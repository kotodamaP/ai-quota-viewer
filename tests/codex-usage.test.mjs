import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexUsage, CODEX_USAGE_LIMIT_ID } from "../src/parse/codex-usage.mjs";

const CTX = { fetchedAt: "2026-08-10T18:00:00+09:00", offsetMinutes: 540 };

test("codex-usage: 週間利用上限の残り%をパースできる（8/10 実測）", () => {
  const text = [
    "利用制限",
    "プラン制限内での利用状況を確認",
    "使用量",
    "使用量は、Codex、Work、Workspace Agents、ChatGPT for Excel で共有されます。Chat の会話は含まれません。",
    "週間利用上限",
    "残り92%",
    "2026/08/17 17:14にリセット",
    "利用制限のリセット",
  ].join("\n");

  const parsed = parseCodexUsage(text, CTX);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.service, "codex");
  assert.equal(parsed.source, "cdp-dom");
  assert.equal(parsed.limits.length, 1);
  assert.equal(parsed.limits[0].limit_id, CODEX_USAGE_LIMIT_ID);
  assert.equal(parsed.limits[0].windows.length, 1);
  assert.equal(parsed.limits[0].windows[0].used_percent, 8); // 100 - 92
  assert.equal(parsed.limits[0].windows[0].window_minutes, 10080);
  // 2026-08-17T17:14:00+09:00 = 2026-08-17T08:14:00Z（ISO 文字列で返る）
  assert.equal(parsed.limits[0].windows[0].resets_at, "2026-08-17T17:14:00+09:00");
});

test("codex-usage: 98% 残りは使用率2%になる（8/10 午前の実測）", () => {
  const text = "週間利用上限\n残り98%\n2026/08/17 17:14にリセット";
  const parsed = parseCodexUsage(text, CTX);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.limits[0].windows[0].used_percent, 2);
});

test("codex-usage: セクションが無いテキストは ok:false", () => {
  assert.equal(parseCodexUsage("", CTX).ok, false);
  assert.equal(parseCodexUsage("ログインしてください", CTX).ok, false);
  assert.equal(parseCodexUsage("週間利用上限\n表示できません", CTX).ok, false);
  assert.equal(parseCodexUsage("週間利用上限\n残り120%\n2026/08/17 17:14にリセット", CTX).ok, false);
});

test("codex-usage: 不正なリセット日付（2026/02/31）は繰り上げず null", () => {
  const text = "週間利用上限\n残り80%\n2026/02/31 12:00にリセット";
  const parsed = parseCodexUsage(text, CTX);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.limits[0].windows[0].resets_at, null);
});
