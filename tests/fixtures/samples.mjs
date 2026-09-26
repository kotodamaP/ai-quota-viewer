/**
 * テスト用フィクスチャ。
 * すべて P0(2026-07-25) の実測データに基づく実形状。
 * ★ 本物の ~/.codex は読まない（環境依存を避けるため）。
 */

const info = { model_context_window: 258400 };

function line(timestamp, rateLimits) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info, rate_limits: rateLimits },
  });
}

const CREDITS_EMPTY = { has_credits: false, unlimited: false, balance: "0" };

/** T1: 現行フォーマット（週枠のみ / secondary=null） */
export const CURRENT_FORMAT = line("2026-07-25T02:58:22.683Z", {
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: 68.0, window_minutes: 10080, resets_at: 1785258154 },
  secondary: null,
  credits: CREDITS_EMPTY,
  individual_limit: null,
  spend_control_reached: null,
  plan_type: "pro",
  rate_limit_reached_type: null,
});

/** T2: 旧フォーマット（primary=5h / secondary=週） */
export const LEGACY_FORMAT = line("2026-03-21T15:48:49.966Z", {
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1774126126 },
  secondary: { used_percent: 40.0, window_minutes: 10080, resets_at: 1774556436 },
  credits: CREDITS_EMPTY,
  plan_type: "plus",
});

/** T3: window_minutes = 0 の不正値（実データに3件存在） */
export const ZERO_WINDOW = line("2026-05-28T17:58:25.105Z", {
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: 0.0, window_minutes: 0, resets_at: 1779991108 },
  secondary: null,
  credits: CREDITS_EMPTY,
  plan_type: "pro",
});

/** T4: モデル別の別枠 */
export const BENGALFOX = line("2026-07-24T18:10:08.762Z", {
  limit_id: "codex_bengalfox",
  limit_name: "GPT-5.3-Codex-Spark",
  primary: { used_percent: 0.0, window_minutes: 10080, resets_at: 1785521420 },
  secondary: null,
  credits: CREDITS_EMPTY,
  plan_type: "pro",
});

/** T5: 枠が一切ない limit_id */
export const PREMIUM_NO_WINDOW = line("2026-06-05T16:56:38.110Z", {
  limit_id: "premium",
  limit_name: null,
  primary: null,
  secondary: null,
  credits: CREDITS_EMPTY,
  plan_type: null,
});

/** T7: 同一 limit_id の古いイベント（CURRENT_FORMAT より前） */
export const OLDER_SAME_LIMIT = line("2026-07-24T20:13:09.391Z", {
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: 64.0, window_minutes: 10080, resets_at: 1785258154 },
  secondary: null,
  credits: CREDITS_EMPTY,
  plan_type: "prolite",
});

/** T8: 壊れた行・無関係な行 */
export const BROKEN_LINES = [
  '{"timestamp":"2026-07-25T03:00:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex"', // 途中で切れている
  '{"timestamp":"2026-07-25T03:00:01.000Z","type":"message","payload":{"text":"no rate limits here"}}',
  "",
  "   ",
  "not json at all",
].join("\n");

/** クレジット残高があるケース（spend が生成される経路） */
export const WITH_CREDITS = line("2026-07-25T04:00:00.000Z", {
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: 12.0, window_minutes: 10080, resets_at: 1785258154 },
  secondary: null,
  credits: { has_credits: true, unlimited: false, balance: "25.5" },
  plan_type: "pro",
});
