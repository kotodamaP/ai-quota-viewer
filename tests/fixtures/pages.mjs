/**
 * 各サービスの usage 画面の構造を元に、数値・個人情報を合成化した innerText fixture。
 * ★ノイズ（ナビゲーション・履歴一覧など）も含めた実物に近い形で保持する。
 *   パーサがノイズ耐性を持つことを検証するため。
 *
 * ★個人識別情報（アカウント名・メールアドレス等）および利用額・残高・契約状況は
 *   すべて架空の合成値に置換済み。パーサの検証ロジックを担保しつつ安全性を確保している。
 */


export const CLAUDE_USAGE = `ホーム
Code
チャットとタスク
プロジェクト
最近の項目
要点のまとめ
Claude無料プランと有料プランの違い
すべて表示
デザイン
ラボ
A
テストユーザー
·
Max
テストユーザーさん、こんにちは
チャット
Cowork
設計担当 高
設定
一般
アカウント
プライバシー
請求
使用量
機能
Claude Code
プラン使用制限
Max (5x)
現在のセッション
2時間54分後にリセット
22% 使用済み
週間制限

Fable 5 は引き続き Max プランに含まれています。
使用クレジットの設定を求めるメッセージが表示された場合は、Claude Code を再起動してください。
使用制限について詳しく見る
すべてのモデル
15:59 (月)にリセット
10% 使用済み
Fable
16:00 (月)にリセット
5% 使用済み
最終更新: 3分前

使用クレジット
プランの上限に達した場合もClaudeを使い続けるために、利用クレジットを有効にしてください。詳細を見る
$42.00使用
Aug 1にリセット
80%使用
$100.00
月間利用上限
上限を調整
$58.00
現在の残高·
自動チャージ
オフ
利用クレジットを購入
最大30%オフ`;

export const GROK_USAGE = `サイドバーを切り替え
検索
新しいチャット
Imagine
自動化
プロジェクト
履歴
Gemini in Chrome
すべて表示
user@example.com
非公開
何を知りたいですか？
エキスパート
アカウント
外観
動作
データコントロール
請求情報
使用量
使用量
週間 SuperGrok 上限
使用済
2026年7月30日 6:11 にリセット
API
18%
チャット
6%
Imagine
3%
Grok Build
1%
追加使用クレジット
追加のクレジット
クレジットを購入
自動チャージ
クレジット残高が少なくなったら自動的にチャージします。
設定
AI_TRIO_GROK_TOTAL 28%
AI_TRIO_GROK_CREDIT_BALANCE $42.50`;

export const CURSOR_USAGE = `Back to Agents
テストユーザー
Ultra
Overview
Settings
Cloud Agents
Usage
Spending
Billing & Invoices
Jul 19 - Jul 25
1d
7d
30d
MTD
Last month

Total spend

$45.20

Included

$20.00

On-demand

$25.20

Your Usage
Your usage per day across this billing period
Group By: Model
Metric: Spend
Cumulative Spend
claude-fable-5-thinking-high
cursor-grok-4.5-high-fast
Export CSV
Date (UTC)
Type
Model
Tokens
Cost
Jul 24, 06:35 PM
On-Demand
claude-opus-5-thinking-high
40.9万
$1.00`;

/**
 * Cursor レイアウトB（プラン/上限ビュー）。検証済み仕様。
 * ★%枠と上限額の両方が出るのはこちら。
 */
export const CURSOR_PLAN = `Back to Agents
テストユーザー
Ultra
Overview
Settings
Usage
Spending
Billing & Invoices
CURRENT PLAN
Ultra
$200/mo
Usage limits reset on 8月4日 (11 days left)
Adjust Plan
Included in Ultra
Cursor Models · Includes Cursor Grok 4.5 and Composer 2.5
17% used
Additional usage beyond limits consumes Other Models quota or on-demand spend.
Other Models
100% used
Additional usage beyond limits consumes on-demand spend. Your plan includes at least $400 of API usage.
On-Demand Usage
On-Demand
$29.50 / $30
Usage past your limit is billed later as on-demand.
Monthly Limit
Set a fixed amount or make it unlimited.
Fixed
Save`;

/** 使用量セクションが見つからないケース（ログイン切れ相当） */
export const LOGGED_OUT = `Claude
ログイン
続行するにはログインしてください
Google で続行`;

/**
 * QwenCloud Token Plan Individual（Subscription ページ）。検証済み仕様。
 * ★「Remaining」は残量%なので used = 100 - remaining に変換する。
 * ★取引IDはプレースホルダ化（パーサは参照しない）。
 */
export const QWENCLOUD_SUBSCRIPTION = `Home
Try AI
Hot
Analytics
Usage
Logs
Billing
Pay-As-You-Go
Subscription
Model Production
API Keys
Settings
Account
Workspaces
Alerts
Collapse sidebar
Subscription Management
View subscription usage details and historical orders
View Docs
Manage API Key
Individual
Team
Individual Plan
Standard
Last updated 20:29:59
Status
Active
Auto-renew
Remaining days
17 days
Expiry date
2026-08-21 01:00:00
Every 5 Hours
Reset time 2026-08-04 00:32:00
Remaining
0.0%
Total
3,000
Every 7 Days
Reset time 2026-08-08 16:41:00
Remaining
59.9%
Total
10,000
Upgrade
Renew
Credit Pack
Updated 20:30:00
No Individual Credit Packs
Subscribe Credit Pack
Usage Details
By Day
Last 7 Days
07-28
07-29
07-30
07-31
08-01
08-02
08-03
0
10 M
20 M
30 M
Subscription History
All Transaction Types
All Payment Statuses
Last 30 Days
Clear Filters
Order ID	Subscription Name	Plan Name	Transaction Type	Paid At	Payment Status	Amount (excl. tax)	Tax	Amount (incl. tax)	Actions
000000000000000	Token Plan Individual	standard	Purchase	2026-07-20 23:13:55	Paid	$10.00	$1.00	$11.00	
Details
Download Invoice
Order Detail
Notification
Copy
This page is currently not available on mobile devices. Please copy the link below and open it on a desktop for the best experience.
0`;

/**
 * OpenCode Go /go ページ。検証済み仕様。
 * ★Go プランは 5時間/週/月 の3枠を % とリセットまでの残り時間で表示する。
 *   （残高・自動チャージは /billing 側の別ページ。ここには出ない）
 * ★メール・ワークスペースIDはプレースホルダ化。
 */
export const OPENCODE_GO = `Default
user@example.com
Zen
Go
利用
APIキー
メンバー
請求
設定
あなたは OpenCode Go を購読しています、
サブスクリプションの管理
Go モードを使用するには、opencode の設定で「OpenCode Go」をプロバイダーとして選択してください、詳しく見る
ローリング利用量
100%
リセットまで 1 時間 26 分
週間利用量
42%
リセットまで 6 日 11 時間
月間利用量
22%
リセットまで 30 日 3 時間
利用限度額に達したら利用可能な残高を使用する`;

/**
 * OpenCode Go /console/.../go ページ。2026-09-22 実測（新コンソールUI・英語）。
 * ★Rolling(0%), Weekly(27%), Monthly(96%)。0%のRolling枠にはリセット行が無い。
 * ★メールアドレス等はプレースホルダ化。
 */
export const OPENCODE_GO_V2 = `D
Default
A
user@example.com
Overview
Usage
Logs
Go
Leaderboard
Models
Providers
Members
Keys
Settings
Go-Subscription

Low cost coding models for everyone · Learn more

Renews in 12d 18h
Manage subscription
Connect OpenCode CLI

Sign in with the command for your version.

V2
opencode auth login opencode
Copy
V1
opencode console login
Copy

Then run /models and select an OpenCode Go model.

Rolling usage
0%

Weekly usage
27%

Resets in 5d 23h

Monthly usage
96%

Resets in 12d 18h

Providers

Control data training and model regions.

Manage privacy

One-time credits

Use your balance after reaching the limits.

Use credit

Loading available credit…

Buy credits`;

/**
 * OpenCode Go Billing ページ。検証済み仕様。
 * ★残高は「単独行の $X.XX」、支払い履歴の金額はタブ区切りの表行。
 * ★メール・支払いIDはプレースホルダ化。
 */
export const OPENCODE_BILLING = `Default
user@example.com
Zen
Go
利用
APIキー
メンバー
請求
設定
請求
支払い方法を管理します。 お問い合わせ ご質問がございましたら。
$0.00
現在の残高
残高を追加
Stripeと連携済み
管理
クーポンを利用
クーポンコードを利用して、クレジットや特典を受け取ります。
利用する
自動チャージ
自動チャージは 無効. です。残高が少なくなったときに自動的にチャージするには有効にしてください。
有効にする
月間上限
アカウントの月間使用制限を設定します。
-
設定
使用制限は設定されていません。
支払い履歴
最近の支払い取引。
日付	支払いID	金額	領収書
Aug 2, 4:28 PM	pay_XXXXXXXXXXXXXXXXXXXXXXXXXX	$10.00	表示
©2026 Anomaly
ブランド
プライバシー
利用規約
日本語`;

// 2026-08-05 22:04 実測（QwenCloudがラベルを変更した後の版）。
// 変更点: 「Every 5 Hours」→「5 Hours Usage Limit」、「Every 7 Days」→「7 Days Usage Limit」。
// 構造（Reset time / Remaining / Total）は従来と同じ。
export const QWENCLOUD_SUBSCRIPTION_V2 = `Home
Try AI
Hot
Analytics
Usage
Logs
Billing
Pay-As-You-Go
Subscription
Model Production
API Keys
Settings
Account
Workspaces
Alerts
Collapse sidebar
Subscription Management
View subscription usage details and historical orders
View Docs
Manage API Key
Individual
Team
Individual Plan
Standard
Last updated 22:04:38
Status
Active
Auto-renew
Remaining days
15 days
Expiry date
2026-08-21 01:00:00
5 Hours Usage Limit
Reset time 2026-08-06 03:04:00
Remaining
91.2%
Total
3,000
7 Days Usage Limit
Reset time 2026-08-08 16:41:00
Remaining
28.0%
Total
10,000

Reset Usage Limit 1 available

Upgrade
Renew
Credit Pack
Updated 22:04:38
No Individual Credit Packs
Subscribe Credit Pack
Usage Details
By Day
Last 7 Days
07-30
07-31
08-01
08-02
08-03
08-04
08-05
0
10 M
20 M
30 M`;

/**
 * Google AI Studio /rate-limit?timeRange=last-1-day の実測（2026-09-13 00:40 JST 取得）。
 *
 * ★これは body.innerText ではなく、取得層 GEMINI_TEXT_EXPRESSION が
 *   <tr> のセルから組み立てて返す JSON と同形。
 *   実ページの表（innerText では列の対応が失われるため JSON 化している）:
 *     ステータス ~ モデル            ~ カテゴリ         ~ RPM    ~ TPM         ~ RPD
 *     error      ~ Gemini 3.8 Flash  ~ テキスト出力モデル ~ 5 / 5  ~ 7.78K / 250K ~ 24 / 20
 *     check      ~ Gemini 3.6 Flash  ~ テキスト出力モデル ~ 2 / 5  ~ 5.7K / 250K  ~  9 / 20
 *     check      ~ Antigravity       ~ エージェント      ~ 0 / 60 ~ 0 / 100K     ~  0 / 100
 *   期間の終端はページの「データの期間は、…～2026年9月13日日曜日 0時00分00秒 UTC-8 です。」。
 *   ★この「UTC-8」表記は夏時間中ズレる（実際は PDT の壁時計）。日境界は実測で
 *     08:00 UTC = JST 17:00 固定と確定したため、パーサはページの文言を使わない。
 *   アカウント名・メールは取得層もパーサも参照しない。
 */
export const GEMINI_RATE_LIMIT = JSON.stringify({
  tier: "無料枠",
  project: "SampleProject",
  models: [
    { status: "error", name: "Gemini 3.8 Flash", category: "テキスト出力モデル", rpm: "5 / 5", tpm: "7.78K / 250K", rpd: "24 / 20" },
    { status: "check", name: "Gemini 3.6 Flash", category: "テキスト出力モデル", rpm: "2 / 5", tpm: "5.7K / 250K", rpd: "9 / 20" },
    { status: "check", name: "Antigravity", category: "エージェント", rpm: "0 / 60", tpm: "0 / 100K", rpd: "0 / 100" },
  ],
});

/** 展開後（さらに表示）に現れる Live API 行。上限が「無制限」の枠は作らない。 */
export const GEMINI_RATE_LIMIT_UNLIMITED = JSON.stringify({
  tier: "無料枠",
  project: "SampleProject",
  models: [
    { status: "check", name: "Gemini 3 Flash Live", category: "Live API", rpm: "0 / 無制限", tpm: "0 / 65K", rpd: "0 / 無制限" },
  ],
});

/**
 * Antigravity CLI（agy）の `/usage` 出力の実測（2026-09-13 サインイン直後）。
 * 取得は `agy -p "/usage" --output-format json`。num_turns:0 ＝ クォータを消費しない。
 * アカウント識別情報は含まれない。
 */
export const ANTIGRAVITY_USAGE = [
  "Loading extension: gemini-obsidian",
  JSON.stringify({
    conversation_id: "",
    status: "SUCCESS",
    response: "",
    duration_seconds: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    command: {
      name: "usage",
      data: {
        description:
          "Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens.",
        groups: [
          {
            name: "Gemini Models",
            description: "Models within this group: Gemini Flash, Gemini Pro",
            buckets: [
              { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-09-20T08:51:21Z" },
              { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-09-13T13:51:21Z" },
            ],
          },
          {
            name: "Claude and GPT models",
            description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
            buckets: [
              { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-09-20T08:51:21Z" },
              { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-09-13T13:51:21Z" },
            ],
          },
        ],
      },
    },
  }),
].join("\n");

/** 未サインイン時の実測（APIキー経路だった頃）。groups が空で返る。 */
export const ANTIGRAVITY_NOT_SIGNED_IN = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "",
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  command: { name: "usage", data: { groups: [] } },
});
