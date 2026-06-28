# SPLL システム

**SPLL-SYS-BD-001 v1.0** ／ 株式会社アークライト 法務部

TRPGの二次創作（有料頒布）に関するライセンス制度「SPLL（Small Publisher Limited
License）」を、Google Workspace + Google Apps Script（GAS）で実装するためのソース一式です。
申込・電子契約（CloudSign）・AI作品審査（Vertex AI Gemini）・利用報告・パートナー清算
までを、人手工程を最小化して運用することを狙っています。

> 設計の経緯・判断根拠は基本設計書 `SPLL_基本設計書_v1.0.docx` を参照。
> 本リポジトリのソースは実装ハンドオフ用の参照実装（スケルトン）です。

## 構成

```
SPLL/
├── README.md
├── package.json              # clasp と npm スクリプト
├── .gitignore
├── .clasp.json.template      # コピーして .clasp.json を作成し scriptId を記入（rootDir=spll_src）
├── .claspignore              # push 対象を spll_src 内の GAS ソースに限定
└── spll_src/                  # clasp の push 対象（rootDir）
    ├── appsscript.json        # マニフェスト（OAuthスコープ・webapp設定）
    ├── Code.gs                # サーバーサイド（3プロジェクト分を集約した参照実装）
    ├── index.html             # 公開入口（GAS①・申込窓口）
    ├── admin.html             # 管理コンソール（GAS③・社内GWS限定）
    └── report.html            # 利用報告（GAS②・?page=report&token=）
```

`Code.gs` は本来 3 つの GAS プロジェクトに分割してデプロイする想定の関数を 1 枚に集約した
参照実装です。実装時はプロジェクトごとにファイルを分割してください。

| プロジェクト | 役割 | 公開範囲 | doGet |
|---|---|---|---|
| GAS① 公開入口 | 作品公開API＋申込画面配信 | インターネット公開 | index.html |
| GAS② 契約・審査 | CloudSign Webhook(doPost)・Gemini・Drive・清算・利用報告 | 限定＋Webhook | report.html(token) |
| GAS③ 管理コンソール | 審査／入金／契約管理 | 社内GWS限定 | admin.html |

## アーキテクチャ概要

作品マスタ(Sheets) → GAS① 作品公開API → 公開入口(index.html)

- **A経路（契約前審査）**：申込＋作品提出 → Gemini審査 → PASS/REVIEW なら契約リンク送付、
  FAIL は送らず終了（1年後に自動削除）。
- **B経路（契約後審査）**：FormRun申込 → CloudSign API送信 → 締結 → Webhook(doPost) で
  Contracts 書戻し → 作品提出案内 → Gemini審査 → 是正。

締結 → 作品提出(Drive) → Gemini審査 → 利用報告(report.html) → 管理コンソール(admin.html) →
半期バッチで計算書（仕入明細書・みなし合意）を生成・送信。

スプレッドシート（業務台帳）が業務の**単一の正本**。状態変更は `Events` へ追記し、
提出原本・AI結果・発行済計算書は上書きしません。

## セットアップ・デプロイ（clasp）

ルートに `package.json`（clasp と npm スクリプト）と `.clasp.json`/`.claspignore`（`rootDir=spll_src`）を
用意しています。`.clasp.json` をルートに置く構成なので、**すべてのコマンドはリポジトリ直下から
そのまま実行**できます（`cd` 不要）。`clasp` 本体はローカルにインストールし、**`clasp login` は
ブラウザ認証が必要なためローカルで実行**してください（リモート/CI環境では不可）。push 対象は
`.claspignore` で GAS ソース5ファイルのみに限定しています。

```bash
npm install              # devDependency の @google/clasp を取得
npm run login            # ブラウザでGoogle認証（ローカルのみ）

# 新規にWebアプリのGASプロジェクトを作る場合（推奨・ワンショット）
npm run setup            # clasp create(webapp) → appsscript.json復元 → clasp push -f

#   ↑の内訳を手動でやる場合:
#   npm run create                              # webアプリ型でGASプロジェクト作成（.clasp.json生成）
#   git checkout -- spll_src/appsscript.json    # create が上書きする既定マニフェストを本書の内容へ戻す
#   npm run push                                # ローカル → GAS

# 既存のGASプロジェクトに接続する場合
cp .clasp.json.template .clasp.json   # scriptId を記入
npm run push

# 公開
npm run deploy           # Webアプリとしてデプロイ（バージョン管理）
npm run open:web         # 公開URLをブラウザで開く
```

主な npm スクリプト：`login` / `setup` / `create` / `clone` / `push` / `push:watch` /
`deploy` / `deployments` / `open` / `open:web` / `logs` / `status`。

`.clasp.json`（実 scriptId を含む）は `.gitignore` 済み。コミットしないでください。

### Webアプリ公開設定（appsscript.json）

`spll_src/appsscript.json` の `webapp` は `executeAs: USER_DEPLOYING` / `access: ANYONE_ANONYMOUS`
です。公開範囲は用途に応じてデプロイ時に調整してください（GAS①公開入口=一般公開、
GAS②契約・審査=限定＋Webhook、GAS③管理コンソール=社内GWS限定）。初回デプロイ時に OAuth スコープ
（Spreadsheet/Drive/外部リクエスト/メール送信/cloud-platform）の承認が求められます。

> 本リポジトリは3プロジェクト分を1つの `Code.gs` に集約した参照実装です。まずは単一プロジェクトとして
> デプロイして動作確認し、運用に合わせて GAS①②③へ分割してください（`doGet` の `page` 出し分けにより
> 単一デプロイでも index/admin/report/upload を切り替え可能）。

### ScriptProperties（秘密情報・設定）

秘密情報・環境依存値はコードに固定せず、各 GAS プロジェクトの **ScriptProperties** に設定します。
下記は**管理コンソールの「設定」タブから登録・更新できます**（初回のみ手動投入でも可）。

| キー | 用途 |
|---|---|
| `SS_MASTER` / `SS_OPS` / `DRIVE_ROOT` | 作品マスタ・業務台帳・Drive 親フォルダの ID（未設定時は `CFG` の既定値） |
| `GCP_PROJECT` / `GCP_REGION` / `GEMINI_MODEL` | Vertex AI Gemini の接続先・モデル |
| `CLOUDSIGN_CLIENT_ID` / `CLOUDSIGN_SECRET` | CloudSign API 認証（secret は画面に再表示しない） |
| `CLOUDSIGN_TEMPLATE_ID` / `CLOUDSIGN_CALLBACK_URL` / `CLOUDSIGN_SANDBOX` | CloudSign 送信テンプレ・Webhook URL・サンドボックス切替 |
| `FORMRUN_FORM_URL` / `FORMRUN_WEBHOOK_SECRET` / `FORMRUN_FIELD_MAP` | FormRun の連携設定（secret は画面に再表示しない） |

`Code.gs` の値解決は `cfg_(key)`（ScriptProperties 優先 → `CFG` 既定値）で行います。`CFG` の
プレースホルダ（`PUT_..._ID`）は ScriptProperties で上書きするか、コード側を実 ID に置換します。

### 管理コンソールからの設定（「設定」タブ）

`admin.html` の「設定」タブから、運用担当が次を画面操作で更新できます（保存は即時反映）。

| 区分 | 保存先 | 主な GAS 関数 |
|---|---|---|
| 個人情報取得同意文・規約テンプレート | `Config` シート（`LEGAL_PRIVACY_TEXT` / `LEGAL_TERMS_TEMPLATE`） | `admin_getLegalTexts` / `admin_saveLegalTexts` |
| 作品マスタ（データソース＋作品の追加・編集・公開切替） | ScriptProperties ＋ `Works_Master` シート | `admin_getDataSourceConfig` / `admin_saveDataSourceConfig` / `admin_listWorksMaster` / `admin_saveWork` / `admin_setWorkPublish` |
| CloudSign API 設定 | ScriptProperties | `admin_getIntegrationConfig` / `admin_saveCloudSignConfig` |
| FormRun 設定 | ScriptProperties | `admin_getIntegrationConfig` / `admin_saveFormRunConfig` |

### 業務タブの実データ配線（GAS関数）

| タブ | 取得 | 操作 |
|---|---|---|
| ダッシュボード | `admin_dashboard`（6KPI＋直近の要対応） | — |
| 作品審査管理 | `admin_reviewQueue`（ジョブ単位に総合結果・経路A/B・主指摘を結合） | `admin_setHumanReview`（CLEARED／CORRECTION_REQUIRED／ESCALATED） |
| 契約管理 | `admin_listContracts`（締結済＋締結待ちを結合・契約者名はマスク） | `admin_sendUploadLink`（B経路の提出案内送付） |
| 入金・清算 | `admin_listPayments` / `admin_listSettlements` | `admin_recordPayment` / `admin_voidPayment` / `admin_approveStatement` |

集計・結合（作品名・パートナー名・契約↔請求）はサーバー側で行い、UIは整形済みデータを描画します。
シートが空でもエラーにならないよう防御的に実装しています（`readRows_` は未作成シートで空配列）。

- 規約テンプレートは差込トークン `{{name}}{{pub}}{{ok}}{{no}}{{media}}{{fee}}{{credit}}` を作品ごとに展開し、
  公開窓口 `index.html` が `api_getLegalTexts()` で取得して申込ウィザードに表示します（取得失敗時は既定文）。
- 公開状態を `PUBLISHED` にした作品のみ `api_listWorks()` で公開窓口に表示されます。
- 秘密情報（CloudSign secret・FormRun webhook secret）は保存時のみ入力し、読み出しでは
  「設定済みか」だけを返します（値は画面に出しません）。

### スプレッドシート

`SS_MASTER`（作品マスタ）／`SS_OPS`（業務台帳）の各シートを設計書 §3 のスキーマで作成します。
1行目をヘッダ行とし、`Code.gs` の `readRows_/appendRow_/updateRow_` がヘッダ名で突合します。

- 作品マスタ：`Works_Master` / `Review_Rules` / `Reference_Assets`
- 業務台帳：`Applications` / `Contracts` / `Upload_Tokens` / `Submissions` /
  `Submission_Files` / `AI_Review_Jobs` / `AI_Findings` / `Human_Reviews` /
  `Compliance_Alerts` / `Usage_Reports` / `Invoices` / `Payments` / `Settlements` /
  `Settlement_Details` / `Settlement_Statements` / `Partners` / `Events` / `Config`

## HTML のモック／配線について

`index.html` / `admin.html` / `report.html` はサンプルデータ内蔵のモックとしても単体表示でき、
GAS 上では `google.script.run` 経由で実データに切り替わるよう配線済みです。

- `index.html`：作品一覧は `api_listWorks()` を呼び、取得できない場合は内蔵サンプルにフォールバック。
  **審査タイミング(A/B)は内部属性**で、公開UIにはバッジ・絞り込みを出しません。
- `report.html`：`serveReport_()` がトークンをテンプレートへ差し込み、`report_getContext(token)`
  で契約情報、`report_submit(token,data)` で報告送信。ログイン／マイページなし。
- `admin.html`：**全タブ google.script.run で実配線済み**。ダッシュボード（6KPI＋要対応）、
  審査キュー（人手判断＝承認／是正要求／上申）、契約一覧（提出案内送付）、入金・清算（入金記録・
  取消・計算書承認）、および「設定」（同意文・規約／作品マスタ／CloudSign／FormRun）。
  バックエンドは作品名の結合・状態の正規化を行い、UIがそのまま描画できる形で返します。
  スタンドアロン表示時は内蔵モックで動作。社内GWS限定で公開。

## セキュリティ・個人情報

- 秘密情報は ScriptProperties。公開APIは返却列をホワイトリスト化（内部メモ・配分は返さない）。
- 提出物は Drive の契約別フォルダに保存。契約者へ内部フォルダ閲覧権限は付与せず、
  トークン付きアップロード画面のみ提供。
- A経路の落選データは `retention_until`（取得+1年）で自動削除（`batch_purgeRejected`）。
- **個人情報（住所・口座・電話）は Gemini に送らない**（契約条件と作品データのみ）。
- AI結果やパトロール未実施を理由に、既発生のパートナー配分を当然に消滅させない。

## AI作品審査（runAiReview_）

`enqueueAiReview_` が提出ファイルから `Submissions`/`Submission_Files` と `AI_Review_Jobs`(QUEUED)
を作成し、`runAiReview_(aiReviewId)` が次を実行します（即時試行→失敗時は `batch_runAiReviews_` が再試行）。

1. 提出ファイルBlobを取得（**作品ファイルのみ。個人情報はGeminiに送らない**）。
2. `Works_Master` の許諾/禁止要素・クレジット・媒体と `Review_Rules`（有効期間内）を構造化（`buildRules_`）。
3. `geminiReview_`（responseSchema 構造化出力）→ `AI_Findings` へ記録。
4. 総合結果で経路別ルーティング（`postReviewRouting_`）:
   - **A経路**：HIGH_RISK/UNREADABLE → `REJECTED`＋`retention_until`（取得+1年）。PASS候補/要確認 →
     CloudSign 契約リンク送付＋`LINK_SENT`。
   - **B経路**：HIGH_RISK → `Compliance_Alerts` 起票（`settlement_block` は空＝**既発生配分は止めない**）。
5. 失敗時は `retry_count` を加算し `AI_MAX_RETRY`(3) 未満なら QUEUED、以上で ERROR。

レスポンスは HTTP エラー時に例外化し、構造化結果が得られない場合は安全側（`REVIEW_REQUIRED`）へ倒します。

## 半期清算（batch_generateStatements）

確定済（`APPROVED`/`LOCKED`）の `Usage_Reports` を集計し、パートナー別の計算書（仕入明細書方式・DRAFT）
を生成します。計算チェーン（per 報告）:

```
net_sales × royalty_rate = license_fee × (1 − handling_fee_rate) = partner_share
```

- `royalty_rate` は `Works_Master.royalty_rate` 列、無ければ Config `DEFAULT_ROYALTY_RATE`(既定0.10)。
  事務手数料は Config `HANDLING_FEE_RATE`(既定0.30)。各値は `rate_snapshot` に保存。
- 作品→パートナーは `partner_id` 列 → 出版社名突合 → 疑似パートナー の順で解決（`resolveWorkPartner_`）。
- `Settlements`／`Settlement_Details`／`Settlement_Statements`(DRAFT・`reg_number_snapshot`) を生成。
  当期の有効な計算書が既にある場合は二重生成を避けてスキップ。

ライフサイクル：生成(DRAFT) → `admin_approveStatement`(APPROVED) → `batch_sendApprovedStatements_`
（CloudSign送信＝SENT・発効日＝本日・**異議期限＝発効日+1ヶ月**） → `batch_confirmDeemed`（みなし確認＝CONFIRMED）。
管理コンソール「入金・清算」から `admin_generateStatements` / `admin_sendApprovedStatements` /
`admin_runAiReviews` を手動起動できます（時間主導トリガーとも共用）。

## CloudSign 連携（サンドボックス既定）

電子契約・計算書送信を CloudSign Web API で実装。**試験運用のためサンドボックスを既定**とし、
`CLOUDSIGN_SANDBOX` を `false` に設定したときのみ本番（`api.cloudsign.jp`）へ切り替わります。

- `cloudSignAccessToken_`：`POST /token?client_id=` でトークン取得、`CacheService` で短期キャッシュ。
- `cs_fetch_`：API共通呼び出し（Bearer認証・multipart対応・HTTPエラーを例外化）。
- `cloudSignSend_`：契約書作成 → ファイル添付（`CLOUDSIGN_TEMPLATE_ID` があればテンプレ差込、無ければ
  規約テンプレートから生成した PDF）→ 当事者設定 → 送信 → `cloudsign_document_id` を Applications に控え。
  **AI審査ジョブとは分離**し、CloudSign障害時はAI審査を失敗させず申込を保留（再送可）にします。
- `cloudSignSendStatement_`：仕入明細書PDFを生成→Drive保存（`pdf_file_id`）→みなし合意付きで送信。
- `doPost`（締結Webhook）：`document_id`/`documentID`/`id` と `event_type`/`status` の差異を吸収、
  重複排除のうえ Contracts へ締結書戻し。**ステータス値は CloudSign 公式仕様で要確認**（`cs_isCompletedEvent_`）。
- 管理コンソール「設定 › CloudSign API」に **接続テスト**ボタン（`admin_cloudSignTest`）。トークンは先頭のみ表示。

> エンドポイント・ステータス値・Web​hookペイロードは CloudSign 公式 Web API ドキュメントで最新仕様の
> 確認が必要です（本実装は標準的なフローに基づくサンドボックス向けの実装）。

## 実装時に確認・補完する箇所（設計書 §5・§9 由来の TODO）

- **CloudSign 仕様確認**：`/documents`・`/files`・`/participants`・`/sent` の各エンドポイントと
  締結ステータス値（`cs_isCompletedEvent_`）、Webhook署名検証を公式仕様で確認・調整。
- **Vertex AI Gemini**：モデル・リージョン・データ所在地を確認（`runAiReview_` の審査ロジックは実装済）。
- **作品提出ページ**：`?page=upload` の専用UI（現状は report テンプレートを暫定流用）。
- **Q-01/Q-03/Q-05a**：A/B 振り分け運用、B経路解除条項、未成年締結ロジック（条文確定後）。
