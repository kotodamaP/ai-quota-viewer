/**
 * ローカルダッシュボード。
 * ★127.0.0.1 バインド固定（設計仕様）。0.0.0.0 は settings 側で弾いてある。
 * ★DNSリバインディング対策として Host ヘッダも検査する。
 * 外部依存なし（node:http のみ）。
 */

import http from "node:http";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSettings, applyDefaults, MIN_INTERVAL_MINUTES } from "../settings.mjs";
import { loadPricing } from "../pricing.mjs";
import { collectAndPublish } from "../collect.mjs";
import { readFxHistory, loadEcbSeries } from "../fx-history.mjs";
import { readRunpod } from "../adapters/runpod.mjs";
import { buildFeedFromDisk, FEED_FILE } from "../feed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const SETTINGS_FILE = path.join("config", "settings.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const ALLOWED_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return ALLOWED_HOSTS.test(u.host);
  } catch {
    return false;
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body-too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readLatest(settings) {
  const out = [];
  for (const service of Object.keys(settings.services)) {
    if (settings.services[service] === false) continue;
    try {
      out.push(JSON.parse(await readFile(path.join("data", "latest", `${service}.json`), "utf8")));
    } catch {
      out.push({
        service, plan: null, fetched_at: null, source_updated_at: null,
        source: "manual", ok: false, error: "not-collected-yet", limits: [], spend: null,
      });
    }
  }
  return out;
}

/** snapshots.jsonl から時系列を作る（末尾 maxLines 行のみ見る） */
async function readHistory(maxLines = 3000) {
  let text;
  try {
    text = await readFile(path.join("data", "snapshots.jsonl"), "utf8");
  } catch {
    return {};
  }
  const lines = text.split("\n").filter(Boolean).slice(-maxLines);

  /** @type {Record<string, {t: string, series: Record<string, number>}[]>} */
  const byService = {};
  for (const line of lines) {
    let snap;
    try { snap = JSON.parse(line); } catch { continue; }
    if (!snap.ok) continue;

    const series = {};
    for (const limit of snap.limits ?? []) {
      for (const w of limit.windows ?? []) {
        if (Number.isFinite(w.used_percent)) {
          series[`${limit.limit_id}/${w.window_minutes}`] = w.used_percent;
        }
      }
    }
    if (Number.isFinite(snap.spend?.used_percent)) series["spend"] = snap.spend.used_percent;
    if (Object.keys(series).length === 0) continue;

    (byService[snap.service] ??= []).push({ t: snap.fetched_at, series });
  }
  return byService;
}

async function uiVersion() {
  // ★UI(HTML)の同一性。開きっぱなしのウィンドウが古い画面のまま残る問題
  //   （2026-09-13: 改名と月額合計が反映されなかった）への恒久対処。
  //   ページ側はこの値が変わったら location.reload() する。
  try {
    const st = await stat(path.join(PUBLIC_DIR, "index.html"));
    return `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch {
    return "unknown";
  }
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  // ディレクトリトラバーサル防止
  const resolved = path.resolve(PUBLIC_DIR, rel);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(resolved);
    res.writeHead(200, {
      "content-type": MIME[path.extname(resolved)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

export async function startServer(settingsArg) {
  let settings = settingsArg ?? (await loadSettings());
  const { host, port } = settings.dashboard;
  /** 同時 collect を防ぐ（Chrome CDP 競合でハング・古い結果に見えるのを避ける） */
  let collectInFlight = null;

  const server = http.createServer(async (req, res) => {
    // ★Hostヘッダ検査（DNSリバインディング対策）
    if (!ALLOWED_HOSTS.test(req.headers.host ?? "")) {
      res.writeHead(403).end("forbidden host");
      return;
    }

    // ★Origin検査（CSRF対策）
    if (req.method === "POST" && !isAllowedOrigin(req.headers.origin)) {
      res.writeHead(403).end("forbidden origin");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
      if (url.pathname === "/api/state") {
        settings = await loadSettings();
        const pricing = await loadPricing();
        json(res, 200, {
          snapshots: await readLatest(settings),
          settings: {
            thresholds: settings.thresholds,
            notify: settings.notify,
            collect_interval_minutes: settings.collect_interval_minutes,
            min_interval_minutes: MIN_INTERVAL_MINUTES,
            services: settings.services,
            layout: settings.layout,
          },
          pricing: { fx: pricing.fx ?? {}, services: pricing.services ?? {} },
          // ★画面も他システムと同じ解釈（src/feed.mjs）で描く
          feed: await buildFeedFromDisk(settings),
          ui_version: await uiVersion(),
          collecting: Boolean(collectInFlight),
          now: new Date().toISOString(),
        });
        return;
      }

      if (url.pathname === "/api/fx-history") {
        const pricing = await loadPricing();
        json(res, 200, {
          days: 7,
          live: (await readFxHistory({ days: 7 })).map((e) => ({ t: e.t, v: e.usd_jpy, source: e.source })),
          ecb: (await loadEcbSeries({ days: 7 })).map((e) => ({ d: e.date, v: e.usd_jpy })),
          current: { v: pricing.fx?.usd_jpy ?? null, date: pricing.fx?.last_verified ?? null, source: pricing.fx?.source ?? null },
        });
        return;
      }

      // 共通フィード（他システム向け）。公開済みファイルを返し、未公開なら同じ関数でその場で組み立てる
      if (url.pathname === "/api/feed") {
        let feed = null;
        try {
          feed = JSON.parse(await readFile(FEED_FILE, "utf8"));
        } catch {
          feed = await buildFeedFromDisk(await loadSettings());
        }
        json(res, 200, feed);
        return;
      }

      if (url.pathname === "/api/runpod") {
        json(res, 200, await readRunpod({ days: 7 }));
        return;
      }

      if (url.pathname === "/api/history") {
        json(res, 200, await readHistory());
        return;
      }

      if ((url.pathname === "/api/refresh" || url.pathname === "/api/collect") && req.method === "POST") {
        if (collectInFlight) {
          json(res, 409, {
            error: "collect-in-progress",
            message: "別の取得が進行中です。完了してから再度お試しください。",
          });
          return;
        }
        settings = await loadSettings();
        const pricing = await loadPricing();
        const only = url.searchParams.get("service")
          ? [url.searchParams.get("service")]
          : undefined;
        collectInFlight = (async () => {
          const { snapshots, warnings } = await collectAndPublish(settings, { pricing, only });
          return { snapshots, warnings };
        })();
        try {
          const result = await collectInFlight;
          json(res, 200, result);
        } finally {
          collectInFlight = null;
        }
        return;
      }

      if (url.pathname === "/api/settings" && req.method === "POST") {
        const ct = req.headers["content-type"] || "";
        if (!ct.includes("application/json")) {
          json(res, 415, { error: "unsupported-media-type", message: "application/json is required" });
          return;
        }
        const raw = JSON.parse(await readBody(req));
        const currentFile = JSON.parse(await readFile(SETTINGS_FILE, "utf8").catch(() => "{}"));

        // ★UIから変更を許可する安全な項目のみ反映する（cdp.script_path 等の実行パス改変を防止）
        const allowedUpdates = {};
        if (raw.services && typeof raw.services === "object") allowedUpdates.services = raw.services;
        if (raw.layout && typeof raw.layout === "object") allowedUpdates.layout = raw.layout;
        if (raw.collect_interval_minutes !== undefined) allowedUpdates.collect_interval_minutes = raw.collect_interval_minutes;
        if (raw.thresholds && typeof raw.thresholds === "object") allowedUpdates.thresholds = raw.thresholds;
        if (raw.notify && typeof raw.notify === "object") allowedUpdates.notify = raw.notify;
        if (raw.pricing_stale_days !== undefined) allowedUpdates.pricing_stale_days = raw.pricing_stale_days;
        if (raw.extras && typeof raw.extras === "object") allowedUpdates.extras = raw.extras;

        // ★サーバ側で下限を強制する。UIからは絶対に15分未満にできない
        const merged = applyDefaults({
          ...currentFile,
          ...allowedUpdates,
        });
        const toSave = {
          collect_interval_minutes: merged.collect_interval_minutes,
          thresholds: merged.thresholds,
          notify: merged.notify,
          dashboard: currentFile.dashboard ?? merged.dashboard,
          services: merged.services,
          shadowban: currentFile.shadowban ?? merged.shadowban,
          layout: merged.layout,
          cdp: currentFile.cdp ?? merged.cdp,
          pricing_stale_days: merged.pricing_stale_days,
          extras: merged.extras,
        };
        await writeFile(SETTINGS_FILE, JSON.stringify(toSave, null, 2) + "\n", "utf8");
        settings = merged;
        json(res, 200, {
          saved: toSave,
          clamped: merged.interval_was_clamped,
          min_interval_minutes: MIN_INTERVAL_MINUTES,
        });
        return;
      }

      await serveStatic(res, url.pathname);
    } catch {
      // ★生の例外を返さない
      json(res, 500, { error: "internal-error" });
    }
  });

  // ★listen 失敗（EADDRINUSE 等）は reject する。error イベントを放置すると
  //   未処理例外でプロセスごと落ちる（watch 同居時に致命的）。
  // ★常にループバック（127.0.0.1 または localhost）にバインドする
  const bindHost = host === "localhost" || host === "127.0.0.1" ? host : "127.0.0.1";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.stderr.write(`dashboard: http://${bindHost}:${port}\n`);
  return server;
}
