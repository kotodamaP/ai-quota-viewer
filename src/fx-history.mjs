/**
 * 為替（USD/JPY）の簡易ログと7日グラフ用データ。
 *
 * 2系列を混ぜずに持つ（2026-09-25）:
 *   - live: 円換算に実際に使った値（open.er-api 等）。refreshFx が成功するたび data/fx-history.jsonl へ追記する。
 *   - ecb : 欧州中央銀行の日次参照レート（frankfurter）。過去7日を遡って描くための参考線。1日1回だけ取得して
 *           data/fx-ecb.json にキャッシュする。
 * ★出典が違う値を1本の線につなぐと、実際には無い段差（約0.7円）が出るため系列を分ける。
 * ★すべてフェイルソフト。失敗しても収集・画面は止めない。
 */

import { readFile, writeFile, appendFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 86_400_000;
/** 同じレートが続く間は、この間隔ごとにだけ記録する（ログが15分ごとに膨らまないように） */
const SAME_RATE_INTERVAL_MS = 6 * 3_600_000;

export const FX_HISTORY_FILE = path.join("data", "fx-history.jsonl");
export const FX_ECB_FILE = path.join("data", "fx-ecb.json");

async function readLines(file) {
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
      if (Number.isFinite(e.usd_jpy) && Number.isFinite(Date.parse(e.t))) out.push(e);
    } catch {
      /* 壊れた行は読み飛ばす */
    }
  }
  return out;
}

/**
 * 円換算に使ったレートを1行追記する。直前と同じレートで6時間未満なら書かない。
 * @returns {Promise<boolean>} 追記したら true
 */
export async function recordFx(
  { usd_jpy, source },
  { file = FX_HISTORY_FILE, now = new Date() } = {}
) {
  if (!Number.isFinite(usd_jpy)) return false;
  const lines = await readLines(file);
  const last = lines.at(-1);
  if (last && last.usd_jpy === usd_jpy && now - new Date(last.t) < SAME_RATE_INTERVAL_MS) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ t: now.toISOString(), usd_jpy, source }) + "\n", "utf8");
  return true;
}

/** 直近 days 日の live 系列（古い順） */
export async function readFxHistory({ file = FX_HISTORY_FILE, days = 7, now = new Date() } = {}) {
  const since = now.getTime() - days * DAY_MS;
  return (await readLines(file))
    .filter((e) => Date.parse(e.t) >= since)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

/** frankfurter の時系列レスポンス → [{date, usd_jpy}]（日付順） */
export function parseEcbSeries(json) {
  const rates = json?.rates ?? {};
  return Object.keys(rates)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(rates[d]?.JPY))
    .sort()
    .map((date) => ({ date, usd_jpy: rates[date].JPY }));
}

/**
 * ECB 日次系列を返す。キャッシュが今日取得済みならそれを使い、古ければ1回だけ取り直す。
 * 取得に失敗したら古いキャッシュ（無ければ空）を返す。
 */
export async function loadEcbSeries({
  file = FX_ECB_FILE,
  days = 7,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  let cache = null;
  try {
    cache = JSON.parse(await readFile(file, "utf8"));
  } catch {
    /* キャッシュなし */
  }
  const today = ymd(now);
  if (cache?.fetched_on === today && Array.isArray(cache.series)) return cache.series;

  // 週末・祝日は値が無いので、1日余分に遡る
  const start = ymd(new Date(now.getTime() - (days + 1) * DAY_MS));
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`https://api.frankfurter.dev/v1/${start}..?from=USD&to=JPY`, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) return cache?.series ?? [];
      const series = parseEcbSeries(await res.json());
      if (series.length === 0) return cache?.series ?? [];
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      await writeFile(tmp, JSON.stringify({ fetched_on: today, source: "frankfurter (ECB)", series }, null, 2), "utf8");
      await rename(tmp, file);
      return series;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return cache?.series ?? [];
  }
}
