/**
 * settings.mjs の単体テスト（node --test）。
 * ★server.mjs の /api/settings 保存は applyDefaults 経由で merged を作るため、
 *   shadowban が設定保存で消えないことをここで保証する
 *   （toSave に shadowban 欠落の防止対応）。

 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyDefaults, DEFAULT_SETTINGS, MIN_INTERVAL_MINUTES } from "../src/settings.mjs";

test("applyDefaults: shadowban.screen_name を保持する", () => {
  const merged = applyDefaults({
    shadowban: { screen_name: "custom_account" },
  });
  assert.equal(merged.shadowban.screen_name, "custom_account");
});

test("applyDefaults: shadowban 未指定なら既定 example_user", () => {
  const merged = applyDefaults({});
  assert.equal(merged.shadowban.screen_name, DEFAULT_SETTINGS.shadowban.screen_name);
  assert.equal(merged.shadowban.screen_name, "example_user");
});

test("applyDefaults: shadowban.screen_name が非文字列なら既定にフォールバック", () => {
  const merged = applyDefaults({ shadowban: { screen_name: 123 } });
  assert.equal(merged.shadowban.screen_name, "example_user");
});


test("applyDefaults: 他設定の保存と同時でも shadowban は消えない（toSave相当のマージ）", () => {
  // server.mjs /api/settings の流れ: 既存設定 + raw を applyDefaults に渡す
  const raw = {
    ...DEFAULT_SETTINGS,
    shadowban: { screen_name: "custom_account" },
  };
  const merged = applyDefaults(raw);
  assert.equal(merged.shadowban.screen_name, "custom_account");
});

test("applyDefaults: 収集間隔の下限15分は維持される", () => {
  const merged = applyDefaults({ collect_interval_minutes: 5 });
  assert.equal(merged.collect_interval_minutes, MIN_INTERVAL_MINUTES);
  assert.equal(merged.interval_was_clamped, true);
});
