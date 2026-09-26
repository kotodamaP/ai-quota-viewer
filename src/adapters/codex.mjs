/**
 * Codexアダプタ。
 * ~/.codex/sessions/**\/rollout-*.jsonl から最新の rate_limits を抽出する。
 * ブラウザ・認証・ネットワークを一切必要としない（P0で Web画面との一致を検証済み）。
 */

import { readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * ★セキュリティ: 資格情報ファイルは決して読まない（design specification §5）。
 * rollout-*.jsonl 以外は走査対象にしないので通常は到達しないが、
 * 意図を明示するため多重防御として保持する。
 */
const DENIED_BASENAMES = new Set([
  "auth.json",
  ".credentials.json",
  "config.toml",
]);

const ROLLOUT_RE = /^rollout-.*\.jsonl$/;

// 1日に多数のCodexタスクを作ると、最新30ファイルがモデル固有の補助枠だけで
// 埋まり、週次の `codex` 枠を持つ直前のファイルが探索外になる。
// 2026-08-10の実測では90件目で本枠を回収できたため、15分間隔のローカル収集で
// 許容できる範囲として200ファイルまで読む。
export const DEFAULT_CODEX_SESSION_SCAN_LIMIT = 200;

export function defaultSessionsRoot() {
  return path.join(os.homedir(), ".codex", "sessions");
}

/**
 * セッションファイルを mtime降順で最大 maxFiles 件返す。
 * ★全走査は禁止（数GB規模）。design specification §4.4。
 */
export async function findSessionFiles(root, { maxFiles = 30 } = {}) {
  /** @type {string[]} */
  const found = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 読めないディレクトリは黙って飛ばす
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        if (DENIED_BASENAMES.has(entry.name)) continue;
        if (ROLLOUT_RE.test(entry.name)) found.push(full);
      }
    }
  }

  await walk(root);

  const stated = [];
  for (const p of found) {
    try {
      const s = await stat(p);
      stated.push({ path: p, mtimeMs: s.mtimeMs });
    } catch {
      /* 消えた/読めないファイルは無視 */
    }
  }

  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stated.slice(0, maxFiles).map((x) => x.path);
}

/**
 * jsonl テキストから rate_limits を持つイベントを抽出する。
 * - "rate_limits" を含まない行は JSON.parse する前に文字列で足切り（性能）
 * - パース失敗行はスキップ（Codex実行中は末尾行が書きかけの場合がある）
 */
export function extractFromText(text) {
  const out = [];
  if (typeof text !== "string" || text.length === 0) return out;

  for (const line of text.split("\n")) {
    if (line.length === 0 || !line.includes('"rate_limits"')) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 壊れた行・途中で切れた行
    }

    const rl = obj?.payload?.rate_limits;
    if (!rl || typeof rl !== "object") continue;
    if (typeof rl.limit_id !== "string" || rl.limit_id.length === 0) continue;

    out.push({
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : "",
      rl,
    });
  }
  return out;
}

/**
 * limit_id ごとに timestamp 最大のイベントへ畳み込む。
 * plan は limit_id を横断して最新の非null な plan_type を採る。
 *
 * ★複製イベント対策（2026-08-10）: Codex が過去セッションの rate_limits 履歴を
 *   新しい rollout ファイルへ「新しいタイムスタンプ付きで」複製することがある
 *   （例: 8/9 17:00 セッション n=649 の履歴が 8/10 05:51 のファイルに全コピー）。
 *   タイムスタンプだけ見ると複製の古い値（45%）が最新（84%）より新しく見え、
 *   正しい使用率が古い値で上書きされてしまう。
 *   そこで「同一 resets_at（リセット枠）内では used_percent は単調増加する」性質を
 *   使い、既存イベントより低い used_percent を持つイベントは無視する。
 *   リセットされると resets_at が変わるため、リセット後の正しい低下は影響しない。
 */
export function reduceLatest(events) {
  /** @type {Map<string, {timestamp: string, rl: object}>} */
  const byLimitId = new Map();
  let planTimestamp = "";
  let plan = null;

  for (const ev of events) {
    const id = ev.rl.limit_id;
    const prev = byLimitId.get(id);

    const prevPrimary = prev?.rl?.primary;
    const evPrimary = ev.rl?.primary;
    const sameWindow =
      prevPrimary && evPrimary && prevPrimary.resets_at === evPrimary.resets_at;

    // 同じリセット枠で使用率が下がっている = 過去スナップショットの複製とみなして無視
    if (sameWindow && evPrimary.used_percent < prevPrimary.used_percent) continue;

    // タイムスタンプが新しい または 同じ枠で使用率が高い（複製の古い値に負けない）
    const isNewer =
      !prev ||
      ev.timestamp > prev.timestamp ||
      (sameWindow && evPrimary.used_percent > prevPrimary.used_percent);
    if (isNewer) byLimitId.set(id, ev);

    if (ev.rl.plan_type && ev.timestamp > planTimestamp) {
      planTimestamp = ev.timestamp;
      plan = ev.rl.plan_type;
    }
  }

  return { byLimitId, plan };
}

/**
 * 収集本体。
 * @returns {{byLimitId: Map, plan: string|null, filesScanned: number}}
 */
export async function collectCodex({ root, maxFiles = DEFAULT_CODEX_SESSION_SCAN_LIMIT } = {}) {
  const sessionsRoot = root ?? defaultSessionsRoot();
  const files = await findSessionFiles(sessionsRoot, { maxFiles });

  const events = [];
  for (const file of files) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    events.push(...extractFromText(text));
  }

  return { ...reduceLatest(events), filesScanned: files.length };
}
