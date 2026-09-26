#!/usr/bin/env node
/**
 * CLIエントリ。
 *   node src/index.mjs collect [--service codex] [--pretty] [--no-save]
 *   node src/index.mjs watch                 常駐して定期収集（下限15分）
 *   node src/index.mjs serve                 ダッシュボードを起動
 *   node src/index.mjs status                最新スナップショットを1行要約
 */

import { loadSettings, MIN_INTERVAL_MINUTES, severity } from "./settings.mjs";
import { loadPricing } from "./pricing.mjs";
import { collectAndPublish } from "./collect.mjs";
import { collectShadowban, saveShadowbanSnapshot } from "./shadowban.mjs";
import { notifyBreaches } from "./notify.mjs";
import { startServer } from "./dashboard/server.mjs";
import { ManagedChrome } from "./chrome/managed.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args.flags[key] = true;
      else { args.flags[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

const USAGE = `ai-quota-viewer

  node src/index.mjs login               初回セットアップ: 収集用ブラウザでログインする
  node src/index.mjs collect [options]   1回だけ収集する
  node src/index.mjs watch               常駐して定期収集する（下限${MIN_INTERVAL_MINUTES}分）
  node src/index.mjs shadowban           1回だけXシャドウバンチェックする（data/latest/shadowban.json へ）
  node src/index.mjs serve               ダッシュボードを起動する
  node src/index.mjs status              最新の状態を1行ずつ表示する
  node src/index.mjs browser-stop        収集用バックグラウンドChromeを終了する

options:
  --service <name>   codex|claude|grok|cursor|opencode|qwencloud|gemini（省略時は設定で有効な全社）
  --screen-name <s>  shadowban のチェック対象アカウント（省略時は settings.shadowban.screen_name）
  --pretty           整形JSONを標準出力へ
  --no-save          ファイルに保存しない
  --no-notify        閾値通知を出さない
`;

function summarize(snap) {
  if (!snap.ok) return `  ${snap.service.padEnd(7)} 取得失敗 (${snap.error})`;
  const parts = [];
  for (const limit of snap.limits) {
    for (const w of limit.windows) {
      parts.push(`${limit.label ?? limit.limit_id}/${w.label} ${w.used_percent}%`);
    }
  }
  if (snap.spend) {
    const used = snap.spend.used_amount;
    const cap = snap.spend.limit_amount;
    if (used !== null) parts.push(`spend $${used}${cap !== null ? `/$${cap}` : ""}`);
    else if (snap.spend.balance !== null) parts.push(`balance $${snap.spend.balance}`);
  }
  return `  ${snap.service.padEnd(7)} ${parts.join("  ") || "(データなし)"}`;
}

async function runCollect(settings, pricing, args) {
  const only = typeof args.flags.service === "string" ? [args.flags.service] : undefined;
  const started = Date.now();

  // 収集→保存→共通フィード公開は collectAndPublish が1つの直列処理で行う
  const { snapshots, warnings } = await collectAndPublish(settings, { pricing, only, noSave: Boolean(args.flags["no-save"]) });

  if (!args.flags["no-notify"]) {
    try {
      const fired = await notifyBreaches(snapshots, settings);
      if (fired.length > 0) process.stderr.write(`notified: ${fired.join(", ")}\n`);
    } catch {
      /* 通知失敗は収集を止めない */
    }
  }

  if (args.flags.pretty) {
    process.stdout.write(JSON.stringify(snapshots, null, 2) + "\n");
  } else {
    for (const snap of snapshots) process.stdout.write(summarize(snap) + "\n");
  }

  for (const w of warnings) process.stderr.write(`warn: ${w}\n`);
  process.stderr.write(`collected ${snapshots.length} services in ${Date.now() - started}ms\n`);

  return snapshots.some((s) => s.ok) ? 0 : 1;
}

const LOCK_HEARTBEAT_MS = 60_000;
/** これより古い heartbeat のロックは残骸扱い（PID再利用で永久に「起動中」と誤認するのを防ぐ） */
const LOCK_STALE_MS = 3 * LOCK_HEARTBEAT_MS;

/**
 * 多重起動ガード。ログオン時自動起動と手動起動が重なっても収集が二重に走らないようにする。
 * ★2026-09-24: Node 更新（MSI）で watch が強制終了されると exit ハンドラが走らずロックが残る。
 *   PID 生存確認だけだと、再利用された別プロセスの PID を「起動中」と誤認し得るため、
 *   heartbeat_at が新しいことも条件にする。
 * @returns {Promise<boolean>} 起動してよければ true
 */
async function acquireWatchLock() {
  const lockPath = path.join("data", "watch.lock");
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    const pid = Number(lock.pid);
    const beatAge = Date.now() - Date.parse(lock.heartbeat_at ?? "");
    if (Number.isInteger(pid) && pid !== process.pid && beatAge < LOCK_STALE_MS) {
      try {
        process.kill(pid, 0); // 生存確認（シグナルは送らない）
        process.stderr.write(`watch: 既に起動中です (pid ${pid})。二重起動を中止します。\n`);
        return false;
      } catch {
        // プロセスが居ない = 残骸ロック。奪ってよい
      }
    }
  } catch {
    /* ロックなし・壊れたロック */
  }

  await mkdir("data", { recursive: true });
  const startedAt = new Date().toISOString();
  const writeLock = () =>
    writeFile(
      lockPath,
      JSON.stringify(
        { pid: process.pid, started_at: startedAt, heartbeat_at: new Date().toISOString() },
        null,
        2
      ),
      "utf8"
    );
  await writeLock();
  setInterval(() => { writeLock().catch(() => {}); }, LOCK_HEARTBEAT_MS).unref();

  const release = () => {
    try { unlinkSync(lockPath); } catch { /* noop */ }
  };
  process.on("exit", release);
  return true;
}

/**
 * watch にダッシュボードを同居させる。別途 serve が起動済み（ポート使用中）なら何もしない。
 * ★2026-09-24: Node 更新で serve だけ落ちて画面が止まる事故への対処。
 *   常駐 watch が復帰すれば画面も一緒に復帰する。
 */
async function startDashboardForWatch(settings) {
  try {
    await startServer(settings);
  } catch (err) {
    const reason = err?.code === "EADDRINUSE" ? "別の serve が起動済み" : String(err?.code ?? err);
    process.stderr.write(`watch: ダッシュボードは同居させません（${reason}）\n`);
  }
}

/** watch 用: Xシャドウバンを収集して保存する。stdout は汚さず stderr のみに出す。 */
export async function runShadowbanForWatch(
  settings,
  { collectImpl = collectShadowban, saveImpl = saveShadowbanSnapshot } = {}
) {
  try {
    const screenName = settings.shadowban?.screen_name ?? "example_user";
    const snapshot = await collectImpl(screenName);
    const saved = await saveImpl(snapshot);
    if (saved === null) {
      process.stderr.write("warn: shadowban.json の保存に失敗しました\n");
      return;
    }
    if (!snapshot.ok) {
      process.stderr.write(`shadowban: 取得失敗（${snapshot.error}）\n`);
    }
  } catch (err) {
    process.stderr.write(`shadowban: 予期しないエラー（${String(err)}）\n`);
  }
}

async function runWatch(settings, pricing, args) {
  if (!(await acquireWatchLock())) return 0;

  const intervalMs = settings.collect_interval_minutes * 60_000;
  if (settings.interval_was_clamped) {
    process.stderr.write(
      `note: 取得間隔が下限 ${MIN_INTERVAL_MINUTES} 分に引き上げられました\n`
    );
  }
  process.stderr.write(
    `watch: ${settings.collect_interval_minutes}分間隔で収集します（Xシャドウバン含む、Ctrl+C で終了）\n`
  );
  await startDashboardForWatch(settings);

  let stopping = false;
  const tick = async () => {
    if (stopping) return;
    try {
      process.stderr.write(`\n[${new Date().toLocaleString()}]\n`);
      await runCollect(settings, pricing, args);
    } catch {
      process.stderr.write("watch: 収集に失敗しましたが継続します\n");
    }
    // Xシャドウバンは設定で明示的に有効化されている場合のみ実行
    if (settings.shadowban?.enabled) {
      await runShadowbanForWatch(settings);
    }
  };

  process.on("SIGINT", () => {
    stopping = true;
    process.stderr.write("\nwatch: 終了します\n");
    process.exit(0);
  });

  await tick();
  setInterval(tick, intervalMs);
  return new Promise(() => {}); // 常駐
}

function managedFromSettings(settings) {
  return new ManagedChrome({
    chromePath: settings.cdp.chrome_path ?? undefined,
    profileDir: settings.cdp.profile_dir,
    port: settings.cdp.port,
    offscreen: settings.cdp.offscreen,
    timeoutMs: settings.cdp.timeout_ms,
  });
}

/**
 * 初回セットアップ。収集専用プロファイルのChromeを「見える位置」で開き、
 * ユーザー自身にログインしてもらう。
 * ★このツールは認証情報を入力も保存もしない。ログイン操作は必ず人が行う。
 */
async function runLogin(settings) {
  const chrome = managedFromSettings(settings);
  if (!chrome.available()) {
    process.stderr.write("chrome.exe が見つかりません。config/settings.json の cdp.chrome_path を設定してください。\n");
    return 2;
  }

  const urls = [
    "https://claude.ai/settings/usage",
    "https://grok.com/?_s=usage",
    "https://cursor.com/dashboard/usage",
    "https://opencode.ai/console/your_workspace_id/go",
    "https://home.qwencloud.com/billing/subscription/token-plan-individual",
    // Gemini API（無料枠）の上限比較表。Google アカウントでログインしておく。
    "https://aistudio.google.com/rate-limit?timeRange=last-1-day",
    // RunPod クレジット残高（LLM とは別枠。ヘッダの小パネル用）
    "https://console.runpod.io/user/billing",
  ];

  process.stdout.write(
    [
      "収集専用のChromeを開きます（あなたの普段のChromeとは別プロファイルです）。",
      "",
      "  1. 開いたウィンドウで Claude / Grok / Cursor / OpenCode Go / QwenCloud にログインしてください。",
      "  2. 各サービスの使用量ページが表示される状態まで進めてください。",
      "  3. 終わったらそのウィンドウは閉じて構いません（プロファイルにログインが残ります）。",
      "",
      "※ このツールはID・パスワードを入力も保存もしません。ログインはあなたが行ってください。",
      "※ Codex はローカルファイルから読むため、ログインは不要です。",
      "",
      `プロファイル: ${chrome.profileDir}`,
      "",
    ].join("\n")
  );

  try {
    await chrome.openVisible(urls);
  } catch (e) {
    process.stderr.write(`ブラウザの起動に失敗しました (${e.kind ?? "unknown"})\n`);
    return 1;
  }

  process.stdout.write("ログイン後に `node src/index.mjs collect` で確認できます。\n");
  return 0;
}

async function runBrowserStop(settings) {
  const chrome = managedFromSettings(settings);
  const stopped = await chrome.stop();
  process.stdout.write(stopped ? "収集用Chromeを終了しました。\n" : "収集用Chromeは起動していません。\n");
  return 0;
}

async function runStatus(settings) {
  const dir = path.join("data", "latest");
  let any = false;
  for (const service of Object.keys(settings.services)) {
    try {
      const snap = JSON.parse(await readFile(path.join(dir, `${service}.json`), "utf8"));
      process.stdout.write(summarize(snap) + `   (${snap.fetched_at})\n`);
      any = true;
    } catch {
      process.stdout.write(`  ${service.padEnd(7)} 未取得\n`);
    }
  }
  if (!any) process.stderr.write("まだ収集していません。'collect' を実行してください。\n");
  return 0;
}

/** Xシャドウバンチェックを1回実行し、data/latest/shadowban.json へ書き出す。 */
async function runShadowban(settings, args) {
  const screenName =
    typeof args.flags["screen-name"] === "string"
      ? args.flags["screen-name"]
      : settings.shadowban?.screen_name ?? "example_user";

  const snapshot = await collectShadowban(screenName);

  if (!args.flags["no-save"]) {
    const saved = await saveShadowbanSnapshot(snapshot);
    if (saved === null) process.stderr.write("warn: shadowban.json の保存に失敗しました\n");
  }

  process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
  return snapshot.ok ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || args.flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const settings = await loadSettings();
  const pricing = await loadPricing();

  switch (command) {
    case "login":
      return runLogin(settings);
    case "browser-stop":
      return runBrowserStop(settings);
    case "collect":
      return runCollect(settings, pricing, args);
    case "watch":
      return runWatch(settings, pricing, args);
    case "shadowban":
      return runShadowban(settings, args);
    case "serve":
      await startServer(settings);
      return new Promise(() => {});
    case "status":
      return runStatus(settings);
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

// severity は dashboard 側でも使うため re-export（CLIでは未使用）
export { severity };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    () => {
      process.stderr.write("fatal: unexpected failure\n");
      process.exit(1);
    }
  );
}
