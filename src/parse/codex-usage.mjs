/**
 * Codex Usage ページ（https://chatgpt.com/#settings/Usage）のパーサ。
 * ★2026-08-10: 収集元を ~/.codex/sessions の JSONL から Usage ページに切り替え。
 *   Codex クライアントが limit_id を codex → codex_bengalfox に切り替えたため、
 *   セッションファイルには Usage ページの「週間利用上限」と一致する新規イベントが
 *   書かれなくなった（古い枠の残骸 84% や bengalfox 0% だけが残る）。
 *   正本は Usage ページの「週間利用上限 残りX%・YYYY/MM/DD HH:MMにリセット」。
 *   共有枠（Codex + Work + Workspace Agents + ChatGPT for Excel）の値。
 *
 * ★canonical snapshot 形式で返す（browser.mjs の isReady 判定が ok===true を要求）。
 */

/** 表示用 limit_id（従来のカード表記「codex」を維持する） */
export const CODEX_USAGE_LIMIT_ID = "codex";

import { toIsoWithOffset, localOffsetMinutes } from "../time.mjs";

/**
 * innerText から週間利用上限をパースする。
 * 期待する形状（日本語 UI）:
 *   週間利用上限
 *   残り92%
 *   2026/08/17 17:14にリセット
 *
 * @param {string} text
 * @param {{fetchedAt?: string, offsetMinutes?: number}} [ctx]
 * @returns {object} canonical snapshot（ok:true または ok:false）
 */
export function parseCodexUsage(text, ctx = {}) {
  const fetchedAt = ctx.fetchedAt ?? new Date().toISOString();
  const fail = (error) => ({
    service: "codex",
    plan: null,
    fetched_at: fetchedAt,
    source_updated_at: null,
    source: "cdp-dom",
    ok: false,
    error,
    limits: [],
    spend: null,
  });

  if (typeof text !== "string" || text.length === 0) return fail("empty-page-text");

  // 週間利用上限セクションの「残りN%」
  const remainMatch = text.match(/週間利用上限[\s\S]{0,120}?残り\s*(\d+(?:\.\d+)?)\s*%/);
  if (!remainMatch) return fail("usage-section-not-found");

  const remain = Number(remainMatch[1]);
  if (!Number.isFinite(remain) || remain < 0 || remain > 100) return fail("usage-section-not-found");
  const usedPercent = Math.round((100 - remain) * 10) / 10;

  // リセット日時「YYYY/MM/DD HH:MMにリセット」（ブラウザのローカルタイム=JST前提）
  const resetMatch = text.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*にリセット/);
  let resetsAt = null;
  if (resetMatch) {
    const [, y, m, d, hh, mm] = resetMatch.map(Number);
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`;
    const epochMs = Date.parse(iso);
    // 不正日付（2026/02/31 等）は Date.parse が繰り上げるため、丸め込みを検証する
    if (Number.isFinite(epochMs)) {
      const dt = new Date(epochMs);
      if (
        dt.getFullYear() === y &&
        dt.getMonth() === m - 1 &&
        dt.getDate() === d &&
        dt.getHours() === hh &&
        dt.getMinutes() === mm
      ) {
        resetsAt = Math.floor(epochMs / 1000);
      }
    }
  }

  return {
    service: "codex",
    plan: "pro",
    fetched_at: fetchedAt,
    source_updated_at: null,
    source: "cdp-dom",
    ok: true,
    error: null,
    limits: [
      {
        limit_id: CODEX_USAGE_LIMIT_ID,
        label: "Codex / Agentic",
        windows: [
          {
            window_minutes: 10080,
            kind: "percent",
            label: "週間共有上限",
            used_percent: usedPercent,
            used_amount: null,
            limit_amount: null,
            // ★canonical 形式: resets_at は ISO 文字列（他パーサと同一契約）
            resets_at: resetsAt
              ? toIsoWithOffset(resetsAt, ctx.offsetMinutes ?? localOffsetMinutes())
              : null,
          },
        ],
      },
    ],
    spend: null,
  };
}
