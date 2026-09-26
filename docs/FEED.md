# 共通フィード quota-feed/1（利用側向け）

AI Quota Viewer が集めた残量・残高を、他システム（外部連携ツール など）が**同じ解釈の値**で表示するための読み口。
設計: ドキュメント `docs/FEED.md`

## 読み方

| 方法 | 場所 |
|---|---|
| ファイル（既定・serve が落ちていても読める） | `.\data\feed\quota-feed.v1.json` |
| HTTP（ブラウザ UI 向け・127.0.0.1 限定） | `GET http://127.0.0.1:7777/api/feed` |

- 書き手は watch（15分ごと）と「今すぐ更新」だけ。収集→保存→公開は1つの直列処理で、ファイルは tmp→rename で置き換わる（読んでいる途中で壊れない）。
- `generation` は公開のたびに1つ増える。変わっていなければ読み直さなくてよい（mtime を見てもよい）。
- 契約: `schema/quota-feed.v1.schema.json`。
- 既存の `data/latest/*.json`（生データ）は今後も残る。ただし解釈は各自でせず、このフィードへ移ること。

## 必ず守ること

1. **古さは読むたびに判定する**: `stale_at < 現在時刻` なら古い。キャッシュ中も毎回比べる（収集が止まってもフィードの中身は変わらないため）。
2. **値を作らない**: `null` は「無い／取れない」。0 や前回値で埋めない。
   - `ok:false` ＋ `error` … 取得失敗（`login-required` など）
   - `ok:false` ＋ `last_ok_at` ＋値 … 前回取れた値を保持中（今は RunPod のみ）。「古い値」と分かる表示にする
   - `ok:true` で一部が `null` … 取得は成功、その項目が無いだけ（例: 週次枠が無いサービスの `weekly`）
3. **知らない項目は無視する**。v1 の中では任意項目の追加しかしない。意味を変えるときは `quota-feed.v2.json` を別に出す。

## 主な項目

| 項目 | 意味 |
|---|---|
| `services[].kind` | `llm`（AI サービス）／`infra`（RunPod などの残高） |
| `services[].headline` | 表示枠のうち最も逼迫した枠。枠が無ければ支出枠（`limit_id:"spend"`）。AI Quota Viewer のゲージと同じ |
| `services[].weekly` | 週次（10080分）枠。**既存の利用側と同じ選定**: claude=`all_models`、codex=`codex`、grok=`weekly`（旧形式は API＋チャットの合算）、その他は週次枠の最大 |
| `*.used_percent` / `remaining_percent` | **丸めていない生値**。表示の丸めは利用側で |
| `*.severity` | `ok`（≤50）/`warn`（>50）/`danger`（>80）。小数1桁に丸めて判定 |
| `services[].windows[]` | 表示対象の全枠（`codex_bengalfox` は除外済み） |
| `services[].monthly_jpy` | そのサービスの契約月額（円）。未契約・未設定は `null` |
| `services[runpod].balance` | `usd`・`jpy`・`spend_per_hr_usd`・`hours_left` |
| `subscriptions` | 契約サブスク月額合計（円）と予約済み変更後の次回額 `next` |
| `fx` | 円換算に使った USD/JPY |

## 読み取り例（Node / TypeScript）

```ts
import { readFile } from "node:fs/promises";

const FEED = process.env.QUOTA_FEED_PATH ?? "./data/feed/quota-feed.v1.json";

export async function weeklyRemaining(id: string, now = Date.now()) {
  const feed = JSON.parse(await readFile(FEED, "utf8"));
  if (feed.schema !== "quota-feed/1") return { ok: false, error: "unsupported-schema" };
  const s = feed.services.find((x: any) => x.id === id);
  if (!s) return { ok: false, error: "unknown-service" };
  const stale = !s.stale_at || Date.parse(s.stale_at) < now;
  if (!s.ok || !s.weekly) return { ok: false, error: s.error ?? "no-weekly-window", stale };
  return { ok: true, remaining: s.weekly.remaining_percent, resetsAt: s.weekly.resets_at, stale };
}
```

## 移行時の注意

- 各種クライアントで週次枠や古さ判定を解釈する際は、フィード内の `stale_at` を基準にしてください。
