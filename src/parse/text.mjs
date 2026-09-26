/**
 * テキスト解析の共通ヘルパ。
 * ★設計方針: 「Chromeから文字列を取ってくる部分」と「文字列を解釈する部分」を分離する。
 *   ここは純粋関数だけなので、Chromeなしで単体テストできる。
 *
 * ★前提: 各サービスのページは実行環境のローカルタイムゾーンで時刻を描画している
 *   （JST環境）。now を引数で受けるのはテストを決定的にするため。
 */

const WEEKDAY_JA = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };
const MONTH_EN = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** 空行を落としてトリムした行配列にする */
export function toLines(text) {
  if (typeof text !== "string") return [];
  return text
    .split("\n")
    .map((l) => l.replace(/ /g, " ").trim())
    .filter((l) => l.length > 0);
}

/** 最初に条件を満たす行のindex。無ければ -1 */
export function findIndex(lines, predicate, from = 0) {
  for (let i = from; i < lines.length; i++) if (predicate(lines[i])) return i;
  return -1;
}

/** "22% 使用済み" / "17%" / "94%使用" -> 22 / 17 / 94 */
export function parsePercent(line) {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(line ?? "");
  return m ? Number(m[1]) : null;
}

/** "$42.00使用" / "$45.20" -> 120.00 / 45.2 */
export function parseMoney(line) {
  const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(line ?? "");
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** "2時間54分後にリセット" -> Date */
export function parseRelativeReset(line, now) {
  if (!/後にリセット|後にリセットされます/.test(line ?? "")) return null;
  const h = /(\d+)\s*時間/.exec(line);
  const m = /(\d+)\s*分/.exec(line);
  const d = /(\d+)\s*日/.exec(line);
  if (!h && !m && !d) return null;
  const ms =
    (d ? Number(d[1]) * 86400 : 0) * 1000 +
    (h ? Number(h[1]) * 3600 : 0) * 1000 +
    (m ? Number(m[1]) * 60 : 0) * 1000;
  return new Date(now.getTime() + ms);
}

/** "リセットまで 1 時間 26 分" / "Resets in 5d 23h" -> Date（OpenCode /go 形式） */
export function parseResetRemaining(line, now) {
  if (!line) return null;
  // 日本語形式: "リセットまで 1 時間 26 分"
  if (/^リセットまで/.test(line)) {
    const d = /(\d+)\s*日/.exec(line);
    const h = /(\d+)\s*時間/.exec(line);
    const m = /(\d+)\s*分/.exec(line);
    if (!d && !h && !m) return null;
    const ms =
      (d ? Number(d[1]) * 86400 : 0) * 1000 +
      (h ? Number(h[1]) * 3600 : 0) * 1000 +
      (m ? Number(m[1]) * 60 : 0) * 1000;
    return new Date(now.getTime() + ms);
  }
  // 英語形式: "Resets in 5d 23h", "Resets in 1h 26m", "Resets in 45m"
  if (/^Resets in\b/i.test(line)) {
    const d = /(\d+)\s*d/i.exec(line);
    const h = /(\d+)\s*h/i.exec(line);
    const m = /(\d+)\s*m/i.exec(line);
    const s = /(\d+)\s*s/i.exec(line);
    if (!d && !h && !m && !s) return null;
    const ms =
      (d ? Number(d[1]) * 86400 : 0) * 1000 +
      (h ? Number(h[1]) * 3600 : 0) * 1000 +
      (m ? Number(m[1]) * 60 : 0) * 1000 +
      (s ? Number(s[1]) : 0) * 1000;
    return new Date(now.getTime() + ms);
  }
  return null;
}

/** "15:59 (月)にリセット" -> 次に来るその曜日・その時刻の Date */
export function parseWeekdayTimeReset(line, now) {
  const m = /(\d{1,2}):(\d{2}).*?[（(]\s*([日月火水木金土])\s*[)）]/.exec(line ?? "");
  if (!m) return null;
  const [, hh, mm, wd] = m;
  const target = WEEKDAY_JA[wd];
  if (target === undefined) return null;

  const out = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(hh), Number(mm), 0, 0);
  let delta = (target - out.getDay() + 7) % 7;
  if (delta === 0 && out.getTime() <= now.getTime()) delta = 7;
  out.setDate(out.getDate() + delta);
  return out;
}

/** "2026年7月30日 6:11 にリセット" -> Date */
export function parseAbsoluteJaReset(line) {
  const m = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(?:(\d{1,2}):(\d{2}))?/.exec(line ?? "");
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(hh ?? 0), Number(mm ?? 0), 0, 0);
}

/** "8月4日" のように年が無い日本語表記 -> 次に来る その月日 の Date */
export function parseJaMonthDayReset(line, now) {
  if (/\d{4}\s*年/.test(line ?? "")) return null; // 年つきは parseAbsoluteJaReset の担当
  const m = /(\d{1,2})月\s*(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?/.exec(line ?? "");
  if (!m) return null;
  const [, mo, d, hh, mm] = m;

  let out = new Date(now.getFullYear(), Number(mo) - 1, Number(d), Number(hh ?? 0), Number(mm ?? 0), 0, 0);
  if (out.getTime() <= now.getTime()) {
    out = new Date(now.getFullYear() + 1, Number(mo) - 1, Number(d), Number(hh ?? 0), Number(mm ?? 0), 0, 0);
  }
  return out;
}

/** "Aug 1にリセット" -> 次に来る その月日 の Date */
export function parseMonthDayEnReset(line, now) {
  const m = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/.exec(line ?? "");
  if (!m) return null;
  const mo = MONTH_EN[m[1].toLowerCase()];
  if (mo === undefined) return null;
  const day = Number(m[2]);

  let out = new Date(now.getFullYear(), mo, day, 0, 0, 0, 0);
  if (out.getTime() <= now.getTime()) out = new Date(now.getFullYear() + 1, mo, day, 0, 0, 0, 0);
  return out;
}

/** どの表記でも拾えるようまとめて試す */
export function parseAnyReset(line, now) {
  return (
    parseAbsoluteJaReset(line) ??
    parseRelativeReset(line, now) ??
    parseWeekdayTimeReset(line, now) ??
    parseJaMonthDayReset(line, now) ??
    parseMonthDayEnReset(line, now)
  );
}

/** "最終更新: 3分前" -> Date（サービス側の集計時刻） */
export function parseLastUpdated(line, now) {
  if (!/前$|前\b/.test(line ?? "")) return null;
  if (!/最終更新|Last updated/i.test(line ?? "")) return null;
  const h = /(\d+)\s*時間/.exec(line);
  const m = /(\d+)\s*分/.exec(line);
  const s = /(\d+)\s*秒/.exec(line);
  if (!h && !m && !s) return null;
  const ms =
    (h ? Number(h[1]) * 3600 : 0) * 1000 +
    (m ? Number(m[1]) * 60 : 0) * 1000 +
    (s ? Number(s[1]) : 0) * 1000;
  return new Date(now.getTime() - ms);
}
