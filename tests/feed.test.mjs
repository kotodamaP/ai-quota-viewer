import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { projectService, projectRunpod, subscriptionsOf, buildFeed, publishFeed, severityOf, staleAt } from "../src/feed.mjs";
import { parseClaude } from "../src/parse/claude.mjs";
import * as pages from "./fixtures/pages.mjs";
import { validate } from "./helpers/validate.mjs";

const W = (window_minutes, used_percent, extra = {}) => ({
  window_minutes, kind: "percent", label: window_minutes === 10080 ? "週次" : "5時間",
  used_percent, used_amount: null, limit_amount: null, resets_at: "2026-09-28T16:00:00+09:00", ...extra,
});
const snap = (service, limits, extra = {}) => ({
  service, plan: null, fetched_at: "2026-09-26T16:00:00+09:00", source_updated_at: null,
  source: "cdp-dom", ok: true, error: null, limits, spend: null, ...extra,
});
const OPTS = { intervalMinutes: 15 };

test("feed: weekly は既存の利用側と同じ枠に固定（Claude は all_models。Fable の方が逼迫していても選ばない）", () => {
  const s = projectService(snap("claude", [
    { limit_id: "all_models", label: "すべてのモデル", windows: [W(300, 20), W(10080, 69)] },
    { limit_id: "fable", label: "Fable", windows: [W(10080, 80)] },
  ]), OPTS);
  assert.equal(s.weekly.limit_id, "all_models");
  assert.equal(s.weekly.used_percent, 69);
  assert.equal(s.weekly.remaining_percent, 31);
  // headline は表示枠全体の最大（今のゲージと同じ）
  assert.equal(s.headline.limit_id, "fable");
  assert.equal(s.headline.severity, "warn");
});

test("feed: Codex は codex_bengalfox を窓からも weekly からも除く", () => {
  const s = projectService(snap("codex", [
    { limit_id: "codex", windows: [W(10080, 22)] },
    { limit_id: "codex_bengalfox", windows: [W(10080, 95)] },
  ]), OPTS);
  assert.equal(s.windows.length, 1);
  assert.equal(s.weekly.limit_id, "codex");
  assert.equal(s.headline.used_percent, 22);
});

test("feed: 旧形式の Grok（api/chat 分割）は週間共有枠1本へ合算する（画面の従来表示と同じ）", () => {
  const s = projectService(snap("grok", [
    { limit_id: "api", label: "API", windows: [W(10080, 18)] },
    { limit_id: "chat", label: "チャット", windows: [W(10080, 6)] },
  ]), OPTS);
  assert.equal(s.windows.length, 1);
  assert.equal(s.weekly.limit_id, "weekly");
  assert.equal(s.weekly.used_percent, 24);
});

test("feed: 枠が無く支出%だけあるサービスは headline が支出枠、weekly は null（値を作らない）", () => {
  const s = projectService(snap("opencode", [], { spend: { currency: "USD", used_amount: 5, limit_amount: 10, used_percent: 50, balance: null, auto_recharge: false, resets_at: null } }), OPTS);
  assert.equal(s.headline.limit_id, "spend");
  assert.equal(s.headline.limit_label, "クレジット");
  assert.equal(s.weekly, null);
  assert.equal(s.error, null);
});

test("feed: 生値を丸めずに載せ、severity は小数1桁丸めで判定（境界 50/80）", () => {
  assert.equal(severityOf(50.04), "ok");
  assert.equal(severityOf(50.05), "warn");
  assert.equal(severityOf(80.05), "danger");
  const s = projectService(snap("antigravity", [{ limit_id: "g", windows: [W(10080, 33.333)] }]), OPTS);
  assert.equal(s.weekly.used_percent, 33.333);
  assert.equal(s.weekly.remaining_percent, 100 - 33.333);
});

test("feed: stale_at = 取得時刻 + 取得間隔×2 + 5分。取得失敗は ok:false で枠を持たない", () => {
  assert.equal(staleAt("2026-09-26T16:00:00+09:00", 15), "2026-09-26T07:35:00.000Z");
  const s = projectService({ ...snap("claude", []), ok: false, error: "login-required" }, OPTS);
  assert.equal(s.ok, false);
  assert.equal(s.error, "login-required");
  assert.equal(s.headline, null);
  assert.deepEqual(s.windows, []);
});

test("feed: RunPod は前回値保持中なら ok:false のまま値と last_ok_at を載せ、stale_at は last_ok_at 基準", () => {
  const r = projectRunpod({ ok: false, error: "cdp-failed", fetched_at: "2026-09-26T17:00:00+09:00",
    last_ok_at: "2026-09-26T16:00:00+09:00", balance_usd: 33.25, spend_per_hr_usd: 0.02, hours_left: 1275 }, { intervalMinutes: 15, fx: 157.54 });
  assert.equal(r.ok, false);
  assert.equal(r.balance.usd, 33.25);
  assert.equal(r.balance.jpy, 5238);
  assert.equal(r.stale_at, "2026-09-26T07:35:00.000Z");
  assert.equal(projectRunpod(null, { intervalMinutes: 15 }).error, "not-collected-yet");
});

test("feed: 月額合計は予約済みの変更を次回額に反映し、USD建てがあるのに為替が無ければ null", () => {
  const pricing = { fx: { usd_jpy: 150 }, services: {
    claude: { subscription_monthly_usd: 220, scheduled_change: { effective: "2026-10-23", monthly_usd: 110 } },
    codex: { subscription_monthly_jpy: 14094 },
    cursor: { subscription_active: false, subscription_monthly_usd: null },
  } };
  const s = subscriptionsOf(pricing, new Date("2026-09-26T00:00:00Z"));
  assert.equal(s.monthly_total_jpy, 220 * 150 + 14094);
  assert.deepEqual(s.next, { effective: "2026-10-23", monthly_total_jpy: 110 * 150 + 14094 });
  assert.equal(subscriptionsOf({ fx: {}, services: pricing.services }).monthly_total_jpy, null);
  // 発効日を過ぎた予約は次回額に出さない
  assert.equal(subscriptionsOf(pricing, new Date("2026-10-24T00:00:00Z")).next, null);
});

test("feed: 実測フィクスチャから組み立てたフィードがスキーマに適合し、秘匿情報を含まない", async () => {
  const schema = JSON.parse(await readFile(path.join(process.cwd(), "schema", "quota-feed.v1.schema.json"), "utf8"));
  const ctx = { now: new Date("2026-07-25T12:00:00+09:00"), offsetMinutes: 540, fetchedAt: "2026-07-25T12:00:00+09:00" };
  const feed = buildFeed({
    snapshots: [parseClaude(pages.CLAUDE_USAGE, ctx), { ...snap("grok", []), ok: false, error: "login-required" }],
    pricing: { fx: { usd_jpy: 157.54, last_verified: "2026-09-26", source: "自動取得 (open.er-api.com)" }, services: { claude: { subscription_monthly_usd: 220 } } },
    runpod: { ok: true, error: null, fetched_at: "a", last_ok_at: "a", balance_usd: 33.25, spend_per_hr_usd: 0.02, hours_left: 1275 },
    settings: { collect_interval_minutes: 15 },
    generation: 7,
    now: new Date("2026-09-26T07:00:00Z"),
  });
  assert.deepEqual(validate(schema, feed), []);
  const text = JSON.stringify(feed);
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}\.|accessToken|refreshToken|api[_-]?key|password|•••• \d{4}/i);
  assert.equal(feed.services.at(-1).id, "runpod");
});

test("feed: publishFeed は generation を1つずつ進めて atomic に書く", async () => {
  const feedFile = "data/test-feed.tmp.json";
  await rm(feedFile, { force: true });
  try {
    const settings = { collect_interval_minutes: 15, services: {}, extras: { runpod: false } };
    const a = await publishFeed(settings, { feedFile });
    const b = await publishFeed(settings, { feedFile });
    assert.equal(a.generation, 1);
    assert.equal(b.generation, 2);
    assert.equal(JSON.parse(await readFile(feedFile, "utf8")).generation, 2);
  } finally {
    await rm(feedFile, { force: true });
  }
});
