/**
 * home.qwencloud.com/billing/subscription/token-plan-individual の innerText パーサ。
 * P4(2026-08-03) の実測テキストに基づく。
 *
 * 実測構造（公式UI・日本語）:
 *   Individual Plan
 *   Standard
 *   Last updated 20:29:59
 *   Status / Active / Auto-renew
 *   Remaining days / 17 days
 *   Expiry date / 2026-08-21 01:00:00
 *   5 Hours Usage Limit        ← 旧表記は "Every 5 Hours"（2026-08-05 変更確認）
 *   Reset time 2026-08-04 00:32:00
 *   Remaining / 0.0%
 *   Total / 3,000
 *   7 Days Usage Limit         ← 旧表記は "Every 7 Days"
 *   Reset time 2026-08-08 16:41:00
 *   Remaining / 59.9%
 *   Total / 10,000
 *
 * ★UIは「Remaining（残量%）」表示なので、used_percent = 100 - remaining。
 * ★window_minutes はラベル（Every 5 Hours / Every 7 Days）から導出する。
 */

import { toLines, findIndex } from "./text.mjs";
import { toIsoWithOffset, windowLabel } from "../time.mjs";

const PLAN_MARKER = /^Individual Plan$/;
// ★ラベルはQwenCloudのUI変更で変わることがある（実測: Every 5 Hours → 5 Hours Usage Limit）。
//   厳密一致でなく複数パターンで拾う（将来の表記揺れに強くする）。
const SLOT_MARKERS = [
  { label: "5 Hours Usage Limit", patterns: [/^Every 5 Hours$/i, /^5 Hours Usage Limit$/i], windowMinutes: 300 },
  { label: "7 Days Usage Limit", patterns: [/^Every 7 Days$/i, /^7 Days Usage Limit$/i], windowMinutes: 10080 },
];
const slotMatches = (marker, line) => marker.patterns.some((p) => p.test(line ?? ""));

const iso = (date, offsetMinutes) =>
  date ? toIsoWithOffset(Math.floor(date.getTime() / 1000), offsetMinutes) : null;

/** "2026-08-04 00:32:00" -> ローカル時刻として Date */
function parseLocalDateTime(line) {
  const m = /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(line ?? "");
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss ?? 0), 0);
}

/** "20:29:59" / "20:30:00" -> 今日のその時刻として Date */
function parseTimeOnly(line, now) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((line ?? "").trim());
  if (!m) return null;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), Number(m[3] ?? 0), 0);
}

/**
 * slot ラベル以降の行から "Reset time / Remaining / Total" の3点セットを拾う。
 * 行形式（実測）:
 *   Every 5 Hours
 *   Reset time 2026-08-04 00:32:00
 *   Remaining
 *   0.0%
 *   Total
 *   3,000
 */
function parseSlot(lines, marker, offsetMinutes) {
  const start = findIndex(lines, (l) => slotMatches(marker, l));
  if (start === -1) return null;

  const window = { window_minutes: null, resets_at: null, remaining: null, total: null };
  for (let i = start + 1; i < Math.min(lines.length, start + 20); i++) {
    const line = lines[i];
    if (/^Reset time/i.test(line)) {
      const d = parseLocalDateTime(line);
      window.resets_at = iso(d, offsetMinutes);
    } else if (/^Remaining$/i.test(line)) {
      const pct = /^\d+(?:\.\d+)?\s*%$/.exec(lines[i + 1] ?? "");
      if (pct) window.remaining = Number(pct[0].replace(/\s*%$/, ""));
    } else if (/^Total$/i.test(line)) {
      const m = /^[\d,]+$/.exec(lines[i + 1] ?? "");
      if (m) window.total = Number(m[0].replace(/,/g, ""));
    } else if (SLOT_MARKERS.some((s) => slotMatches(s, line)) && !slotMatches(marker, line)) {
      break; // 次の枠に移ったら打ち切り
    }
  }
  if (window.remaining === null && window.total === null) return null;

  const usedPercent = window.remaining === null ? null : Math.round((100 - window.remaining) * 10) / 10;
  const limitAmount = window.total;
  const usedAmount =
    usedPercent !== null && limitAmount !== null ? Math.round((limitAmount * usedPercent) / 100) : null;

  return {
    window_minutes: marker.windowMinutes,
    kind: "amount",
    label: windowLabel(marker.windowMinutes),
    used_percent: usedPercent,
    used_amount: usedAmount,
    limit_amount: limitAmount,
    resets_at: window.resets_at,
  };
}

/**
 * @param {string} text  document.body.innerText
 * @param {{now: Date, offsetMinutes: number, fetchedAt: string}} ctx
 */
export function parseQwencloud(text, { now, offsetMinutes, fetchedAt }) {
  const lines = toLines(text);

  const planIdx = findIndex(lines, (l) => PLAN_MARKER.test(l));
  const plan = planIdx !== -1 ? lines[planIdx] : null;

  const windows = [];
  for (const marker of SLOT_MARKERS) {
    const win = parseSlot(lines, marker, offsetMinutes);
    if (win) windows.push(win);
  }

  if (windows.length === 0) {
    return {
      service: "qwencloud", plan, fetched_at: fetchedAt, source_updated_at: null,
      source: "cdp-dom", ok: false, error: "usage-section-not-found",
      limits: [], spend: null,
    };
  }

  const updatedIdx = findIndex(lines, (l) => /^Last updated/i.test(l));
  const updatedLine = updatedIdx !== -1 ? lines[updatedIdx] : null;
  // "Last updated 20:29:59" → "20:29:59"（時刻のみの行として解釈）
  const updatedText = updatedLine ? updatedLine.replace(/^Last updated\s*/i, "") : null;
  const updated = updatedText ? parseTimeOnly(updatedText, now) : null;

  const limits = [
    {
      limit_id: "quota",
      label: "Quota",
      windows: windows.sort((a, b) => a.window_minutes - b.window_minutes),
    },
  ];

  return {
    service: "qwencloud",
    plan,
    fetched_at: fetchedAt,
    source_updated_at: iso(updated, offsetMinutes),
    source: "cdp-dom",
    ok: true,
    error: null,
    limits,
    spend: null,
  };
}
