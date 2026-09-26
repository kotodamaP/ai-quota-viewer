/**
 * USD/JPY 為替レートの自動取得。
 * ★フェイルソフト: 全ソース失敗時は null を返し、呼び出し側は既存値を使い続ける。
 *   単価テーブル（unit_price_jpy 等）は人手管理のまま。自動更新するのは fx のみ。
 */

const SOURCES = [
  {
    name: "open.er-api.com",
    url: "https://open.er-api.com/v6/latest/USD",
    pick: (json) => json?.rates?.JPY,
  },
  {
    name: "frankfurter.app",
    url: "https://api.frankfurter.app/latest?from=USD&to=JPY",
    pick: (json) => json?.rates?.JPY,
  },
];

/**
 * USD/JPY を外部APIから取得する。
 * @param {{timeoutMs?: number, now?: Date}} [opts]
 * @returns {Promise<{usd_jpy: number, source: string, last_verified: string} | null>}
 */
export async function fetchUsdJpy({ timeoutMs = 8000, now = new Date() } = {}) {
  for (const src of SOURCES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(src.url, {
          signal: ctrl.signal,
          headers: { accept: "application/json" },
        });
        if (!res.ok) continue;
        const json = await res.json();
        const rate = Number(src.pick(json));
        if (Number.isFinite(rate) && rate > 0) {
          return {
            usd_jpy: rate,
            source: src.name,
            last_verified: localDate(now),
          };
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // 次のソースへ
    }
  }
  return null;
}

/** ローカルタイムの YYYY-MM-DD（UTC だと日付がずれるため） */
function localDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
