/**
 * 閾値超過の通知。
 * Windows では PowerShell の NotifyIcon バルーンを使う（追加モジュール不要）。
 * 通知は「あれば嬉しい」機能なので、失敗しても収集本体を絶対に止めない。
 *
 * クールダウン状態は data/notify-state.json に持つ。
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const STATE_FILE = path.join("data", "notify-state.json");

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function writeState(file, state) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* 通知状態の保存失敗は無視 */
  }
}

/** PowerShell に渡す文字列を安全にエスケープする（シングルクォート方式） */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function showWindowsBalloon(title, message) {
  if (process.platform !== "win32") {
    process.stderr.write(`[notify] ${title}: ${message}\n`);
    return;
  }
  const script = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = ${psQuote(title)}
$n.BalloonTipText = ${psQuote(message)}
$n.Visible = $true
$n.ShowBalloonTip(10000)
Start-Sleep -Seconds 6
$n.Dispose()
`.trim();

  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();
  } catch {
    process.stderr.write(`[notify] ${title}: ${message}\n`);
  }
}

/** snapshot 群から閾値超過の項目を抽出する */
export function findBreaches(snapshots, threshold) {
  const breaches = [];
  for (const snap of snapshots) {
    if (!snap.ok) continue;
    for (const limit of snap.limits ?? []) {
      for (const w of limit.windows ?? []) {
        if (Number.isFinite(w.used_percent) && w.used_percent >= threshold) {
          breaches.push({
            key: `${snap.service}:${limit.limit_id}:${w.window_minutes}`,
            service: snap.service,
            label: `${limit.label ?? limit.limit_id} / ${w.label}`,
            percent: w.used_percent,
          });
        }
      }
    }
    const sp = snap.spend;
    if (sp && Number.isFinite(sp.used_percent) && sp.used_percent >= threshold) {
      breaches.push({
        key: `${snap.service}:spend`,
        service: snap.service,
        label: "クレジット",
        percent: sp.used_percent,
      });
    }
  }
  return breaches;
}

/**
 * 閾値超過を通知する。クールダウン中の項目は飛ばす。
 * @returns {Promise<string[]>} 実際に通知した key の一覧
 */
export async function notifyBreaches(snapshots, settings, { now = new Date(), stateFile = STATE_FILE } = {}) {
  if (!settings.notify.enabled) return [];

  const breaches = findBreaches(snapshots, settings.notify.threshold);
  if (breaches.length === 0) return [];

  const state = await readState(stateFile);
  const cooldownMs = settings.notify.cooldown_minutes * 60_000;
  const fired = [];

  for (const b of breaches) {
    const last = state[b.key] ? Date.parse(state[b.key]) : 0;
    if (now.getTime() - last < cooldownMs) continue;

    showWindowsBalloon(
      `AI Quota: ${b.service} ${b.percent}%`,
      `${b.label} が ${b.percent}% に達しました（閾値 ${settings.notify.threshold}%）`
    );
    state[b.key] = new Date(now.getTime()).toISOString();
    fired.push(b.key);
  }

  if (fired.length > 0) await writeState(stateFile, state);
  return fired;
}
