# AI Quota Viewer

各社 AI サービス（Claude / Codex / Grok / Cursor / OpenCode / QwenCloud / Google AI Studio Gemini / Antigravity CLI / RunPod）の利用枠・レート制限・クレジット残量を1画面で統合監視するローカルツールです。

集計データはお手元のローカル環境にのみ保存され、開発者や外部の収集基盤への独自テレメトリ・トラッキング送信は一切行いません。

---

## 主な特長

1. **ローカル保存・独自テレメトリなし**
   - 本ツール独自のクラウドサーバーや分析基盤への送信は存在しません。集計データはローカルの `data/` ディレクトリにのみ保存されます。
   - ダッシュボード（Web UI）は `127.0.0.1`（ループバック）に厳格にバインドされ、外部ネットワークには公開されません。
2. **2つの収集方式（ブラウザ管理 & ローカルCLI）**
   - **マネージドブラウザ方式（推奨）**: ツール専用の隔離プロファイル（`.chrome-profile/`）でバックグラウンドChrome（`--remote-debugging-address=127.0.0.1`）を起動し、安全に利用量画面を取得します。常用ブラウザの閲覧履歴やCookieには干渉しません。
   - **ローカルCLI方式**: Codex（公式 `codex app-server` またはローカルセッションログ）や Antigravity CLI（`agy -p "/usage"`）はブラウザを使わず直接読み取ります。
3. **安全設計のハードリミット**
   - 各社サービスへの過剰な負荷やBot検知を防止するため、収集間隔は **最短15分** にハードコードされています（設定ファイルで15分未満に指定しても自動的に15分に引き上げられます）。
4. **共通フィード（`quota-feed/1`）連携**
   - 集計結果を標準スキーマ（`schema/quota-feed.v1.schema.json`）に適合する JSON として出力（`data/feed/quota-feed.v1.json` および `GET http://127.0.0.1:7777/api/feed`）。デスクトップウィジェットや他アプリから同じ解釈で利用量を取得できます。

---

## 対応サービス

| サービス | 取得方式 | 取得内容 |
|---|---|---|
| **Codex** | 公式ローカル `codex app-server` / セッションログ | 週次残量%、リセット時刻、クレジット |
| **Claude** | マネージドブラウザ (claude.ai) | 5時間枠%、週次枠%、モデル別枠、クレジット残高・利用上限 |
| **Grok** | マネージドブラウザ (grok.com) | 週間共有枠%（内訳含む）、追加クレジット残高 |
| **Cursor** | マネージドブラウザ (cursor.com) | モデル別利用%、On-Demand消費額・上限 |
| **OpenCode** | マネージドブラウザ (opencode.ai) | 5時間/週/月枠の利用量% |
| **QwenCloud** | マネージドブラウザ (home.qwencloud.com) | 5時間枠%、7日枠%、リセット時刻 |
| **Gemini API** | マネージドブラウザ (aistudio.google.com) | モデル別実績 / 無料枠上限（RPM・TPM・RPD）、上限到達判定 |
| **Antigravity CLI** | ローカル `agy` CLI（OAuth） | グループ別残量%（Weekly / 5時間）、リセット時刻 |
| **RunPod** | マネージドブラウザ (console.runpod.io) | クレジット残高（USD/円）、時間あたり消費レート |

---

## 動作要件

- **OS**: Windows 10 / 11（推奨）または macOS / Linux（※ macOS / Linux では `cdp.chrome_path` の手動指定が必要な場合があります）
- **Node.js**: `>= 22.0.0`（標準テストランナー `node --test` を使用）
- **Google Chrome**: マネージドブラウザ収集を使用する場合に必要
- **外部依存パッケージ**: **なし（ゼロ依存）**。Node.js 標準ライブラリのみで動作します。


---

## クイックスタート

### 1. 初期設定

リポジトリをクローン後、設定サンプルのコピーを作成します：

```bash
cp config/settings.example.json config/settings.json
cp config/pricing.example.json config/pricing.json
```

`config/settings.json` で監視したいサービスを `true` に設定してください。

### 2. 収集用ブラウザの初回ログイン

```bash
node src/index.mjs login
```

収集専用プロファイルのChromeウィンドウが画面上に開きます。
監視対象の各サービス（Claude、Grok 等）に手動で一度だけログインし、利用量画面が表示される状態まで進めてください。
完了したらブラウザウィンドウを閉じて構いません（セッションは `.chrome-profile/` に保持されます）。

> [!IMPORTANT]
> **認証情報の取り扱いに関する重要事項**:
> 本ツールは独自の形式でID、パスワード、APIキーを保存しません。
> ただし、マネージドブラウザ方式の場合、Chrome の隔離プロファイル（`.chrome-profile/`）内にブラウザ自身のセッション情報（Cookie・アクセストークン等）が保存されます。
> `.chrome-profile/` は機密ディレクトリとして扱い、Git への追加や外部共有・バックアップを避けてください（`.gitignore` にて除外設定済みです）。

### 3. 利用量の収集

```bash
# 1回だけ全社収集してコンソールに表示
node src/index.mjs collect

# 特定のサービスだけ収集
node src/index.mjs collect --service claude
```

### 4. ダッシュボードの起動

```bash
node src/index.mjs serve
```

ブラウザで `http://127.0.0.1:7777` を開くと、全サービスのメーターや残高、月額費用が一覧表示されます。

### 5. 常駐監視（バックグラウンド実行）

```bash
node src/index.mjs watch
```

設定された間隔（既定15分）で定期的にバックグラウンド収集を行います。ダッシュボードサーバーも同居して起動します。

---

## 外部通信（アウトバウンド通信）に関する透明性

本ツールは以下の外部通信を行います。これら以外の独自サーバーや分析トラッカーへの通信は一切ありません：

1. **各社利用量ページ**:
   `collect` / `watch` では設定ファイルで有効化（`true`）したサービスにのみアクセスします。初回セットアップの `login` は手動ログイン用に対応ブラウザサービスのページを開きます。

2. **為替レート取得 API**:
   - `https://open.er-api.com`（一次取得）
   - `https://api.frankfurter.app` / `https://api.frankfurter.dev`（フォールバック）
   為替レートの自動更新が有効な場合、USD/JPY レート取得のために定期的に問い合わせます。
3. **Webフォント CDN**:
   - `fonts.googleapis.com` / `fonts.gstatic.com`（Google Fonts）
   - `cdn.jsdelivr.net`（jsDelivr）
   ダッシュボード（Web UI）のフォント描画のためにブラウザから読み込まれます。
4. **Xシャドウバンチェック（任意機能・既定では無効）**:
   - `https://api.ipify.org`（接続元グローバルIPの取得）
   - `https://xsearchbancheckerapi.fia-s.com` / `https://x-shadowban-checker.fia-s.com`（Shadowban判定）
   ※設定ファイルで `shadowban.enabled: true` とした場合、または `node src/index.mjs shadowban` を明示的に実行した場合のみ、指定されたアカウント名とIPアドレスを用いて状態確認を行います。

---

## セキュリティ設計

- **ループバック固定**: Web UI および内部APIは `127.0.0.1` に厳格にバインドされ、`0.0.0.0` や外部IPによる開放を拒否します。
- **CSRF / Origin 防御**: ダッシュボードの操作API（`/api/refresh`, `/api/settings`）はループバックオリジン検査（localhost / 127.0.0.1）を行い、悪意ある外部WebサイトやDNSリバインディングからのリクエストを遮断します。
- **設定キーのホワイトリスト化**: UI経由で変更可能な設定項目は表示・間隔設定に限定され、実行パス等の改変を防止します。

---

## テストの実行

```bash
npm test
# または
node --test
```

全117件の単体テスト（合成データによるパース検証・境界値検証・セキュリティ検証）が外部通信なしで高速に実行されます。


---

## ライセンス

本プロジェクトは [MIT License](LICENSE) のもとで公開されています。
