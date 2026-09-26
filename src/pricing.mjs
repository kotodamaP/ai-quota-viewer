/**
 * クレジット単価の注入。
 * ★単価は自動取得しない（設計仕様 重大2）。config/pricing.json を人手で更新する。
 *   ただし fx.usd_jpy（為替）だけは collect 時に自動更新する（src/fx.mjs + refreshFx）。
 *   last_verified から pricing_stale_days を超えたら「単価情報が古い」警告を返す。
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fetchUsdJpy } from "./fx.mjs";

export async function loadPricing(file = path.join("config", "pricing.json")) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { fx: {}, services: {} };
  }
}

function daysSince(dateStr, now) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/**
 * snapshot に単価と概算額を注入する（非破壊）。
 * 単価が未設定なら null のままにし、UI側で「単価未設定」と出す。推測値は入れない。
 *
 * @returns {{snapshot: object, warnings: string[]}}
 */
export function injectPricing(snapshot, pricing, { now = new Date(), staleDays = 90 } = {}) {
  const warnings = [];
  const entry = pricing?.services?.[snapshot.service];
  if (!snapshot.spend || !entry) return { snapshot, warnings };

  const age = daysSince(entry.last_verified, now);
  if (age === null) {
    warnings.push(`${snapshot.service}: 単価の確認日が未記録`);
  } else if (age > staleDays) {
    warnings.push(`${snapshot.service}: 単価情報が${age}日前のまま（${staleDays}日超）`);
  }

  const unitPrice = Number.isFinite(entry.unit_price_jpy) ? entry.unit_price_jpy : null;
  const usdJpy = Number.isFinite(pricing?.fx?.usd_jpy) ? pricing.fx.usd_jpy : null;

  const spend = { ...snapshot.spend, unit_price_jpy: unitPrice };

  // 上限が pricing 側にしか無いケース（Claudeの月間上限など）を補う
  if (spend.limit_amount === null && Number.isFinite(entry.monthly_cap_usd)) {
    spend.limit_amount = entry.monthly_cap_usd;
  }

  // 使用率が未算出でも used/limit が揃えば計算できる
  if (
    spend.used_percent === null &&
    Number.isFinite(spend.used_amount) &&
    Number.isFinite(spend.limit_amount) &&
    spend.limit_amount > 0
  ) {
    spend.used_percent = Math.round((spend.used_amount / spend.limit_amount) * 1000) / 10;
  }

  if (unitPrice === null && usdJpy === null) {
    warnings.push(`${snapshot.service}: 単価/為替が未設定のため円換算は表示しない`);
  }

  return { snapshot: { ...snapshot, spend }, warnings };
}

/** UI表示用の円換算（設定が無ければ null を返す。推測しない） */
export function toJpy(amountUsd, pricing) {
  const rate = pricing?.fx?.usd_jpy;
  if (!Number.isFinite(amountUsd) || !Number.isFinite(rate)) return null;
  return Math.round(amountUsd * rate);
}

/**
 * 為替レートを自動取得して pricing を更新し、config/pricing.json へ書き戻す。
 * ★フェイルソフト: 取得失敗時は何も書き換えず null を返す（既存値を使い続ける）。
 *   USD建てサービスの unit_price_jpy も fx に追随して再計算する（円換算の表示を常に最新レートに保つ）。
 *
 * @returns {Promise<object|null>} 更新後の pricing。失敗時は null。
 */
export async function refreshFx(
  pricing,
  { file = path.join("config", "pricing.json"), now = new Date() } = {}
) {
  const fx = await fetchUsdJpy({ now });
  if (!fx) return null;

  const usdJpy = Math.round(fx.usd_jpy * 100) / 100;

  // ★書き戻しの土台は「今のファイル」。常駐 watch は起動時に読んだ pricing を持ち続けるため、
  //   それを土台にすると手で直した月額・プラン等が次の収集で古い内容に巻き戻る（2026-09-24 発見）。
  //   ファイルが読めない時だけ引数の pricing を使う。
  try {
    pricing = JSON.parse(await readFile(file, "utf8"));
  } catch {
    /* 引数の pricing で続行 */
  }

  const services = {};
  for (const [svc, entry] of Object.entries(pricing.services ?? {})) {
    let unit = entry.unit_price_jpy;
    if (entry.credit_unit === "USD") {
      unit = usdJpy; // 1 USD = fx.usd_jpy
    } else if (entry.credit_unit === "credit" && Number.isFinite(entry.usd_per_credit)) {
      unit = Math.round(usdJpy * entry.usd_per_credit * 100) / 100;
    }
    services[svc] = { ...entry, unit_price_jpy: unit };
  }

  const next = {
    ...pricing,
    fx: {
      ...(pricing.fx ?? {}),
      usd_jpy: usdJpy,
      last_verified: fx.last_verified,
      source: `自動取得 (${fx.source})`,
      auto: true,
      note: "自動取得（収集のたびに更新）。推定値であり実請求額ではない。",
    },
    services,
  };

  // atomic 書き換え（tmp → rename）: serve/watch が同時に読んでも途中状態が見えない
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  await rename(tmp, file);
  return next;
}
