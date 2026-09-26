/**
 * 全サービスの収集オーケストレータ。
 * ★フェイルソフト: 1社の失敗が他社に影響しない（設計仕様 設計原則）。
 *   失敗した社は ok:false のスナップショットになり、他社は正常に出る。
 */

import { collectCodex, DEFAULT_CODEX_SESSION_SCAN_LIMIT } from "./adapters/codex.mjs";
import { collectCodexFromAppServer } from "./adapters/codex-app-server.mjs";
import { normalizeCodex, failureSnapshot } from "./normalize.mjs";
import { collectBrowserService, BROWSER_SERVICES as BROWSER_SERVICE_SPECS } from "./adapters/browser.mjs";
import { collectAntigravity } from "./adapters/agy.mjs";
import { injectPricing, refreshFx } from "./pricing.mjs";
import { recordFx } from "./fx-history.mjs";
import { collectRunpod, saveRunpod } from "./adapters/runpod.mjs";
import { saveSnapshot } from "./store.mjs";
import { publishFeed } from "./feed.mjs";
import { toIsoWithOffset, localOffsetMinutes } from "./time.mjs";
import { Cdp } from "./cdp.mjs";
import { ManagedChrome } from "./chrome/managed.mjs";

// ★browser.mjs の BROWSER_SERVICES 定義を正本にする（追加・削除は一箇所で済む）
const BROWSER_SERVICES = Object.keys(BROWSER_SERVICE_SPECS);

async function collectCodexSnapshot(ctx) {
  try {
    const collected = await collectCodexFromAppServer({ now: ctx.now });
    return normalizeCodex(collected, { ...ctx, source: "local-app-server" });
  } catch {
    // 古い Codex CLI や一時的な app-server 起動失敗時だけ JSONL へ縮退する。
  }

  try {
    const collected = await collectCodex({
      maxFiles: ctx.maxFiles ?? DEFAULT_CODEX_SESSION_SCAN_LIMIT,
    });
    if (collected.byLimitId.size === 0) {
      return failureSnapshot("codex", "no-rate-limit-data-found", ctx);
    }
    return normalizeCodex(collected, ctx);
  } catch {
    return failureSnapshot("codex", "collect-failed", ctx);
  }
}

/**
 * 同一プロセス内の収集を直列化する。watch がダッシュボードを同居させるため、
 * 定期収集と「今すぐ更新」が同時に収集用Chrome(CDP)を触って競合しないようにする。
 */
let collectChain = Promise.resolve();

/**
 * @param {object} settings
 * @param {{now?: Date, offsetMinutes?: number, pricing?: object, only?: string[]}} opts
 */
function enqueue(job) {
  const run = collectChain.then(job);
  collectChain = run.catch(() => {});
  return run;
}

export function collectAll(settings, opts = {}) {
  return enqueue(() => collectAllNow(settings, opts));
}

/**
 * 収集 → 保存 → 共通フィード公開 を1つの直列処理で行う（watch・collect CLI・「今すぐ更新」の共通入口）。
 * ★設計レビュー（2026-09-26）: 保存とフィード公開が別々だと、同時実行で世代が混ざる。
 *   同じ直列チェーンの中で最後まで済ませる。部分更新（only）でも、フィードは全サービス分を
 *   ディスク上の最新から組み立てる。noSave のときは保存も公開もしない。
 */
export function collectAndPublish(settings, opts = {}) {
  return enqueue(async () => {
    const result = await collectAllNow(settings, opts);
    if (!opts.noSave) {
      for (const snap of result.snapshots) await saveSnapshot(snap);
      try {
        await publishFeed(settings);
      } catch {
        result.warnings.push("共通フィードの公開に失敗しました");
      }
    }
    return result;
  });
}

async function collectAllNow(settings, opts) {
  const now = opts.now ?? new Date();
  const offsetMinutes = opts.offsetMinutes ?? localOffsetMinutes(now);
  const fetchedAt = toIsoWithOffset(Math.floor(now.getTime() / 1000), offsetMinutes);
  const ctx = { now, offsetMinutes, fetchedAt };

  // ★為替レートの自動更新（軽量・フェイルソフト）。
  //   取得に成功したら config/pricing.json へ書き戻し、以降の injectPricing / UI が新レートを使う。
  //   失敗時は既存値のまま（収集自体は続行）。
  let pricing = opts.pricing;
  if (pricing) {
    try {
      const next = await refreshFx(pricing, { now });
      if (next) {
        pricing = next;
        // 為替の簡易ログ（7日グラフの「換算に使用」系列）。失敗しても収集は続ける
        await recordFx({ usd_jpy: next.fx.usd_jpy, source: next.fx.source }, { now }).catch(() => {});
      }
    } catch {
      // フェイルソフト: 既存レートで続行
    }
  }

  const wanted = (name) =>
    (opts.only ? opts.only.includes(name) : true) && settings.services[name] !== false;

  const mode = settings.cdp.mode ?? "managed";

  const cdp = new Cdp({
    scriptPath: settings.cdp.script_path ?? undefined,
    timeoutMs: settings.cdp.timeout_ms,
  });
  // managedモードでは1インスタンスを全サービスで共有する（起動は1回で済む）
  const managedChrome =
    mode === "managed"
      ? new ManagedChrome({
          chromePath: settings.cdp.chrome_path ?? undefined,
          profileDir: settings.cdp.profile_dir,
          port: settings.cdp.port,
          offscreen: settings.cdp.offscreen,
          timeoutMs: settings.cdp.timeout_ms,
        })
      : null;

  const codexJob = wanted("codex") ? collectCodexSnapshot(ctx) : null;

  // ★Antigravity はブラウザを共有しない（agy の CLI 呼び出し）ので、
  //   ブラウザ系の逐次ループとは別に並行で走らせてよい。
  const antigravityJob = wanted("antigravity")
    ? collectAntigravity({ ...ctx, settings }).catch(() =>
        failureSnapshot("antigravity", "unexpected-failure", { ...ctx, source: "local-cli" })
      )
    : null;

  // ★ブラウザ系は同一Chromeを共有するため逐次実行する（並列だとタブ操作が競合する）。
  //   CodexはローカルJSONL完結なので並行で走らせてよい。
  const browserSnapshots = [];
  for (const service of BROWSER_SERVICES) {
    if (!wanted(service)) continue;
    try {
      browserSnapshots.push(
        await collectBrowserService(service, {
          ...ctx,
          mode,
          cdp,
          managedChrome,
          fallbackToAttach: settings.cdp.fallback_to_attach,
          openIfMissing: settings.cdp.open_tab_if_missing,
        })
      );
    } catch {
      browserSnapshots.push(failureSnapshot(service, "unexpected-failure", ctx));
    }
  }

  // ★RunPod クレジット残高（LLM とは別枠・2026-09-26）。同じ収集用Chromeを使うので逐次の最後に読む。
  //   canonical スナップショットには混ぜず、専用ファイルへ保存する（失敗しても他は止めない）。
  if (managedChrome && settings.extras?.runpod !== false && (!opts.only || opts.only.includes("runpod"))) {
    try {
      const rp = await collectRunpod({ ...ctx, managedChrome });
      if (!opts.noSave) await saveRunpod(rp, { now });
    } catch {
      /* 別枠なので握りつぶす */
    }
  }

  const jobs = [];
  if (codexJob) jobs.push(codexJob);
  if (antigravityJob) jobs.push(antigravityJob);
  for (const s of browserSnapshots) jobs.push(Promise.resolve(s));

  const settled = await Promise.allSettled(jobs);
  const snapshots = settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : failureSnapshot(`unknown-${i}`, "unexpected-failure", ctx)
  );

  // 単価注入（自動取得はしない。config/pricing.json の値だけを使う）
  const warnings = [];
  const priced = snapshots.map((snap) => {
    if (!pricing) return snap;
    const r = injectPricing(snap, pricing, {
      now,
      staleDays: settings.pricing_stale_days,
    });
    warnings.push(...r.warnings);
    return r.snapshot;
  });

  return { snapshots: priced, warnings, fetchedAt };
}
