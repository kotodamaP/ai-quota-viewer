import test from "node:test";
import assert from "node:assert/strict";

import { convertAppServerRateLimits } from "../src/adapters/codex-app-server.mjs";
import { normalizeCodex } from "../src/normalize.mjs";

const RESPONSE = {
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1786954501 },
    planType: "pro",
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1786954501 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      planType: "pro",
    },
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1786978147 },
      secondary: null,
      credits: null,
      planType: "pro",
    },
  },
};

test("app-server: multi-bucket responseを既存Codex正規化入力へ変換する", () => {
  const collected = convertAppServerRateLimits(RESPONSE, {
    timestamp: "2026-08-10T14:45:00.000Z",
  });

  assert.equal(collected.plan, "pro");
  assert.equal(collected.byLimitId.size, 2);
  assert.equal(collected.byLimitId.get("codex").rl.primary.used_percent, 23);
  assert.equal(collected.byLimitId.get("codex").rl.primary.window_minutes, 10080);
});

test("app-server: canonicalには使用率23%として保持し、sourceを区別する", () => {
  const collected = convertAppServerRateLimits(RESPONSE, {
    timestamp: "2026-08-10T14:45:00.000Z",
  });
  const snapshot = normalizeCodex(collected, {
    offsetMinutes: 540,
    fetchedAt: "2026-08-10T23:45:00+09:00",
    source: "local-app-server",
  });

  const weekly = snapshot.limits.find((limit) => limit.limit_id === "codex").windows[0];
  assert.equal(snapshot.source, "local-app-server");
  assert.equal(weekly.used_percent, 23);
  assert.equal(100 - weekly.used_percent, 77);
});
