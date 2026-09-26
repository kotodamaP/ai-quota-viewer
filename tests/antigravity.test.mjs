import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseAntigravity, findUsagePayload } from "../src/parse/antigravity.mjs";
import { validate } from "./helpers/validate.mjs";
import * as pages from "./fixtures/pages.mjs";

// 実測と同じ 2026-09-13 17:55 JST を基準時刻にする
const NOW = new Date("2026-09-13T17:55:00+09:00");
const CTX = { now: NOW, offsetMinutes: 540, fetchedAt: "2026-09-13T17:55:00+09:00" };

/** 実測JSONの remaining_fraction を差し替えて「使用中」の状態を作る */
function withRemaining(text, map) {
  const line = text.split("\n").find((l) => l.trim().startsWith("{"));
  const obj = JSON.parse(line);
  for (const g of obj.command.data.groups) {
    for (const b of g.buckets) {
      if (b.id in map) b.remaining_fraction = map[b.id];
    }
  }
  return JSON.stringify(obj);
}

test("Antigravity: usage コマンドの JSON 行だけを拾う（警告行が混ざっても壊れない）", () => {
  const payload = findUsagePayload(pages.ANTIGRAVITY_USAGE);
  assert.ok(payload, "usage payload が取れること");
  assert.equal(payload.groups.length, 2);

  // JSON が無い / 別コマンドなら null
  assert.equal(findUsagePayload("Loading extension: x\nnot json"), null);
  assert.equal(findUsagePayload(JSON.stringify({ command: { name: "model", data: {} } })), null);
});

test("Antigravity: グループ×窓を canonical へ写像する", () => {
  const snap = parseAntigravity(pages.ANTIGRAVITY_USAGE, CTX);

  assert.equal(snap.ok, true);
  assert.equal(snap.service, "antigravity");
  assert.equal(snap.source, "local-cli");
  // ★サービス側が tier 名を名乗らないので plan は推測しない
  assert.equal(snap.plan, null);
  assert.equal(snap.spend, null);

  // ★2026-09-13 ユーザー判断: 非 Gemini レーン（Claude / GPT 系）はカードに出さない。
  //   元データに 2 群あること（上の groups.length === 2）は残したまま、写像だけ絞る。
  assert.deepEqual(
    snap.limits.map((l) => [l.limit_id, l.label]),
    [["gemini-models", "Gemini Models"]]
  );

  const gemini = snap.limits[0];
  // 窓は短い順（5時間 → 週次）
  assert.deepEqual(gemini.windows.map((w) => w.window_minutes), [300, 10080]);
  assert.deepEqual(gemini.windows.map((w) => w.label), ["5時間", "週次"]);
  assert.equal(gemini.windows[0].kind, "percent");

  // remaining_fraction=1 → 使用率 0%（残量100%）
  assert.equal(gemini.windows[0].used_percent, 0);
  // reset_time は UTC の ISO → +09:00 の ISO へ
  assert.equal(gemini.windows[0].resets_at, "2026-09-13T22:51:21+09:00");
  assert.equal(gemini.windows[1].resets_at, "2026-09-20T17:51:21+09:00");
  assert.equal(gemini.windows[0].used_amount, null);
  assert.equal(gemini.windows[0].limit_amount, null);
});

test("Antigravity: 残量は使用率へ変換する（remaining 0.25 → 75%）", () => {
  const text = withRemaining(pages.ANTIGRAVITY_USAGE, {
    "gemini-5h": 0.25,
    "gemini-weekly": 0.9,
  });
  const snap = parseAntigravity(text, CTX);

  const gemini = snap.limits.find((l) => l.limit_id === "gemini-models");
  assert.equal(gemini.windows.find((w) => w.window_minutes === 300).used_percent, 75);
  assert.equal(gemini.windows.find((w) => w.window_minutes === 10080).used_percent, 10);
});

test("Antigravity: Claude / GPT 群はカードに出さない（Gemini 側だけ見る）", () => {
  const snap = parseAntigravity(pages.ANTIGRAVITY_USAGE, CTX);
  assert.deepEqual(snap.limits.map((l) => l.limit_id), ["gemini-models"]);
  // パーサがデータを落としているのではなく、写像の段で除外していること
  assert.equal(findUsagePayload(pages.ANTIGRAVITY_USAGE).groups.length, 2);
});

test("Antigravity: 未知の窓は枠を作らない（推測しない）", () => {
  const obj = JSON.parse(pages.ANTIGRAVITY_USAGE.split("\n").find((l) => l.trim().startsWith("{")));
  obj.command.data.groups[0].buckets.push({
    id: "gemini-daily",
    name: "Daily Limit Remaining",
    window: "daily",
    remaining_fraction: 0.5,
  });
  const snap = parseAntigravity(JSON.stringify(obj), CTX);
  const gemini = snap.limits.find((l) => l.limit_id === "gemini-models");
  assert.deepEqual(gemini.windows.map((w) => w.window_minutes), [300, 10080]);
});

test("Antigravity: 未サインインは原因が分かるエラーになる", () => {
  const snap = parseAntigravity(pages.ANTIGRAVITY_NOT_SIGNED_IN, CTX);
  assert.equal(snap.ok, false);
  assert.equal(snap.error, "usage-not-signed-in");
  assert.equal(snap.source, "local-cli");
  assert.deepEqual(snap.limits, []);
});

test("Antigravity: usage 出力が無い場合は usage-output-not-found", () => {
  for (const text of ["", "Loading extension: x", '{"event":"init"}', pages.LOGGED_OUT]) {
    const snap = parseAntigravity(text, CTX);
    assert.equal(snap.ok, false, `text=${text.slice(0, 20)}`);
    assert.equal(snap.error, "usage-output-not-found");
  }
});

test("Antigravity: 出力が canonical.schema.json に適合する", async () => {
  const schema = JSON.parse(
    await readFile(path.join("schema", "canonical.schema.json"), "utf8")
  );
  for (const text of [pages.ANTIGRAVITY_USAGE, pages.ANTIGRAVITY_NOT_SIGNED_IN]) {
    const errors = validate(schema, parseAntigravity(text, CTX));
    assert.deepEqual(errors, []);
  }
});
