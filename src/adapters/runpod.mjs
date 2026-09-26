/**
 * RunPod のクレジット残高（LLM サービスとは別枠・2026-09-26）。
 *
 * ★取得は他社と同じく収集用ブラウザ（managed Chrome）のログイン済みセッションで請求画面を読むだけ。
 *   API キー（Windows 資格情報に保存済み）は読まない＝このツールは認証情報を扱わない方針のまま。
 * ★保存は data/latest/runpod.json（最新）と data/runpod-history.jsonl（残高の簡易ログ）。
 */

import { readFile, writeFile, appendFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

import { parseRunpodBilling, isRunpodLogin } from "../parse/runpod.mjs";

export const RUNPOD_BILLING_URL = "https://console.runpod.io/user/billing";
const URL_PATTERN = /^https:\/\/console\.runpod\.io\/user\/billing/;
export const RUNPOD_LATEST_FILE = path.join("data", "latest", "runpod.json");
export const RUNPOD_HISTORY_FILE = path.join("data", "runpod-history.jsonl");

const DAY_MS = 86_400_000;
/** 残高が変わらない間は、この間隔ごとにだけ記録する */
const SAME_VALUE_INTERVAL_MS = 6 * 3_600_000;

/** 収集用ブラウザで請求画面を読んで残高を返す（失敗しても例外にせず ok:false） */
export async function collectRunpod(ctx) {
  const chrome = ctx.managedChrome;
  if (!chrome) return { ok: false, error: "managed-chrome-unavailable", fetched_at: ctx.fetchedAt, balance_usd: null, spend_per_hr_usd: null };
  // ★金額は描画時にカウントアップのアニメーションで流れる。途中の値を読むと
  //   $25.50 のところを $26.71 と保存してしまう（合成フィクスチャ）。
  //   → 1.2秒おきの読取で「残高・消費レート・残り時間」が2回続けて同じになってから確定する。
  let prevKey = null;
  const isReady = (text) => {
    const r = parseRunpodBilling(text, ctx);
    if (!r.ok) {
      prevKey = null;
      return false;
    }
    const key = `${r.balance_usd}|${r.spend_per_hr_usd}|${r.hours_left}`;
    const stable = key === prevKey;
    prevKey = key;
    return stable;
  };
  try {
    const text = await chrome.readPage(URL_PATTERN, RUNPOD_BILLING_URL, isReady, {
      // isReady は前回値を覚えるので、ここでは呼ばずにパーサを直接使う
      isTerminal: (text) => isRunpodLogin(text) && !parseRunpodBilling(text, ctx).ok,
    });
    return parseRunpodBilling(text, ctx);
  } catch (e) {
    return { ok: false, error: e?.kind ?? "cdp-failed", fetched_at: ctx.fetchedAt, balance_usd: null, spend_per_hr_usd: null };
  }
}

/**
 * 最新を保存し、成功時は残高を簡易ログへ追記する。
 * 失敗時は「最後に取れた残高」を消さずに残し、エラーだけ上書きする（画面が空にならないように）。
 */
export async function saveRunpod(result, { latestFile = RUNPOD_LATEST_FILE, historyFile = RUNPOD_HISTORY_FILE, now = new Date() } = {}) {
  let prev = null;
  try {
    prev = JSON.parse(await readFile(latestFile, "utf8"));
  } catch {
    /* 初回 */
  }
  const latest = result.ok
    ? { ...result, last_ok_at: result.fetched_at }
    : {
        ...result,
        balance_usd: prev?.balance_usd ?? null,
        spend_per_hr_usd: prev?.spend_per_hr_usd ?? null,
        last_ok_at: prev?.last_ok_at ?? null,
      };
  await mkdir(path.dirname(latestFile), { recursive: true });
  const tmp = latestFile + ".tmp";
  await writeFile(tmp, JSON.stringify(latest, null, 2) + "\n", "utf8");
  await rename(tmp, latestFile);

  if (result.ok) await recordRunpodBalance(result.balance_usd, { file: historyFile, now });
  return latest;
}

async function readHistoryLines(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (Number.isFinite(e.balance_usd) && Number.isFinite(Date.parse(e.t))) out.push(e);
    } catch {
      /* 壊れた行は読み飛ばす */
    }
  }
  return out;
}

/** 残高を1行追記する。直前と同じ残高で6時間未満なら書かない */
export async function recordRunpodBalance(balance, { file = RUNPOD_HISTORY_FILE, now = new Date() } = {}) {
  if (!Number.isFinite(balance)) return false;
  const last = (await readHistoryLines(file)).at(-1);
  if (last && last.balance_usd === balance && now - new Date(last.t) < SAME_VALUE_INTERVAL_MS) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ t: now.toISOString(), balance_usd: balance }) + "\n", "utf8");
  return true;
}

/** 画面用: 最新＋直近 days 日の残高履歴（古い順） */
export async function readRunpod({ latestFile = RUNPOD_LATEST_FILE, historyFile = RUNPOD_HISTORY_FILE, days = 7, now = new Date() } = {}) {
  let latest = null;
  try {
    latest = JSON.parse(await readFile(latestFile, "utf8"));
  } catch {
    /* 未取得 */
  }
  const since = now.getTime() - days * DAY_MS;
  const history = (await readHistoryLines(historyFile))
    .filter((e) => Date.parse(e.t) >= since)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
    .map((e) => ({ t: e.t, v: e.balance_usd }));
  return { latest, history };
}
