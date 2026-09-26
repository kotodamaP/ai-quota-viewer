/**
 * Codex の公式ローカル app-server から現在のアカウントレート制限を読む。
 * Web の Usage ページや認証情報ファイルは参照しない。
 */

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_STDOUT_CHARS = 2_000_000;

function appWindowToLegacy(window) {
  if (!window || typeof window !== "object") return null;
  return {
    used_percent: Number.isFinite(window.usedPercent) ? window.usedPercent : null,
    window_minutes: Number.isInteger(window.windowDurationMins)
      ? window.windowDurationMins
      : null,
    resets_at: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
  };
}

function appSnapshotToLegacy(snapshot, fallbackLimitId) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const limitId = snapshot.limitId ?? fallbackLimitId;
  if (typeof limitId !== "string" || limitId.length === 0) return null;

  return {
    limit_id: limitId,
    limit_name: typeof snapshot.limitName === "string" ? snapshot.limitName : null,
    primary: appWindowToLegacy(snapshot.primary),
    secondary: appWindowToLegacy(snapshot.secondary),
    credits: snapshot.credits
      ? {
          has_credits: snapshot.credits.hasCredits === true,
          unlimited: snapshot.credits.unlimited === true,
          balance: snapshot.credits.balance ?? null,
        }
      : null,
    individual_limit: snapshot.individualLimit ?? null,
    spend_control_reached: snapshot.spendControlReached ?? null,
    plan_type: typeof snapshot.planType === "string" ? snapshot.planType : null,
    rate_limit_reached_type: snapshot.rateLimitReachedType ?? null,
  };
}

/** app-server の GetAccountRateLimitsResponse を既存 Codex 正規化入力へ変換する。 */
export function convertAppServerRateLimits(response, { timestamp = new Date().toISOString() } = {}) {
  const byLimitId = new Map();
  const buckets = response?.rateLimitsByLimitId;

  if (buckets && typeof buckets === "object") {
    for (const [fallbackLimitId, snapshot] of Object.entries(buckets)) {
      const rl = appSnapshotToLegacy(snapshot, fallbackLimitId);
      if (rl) byLimitId.set(rl.limit_id, { timestamp, rl });
    }
  }

  if (byLimitId.size === 0) {
    const rl = appSnapshotToLegacy(response?.rateLimits, "codex");
    if (rl) byLimitId.set(rl.limit_id, { timestamp, rl });
  }

  let plan = null;
  for (const ev of byLimitId.values()) {
    if (ev.rl.plan_type) {
      plan = ev.rl.plan_type;
      if (ev.rl.limit_id === "codex") break;
    }
  }

  return { byLimitId, plan, filesScanned: 0 };
}

/**
 * app-server を一時的に stdio で起動し、account/rateLimits/read だけ実行する。
 * 認証トークンは argv/stdout へ出さない。
 */
export function collectCodexFromAppServer({
  command = "codex",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
  now = new Date(),
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });

    let settled = false;
    let buffer = "";

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      if (error) reject(error);
      else resolve(value);
    };

    const write = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        finish(error);
      }
    };

    const timer = setTimeout(
      () => finish(new Error("codex-app-server-timeout")),
      Math.max(1, timeoutMs)
    );

    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`codex-app-server-exited:${code ?? "unknown"}`));
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_STDOUT_CHARS) {
        finish(new Error("codex-app-server-output-too-large"));
        return;
      }

      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1) {
          if (message.error) {
            finish(new Error("codex-app-server-initialize-failed"));
          } else {
            write({ id: 2, method: "account/rateLimits/read", params: null });
          }
        } else if (message.id === 2) {
          if (message.error) {
            finish(new Error("codex-app-server-rate-limits-failed"));
          } else {
            const collected = convertAppServerRateLimits(message.result, {
              timestamp: now.toISOString(),
            });
            if (collected.byLimitId.size === 0) {
              finish(new Error("codex-app-server-empty-rate-limits"));
            } else {
              finish(null, collected);
            }
          }
        }
      }
    });

    write({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "ai-quota-viewer", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}
