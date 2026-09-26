/**
 * ブラウザ経由のアダプタ群。
 * 解析ロジックは src/parse/* にあり、Chromeなしで単体テストできる。
 *
 * 2つのモードを持つ:
 *   managed … 専用プロファイルのバックグラウンドChromeを自分で起動して読む（既定・推奨）
 *   attach  … ユーザーの常用Chromeにアタッチし、開いているタブを読む（従来方式）
 */

import { Cdp, CdpUnavailableError } from "../cdp.mjs";
import { ManagedChrome } from "../chrome/managed.mjs";
import { CdpError, listTargets, closeTab, CdpSession } from "../chrome/cdp.mjs";
import { parseClaude } from "../parse/claude.mjs";
import { parseGrok } from "../parse/grok.mjs";
import { parseCursor } from "../parse/cursor.mjs";
import { parseOpencode } from "../parse/opencode.mjs";
import { parseQwencloud } from "../parse/qwencloud.mjs";
import { parseGemini } from "../parse/gemini.mjs";

// Grokの合計使用率と追加クレジット残高は innerText には出ず、
// number-flow-react の aria-label にだけ存在する。必要な2値だけ補助行へ移す。
const GROK_TEXT_EXPRESSION = `(() => {
  const body = document.body ? document.body.innerText : "";
  const extra = [];
  for (const element of document.querySelectorAll("[aria-label]")) {
    const value = element.getAttribute("aria-label") || "";
    const context = element.parentElement ? element.parentElement.innerText.trim() : "";
    if (/^\\d+(?:\\.\\d+)?%$/.test(value) && /^使用済$/.test(context)) {
      extra.push("AI_TRIO_GROK_TOTAL " + value);
    }
    if (/^\\$\\s*[\\d,]+(?:\\.\\d+)?$/.test(value) && /追加のクレジット/.test(context)) {
      extra.push("AI_TRIO_GROK_CREDIT_BALANCE " + value);
    }
  }
  return [body, ...extra].filter(Boolean).join("\\n");
})()`;

// Google AI Studio のレート制限ページは「モデル × 指標」の表で、body.innerText では
// セルの対応（どの数値が RPM/TPM/RPD か）が失われる。そこで <tr> のセルから
// そのまま JSON を組み立てて渡す（解析・数値変換は src/parse/gemini.mjs 側で行う）。
//
// ★ステータス列（アイコンのリガチャ文字）は innerText に出ないため、ここで拾う。
//   "error" は「そのモデルは現在レート上限に達している」を意味する。
// ★RPM 列が数値でない行は落とす: 見出し行（"RPM"）と、ページ下部「ツール」節の
//   グラウンディング行（RPM/TPM が "-"）を除外するため。
// ★tier / project は表示中の選択状態をそのまま読む（どの枠を見ているかを
//   スナップショットに残し、別プロジェクトの数字を誤認しないようにする）。
const GEMINI_TEXT_EXPRESSION = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const body = document.body ? document.body.innerText : "";
  const lines = body.split("\\n").map((s) => s.trim()).filter(Boolean);

  const models = [];
  for (const tr of document.querySelectorAll("tr")) {
    const cells = Array.from(tr.querySelectorAll("td,th")).map((c) => clean(c.innerText));
    if (cells.length < 7) continue;
    if (!/^[\\d.,]+\\s*[KMB]?\\s*\\/\\s*([\\d.,]+\\s*[KMB]?|無制限)$/i.test(cells[3])) continue;
    models.push({
      status: cells[0], name: cells[1], category: cells[2],
      rpm: cells[3], tpm: cells[4], rpd: cells[5],
    });
  }

  const titleAt = lines.findIndex((l) => /Gemini API.*(レート制限|rate limit)/i.test(l));
  const tier = titleAt >= 0 ? (lines[titleAt + 1] || "") : "";
  const projAt = lines.lastIndexOf("Project");
  const project = projAt >= 0 ? (lines[projAt + 1] || "") : "";

  // ★ページ記載の「集計期間（UTC-8）」は渡さない。夏時間中は表記が1時間ズレるため、
  //   リセット時刻は src/parse/gemini.mjs 側で実測値から計算する。
  // ★アカウントの PRO バッジも渡さない。Google AI Pro は Gemini アプリのサブスクで
  //   あって API の枠ではない（混ぜると「どちらの残量か」が分からなくなる）。
  const payload = { tier, project, models };
  // 表が空＝未ログイン等。判定材料としてページ先頭のテキストを少量だけ添える。
  if (models.length === 0) payload.pageHint = body.slice(0, 400);
  return JSON.stringify(payload);
})()`;

export const BROWSER_SERVICES = {
  claude: {
    urlPattern: /^https:\/\/claude\.ai\//,
    fallbackUrl: "https://claude.ai/settings/usage",
    parse: parseClaude,
  },
  grok: {
    urlPattern: /^https:\/\/grok\.com\//,
    fallbackUrl: "https://grok.com/?_s=usage",
    textExpression: GROK_TEXT_EXPRESSION,
    parse: parseGrok,
  },
  cursor: {
    urlPattern: /^https:\/\/cursor\.com\/dashboard/,
    // ★/dashboard/spending がプラン/上限ビュー（レイアウトB）。
    //   %枠（Cursor Models / Other Models）と On-Demand の上限額が両方ここにある。
    //   /dashboard/usage は消費金額ビュー（レイアウトA）で %枠を持たない。
    fallbackUrl: "https://cursor.com/dashboard/spending",
    parse: parseCursor,
  },
  opencode: {
    urlPattern: /^https:\/\/opencode\.ai\//,
    // ★/go は Go プランの利用量%（5時間/週/月）を表示するページ。
    //   /billing は残高ページで % 枠が無いため、Go プランの取得先は /go が正。
    //   新UI移行に伴い /workspace/.../go から /console/.../go に変更。
    fallbackUrl: "https://opencode.ai/console/your_workspace_id/go",
    // ★OpenCode コンソール画面には「Sign in with the command for your version...」
    //   というCLI案内が常時存在するため、汎用 LOGIN_MARKERS だと通常画面を
    //   ログイン画面と誤認（偽陽性）して早期打ち切り（約2.4秒）してしまう。
    //   本物のログイン画面（Log in to OpenCode Console 等）だけを検知する。
    isLogin: (text) =>
      /Log in to OpenCode Console|Continue with (?:Google|GitHub|email)/i.test(text) &&
      !/(?:Overview|Settings|Usage|Loading Go subscription)/i.test(text),
    parse: parseOpencode,
  },
  qwencloud: {
    urlPattern: /^https:\/\/home\.qwencloud\.com\//,
    fallbackUrl: "https://home.qwencloud.com/billing/subscription/token-plan-individual",
    parse: parseQwencloud,
  },
  gemini: {
    urlPattern: /^https:\/\/aistudio\.google\.com\//,
    // ★/rate-limit が「モデル別の実績 / 上限」比較表（RPM・TPM・RPD）を出す唯一の画面。
    //   /usage はリクエスト総数のグラフだけで上限を持たないため使わない。
    //   timeRange=last-1-day … 直近の完了日（AI Studio は UTC-8 の日境界で集計）の
    //   ピーク実績と上限を比較する。28日指定にすると期間内の最大値になり直近の
    //   「残量」としては古い情報になるため、1日を既定にする。
    fallbackUrl: "https://aistudio.google.com/rate-limit?timeRange=last-1-day",
    textExpression: GEMINI_TEXT_EXPRESSION,
    parse: parseGemini,
  },
};

/** ログイン画面に落ちているかを判定する（サインイン導線しか無い状態） */
const LOGIN_MARKERS =
  /(サインイン|ログイン|Sign in|Log in|続行するには|Googleで続行|Continue with (Google|GitHub))/i;

function failure(service, kind, fetchedAt) {
  return {
    service,
    plan: null,
    fetched_at: fetchedAt,
    source_updated_at: null,
    source: "cdp-dom",
    ok: false,
    error: kind,
    limits: [],
    spend: null,
  };
}

/** managed モード: 自前Chromeで読み直してから取得する */
async function fetchTextManaged(spec, ctx) {
  const chrome = ctx.managedChrome ?? new ManagedChrome(ctx.managedOptions ?? {});
  // 「パーサが成功する状態」になるまで待つのが一番確実な準備完了条件
  const isReady = (text) => {
    try {
      return spec.parse(text, ctx).ok === true;
    } catch {
      return false;
    }
  };
  // ログイン画面は待っても変わらないので即打ち切る（待機時間の無駄を防ぐ）
  const isTerminal = (text) => {
    const isLogin = spec.isLogin ? spec.isLogin(text) : LOGIN_MARKERS.test(text);
    return isLogin && !isReady(text);
  };
  return chrome.readPage(spec.urlPattern, spec.fallbackUrl, isReady, {
    isTerminal,
    textExpression: spec.textExpression,
  });
}

/**
 * ★ハング回復（managed 専用）: ページのレンダラーが固まって CDP コマンドが
 *   応答しなくなることがある（2026-08-08 に claude.ai の Service Worker 破損で
 *   全コマンドが cdp-command-timeout になり、毎回の収集が失敗し続けた）。
 *   対処: ①対象サービスのタブを全部閉じる ②そのオリジンのサイトデータ
 *   （Service Worker / IndexedDB / cache / localStorage。Cookie は残すので
 *   ログインは維持される）を消す。呼び出し側でこの後に1回だけ再試行する。
 */
async function recoverManaged(service, spec, ctx) {
  const chrome = ctx.managedChrome;
  if (!chrome) return;

  // ①固まったタブを閉じる（ハングしたタブが URL パターンに一致し続けると、
  //   readPage が新規タブを作らず毎回同じタブを選んでしまうため必須）
  try {
    const targets = await listTargets(chrome.port);
    for (const t of targets) {
      if (t.type === "page" && spec.urlPattern.test(t.url)) {
        await closeTab(chrome.port, t.id).catch(() => {});
      }
    }
  } catch {
    /* タブ一覧すら取れない場合は再試行の自然回復に任せる */
  }

  // ②サイトデータを消す（SW 破損が原因なら、新規タブでも同じハングが起きるため）
  try {
    const origin = new URL(spec.fallbackUrl).origin;
    const targets = await listTargets(chrome.port).catch(() => []);
    const helper = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (helper) {
      const session = await CdpSession.connect(helper.webSocketDebuggerUrl, { timeoutMs: 8000 });
      try {
        await session.send(
          "Storage.clearDataForOrigin",
          { origin, storageTypes: "service_workers,indexeddb,cache_storage,local_storage" },
          { timeoutMs: 8000 }
        );
      } finally {
        session.close();
      }
    }
  } catch {
    /* クリア失敗でも再試行自体は行う */
  }
}

/** attach モード: ユーザーの常用Chromeで開いているタブを読む */
async function fetchTextAttach(spec, ctx) {
  const cdp = ctx.cdp ?? new Cdp(ctx.cdpOptions ?? {});
  return cdp.getPageText(spec.urlPattern, spec.fallbackUrl, {
    openIfMissing: ctx.openIfMissing !== false,
    expression: spec.textExpression,
  });
}

/**
 * @param {'claude'|'grok'|'cursor'|'opencode'|'qwencloud'|'gemini'} service
 * @param {{now: Date, offsetMinutes: number, fetchedAt: string, mode?: 'managed'|'attach'}} ctx
 */
export async function collectBrowserService(service, ctx) {
  const spec = BROWSER_SERVICES[service];
  if (!spec) return failure(service, "unknown-service", ctx.fetchedAt);

  const mode = ctx.mode ?? "managed";

  const attempt = async (which) => {
    let text;
    try {
      text = which === "attach" ? await fetchTextAttach(spec, ctx) : await fetchTextManaged(spec, ctx);
    } catch (e) {
      const kind =
        e instanceof CdpUnavailableError || e instanceof CdpError ? e.kind : "cdp-failed";
      return failure(service, kind, ctx.fetchedAt);
    }

    if (!text || text.trim().length === 0) {
      return failure(service, "empty-page-text", ctx.fetchedAt);
    }

    let snapshot;
    try {
      snapshot = spec.parse(text, ctx);
    } catch {
      return failure(service, "parse-failed", ctx.fetchedAt);
    }

    // 使用量が見つからず、ログイン導線しか無いなら原因を具体的に返す
    const isLogin = spec.isLogin ? spec.isLogin(text) : LOGIN_MARKERS.test(text);
    if (!snapshot.ok && snapshot.error === "usage-section-not-found" && isLogin) {
      return failure(service, "login-required", ctx.fetchedAt);
    }
    return snapshot;
  };

  const primary0 = await attempt(mode);

  // ★ハング回復: managed が CDP タイムアウトで失敗したら、固まったタブと
  //   サイトデータ（Cookie以外）を掃除して1回だけ再試行する。
  //   2026-08-08 claude.ai のSW破損で全コマンドがタイムアウトし続けた事象への対処。
  let primary = primary0;
  if (!primary.ok && mode === "managed" && primary.error === "cdp-command-timeout") {
    await recoverManaged(service, spec, ctx);
    const retried = await attempt(mode);
    if (retried.ok || retried.error !== "cdp-command-timeout") {
      primary = retried;
    }
  }

  if (primary.ok || mode !== "managed" || ctx.fallbackToAttach === false) return primary;

  // ★managedが未ログイン等で失敗したら、従来のattach（常用Chromeの開いているタブ）へ退避する。
  //   収集専用プロファイルへログインするまでの移行期間でも監視が途切れないようにするため。
  const fallback = await attempt("attach");
  if (fallback.ok) {
    return { ...fallback, source: "cdp-dom" };
  }
  // どちらも失敗したときは、原因がより具体的な managed 側の結果を返す
  return primary;
}
