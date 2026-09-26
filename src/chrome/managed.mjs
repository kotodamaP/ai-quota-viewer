/**
 * 専用プロファイルのバックグラウンドChromeを管理する。
 *
 * ★狙い: ユーザーの常用Chromeとタブに一切依存しない。
 *   - 常用Chromeが起動していなくても収集できる
 *   - ユーザーの作業タブを増やさない・触らない
 *   - 自分のブラウザなので自由にreloadでき、「タブが古いまま」問題も消える
 *
 * ★headlessにはしない。claude.ai と cursor.com は headless だと
 *   Cloudflareのボット検証に止められることを実測で確認済み（P3+）。
 *   実ウィンドウを画面外に置く方式なら3社とも通過する。
 *   これは検証の回避ではなく、実ブラウザをそのまま使っているだけ。
 *
 * ★ログインはユーザーが一度だけ手動で行う（`node src/index.mjs login`）。
 *   認証情報の入力・保存はこのツールでは一切行わない。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  CdpError, CdpSession, waitForDevTools, listTargets, newTab,
} from "./cdp.mjs";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
];

/** 画面外に置くための座標。ウィンドウは実在するが視界に入らない。 */
const OFFSCREEN = "-32000,-32000";

export function findChrome(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  return CHROME_CANDIDATES.find((p) => p && existsSync(p)) ?? null;
}

export class ManagedChrome {
  constructor(options = {}) {
    this.chromePath = findChrome(options.chromePath);
    this.profileDir = path.resolve(options.profileDir ?? ".chrome-profile");
    this.port = options.port ?? 9335;
    this.offscreen = options.offscreen !== false;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.child = null;
  }

  available() {
    return Boolean(this.chromePath);
  }

  #args({ visible = false } = {}) {
    const args = [
      `--remote-debugging-port=${this.port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      // ★背景タブのレンダリング抑制を止める。
      //   これが無いと、前面でないタブの innerText が空のまま返ることがある（実測）。
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,900",
    ];
    if (!visible && this.offscreen) args.push(`--window-position=${OFFSCREEN}`);
    return args;
  }

  /** 既に起動していればそれを使い、無ければ起動する */
  async ensureRunning({ visible = false } = {}) {
    if (!this.available()) throw new CdpError("chrome-not-found");

    const existing = await waitForDevTools(this.port, { timeoutMs: 1200 });
    if (existing) return { started: false, browser: existing.Browser };

    await mkdir(this.profileDir, { recursive: true });

    this.child = spawn(this.chromePath, [...this.#args({ visible }), "about:blank"], {
      stdio: "ignore",
      windowsHide: !visible,
      detached: true,
    });
    this.child.unref();

    const ver = await waitForDevTools(this.port, { timeoutMs: this.timeoutMs });
    if (!ver) throw new CdpError("chrome-devtools-not-ready");
    return { started: true, browser: ver.Browser };
  }

  async #pageTargets() {
    return (await listTargets(this.port)).filter((t) => t.type === "page");
  }

  /**
   * urlPattern に一致するタブを探し（無ければ作り）、常に読み直してから
   * `isReady(text)` が true になるまで待つ。
   * 自分のブラウザなので毎回reloadしてよい ＝ 取得データが常に新鮮。
   */
  async readPage(
    urlPattern,
    url,
    isReady,
    { settleMs = 1200, waitMs = 25_000, isTerminal = null, textExpression = undefined } = {}
  ) {
    await this.ensureRunning();

    let target = (await this.#pageTargets()).find((t) => urlPattern.test(t.url));
    if (!target) target = await newTab(this.port, url);
    if (!target?.webSocketDebuggerUrl) {
      // /json/new が webSocketDebuggerUrl を返さない場合は一覧から引き直す
      target = (await this.#pageTargets()).find((t) => urlPattern.test(t.url) || t.id === target?.id);
    }
    if (!target?.webSocketDebuggerUrl) throw new CdpError("target-unavailable");

    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    try {
      await session.send("Page.enable");
      // ★ログイン後にウィンドウが画面内に残っていたら、収集のたびに画面外へ戻す（2026-09-26）。
      //   login でウィンドウを出したまま閉じ忘れると、15分ごとの前面化が作業の邪魔になるため。
      if (this.offscreen) await this.#keepWindowOffscreen(session, target.id);
      // ★読む対象を前面に出す。背景タブのままだと描画が進まず innerText が空になる。
      await session.send("Page.bringToFront").catch(() => {});

      // ★旧ドキュメントに目印を置く（レース防止）:
      //   新ドキュメントに置き換わると消えるため、「reload 前の古い innerText を

      //   isReady と誤認する」レースを防げる。
      await session
        .send("Runtime.evaluate", { expression: "window.__aiQuotaStale = true" })
        .catch(() => {});

      const nav = await session.send("Page.navigate", { url });
      // ★フラグメント付き URL（chatgpt.com/#settings/Usage 等）への同一 URL navigate は
      //   same-document navigation になり loaderId が返らず、ドキュメントが読み直されない。
      //   その場合のみ明示的に reload する（他サービスは loaderId 有り → 挙動不変）。
      if (!nav?.result?.loaderId) {
        await session.send("Page.reload", {});
      }

      const deadline = Date.now() + waitMs;
      let text = "";
      let terminalStreak = 0; // ★ロード中の中間状態での login 誤発火対策
      while (Date.now() < deadline) {

        await new Promise((r) => setTimeout(r, settleMs));
        // 目印が残っている間は旧ドキュメント。読み取りをスキップして待つ。
        const stale = await session
          .send("Runtime.evaluate", {
            expression: "window.__aiQuotaStale === true",
            returnByValue: true,
          })
          .catch(() => null);
        if (stale?.result?.result?.value === true) {
          terminalStreak = 0;
          continue;
        }

        text = await session.innerText(textExpression);
        if (!text) continue;
        if (isReady(text)) return text;
        // ★ログイン画面のように「待っても変わらない」状態なら即座に打ち切る。
        //   これが無いと1社あたり待機時間いっぱい（25秒）掛かってしまう。
        //   ただし reload 直後のロード中は「Log in」等の文言が一時的に現れるため、
        //   2回連続で初めて打ち切る（chatgpt.com で誤発火を確認・2026-08-10）。
        if (isTerminal && isTerminal(text)) {
          terminalStreak += 1;
          if (terminalStreak >= 2) return text;
        } else {
          terminalStreak = 0;
        }
      }
      // 時間切れ。取れた分は返し、判定は呼び出し側のパーサに任せる
      return text;
    } finally {
      session.close();
    }
  }

  /**
   * ログイン用に、確実に「見える位置」でウィンドウを出す。
   *
   * ★注意: 収集用Chromeが既に画面外(-32000,-32000)で起動していることがある。
   *   その場合 ensureRunning は既存プロセスを再利用するため、visible フラグだけでは
   *   ウィンドウは画面外のままになり、ユーザーがログイン操作できない。
   *   よって既存プロセスに対しては CDP でウィンドウ位置を画面内へ戻す。
   */
  async openVisible(urls) {
    const { started } = await this.ensureRunning({ visible: true });

    const targets = await this.#pageTargets();
    if (!started && targets.length > 0) {
      await this.#moveWindowOnScreen(targets[0]);
    }

    for (const url of urls) await newTab(this.port, url);

    // タブを開いた後にもう一度前面へ出す（新規タブで別ウィンドウが立つ場合に備える）
    const after = await this.#pageTargets();
    if (after.length > 0) await this.#moveWindowOnScreen(after[after.length - 1]);

    return this.port;
  }

  /** 画面内に出ているウィンドウを画面外（-32000,-32000）へ戻す。失敗しても収集は続ける */
  async #keepWindowOffscreen(session, targetId) {
    try {
      const res = await session.send("Browser.getWindowForTarget", { targetId });
      const windowId = res?.result?.windowId;
      const left = res?.result?.bounds?.left;
      if (windowId === undefined || !(left > -10000)) return;
      const [x, y] = OFFSCREEN.split(",").map(Number);
      await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      await session.send("Browser.setWindowBounds", { windowId, bounds: { left: x, top: y } });
    } catch {
      /* 位置を戻せなくても読取は続行 */
    }
  }

  /** 画面外に置かれたウィンドウを画面内へ戻して前面化する */
  async #moveWindowOnScreen(target) {
    if (!target?.webSocketDebuggerUrl) return;
    let session;
    try {
      session = await CdpSession.connect(target.webSocketDebuggerUrl);
      const res = await session.send("Browser.getWindowForTarget", { targetId: target.id });
      const windowId = res?.result?.windowId;
      if (windowId === undefined) return;
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: 80, top: 60, width: 1280, height: 900, windowState: "normal" },
      });
      // 前面化（失敗しても致命的ではない）
      await session.send("Page.bringToFront").catch(() => {});
    } catch {
      /* 位置調整に失敗してもログイン導線自体は続行させる */
    } finally {
      session?.close();
    }
  }

  async stop() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`);
      if (!res.ok) return false;
    } catch {
      return false;
    }
    // Browser.close で行儀よく終了させる
    try {
      const info = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json();
      if (info.webSocketDebuggerUrl) {
        const s = await CdpSession.connect(info.webSocketDebuggerUrl);
        await s.send("Browser.close").catch(() => {});
        s.close();
        return true;
      }
    } catch {
      /* fallthrough */
    }
    if (this.child) {
      try { this.child.kill(); return true; } catch { /* noop */ }
    }
    return false;
  }
}
