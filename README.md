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
├── .gitignore
└── spll_src/                  # clasp の push 対象（rootDir）
    ├── appsscript.json        # マニフェスト（OAuthスコープ・webapp設定）
    ├── .clasp.json.template   # コピーして .clasp.json を作成し scriptId を記入
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

```bash
npm i -g @google/clasp
clasp login

cd spll_src
cp .clasp.json.template .clasp.json   # scriptId を記入（プロジェクトごとに用意）
clasp push                            # ローカル → GAS
clasp deploy                          # Web アプリとして公開（バージョン管理）
```

`.clasp.json`（実 scriptId を含む）は `.gitignore` 済み。コミットしないでください。

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
- `admin.html`：ダッシュボード／審査／契約／入金の各表は `admin_dashboard / admin_reviewQueue /
  admin_listContracts / admin_recordPayment` に接続する想定（現状は表示モック）。
  **「設定」タブは google.script.run で実配線済み**（同意文・規約／作品マスタ／CloudSign／FormRun）。
  スタンドアロン表示時は内蔵モックで動作。社内GWS限定で公開。

## セキュリティ・個人情報

- 秘密情報は ScriptProperties。公開APIは返却列をホワイトリスト化（内部メモ・配分は返さない）。
- 提出物は Drive の契約別フォルダに保存。契約者へ内部フォルダ閲覧権限は付与せず、
  トークン付きアップロード画面のみ提供。
- A経路の落選データは `retention_until`（取得+1年）で自動削除（`batch_purgeRejected`）。
- **個人情報（住所・口座・電話）は Gemini に送らない**（契約条件と作品データのみ）。
- AI結果やパトロール未実施を理由に、既発生のパートナー配分を当然に消滅させない。

## 実装時に確認・補完する箇所（設計書 §5・§9 由来の TODO）

- **CloudSign API**：`cloudSignSend_` / `cloudSignAccessToken_` は最新 API 仕様で実装。
- **Vertex AI Gemini**：モデル・リージョン・データ所在地を確認。`runAiReview_`（Job 実行）の実装。
- **作品提出ページ**：`?page=upload` の専用UI（現状は report テンプレートを暫定流用）。
- **半期清算**：`batch_generateStatements` の集計・スナップショット・計算書PDF生成。
- **Q-01/Q-03/Q-05a**：A/B 振り分け運用、B経路解除条項、未成年締結ロジック（条文確定後）。
