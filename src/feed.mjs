/**
 * 残量データ共通フィード quota-feed/1（2026-09-26）。
 *
 * 目的: 外部アプリケーションや連携ツールが、このビューアと**同じ解釈の値**を読めるようにする。
 *   収集は watch が唯一の書き手。解釈（どの枠を見せるか・古さ・状態）はこのファイルに一本化し、
 *   ダッシュボード自身もここで作った値を描く。
 * 設計: docs/FEED.md（設計レビュー反映済み）
 *
 * v1 で固定する規則（変えるなら quota-feed/2 を別ファイルで出す）:
 *   - headline = 表示枠のうち used_percent 最大の枠。枠が無ければ支出枠（spend.used_percent）
 *   - weekly   = WEEKLY_LIMIT_IDS の limit_id に限定した 10080分枠のうち最大。指定の無いサービスは全 10080分枠の最大
 *   - used_percent / remaining_percent は丸めない生値。severity は小数1桁に丸めて 80超=danger / 50超=warn
 *   - stale_at = 値の元になった取得時刻 + (取得間隔×2 + 5分)。利用側は読むたびに現在時刻と比べる
 *   - 値は作らない: 取れない項目は null。失敗は ok:false + error
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

export const FEED_SCHEMA = "quota-feed/1";
export const FEED_FILE = path.join("data", "feed", "quota-feed.v1.json");

const WEEK = 10_080;
/** 画面にもフィードにも出さない枠（モデル固有枠/実験枠の可能性。Codex 助言 2026-08-10） */
const HIDDEN_LIMIT_IDS = new Set(["codex_bengalfox"]);
/** weekly の対象を既存の利用側（外部連携ツール）と同じ枠に固定する */
const WEEKLY_LIMIT_IDS = { claude: ["all_models"], codex: ["codex"], grok: ["weekly"] };

export const SERVICE_LABELS = {
  claude: "Claude", codex: "Codex", grok: "Grok", cursor: "Cursor",
  opencode: "OpenCode Go", qwencloud: "QwenCloud", gemini: "Gemini API",
  antigravity: "Antigravity CLI", runpod: "RunPod",
};

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** 色判定（ダッシュボードの barSev と同じ規則。表示と同じ小数1桁丸めで比べる） */
export function severityOf(used) {
  if (!finite(used)) return null;
  const v = Math.round(used * 10) / 10;
  if (v > 80) return "danger";
  if (v > 50) return "warn";
  return "ok";
}

/** 旧形式の Grok（api/chat が別 limit）を週間共有枠 1本へ合算する（画面の従来ロジックを移設） */
function mergeLegacyGrok(limits) {
  if (limits.some((l) => l.limit_id === "weekly")) return limits;
  const parts = [];
  let resetsAt = null;
  for (const limit of limits) {
    if (!/^(api|chat)$/i.test(limit.limit_id)) continue;
    for (const w of limit.windows ?? []) {
      if (w.window_minutes !== WEEK || !finite(w.used_percent)) continue;
      parts.push({ label: limit.label ?? limit.limit_id, used_percent: w.used_percent });
      if (!resetsAt && w.resets_at) resetsAt = w.resets_at;
    }
  }
  if (parts.length < 2) return limits;
  const used = Math.min(100, Math.round(parts.reduce((a, p) => a + p.used_percent, 0) * 10) / 10);
  const note = parts.map((p) => `${p.label} ${p.used_percent}%`).join(" + ");
  return [{
    limit_id: "weekly",
    label: `週間上限（${note}）`,
    windows: [{ window_minutes: WEEK, kind: "percent", label: "週次", used_percent: used,
      used_amount: null, limit_amount: null, resets_at: resetsAt }],
  }];
}

function toWindow(limit, w) {
  const used = finite(w.used_percent) ? w.used_percent : null;
  return {
    limit_id: limit.limit_id,
    limit_label: limit.label ?? limit.limit_id,
    window_minutes: finite(w.window_minutes) ? w.window_minutes : null,
    label: w.label ?? null,
    used_percent: used,
    remaining_percent: used === null ? null : 100 - used,
    resets_at: w.resets_at ?? null,
    used_amount: finite(w.used_amount) ? w.used_amount : null,
    limit_amount: finite(w.limit_amount) ? w.limit_amount : null,
    severity: severityOf(used),
  };
}

const maxByUsed = (list) =>
  list.filter((w) => w.used_percent !== null)
    .reduce((a, b) => (a === null || b.used_percent > a.used_percent ? b : a), null);

export function staleAt(iso, intervalMinutes) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  return new Date(t + (intervalMinutes * 2 + 5) * 60_000).toISOString();
}

/** 1件の月額を円に直す（為替が無い USD 建ては null＝不完全な数字を出さない） */
function monthlyJpy(entry, fx) {
  if (!entry || entry.subscription_active === false) return null;
  if (finite(entry.subscription_monthly_jpy)) return entry.subscription_monthly_jpy;
  if (finite(entry.subscription_monthly_usd) && finite(fx)) return entry.subscription_monthly_usd * fx;
  return null;
}

/**
 * canonical スナップショット 1件 → フィードのサービス項目。
 * @param {object} snap canonical snapshot
 * @param {{intervalMinutes:number, pricing?:object}} opts
 */
export function projectService(snap, { intervalMinutes, pricing } = {}) {
  const id = snap.service;
  const base = {
    id,
    kind: "llm",
    label: SERVICE_LABELS[id] ?? id,
    plan: snap.plan ?? null,
    ok: snap.ok === true,
    error: snap.ok === true ? null : snap.error ?? "unknown",
    fetched_at: snap.fetched_at ?? null,
    stale_at: staleAt(snap.fetched_at, intervalMinutes),
    source: snap.source ?? null,
    headline: null,
    weekly: null,
    windows: [],
    spend: null,
    monthly_jpy: monthlyJpy(pricing?.services?.[id], pricing?.fx?.usd_jpy),
  };
  if (snap.ok !== true) return base;

  let limits = (snap.limits ?? []).filter((l) => !HIDDEN_LIMIT_IDS.has(l.limit_id));
  if (id === "grok") limits = mergeLegacyGrok(limits);
  const windows = limits.flatMap((l) => (l.windows ?? []).map((w) => toWindow(l, w)));

  let headline = maxByUsed(windows);
  if (!headline && finite(snap.spend?.used_percent)) {
    headline = {
      limit_id: "spend", limit_label: "クレジット", window_minutes: null, label: null,
      used_percent: snap.spend.used_percent, remaining_percent: 100 - snap.spend.used_percent,
      resets_at: snap.spend.resets_at ?? null, used_amount: snap.spend.used_amount ?? null,
      limit_amount: snap.spend.limit_amount ?? null, severity: severityOf(snap.spend.used_percent),
    };
  }

  const weeklyIds = WEEKLY_LIMIT_IDS[id];
  const weekly = maxByUsed(
    windows.filter((w) => w.window_minutes === WEEK && (!weeklyIds || weeklyIds.includes(w.limit_id)))
  );

  const s = snap.spend;
  return {
    ...base,
    headline,
    weekly,
    windows,
    spend: s
      ? {
          currency: s.currency ?? null,
          used_amount: finite(s.used_amount) ? s.used_amount : null,
          limit_amount: finite(s.limit_amount) ? s.limit_amount : null,
          used_percent: finite(s.used_percent) ? s.used_percent : null,
          balance: finite(s.balance) ? s.balance : null,
          auto_recharge: typeof s.auto_recharge === "boolean" ? s.auto_recharge : null,
          resets_at: s.resets_at ?? null,
        }
      : null,
  };
}

/** RunPod（LLM とは別枠）→ フィード項目。前回値保持中は ok:false のまま値と last_ok_at を載せる */
export function projectRunpod(latest, { intervalMinutes, fx } = {}) {
  if (!latest) {
    return { id: "runpod", kind: "infra", label: "RunPod", ok: false, error: "not-collected-yet",
      fetched_at: null, last_ok_at: null, stale_at: null, balance: null };
  }
  const usd = finite(latest.balance_usd) ? latest.balance_usd : null;
  return {
    id: "runpod",
    kind: "infra",
    label: "RunPod",
    ok: latest.ok === true,
    error: latest.ok === true ? null : latest.error ?? "unknown",
    fetched_at: latest.fetched_at ?? null,
    last_ok_at: latest.last_ok_at ?? null,
    stale_at: staleAt(latest.last_ok_at ?? latest.fetched_at, intervalMinutes),
    balance: usd === null ? null : {
      usd,
      jpy: finite(fx) ? Math.round(usd * fx) : null,
      spend_per_hr_usd: finite(latest.spend_per_hr_usd) ? latest.spend_per_hr_usd : null,
      hours_left: finite(latest.hours_left) ? latest.hours_left : null,
    },
  };
}

/** 契約サブスクの月額合計（画面の合計計器と同じ規則）。USD 建てがあるのに為替が無ければ null */
export function subscriptionsOf(pricing, now = new Date()) {
  const fx = pricing?.fx?.usd_jpy;
  const entries = Object.entries(pricing?.services ?? {})
    .filter(([, v]) => v && v.subscription_active !== false)
    .filter(([, v]) => finite(v.subscription_monthly_usd) || finite(v.subscription_monthly_jpy));
  const amounts = entries.map(([, v]) => monthlyJpy(v, fx));
  const total = amounts.some((a) => a === null) ? null : Math.round(amounts.reduce((a, b) => a + b, 0));

  let next = null;
  const changes = entries
    .map(([, v]) => [v, v.scheduled_change])
    .filter(([, c]) => c?.effective && new Date(c.effective + "T00:00:00+09:00") > now);
  if (total !== null && changes.length) {
    const deltas = changes.map(([v, c]) => {
      const to = finite(c.monthly_jpy) ? c.monthly_jpy : finite(c.monthly_usd) && finite(fx) ? c.monthly_usd * fx : null;
      return to === null ? null : to - monthlyJpy(v, fx);
    });
    if (deltas.every((d) => d !== null)) {
      next = {
        effective: changes.map(([, c]) => c.effective).sort()[0],
        monthly_total_jpy: Math.round(total + deltas.reduce((a, b) => a + b, 0)),
      };
    }
  }
  return { monthly_total_jpy: total, next };
}

/**
 * フィード全体を組み立てる（純関数。ディスクには触らない）。
 * @param {{snapshots:object[], pricing:object, runpod:object|null, settings:object, generation:number, now?:Date}} input
 */
export function buildFeed({ snapshots, pricing, runpod, settings, generation, now = new Date() }) {
  const intervalMinutes = settings.collect_interval_minutes;
  const services = snapshots.map((s) => projectService(s, { intervalMinutes, pricing }));
  if (settings.extras?.runpod !== false) {
    services.push(projectRunpod(runpod, { intervalMinutes, fx: pricing?.fx?.usd_jpy }));
  }
  return {
    schema: FEED_SCHEMA,
    generation,
    generated_at: now.toISOString(),
    producer: { name: "ai-quota-viewer", interval_minutes: intervalMinutes },
    fx: {
      usd_jpy: finite(pricing?.fx?.usd_jpy) ? pricing.fx.usd_jpy : null,
      as_of: pricing?.fx?.last_verified ?? null,
      source: pricing?.fx?.source ?? null,
    },
    subscriptions: subscriptionsOf(pricing, now),
    services,
  };
}

/** 有効なサービスの最新スナップショットをディスクから読む（未取得は ok:false の空スナップショット） */
export async function readLatestSnapshots(settings, { dir = path.join("data", "latest") } = {}) {
  const out = [];
  for (const service of Object.keys(settings.services ?? {})) {
    if (settings.services[service] === false) continue;
    try {
      out.push(JSON.parse(await readFile(path.join(dir, `${service}.json`), "utf8")));
    } catch {
      out.push({ service, plan: null, fetched_at: null, source_updated_at: null, source: "manual",
        ok: false, error: "not-collected-yet", limits: [], spend: null });
    }
  }
  return out;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** ディスク上の最新状態からフィードを組み立てる（書き込みはしない。/api/state からも使う） */
export async function buildFeedFromDisk(settings, { now = new Date(), feedFile = FEED_FILE } = {}) {
  const [snapshots, pricing, runpod, prev] = await Promise.all([
    readLatestSnapshots(settings),
    readJson(path.join("config", "pricing.json")),
    readJson(path.join("data", "latest", "runpod.json")),
    readJson(feedFile),
  ]);
  const generation = Number.isInteger(prev?.generation) ? prev.generation : 0;
  return buildFeed({ snapshots, pricing: pricing ?? {}, runpod, settings, generation, now });
}

/** 公開は同一プロセス内で直列化する（watch とダッシュボードの「今すぐ更新」が同居するため） */
let publishChain = Promise.resolve();

/**
 * フィードを公開する: ディスク上の最新（部分更新でも他サービスは前回の値と取得時刻のまま）から組み立て、
 * generation を1つ進めて atomic（tmp→rename）に書く。
 */
export function publishFeed(settings, { now = new Date(), feedFile = FEED_FILE } = {}) {
  const run = publishChain.then(async () => {
    const feed = await buildFeedFromDisk(settings, { now, feedFile });
    feed.generation += 1;
    await mkdir(path.dirname(feedFile), { recursive: true });
    const tmp = feedFile + ".tmp";
    await writeFile(tmp, JSON.stringify(feed, null, 2) + "\n", "utf8");
    await rename(tmp, feedFile);
    return feed;
  });
  publishChain = run.catch(() => {});
  return run;
}
