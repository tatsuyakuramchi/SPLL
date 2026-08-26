# SPLL Public Web移行設計・修正計画 / CloudSign FORM設定設計 v1.1

- 文書名: SPLL Public Web移行設計・修正計画 / CloudSign FORM設定設計
- 対象リポジトリ: `tatsuyakuramchi/SPLL`
- 対象ブランチ: `claude/new-design-implementation-wlqwv9`
- 作成日: 2026-08-26
- 更新日: 2026-08-26（v1.1：用語定義 §0.0、現行GASでの実装状況 §32 を追記）
- 目的:
  1. 一般公開部分のアクセス集中耐性をGASから切り離す
  2. 社内の作品・契約・審査管理はGoogle Spreadsheet中心の運用を維持する
  3. Cloud Runから将来一般的なLinux/VPS/Webサーバーへ移植できる構造にする
  4. CloudSign FORM powered by formrunを正式な申込受付として維持する
  5. 作品提出・認証QR取得・QR検証を移植可能なPublic Webに統合する
  6. 本書だけを見ながらCloudSign FORM / formrun側のフォーム設定ができる粒度まで落とす

---

## 0.0 用語

本書および実装（画面文言・コード内コメント）で使う呼称を次に統一する。

| 呼称 | 指すもの | 例 |
|---|---|---|
| **クリエーター** | SPLLへ利用許諾を申請し、二次創作物を制作・頒布する側 | 申込ポータルの入力者、CloudSignの署名者、作品の提出者、認証バッジの掲載者 |
| **ユーザー** | 社内で実際に業務を担当する側 | 管理コンソールのログインユーザー、審査担当、契約担当、事務局運営の構成員 |

従来「利用者」と書いていた箇所はすべて**クリエーター**を指すため、実装の文言を置換済み。
「ユーザー」は社内担当者のみを指す語とし、クリエーターの意味では使わない。

なお契約書・法務文書では、契約当事者を示す法律上の呼称（甲・乙・契約者）をそのまま用いる。

---

## 0. 結論

SPLLは全面的にGASから移行しない。

**利用者向けの高トラフィック部分だけを、移植可能なDocker Webアプリへ切り出す。**

一方で、社内担当者が操作する業務管理は、引き続きGoogle Spreadsheetを主画面とする。

```text
                         ┌────────────────────────┐
                         │      一般利用者         │
                         └──────────┬─────────────┘
                                    │
                                    ▼
                        独自ドメイン（固定）
                   例: https://spll.example.jp
                                    │
                                    ▼
                 ┌────────────────────────────────┐
                 │ Public Web / API                │
                 │ Docker化・クラウド非依存         │
                 │                                │
                 │ ・原作検索/申込前確認            │
                 │ ・作品提出ページ                 │
                 │ ・認証QR取得ページ               │
                 │ ・QR検証ページ                  │
                 │ ・Webhook受信                   │
                 └──────┬─────────┬──────────────┘
                        │         │
             申込前導線 │         │ Webhook
                        ▼         ▼
             ┌────────────────┐  ┌────────────────┐
             │ CloudSign FORM │  │ System Queue   │
             │ powered by     │  │ / PostgreSQL   │
             │ formrun        │  │ Inbox          │
             └───────┬────────┘  └───────┬────────┘
                     │                    │
                     ▼                    ▼
                CloudSign              Worker
                     │                    │
                     │                    ├─ Sheets更新
                     │                    ├─ Drive操作
                     │                    ├─ AI審査
                     │                    └─ 各種同期
                     ▼
                Webhook
                                          │
             ┌────────────────────────────┼────────────┐
             ▼                            ▼            ▼
      Google Spreadsheet             Google Drive   Gemini等
      ＝社内業務の主画面              ＝作品原本
```

### インフラの考え方

当面:

```text
Docker → Cloud Run
PostgreSQL → Cloud SQL for PostgreSQL
```

将来:

```text
同じDocker → Ubuntu VPS / 一般Webサーバー
PostgreSQL → 一般PostgreSQL
Nginx → Docker
```

アプリケーション側でCloud Run固有APIを直接使用しない。

---

# 1. 設計原則

## 1.1 Spreadsheetを業務の中心に残す

次の情報は引き続きSpreadsheetを業務上の正本・主画面とする。

- 原作マスタ
- SPLL番号・案件管理
- 申込管理
- 契約管理
- 作品管理
- 作品提出版管理
- AI審査結果
- 人手審査結果
- 認証状態
- QR/バッジ発行状態
- 通知・要対応
- 監査イベント
- 経理引渡情報

担当者にPostgreSQLやCloud Runの管理画面を操作させない。

PostgreSQLはあくまで以下のための**システム内部ストレージ**とする。

- 高アクセス公開データのキャッシュ
- Webhookの耐障害受信箱
- 非同期ジョブ
- 冪等性管理
- Public Webのセッション/短期トークン
- Sheetsへの書込待ち

したがって、社内運用上は以下の理解でよい。

```text
Google Sheets = 人が使う業務台帳
PostgreSQL    = システムが使う耐障害バッファ・公開用投影
```

---

## 1.2 CloudSign FORMを正式な申込受付として維持する

SPLLポータルは「申込前の条件選択」であり、正式な申込受付・契約者情報入力はCloudSign FORMとする。

```text
SPLL Public Web
  原作選択
  利用区分選択
  利用条件確認
       ↓
CloudSign FORM powered by formrun
  氏名
  住所
  メール
  成年確認
       ↓
CloudSign
  完成した利用許諾契約書を確認
       ↓
利用者がCloudSign上で同意
       ↓
契約成立
```

契約成立点はCloudSign上の同意完了時とする。

SPLLポータル・formrun完了画面では「契約成立」と表示しない。

---

## 1.3 QRにインフラ固有URLを入れない

QRコードには以下を絶対に埋め込まない。

- `*.run.app`
- `script.google.com/macros/...`
- VPSのIPアドレス
- 特定クラウド事業者のURL

QRは必ず自社管理の独自ドメインを利用する。

例:

```text
https://spll.example.jp/v/CERT-xxxx
```

これにより、

```text
2026年: DNS → Cloud Run
2028年: DNS → VPS/Nginx
```

と変更しても過去発行済みQRはそのまま利用できる。

---

# 2. 対象機能の配置

| 機能 | 現行 | 目標 |
|---|---|---|
| 公開トップ | GAS HtmlService | Public Web |
| 原作検索 | GAS + Sheets | Public Web + public projection |
| 利用条件計算 | GAS | Public Web |
| 申込前確認 | GAS | Public Web |
| 正式申込 | CloudSign FORM | **変更なし** |
| 契約同意 | CloudSign | **変更なし** |
| formrun Webhook | GAS | Public Web Receiver |
| CloudSign Webhook | GAS | Public Web Receiver |
| Webhook再試行 | GAS batch | Worker |
| 原作マスタ | Sheets | **変更なし** |
| 作品管理 | Sheets | **変更なし** |
| 審査管理 | GAS Admin | Sheets中心 + GAS操作 |
| 作品ファイル | Drive | **変更なし** |
| 作品提出ページ | GAS | Public Web |
| QR取得ページ | GAS相当 | Public Web |
| QR検証 | GAS | Public Web |
| QR/バッジ生成 | GAS | GASまたはWorker |
| 認証ON/OFF | GAS Admin | Sheets + GAS確定操作 |
| AI審査 | GAS | Workerへ段階移行可 |

---

# 3. Public Webの構造

## 3.1 技術構成

特定クラウドに依存しない構成とする。

推奨:

```text
Node.js
Express または Fastify
TypeScript
Docker
PostgreSQL
```

Next.jsを利用してもよいが、Cloud Run専用機能・Vercel専用機能には依存しない。

### ディレクトリ案

```text
apps/
  public-web/
    src/
      routes/
      services/
      adapters/
      views/
  worker/
    src/
packages/
  domain/
  sheets-adapter/
  drive-adapter/
  cloudsign-adapter/
  formrun-adapter/
  queue/
```

---

## 3.2 Public WebのURL設計

```text
GET  /
GET  /works
GET  /works/:workId

GET  /apply
POST /api/applications/prepare

GET  /submission/:token
POST /api/submissions/:token/open-folder
POST /api/submissions/:token/finalize

GET  /certificate/:token
GET  /v/:certificateId

POST /webhooks/formrun
POST /webhooks/cloudsign

GET  /health
```

### QR

QRには次のみを入れる。

```text
https://spll.example.jp/v/{certificate_id}?c={verification_code}
```

または、照合コードをURLへ直接露出しない場合:

```text
https://spll.example.jp/v/{opaque_token}
```

後者を推奨する。

---

# 4. データ設計

## 4.1 Sheetsが正本

現行の主要Sheetsは維持する。

例:

```text
Works_Master
License_Cases
Applications
Application_Works
Contracts
Submissions
Submission_Versions
Submission_Files
AI_Review_Jobs
AI_Findings
Human_Reviews
Certificates
Badges
Notification_Queue
Webhook_Receipts
Events
```

## 4.2 PostgreSQLは業務正本にしない

最低限以下のみ保持する。

```text
public_works_projection
public_certificate_projection
webhook_inbox
jobs
idempotency_keys
public_tokens
sync_state
```

### public_works_projection

公開サイトで検索する原作情報だけを同期する。

### public_certificate_projection

QR検証に必要な最小情報だけを同期する。

- certificate_id
- license_id
- status
- work label
- issued_at
- updated_at
- public display flags

個人情報は原則入れない。

---

# 5. Sheets同期設計

## 5.1 原作マスタ

```text
Works_Master
   ↓
定期同期（1～5分）
   ↓
public_works_projection
   ↓
Public Web
```

一般アクセスのたびにSpreadsheetを読まない。

## 5.2 認証状態

認証状態の変更は重要なので、単なるセル直接変更ではなくGASメニュー/ボタンから確定する。

```text
Spreadsheet
  「認証をオフ」
        ↓
Apps Script
        ↓
Public API
        ↓
public_certificate_projection 即時更新
        ↓
Sheetsも状態確定
```

QR検証画面への反映を即時にする。

---

# 6. CloudSign FORM設計

## 6.1 作成するフォーム

本番標準経路では**2フォーム**を作成する。

### FORM-A: STANDARD_FIXED

対象:

- 定額
- 1件あたり定額
- 固定利用料

Config:

```text
FORM_URL_STANDARD_FIXED
```

### FORM-B: STANDARD_RATE

対象:

- 売上連動
- ロイヤリティ率
- RATE型

Config:

```text
FORM_URL_STANDARD_RATE
```

### MANUAL_REVIEW

標準CloudSign FORMへ自動送信しない。

対象:

- 未成年
- 海外居住
- イベント利用
- その他
- 特約あり
- 原作数超過
- 長文条件
- URL引継ぎ上限超過
- 条件不一致

`FORM_URL_MANUAL_REVIEW` は当面空欄でもよい。

法人は標準FORMを使用しない。

---

# 7. CloudSign FORM ユーザー入力項目

両標準フォームで同じ項目を作る。

| # | canonical key | 表示名 | 必須 | 備考 |
|---:|---|---|:---:|---|
| 1 | `party_name` | 氏名 | ○ | 契約当事者 |
| 2 | `circle_name` | 屋号・サークル名 |  | 任意 |
| 3 | `postal_code` | 郵便番号 | ○ | 住所補助 |
| 4 | `party_address` | 住所 | ○ | 契約当事者特定 |
| 5 | `email` | メールアドレス | ○ | CloudSign送信先 |
| 6 | `adult_confirmed` | 成年確認 | ○ | 利用者自身がチェック |

### 成年確認文

推奨:

```text
私は18歳以上です。
```

「規約に同意する」項目は初期値設定できないため、成年確認は必ず利用者自身に操作させる。

### FORM上で取得しないもの

- 原作名の再入力
- 利用区分の再入力
- 利用料の再入力
- 料率の再入力
- 支払条件の再入力
- クレジット表記の再入力
- 契約本文への重複同意
- 反社条項の個別チェック
- 権利非侵害保証の個別チェック
- 電話番号
- フリガナ
- 適格請求書番号
- 制作物名
- 予定販売数
- 予定価格

---

# 8. CloudSign FORM hidden項目

## 8.1 現行実装で定義されている項目

現行 `28_contract_form_v4_shared.gs` は次をシステム確定値として生成している。

```text
contract_template_version
license_id
application_ref
usage_category
work_count
work_names
work_id_1 ～ work_id_5
work_title_1 ～ work_title_5
licensor_name
license_term
territory
fee_model
fee_value
fee_amount_or_rate
licensed_uses
payment_terms
reporting_terms
credit_text
special_terms
```

加えて、

```text
handoff_token
terms_snapshot_hash
template_route
```

を引き渡している。

---

# 9. 【重要】現行URL引継ぎ方式の修正

## 9.1 問題

現行 `portal_contract_v4_patch.html` の `buildFormUrl()` は、`form_fields` の全項目をURLクエリへ追加する。

一方、formrun公式仕様では、初期値を付与する公開フォームURLは**1000文字以内**でなければならない。

日本語はURLエンコードにより大きく膨らむ。

例:

```text
クレジット表記 100文字
```

でもURL上では数百～900文字程度になり得る。

そのため、

- `credit_text`
- `special_terms`
- `reporting_terms`
- `work_names`

などを含めて全項目をURLに載せる現行方式は本番では危険。

## 9.2 必須修正方針

**FORMに渡す項目と、SPLL内部で保持する項目を分離する。**

### 内部スナップショット

全条件をSPLL側で保持し、

```text
terms_snapshot_hash
```

は全条件から生成する。

### FORM転送項目

CloudSign契約書に実際に差し込む最小項目だけを渡す。

推奨:

```text
license_id
application_ref
handoff_token
terms_snapshot_hash
work_names
licensor_name
usage_category
fee_amount_or_rate
credit_text
```

原則として次は標準テンプレートへ固定文言として組み込み、URLでは渡さない。

```text
license_term
territory
licensed_uses
payment_terms
reporting_terms
```

ただし利用区分によって文言が変わる場合は、テンプレートを分けるか、短いコード値で渡す。

### URL長チェック

Public Webで最終URLを生成した時点で、

```text
850文字を超えたら自動標準経路を停止
```

を推奨する。

```text
if generated_form_url.length > 850:
    route = MANUAL_REVIEW
```

1000文字ギリギリを使用しない。

---

# 10. 改変検知の修正版

現行はWebhookで全個別条件を再ハッシュしている。

コンパクト引継ぎ後は次の方式に変更する。

```text
SPLL側
  全契約条件を生成
       ↓
  full terms_snapshot_hash
       ↓
  HMAC handoff_token
       ↓
FORMへ必要最小項目だけ引渡
```

FormRun Webhook受信時:

1. `application_ref` を照合
2. `license_id` を照合
3. `terms_snapshot_hash` を照合
4. `handoff_token` を検証
5. SPLL側の正本スナップショットを再取得
6. FORMへ送った表示項目を正本と比較
7. 不一致なら `MANUAL_REVIEW`

これにより、内部用の `work_id_1..5` 等をURLに積む必要がなくなる。

---

# 11. CloudSign契約書テンプレート

## 11.1 STANDARD_FIXED用

CloudSign側で固定利用料型テンプレートを1つ作る。

個別差込欄:

| 契約書欄 | FormRun項目 |
|---|---|
| SPLL番号 | `license_id` |
| 利用者氏名 | `party_name` |
| 屋号・サークル名 | `circle_name` |
| 住所 | `party_address` |
| メール | `email` |
| 対象原作 | `work_names` |
| ライセンサー | `licensor_name` |
| 利用区分 | `usage_category` |
| 利用許諾料 | `fee_amount_or_rate` |
| クレジット | `credit_text` |

固定テンプレート側へ入れるもの:

- 許諾期間
- 地域
- 固定利用料の支払ロジック
- 標準報告条件
- 共通条項

## 11.2 STANDARD_RATE用

差込欄は原則同じ。

固定テンプレート側で以下を売上連動用に変更する。

- ロイヤリティ算定
- 売上報告
- 支払期限
- 報告頻度
- 対象売上の定義

---

# 12. CloudSign FORM作成手順

CloudSign公式の説明では、CloudSign FORM powered by formrunは大きく次の2段階で設定する。

1. formrunとCloudSignアカウントを連携
2. formrunフォームとCloudSignテンプレートを連携

以下はSPLL用の具体化。

---

## 12.1 STEP 1: CloudSign側でテンプレートを作る

### 固定型

テンプレート名例:

```text
SPLL_利用許諾契約_STANDARD_FIXED_v4.1
```

### 売上連動型

```text
SPLL_利用許諾契約_STANDARD_RATE_v4.1
```

### 契約書上の受信者入力欄

原則不要。

- 押印欄: 不要
- 署名欄: 不要
- フリーテキスト: 原則不要
- チェックボックス: 原則不要

契約書自体を完成状態にし、CloudSign上で「同意」させる。

---

## 12.2 STEP 2: formrunでSTANDARD_FIXEDフォームを作る

フォーム名:

```text
SPLL 利用許諾申込（定額）
```

作成項目:

```text
氏名
屋号・サークル名
郵便番号
住所
メールアドレス
成年確認
```

次にhiddenテキスト項目を作成する。

最低限:

```text
license_id
application_ref
handoff_token
terms_snapshot_hash
work_names
licensor_name
usage_category
fee_amount_or_rate
credit_text
```

### 実際の項目IDを記録する

formrunの

```text
データ管理設定
  ↓
データ項目管理
```

で各項目の実ID（例 `_field_12`）を確認する。

次の表を埋める。

| canonical key | FormRun実フィールドID |
|---|---|
| `party_name` | `[記入]` |
| `circle_name` | `[記入]` |
| `postal_code` | `[記入]` |
| `party_address` | `[記入]` |
| `email` | `[記入]` |
| `adult_confirmed` | `[記入]` |
| `license_id` | `[記入]` |
| `application_ref` | `[記入]` |
| `handoff_token` | `[記入]` |
| `terms_snapshot_hash` | `[記入]` |
| `work_names` | `[記入]` |
| `licensor_name` | `[記入]` |
| `usage_category` | `[記入]` |
| `fee_amount_or_rate` | `[記入]` |
| `credit_text` | `[記入]` |

---

## 12.3 STEP 3: STANDARD_RATEフォームを複製

STANDARD_FIXEDを複製し、

```text
SPLL 利用許諾申込（売上連動）
```

とする。

入力項目・hidden項目の構造は同じにする。

**注意:** 複製後に `_field_N` が同一か必ず確認すること。

異なる場合はフォーム別のマッピングを持つ必要がある。

可能であれば両フォームのデータ項目ID構造を揃える。

---

## 12.4 STEP 4: CloudSign連携

formrun側でCloudSign連携を有効化する。

### STANDARD_FIXED

```text
formrun:
SPLL 利用許諾申込（定額）
     ↓
CloudSign template:
SPLL_利用許諾契約_STANDARD_FIXED_v4.1
```

### STANDARD_RATE

```text
formrun:
SPLL 利用許諾申込（売上連動）
     ↓
CloudSign template:
SPLL_利用許諾契約_STANDARD_RATE_v4.1
```

---

## 12.5 STEP 5: CloudSign送付先設定

CloudSign受信者:

```text
氏名  ← party_name
Email ← email
```

屋号は送信先識別には使用しない。

---

## 12.6 STEP 6: 契約書差込設定

### FORM-A

| CloudSignテンプレート欄 | formrun項目 |
|---|---|
| SPLL番号 | license_id |
| 氏名 | party_name |
| 屋号 | circle_name |
| 住所 | party_address |
| Email | email |
| 対象原作 | work_names |
| ライセンサー | licensor_name |
| 利用区分 | usage_category |
| 利用許諾料 | fee_amount_or_rate |
| クレジット | credit_text |

FORM-Bも同様。

---

# 13. formrun側の推奨設定

## 13.1 初期値

hidden値はURLパラメータで初期値設定する。

例:

```text
https://form.run/@xxxxx?_field_12=SPLL-xxx&_field_13=REF-xxx
```

## 13.2 入力途中保存

**OFFを推奨。**

formrun公式仕様上、EFOの入力途中保存がONの場合、URLから渡した初期値より保存済み入力データが優先される場合がある。

SPLLのhidden引継ぎとの相性が悪い。

## 13.3 回答確認画面

hidden値が正常に引き継がれているか、テスト時に回答データで確認する。

## 13.4 完了メッセージ

推奨文:

```text
お申込み情報を受け付けました。

この時点では契約はまだ成立していません。
ご入力いただいたメールアドレス宛にCloudSignから契約書が送付されます。
契約書の内容をご確認のうえ、CloudSign上で同意手続きを完了してください。
```

「契約が完了しました」「許諾が完了しました」と表示しない。

---

# 14. FORM_HIDDEN_MAP設定

Public Web側では

```text
canonical key → FormRun実フィールドID
```

を持つ。

例:

```json
{
  "license_id": "_field_12",
  "application_ref": "_field_13",
  "handoff_token": "_field_14",
  "terms_snapshot_hash": "_field_15",
  "work_names": "_field_16",
  "licensor_name": "_field_17",
  "usage_category": "_field_18",
  "fee_amount_or_rate": "_field_19",
  "credit_text": "_field_20"
}
```

実IDへ置換する。

### フォーム別にIDが異なる場合

```json
{
  "STANDARD_FIXED": {
    "license_id": "_field_12"
  },
  "STANDARD_RATE": {
    "license_id": "_field_31"
  }
}
```

というルート別設定へ変更する。

---

# 15. FORMRUN_FIELD_MAP設定

Webhook受信側では逆引きする。

```text
FormRun実フィールドID → canonical key
```

例:

```json
{
  "_field_1": "party_name",
  "_field_2": "circle_name",
  "_field_3": "postal_code",
  "_field_4": "party_address",
  "_field_5": "email",
  "_field_6": "adult_confirmed",

  "_field_12": "license_id",
  "_field_13": "application_ref",
  "_field_14": "handoff_token",
  "_field_15": "terms_snapshot_hash",
  "_field_16": "work_names",
  "_field_17": "licensor_name",
  "_field_18": "usage_category",
  "_field_19": "fee_amount_or_rate",
  "_field_20": "credit_text"
}
```

---

# 16. FormRun Webhook設計

現行GASはFormRun Webhookを受けているが、移行後はPublic Webで受信する。

```text
POST https://spll.example.jp/webhooks/formrun
```

### 処理

```text
formrun
  ↓
Public Web
  ↓
webhook_inboxへINSERT
  ↓
即時2xx
  ↓
Worker
  ↓
改変検知
  ↓
Sheets反映
```

Webhook受信時に直接Sheetsへ大量書込しない。

### セキュリティ

formrun Webhookがカスタムヘッダーを使用できる環境では、共有秘密をカスタムヘッダーに設定する。

例:

```text
X-SPLL-Webhook-Secret: <secret>
```

Public Webで一致確認する。

### 冪等性

```text
provider
external_event_id
payload_hash
```

の組合せで重複排除する。

---

# 17. CloudSign Webhook設計

CloudSign Webhook:

```text
POST https://spll.example.jp/webhooks/cloudsign
```

CloudSign管理画面:

```text
Web API設定
  ↓
Webhook追加
```

通知条件:

- 締結完了
- 取り消し・却下
- メール不達

を必要に応じて設定する。

受信後はFormRunと同様に、

```text
受信保存
↓
即2xx
↓
Worker
↓
CloudSign API再照会
↓
真正性確認
↓
Sheets更新
```

とする。

CloudSign Webhook payloadだけを根拠に契約成立処理を完了させず、CloudSign API照会で締結状態を確認する現行方針は維持する。

---

# 18. 作品提出ページ

## 18.1 URL

```text
https://spll.example.jp/submission/{opaque_token}
```

## 18.2 表示内容

- SPLL番号
- 対象原作
- 作品名
- 最新版
- 過去の版
- 現在の審査状態
- 修正依頼内容
- 提出可能期限
- 提出可能回数

## 18.3 通常ファイル

PDF / PNG / JPEG等。

ただしPublic Webサーバー経由で大容量ファイルを保持しない。

## 18.4 大容量

現行設計のGoogle Drive専用フォルダ方式を維持できる。

```text
Public Web
  ↓
提出用Driveフォルダ作成
  ↓
利用者がDriveへ直接投入
  ↓
Public Webで「提出確定」
  ↓
Worker / GAS
  ↓
Sheets登録
```

ファイル本体がCloud Runを通らないため、将来VPSへ移しても構造を変える必要がない。

---

# 19. 作品審査

社内担当者の主画面はSpreadsheetとする。

例:

| SPLL番号 | 作品名 | Version | AI | 人手審査 | 修正依頼 | Drive |
|---|---|---:|---|---|---|---|
| SPLL-001 | 作品A | 2 | REVIEW | 審査待ち |  | 開く |
| SPLL-002 | 作品B | 1 | PASS | CLEARED |  | 開く |

操作はセル直接編集ではなく、GASメニューまたはボタンを推奨する。

```text
SPLL管理
  ├─ 選択行を審査完了
  ├─ 修正依頼
  ├─ 上申
  ├─ 提出リンク再発行
  └─ Driveを開く
```

---

# 20. QR / 認証設計

## 20.1 QRの意味

QRは「作品の法的適法性を保証するもの」や「作品内容を全面承認したもの」としない。

表示上は、

```text
SPLLライセンス認証
```

とする。

作品審査結果と認証状態は別概念として扱う。

### 認証状態例

```text
ACTIVE
SUSPENDED
REVOKED
EXPIRED
```

### 作品審査状態例

```text
SUBMITTED
HUMAN_REVIEW_PENDING
CLEARED
CORRECTION_REQUIRED
ESCALATED
```

---

## 20.2 QR発行トリガー

現行の料金モデル等との関係を踏まえ、発行トリガーは設定化する。

例:

```text
ON_SIGNING
ON_PAYMENT
ON_REVIEW_CLEAR
```

ただし「審査通過＝作品の適法性保証」と誤認させないため、QRをSPLLライセンス認証として利用する場合は、契約・入金条件を主トリガーとする方が整理しやすい。

---

## 20.3 利用者向け取得ページ

```text
GET /certificate/{token}
```

表示:

```text
SPLL番号
作品名
対象原作
認証状態
発行日

[認証バッジを表示]
[PNGを取得]
```

QR自体は独自ドメインの検証ページへ向ける。

---

## 20.4 検証ページ

```text
GET /v/{opaque_token}
```

公開情報は最小化する。

例:

```text
SPLL番号
対象原作
認証状態
発行日
```

個人名・住所・メール等は表示しない。

---

# 21. 現行コードの修正対象

## 21.1 Public Portal

現行:

```text
spll_src/index.html
apps/portal/entry.gs
portal_contract_v4_patch.html
```

対応:

- HTML/CSS/JSをPublic Webへ移植
- `google.script.run` をHTTP APIへ置換
- `buildFormUrl()` をコンパクト引継ぎへ修正
- FORM URL長チェックを追加

---

## 21.2 CloudSign FORM

現行:

```text
28_contract_form_v4_shared.gs
29_contract_form_v4.gs
36_formrun_contract_v4.gs
```

対応:

- full snapshotとFORM transfer fieldsを分離
- 全HASH_KEYSをURLへ送る設計を廃止
- Webhookで正本条件と転送項目を比較
- Route別FormRun field map対応
- URL長超過時MANUAL_REVIEW

---

## 21.3 Webhook

現行:

```text
35_webhooks.gs
```

対応:

- `receiveWebhook_()` のHTTP受信をPublic Webへ移す
- 受信時はPostgreSQL inboxへ保存して即応答
- 業務処理をWorkerへ移す
- GAS側は後方互換期間のみ残す

---

## 21.4 作品提出

現行:

```text
40_public_pages.gs
42_large_submission.gs
upload.html
```

対応:

- UIをPublic Webへ移す
- Drive管理ロジックはadapter化
- Sheets更新はWorker経由
- 提出tokenはopaque token化

---

## 21.5 QR / Badge

現行:

```text
Certificates
Badges
issueBadge_
admin_issueBadge
admin_rotateCertCode
```

対応:

- QR URL生成を独自ドメイン固定へ変更
- `ScriptApp.getService().getUrl()` 依存を廃止
- `PUBLIC_BASE_URL` 設定を使用
- 取得ページ/検証ページをPublic Webへ移す
- Badge PNG生成は当面GAS継続可

---

# 22. 新規設定値

環境変数/設定として以下を用意する。

```text
PUBLIC_BASE_URL
DATABASE_URL

GOOGLE_SHEETS_MASTER_ID
GOOGLE_SHEETS_OPS_ID
GOOGLE_DRIVE_ROOT_ID

CLOUDSIGN_CLIENT_ID
CLOUDSIGN_SECRET

FORM_URL_STANDARD_FIXED
FORM_URL_STANDARD_RATE

FORM_HIDDEN_MAP_FIXED
FORM_HIDDEN_MAP_RATE
FORMRUN_FIELD_MAP_FIXED
FORMRUN_FIELD_MAP_RATE

FORMRUN_WEBHOOK_SECRET
CLOUDSIGN_WEBHOOK_SECRET

HANDOFF_SECRET
```

秘密値はGitHubへコミットしない。

---

# 23. 段階的移行計画

## Phase 0: CloudSign FORMの実設定

まずCloudSign FORMを完成させる。

- [ ] STANDARD_FIXEDテンプレート作成
- [ ] STANDARD_RATEテンプレート作成
- [ ] STANDARD_FIXED formrun作成
- [ ] STANDARD_RATE formrun作成
- [ ] ユーザー入力6項目設定
- [ ] hidden項目設定
- [ ] 実 `_field_N` を記録
- [ ] CloudSign送付先マッピング
- [ ] 契約書差込マッピング
- [ ] EFO入力途中保存OFF
- [ ] 完了文設定
- [ ] テスト回答

## Phase 1: 現行GASのFORM引継ぎ修正

Cloud Run移行前に先に行う。

- [ ] URL転送項目を最小化
- [ ] full hashとtransfer fieldsを分離
- [ ] 850文字ガード追加
- [ ] route別 field map対応
- [ ] 改変検知修正
- [ ] STANDARD_FIXED / RATE実URL登録

このPhaseで現在のGASポータルのままCloudSign FORM設定を本番検証できる。

## Phase 2: Public Web作成

- [ ] Portal移植
- [ ] 独自ドメイン設定
- [ ] Works projection
- [ ] CloudSign FORM遷移
- [ ] Docker化
- [ ] Cloud Runデプロイ

## Phase 3: Webhook移行

- [ ] PostgreSQL `webhook_inbox`
- [ ] FormRun receiver
- [ ] CloudSign receiver
- [ ] Worker
- [ ] 冪等処理
- [ ] 再試行
- [ ] CloudSign Webhook送信先切替

## Phase 4: 作品提出ページ移行

- [ ] submission token
- [ ] upload page
- [ ] Drive folder open/finalize
- [ ] Sheets同期
- [ ] 再提出/版管理
- [ ] AI審査キュー

## Phase 5: QR取得/検証ページ移行

- [ ] 独自ドメインQR
- [ ] certificate page
- [ ] verify page
- [ ] QR再発行
- [ ] 旧QR失効
- [ ] Sheetsの認証操作と即時同期

## Phase 6: GAS公開ページ停止

残すもの:

```text
Spreadsheet automation
Drive helper
Badge generation
Admin menu
internal batches（必要なもの）
```

停止するもの:

```text
GAS public portal
GAS upload public UI
GAS verify public UI
GAS public webhook receiver
```

---

# 24. テスト計画

## 24.1 CloudSign FORM

- [ ] FIXEDで正しいテンプレートが送付される
- [ ] RATEで正しいテンプレートが送付される
- [ ] 氏名が正しく差し込まれる
- [ ] 住所が正しく差し込まれる
- [ ] EmailへCloudSignが送付される
- [ ] SPLL番号が正しい
- [ ] 原作名が正しい
- [ ] 利用料が正しい
- [ ] クレジットが正しい
- [ ] FORM完了画面で契約成立と表示しない
- [ ] CloudSign同意後に契約成立扱いになる

## 24.2 改変試験

URLを手作業で変更する。

- [ ] `license_id` 改変 → MANUAL_REVIEW
- [ ] `application_ref` 改変 → MANUAL_REVIEW
- [ ] `terms_snapshot_hash` 改変 → MANUAL_REVIEW
- [ ] `fee_amount_or_rate` 改変 → MANUAL_REVIEW
- [ ] `work_names` 改変 → MANUAL_REVIEW
- [ ] `credit_text` 改変 → MANUAL_REVIEW

## 24.3 URL長

- [ ] 通常1作品
- [ ] 最大5作品
- [ ] 長い作品名
- [ ] 長いクレジット

850文字超過時は標準FORMへ送らずMANUAL_REVIEW。

## 24.4 Webhook

- [ ] FormRun正常受信
- [ ] 重複受信
- [ ] CloudSign締結
- [ ] CloudSign取消
- [ ] CloudSignメール不達
- [ ] DB受信後Sheets障害
- [ ] Sheets復旧後再試行

## 24.5 提出

- [ ] 新規提出
- [ ] 再提出
- [ ] 大容量Drive提出
- [ ] 期限切れ
- [ ] トークン失効
- [ ] 二重確定

## 24.6 QR

- [ ] ACTIVE
- [ ] SUSPENDED
- [ ] REVOKED
- [ ] 再発行
- [ ] 旧QR
- [ ] DNS/サーバー切替後も旧QRが開ける

---

# 25. CloudSign FORMを今から設定する際の実作業順

以下の順番で進めればよい。

### 1

CloudSignで

```text
SPLL_利用許諾契約_STANDARD_FIXED_v4.1
SPLL_利用許諾契約_STANDARD_RATE_v4.1
```

を作る。

### 2

formrunで

```text
SPLL 利用許諾申込（定額）
```

を作る。

### 3

ユーザー入力6項目を作る。

### 4

hidden項目9項目を作る。

### 5

`データ項目管理` で `_field_N` をこのMDの表に記録する。

### 6

CloudSign FORM連携でFIXEDテンプレートを紐付ける。

### 7

氏名・Email・契約書差込をマッピングする。

### 8

フォームを複製してRATEを作る。

### 9

RATE側 `_field_N` を再確認する。

### 10

RATE CloudSignテンプレートを紐付ける。

### 11

フォーム公開URLを取得する。

```text
FORM_URL_STANDARD_FIXED=<URL>
FORM_URL_STANDARD_RATE=<URL>
```

### 12

SPLL側の `FORM_HIDDEN_MAP` / `FORMRUN_FIELD_MAP` を実IDに合わせる。

### 13

SPLLポータルから実際に遷移してhidden値を確認する。

### 14

URL改変試験を行う。

### 15

CloudSign締結まで通し、WebhookでSheetsへ正しく書き戻ることを確認する。

---

# 26. 本番切替条件

以下がすべてOKになるまで本番公開しない。

- [ ] 独自ドメイン
- [ ] HTTPS
- [ ] STANDARD_FIXED FORM
- [ ] STANDARD_RATE FORM
- [ ] CloudSign template mapping
- [ ] FORM field mapping
- [ ] URL長ガード
- [ ] 改変検知
- [ ] Webhook冪等性
- [ ] Sheets同期
- [ ] Drive提出
- [ ] QR独自ドメイン
- [ ] 失効試験
- [ ] エラー再試行
- [ ] ロールバック手順

---

# 27. ロールバック

Public Web移行中も、GAS版を一定期間残す。

ただし、二重受付を避けるため公開URLは1系統だけにする。

```text
通常:
DNS → Cloud Run

障害時:
DNS / reverse proxy → 旧GAS案内ページ
```

Webhook送信先の切替は特に慎重に行う。

Webhookは切替前後に受信IDを冪等管理し、二重処理を防止する。

---

# 28. 現時点での最優先修正

優先度順:

1. **CloudSign FORMの実フォーム作成**
2. **現行 `buildFormUrl()` のURL長問題修正**
3. **FORM転送項目と内部スナップショットの分離**
4. **独自ドメインの確定**
5. Public Web Docker化
6. Webhook receiver移行
7. 作品提出ページ移行
8. QR取得・検証ページ移行
9. GAS公開部分停止

CloudSign FORMの設定を先に完成させれば、Public Webの移行前でも現行GASから接続テストが可能である。

---

# 29. 参照実装

現行リポジトリ内:

```text
spll_src/28_contract_form_v4_shared.gs
spll_src/29_contract_form_v4.gs
spll_src/35_webhooks.gs
spll_src/36_formrun_contract_v4.gs
spll_src/40_public_pages.gs
spll_src/42_large_submission.gs
spll_src/47_batches.gs
spll_src/50_admin.gs
spll_src/portal_contract_v4_patch.html
spll_src/upload.html
spll_src/admin.html

docs/SPLL_CloudSign_FORM_実装仕様_v2.1.md
docs/SPLL_CloudSign_FORM_設定マッピング_v1.0.md
```

---

# 30. 外部仕様参照

CloudSign FORM:

- https://www.cloudsign.jp/integrations/cloudsign_form/
- https://www.cloudsign.jp/info/20240603_information-3/

CloudSign Webhook:

- https://help.cloudsign.jp/ja/articles/417935

formrun 初期値 / hidden:

- https://form.run/home/blog/media_tips_initial_values_hidden
- https://faq.form.run/faq/initialvalue
- https://faq.form.run/faq/hidden-form

formrun Webhook:

- https://faq.form.run/webhook

---

# 31. 備考

CloudSign FORM / formrunの管理画面上の名称はサービス側のUI更新で変わる可能性がある。

特に本書で重要なのは画面名称そのものではなく、以下の論理設定である。

```text
1. FORMは契約者情報を取得
2. SPLL条件はシステムから引き継ぐ
3. CloudSignテンプレートへ差し込む
4. CloudSign上の同意で契約成立
5. FormRun/CloudSign Webhookは耐障害受信
6. 社内管理はSpreadsheet
7. Public Webは独自ドメイン + Dockerで移植可能
```

以上。


---

# 32. 現行GASでの実装状況（v1.1追記）

CloudSign FORMのデモ環境が用意できた時点で、**§28の優先度2・3・4に相当するコード修正を現行GASへ先に入れた**。
Public Web（Docker）へ移す前に、いまのGASのままフォーム接続テストができる状態にするため。

## 32.1 実装済み

| 本書の該当 | 内容 | 実装 |
|---|---|---|
| §9 | FORM転送項目と内部スナップショットの分離 | `CONTRACT_FORM_V4_TRANSFER_KEYS`（`license_id` / `application_ref` / `usage_category` / `work_names` / `licensor_name` / `fee_amount_or_rate` / `credit_text`）＋制御項目3つのみURLへ載せる。`terms_snapshot_hash` は従来どおり全条件（`CONTRACT_FORM_V4_HASH_KEYS`）から生成 |
| §9 | URL長チェック | `FORM_URL_MAX_CHARS`（既定850）。ポータルが実際に組み立てるURLをサーバー側で見積もり、超過した申込は `MANUAL_REVIEW` へ退避し理由を申込レコードへ記録 |
| §10 | 改変検知の修正版 | 受信時に ①`application_ref` ②`license_id` ③`terms_snapshot_hash` を照合 → ④SPLL正本を再生成して申込時ハッシュと一致するか確認 → ⑤**転送した項目だけ**を正本と突合。`handoff_token` のHMAC検証は従来どおり `processFormrunEvent_` |
| §14 §15 | 経路別マップ | `FORM_HIDDEN_MAP_FIXED` / `_RATE`、`FORMRUN_FIELD_MAP_FIXED` / `_RATE`。未設定なら共通マップへフォールバック。受信は「共通マップで正規化 → 申込を特定 → その経路のマップで再正規化」の2段 |
| §14 | 申込の経路記録 | `Applications.template_route`（スキーマv10）。受信時にどちらのフォームか判定するために必要 |
| §21.5 §1.3 | QRのドメイン固定 | `PUBLIC_BASE_URL`。設定すると検証URLは `https://（ドメイン）/v/{cert_id}?c={code}`。未設定時は現行どおりGAS②のURL。**あわせて `verifyUrl_` が `ScriptApp.getService().getUrl()` を使っていた不具合を修正**（管理コンソールからコード再発行するとadminのURLがQRに焼き込まれていた） |
| §7 | FORM入力項目 | canonical key は `party_name` / `circle_name` / `postal_code` / `party_address` / `email` / `adult_confirmed`。SPLL側が保持するのは氏名（`party_display_name`）と連絡先メールのみで、**住所・郵便番号はCloudSign側に残し台帳へ持ち込まない**（個人情報の最小化） |
| — | 設定画面 | 管理コンソール「設定」に公開ドメインとURL上限の入力欄を追加。hidden項目マッピングの「ひな形を挿入」も転送項目だけを出すよう変更 |

### 締結時スナップショットの出所が変わった点

転送項目を絞った結果、FormRun受信証跡から全条件を復元することはできなくなった。
そのため締結時の `terms_snapshot` は次の順で確定する。

1. **`SPLL_SNAPSHOT`** … 申込から正本を再生成し、申込時ハッシュと一致した場合（通常はこれ）
2. `FORMRUN_RECEIPT` … 一致しない場合に、全項目を転送していた旧フォームの受信証跡から復元できたとき
3. `RECOMPUTED` … どちらも取れないとき。`TERMS_MISMATCH` として認証・バッジを停止する

申込後に原作マスタ・料金表が変わると 1 が一致しなくなるため、**条件のドリフトはここで必ず検出される**。

## 32.2 未着手（Public Web移行本体）

§28 の 5〜9（Docker化・Webhook receiver移行・作品提出ページ移行・QR取得/検証ページ移行・GAS公開部分停止）は未着手。
独自ドメイン（§28-4）が決まり次第、`PUBLIC_BASE_URL` を設定できる。

> **注意：** `PUBLIC_BASE_URL` は**そのドメインで検証ページが開ける状態になってから**設定する。
> QRは頒布物に印刷されて残るため、開けないドメインで発行したQRは後から回収できない。
> 管理コンソール側でも、実行基盤のURL（`script.google.com` / `*.run.app`）やIPアドレスは入力を拒否する。

## 32.3 テスト

`npm test` に次を追加（合計508件）。

- 転送項目のみがURLへ載ること／内部スナップショットには全条件が残ること
- URL上限超過の申込が `MANUAL_REVIEW` へ退避し、理由が残ること
- 経路別マップでの正規化・フォールバック
- 転送項目の書換えは自動締結を止め、転送していない項目は比較対象にしないこと
- 申込後にマスタが変わった受信を自動締結しないこと
- 公開ドメイン設定の検証（実行基盤URL・クエリ付きの拒否）とURL上限の範囲検証
