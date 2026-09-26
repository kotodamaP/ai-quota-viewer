/**
 * grok.com/?_s=usage の innerText パーサ。
 * 画面構造を模した合成フィクスチャに基づく。
 *
 * 実測構造（公式UI）:
 *   使用量
 *   週間 SuperGrok 上限
 *   28% 使用済          ← API+チャット+Imagine+Grok Buildの合算
 *   2026年7月30日 6:11 にリセット
 *   API 18% / チャット 6% / Imagine 3% / Grok Build 1%
 *   追加使用クレジット $42.50
 *
 * ★4分類は「独立した100%枠」ではなく、週間 SuperGrok 上限という1本の共有枠に
 *   対する内訳%。表示・正規化とも公式合計（無ければ内訳合算）を正とする。
 * ★合計値と追加クレジット残高は number-flow-react の aria-label にだけ存在するため、
 *   取得層が AI_TRIO_GROK_* の補助行として付加する。
 */

import { toLines, findIndex, parsePercent, parseAnyReset } from "./text.mjs";
import { toIsoWithOffset, windowLabel } from "../time.mjs";

const ONLY_PERCENT = /^\d+(?:\.\d+)?\s*%$/;
const TOTAL_USED = /^(\d+(?:\.\d+)?)\s*%\s*使用済$/;
const AUGMENTED_TOTAL = /^AI_TRIO_GROK_TOTAL\s+(\d+(?:\.\d+)?)\s*%$/i;
const CREDIT_BALANCE = /^AI_TRIO_GROK_CREDIT_BALANCE\s+\$\s*([\d,]+(?:\.\d+)?)$/i;
const PART_INLINE =
  /^(API|チャット|Chat|Imagine|Grok\s+Build)\s*[\/・]?\s*(\d+(?:\.\d+)?)\s*%$/i;

const iso = (date, offsetMinutes) =>
  date ? toIsoWithOffset(Math.floor(date.getTime() / 1000), offsetMinutes) : null;

function slugify(label) {
  const normalized = String(label).trim();
  const map = {
    api: "api",
    "チャット": "chat",
    chat: "chat",
    imagine: "imagine",
    "grok build": "grok_build",
  };
  const key = /^[\x00-\x7F]+$/.test(normalized) ? normalized.toLowerCase() : normalized;
  if (map[key]) return map[key];
  return key.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function isPartLabel(label) {
  return /^(API|チャット|Chat|Imagine|Grok\s+Build)$/i.test(String(label).trim());
}

/**
 * API / チャット / Imagine / Grok Build 内訳を拾う。行形式は次のどちらでも可:
 *   - 「API」→「17%」
 *   - 「API 17%」／「API / 17%」
 */
function collectParts(lines, searchFrom) {
  const parts = [];
  for (let i = searchFrom + 1; i < lines.length; i++) {
    const inline = PART_INLINE.exec(lines[i]);
    if (inline) {
      parts.push({
        limit_id: slugify(inline[1]),
        label: inline[1],
        used_percent: Number(inline[2]),
      });
      continue;
    }
    if (!ONLY_PERCENT.test(lines[i])) continue;
    const label = lines[i - 1];
    if (!label || ONLY_PERCENT.test(label) || /にリセット/.test(label)) continue;
    if (/使用済|上限|使用量|追加/.test(label)) continue;
    if (!isPartLabel(label)) continue;

    parts.push({
      limit_id: slugify(label),
      label,
      used_percent: parsePercent(lines[i]),
    });
  }
  return parts;
}

function findHeadlineTotal(lines, searchFrom) {
  for (let i = searchFrom; i < Math.min(lines.length, searchFrom + 8); i++) {
    const m = TOTAL_USED.exec(lines[i]);
    if (m) return Number(m[1]);
  }
  for (const line of lines) {
    const m = AUGMENTED_TOTAL.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

export function parseGrok(text, { now, offsetMinutes, fetchedAt }) {
  const lines = toLines(text);

  const headIdx = findIndex(lines, (l) => /上限/.test(l) && /週間|weekly/i.test(l));
  const planMatch = headIdx !== -1 ? /週間\s*(.+?)\s*上限/.exec(lines[headIdx]) : null;
  const plan = planMatch ? planMatch[1] : null;

  // 見出し以降で最初に現れる「…にリセット」を週次窓のリセットとして採る
  const resetLine =
    headIdx === -1 ? null : lines.slice(headIdx, headIdx + 6).find((l) => /にリセット|reset/i.test(l));
  const resetsAt = iso(parseAnyReset(resetLine, now), offsetMinutes);

  const searchFrom = headIdx === -1 ? 0 : headIdx;
  const parts = collectParts(lines, searchFrom);
  const partsSum = parts.reduce((acc, p) => acc + (Number.isFinite(p.used_percent) ? p.used_percent : 0), 0);
  const headlineTotal = findHeadlineTotal(lines, searchFrom);

  // 公式の「N% 使用済」があればそれを優先。無ければ内訳の合算（上限100）。
  let usedPercent = null;
  if (Number.isFinite(headlineTotal)) usedPercent = headlineTotal;
  else if (parts.length > 0) usedPercent = Math.min(100, Math.round(partsSum * 10) / 10);
  else usedPercent = null;

  if (usedPercent === null) {
    return {
      service: "grok", plan, fetched_at: fetchedAt, source_updated_at: null,
      source: "cdp-dom", ok: false, error: "usage-section-not-found",
      limits: [], spend: null,
    };
  }

  const partNote = parts
    .map((p) => `${p.label} ${p.used_percent}%`)
    .join(" + ");

  const limits = [
    {
      limit_id: "weekly",
      label: partNote ? `週間上限（${partNote}）` : "週間上限",
      windows: [
        {
          window_minutes: 10080,
          kind: "percent",
          label: windowLabel(10080),
          used_percent: usedPercent,
          used_amount: null,
          limit_amount: null,
          resets_at: resetsAt,
        },
      ],
    },
  ];

  // 追加クレジット残高は aria-label から取得層が補助行へ移している。
  const balanceLine = lines.find((line) => CREDIT_BALANCE.test(line)) ?? null;
  const balanceMatch = balanceLine ? CREDIT_BALANCE.exec(balanceLine) : null;
  const balance = balanceMatch ? Number(balanceMatch[1].replace(/,/g, "")) : null;

  // 自動チャージ設定: "残高が$50を下回った場合: $50（月額上限$50）"
  const autoIdx = findIndex(lines, (l) => /^自動チャージ$/.test(l));
  let limitAmount = null;
  let autoRecharge = null;
  if (autoIdx !== -1) {
    const detail = lines[autoIdx + 1] ?? "";
    const amounts = [...detail.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)].map((m) =>
      Number(m[1].replace(/,/g, ""))
    );
    limitAmount = amounts.length >= 3 ? amounts[2] : null;
    if (/^(オフ|Off)$/i.test(detail)) autoRecharge = false;
    else if (amounts.length > 0) autoRecharge = true;
  }

  let spend = null;
  if (Number.isFinite(balance) || Number.isFinite(limitAmount)) {
    spend = {
      kind: "amount",
      currency: "USD",
      used_amount: null,
      limit_amount: limitAmount,
      used_percent: null,
      balance,
      resets_at: null,
      auto_recharge: autoRecharge,
      unit_price_jpy: null,
    };
  }

  return {
    service: "grok",
    plan,
    fetched_at: fetchedAt,
    source_updated_at: null,
    source: "cdp-dom",
    ok: true,
    error: null,
    limits,
    spend,
  };
}
