import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractFromText, reduceLatest, collectCodex, findSessionFiles } from "../src/adapters/codex.mjs";
import { normalizeCodex } from "../src/normalize.mjs";
import { toIsoWithOffset, windowLabel } from "../src/time.mjs";
import { validate } from "./helpers/validate.mjs";
import * as fx from "./fixtures/samples.mjs";

const JST = 540;
const FETCHED_AT = "2026-07-25T12:00:00+09:00";

function normalizeText(text) {
  return normalizeCodex(reduceLatest(extractFromText(text)), {
    offsetMinutes: JST,
    fetchedAt: FETCHED_AT,
  });
}

test("T1: 現行フォーマット — 週枠1件が正しく取れる", () => {
  const snap = normalizeText(fx.CURRENT_FORMAT);

  assert.equal(snap.service, "codex");
  assert.equal(snap.plan, "pro");
  assert.equal(snap.limits.length, 1);

  const windows = snap.limits[0].windows;
  assert.equal(windows.length, 1);
  assert.equal(windows[0].window_minutes, 10080);
  assert.equal(windows[0].used_percent, 68);
  assert.equal(windows[0].label, "週次");
  assert.equal(windows[0].resets_at, "2026-07-29T02:02:34+09:00");
});

test("T2: 旧フォーマット — スロット名ではなく window_minutes で判定される", () => {
  const snap = normalizeText(fx.LEGACY_FORMAT);
  const windows = snap.limits[0].windows;

  assert.equal(windows.length, 2);

  const byMinutes = Object.fromEntries(windows.map((w) => [w.window_minutes, w]));

  // primary に入っていた 300 が「5時間」と判定されること
  assert.equal(byMinutes[300].label, "5時間");
  assert.equal(byMinutes[300].used_percent, 1);

  // secondary に入っていた 10080 が「週次」と判定されること
  assert.equal(byMinutes[10080].label, "週次");
  assert.equal(byMinutes[10080].used_percent, 40);
});

test("T3: window_minutes=0 の不正値は除外される", () => {
  const snap = normalizeText(fx.ZERO_WINDOW);
  // 有効な窓が無くなるので limit ごと出ない
  assert.equal(snap.limits.length, 0);
});

test("T3b: 不正窓と正常窓が混在しても正常窓だけ残る", () => {
  const snap = normalizeText([fx.ZERO_WINDOW, fx.BENGALFOX].join("\n"));
  const ids = snap.limits.map((l) => l.limit_id);
  assert.deepEqual(ids, ["codex_bengalfox"]);
});

test("T4: limit_id ごとに独立した枠として出る（codex と codex_bengalfox は統合しない）", () => {
  // ★2026-08-10: codex 系の統合は廃止。bengalfox はモデル固有枠/実験枠の可能性があり、
  //   codex の後継と断定しない（Codex 助言）。JSONL フォールバック時は両枠独立で出る。
  const snap = normalizeText([fx.CURRENT_FORMAT, fx.BENGALFOX].join("\n"));

  assert.equal(snap.limits.length, 2);
  const ids = snap.limits.map((l) => l.limit_id);
  assert.deepEqual(ids, ["codex", "codex_bengalfox"]);

  const spark = snap.limits.find((l) => l.limit_id === "codex_bengalfox");
  assert.equal(spark.label, "GPT-5.3-Codex-Spark");
  assert.equal(spark.windows[0].used_percent, 0);
});

test("T5: 枠が無い limit_id は limits[] に出ない", () => {
  const snap = normalizeText([fx.CURRENT_FORMAT, fx.PREMIUM_NO_WINDOW].join("\n"));
  const ids = snap.limits.map((l) => l.limit_id);
  assert.ok(!ids.includes("premium"));
  assert.deepEqual(ids, ["codex"]);
});

test("T6: unix秒 -> オフセット付きISO8601", () => {
  assert.equal(toIsoWithOffset(1785258154, 540), "2026-07-29T02:02:34+09:00");
  assert.equal(toIsoWithOffset(1785258154, 0), "2026-07-28T17:02:34+00:00");
  assert.equal(toIsoWithOffset(1785258154, -300), "2026-07-28T12:02:34-05:00");
  assert.equal(toIsoWithOffset(Number.NaN, 540), null);

  assert.equal(windowLabel(300), "5時間");
  assert.equal(windowLabel(10080), "週次");
  assert.equal(windowLabel(43200), "月次");
  assert.equal(windowLabel(77), "77分");
});

test("T7: 同一 limit_id では最新タイムスタンプが勝つ", () => {
  // 意図的に古い方をあとに並べる
  const snap = normalizeText([fx.CURRENT_FORMAT, fx.OLDER_SAME_LIMIT].join("\n"));

  assert.equal(snap.limits.length, 1);
  assert.equal(snap.limits[0].windows[0].used_percent, 68); // 64 ではない
  assert.equal(snap.plan, "pro"); // prolite ではない
});

test("T7b: 同一リセット枠で使用率が低いイベントは複製として無視される（タイムスタンプが新しくても）", () => {
  // 8/10 05:51 に発生した実例: 過去セッション(n=649)の rate_limits 履歴が
  // 新しい rollout ファイルへ「新しいタイムスタンプ付きで」複製され、
  // 古い値(45%)が最新(84%)より新しく見える状態を再現する。
  const olderReal = {
    timestamp: "2026-08-09T20:43:52.226Z",
    rl: {
      limit_id: "codex",
      plan_type: "pro",
      primary: { used_percent: 84, window_minutes: 10080, resets_at: 1786825788 },
      secondary: null,
    },
  };
  const duplicatedStale = {
    timestamp: "2026-08-09T20:51:30.432Z", // 新しいタイムスタンプ
    rl: {
      limit_id: "codex",
      plan_type: "pro",
      primary: { used_percent: 45, window_minutes: 10080, resets_at: 1786825788 }, // 古い値
      secondary: null,
    },
  };
  const { byLimitId } = reduceLatest([duplicatedStale, olderReal]);
  assert.equal(byLimitId.get("codex").rl.primary.used_percent, 84);
});

test("T7c: リセット後（resets_at が変わる）なら低い値でも新しいイベントが勝つ", () => {
  const before = {
    timestamp: "2026-08-09T20:00:00.000Z",
    rl: {
      limit_id: "codex",
      plan_type: "pro",
      primary: { used_percent: 84, window_minutes: 10080, resets_at: 1786825788 },
      secondary: null,
    },
  };
  const afterReset = {
    timestamp: "2026-08-16T05:30:00.000Z",
    rl: {
      limit_id: "codex",
      plan_type: "pro",
      primary: { used_percent: 2, window_minutes: 10080, resets_at: 1786920000 },
      secondary: null,
    },
  };
  const { byLimitId } = reduceLatest([before, afterReset]);
  assert.equal(byLimitId.get("codex").rl.primary.used_percent, 2);
  assert.equal(byLimitId.get("codex").rl.primary.resets_at, 1786920000);
});

test("T8: 壊れた行が混ざっても例外を投げず正常行だけ処理する", () => {
  const text = [fx.BROKEN_LINES, fx.CURRENT_FORMAT, "garbage"].join("\n");

  assert.doesNotThrow(() => normalizeText(text));
  const snap = normalizeText(text);
  assert.equal(snap.limits.length, 1);
  assert.equal(snap.limits[0].windows[0].used_percent, 68);
});

test("T9: 出力に秘匿情報が混入しない", () => {
  const snap = normalizeText([fx.CURRENT_FORMAT, fx.BENGALFOX, fx.WITH_CREDITS].join("\n"));

  const forbiddenKey = /token|secret|credential|password|api[_-]?key|cookie|session[_-]?id/i;
  const jwtLike = /\beyJ[A-Za-z0-9_-]{8,}/;

  const seenKeys = [];
  (function walk(node) {
    if (node === null || typeof node !== "object") {
      if (typeof node === "string") assert.ok(!jwtLike.test(node), `JWT-like value found: ${node}`);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      seenKeys.push(key);
      assert.ok(!forbiddenKey.test(key), `forbidden key found: ${key}`);
      walk(value);
    }
  })(snap);

  assert.ok(seenKeys.length > 0);
  // 生のトークン文字列を含む入力を通しても素通ししないこと
  assert.ok(!JSON.stringify(snap).includes("eyJ"));
});

test("T10: 出力が canonical.schema.json に適合する", async () => {
  const schemaPath = path.join(process.cwd(), "schema", "canonical.schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));

  for (const [name, text] of [
    ["current", fx.CURRENT_FORMAT],
    ["legacy", fx.LEGACY_FORMAT],
    ["multi", [fx.CURRENT_FORMAT, fx.BENGALFOX, fx.PREMIUM_NO_WINDOW].join("\n")],
    ["credits", fx.WITH_CREDITS],
  ]) {
    const errors = validate(schema, normalizeText(text));
    assert.deepEqual(errors, [], `${name}: ${errors.join(" / ")}`);
  }
});

test("credits: has_credits=false かつ balance=0 なら spend は null", () => {
  const snap = normalizeText(fx.CURRENT_FORMAT);
  assert.equal(snap.spend, null);
});

test("credits: 残高がある場合は spend が組み立てられる", () => {
  const snap = normalizeText(fx.WITH_CREDITS);
  assert.equal(snap.spend.kind, "amount");
  assert.equal(snap.spend.balance, 25.5);
  assert.equal(snap.spend.unit_price_jpy, null);
});

test("findSessionFiles: rollout以外と資格情報ファイルを拾わない / mtime降順で打ち切る", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aqv-"));
  const nested = path.join(dir, "2026", "07", "25");
  await mkdir(nested, { recursive: true });

  await writeFile(path.join(nested, "rollout-a.jsonl"), fx.CURRENT_FORMAT);
  await writeFile(path.join(nested, "rollout-b.jsonl"), fx.BENGALFOX);
  await writeFile(path.join(nested, "auth.json"), '{"secret":"must-not-be-read"}');
  await writeFile(path.join(nested, "notes.txt"), "ignore me");

  const files = await findSessionFiles(dir, { maxFiles: 10 });
  assert.equal(files.length, 2);
  assert.ok(files.every((f) => path.basename(f).startsWith("rollout-")));
  assert.ok(!files.some((f) => f.includes("auth.json")));

  const capped = await findSessionFiles(dir, { maxFiles: 1 });
  assert.equal(capped.length, 1);
});

test("collectCodex: 一時ディレクトリから読み込んで畳み込める", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aqv-"));
  await writeFile(path.join(dir, "rollout-x.jsonl"), [fx.CURRENT_FORMAT, fx.BENGALFOX].join("\n"));

  const collected = await collectCodex({ root: dir, maxFiles: 5 });
  assert.equal(collected.filesScanned, 1);
  assert.equal(collected.byLimitId.size, 2);
  assert.equal(collected.plan, "pro");
});

test("collectCodex: 最新30ファイルが補助枠だけでも既定探索範囲から週次codex枠を回収する", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aqv-"));
  const baseSeconds = Math.floor(Date.now() / 1000) - 1000;
  const codexFile = path.join(dir, "rollout-codex.jsonl");

  await writeFile(codexFile, fx.CURRENT_FORMAT);
  await utimes(codexFile, baseSeconds, baseSeconds);

  // 旧30件打ち切りでは、これらだけが読まれて通常のcodex枠が消えていた。
  for (let i = 0; i < 35; i += 1) {
    const file = path.join(dir, `rollout-bengal-${String(i).padStart(2, "0")}.jsonl`);
    await writeFile(file, fx.BENGALFOX);
    await utimes(file, baseSeconds + i + 1, baseSeconds + i + 1);
  }

  const collected = await collectCodex({ root: dir });
  assert.equal(collected.filesScanned, 36);
  assert.equal(collected.byLimitId.get("codex").rl.primary.used_percent, 68);
});
