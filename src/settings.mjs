/**
 * 設定の読み込み。
 * ★取得間隔の下限15分はここで強制する。設定ファイルで下げられないようにするのが仕様
 *   （設計仕様（Bot検知を誘発しない））。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/** これ未満には絶対に下げられない */
export const MIN_INTERVAL_MINUTES = 15;

export const DEFAULT_SETTINGS = {
  collect_interval_minutes: MIN_INTERVAL_MINUTES,
  thresholds: { warn: 70, danger: 90 },
  notify: { enabled: true, threshold: 80, cooldown_minutes: 60 },
  dashboard: { host: "127.0.0.1", port: 7777 },
  services: { codex: true, claude: true, grok: true, cursor: false, opencode: true, qwencloud: true, gemini: true, antigravity: true },
  shadowban: { enabled: false, screen_name: "example_user" },
  layout: { order: [], density: "comfortable" },
  cdp: {
    // managed: 専用プロファイルのバックグラウンドChromeを自分で起動する（推奨）
    // attach : ユーザーの常用Chromeにアタッチし、開いているタブを読む（従来方式）
    mode: "managed",
    chrome_path: null,
    profile_dir: ".chrome-profile",
    port: 9335,
    offscreen: true,
    // managedが未ログイン等で失敗したとき、常用Chromeのタブへ退避するか
    fallback_to_attach: false,
    script_path: null,
    open_tab_if_missing: false,
    timeout_ms: 45_000,
  },
  pricing_stale_days: 90,
  // Antigravity CLI（agy）の収集設定。path が null なら `where agy` → 既定候補で解決する。
  agy: { path: null, timeout_ms: 60_000 },
  extras: { runpod: true },
};

function num(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function applyDefaults(raw = {}) {
  const d = DEFAULT_SETTINGS;
  const interval = num(raw.collect_interval_minutes, d.collect_interval_minutes);

  return {
    // ★ハードリミット。設定値が小さくても15分に引き上げる
    collect_interval_minutes: Math.max(MIN_INTERVAL_MINUTES, interval),
    interval_was_clamped: interval < MIN_INTERVAL_MINUTES,
    thresholds: {
      warn: num(raw.thresholds?.warn, d.thresholds.warn),
      danger: num(raw.thresholds?.danger, d.thresholds.danger),
    },
    notify: {
      enabled: raw.notify?.enabled !== false,
      threshold: num(raw.notify?.threshold, d.notify.threshold),
      cooldown_minutes: num(raw.notify?.cooldown_minutes, d.notify.cooldown_minutes),
    },
    dashboard: {
      // ★ループバック（127.0.0.1 または localhost）固定
      host:
        raw.dashboard?.host === "localhost" || raw.dashboard?.host === "127.0.0.1"
          ? raw.dashboard.host
          : d.dashboard.host,
      port: num(raw.dashboard?.port, d.dashboard.port),
    },
    services: { ...d.services, ...(raw.services ?? {}) },
    shadowban: {
      enabled: raw.shadowban?.enabled === true,
      screen_name:
        typeof raw.shadowban?.screen_name === "string"
          ? raw.shadowban.screen_name
          : d.shadowban.screen_name,
    },
    layout: {
      // order: 表示順（サービス名の配列）。空なら settings.services のキー順
      order: Array.isArray(raw.layout?.order) ? raw.layout.order.filter((s) => typeof s === "string") : [],
      // density: comfortable=標準 / compact=コンパクト表示
      density: raw.layout?.density === "compact" ? "compact" : "comfortable",
    },
    cdp: {
      mode: raw.cdp?.mode === "attach" ? "attach" : d.cdp.mode,
      chrome_path: raw.cdp?.chrome_path ?? d.cdp.chrome_path,
      profile_dir: raw.cdp?.profile_dir ?? d.cdp.profile_dir,
      port: num(raw.cdp?.port, d.cdp.port),
      offscreen: raw.cdp?.offscreen !== false,
      fallback_to_attach: raw.cdp?.fallback_to_attach === true,
      script_path: raw.cdp?.script_path ?? d.cdp.script_path,
      open_tab_if_missing: raw.cdp?.open_tab_if_missing === true,
      timeout_ms: num(raw.cdp?.timeout_ms, d.cdp.timeout_ms),
    },
    pricing_stale_days: num(raw.pricing_stale_days, d.pricing_stale_days),
    agy: {
      path: raw.agy?.path ?? d.agy.path,
      timeout_ms: num(raw.agy?.timeout_ms, d.agy.timeout_ms),
    },
    extras: {
      runpod: raw.extras?.runpod !== false,
    },
  };
}

export async function loadSettings(file = path.join("config", "settings.json")) {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return applyDefaults(raw);
  } catch {
    return applyDefaults({});
  }
}

/** 利用率から表示区分を決める */
export function severity(percent, thresholds) {
  if (!Number.isFinite(percent)) return "unknown";
  if (percent >= thresholds.danger) return "danger";
  if (percent >= thresholds.warn) return "warn";
  return "ok";
}
