/**
 * 正規化。schema/canonical.schema.json への適合が契約。
 * スキーマは 設計担当 所有。ここでスキーマの形を勝手に変えないこと。
 */

import { toIsoWithOffset, windowLabel } from "./time.mjs";

const SLOTS = ["primary", "secondary"];

/**
 * 1つの窓（primary/secondary の中身）を正規化する。
 * ★ スロット名ではなく window_minutes で種別を判定する。
 * ★ window_minutes <= 0 は不正値として除外する（実データに3件存在）。
 */
function normalizeWindow(raw, offsetMinutes) {
  if (!raw || typeof raw !== "object") return null;

  const wm = raw.window_minutes;
  if (!Number.isInteger(wm) || wm <= 0) return null;

  return {
    window_minutes: wm,
    kind: "percent",
    label: windowLabel(wm),
    used_percent: typeof raw.used_percent === "number" ? raw.used_percent : null,
    used_amount: null,
    limit_amount: null,
    resets_at: Number.isFinite(raw.resets_at)
      ? toIsoWithOffset(raw.resets_at, offsetMinutes)
      : null,
  };
}

/**
 * credits -> spend。
 * has_credits=false かつ balance が 0/null のときは spend:null とし、
 * UI側で「該当なし」を表示する（design specification §4.6）。
 */
function buildSpend(byLimitId) {
  let newest = null;
  let newestTs = "";
  for (const ev of byLimitId.values()) {
    if (ev.timestamp >= newestTs) {
      newestTs = ev.timestamp;
      newest = ev.rl;
    }
  }

  const credits = newest?.credits;
  if (!credits || typeof credits !== "object") return null;

  const hasCredits = credits.has_credits === true;
  const unlimited = credits.unlimited === true;
  const balance =
    credits.balance === null || credits.balance === undefined || credits.balance === ""
      ? null
      : Number(credits.balance);
  const balanceNum = Number.isFinite(balance) ? balance : null;

  if (!hasCredits && !unlimited && (balanceNum === null || balanceNum === 0)) {
    return null;
  }

  // NOTE: Codexのクレジット単位は通貨ではなく "credit"。
  // schema の currency は ISO4217 を想定しているため、ここでは currency を省略する
  // （spend に required は無いので適合する）。単価注入はP5。
  return {
    kind: "amount",
    used_amount: null,
    limit_amount: null,
    used_percent: null,
    balance: balanceNum,
    resets_at: null,
    auto_recharge: null,
    unit_price_jpy: null,
  };
}

/**
 * @param {{byLimitId: Map, plan: string|null}} collected
 * @param {{offsetMinutes: number, fetchedAt: string}} opts
 */
export function normalizeCodex(
  collected,
  { offsetMinutes, fetchedAt, source = "local-jsonl" }
) {
  // ★2026-08-10 注意: codex と codex_bengalfox は同一枠として統合しない。
  //   注意: bengalfox はモデル固有枠/実験枠の可能性があり、
  //   「codex の後継」と断定するのは危険。JSONL の bengalfox は独立したまま
  //   表示対象外とし、通常の `codex` 週次枠を一次ソースとして使う。

  const limits = [];

  for (const [limitId, ev] of collected.byLimitId) {
    const windows = [];
    for (const slot of SLOTS) {
      const w = normalizeWindow(ev.rl[slot], offsetMinutes);
      if (w) windows.push(w);
    }

    // 有効な窓が1つも無い limit_id は出さない（premium が該当）
    if (windows.length === 0) continue;

    windows.sort((a, b) => a.window_minutes - b.window_minutes);

    limits.push({
      limit_id: limitId,
      label: typeof ev.rl.limit_name === "string" ? ev.rl.limit_name : null,
      windows,
    });
  }

  limits.sort((a, b) => a.limit_id.localeCompare(b.limit_id));

  return {
    service: "codex",
    plan: collected.plan ?? null,
    fetched_at: fetchedAt,
    source_updated_at: null,
    source,
    ok: true,
    error: null,
    limits,
    spend: buildSpend(collected.byLimitId),
  };
}

/**
 * 失敗時のスナップショット。
 * ★ 生の例外メッセージを載せない（パス・資格情報が混ざりうるため）。design specification §5。
 */
export function failureSnapshot(service, kind, { offsetMinutes, fetchedAt, source = "local-jsonl" }) {
  void offsetMinutes;
  return {
    service,
    plan: null,
    fetched_at: fetchedAt,
    source_updated_at: null,
    source,
    ok: false,
    error: kind,
    limits: [],
    spend: null,
  };
}
