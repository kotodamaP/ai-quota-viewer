/**
 * 時刻ユーティリティ。
 * resets_at は unix秒で来るため、オフセット付き ISO8601 に変換する。
 * テストのためオフセットは必ず引数で固定できること（design specification §4.5）。
 */

const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");

/**
 * @param {number} unixSeconds
 * @param {number} offsetMinutes UTCからの分オフセット（JST = 540）
 * @returns {string|null} 例 "2026-07-29T02:02:34+09:00"
 */
export function toIsoWithOffset(unixSeconds, offsetMinutes) {
  if (!Number.isFinite(unixSeconds) || !Number.isFinite(offsetMinutes)) return null;

  // オフセットぶんずらした「壁時計時刻」をUTCとして読み出す
  const d = new Date(unixSeconds * 1000 + offsetMinutes * 60_000);
  if (Number.isNaN(d.getTime())) return null;

  const sign = offsetMinutes < 0 ? "-" : "+";
  const oh = pad(Math.trunc(Math.abs(offsetMinutes) / 60));
  const om = pad(Math.abs(offsetMinutes) % 60);

  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `${sign}${oh}:${om}`
  );
}

/** 実行環境のローカルオフセット（分）。JST環境=540。 */
export function localOffsetMinutes(date = new Date()) {
  return -date.getTimezoneOffset();
}

/**
 * 表示名 → 安定したID（"Gemini Models" → "gemini-models"）。
 * サービス実装をまたいで使うためここに置く（Gemini API / Antigravity の両方）。
 */
export function slugify(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}.-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * 枠のラベルを window_minutes から導出する。
 * ★ primary/secondary のスロット名では判定しない（design specification §4.1）。
 */
export function windowLabel(windowMinutes) {
  switch (windowMinutes) {
    case 300:
      return "5時間";
    case 10080:
      return "週次";
    case 43200:
      return "月次";
    default:
      return `${windowMinutes}分`;
  }
}
