import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";

import { parseRunpodBilling, isRunpodLogin } from "../src/parse/runpod.mjs";
import { saveRunpod, readRunpod } from "../src/adapters/runpod.mjs";

const CTX = { fetchedAt: "2026-09-26T10:00:00+09:00" };

test("RunPod: Balance 見出しの近くの $ 金額を残高として読む（$/hr は残高にしない）", () => {
  const r = parseRunpodBilling("Billing\nCurrent spend rate\n$0.44/hr\nBalance\n$23.51\nAdd credits", CTX);
  assert.equal(r.ok, true);
  assert.equal(r.balance_usd, 23.51);
  assert.equal(r.spend_per_hr_usd, 0.44);
});

test("RunPod: 請求画面（合成フィクスチャ）— 上限レート $50/hr を消費レートと取り違えない", () => {
  const text = [
    "Account balance", "$25.50", "Current spend rate", "$0.020/hr", "Spend rate limit", "$50.00/hr",
    "Estimated time left", "1,275 hours", "Choose an amount to add.", "$150", "$200", "Auto-Pay", "Disabled",
  ].join("\n");
  const r = parseRunpodBilling(text, CTX);
  assert.equal(r.ok, true);
  assert.equal(r.balance_usd, 25.5);
  assert.equal(r.spend_per_hr_usd, 0.02);
  assert.equal(r.spend_limit_per_hr_usd, 50);
  assert.equal(r.hours_left, 1275);
  assert.equal(r.auto_pay, false);
});

test("RunPod: 同じ行の残高とカンマ区切りも読める／消費レートが無ければ null（0 と区別）", () => {
  const r = parseRunpodBilling("Account Balance: $1,234.50", CTX);
  assert.equal(r.balance_usd, 1234.5);
  assert.equal(r.spend_per_hr_usd, null);
});

test("RunPod: サインアップ画面は login-required、残高が無い画面は balance-not-found", () => {
  const signup = "Create your account\nSign up with Google\nSign up with GitHub";
  assert.equal(isRunpodLogin(signup), true);
  assert.equal(parseRunpodBilling(signup, CTX).error, "login-required");
  assert.equal(parseRunpodBilling("Pods\nServerless", CTX).error, "balance-not-found");
});

test("RunPod: 取得失敗時は最後に取れた残高を残し、成功時だけ簡易ログへ追記する", async () => {
  const latestFile = "data/test-runpod-latest.tmp.json";
  const historyFile = "data/test-runpod-history.tmp.jsonl";
  await rm(latestFile, { force: true });
  await rm(historyFile, { force: true });
  try {
    const now = new Date("2026-09-26T01:00:00Z");
    await saveRunpod({ ok: true, error: null, fetched_at: "a", balance_usd: 20, spend_per_hr_usd: 0 }, { latestFile, historyFile, now });
    const kept = await saveRunpod({ ok: false, error: "login-required", fetched_at: "b", balance_usd: null, spend_per_hr_usd: null }, { latestFile, historyFile, now });
    assert.equal(kept.balance_usd, 20);
    assert.equal(kept.last_ok_at, "a");
    assert.equal(kept.error, "login-required");
    const lines = (await readFile(historyFile, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const view = await readRunpod({ latestFile, historyFile, now });
    assert.deepEqual(view.history.map((h) => h.v), [20]);
  } finally {
    await rm(latestFile, { force: true });
    await rm(historyFile, { force: true });
  }
});
