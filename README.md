# SPLL システム

TRPG の二次創作（有料頒布）に関するライセンス制度「SPLL（Small Publisher Limited License）」の
**申込 → 電子契約（CloudSign FORM）→ 作品提出 → AI一次審査＋人手審査 → 認証（Certificate）→ 認証バッジ**を、
Google Apps Script（GAS）3 プロジェクト＋ Cloud Run（公開サイト）で運用するためのソース一式です。

SPLL が扱うのは**契約と認証の管理**だけです。請求・入金・清算・権利者への配分は本システムの対象外で、
締結内容を `Finance_Handoffs` に置く（外部連携のキュー）以上のことはしません。
利用許諾料の振込先も契約書本文にだけ記載し、システムには持ちません。

> 用語：申請者＝**クリエーター**、社内担当者＝**ユーザー**。
> 設計の経緯は `docs/`（RP-002 の実装方針は `docs/SPLL_具体的修正案_v2.0.md`）を参照。

## 構成

```
SPLL/
├── apps/
│   ├── portal/        # GAS①：申込窓口の API（原作公開・申込作成・FORM 引渡）。dist/ はビルド生成物
│   ├── workflow/      # GAS②：CloudSign / formrun Webhook、審査、認証、クリエーター向けページ、バッチ
│   ├── admin/         # GAS③：管理コンソール（社内 Google Workspace ドメイン限定）
│   └── public-web/    # Cloud Run：公開サイト（申込・案内・提出・検証）。GAS①②へ共有鍵付き RPC
├── spll_src/          # GAS ソースの正本（*.gs / *.html）。scripts/build.js が各 apps/*/dist へ振り分ける
├── scripts/           # build.js（振り分け＋禁止参照チェック）、clasp.js、deploy.js、test-all.js
├── tests/             # インメモリ GAS スタブ上の機能テスト（harness / sec01 / form_v4 / partnership / public_web）
└── docs/              # 契約書・法務3文書・設定手順・手動テスト手順・設計メモ（legal/ は公開用HTML）
```

`spll_src/*.gs` を直接デプロイしません。**`node scripts/build.js`** が `MANIFEST`（`scripts/build.js`）に従って
プロジェクトごとに必要なファイルだけを `apps/<app>/dist/` へ配り、閉包（未解決参照）と禁止参照
（例：portal に `admin_*` を入れない）を検査します。

## アーキテクチャ

```
クリエーター ──▶ Cloud Run（apps/public-web）
                    │  /api/rpc（共有鍵 PUBLIC_WEB_KEY）
                    ├──▶ GAS① portal    … 原作一覧・法務文書・申込作成・CloudSign FORM への引渡
                    └──▶ GAS② workflow  … 提出・案内・バッジ・検証（トークン認証）
CloudSign / formrun ──▶ GAS② doPost（Webhook。署名・共有鍵で検証）
ユーザー（社内）  ──▶ GAS③ admin（Workspace ドメイン限定）
                         └── 時間主導トリガー（GAS②）：5分・日次バッチ
業務台帳：Google スプレッドシート（SS_MASTER＝原作マスタ／SS_OPS＝業務台帳）、提出物：Drive（SPLL-番号/）
```

- 公開サイトの画面（`index.html` / `guide.html` / `upload.html`）は `spll_src` が正本で、Cloud Run のイメージにも同梱します。
  画面を直したら **GAS の再デプロイと Cloud Run の再ビルドの両方**が必要です。
- GAS① と GAS② は `HANDOFF_SECRET` を共有し、申込 → FORM → 締結 Webhook の改変検知に使います。

## 業務フローと状態機械

**1 案件＝1 つの SPLL 番号（`License_Cases`）が唯一の業務上の主台帳**です（RP-002）。
案件の現在地 `case_status` と `contract_status` / `review_status` / `certification_status` は
状態遷移表 `spll_src/12_license_state.gs`（`transitionLicenseCase_`）を通してだけ変わります。

```
申込（SPLL番号発行）→ CloudSign FORM → 締結（Webhook）→ 作品提出待ち
  → 作品提出 → AI一次審査 → 人手審査 CLEARED → 認証（Certificate）発行 → バッジ（Badge）
```

| case_status | 意味 |
|---|---|
| APPLICATION_RECEIVED / CONTRACT_PENDING / MANUAL_REVIEW / SIGNING / HOLD | 申込〜締結。HOLD は締結したが条件不一致（法務確認待ち） |
| AWAITING_SUBMISSION / REVIEWING / CORRECTION_REQUIRED | 締結後〜審査 |
| CERTIFIED / SUSPENDED / TERMINATED / CANCELLED | 認証済／認証停止／終了／取消 |

守っている不変条件：

- **認証は人手審査 CLEARED の後にだけ発行**（締結だけでは発行しない）。Certificate が正本、Badge はその表示物。
- **バッジは「認証 ACTIVE」からだけ作られる**。手動発行の入口は無く、失敗した生成ジョブの再試行だけがある
  （`issueBadge_` 自身が案件・認証・審査状態を検証する）。バッジ PNG には契約IDではなく SPLL 番号を印字する。
- **1 ライセンス＝1 作品**。修正版は同じ提出の新しい版（Submission_Versions）。別の作品は別の申込。
- **契約が終了（TERMINATED）した認証は再有効化できない**。再開は新しい契約の締結で行う。
- 認証の行と台帳は「ロック → 事前検証（`validateLicenseTransition_`）→ 書き込み」で一緒に変える。
  台帳が拒否する変更は認証の行にも書かない。
- 認証が ACTIVE でない間はバッジを配布しない（一時停止は行を残す、失効・終了は SUPERSEDED）。

### 認証の状態と理由

| Certificate.status | 意味 | 変え方 |
|---|---|---|
| ACTIVE | 有効 | 発行時／復帰 |
| SUSPENDED | 一時停止。**理由は `reason_code`**（例：`FEE_PAYMENT_UNCONFIRMED`＝利用許諾料の入金未確認） | 未確認停止と復帰は担当者 1 名のスイッチ。他の理由からの復帰は申請→別担当者の承認 |
| REVOKED / TERMINATED / EXPIRED | 失効／契約終了／期限切れ | 申請→別担当者の承認（職務分離） |

`PAYMENT_HOLD` は廃止（`setup_migrateCertStatesV3` で `SUSPENDED`＋理由へ移行）。
「なぜ止めたか」と「認証の法的状態」を分けて持ちます。

## データ（スプレッドシート）

- `SS_MASTER`：`Works_Master`（原作）／`Review_Rules`／`Fee_Schedule`（料金表）
- `SS_OPS`（主なもの）：`License_Cases`（正本）／`License_Works`／`Applications`・`Contracts`（移行期間の互換・証跡）／
  `Contract_Works`・`Contract_Documents`／`Submissions`・`Submission_Versions`・`Submission_Files`／
  `AI_Review_Jobs`・`AI_Findings`・`Human_Reviews`・`Compliance_Alerts`／`Certificates`・`Certificate_Change_Requests`／
  `Badges`・`Badge_Jobs`／`Access_Tokens`／`Notification_Queue`／`Legal_Documents`・`Application_Consents`／
  `Finance_Handoffs`／`Events`・`System_Errors`・`Batch_Runs`・`Migration_Runs`／`Config`／`Admin_Users`
- 提出・認証・バッジ・トークン・通知は `license_id` を正本に持ち、`contract_id` は互換列です。
- 状態変更は `Events` に before / after を残し、提出原本・AI 結果は上書きしません。
- スキーマは `spll_src/05_schema.gs`（`SCHEMA_VERSION`）。不足列の追加は `setup_migrate` が冪等に行います。

## ビルド・テスト・デプロイ

```bash
node scripts/build.js            # spll_src → apps/*/dist（閉包・禁止参照チェック込み）
node scripts/test-all.js         # 全テスト（GAS スタブ上）
```

GAS（clasp）。`clasp login` はブラウザ認証のためローカルで実行します。Windows で npm のシムが壊れている環境向けに
`node scripts/...` を直接使う形にしています。

```bash
node scripts/clasp.js login                        # 初回のみ
node scripts/deploy.js portal   "変更の説明"        # build 済みの dist を push → 既存ウェブアプリデプロイを新版へ
node scripts/deploy.js workflow "変更の説明"
node scripts/deploy.js admin    "変更の説明"
```

前提（アプリごとに初回 1 回）：`apps/<app>/.clasp.json`（scriptId）と `apps/<app>/.deploy.json`（`{"deploymentId":"AKfycb..."}`）。
どちらも `.gitignore` 済みでコミットしません。

Cloud Run（Cloud Shell 等）：

```bash
gcloud builds submit --config apps/public-web/cloudbuild.yaml \
  --substitutions _IMAGE=asia-northeast1-docker.pkg.dev/<PROJECT>/spll/public-web
gcloud run deploy spll-public-web --region asia-northeast1 \
  --image asia-northeast1-docker.pkg.dev/<PROJECT>/spll/public-web:latest
curl -s https://<service>.run.app/_health          # {"ok":true,...}
```

環境変数 `GAS_PORTAL_URL` / `GAS_WORKFLOW_URL`、Secret Manager の `PUBLIC_WEB_KEY`（GAS 側の同名 ScriptProperty と一致）。
詳細は `docs/SPLL_クリエーター向けサイトのCloudRun配信_v1.1.md`。

## 設定

**ScriptProperties（秘密情報・環境依存値。プロジェクトごとに独立）**

| キー | portal | workflow | admin |
|---|---|---|---|
| `ENVIRONMENT`（development / staging / production・必須） | ✔ | ✔ | ✔ |
| `SS_MASTER` / `SS_OPS` / `DRIVE_ROOT` | ✔ | ✔ | ✔ |
| `HANDOFF_SECRET`（①②で同じ値） | ✔ | ✔ | — |
| `PUBLIC_WEB_KEY`（Cloud Run との共有鍵） | ✔ | ✔ | — |
| `FORM_HIDDEN_MAP_FIXED` / `_RATE` / `_MANUAL`（formrun の hidden 項目キー） | ✔ | ✔ | — |
| `FORMRUN_FIELD_MAP_FIXED` / `_RATE` / `_MANUAL`、`FORMRUN_WEBHOOK_SECRET`、`CLOUDSIGN_WEBHOOK_KEY` | — | ✔ | — |
| `GCP_PROJECT` / `GCP_REGION` / `GEMINI_MODEL`（Vertex AI） | — | ✔ | ✔ |
| `CLOUDSIGN_CLIENT_ID` / `CLOUDSIGN_SECRET` / `CLOUDSIGN_SANDBOX` | — | ✔ | ✔ |
| `BADGE_TEMPLATE_ID` / `BADGE_AUTO` / `QR_API_URL` | — | ✔ | ✔ |
| `ADMIN_CONSOLE_URL` | ✔ | — | — |

**Config シート（業務値。管理コンソール「設定」から編集・3 プロジェクト共通・即時反映）**：
`WORKFLOW_URL`（GAS②の /exec）、`PUBLIC_BASE_URL`（QR に焼き込む独自ドメイン）、`OFFICE_CONTACT`、`OFFICE_EMAIL_DOMAIN`、
`FORM_URL_STANDARD_FIXED` / `_STANDARD_RATE` / `_MANUAL_REVIEW`、`CORPORATE_INQUIRY_*`、`GUIDE_EMAIL_*`、`MAIL_*`、
`REVIEW_SLA_DAYS`、`SUBMIT_FOLDER_*`、`APPLICATION_RETENTION_DAYS` など。手順は `docs/SPLL_初期設定チェックリスト_v1.0.md`。

初期化・移行は admin の GAS エディタから：`setup_all`（ブートストラップ＋移行一式）、個別には
`setup_migrate`（スキーマ）、`setup_migrateLicenseCases`、`setup_migrateLicenseForeignKeysV2`、
`setup_migrateAdminRolesV2`、`setup_migrateCertStatesV3`。workflow では `setup_workflowAll`（トリガー作成）。

## 管理コンソール（GAS③）

| タブ | 内容 |
|---|---|
| ダッシュボード | `case_status` の集計と要対応（個別確認・承認待ち・人手対応の通知・整合性エラー）。SPLL 番号で詳細へ |
| ライセンス | 検索・絞り込み、1 案件の詳細（契約・原作・提出・審査・認証・バッジ生成ジョブ・履歴）。案内リンク／提出リンクの発行 |
| 作品審査 | 人手判断（CLEARED で認証発行／CORRECTION_REQUIRED／ESCALATED） |
| 認証管理 | Certificate 一覧（Badge は表示物）。一時停止／復帰のスイッチ、失効・再有効化の申請と承認 |
| 設定 | 同意文・規約（版管理・公開）、原作マスタ、料金表、申込窓口の URL、手続き案内・案内メール、AI、CloudSign、formrun、管理者 |

ロール：SYSTEM_ADMIN / LEGAL_ADMIN / OPERATIONS / REVIEWER / AUDITOR（ACCOUNTING は廃止）。
通常画面に契約ID・申込IDは出しません（旧参照は詳細の「legacy」にだけ）。

## セキュリティ・個人情報

- 秘密情報は ScriptProperties / Secret Manager のみ。リポジトリには置きません。
- クリエーター向けページはすべて用途別トークン（`Access_Tokens`：期限・回数付き）で認証。ログイン／マイページは持ちません。
- バッジ画像は Drive 共有リンクを使わず、トークン検証後に GAS が配信します。認証が ACTIVE でなければ配布しません。
- 認証の照合コードは平文を保存せずハッシュだけ（`check_code_hash`）。再試行や再発行では新しいコードを発行します。
- **本番（production）では、公開版の法務文書（PRIVACY・GUIDELINE）が無いと申込を停止**します（既定文へフォールバックしない）。
- 個人情報（氏名・住所・メール）は Gemini に送りません（作品データと契約条件のみ）。
- 台帳と実体の整合は `auditLicenseConsistency_`（日次）で監査し、矛盾は `System_Errors`（LICENSE_INCONSISTENCY）へ残します。
- 契約に至らなかった申込は `APPLICATION_RETENTION_DAYS`（既定 365 日）で匿名化します。

## テスト

`node scripts/test-all.js` は build のあと `tests/harness.js`（業務フロー全体）、`tests/sec01.js`（セキュリティ）、
`tests/form_v4.js`（CloudSign FORM v4）、`tests/partnership.js`、`tests/public_web.js`（Cloud Run）を実行します。
日付依存のテストは固定の対象月を使っています。

## ドキュメント

- 契約書ひな形：`docs/SPLL_利用許諾契約書_CloudSign_FORM対応_v4.1.md`（振込先は個別条件に固定文言で記載）
- CloudSign FORM の実装・設定：`docs/SPLL_CloudSign_FORM_実装仕様_v2.1.md`、`docs/SPLL_CloudSign_FORM_設定マッピング_v1.0.md`
- 初期設定・手動テスト：`docs/SPLL_初期設定チェックリスト_v1.0.md`、`docs/SPLL_手動テスト手順_v1.0.md`
- 法務3文書（正本 Markdown → `node docs/build_legal_html.js` で `docs/legal/` を生成）：
  `SPLL_個人情報取得同意_v1.0.md`、`SPLL_二次創作ガイドライン_v4.1.md`、`SPLL_利用規約_v1.0.md`
- 設計判断：`docs/SPLL_具体的修正案_v2.0.md`（RP-002）、`docs/SPLL_修正設計書_v2.0.md`
