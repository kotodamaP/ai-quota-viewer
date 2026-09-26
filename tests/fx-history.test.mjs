import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";

import { recordFx, readFxHistory, parseEcbSeries, loadEcbSeries } from "../src/fx-history.mjs";

test("為替ログ: 同じレートは6時間未満なら追記しない／変わったら追記する", async () => {
  const file = "data/test-fx-history.tmp.jsonl";
  await rm(file, { force: true });
  try {
    const t0 = new Date("2026-09-25T00:00:00Z");
    assert.equal(await recordFx({ usd_jpy: 158.13, source: "a" }, { file, now: t0 }), true);
    assert.equal(await recordFx({ usd_jpy: 158.13, source: "a" }, { file, now: new Date(t0.getTime() + 15 * 60_000) }), false);
    assert.equal(await recordFx({ usd_jpy: 158.2, source: "a" }, { file, now: new Date(t0.getTime() + 30 * 60_000) }), true);
    assert.equal(await recordFx({ usd_jpy: 158.2, source: "a" }, { file, now: new Date(t0.getTime() + 7 * 3_600_000) }), true);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 3);
  } finally {
    await rm(file, { force: true });
  }
});

test("為替ログ: 直近7日だけを古い順に返し、壊れた行は読み飛ばす", async () => {
  const file = "data/test-fx-history-read.tmp.jsonl";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, [
    JSON.stringify({ t: "2026-09-10T00:00:00Z", usd_jpy: 150 }),
    "not json",
    JSON.stringify({ t: "2026-09-24T00:00:00Z", usd_jpy: 158 }),
    JSON.stringify({ t: "2026-09-20T00:00:00Z", usd_jpy: 157 }),
  ].join("\n") + "\n", "utf8");
  try {
    const rows = await readFxHistory({ file, days: 7, now: new Date("2026-09-25T00:00:00Z") });
    assert.deepEqual(rows.map((r) => r.usd_jpy), [157, 158]);
  } finally {
    await rm(file, { force: true });
  }
});

test("ECB系列: frankfurter の時系列を日付順に取り出す（週末の欠けはそのまま）", () => {
  const series = parseEcbSeries({
    rates: { "2026-09-22": { JPY: 157.18 }, "2026-09-18": { JPY: 157.89 }, "2026-09-21": { JPY: 157.27 }, bad: { JPY: 1 } },
  });
  assert.deepEqual(series.map((s) => s.date), ["2026-09-18", "2026-09-21", "2026-09-22"]);
});

test("ECB系列: 当日取得済みならキャッシュを使い、取得失敗時は古いキャッシュを返す", async () => {
  const file = "data/test-fx-ecb.tmp.json";
  await rm(file, { force: true });
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, json: async () => ({ rates: { "2026-09-24": { JPY: 158.85 } } }) }; };
  const down = async () => { calls++; throw new Error("down"); };
  try {
    const now = new Date("2026-09-25T03:00:00Z");
    assert.deepEqual(await loadEcbSeries({ file, now, fetchImpl: ok }), [{ date: "2026-09-24", usd_jpy: 158.85 }]);
    await loadEcbSeries({ file, now, fetchImpl: ok });
    assert.equal(calls, 1, "同じ日は取り直さない");
    const tomorrow = new Date("2026-09-26T03:00:00Z");
    assert.deepEqual(await loadEcbSeries({ file, now: tomorrow, fetchImpl: down }), [{ date: "2026-09-24", usd_jpy: 158.85 }]);
  } finally {
    await rm(file, { force: true });
  }
});
