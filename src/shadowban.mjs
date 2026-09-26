/**
 * X シャドウバンチェック収集（Shadowban Checker F の API を再現）。
 *
 * ★仕様メモ（2026-08-08 解読・実証済み）:
 *   - API: https://xsearchbancheckerapi.fia-s.com/api
 *   - 手順: ipify でIP取得 → key=base64(IV||AES-CBC(固定鍵,IV,IP))
 *     → generate-keyvalue → PoW(SHA-256(sessionId+nonce) が hex "000" 始まり)
 *     → check-by-user (X-Session-Token / X-Request-Hash ヘッダ必須)
 *   - Origin ヘッダ必須（無いと 500）。
 *   - レスポンスは平文JSON。フラグは boolean。
 *   - 非公式APIのため、失敗しても例外を投げず ok:false を返す。
 *     生の例外メッセージやパスは出力に載せない。
 */

import crypto from "node:crypto";
import https from "node:https";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const SHADOWBAN_SCHEMA_VERSION = 1;
export const SHADOWBAN_SERVICE_NAME = "shadowban";
export const SHADOWBAN_LATEST_FILE = path.join("data", "latest", "shadowban.json");

const API_BASE = "https://xsearchbancheckerapi.fia-s.com/api";
const CIPHER_KEY = Buffer.from("x1y2z3stuvwxYZ7890ghijklABCDEF12", "utf8");
const ORIGIN = "https://x-shadowban-checker.fia-s.com";
const POW_PREFIX = "000";
const POW_MAX_TRIES = 200_000;
const POW_TIME_BUDGET_MS = 2_000;
const IP_TTL_MS = 60 * 60 * 1000;
/** ネットワーク要求のタイムアウト。接続維持でCLIが止まらないようにする。 */
const REQUEST_TIMEOUT_MS = 15_000;


const REQUIRED_FLAG_KEYS = [
  "not_found",
  "suspend",
  "protect",
  "no_tweet",
  "search_ban",
  "search_suggestion_ban",
  "no_reply",
  "ghost_ban",
  "reply_deboosting",
];

let cachedIp = null;
let cachedIpAt = 0;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function postJson(pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      `${API_BASE}${pathname}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Origin: ORIGIN,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          ...headers,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => { buf += c; });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode, raw: buf });
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("request-timeout")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function getClientIp() {
  const now = Date.now();
  if (cachedIp !== null && now - cachedIpAt < IP_TTL_MS) return cachedIp;
  const ip = await new Promise((resolve, reject) => {
    const req = https
      .get("https://api.ipify.org/?format=json", (res) => {
        let buf = "";
        res.on("data", (c) => { buf += c; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(buf);
            resolve(typeof parsed.ip === "string" ? parsed.ip : null);
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("ip-timeout")));
  });
  if (ip !== null) {
    cachedIp = ip;
    cachedIpAt = now;
  }
  return ip;
}

function buildKey(ip) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", CIPHER_KEY, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(ip, "utf8")), cipher.final()]);
  return Buffer.concat([iv, ct]).toString("base64");
}

/** PoW: SHA-256(sessionId + nonce) のhexが POW_PREFIX で始まる nonce を探す。 */
function findNonce(sessionId, now = Date.now) {
  const deadline = now() + POW_TIME_BUDGET_MS;
  for (let i = 0; i < POW_MAX_TRIES; i++) {
    const h = crypto.createHash("sha256").update(sessionId + String(i)).digest("hex");
    if (h.startsWith(POW_PREFIX)) return String(i);
    if (now() > deadline) break;
  }
  return null;
}

function validateFlags(value) {
  if (!isRecord(value)) return null;
  for (const key of REQUIRED_FLAG_KEYS) {
    if (typeof value[key] !== "boolean") return null;
  }
  return {
    not_found: value.not_found,
    suspend: value.suspend,
    protect: value.protect,
    no_tweet: value.no_tweet,
    search_ban: value.search_ban,
    search_suggestion_ban: value.search_suggestion_ban,
    no_reply: value.no_reply,
    ghost_ban: value.ghost_ban,
    reply_deboosting: value.reply_deboosting,
  };
}

// テストから内部ロジックを検証できるようにする（node --test）。
export { buildKey, findNonce, validateFlags };

/**
 * 1回分のシャドウバンチェックを実行する。
 * 例外は投げず、必ず ok:false を含む結果オブジェクトを返す。
 * テストからは postJsonImpl / getClientIpImpl を注入できる。
 */
export async function collectShadowban(
  screenName,
  {
    now = () => new Date(),
    postJsonImpl = postJson,
    getClientIpImpl = getClientIp,
  } = {}
) {
  const fetchedAt = now().toISOString();
  const base = {
    schema_version: SHADOWBAN_SCHEMA_VERSION,
    service: SHADOWBAN_SERVICE_NAME,
    screen_name: screenName,
    fetched_at: fetchedAt,
  };

  if (typeof screenName !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(screenName)) {
    return { ...base, ok: false, flags: null, error: "invalid-screen-name" };
  }

  const ip = await getClientIpImpl();
  if (ip === null) {
    return { ...base, ok: false, flags: null, error: "ip-unavailable" };
  }

  const key = buildKey(ip);
  const body = { screen_name: screenName, key, searchban: true, repost: true };

  // 1. セッションキー発行
  let gk;
  try {
    gk = await postJsonImpl("/generate-keyvalue", body);
  } catch {
    return { ...base, ok: false, flags: null, error: "network-failed" };
  }
  if (gk.status !== 200 || !isRecord(gk.json) || typeof gk.json.key !== "string") {
    return { ...base, ok: false, flags: null, error: "keyvalue-failed" };
  }
  const sessionId = gk.json.key;

  // 2. PoW
  const nonce = findNonce(sessionId);
  if (nonce === null) {
    return { ...base, ok: false, flags: null, error: "pow-timeout" };
  }

  // 3. チェック実行
  let res;
  try {
    res = await postJsonImpl("/check-by-user", body, {
      "X-Session-Token": sessionId,
      "X-Request-Hash": nonce,
    });
  } catch {
    return { ...base, ok: false, flags: null, error: "network-failed" };
  }
  if (res.status !== 200 || !isRecord(res.json)) {
    return { ...base, ok: false, flags: null, error: "check-failed" };
  }

  const flags = validateFlags(res.json);
  if (flags === null) {
    return { ...base, ok: false, flags: null, error: "schema-changed" };
  }

  return { ...base, ok: true, flags, error: null };
}

/** data/latest/shadowban.json に書き出す。失敗しても throw しない。 */
export async function saveShadowbanSnapshot(snapshot, { out = SHADOWBAN_LATEST_FILE } = {}) {
  try {
    await mkdir(path.dirname(out), { recursive: true });
    // ★atomic 書き込み: 一時ファイル → rename。連携ツール が同時に読んでも
    //   途中状態のJSONを拾わない。
    const tmp = `${out}.tmp-${process.pid}`;

    await writeFile(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    await rename(tmp, out);
    return out;
  } catch {
    return null;
  }
}
