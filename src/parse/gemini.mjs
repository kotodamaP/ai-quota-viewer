/**
 * Google AI Studio（aistudio.google.com/rate-limit）の実測テキストパーサ。
 * 2026-09-13 の実測（日本語UI・無料枠プロジェクト）に基づく。
 *
 * ★取得層（src/adapters/browser.mjs の GEMINI_TEXT_EXPRESSION）は
 *   document.body.innerText ではなく、レート制限テーブルの <tr> から
 *   組み立てた JSON 文字列を返す。理由は下記「実測構造」参照。
 *
 * 実測構造（モデルごとの最大使用量テーブル・1行=1モデル）:
 *   ステータス ~ モデル ~ カテゴリ ~ RPM ~ TPM ~ RPD ~ グラフ
 *   error      ~ Gemini 3.8 Flash ~ テキスト出力モデル ~ 5 / 5 ~ 7.78K / 250K ~ 24 / 20
 *   check      ~ Gemini 3.6 Flash ~ テキスト出力モデル ~ 2 / 5 ~ 5.7K / 250K ~  9 / 20
 *
 * ★表の見出しは「モデルごとの最大使用量（上限 過去 N 日間 との比較）」。
 *   取得URLの timeRange=last-1-day では期間が「現在進行中の当日」になるので、
 *   RPD は当日の累計リクエスト数 / 1日の上限（＝残量が直接読める）、
 *   RPM/TPM は当日のピーク / 分あたりの上限になる。過去日の値ではない。
 *
 * ★リセット（日境界）は 08:00 UTC = JST 17:00 固定。実測で確定した:
 *   2026-09-13 に RPD が 24 → 0 へ落ちたのは 16:50〜17:00 JST（= 07:50〜08:00Z）。
 *   ★ページの「UTC-8」という表記は夏時間中ズレる（2026-09-13 は PDT の壁時計を
 *     UTC-8 として表示していた）。よってページの文言から日付を組まず、
 *   実測どおり 08:00 UTC の次回到来で計算する。
 *
 * ★ここで測っているのは **API 無料枠**（AI Studio の API キーが属する Cloud
 *   プロジェクトの枠）であって、Google AI Pro（Gemini アプリのサブスク）の枠では
 *   ない。AI Pro はアプリ側の利用上限で、この画面には出ない。混同させないこと。
 *
 * ★ステータス列:
 *   error … そのモデルは現在レート上限に達している（ページ上部にも警告が出る）
 *   check … 上限内
 *   表示名に「（上限到達）」を付けて区別する（canonical には専用フィールドが無いため）。
 *
 * ★RPM/TPM/RPD はいずれもプロジェクト単位の上限（APIキー単位ではない）。
 *
 * ★上限が「無制限」または「-」（ツール系の行）のセルは枠を作らない。
 */

import { toIsoWithOffset, slugify } from "../time.mjs";

/** 表示するモデル数の上限（逼迫している上位から） */
const MAX_MODELS = 3;

/** 1日枠。AI Studio は UTC-8 固定の日境界で集計する。 */
const DAY_MINUTES = 1440;
/** RPM / TPM は1分あたりの上限 */
const MINUTE_MINUTES = 1;

/** "82.53K" / "1M" / "14.4K" / "250" → 数値。"-"・"無制限" は null。 */
export function parseAmount(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/,/g, "");
  if (!s || s === "-" || /無制限|unlimited/i.test(s)) return null;
  const m = /^([\d.]+)\s*([KMB]?)$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { "": 1, K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] ?? 1;
  return n * mult;
}

/** "24 / 20" → { used, limit, percent }。無制限・"-"・書式違いは null。 */
export function parsePair(raw) {
  if (typeof raw !== "string") return null;
  const parts = raw.split("/").map((s) => s.trim());
  if (parts.length !== 2) return null;
  const used = parseAmount(parts[0]);
  const limit = parseAmount(parts[1]);
  if (used === null || limit === null || limit <= 0) return null;
  return { used, limit, percent: Math.round((used / limit) * 1000) / 10 };
}

/** 日境界（リセット）の時刻。実測で確定した 08:00 UTC = JST 17:00 固定。 */
export const RESET_UTC_HOUR = 8;

/**
 * 次に来る日境界（08:00 UTC）を返す。
 * ★ページの「UTC-8」表記は夏時間中ズレるうえ、境界の見え方も一定しないため、
 *   ページの文言から日付を組まない。実測で確定した瞬間をそのまま使う。
 */
export function nextDailyReset(now) {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    RESET_UTC_HOUR
  );
  return new Date(today <= now.getTime() ? today + 24 * 60 * 60 * 1000 : today);
}

function failure(fetchedAt) {
  return {
    service: "gemini",
    plan: null,
    fetched_at: fetchedAt,
    source_updated_at: null,
    source: "cdp-dom",
    ok: false,
    error: "usage-section-not-found",
    limits: [],
    spend: null,
  };
}

/**
 * @param {string} text 取得層が組み立てた JSON（GEMINI_TEXT_EXPRESSION の戻り値）
 * @param {{now: Date, offsetMinutes: number, fetchedAt: string}} ctx
 */
export function parseGemini(text, { now, offsetMinutes, fetchedAt }) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return failure(fetchedAt);
  }
  if (!payload || !Array.isArray(payload.models) || payload.models.length === 0) {
    return failure(fetchedAt);
  }

  // リセット＝次の日境界（08:00 UTC = JST 17:00 固定・実測）
  const resetsAt = toIsoWithOffset(
    Math.floor(nextDailyReset(now).getTime() / 1000),
    offsetMinutes
  );

  const tier = typeof payload.tier === "string" && payload.tier.trim() ? payload.tier.trim() : null;
  const project =
    typeof payload.project === "string" && payload.project.trim() ? payload.project.trim() : null;
  // ★tier は「API の枠」をそのまま出す（無料枠 / Tier 1 ...）。
  //   Google AI Pro のバッジはアカウントのサブスク状態であって API の枠ではないため
  //   ここには混ぜない（混ざるとどちらの残量か分からなくなる）。
  const planParts = [];
  if (tier) planParts.push(tier);
  if (project) planParts.push(`Project: ${project}`);

  // 行が1つも読めていない＝テーブル自体が取れていない（取得失敗）。
  // ★「読めたが載せる枠が無い」とは区別する（下の built.length === 0 を参照）。
  if (payload.models.length === 0) return failure(fetchedAt);

  const built = [];
  for (const model of payload.models) {
    const name = typeof model?.name === "string" ? model.name.trim() : "";
    if (!name) continue;
    // ★「Antigravity」行は Gemini API のモデル枠ではなく Antigravity エージェント用の
    //   別レーン（実測: RPM 60 / TPM 100K / RPD 100）。購読側は agy の /usage を読む
    //   `antigravity` サービスが担当するので、ここでは扱わない（カード名の混同を防ぐ）。
    if (/^antigravity$/i.test(name)) continue;

    const windows = [];
    const rpd = parsePair(model.rpd);
    const rpm = parsePair(model.rpm);
    const tpm = parsePair(model.tpm);

    if (rpd) {
      windows.push({
        window_minutes: DAY_MINUTES,
        kind: "percent",
        label: "日次RPD（当日）",
        used_percent: rpd.percent,
        used_amount: rpd.used,
        limit_amount: rpd.limit,
        resets_at: resetsAt,
      });
    }
    if (rpm) {
      // ★RPM/TPM は「当日」と断定しない。日境界直後はページの集計範囲が前日側に
      //   またがり、RPD が 0 に戻ってもピーク値は残る（実測 2026-09-13 17:05）。
      //   ピークであることだけを書く。
      windows.push({
        window_minutes: MINUTE_MINUTES,
        kind: "percent",
        label: "毎分RPM（ピーク）",
        used_percent: rpm.percent,
        used_amount: rpm.used,
        limit_amount: rpm.limit,
        resets_at: null,
      });
    }
    if (tpm) {
      windows.push({
        window_minutes: MINUTE_MINUTES,
        kind: "amount",
        label: "毎分TPM（ピーク）",
        used_percent: tpm.percent,
        used_amount: tpm.used,
        limit_amount: tpm.limit,
        resets_at: null,
      });
    }
    if (windows.length === 0) continue;

    const peak = Math.max(...windows.map((w) => w.used_percent));
    built.push({
      limit_id: slugify(name),
      label: model.status === "error" ? `${name}（上限到達）` : name,
      windows,
      _peak: peak,
      _used: windows.some((w) => Number.isFinite(w.used_amount) && w.used_amount > 0),
    });
  }

  if (built.length === 0) {
    // ページは正常に読めたが、出すべきモデルが無い（未使用で1行も出ていない等）。
    // 取得失敗ではないので ok:true のまま空で返す（UI 側が「枠なし」と表示する）。
    return {
      service: "gemini",
      plan: planParts.length ? planParts.join(" · ") : null,
      fetched_at: fetchedAt,
      source_updated_at: null,
      source: "cdp-dom",
      ok: true,
      error: null,
      limits: [],
      spend: null,
    };
  }

  // 実績のあるモデルだけを逼迫順に上位 MAX_MODELS 件。
  // どれも未使用なら「残量100%」を見せるため表示行をそのまま残す。
  const withUsage = built.filter((m) => m._used);
  const picked = (withUsage.length ? withUsage : built)
    .sort((a, b) => b._peak - a._peak)
    .slice(0, MAX_MODELS);

  return {
    service: "gemini",
    plan: planParts.length ? planParts.join(" · ") : null,
    fetched_at: fetchedAt,
    // ★サービス側の「集計時刻」は公開されていない。期間の終端は未来の日境界なので
    //   集計時刻の代わりには使えない（schema の定義どおり null にする）。
    source_updated_at: null,
    source: "cdp-dom",
    ok: true,
    error: null,
    limits: picked.map(({ limit_id, label, windows }) => ({ limit_id, label, windows })),
    spend: null,
  };
}
