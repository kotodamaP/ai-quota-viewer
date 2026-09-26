import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = fs.readFileSync(
  new URL("../src/dashboard/public/index.html", import.meta.url),
  "utf8",
);
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

function extractFunction(name) {
  const start = inlineScript.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} がインラインスクリプトに存在する`);

  const bodyStart = inlineScript.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < inlineScript.length; i += 1) {
    if (inlineScript[i] === "{") depth += 1;
    if (inlineScript[i] !== "}") continue;
    depth -= 1;
    if (depth === 0) return inlineScript.slice(start, i + 1);
  }
  throw new Error(`${name} の終端を検出できません`);
}

const percentMetric = vm.runInNewContext(`(${extractFunction("percentMetric")})`);

test("dashboard: 全サービスのメーターは used_percent と同じ向きで増える", () => {
  const metric = percentMetric(53);
  assert.equal(metric.used, 53);
  assert.equal(metric.value, 53);
  assert.equal(metric.label, "使用率");
  assert.equal(percentMetric(120).value, 100);
  assert.equal(percentMetric(-5).value, 0);
});

test("dashboard: percentMetric に Codex専用分岐を再導入しない", () => {
  assert.equal(percentMetric.length, 1);
  assert.doesNotMatch(inlineScript, /percentMetric\(snap\s*,/);
  assert.match(inlineScript, /percentMetric\(src\.w\.used_percent\)/);
  assert.match(inlineScript, /percentMetric\(w\.used_percent\)/);
});

