import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  parseGemini, parseAmount, parsePair, nextDailyReset, RESET_UTC_HOUR,
} from "../src/parse/gemini.mjs";
import { slugify } from "../src/time.mjs";
import { validate } from "./helpers/validate.mjs";
import * as pages from "./fixtures/pages.mjs";

// 実測と同じ 2026-09-13 00:40 JST を基準時刻にする
const NOW = new Date("2026-09-13T00:40:00+09:00");
const CTX = { now: NOW, offsetMinutes: 540, fetchedAt: "2026-09-13T00:40:00+09:00" };

test("Gemini: 数値表記（K/M・無制限・-）を解釈する", () => {
  assert.equal(parseAmount("250"), 250);
  assert.equal(parseAmount("82.53K"), 82530);
  assert.equal(parseAmount("1M"), 1_000_000);
  assert.equal(parseAmount("14.4K"), 14400);
  assert.equal(parseAmount("無制限"), null);
  assert.equal(parseAmount("-"), null);
  assert.equal(parseAmount(""), null);

  assert.deepEqual(parsePair("5 / 5"), { used: 5, limit: 5, percent: 100 });
  assert.deepEqual(parsePair("1 / 20"), { used: 1, limit: 20, percent: 5 });
  const tpm = parsePair("7.78K / 250K");
  assert.equal(tpm.used, 7780);
  assert.equal(tpm.limit, 250000);
  assert.equal(tpm.percent, 3.1);
  // 上限「無制限」は枠にしない（Live API の RPM/RPD がこれに当たる）
  assert.equal(parsePair("0 / 無制限"), null);
  assert.equal(parsePair("- / -"), null);
});

test("Gemini: リセットは 08:00 UTC 固定の次の日境界（ページのUTC-8表記は使わない）", () => {
  assert.equal(RESET_UTC_HOUR, 8);
  // 2026-09-13 00:40 JST = 09-12 15:40Z → 次の 08:00Z は 09-13
  assert.equal(nextDailyReset(NOW).toISOString(), "2026-09-13T08:00:00.000Z");
  // 境界の直前ちょうど（08:00:00Z）は「次」なので翌日へ送る
  assert.equal(
    nextDailyReset(new Date("2026-09-13T08:00:00Z")).toISOString(),
    "2026-09-14T08:00:00.000Z"
  );
  // 境界の1分前は当日
  assert.equal(
    nextDailyReset(new Date("2026-09-13T07:59:00Z")).toISOString(),
    "2026-09-13T08:00:00.000Z"
  );
});

test("Gemini: 無料枠テーブルからモデル別の3指標を取り出す", () => {
  const snap = parseGemini(pages.GEMINI_RATE_LIMIT, CTX);

  assert.equal(snap.ok, true);
  assert.equal(snap.service, "gemini");
  assert.equal(snap.source, "cdp-dom");
  // どの枠を見ているかをスナップショットに残す（別プロジェクトの数字と誤認しない）。
  // ★Google AI Pro（Gemini アプリのサブスク）は混ぜない。ここは API の枠だけ。
  assert.equal(snap.plan, "無料枠 · Project: SampleProject");
  // サービス側の集計時刻は公開されていないので null（期間の終端は未来の日境界）
  assert.equal(snap.source_updated_at, null);

  // 未使用の Antigravity は落ち、逼迫している順に並ぶ
  assert.deepEqual(snap.limits.map((l) => l.limit_id), ["gemini-3.8-flash", "gemini-3.6-flash"]);

  const top = snap.limits[0];
  assert.equal(top.label, "Gemini 3.8 Flash（上限到達）");
  assert.deepEqual(
    top.windows.map((w) => [w.label, w.window_minutes, w.kind]),
    [
      ["日次RPD（当日）", 1440, "percent"],
      ["毎分RPM（ピーク）", 1, "percent"],
      ["毎分TPM（ピーク）", 1, "amount"],
    ]
  );

  const [rpd, rpm, tpm] = top.windows;
  // 24 / 20 … 無料枠の1日上限を超えている状態を 100% で潰さずに保持する
  assert.equal(rpd.used_percent, 120);
  assert.equal(rpd.used_amount, 24);
  assert.equal(rpd.limit_amount, 20);
  // リセット＝次の UTC-8 日境界（JST 17:00）
  assert.equal(rpd.resets_at, "2026-09-13T17:00:00+09:00");

  assert.equal(rpm.used_percent, 100);
  assert.equal(rpm.used_amount, 5);
  assert.equal(rpm.limit_amount, 5);
  // 分あたりの枠に「リセット時刻」は無い（ページも出さない）
  assert.equal(rpm.resets_at, null);

  assert.equal(tpm.used_percent, 3.1);
  assert.equal(tpm.used_amount, 7780);
  assert.equal(tpm.limit_amount, 250000);
});

test("Gemini: 上限が「無制限」の指標は枠を作らない", () => {
  const snap = parseGemini(pages.GEMINI_RATE_LIMIT_UNLIMITED, CTX);

  assert.equal(snap.ok, true);
  assert.equal(snap.plan, "無料枠 · Project: SampleProject"); // PRO バッジ無し
  const windows = snap.limits[0].windows;
  assert.deepEqual(windows.map((w) => w.label), ["毎分TPM（ピーク）"]);
  assert.equal(windows[0].limit_amount, 65000);
});

test("Gemini: 日境界をまたいだ収集でもリセットは常に未来になる", () => {
  // 2026-09-14 09:00 JST = 09-14 00:00Z → その日の 08:00Z が次の境界
  const ctx = { ...CTX, now: new Date("2026-09-14T09:00:00+09:00") };
  const snap = parseGemini(pages.GEMINI_RATE_LIMIT, ctx);
  assert.equal(snap.limits[0].windows[0].resets_at, "2026-09-14T17:00:00+09:00");
  assert.ok(new Date(snap.limits[0].windows[0].resets_at) > ctx.now);
});

test("Gemini: Antigravity 行しか無い場合は取得失敗にしない（枠だけ空）", () => {
  // 実測 2026-09-13 17:56: APIキーを使わなくなったため、折りたたみ表示には
  // Antigravity 行だけが残った。これは取得失敗ではなく「出す枠が無い」状態。
  const payload = JSON.parse(pages.GEMINI_RATE_LIMIT);
  payload.models = payload.models.filter((m) => m.name === "Antigravity");
  assert.equal(payload.models.length, 1);

  const snap = parseGemini(JSON.stringify(payload), CTX);
  assert.equal(snap.ok, true);
  assert.equal(snap.error, null);
  assert.equal(snap.plan, "無料枠 · Project: SampleProject");
  assert.deepEqual(snap.limits, []);
});

test("Gemini: 表が無い・JSONでない場合は ok=false に落ちる", () => {
  for (const text of [
    pages.LOGGED_OUT,
    "",
    "{}",
    JSON.stringify({ tier: "無料枠", models: [] }),
    JSON.stringify({ tier: "無料枠" }),
  ]) {
    const snap = parseGemini(text, CTX);
    assert.equal(snap.ok, false, `text=${text.slice(0, 30)}`);
    assert.equal(snap.error, "usage-section-not-found");
    assert.deepEqual(snap.limits, []);
    assert.equal(snap.spend, null);
  }
});

test("Gemini: limit_id は表示名から安定した slug を作る", () => {
  assert.equal(slugify("Gemini 3.8 Flash"), "gemini-3.8-flash");
  assert.equal(slugify("Gemini 2.5 Flash TTS"), "gemini-2.5-flash-tts");
  assert.equal(slugify("Nano Banana (Gemini 3 Pro Image)"), "nano-banana-gemini-3-pro-image");
});

test("Gemini: 出力が canonical.schema.json に適合する", async () => {
  const schema = JSON.parse(
    await readFile(path.join("schema", "canonical.schema.json"), "utf8")
  );
  const snap = parseGemini(pages.GEMINI_RATE_LIMIT, CTX);
  const errors = validate(schema, snap);
  assert.deepEqual(errors, []);
});
