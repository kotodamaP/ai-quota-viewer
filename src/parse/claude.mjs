/**
 * claude.ai 設定＞使用量 の innerText パーサ。
 * 画面構造を模した合成フィクスチャに基づく。
 *
 * 実測構造:
 *   プラン使用制限 / Max (5x)
 *   現在のセッション / 2時間54分後にリセット / 22% 使用済み       <- 5時間枠
 *   週間制限
 *   すべてのモデル / 15:59 (月)にリセット / 10% 使用済み          <- 週次枠
 *   Fable        / 16:00 (月)にリセット / 5% 使用済み             <- 週次枠（モデル別）
 *   最終更新: 3分前
 *   使用クレジット / $42.00使用 / Aug 1にリセット / 80%使用
 *   $100.00 / 月間利用上限 / $58.00 / 現在の残高 / 自動チャージ / オフ
 */

import {
  toLines, findIndex, parsePercent, parseMoney,
  parseAnyReset, parseLastUpdated,
} from "./text.mjs";
import { toIsoWithOffset, windowLabel } from "../time.mjs";

const PERCENT_USED = /^\d+(?:\.\d+)?%\s*使用済み?$/;
const RESET_LINE = /にリセット/;

const iso = (date, offsetMinutes) =>
  date ? toIsoWithOffset(Math.floor(date.getTime() / 1000), offsetMinutes) : null;

function slugify(label) {
  const map = { "すべてのモデル": "all_models", "現在のセッション": "session", "Fable": "fable" };
  if (map[label]) return map[label];
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

/**
 * 「N% 使用済み」の行を起点に、直前の「…にリセット」行とラベル行を拾う。
 * 行の並び順に依存しすぎないよう、直前3行までを後ろ向きに探索する。
 */
function collectEntries(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (!PERCENT_USED.test(lines[i])) continue;

    let resetLine = null;
    let label = null;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      if (resetLine === null && RESET_LINE.test(lines[j])) { resetLine = lines[j]; continue; }
      if (resetLine !== null && label === null && !RESET_LINE.test(lines[j])) { label = lines[j]; break; }
    }
    entries.push({ index: i, label, resetLine, percent: parsePercent(lines[i]) });
  }
  return entries;
}

function buildSpend(lines, now, offsetMinutes) {
  const creditIdx = findIndex(lines, (l) => /^使用クレジット$/.test(l));
  if (creditIdx === -1) return null;

  const tail = lines.slice(creditIdx, creditIdx + 20);

  const usedLine = tail.find((l) => /\$[\d,.]+使用/.test(l));
  const percentLine = tail.find((l) => /^\d+(?:\.\d+)?%使用$/.test(l));
  const resetLine = tail.find((l) => RESET_LINE.test(l));

  // "$100.00" の次行が "月間利用上限"、"$58.00" の次行が "現在の残高" という並び
  let limitAmount = null;
  let balance = null;
  for (let i = 0; i < tail.length - 1; i++) {
    const money = parseMoney(tail[i]);
    if (money === null || !/^\$/.test(tail[i])) continue;
    if (/月間利用上限|Monthly (usage )?limit/i.test(tail[i + 1])) limitAmount = money;
    if (/現在の残高|Current balance/i.test(tail[i + 1])) balance = money;
  }

  const autoIdx = tail.findIndex((l) => /^自動チャージ$/.test(l));
  const autoRecharge =
    autoIdx === -1 || autoIdx + 1 >= tail.length
      ? null
      : !/^(オフ|Off)$/i.test(tail[autoIdx + 1]);

  const usedAmount = usedLine ? parseMoney(usedLine) : null;
  if (usedAmount === null && limitAmount === null && balance === null) return null;

  return {
    kind: "amount",
    currency: "USD",
    used_amount: usedAmount,
    limit_amount: limitAmount,
    used_percent: percentLine ? parsePercent(percentLine) : null,
    balance,
    resets_at: iso(parseAnyReset(resetLine, now), offsetMinutes),
    auto_recharge: autoRecharge,
    unit_price_jpy: null,
  };
}

/**
 * @param {string} text  document.body.innerText
 * @param {{now: Date, offsetMinutes: number, fetchedAt: string}} ctx
 */
export function parseClaude(text, { now, offsetMinutes, fetchedAt }) {
  const lines = toLines(text);

  // 見出しは「プラン使用制限」（〜2026-09）→「プランの使用量上限」（検証済み）に変わった
  const planIdx = findIndex(lines, (l) => /^プラン(?:使用制限|の使用量上限)$/.test(l));
  const plan = planIdx !== -1 && planIdx + 1 < lines.length ? lines[planIdx + 1] : null;

  const sessionIdx = findIndex(lines, (l) => /^現在のセッション$/.test(l));
  const weeklyIdx = findIndex(lines, (l) => /^週間制限$/.test(l));

  const entries = collectEntries(lines);
  if (entries.length === 0) {
    return {
      service: "claude", plan, fetched_at: fetchedAt, source_updated_at: null,
      source: "cdp-dom", ok: false, error: "usage-section-not-found",
      limits: [], spend: null,
    };
  }

  /** @type {Map<string, {label: string, windows: object[]}>} */
  const byLimit = new Map();

  for (const e of entries) {
    const isSession =
      sessionIdx !== -1 && e.index > sessionIdx && (weeklyIdx === -1 || e.index < weeklyIdx);

    const windowMinutes = isSession ? 300 : 10080;
    const label = isSession ? "現在のセッション" : e.label ?? "すべてのモデル";
    const limitId = isSession ? "all_models" : slugify(label);

    const win = {
      window_minutes: windowMinutes,
      kind: "percent",
      label: windowLabel(windowMinutes),
      used_percent: e.percent,
      used_amount: null,
      limit_amount: null,
      resets_at: iso(parseAnyReset(e.resetLine, now), offsetMinutes),
    };

    const displayLabel = isSession ? "すべてのモデル" : label;
    const current = byLimit.get(limitId) ?? { label: displayLabel, windows: [] };
    current.windows.push(win);
    byLimit.set(limitId, current);
  }

  const limits = [...byLimit].map(([limit_id, v]) => ({
    limit_id,
    label: v.label,
    windows: v.windows.sort((a, b) => a.window_minutes - b.window_minutes),
  }));
  limits.sort((a, b) => a.limit_id.localeCompare(b.limit_id));

  const updatedLine = lines.find((l) => /最終更新/.test(l));
  const sourceUpdated = parseLastUpdated(updatedLine, now);

  return {
    service: "claude",
    plan,
    fetched_at: fetchedAt,
    source_updated_at: iso(sourceUpdated, offsetMinutes),
    source: "cdp-dom",
    ok: true,
    error: null,
    limits,
    spend: buildSpend(lines, now, offsetMinutes),
  };
}
