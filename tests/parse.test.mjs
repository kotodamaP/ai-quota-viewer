import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseClaude } from "../src/parse/claude.mjs";
import { parseGrok } from "../src/parse/grok.mjs";
import { parseCursor } from "../src/parse/cursor.mjs";
import { parseOpencode } from "../src/parse/opencode.mjs";
import { parseQwencloud } from "../src/parse/qwencloud.mjs";
import { parseGemini } from "../src/parse/gemini.mjs";
import {
  parseRelativeReset, parseWeekdayTimeReset, parseAbsoluteJaReset,
  parseMonthDayEnReset, parsePercent, parseMoney, parseLastUpdated,
  parseResetRemaining,
} from "../src/parse/text.mjs";
import { validate } from "./helpers/validate.mjs";
import * as pages from "./fixtures/pages.mjs";

// 2026-07-25 12:05 (土) をテストの基準時刻に固定する
const NOW = new Date(2026, 6, 25, 12, 5, 0);
const CTX = { now: NOW, offsetMinutes: 540, fetchedAt: "2026-07-25T12:05:00+09:00" };

// P4(2026-08-03 20:35 JST) のキャプチャに合わせた専用CTX。
// qwencloud の source_updated_at は「時刻のみ→当日扱い」のため基準日が重要。
const P4_NOW = new Date(2026, 7, 3, 20, 35, 0);
const P4_CTX = { now: P4_NOW, offsetMinutes: 540, fetchedAt: "2026-08-03T20:35:00+09:00" };

test("時刻表記パーサ", () => {
  assert.equal(parsePercent("22% 使用済み"), 22);
  assert.equal(parsePercent("94%使用"), 94);
  assert.equal(parsePercent("17%"), 17);
  assert.equal(parseMoney("$42.00使用"), 42);
  assert.equal(parseMoney("$1,234.50"), 1234.5);

  // 相対: 12:05 + 2h54m = 14:59
  assert.equal(parseRelativeReset("2時間54分後にリセット", NOW).getHours(), 14);
  assert.equal(parseRelativeReset("2時間54分後にリセット", NOW).getMinutes(), 59);

  // 曜日+時刻: 土曜(7/25)から見た次の月曜は 7/27
  const mon = parseWeekdayTimeReset("15:59 (月)にリセット", NOW);
  assert.equal(mon.getMonth(), 6);
  assert.equal(mon.getDate(), 27);
  assert.equal(mon.getDay(), 1);

  // 絶対（日本語）
  const abs = parseAbsoluteJaReset("2026年7月30日 6:11 にリセット");
  assert.equal(abs.getDate(), 30);
  assert.equal(abs.getHours(), 6);

  // 月日（英語）: 7/25 から見た Aug 1 は同年
  const aug = parseMonthDayEnReset("Aug 1にリセット", NOW);
  assert.equal(aug.getMonth(), 7);
  assert.equal(aug.getFullYear(), 2026);

  // 最終更新
  assert.equal(parseLastUpdated("最終更新: 3分前", NOW).getMinutes(), 2);

  // OpenCode 残り時間リセット（日本語・英語）
  // 12:05 + 1h26m = 13:31
  assert.equal(parseResetRemaining("リセットまで 1 時間 26 分", NOW).getHours(), 13);
  assert.equal(parseResetRemaining("リセットまで 1 時間 26 分", NOW).getMinutes(), 31);
  // 12:05 + 5d23h = 7/25 + 5d = 7/30 11:05
  const rEn = parseResetRemaining("Resets in 5d 23h", NOW);
  assert.equal(rEn.getDate(), 31); // 7/25 12:05 + 5d = 7/30 12:05, + 23h = 7/31 11:05
  assert.equal(rEn.getHours(), 11);
  assert.equal(rEn.getMinutes(), 5);
});

test("Claude: 新しい見出し「プランの使用量上限」でもプラン名が取れる（検証済み）", () => {
  const text = pages.CLAUDE_USAGE
    .replace("プラン使用制限", "プランの使用量上限")
    .replace("Max (5x)", "Max (20x)");
  assert.equal(parseClaude(text, CTX).plan, "Max (20x)");
});

test("Claude: 実測テキストから全項目を取り出す", () => {
  const snap = parseClaude(pages.CLAUDE_USAGE, CTX);

  assert.equal(snap.ok, true);
  assert.equal(snap.plan, "Max (5x)");
  assert.equal(snap.source_updated_at, "2026-07-25T12:02:00+09:00");

  const all = snap.limits.find((l) => l.limit_id === "all_models");
  const fable = snap.limits.find((l) => l.limit_id === "fable");
  assert.ok(all && fable, "モデル別に独立した枠が取れること");

  // 5時間枠
  const w5 = all.windows.find((w) => w.window_minutes === 300);
  assert.equal(w5.used_percent, 22);
  assert.equal(w5.label, "5時間");
  assert.equal(w5.resets_at, "2026-07-25T14:59:00+09:00");

  // 週次枠
  const wWeek = all.windows.find((w) => w.window_minutes === 10080);
  assert.equal(wWeek.used_percent, 10);
  assert.equal(wWeek.resets_at, "2026-07-27T15:59:00+09:00");

  assert.equal(fable.windows[0].used_percent, 5);
  assert.equal(fable.windows[0].resets_at, "2026-07-27T16:00:00+09:00");

  // クレジット
  assert.equal(snap.spend.used_amount, 42);
  assert.equal(snap.spend.limit_amount, 100);
  assert.equal(snap.spend.used_percent, 80);
  assert.equal(snap.spend.balance, 58);
  assert.equal(snap.spend.auto_recharge, false);
  assert.equal(snap.spend.resets_at, "2026-08-01T00:00:00+09:00");
});

test("Grok: 4分類を週間共有枠の内訳として集計し、追加クレジット残高を取る", () => {
  const snap = parseGrok(pages.GROK_USAGE, CTX);

  assert.equal(snap.ok, true);
  assert.equal(snap.plan, "SuperGrok");
  assert.deepEqual(snap.limits.map((l) => l.limit_id), ["weekly"]);

  const weekly = snap.limits[0];
  // fixture: API 18% + チャット 6% + Imagine 3% + Grok Build 1% = 28%
  assert.equal(weekly.windows[0].used_percent, 28);
  assert.equal(weekly.windows[0].window_minutes, 10080);
  assert.equal(weekly.windows[0].resets_at, "2026-07-30T06:11:00+09:00");
  assert.match(weekly.label, /API 18%/);
  assert.match(weekly.label, /チャット 6%/);
  assert.match(weekly.label, /Imagine 3%/);
  assert.match(weekly.label, /Grok Build 1%/);

  assert.equal(snap.spend.currency, "USD");
  assert.equal(snap.spend.balance, 42.5);
  // 現行画面の説明文だけではオン/オフを判定できない
  assert.equal(snap.spend.auto_recharge, null);
});

test("Grok: 見出しの『N% 使用済』があれば合算より優先する", () => {
  const text = pages.GROK_USAGE.replace(
    "週間 SuperGrok 上限\n使用済\n",
    "週間 SuperGrok 上限\n23% 使用済\n"
  ).replace("AI_TRIO_GROK_TOTAL 28%\n", "");
  const snap = parseGrok(text, CTX);
  assert.equal(snap.ok, true);
  assert.equal(snap.limits[0].windows[0].used_percent, 23);
});

test("Cursor レイアウトA（消費金額ビュー）: 窓を持たず金額のみ", () => {
  const snap = parseCursor(pages.CURSOR_USAGE, CTX);

  assert.equal(snap.ok, true);
  assert.equal(snap.plan, "Ultra");
  assert.deepEqual(snap.limits, []); // このビューには%が無い
  assert.equal(snap.spend.kind, "amount");
  assert.equal(snap.spend.used_amount, 45.2);
  assert.equal(snap.spend.period_start, "Jul 19");
  assert.equal(snap.spend.period_end, "Jul 25");
});

test("Cursor レイアウトB（プラン/上限ビュー）: %枠と上限額が両方取れる", () => {
  const snap = parseCursor(pages.CURSOR_PLAN, CTX);

  assert.equal(snap.ok, true);
  assert.equal(snap.plan, "Ultra");

  const ids = snap.limits.map((l) => l.limit_id);
  assert.ok(ids.includes("cursor_models"), `got ${ids}`);
  assert.ok(ids.includes("other_models"), `got ${ids}`);

  const cursorModels = snap.limits.find((l) => l.limit_id === "cursor_models");
  const other = snap.limits.find((l) => l.limit_id === "other_models");
  assert.equal(cursorModels.used_percent ?? cursorModels.windows[0].used_percent, 17);
  assert.equal(other.windows[0].used_percent, 100); // ★枯渇状態を見逃さない

  // 月次窓・リセットは 8月4日
  assert.equal(cursorModels.windows[0].window_minutes, 43200);
  assert.equal(cursorModels.windows[0].resets_at, "2026-08-04T00:00:00+09:00");

  // On-Demand の使用額と上限
  assert.equal(snap.spend.used_amount, 29.5);
  assert.equal(snap.spend.limit_amount, 30);
  assert.equal(snap.spend.used_percent, 98.3);
});

test("Cursor: ラベルの '·' 以降（説明文）を切り落とす", () => {
  const snap = parseCursor(pages.CURSOR_PLAN, CTX);
  const cm = snap.limits.find((l) => l.limit_id === "cursor_models");
  assert.equal(cm.label, "Cursor Models");
});

test("ログイン切れ等で使用量が見つからない場合は ok=false に落ちる", () => {
  for (const fn of [parseClaude, parseGrok, parseCursor, parseOpencode, parseQwencloud, parseGemini]) {
    const snap = fn(pages.LOGGED_OUT, CTX);
    assert.equal(snap.ok, false);
    assert.equal(snap.error, "usage-section-not-found");
    assert.deepEqual(snap.limits, []);
  }
});

test("OpenCode Go: /go の3枠（5時間/週/月）を limits で取る", () => {
  const snap = parseOpencode(pages.OPENCODE_GO, P4_CTX);

  assert.equal(snap.ok, true);
  assert.equal(snap.plan, "Go");
  assert.equal(snap.limits.length, 1);
  assert.equal(snap.limits[0].limit_id, "go");

  const windows = snap.limits[0].windows;
  assert.equal(windows.length, 3);

  // 5時間ローリング枠（$12相当。ページは % と残り時間のみ表示）
  const w5 = windows.find((w) => w.window_minutes === 300);
  assert.equal(w5.kind, "percent");
  assert.equal(w5.label, "5時間");
  assert.equal(w5.used_percent, 100);
  assert.equal(w5.used_amount, null);
  assert.equal(w5.limit_amount, null);
  // 2026-08-03 20:35 + 1h26m = 22:01
  assert.equal(w5.resets_at, "2026-08-03T22:01:00+09:00");

  // 週次枠（$30相当）
  const wWeek = windows.find((w) => w.window_minutes === 10080);
  assert.equal(wWeek.used_percent, 42);
  // 2026-08-03 20:35 + 6d11h = 2026-08-10 07:35
  assert.equal(wWeek.resets_at, "2026-08-10T07:35:00+09:00");

  // 月次枠（$60相当）
  const wMonth = windows.find((w) => w.window_minutes === 43200);
  assert.equal(wMonth.used_percent, 22);
  // 2026-08-03 20:35 + 30d3h = 2026-09-02 23:35
  assert.equal(wMonth.resets_at, "2026-09-02T23:35:00+09:00");

  // /go ページに残高表示は無いため spend は null（残高は /billing 側）
  assert.equal(snap.spend, null);
});

test("OpenCode: 利用量ラベルが無いページは usage-section-not-found に落ちる", () => {
  const text = pages.OPENCODE_GO
    .replace("ローリング利用量\n", "")
    .replace("週間利用量\n", "")
    .replace("月間利用量\n", "");
  const snap = parseOpencode(text, P4_CTX);
  assert.equal(snap.ok, false);
  assert.equal(snap.error, "usage-section-not-found");
  assert.equal(snap.spend, null);
});

test("OpenCode Go: /console/.../go (V2新UI・英語) の3枠を limits で取る（0%リセット不在対応）", () => {
  const snap = parseOpencode(pages.OPENCODE_GO_V2, P4_CTX);

  assert.equal(snap.ok, true);
  assert.equal(snap.plan, "Go");
  assert.equal(snap.limits.length, 1);
  assert.equal(snap.limits[0].limit_id, "go");

  const windows = snap.limits[0].windows;
  assert.equal(windows.length, 3);

  // 5時間ローリング枠（使用率0%、リセット行なし）
  const w5 = windows.find((w) => w.window_minutes === 300);
  assert.equal(w5.kind, "percent");
  assert.equal(w5.label, "5時間");
  assert.equal(w5.used_percent, 0);
  assert.equal(w5.used_amount, null);
  assert.equal(w5.limit_amount, null);
  assert.equal(w5.resets_at, null);

  // 週次枠（使用率27%、Resets in 5d 23h）
  // 2026-08-03 20:35 + 5d23h = 2026-08-09 19:35
  const wWeek = windows.find((w) => w.window_minutes === 10080);
  assert.equal(wWeek.used_percent, 27);
  assert.equal(wWeek.resets_at, "2026-08-09T19:35:00+09:00");

  // 月次枠（使用率96%、Resets in 12d 18h）
  // 2026-08-03 20:35 + 12d18h = 2026-08-16 14:35
  const wMonth = windows.find((w) => w.window_minutes === 43200);
  assert.equal(wMonth.used_percent, 96);
  assert.equal(wMonth.resets_at, "2026-08-16T14:35:00+09:00");

  assert.equal(snap.spend, null);
});

test("QwenCloud: 2窓（5時間/7日）を remaining→used 変換で取る", () => {
  const snap = parseQwencloud(pages.QWENCLOUD_SUBSCRIPTION, P4_CTX);

  assert.equal(snap.ok, true);
  assert.equal(snap.plan, "Individual Plan");
  assert.equal(snap.source_updated_at, "2026-08-03T20:29:59+09:00");

  const windows = snap.limits[0].windows;
  assert.equal(snap.limits[0].limit_id, "quota");
  assert.equal(windows.length, 2);

  // 5時間枠: Remaining 0.0% → used 100%
  const w5 = windows.find((w) => w.window_minutes === 300);
  assert.equal(w5.kind, "amount");
  assert.equal(w5.label, "5時間");
  assert.equal(w5.used_percent, 100);
  assert.equal(w5.used_amount, 3000);
  assert.equal(w5.limit_amount, 3000);
  assert.equal(w5.resets_at, "2026-08-04T00:32:00+09:00");

  // 7日枠: Remaining 59.9% → used 40.1%
  const w7 = windows.find((w) => w.window_minutes === 10080);
  assert.equal(w7.used_percent, 40.1);
  assert.equal(w7.used_amount, 4010);
  assert.equal(w7.limit_amount, 10000);
  assert.equal(w7.resets_at, "2026-08-08T16:41:00+09:00");
});

test("QwenCloud: 新ラベル版（5 Hours Usage Limit / 7 Days Usage Limit）も取れる", () => {
  const snap = parseQwencloud(pages.QWENCLOUD_SUBSCRIPTION_V2, P4_CTX);

  assert.equal(snap.ok, true);
  assert.equal(snap.plan, "Individual Plan");
  assert.equal(snap.source_updated_at, "2026-08-03T22:04:38+09:00");

  const windows = snap.limits[0].windows;
  assert.equal(windows.length, 2);

  // 5時間枠: Remaining 91.2% → used 8.8%
  const w5 = windows.find((w) => w.window_minutes === 300);
  assert.equal(w5.used_percent, 8.8);
  assert.equal(w5.used_amount, 264);
  assert.equal(w5.limit_amount, 3000);
  assert.equal(w5.resets_at, "2026-08-06T03:04:00+09:00");

  // 7日枠: Remaining 28.0% → used 72.0%
  const w7 = windows.find((w) => w.window_minutes === 10080);
  assert.equal(w7.used_percent, 72);
  assert.equal(w7.used_amount, 7200);
  assert.equal(w7.limit_amount, 10000);
  assert.equal(w7.resets_at, "2026-08-08T16:41:00+09:00");
});

test("ブラウザ系3社の出力も canonical.schema.json に適合する", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schema", "canonical.schema.json"), "utf8")
  );

  const cases = [
    ["claude", parseClaude(pages.CLAUDE_USAGE, CTX)],
    ["grok", parseGrok(pages.GROK_USAGE, CTX)],
    ["cursor", parseCursor(pages.CURSOR_USAGE, CTX)],
    ["cursor-plan", parseCursor(pages.CURSOR_PLAN, CTX)],
    ["opencode", parseOpencode(pages.OPENCODE_GO, P4_CTX)],
    ["opencode-v2", parseOpencode(pages.OPENCODE_GO_V2, P4_CTX)],
    ["qwencloud", parseQwencloud(pages.QWENCLOUD_SUBSCRIPTION, P4_CTX)],
    ["claude-loggedout", parseClaude(pages.LOGGED_OUT, CTX)],
  ];

  for (const [name, snap] of cases) {
    const errors = validate(schema, snap);
    assert.deepEqual(errors, [], `${name}: ${errors.join(" / ")}`);
  }
});

test("出力に秘匿情報が混入しない（ブラウザ系）", () => {
  const forbiddenKey = /token|secret|credential|password|api[_-]?key|cookie|session[_-]?id/i;
  const jwtLike = /\beyJ[A-Za-z0-9_-]{8,}/;

  for (const snap of [
    parseClaude(pages.CLAUDE_USAGE, CTX),
    parseGrok(pages.GROK_USAGE, CTX),
    parseCursor(pages.CURSOR_USAGE, CTX),
    parseOpencode(pages.OPENCODE_GO, P4_CTX),
    parseOpencode(pages.OPENCODE_GO_V2, P4_CTX),
    parseQwencloud(pages.QWENCLOUD_SUBSCRIPTION, P4_CTX),
  ]) {
    (function walk(node) {
      if (node === null || typeof node !== "object") {
        if (typeof node === "string") assert.ok(!jwtLike.test(node));
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        assert.ok(!forbiddenKey.test(k), `forbidden key: ${k}`);
        walk(v);
      }
    })(snap);
  }
});
