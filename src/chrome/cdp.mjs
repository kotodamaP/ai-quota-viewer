/**
 * 最小限のCDPクライアント。Node組み込みWebSocketだけで動く（追加依存なし）。
 *
 * ★自前で起動したChromeなら /json/version と /json/list が正常に使える（P3実測）。
 *   ユーザーの常用Chromeは起動オプションの都合でこれらが404を返すため、
 *   そちらへは attach モード（外部cdp.mjs経由）を使い分ける。
 */

export class CdpError extends Error {
  constructor(kind) {
    super(kind);
    this.name = "CdpError";
    this.kind = kind;
  }
}

/** DevTools HTTP エンドポイントが応答するまで待つ */
export async function waitForDevTools(port, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* まだ起動中 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

export async function listTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) throw new CdpError("devtools-list-failed");
    return await res.json();
  } catch (e) {
    if (e instanceof CdpError) throw e;
    throw new CdpError("devtools-unreachable");
  }
}

export async function newTab(port, url = "about:blank") {
  const res = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" }
  );
  if (!res.ok) throw new CdpError("tab-open-failed");
  return await res.json();
}

export async function closeTab(port, targetId) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`);
  } catch {
    /* 失敗しても致命的ではない */
  }
}

/** 1つのターゲット（タブ）へのCDP接続 */
export class CdpSession {
  #ws;
  #nextId = 0;
  #pending = new Map();

  static async connect(webSocketDebuggerUrl, { timeoutMs = 15_000 } = {}) {
    const session = new CdpSession();
    const ws = new WebSocket(webSocketDebuggerUrl);
    session.#ws = ws;

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && session.#pending.has(msg.id)) {
        session.#pending.get(msg.id)(msg);
        session.#pending.delete(msg.id);
      }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError("ws-connect-timeout")), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpError("ws-connect-failed"));
      });
    });

    return session;
  }

  send(method, params = {}, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError("cdp-command-timeout"));
      }, timeoutMs);

      this.#pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });

      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new CdpError("cdp-send-failed"));
      }
    });
  }

  /** ページのテキストを取る。サービス固有の補助値が必要なら安全な固定式を渡せる。 */
  async innerText(expression = "document.body ? document.body.innerText : ''") {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    return res?.result?.result?.value ?? "";
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* noop */
    }
  }
}
