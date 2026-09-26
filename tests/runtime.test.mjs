import test from "node:test";
import assert from "node:assert/strict";

import { applyDefaults, severity, MIN_INTERVAL_MINUTES } from "../src/settings.mjs";
import { injectPricing, toJpy } from "../src/pricing.mjs";
import { findBreaches } from "../src/notify.mjs";

test("設定: 取得間隔は15分未満に下げられない（ハードリミット）", () => {
  const s = applyDefaults({ collect_interval_minutes: 1 });
  assert.equal(s.collect_interval_minutes, MIN_INTERVAL_MINUTES);
  assert.equal(s.interval_was_clamped, true);

  const ok = applyDefaults({ collect_interval_minutes: 30 });
  assert.equal(ok.collect_interval_minutes, 30);
  assert.equal(ok.interval_was_clamped, false);
});

test("設定: dashboard.host に 0.0.0.0 を指定しても 127.0.0.1 に落ちる", () => {
  const s = applyDefaults({ dashboard: { host: "0.0.0.0", port: 8080 } });
  assert.equal(s.dashboard.host, "127.0.0.1");
  assert.equal(s.dashboard.port, 8080);
});

test("設定: しきい値から表示区分が決まる", () => {
  const th = { warn: 70, danger: 90 };
  assert.equal(severity(10, th), "ok");
  assert.equal(severity(70, th), "warn");
  assert.equal(severity(89.9, th), "warn");
  assert.equal(severity(90, th), "danger");
  assert.equal(severity(null, th), "unknown");
});

test("単価: 未設定なら null のまま（推測値を入れない）", () => {
  const snap = {
    service: "claude",
    spend: { kind: "amount", currency: "USD", used_amount: 42, limit_amount: 100, used_percent: 80, balance: 58, unit_price_jpy: null },
    limits: [],
  };
  const pricing = { fx: { usd_jpy: null }, services: { claude: { unit_price_jpy: null, last_verified: "2026-07-25" } } };
  const { snapshot, warnings } = injectPricing(snap, pricing, { now: new Date(2026, 6, 25) });

  assert.equal(snapshot.spend.unit_price_jpy, null);
  assert.ok(warnings.some((w) => /円換算は表示しない/.test(w)));
});

test("単価: last_verified が古いと警告する", () => {
  const snap = { service: "codex", spend: { kind: "amount", used_amount: 1, limit_amount: null, used_percent: null, unit_price_jpy: null }, limits: [] };
  const pricing = { fx: {}, services: { codex: { unit_price_jpy: 1, last_verified: "2026-01-01" } } };
  const { warnings } = injectPricing(snap, pricing, { now: new Date(2026, 6, 25), staleDays: 90 });
  assert.ok(warnings.some((w) => /単価情報が\d+日前/.test(w)));
});

test("単価: used/limit が揃えば使用率を算出する", () => {
  const snap = { service: "cursor", spend: { kind: "amount", used_amount: 50, limit_amount: null, used_percent: null, unit_price_jpy: null }, limits: [] };
  const pricing = { fx: {}, services: { cursor: { monthly_cap_usd: 200, last_verified: "2026-07-25" } } };
  const { snapshot } = injectPricing(snap, pricing, { now: new Date(2026, 6, 25) });
  assert.equal(snapshot.spend.limit_amount, 200);
  assert.equal(snapshot.spend.used_percent, 25);
});

test("単価: 為替未設定なら円換算しない", () => {
  assert.equal(toJpy(100, { fx: { usd_jpy: null } }), null);
  assert.equal(toJpy(100, { fx: { usd_jpy: 150 } }), 15000);
});

test("為替: refreshFx がレートと単価を更新して config へ書き戻す", async () => {
  const { refreshFx } = await import("../src/pricing.mjs");
  const pricing = {
    fx: { usd_jpy: 100, last_verified: "2026-01-01", source: "manual" },
    services: {
      claude: { credit_unit: "USD", unit_price_jpy: 100 },
      codex: { credit_unit: "credit", usd_per_credit: 0.04, unit_price_jpy: 4 },
      qwencloud: { credit_unit: "quota", unit_price_jpy: null },
    },
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ rates: { JPY: 150.5 } }),
  });
  const file = "data/test-pricing.tmp.json";
  try {
    const next = await refreshFx(pricing, { file, now: new Date(2026, 7, 10) });
    assert.ok(next);
    assert.equal(next.fx.usd_jpy, 150.5);
    assert.equal(next.fx.last_verified, "2026-08-10");
    assert.equal(next.fx.auto, true);
    // USD建て単価はレートに追随、credit建ては usd_per_credit×レート、quota は null のまま
    assert.equal(next.services.claude.unit_price_jpy, 150.5);
    assert.equal(next.services.codex.unit_price_jpy, 6.02);
    assert.equal(next.services.qwencloud.unit_price_jpy, null);
    // ファイルにも書き戻されている
    const { readFile } = await import("node:fs/promises");
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.fx.usd_jpy, 150.5);
  } finally {
    globalThis.fetch = origFetch;
    const { rm } = await import("node:fs/promises");
    await rm(file, { force: true });
  }
});

test("為替: 書き戻しは今のファイルを土台にする（手で直した月額が古いメモリ内容に巻き戻らない）", async () => {
  const { refreshFx } = await import("../src/pricing.mjs");
  const { writeFile, readFile, rm } = await import("node:fs/promises");
  const stale = {
    fx: { usd_jpy: 100 },
    services: { claude: { credit_unit: "USD", unit_price_jpy: 100, subscription_monthly_usd: 20 } },
  };
  const file = "data/test-pricing-fresh.tmp.json";
  await writeFile(file, JSON.stringify({
    fx: { usd_jpy: 100 },
    services: { claude: { credit_unit: "USD", unit_price_jpy: 100, subscription_monthly_usd: 220 } },
  }), "utf8");
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ rates: { JPY: 150 } }) });
  try {
    const next = await refreshFx(stale, { file, now: new Date(2026, 8, 24) });
    assert.equal(next.services.claude.subscription_monthly_usd, 220);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.services.claude.subscription_monthly_usd, 220);
    assert.equal(saved.fx.usd_jpy, 150);
  } finally {
    globalThis.fetch = origFetch;
    await rm(file, { force: true });
  }
});

test("為替: 取得失敗なら何も変更しない（フェイルソフト）", async () => {
  const { refreshFx } = await import("../src/pricing.mjs");
  const pricing = {
    fx: { usd_jpy: 100, last_verified: "2026-01-01", source: "manual" },
    services: { claude: { credit_unit: "USD", unit_price_jpy: 100 } },
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  const file = "data/test-pricing-nofx.tmp.json";
  try {
    const next = await refreshFx(pricing, { file, now: new Date(2026, 7, 10) });
    assert.equal(next, null);
  } finally {
    globalThis.fetch = origFetch;
    const { rm } = await import("node:fs/promises");
    await rm(file, { force: true });
  }
});

test("通知: しきい値を超えた枠だけ抽出される", () => {
  const snapshots = [
    {
      service: "claude", ok: true,
      limits: [
        { limit_id: "all_models", label: "すべてのモデル", windows: [
          { window_minutes: 300, label: "5時間", used_percent: 95 },
          { window_minutes: 10080, label: "週次", used_percent: 10 },
        ]},
      ],
      spend: { used_percent: 94 },
    },
    { service: "codex", ok: true, limits: [{ limit_id: "codex", label: null, windows: [{ window_minutes: 10080, label: "週次", used_percent: 68 }] }], spend: null },
    { service: "grok", ok: false, limits: [], spend: null },
  ];

  const breaches = findBreaches(snapshots, 80);
  const keys = breaches.map((b) => b.key).sort();
  assert.deepEqual(keys, ["claude:all_models:300", "claude:spend"]);
  // 取得失敗した社は対象外
  assert.ok(!keys.some((k) => k.startsWith("grok")));
});
