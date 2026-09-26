/**
 * RunPod 請求画面（console.runpod.io/user/billing）からクレジット残高を読む。
 * LLM サービスではないので canonical スナップショットにはせず、別枠の小さな形で返す（2026-09-26）。
 *
 * ★表記揺れに強くする: 「Balance」を含む行から数行以内の最初の $ 金額を残高とみなす。
 *   稼働中 Pod の消費レート（$x.xx/hr）は見つかった時だけ返す（無ければ null＝不明。0 と区別）。
 * ★推測しない: 残高が見つからなければ ok:false。
 */

const MONEY = /\$\s*(-?[\d,]+(?:\.\d+)?)/;
const RATE = /\$\s*([\d,]+(?:\.\d+)?)\s*\/\s*h(?:r|our)\b/i;

/** 本物のログイン／サインアップ画面だけを検知する（未ログインだと /signup へ飛ばされる） */
export function isRunpodLogin(text) {
  return /Create your account|Sign up with (?:Google|GitHub)|Sign in to Runpod|Welcome back/i.test(text ?? "");
}

const num = (s) => Number(String(s).replace(/,/g, ""));

/**
 * @param {string} text  document.body.innerText
 * @param {{fetchedAt: string}} ctx
 */
export function parseRunpodBilling(text, { fetchedAt }) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let balance = null;
  for (let i = 0; i < lines.length && balance === null; i++) {
    if (!/balance/i.test(lines[i])) continue;
    for (let j = i; j < Math.min(lines.length, i + 4); j++) {
      if (RATE.test(lines[j])) continue; // $x/hr は残高ではない
      const m = lines[j].match(MONEY);
      if (m) {
        balance = num(m[1]);
        break;
      }
    }
  }

  /** 見出し行の直後（同じ行も可）で最初に pattern に合う値を返す */
  const after = (label, pattern) => {
    const i = lines.findIndex((l) => label.test(l));
    if (i === -1) return null;
    for (let j = i; j < Math.min(lines.length, i + 3); j++) {
      const m = lines[j].match(pattern);
      if (m) return m;
    }
    return null;
  };
  // ★「Spend rate limit（$50/hr）」を消費レートと取り違えないよう、見出しで引く（合成フィクスチャ）
  const rateMatch = after(/current spend rate/i, RATE) ?? after(/^spend rate$/i, RATE);
  const spendPerHr = rateMatch ? num(rateMatch[1]) : null;
  const limitMatch = after(/spend rate limit/i, RATE);
  const hoursMatch = after(/estimated time left/i, /([\d,]+(?:\.\d+)?)\s*hours?\b/i);
  const autoPayAt = lines.findIndex((l) => /^auto-?pay$/i.test(l));
  const autoPay = autoPayAt === -1 ? null
    : /^enabled$/i.test(lines[autoPayAt + 1] ?? "") ? true
    : /^disabled$/i.test(lines[autoPayAt + 1] ?? "") ? false : null;

  if (!Number.isFinite(balance)) {
    return {
      ok: false,
      error: isRunpodLogin(text) ? "login-required" : "balance-not-found",
      fetched_at: fetchedAt,
      balance_usd: null,
      spend_per_hr_usd: null,
    };
  }
  return {
    ok: true,
    error: null,
    fetched_at: fetchedAt,
    balance_usd: balance,
    spend_per_hr_usd: Number.isFinite(spendPerHr) ? spendPerHr : null,
    spend_limit_per_hr_usd: limitMatch ? num(limitMatch[1]) : null,
    hours_left: hoursMatch ? num(hoursMatch[1]) : null,
    auto_pay: autoPay,
  };
}
