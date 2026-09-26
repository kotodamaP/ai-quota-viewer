/**
 * Antigravity CLI（agy）からの収集。
 *
 * ★ブラウザを使わない唯一の外部サービス。agy の print モードは読み取り専用の
 *   スラッシュコマンドにも答え、`/usage` は **クォータを消費しない**
 *   （実測: num_turns:0 / tokens 0）。だから 15 分間隔で叩いても枠を削らない。
 *
 * ★サインインしていないと groups が空で返る。その場合は
 *   parse 側が usage-not-signed-in を返す（原因が一目で分かるように）。
 *
 * ★agy のパスは settings.agy.path → `where agy` → 既定候補 の順で解決する。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { failureSnapshot } from "../normalize.mjs";
import { parseAntigravity } from "../parse/antigravity.mjs";

const DEFAULT_CANDIDATES = [
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\agy\\bin\\agy.exe` : null,
];

function whichAgy() {
  return new Promise((resolve) => {
    execFile("where", ["agy"], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first ?? null);
    });
  });
}

/** @returns {Promise<string|null>} */
export async function resolveAgyPath(configured) {
  if (configured && existsSync(configured)) return configured;
  const found = await whichAgy();
  if (found && existsSync(found)) return found;
  return DEFAULT_CANDIDATES.find((p) => p && existsSync(p)) ?? null;
}

function runAgy(agyPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      agyPath,
      args,
      // ★作業ディレクトリは渡さない（cwd はプロセスの現在地）。/usage は読み取り専用で
      //   ファイルにも触らないので、ここでワークスペースを与える必要がない。
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const kind = err.killed ? "agy-timeout" : "agy-failed";
          return reject(Object.assign(new Error(kind), { kind, stderr: String(stderr ?? "") }));
        }
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      }
    );
  });
}

/**
 * @param {{now: Date, offsetMinutes: number, fetchedAt: string, settings?: object}} ctx
 */
export async function collectAntigravity(ctx) {
  const timeoutMs = ctx.settings?.agy?.timeout_ms ?? 60_000;
  const agyPath = await resolveAgyPath(ctx.settings?.agy?.path ?? null);
  if (!agyPath) return failureSnapshot("antigravity", "agy-not-found", ctx);

  let out;
  try {
    out = await runAgy(
      agyPath,
      // ★`--disable-slash-commands` を付けてはいけない。付けると `/usage` が
      //   コマンドとして処理されず、ただのプロンプトとしてモデルに投げられる
      //   （実測: 27秒かかったうえ command フィールドが無く parse が失敗する）。
      //   ここで渡すのは固定文字列なので、スラッシュ展開を止める必要はない。
      ["-p", "/usage", "--output-format", "json"],
      timeoutMs
    );
  } catch (e) {
    return failureSnapshot("antigravity", e.kind ?? "agy-failed", { ...ctx, source: "local-cli" });
  }

  const text = out.stdout || out.stderr;
  if (!text.trim()) {
    return failureSnapshot("antigravity", "empty-output", { ...ctx, source: "local-cli" });
  }

  try {
    return parseAntigravity(text, ctx);
  } catch {
    return failureSnapshot("antigravity", "parse-failed", { ...ctx, source: "local-cli" });
  }
}
