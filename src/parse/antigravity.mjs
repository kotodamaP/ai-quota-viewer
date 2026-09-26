/**
 * Antigravity CLI（agy）の `/usage` 出力パーサ。
 * 2026-09-13 の実測（サインイン後のサブスク枠）に基づく。
 *
 * ★入力は agy の stdout。JSON 行が混ざるので「command.name === "usage" の行」を拾う。
 *   （--output-format json でも警告行が前後に出ることがある）
 *
 * 実測（`agy -p "/usage" --output-format json`、num_turns:0 ＝ クォータ消費ゼロ）:
 * {
 *   "command": { "name": "usage", "data": {
 *     "description": "Within each group, models share a weekly limit and a 5-hour limit. …",
 *     "groups": [
 *       { "name": "Gemini Models", "description": "Models within this group: Gemini Flash, Gemini Pro",
 *         "buckets": [
 *           {"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly",
 *            "remaining_fraction":1,"reset_time":"2026-09-20T08:51:21Z"},
 *           {"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h",
 *            "remaining_fraction":1,"reset_time":"2026-09-13T13:51:21Z"} ] },
 *       { "name": "Claude and GPT models", … } ] } }
 * }
 *
 * ★これは API の枠ではなく **Antigravity 側の購読枠**。Gemini API の無料枠
 *   （gemini-3.8-flash = 20 リクエスト/日）とは別物なので、サービスを分けて表示する。
 * ★`remaining_fraction` は残量。canonical は使用率なので used = (1 - remaining) * 100。
 * ★未サインインだと groups が空配列で返る（その時は専用のエラーにする）。
 */

import { toIsoWithOffset, windowLabel, slugify } from "../time.mjs";

/** 枠の種類 → window_minutes */
const WINDOW_MINUTES = {
  "5h": 300,
  weekly: 10080,
};

/**
 * ★非 Gemini レーン（Claude / GPT 系）は表示しない（2026-09-13 ユーザー判断）。
 *   このカードは Antigravity の「Gemini 側のサブスク枠」を見るためのもの。
 *   グループ名はサービス側の表記なので、名前で判定する（無ければ残す＝取りこぼさない）。
 */
const NON_GEMINI_GROUP = /claude|gpt|anthropic|openai/i;

function failure(fetchedAt, error) {
  return {
    service: "antigravity",
    plan: null,
    fetched_at: fetchedAt,
    source_updated_at: null,
    source: "local-cli",
    ok: false,
    error,
    limits: [],
    spend: null,
  };
}

/** stdout から usage コマンドの JSON を取り出す（複数行に警告が混ざるため行単位で探す）。 */
export function findUsagePayload(text) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj?.command?.name === "usage" && obj.command.data) return obj.command.data;
  }
  return null;
}

/**
 * @param {string} text agy の stdout
 * @param {{now: Date, offsetMinutes: number, fetchedAt: string}} ctx
 */
export function parseAntigravity(text, { now, offsetMinutes, fetchedAt }) {
  void now;
  const data = findUsagePayload(text);
  if (!data) return failure(fetchedAt, "usage-output-not-found");

  const groups = Array.isArray(data.groups) ? data.groups : [];
  if (groups.length === 0) {
    // 構造は取れているが中身が無い ＝ 未サインイン（APIキー経路だった頃の実測）
    return failure(fetchedAt, "usage-not-signed-in");
  }

  const limits = [];
  for (const group of groups) {
    const name = typeof group?.name === "string" ? group.name.trim() : "";
    if (!name) continue;
    if (NON_GEMINI_GROUP.test(name)) continue; // Claude / GPT 群は出さない

    const windows = [];
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      const windowMinutes = WINDOW_MINUTES[bucket?.window];
      if (!windowMinutes) continue; // 未知の窓は作らない（推測しない）

      const remaining = bucket.remaining_fraction;
      if (!Number.isFinite(remaining)) continue;

      // 残量 → 使用率。0〜100 に収める（丸めで 100.1 になっても表示を壊さない）
      const used = Math.max(0, Math.min(100, Math.round((1 - remaining) * 1000) / 10));

      const resetMs = Date.parse(bucket.reset_time ?? "");
      windows.push({
        window_minutes: windowMinutes,
        kind: "percent",
        label: windowLabel(windowMinutes),
        used_percent: used,
        used_amount: null,
        limit_amount: null,
        resets_at: Number.isFinite(resetMs)
          ? toIsoWithOffset(Math.floor(resetMs / 1000), offsetMinutes)
          : null,
      });
    }
    if (windows.length === 0) continue;

    windows.sort((a, b) => a.window_minutes - b.window_minutes);
    limits.push({ limit_id: slugify(name), label: name, windows });
  }

  if (limits.length === 0) return failure(fetchedAt, "usage-windows-not-found");

  return {
    service: "antigravity",
    // ★プラン名はサービス側が名乗らない（tier 名は /usage に出ない）。
    //   推測で "Google AI Pro" 等を入れないこと。カード名で API 枠と区別する。
    plan: null,
    fetched_at: fetchedAt,
    source_updated_at: null,
    source: "local-cli",
    ok: true,
    error: null,
    limits,
    spend: null,
  };
}
