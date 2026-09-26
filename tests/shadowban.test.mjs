/**
 * shadowban.mjs の単体テスト（node --test）。
 * ネットワークは叩かない。postJsonImpl / getClientIpImpl を注入する。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildKey,
  collectShadowban,
  findNonce,
  saveShadowbanSnapshot,
  validateFlags,
} from "../src/shadowban.mjs";
import { runShadowbanForWatch } from "../src/index.mjs";

const CIPHER_KEY = Buffer.from("x1y2z3stuvwxYZ7890ghijklABCDEF12", "utf8");
const REAL_FLAGS = {
  not_found: false,
  suspend: false,
  protect: false,
  no_tweet: false,
  search_ban: true,
  search_suggestion_ban: true,
  no_reply: false,
  ghost_ban: false,
  reply_deboosting: false,
};

function okCheckByUser(overrides = {}) {
  return {
    status: 200,
    json: { ...REAL_FLAGS, ...overrides },
  };
}

test("buildKey: IV || AES-CBC の構造で、復号すると元IPに戻る", () => {
  const ip = "203.0.113.42";
  const key = buildKey(ip);
  const buf = Buffer.from(key, "base64");
  assert.equal(buf.length, 32, "IV(16) + ciphertext(16) = 32 bytes");

  const iv = buf.subarray(0, 16);
  const ct = buf.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", CIPHER_KEY, iv);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  assert.equal(plain, ip);
});

test("buildKey: 毎回ランダムなIVなので key は毎回異なる", () => {
  const ip = "203.0.113.42";
  assert.notEqual(buildKey(ip), buildKey(ip));
});

test("findNonce: 返した nonce の SHA-256(sessionId+nonce) は 000 で始まる", () => {
  const sessionId = "unit-test-session-id";
  const nonce = findNonce(sessionId);
  assert.ok(nonce !== null, "nonce should be found");
  const hash = crypto.createHash("sha256").update(sessionId + nonce).digest("hex");
  assert.ok(hash.startsWith("000"), `hash ${hash.slice(0, 8)}... should start with 000`);
});

test("findNonce: 時間予算超過で null（無限ループしない）", () => {
  let calls = 0;
  const now = () => {
    calls += 1;
    // 1回目で deadline を決定し、2回目のループ判定で必ず超過させる
    return calls === 1 ? 1_000 : Number.MAX_SAFE_INTEGER;
  };
  // 先頭が 000 にならない確実な入力（オールゼロでも先頭3桁が 000 になるのは稀だが、
  // ループ2回目で確実に break するため、仮にヒットしても別トークンで再確認する）
  const nonce = findNonce("definitely-not-matching", now);
  assert.equal(nonce, null);
});

test("validateFlags: 正常なフラグはそのまま返す", () => {
  const flags = validateFlags(REAL_FLAGS);
  assert.deepEqual(flags, REAL_FLAGS);
});

test("validateFlags: キー欠落は null", () => {
  const { search_ban, ...rest } = REAL_FLAGS;
  assert.equal(validateFlags(rest), null);
});

test("validateFlags: 非booleanは null", () => {
  assert.equal(validateFlags({ ...REAL_FLAGS, search_ban: "yes" }), null);
});

test("validateFlags: 非オブジェクトは null", () => {
  assert.equal(validateFlags(null), null);
  assert.equal(validateFlags([1, 2]), null);
});

test("collectShadowban: 不正な screen name は invalid-screen-name", async () => {
  const result = await collectShadowban("bad name!");
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid-screen-name");
});

test("collectShadowban: IP取得失敗は ip-unavailable", async () => {
  const result = await collectShadowban("example_user", {
    getClientIpImpl: async () => null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "ip-unavailable");
});

test("collectShadowban: generate-keyvalue の 5xx は keyvalue-failed", async () => {
  const result = await collectShadowban("example_user", {
    getClientIpImpl: async () => "203.0.113.42",
    postJsonImpl: async () => ({ status: 500, json: { message: "Internal server error" } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "keyvalue-failed");
});

test("collectShadowban: generate-keyvalue が key を返さないと keyvalue-failed", async () => {
  const result = await collectShadowban("example_user", {
    getClientIpImpl: async () => "203.0.113.42",
    postJsonImpl: async () => ({ status: 200, json: { value: 370370367 } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "keyvalue-failed");
});

test("collectShadowban: check-by-user の 5xx は check-failed", async () => {
  const result = await collectShadowban("example_user", {
    getClientIpImpl: async () => "203.0.113.42",
    postJsonImpl: async (pathname) =>
      pathname === "/generate-keyvalue"
        ? { status: 200, json: { key: "session-1", value: 370370367 } }
        : { status: 500, json: { message: "boom" } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "check-failed");
});

test("collectShadowban: 200 でも非JSON は check-failed", async () => {
  const result = await collectShadowban("example_user", {
    getClientIpImpl: async () => "203.0.113.42",
    postJsonImpl: async (pathname) =>
      pathname === "/generate-keyvalue"
        ? { status: 200, json: { key: "session-1", value: 370370367 } }
        : { status: 200, raw: "<html>not json</html>" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "check-failed");
});

test("collectShadowban: フラグ欠落は schema-changed（緑にしない）", async () => {
  const result = await collectShadowban("example_user", {
    getClientIpImpl: async () => "203.0.113.42",
    postJsonImpl: async (pathname) =>
      pathname === "/generate-keyvalue"
        ? { status: 200, json: { key: "session-1", value: 370370367 } }
        : { status: 200, json: { ...REAL_FLAGS, search_ban: undefined } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "schema-changed");
});

test("collectShadowban: 成功時に ok:true と flags を返す（リクエスト形状も検証）", async () => {
  const calls = [];
  const result = await collectShadowban("example_user", {
    now: () => new Date("2026-08-08T07:00:00.000Z"),
    getClientIpImpl: async () => "203.0.113.42",
    postJsonImpl: async (pathname, body, headers = {}) => {
      calls.push({ pathname, body, headers });
      if (pathname === "/generate-keyvalue") {
        return { status: 200, json: { key: "session-1", value: 370370367 } };
      }
      assert.equal(headers["X-Session-Token"], "session-1");
      assert.ok(typeof headers["X-Request-Hash"] === "string");
      return { status: 200, json: REAL_FLAGS };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.flags, REAL_FLAGS);
  assert.equal(result.error, null);
  assert.equal(result.screen_name, "example_user");
  assert.equal(result.fetched_at, "2026-08-08T07:00:00.000Z");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].pathname, "/generate-keyvalue");
  assert.equal(calls[1].pathname, "/check-by-user");
  // ボディの key は IV || ciphertext の base64（32バイト）
  const keyBuf = Buffer.from(calls[0].body.key, "base64");
  assert.equal(keyBuf.length, 32);
});

test("saveShadowbanSnapshot: atomic 書き込みで一時ファイルが残らない", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sbc-test-"));
  try {
    const out = path.join(dir, "shadowban.json");
    await saveShadowbanSnapshot({ ok: true, value: 1 }, { out });

    const saved = JSON.parse(await readFile(out, "utf8"));
    assert.equal(saved.ok, true);

    const entries = await readdir(dir);
    assert.ok(!entries.some((e) => e.includes(".tmp-")), "tmp ファイルが残らない");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveShadowbanSnapshot: 書き込み失敗時は null を返し例外を投げない", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sbc-test-"));
  try {
    // 親パスを「ファイル」にして mkdir を失敗させる
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "i am a file", "utf8");
    const out = path.join(blocker, "shadowban.json");

    const result = await saveShadowbanSnapshot({ ok: true }, { out });
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- watch 組み込み（runShadowbanForWatch）----

async function captureStderr(fn) {
  const original = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
    return chunks.join("");
  } finally {
    process.stderr.write = original;
  }
}


test("watch: 成功時は stderr に何も書かず、保存まで行う", async () => {
  let savedSnapshot = null;
  const stderr = await captureStderr(() =>
    runShadowbanForWatch(
      { shadowban: { screen_name: "example_user" } },
      {
        collectImpl: async () => ({ ok: true, flags: REAL_FLAGS, error: null }),
        saveImpl: async (snapshot) => {
          savedSnapshot = snapshot;
          return "saved";
        },
      }
    )
  );
  assert.equal(stderr, "");
  assert.equal(savedSnapshot.ok, true);
});

test("watch: 取得失敗(ok:false)でも例外を投げず stderr に理由を出す", async () => {
  const stderr = await captureStderr(() =>
    runShadowbanForWatch(
      {},
      {
        collectImpl: async () => ({ ok: false, error: "check-failed", flags: null }),
        saveImpl: async () => "saved",
      }
    )
  );
  assert.match(stderr, /check-failed/);
});

test("watch: 保存失敗は warn を出して継続する", async () => {
  const stderr = await captureStderr(() =>
    runShadowbanForWatch(
      {},
      {
        collectImpl: async () => ({ ok: true, flags: REAL_FLAGS, error: null }),
        saveImpl: async () => null,
      }
    )
  );
  assert.match(stderr, /保存に失敗/);
});

test("watch: 予期しない例外は stderr に出して投げ直さない（watch 継続）", async () => {
  const stderr = await captureStderr(() =>
    runShadowbanForWatch(
      {},
      {
        collectImpl: async () => {
          throw new Error("boom");
        },
        saveImpl: async () => "saved",
      }
    )
  );
  assert.match(stderr, /boom/);
});

test("watch: settings.shadowban.screen_name を尊重し既定は example_user", async () => {
  const seen = [];
  await runShadowbanForWatch(
    { shadowban: { screen_name: "custom_account" } },
    {
      collectImpl: async (screenName) => {
        seen.push(screenName);
        return { ok: true, flags: REAL_FLAGS, error: null };
      },
      saveImpl: async () => "saved",
    }
  );
  await runShadowbanForWatch(
    {},
    {
      collectImpl: async (screenName) => {
        seen.push(screenName);
        return { ok: true, flags: REAL_FLAGS, error: null };
      },
      saveImpl: async () => "saved",
    }
  );
  assert.deepEqual(seen, ["custom_account", "example_user"]);
});
