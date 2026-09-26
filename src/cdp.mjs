/**
 * chrome-cdp-skill (cdp.mjs) の薄いラッパ。
 *
 * ★なぜ自前でCDPを実装しないか:
 *   起動設定によっては /json/version など DevTools HTTP 発見エンドポイントが 404 を返し、
 *   ポート直叩きでは target 一覧が取れない場合がある。

 *   cdp.mjs は DevToolsActivePort から browser WebSocket に直結し、
 *   「デバッグを許可しますか？」モーダルとタブ毎デーモンの面倒も見てくれる。
 *   実績のあるそちらに乗るほうが堅い。
 *
 * ★セキュリティ: ここではログイン操作を一切行わない。既にログイン済みのタブを読むだけ。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export const DEFAULT_CDP_SCRIPT =
  "null";

const TARGET_LINE = /^([0-9A-Fa-f]{8})\s+(.*?)\s+(https?:\/\/\S+)\s*$/;

export class CdpUnavailableError extends Error {
  constructor(kind) {
    super(kind);
    this.name = "CdpUnavailableError";
    this.kind = kind;
  }
}

function run(scriptPath, args, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    const timer = setTimeout(() => {
      child.kill();
      reject(new CdpUnavailableError("cdp-timeout"));
    }, timeoutMs);

    child.on("error", () => {
      clearTimeout(timer);
      reject(new CdpUnavailableError("cdp-spawn-failed"));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // ★stderr をそのまま外に出さない（パス等が混ざりうるため種別だけ返す）
        reject(new CdpUnavailableError("cdp-command-failed"));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export class Cdp {
  constructor({ scriptPath = DEFAULT_CDP_SCRIPT, timeoutMs = 45_000 } = {}) {
    this.scriptPath = scriptPath;
    this.timeoutMs = timeoutMs;
  }

  available() {
    return existsSync(this.scriptPath);
  }

  async listTargets() {
    if (!this.available()) throw new CdpUnavailableError("cdp-script-not-found");
    const { stdout } = await run(this.scriptPath, ["list"], { timeoutMs: this.timeoutMs });
    const targets = [];
    for (const line of stdout.split("\n")) {
      const m = TARGET_LINE.exec(line.trim());
      if (m) targets.push({ id: m[1], title: m[2], url: m[3] });
    }
    return targets;
  }

  async evaluate(targetId, expression) {
    const { stdout } = await run(this.scriptPath, ["eval", targetId, expression], {
      timeoutMs: this.timeoutMs,
    });
    return stdout;
  }

  async openTab(url) {
    const { stdout } = await run(this.scriptPath, ["open", url], { timeoutMs: this.timeoutMs });
    const m = /Opened new tab:\s*([0-9A-Fa-f]{8})/.exec(stdout);
    return m ? m[1] : null;
  }

  /**
   * urlPattern に一致する既存タブを探し、無ければ開いて innerText を取得する。
   * ★既存タブを別URLへ遷移させない（ユーザーの作業タブを壊さないため）。
   */
  async getPageText(
    urlPattern,
    fallbackUrl,
    { openIfMissing = true, expression = "document.body.innerText" } = {}
  ) {
    const targets = await this.listTargets();
    let target = targets.find((t) => urlPattern.test(t.url));

    if (!target) {
      if (!openIfMissing) throw new CdpUnavailableError("tab-not-open");
      const id = await this.openTab(fallbackUrl);
      if (!id) throw new CdpUnavailableError("tab-open-failed");
      // 新規タブは初回アクセス時に承認モーダルが出るため、少し待ってから読む
      await new Promise((r) => setTimeout(r, 3000));
      target = { id, url: fallbackUrl };
    }

    const text = await this.evaluate(target.id, expression);
    if (!text || text.trim().length === 0) throw new CdpUnavailableError("empty-page-text");
    return text;
  }
}
