/**
 * opencode.ai の workspace 内 /go ページの innerText パーサ。
 * P4(2026-08-03) の実測テキストに基づく。
 *
 * 実測構造（公式UI・日本語）:
 *   Default
 *   user@example.com
 *   Zen
 *   Go
 *   利用
 *   APIキー
 *   メンバー
 *   請求
 *   設定
 *   あなたは OpenCode Go を購読しています、
 *   サブスクリプションの管理
 *   Go モードを使用するには、opencode の設定で「OpenCode Go」をプロバイダーとして選択してください、詳しく見る
 *   ローリング利用量
 *   100%
 *   リセットまで 1 時間 26 分
 *   週間利用量
 *   42%
 *   リセットまで 6 日 11 時間
 *   月間利用量
 *   22%
 *   リセットまで 30 日 3 時間
 *   利用限度額に達したら利用可能な残高を使用する
 *
 * ★OpenCode Go の枠（公式ドキュメント docs/go.mdx より）:
 *   5時間ローリング $12 / 週次 $30 / 月次 $60（いずれも金額ベースの利用枠）。
 *   /go ページは used% とリセットまでの残り時間のみを表示し、金額は出ない。
 *   → used_percent と resets_at を window_minutes(300/10080/43200) に載せる。
 *   → used_amount / limit_amount は null（金額非公開）。
 * ★表示は「使用済み%」のため、qwencloud のような remaining→used 変換は不要。
 * ★ページ実在判定は構造アンカー方式: 「ローリング利用量」行の存在。
 *   /billing は残高ページだが、Go プランの利用状況は /go が正（fallbackUrl を /go に変更済み）。
 */

import { toLines, findIndex } from "./text.mjs";
import { parseResetRemaining } from "./text.mjs";
import { toIsoWithOffset, windowLabel } from "../time.mjs";

// 公式UIの枠ラベル（日本語・英語新UI両対応） → window_minutes（docs/go.mdx の 5時間/週/月 と対応）
const WINDOW_MARKERS = [
  { labels: ["ローリング利用量", "Rolling usage"], windowMinutes: 300 },
  { labels: ["週間利用量", "Weekly usage"], windowMinutes: 10080 },
  { labels: ["月間利用量", "Monthly usage"], windowMinutes: 43200 },
];
const GO_PLAN_MARKER = /(?:あなたは\s*OpenCode\s*Go\s*を購読しています|Go-Subscription|OpenCode\s*Go)/i;

/**
 * @param {string} text  document.body.innerText
 * @param {{now: Date, offsetMinutes: number, fetchedAt: string}} ctx
 */
export function parseOpencode(text, { now, offsetMinutes, fetchedAt }) {
  const lines = toLines(text);

  const matchMarker = (line, marker) =>
    marker.labels.some((lbl) => line.toLowerCase() === lbl.toLowerCase());

  // ページ実在判定: 3枠のうち最低1枠のラベル行があれば /go の使用量ページ
  const hasUsage = WINDOW_MARKERS.some(
    (m) => findIndex(lines, (l) => matchMarker(l, m)) !== -1
  );
  if (!hasUsage) {
    return {
      service: "opencode",
      plan: null,
      fetched_at: fetchedAt,
      source_updated_at: null,
      source: "cdp-dom",
      ok: false,
      error: "usage-section-not-found",
      limits: [],
      spend: null,
    };
  }

  // プラン名: 「あなたは OpenCode Go を購読しています」または「Go-Subscription」等 → "Go"
  const plan = findIndex(lines, (l) => GO_PLAN_MARKER.test(l)) !== -1 ? "Go" : null;

  // 枠ごとに「ラベル行 → 次の行が % → リセット行（あれば）」を拾う
  const windows = [];
  for (const marker of WINDOW_MARKERS) {
    const idx = findIndex(lines, (l) => matchMarker(l, marker));
    if (idx === -1) continue;

    const pctLine = lines[idx + 1] ?? "";
    const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(pctLine);
    if (!pct) continue;

    // 0%などの枠はリセット行が存在しない場合があるため、次の行がリセット表記に合致するか検査
    const resetCandidate = lines[idx + 2] ?? "";
    const resetDate = parseResetRemaining(resetCandidate, now);

    windows.push({
      window_minutes: marker.windowMinutes,
      kind: "percent",
      label: windowLabel(marker.windowMinutes),
      used_percent: Number(pct[1]),
      used_amount: null,
      limit_amount: null,
      resets_at: resetDate
        ? toIsoWithOffset(Math.floor(resetDate.getTime() / 1000), offsetMinutes)
        : null,
    });
  }

  return {
    service: "opencode",
    plan,
    fetched_at: fetchedAt,
    source_updated_at: null,
    source: "cdp-dom",
    ok: true,
    error: null,
    limits: [{ limit_id: "go", label: "Go", windows }],
    spend: null,
  };
}
