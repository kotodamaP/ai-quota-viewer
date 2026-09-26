/**
 * cursor.com/dashboard/* の innerText パーサ。
 *
 * ★Cursorのダッシュボードは2種類のレイアウトを出す（P3実測で判明）。両方に対応する。
 *
 * レイアウトA（Usage / 消費金額ビュー）:
 *   Jul 19 - Jul 25 / Total spend $45.20 / Included $20.00 / On-demand $25.20
 *
 * レイアウトB（プラン / 上限ビュー）:
 *   CURRENT PLAN / Ultra / $200/mo
 *   Usage limits reset on 8月4日 (11 days left)
 *   Cursor Models · Includes ... / 17% used
 *   Other Models                 / 100% used
 *   On-Demand / $29.50 / $30
 *
 * レイアウトBには%枠と上限額が両方あるので、取れるならBを優先する。
 */

import { toLines, findIndex, parseMoney, parseAnyReset } from "./text.mjs";
import { toIsoWithOffset, windowLabel } from "../time.mjs";

const PLAN_WORDS = /^(Ultra|Pro|Business|Teams?|Free|Hobby)$/i;
const PERCENT_USED = /^(\d+(?:\.\d+)?)\s*%\s*used$/i;
const MONEY_PAIR = /^\$\s*([\d,]+(?:\.\d+)?)\s*\/\s*\$\s*([\d,]+(?:\.\d+)?)$/;
/** Cursorの上限はプラン単位＝月次 */
const CURSOR_WINDOW_MINUTES = 43200;

const iso = (date, offsetMinutes) =>
  date ? toIsoWithOffset(Math.floor(date.getTime() / 1000), offsetMinutes) : null;

const num = (s) => Number(String(s).replace(/,/g, ""));

function slugify(label) {
  return (
    label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown"
  );
}

/** ラベル行の直後（または同一行）に来る金額を拾う */
function moneyAfter(lines, labelRe) {
  const idx = findIndex(lines, (l) => labelRe.test(l));
  if (idx === -1) return null;
  const same = parseMoney(lines[idx]);
  if (same !== null) return same;
  for (let i = idx + 1; i < Math.min(idx + 3, lines.length); i++) {
    const v = parseMoney(lines[i]);
    if (v !== null) return v;
  }
  return null;
}

/** レイアウトB: 「N% used」の直前行をラベルとして枠を組み立てる */
function parseLimitsLayoutB(lines, resetsAt) {
  const limits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PERCENT_USED.exec(lines[i]);
    if (!m) continue;

    // 直前の非ノイズ行をラベルにする。"Cursor Models · Includes ..." は "·" の前だけ採る
    let label = null;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const cand = lines[j];
      if (!cand || PERCENT_USED.test(cand)) continue;
      if (/^Additional usage|^Included in|^CURRENT PLAN$/i.test(cand)) continue;
      label = cand.split(/\s*[·•]\s*/)[0].trim();
      break;
    }
    if (!label) continue;

    limits.push({
      limit_id: slugify(label),
      label,
      windows: [
        {
          window_minutes: CURSOR_WINDOW_MINUTES,
          kind: "percent",
          label: windowLabel(CURSOR_WINDOW_MINUTES),
          used_percent: Number(m[1]),
          used_amount: null,
          limit_amount: null,
          resets_at: resetsAt,
        },
      ],
    });
  }
  return limits;
}

export function parseCursor(text, { now = new Date(), offsetMinutes = 540, fetchedAt }) {
  const lines = toLines(text);

  const planIdx = findIndex(lines, (l) => PLAN_WORDS.test(l));
  const plan = planIdx === -1 ? null : lines[planIdx];

  // --- レイアウトB を先に試す ---
  const resetLine = lines.find((l) => /reset(s)? on|リセット/i.test(l));
  const resetsAt = iso(parseAnyReset(resetLine, now), offsetMinutes);
  const limitsB = parseLimitsLayoutB(lines, resetsAt);

  // On-Demand の "$29.50 / $30"
  let onDemandUsed = null;
  let onDemandCap = null;
  const pairIdx = findIndex(lines, (l) => MONEY_PAIR.test(l));
  if (pairIdx !== -1) {
    const m = MONEY_PAIR.exec(lines[pairIdx]);
    onDemandUsed = num(m[1]);
    onDemandCap = num(m[2]);
  }

  // --- レイアウトA ---
  const totalSpend = moneyAfter(lines, /^Total spend$/i);
  const periodLine = lines.find((l) =>
    /^[A-Z][a-z]{2}\s+\d{1,2}\s*[-–]\s*[A-Z][a-z]{2}\s+\d{1,2}$/.test(l)
  );
  const [periodStart, periodEnd] = periodLine
    ? periodLine.split(/\s*[-–]\s*/).map((s) => s.trim())
    : [null, null];

  const hasB = limitsB.length > 0 || onDemandUsed !== null;
  const hasA = totalSpend !== null;

  if (!hasA && !hasB) {
    return {
      service: "cursor", plan, fetched_at: fetchedAt, source_updated_at: null,
      source: "cdp-dom", ok: false, error: "usage-section-not-found",
      limits: [], spend: null,
    };
  }

  const usedAmount = onDemandUsed ?? totalSpend;
  const limitAmount = onDemandCap;

  return {
    service: "cursor",
    plan,
    fetched_at: fetchedAt,
    source_updated_at: null,
    source: "cdp-dom",
    ok: true,
    error: null,
    limits: limitsB,
    spend: {
      kind: "amount",
      currency: "USD",
      used_amount: usedAmount,
      limit_amount: limitAmount,
      used_percent:
        Number.isFinite(usedAmount) && Number.isFinite(limitAmount) && limitAmount > 0
          ? Math.round((usedAmount / limitAmount) * 1000) / 10
          : null,
      balance: null,
      period_start: periodStart,
      period_end: periodEnd,
      resets_at: resetsAt,
      auto_recharge: null,
      unit_price_jpy: null,
    },
  };
}
