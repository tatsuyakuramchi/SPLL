# SPLL 契約・認証管理システム 具体的修正案 v2.0

**文書番号（案）:** SPLL-SYS-RP-002  
**対象リポジトリ:** `tatsuyakuramchi/SPLL`  
**対象ブランチ:** `claude/new-design-implementation-wlqwv9`  
**作成日:** 2026-09-02  
**ステータス:** Implemented（実装状況は末尾の付録を参照）  

---

## 1. 本修正の目的

現行SPLLは、既に `License_Cases` / `License_Works` / `Contract_Documents` / `Finance_Handoffs` を導入し、旧来の請求・入金・清算機能をSPLL本体から切り離している。

一方、実コードには以下の旧構造が残っている。

- `Applications` / `Contracts` が依然として多くの業務処理の起点になっている
- `Access_Tokens` / `Submissions` / `Certificates` / `Badges` 等が `contract_id` を主参照している
- AdminのDashboard・契約一覧が `Applications` / `Contracts` を直接集計している
- `ACCOUNTING` ロール、振込先設定等のFinance由来機能が残っている
- CloudSign締結直後にCertificate・Badgeを発行しており、「作品提出→審査→認証」の業務順序と一致していない

本修正では、**`License_Cases`（SPLL番号）を唯一の業務上の主台帳・主キーへ昇格させ、契約締結から作品審査・認証までを一本の状態遷移として管理する。**

---

# 2. 修正方針の要約

## 2.1 最終的な中心構造

```text
License_Cases                         1案件 = 1 SPLL番号
    │
    ├── License_Works                対象原作・契約条件スナップショット
    │
    ├── Contract_Documents           原契約・変更契約・解除等の履歴
    │
    ├── Submissions                  作品提出
    │      ├── Submission_Versions
    │      ├── Submission_Files
    │      ├── AI_Review_Jobs
    │      ├── AI_Findings
    │      └── Human_Reviews
    │
    ├── Certificates                 認証の正本
    │      └── Badges                Certificateの表示物
    │
    └── Events                       業務・監査ログ

Technical / Evidence
    ├── Applications                 移行期間の技術・証跡テーブル
    ├── Contracts                    移行期間のCloudSign互換テーブル
    ├── Application_Consents
    ├── Webhook_Receipts
    ├── Access_Tokens
    ├── Notification_Queue
    ├── System_Errors
    └── Migration_Runs

External Outbox
    └── Finance_Handoffs             経理への締結情報引渡のみ
```

## 2.2 修正の優先順位

| 優先度 | 修正 |
|---|---|
| P0 | 認証発行タイミング修正（締結直後→審査完了後） |
| P0 | State Machine導入・`case_status`直接更新禁止 |
| P0 | `license_id` を提出・認証・バッジ・トークンへ展開 |
| P0 | Dashboardを`License_Cases`基準へ切替 |
| P1 | Admin UIをライセンス中心へ統合 |
| P1 | `Contract_Documents`を契約書履歴の正本へ昇格 |
| P1 | GUIDEから振込先・Finance操作を除去 |
| P1 | `ACCOUNTING`ロール廃止 |
| P2 | `Applications` / `Contracts` の新規業務参照を停止 |
| P2 | README・設計書・テストを現行構造へ統一 |

---

# 3. P0-1 認証発行タイミングの修正

## 3.1 現行問題

現行 `32_contract.gs` の `finishLicenseActivation_()` はCloudSign締結後に以下を実施している。

```text
CloudSign締結
  ↓
issueCert_()
  ↓
enqueueBadgeJob_()
  ↓
提出トークン発行
  ↓
review_status = PENDING
```

この状態では、**審査前の作品にACTIVE認証・バッジが存在し得る。**

目標業務フローは以下とする。

```text
CloudSign締結
  ↓
作品提出待ち
  ↓
作品提出
  ↓
AI審査
  ↓
人手審査（必要時）
  ↓
CLEARED
  ↓
Certificate発行
  ↓
Badge発行
```

## 3.2 `32_contract.gs` 修正

### 変更前

```javascript
function finishLicenseActivation_(contractId){
  const cert = issueCert_(contractId);
  if(prop_('BADGE_AUTO') !== 'false'){
    enqueueBadgeJob_(contractId, cert && cert.verify_url);
  }
  prepareSubmissionToken_(contractId);
  ...
  updateLicenseCase_(licenseId, {
    certification_status:'ACTIVE',
    review_status:'PENDING'
  });
}
```

### 変更後

`finishLicenseActivation_()` を実質的に「締結後処理」へ変更する。

推奨名称：

```javascript
preparePostSigningWorkflow_(licenseId, contractId)
```

処理内容：

```text
1. Contract_Documentsへ締結済契約書を登録
2. GUIDEトークン発行
3. SUBMISSIONトークン発行又は発行可能状態にする
4. Notification_QueueへGUIDE_READY
5. contract_status = SIGNED
6. review_status = AWAITING_SUBMISSION
7. certification_status = NOT_ISSUED
8. case_status = AWAITING_SUBMISSION
```

**ここでは `issueCert_()` / `enqueueBadgeJob_()` を呼ばない。**

## 3.3 新規関数 `completeCertification_()`

`32_contract.gs` 又は認証専用ファイル（推奨：`41_certificate.gs`）へ追加する。

```javascript
function completeCertification_(licenseId, submissionId){
  // 1. 最新Submissionであること
  // 2. 最新版がCLEAREDであること
  // 3. 未解決の重大Compliance Alertがないこと
  // 4. 有効なSIGNED契約が存在すること
  // を確認してから認証を発行する
}
```

処理：

```text
Human Review = CLEARED
      ↓
completeCertification_()
      ↓
Certificates append / ACTIVE
      ↓
Badge_Jobs = QUEUED
      ↓
License_Cases.certification_status = ACTIVE
License_Cases.review_status = CLEARED
License_Cases.case_status = CERTIFIED
```

## 3.4 `admin_setHumanReview()` 修正

現行の人手判断後に状態更新だけで終わらせず、`CLEARED` 時のみ認証処理を呼ぶ。

```javascript
if(result === 'CLEARED'){
  completeCertification_(licenseId, submissionId);
}
```

`CORRECTION_REQUIRED`：

```text
review_status = CORRECTION_REQUIRED
case_status = CORRECTION_REQUIRED
```

`ESCALATED`：

```text
review_status = ESCALATED
case_status = MANUAL_REVIEW
```

---

# 4. P0-2 State Machineの導入

## 4.1 現行問題

現在は複数箇所から以下のような直接更新が可能である。

```javascript
updateLicenseCase_(licenseId, { case_status:'SIGNED' });
updateLicenseCase_(licenseId, { review_status:'PENDING' });
updateLicenseCase_(licenseId, { certification_status:'ACTIVE' });
```

これにより、例えば以下の矛盾状態を作成できる。

```text
contract_status = SIGNING
certification_status = ACTIVE
```

## 4.2 `00_core.gs` 修正

現行：

```javascript
function updateLicenseCase_(licenseId, patch)
```

を業務処理から直接使用しない。

内部用に改名する。

```javascript
function updateLicenseCaseRaw_(licenseId, patch)
```

新規追加：

```javascript
function transitionLicenseCase_(licenseId, event, context)
```

## 4.3 イベント一覧

```text
APPLICATION_CREATED
FORM_SUBMITTED
MANUAL_REVIEW_REQUIRED
CLOUDSIGN_SENT
CLOUDSIGN_SIGNED
SUBMISSION_CREATED
AI_REVIEW_STARTED
AI_REVIEW_COMPLETED
HUMAN_REVIEW_CLEARED
CORRECTION_REQUIRED
REVIEW_ESCALATED
CERTIFICATE_ISSUED
CERTIFICATE_SUSPENDED
CERTIFICATE_RESTORED
CERTIFICATE_REVOKED
CONTRACT_TERMINATED
APPLICATION_CANCELLED
```

## 4.4 case_status一覧

```text
APPLICATION_RECEIVED
CONTRACT_PENDING
MANUAL_REVIEW
SIGNING
AWAITING_SUBMISSION
REVIEWING
CORRECTION_REQUIRED
CERTIFIED
SUSPENDED
TERMINATED
CANCELLED
```

## 4.5 遷移表

| Event | contract_status | review_status | certification_status | case_status |
|---|---|---|---|---|
| APPLICATION_CREATED | NOT_STARTED | NOT_STARTED | NOT_ISSUED | APPLICATION_RECEIVED |
| FORM_SUBMITTED | NOT_STARTED | NOT_STARTED | NOT_ISSUED | CONTRACT_PENDING |
| MANUAL_REVIEW_REQUIRED | NOT_STARTED | NOT_STARTED | NOT_ISSUED | MANUAL_REVIEW |
| CLOUDSIGN_SENT | SIGNING | NOT_STARTED | NOT_ISSUED | SIGNING |
| CLOUDSIGN_SIGNED | SIGNED | AWAITING_SUBMISSION | NOT_ISSUED | AWAITING_SUBMISSION |
| SUBMISSION_CREATED | SIGNED | IN_REVIEW | NOT_ISSUED | REVIEWING |
| CORRECTION_REQUIRED | SIGNED | CORRECTION_REQUIRED | NOT_ISSUED | CORRECTION_REQUIRED |
| HUMAN_REVIEW_CLEARED | SIGNED | CLEARED | NOT_ISSUED | REVIEWING |
| CERTIFICATE_ISSUED | SIGNED | CLEARED | ACTIVE | CERTIFIED |
| CERTIFICATE_SUSPENDED | SIGNED | CLEARED | SUSPENDED | SUSPENDED |
| CERTIFICATE_REVOKED | SIGNED | CLEARED | REVOKED | TERMINATED |
| CONTRACT_TERMINATED | TERMINATED | - | REVOKED | TERMINATED |

## 4.6 遷移検証

許可されていない遷移は例外とする。

例：

```text
APPLICATION_RECEIVED → CERTIFIED
```

は拒否する。

`Events`には必ず、

```text
before
transition_event
after
actor
occurred_at
```

が分かる形で記録する。

---

# 5. P0-3 スキーマをlicense_id中心へ変更

## 5.1 基本方針

既存列をいきなり削除しない。

**Phase 1では `license_id` を末尾追加してdual-writeする。**

移行確認後、`contract_id`をCompatibility列へ降格する。

## 5.2 `05_schema.gs` 修正

### Access_Tokens

現行：

```text
token_id, contract_id, purpose, ...
```

変更：

```text
token_id, contract_id, ..., license_id, reference_id
```

最終正本：`license_id`

### Submissions

現行：

```text
submission_id, contract_id, title, status, ...
```

変更：

```text
submission_id, contract_id, title, status, ..., license_id
```

### Certificates

現行：

```text
cert_id, contract_id, status, ...
```

変更：

```text
cert_id, contract_id, status, ..., license_id
```

### Badges

変更：

```text
badge_id, contract_id, ..., license_id, cert_id
```

### Compliance_Alerts

変更：

```text
alert_id, contract_id, submission_id, ..., license_id
```

### Notification_Queue

変更：

```text
notification_id, contract_id, ..., license_id
```

### Certificate_Change_Requests

既に`contract_id`があるため、末尾に`license_id`を追加する。

---

# 6. P0-4 データ移行

## 6.1 新規migration関数

`05_schema.gs`へ以下を追加する。

```javascript
setup_migrateLicenseForeignKeysV2()
```

処理対象：

```text
Access_Tokens
Submissions
Certificates
Badges
Compliance_Alerts
Notification_Queue
Certificate_Change_Requests
```

## 6.2 変換ロジック

```text
row.contract_id
   ↓
Contracts.contract_id
   ↓
Contracts.license_id
   ↓
row.license_id
```

Contractsにlicense_idがない旧データは、

```text
Contracts.application_id
  ↓
Applications.license_id
```

までフォールバックする。

解決できない行は勝手に補完しない。

```text
Migration_Runs = PARTIAL
System_Errors = MIGRATION_UNRESOLVED_LICENSE
```

として記録する。

## 6.3 移行受入条件

```text
license_id未設定行 = 0
```

を原則とする。

旧データ等で例外がある場合は、対象ID一覧をMigration_Runsに記録する。

---

# 7. `20_tokens.gs` 修正

## 7.1 issueToken_

現行：

```javascript
issueToken_(contractId, purpose, days, maxUses)
```

新：

```javascript
issueToken_(licenseId, purpose, days, maxUses, referenceId)
```

保存：

```text
license_id = licenseId
contract_id = currentContractId（移行期間のみ互換列）
reference_id = submission_id等必要時のみ
```

## 7.2 revokeTokens_

現行：

```javascript
revokeTokens_(contractId, purpose)
```

新：

```javascript
revokeTokens_(licenseId, purpose)
```

## 7.3 prepareSubmissionToken_

```javascript
prepareSubmissionToken_(licenseId)
```

へ変更する。

---

# 8. `40_public_pages.gs` 修正

## 8.1 `web_getSubmitContext()`

現行：

```text
Token.contract_id
 → Submissions.contract_id
 → Certificates.contract_id
 → Badges.contract_id
```

変更：

```text
Token.license_id
 → License_Cases
 → License_Works
 → Submissions.license_id
 → Certificates.license_id
 → Badges.license_id
```

返却値も、

```text
contract_id
```

を主表示にせず、

```text
license_id
```

を返す。

## 8.2 `web_submitWork()`

新規提出：

```javascript
appendRow_(..., 'Submissions', {
  submission_id: submissionId,
  license_id: licenseId,
  contract_id: currentContractId, // migration compatibility only
  ...
});
```

### 契約フォルダ依存の修正

現在Driveフォルダも`contractId`中心のため、最終的には以下へ変更する。

```text
DRIVE_ROOT
  └── SPLL-202609-0001
       ├── 01_Contract
       ├── 02_Submissions
       ├── 03_Review
       └── 04_Certificate
```

新規関数：

```javascript
licenseRootFolder_(licenseId)
licenseSubFolder_(licenseId, name)
```

旧 `contractSubFolder_()` はLegacy案件用ラッパーへ降格する。

## 8.3 バッジ画面

現在画面には`b.contract_id`が「ライセンスID」のように表示されるため、明確に修正する。

変更：

```text
ライセンスID: SPLL-202609-0001
```

表示値は必ず`license_id`とする。

---

# 9. `44_guide.gs` 修正

## 9.1 Finance項目を削除

以下を削除する。

```javascript
paymentInfo_()
paymentConfigured_()
```

削除対象Config：

```text
PAYMENT_BANK_NAME
PAYMENT_BRANCH
PAYMENT_ACCOUNT_TYPE
PAYMENT_ACCOUNT_NUMBER
PAYMENT_ACCOUNT_HOLDER
PAYMENT_HOLDER_KANA
PAYMENT_NOTE
```

## 9.2 GUIDEの役割変更

旧：

```text
振込先
作品提出
バッジ
```

新：

```text
SPLL番号
契約成立日
対象原作
利用目的
契約条件の概要
作品提出への導線
審査状況
認証状況
認証バッジ（発行後）
問い合わせ先
```

`fee_label` / `payment_terms` は「契約条件の表示」として残してもよいが、**支払処理・口座案内は行わない。**

## 9.3 `prepareGuideToken_()`

```javascript
prepareGuideToken_(licenseId)
```

へ変更する。

---

# 10. `32_contract.gs` 契約管理の再整理

## 10.1 Contractsの位置づけ

Phase移行後：

```text
Contracts = CloudSign連携Compatibility Table
Contract_Documents = 契約書履歴の業務正本
```

とする。

## 10.2 `syncLicenseOnSigning_()`

契約締結時は必ず以下を1トランザクション相当で実施する。

```text
1. Contractsを更新（互換）
2. Contract_DocumentsへSIGNEDを追記
3. License_Cases.contract_status = SIGNED
4. License_Cases.signed_at更新
5. transitionLicenseCase_(CLOUDSIGN_SIGNED)
6. preparePostSigningWorkflow_()
7. Finance_Handoffs READY
```

## 10.3 Contract_Documents version

単純な行数ではなく、同一`license_id + document_type`ごとのversionを採番する。

例：

```text
ORIGINAL v1
AMENDMENT v1
AMENDMENT v2
TERMINATION v1
```

## 10.4 現契約の判定

新規helper：

```javascript
currentSignedContractDocument_(licenseId)
```

を作り、CloudSign書類IDを知る必要がある内部処理だけがこれを利用する。

---

# 11. `50_admin.gs` 修正

## 11.1 Dashboard

現行の以下依存を廃止する。

```text
Applicationsによるsigning件数
Compliance_Alerts / Contracts中心の要対応
```

新Dashboardは`License_Cases`の`case_status`を正本とする。

### KPI

```text
MANUAL_REVIEW           契約・例外確認
SIGNING                 締結中
AWAITING_SUBMISSION     作品提出待ち
REVIEWING               審査中
CORRECTION_REQUIRED     是正対応中
SUSPENDED               認証停止
```

### 要対応一覧

以下を統合して表示する。

```text
License_Cases
Notification_Queue
System_Errors（OPENかつ業務影響あり）
Certificate_Change_Requests
```

## 11.2 `admin_listContracts()`

日常UIから廃止する。

移行期間だけ残し、関数コメントに：

```text
@deprecated RP-002
```

を付与する。

## 11.3 新規API

```javascript
admin_listLicenseCases(filters)
admin_getLicenseCase(licenseId)
admin_getLicenseTimeline(licenseId)
admin_getContractDocuments(licenseId)
admin_getSubmissionsByLicense(licenseId)
admin_getCertificationByLicense(licenseId)
```

### `admin_getLicenseCase()`返却イメージ

```javascript
{
  license: {...},
  works: [...],
  contractDocuments: [...],
  submissions: [...],
  certificate: {...},
  badge: {...},
  pendingNotifications: [...],
  timeline: [...]
}
```

## 11.4 `admin_setHumanReview()`

`submission_id → Submissions.license_id`を解決し、

```javascript
transitionLicenseCase_(licenseId, event)
```

を通す。

`CLEARED`時には`completeCertification_()`を呼ぶ。

---

# 12. `admin.html` 修正

## 12.1 トップメニュー

現行：

```text
ダッシュボード
ライセンス
作品審査管理
契約管理
設定
```

変更：

```text
ダッシュボード
ライセンス
作品審査
認証管理
原作・条件
設定
```

「契約管理」はライセンス詳細へ統合する。

## 12.2 ライセンス一覧

現行の「経理引渡」列を通常一覧から削除する。

新規列：

```text
SPLL番号
契約者
対象原作
利用目的
現在状態
契約
審査
認証
締結日
最終更新
```

検索：

```text
SPLL番号
契約者名
原作名
CloudSign書類ID
```

フィルタ：

```text
case_status
contract_status
review_status
certification_status
usage_category
work_id
```

## 12.3 ライセンス詳細Drawer / Detail View

1案件を以下のセクションにまとめる。

```text
[概要]
SPLL番号 / 契約者 / 利用目的 / 現在状態 / 次の対応

[契約]
契約状態 / 締結日 / CloudSign / 契約書履歴

[対象原作]
原作名 / クレジット / 契約時料金条件

[作品提出]
Submission / Version / 提出日

[審査]
AI結果 / Human Review / 是正履歴

[認証]
Certificate / Badge / 状態変更申請

[履歴]
Events timeline
```

## 12.4 認証管理タブ

一覧：

```text
SPLL番号
契約者
原作
認証状態
発行日
停止理由
状態変更申請
```

Certificateを直接編集するUIは作らない。

---

# 13. RBAC修正 `10_auth.gs`

## 13.1 ロール一覧

現行：

```javascript
SYSTEM_ADMIN
LEGAL_ADMIN
OPERATIONS
ACCOUNTING
AUDITOR
```

変更：

```javascript
SYSTEM_ADMIN
LEGAL_ADMIN
OPERATIONS
REVIEWER
AUDITOR
```

## 13.2 権限

### SYSTEM_ADMIN

- 全操作
- 接続設定
- 管理者管理
- マイグレーション

### LEGAL_ADMIN

- 契約例外
- 法務文書公開
- Fee Schedule変更
- 認証停止・取消承認
- 契約書履歴確認

### OPERATIONS

- 通常案件処理
- 原作マスタ運用
- 提出案内
- 通知対応

### REVIEWER

- 作品審査
- CLEARED / CORRECTION_REQUIRED / ESCALATED

### AUDITOR

- 全参照
- 更新不可

## 13.3 ACCOUNTING移行

自動でOPERATIONSへ昇格させない。

安全側としてmigration時に：

```text
ACCOUNTING → AUDITOR
```

へ変更し、必要なユーザーのみSYSTEM_ADMINがOPERATIONS等へ再設定する。

新規migration：

```javascript
setup_migrateAdminRolesV2()
```

---

# 14. Fee Schedule権限修正

現行 `admin_saveFeeRow()`：

```javascript
requireRole_(['ACCOUNTING','LEGAL_ADMIN'])
```

変更：

```javascript
requireRole_(['LEGAL_ADMIN'])
```

SYSTEM_ADMINは`requireRole_()`仕様上常に許可。

理由：料金条件はFinance操作ではなく、**契約条件マスタ**であるため。

---

# 15. Notification Queue修正

`Notification_Queue`も`license_id`中心へ変更する。

新規：

```javascript
enqueueLicenseNotification_(licenseId, type, referenceId, payload)
```

旧：

```javascript
enqueueNotification_(contractId, ...)
```

は移行ラッパーとする。

通知一覧では契約IDではなくSPLL番号を表示する。

---

# 16. Certificate / Badge設計

## 16.1 Certificateが正本

```text
Certificate = 法的・業務上の認証状態
Badge       = Certificateを可視化する配布物
```

Badge.statusから認証有効性を判断しない。

## 16.2 Badge再生成

CertificateがACTIVEであればBadge画像の再生成を可能とする。

Badge画像生成失敗は：

```text
Certificate ACTIVE
Badge Job ERROR
```

とし、認証自体を無効にしない。

## 16.3 認証停止

```text
Certificate_Change_Request
   ↓ LEGAL_ADMIN承認
Certificate.status = SUSPENDED
   ↓
License_Cases.certification_status = SUSPENDED
   ↓
case_status = SUSPENDED
```

---

# 17. Finance_Handoffsの位置づけ

`Finance_Handoffs`は残すが、管理画面の主工程から外す。

位置づけ：

```text
Transactional Outbox / 外部連携キュー
```

SPLLのcase_statusへ影響させない。

例えば経理側が未受領でも、

```text
certification_status = ACTIVE
case_status = CERTIFIED
```

は維持する。

AdminではSYSTEM_ADMIN向け「外部連携診断」程度に限定する。

---

# 18. Driveフォルダ構造変更

## 18.1 新規案件

```text
SPLL_ROOT
  └── SPLL-202609-0001
      ├── 01_Contract
      ├── 02_Submissions
      │   └── SUB-...
      │       ├── v1
      │       └── v2
      ├── 03_Review
      └── 04_Certificate
```

## 18.2 旧案件

既存フォルダは物理移動しない。

`License_Cases`又は内部mapに既存folder_idを保持し、新規案件だけSPLL番号フォルダ方式に切り替える。

物理移動はDriveリンク切れリスクがあるため行わない。

---

# 19. Build構成

現在の3GAS + Cloud Run構造は維持する。

```text
apps/portal
apps/workflow
apps/admin
apps/public-web
```

`scripts/build.js`のSEC-01境界チェックも維持する。

追加候補：

```text
spll_src/12_license_state.gs
spll_src/41_certificate.gs
```

### portal

State Machineのうち申込作成に必要な最小関数を含める。

### workflow

- State Machine
- Contract
- Submission
- Review orchestration
- Certificate

### admin

- State Machine
- Certificate
- Admin APIs

---

# 20. ファイル別変更一覧

| ファイル | 修正内容 | 優先度 |
|---|---|---:|
| `00_core.gs` | `updateLicenseCaseRaw_`化、共通license helper | P0 |
| `05_schema.gs` | 各テーブルへlicense_id追加、migration追加 | P0 |
| `10_auth.gs` | ACCOUNTING廃止、REVIEWER追加 | P1 |
| `12_license_state.gs` | 新設。State Machine | P0 |
| `20_tokens.gs` | contract_id→license_id中心 | P0 |
| `25_portal.gs` | 申込作成後のState Event統一 | P0 |
| `29_contract_form_v4.gs` | handoff後のcase遷移統一 | P0 |
| `32_contract.gs` | 締結時認証発行廃止、Contract_Documents正本化 | P0 |
| `35_webhooks.gs` | CloudSign/FormRun受信後はState Eventを発火 | P0 |
| `37_ai.gs` | AI開始/完了時の状態イベント連携 | P0 |
| `40_public_pages.gs` | Submission/Badge/Certificateをlicense_id化 | P0 |
| `41_certificate.gs` | 新設。認証発行・停止・取消 | P0 |
| `44_guide.gs` | 振込先削除、license_id化 | P1 |
| `46_mailer.gs` | notificationをlicense_id中心へ | P1 |
| `47_batches.gs` | case_status再計算/整合性監査batch追加 | P1 |
| `50_admin.gs` | Dashboard・一覧・詳細をLicense中心へ | P0/P1 |
| `51_admin_contract_v4.gs` | 契約条件管理のみへ整理 | P1 |
| `admin.html` | 契約管理統合・認証管理追加・Finance表示削除 | P1 |
| `guide.html` | 振込先UI削除 | P1 |
| `scripts/build.js` | 新規state/certificateファイル配布追加 | P0 |
| `tests/harness.js` | State・migration・認証順序テスト追加 | P0 |
| `tests/sec01.js` | 新規ファイルの境界確認 | P0 |
| `README.md` | 現行アーキテクチャへ全面更新 | P2 |

---

# 21. 実装コミット案

## Commit 1 — `RP002: add license state machine`

```text
12_license_state.gs 新設
case_status定義
transitionLicenseCase_
状態遷移テスト
```

## Commit 2 — `RP002: migrate operational foreign keys to license_id`

```text
05_schema.gs
Access_Tokens
Submissions
Certificates
Badges
Notification_Queue
Compliance_Alerts
migration
```

## Commit 3 — `RP002: defer certification until review clearance`

```text
32_contract.gs
41_certificate.gs
50_admin.gs
37_ai.gs
```

**最重要コミット。**

## Commit 4 — `RP002: make public workflow license-centric`

```text
20_tokens.gs
40_public_pages.gs
44_guide.gs
Drive helper
```

## Commit 5 — `RP002: rebuild admin around License_Cases`

```text
50_admin.gs
admin.html
admin_contract patch
```

## Commit 6 — `RP002: remove finance remnants from SPLL License`

```text
ACCOUNTING role
payment config
bank info
finance UI
```

## Commit 7 — `RP002: deprecate legacy application and contract views`

```text
admin_listContracts deprecated
Applications/Contracts direct UI removal
compatibility helper
```

## Commit 8 — `RP002: documentation and acceptance tests`

```text
README
manual test
architecture docs
migration checklist
```

---

# 22. テスト項目

## 22.1 認証順序

### Test 1

```text
契約締結
→ Certificateが作成されない
→ Badgeが作成されない
→ case_status = AWAITING_SUBMISSION
```

### Test 2

```text
提出
→ case_status = REVIEWING
→ Certificateなし
```

### Test 3

```text
CORRECTION_REQUIRED
→ case_status = CORRECTION_REQUIRED
→ Certificateなし
```

### Test 4

```text
CLEARED
→ Certificate ACTIVE
→ Badge Job QUEUED
→ case_status = CERTIFIED
```

## 22.2 State Machine

不正遷移を拒否する。

```text
APPLICATION_RECEIVED → CERTIFIED : FAIL
SIGNING → CERTIFIED             : FAIL
AWAITING_SUBMISSION → SUSPENDED : FAIL
```

## 22.3 license_id migration

各テーブルについて：

```text
既存contract_id
→ license_id解決
→ 値一致
```

重複実行しても同じ結果になること。

## 22.4 Admin

通常運用で以下IDを画面上で使わない。

```text
application_id
contract_id
```

SPLL番号で全画面を移動できること。

## 22.5 Finance分離

以下が管理画面・GUIDEに表示されないこと。

```text
銀行名
支店
口座番号
口座名義
入金
請求
清算
```

---

# 23. 切替手順

## Step 1

本番スプレッドシート、ScriptProperties、Drive構造をバックアップする。

## Step 2

新列追加のみ実施する。

既存列は削除しない。

## Step 3

`setup_migrateLicenseForeignKeysV2()` をstagingで実行する。

## Step 4

全テスト実行。

```bash
node scripts/test-all.js
```

## Step 5

dual-writeを有効化する。

```text
contract_id + license_id
```

の双方を書き込む。

## Step 6

Admin UIをLicense_Cases中心へ切替する。

## Step 7

認証発行タイミングを切替する。

**この切替前後は新規締結を一時的に止めてデータ不整合を避ける。**

## Step 8

移行期間中、整合性監査batchを毎日実行する。

新規関数案：

```javascript
auditLicenseConsistency_()
```

チェック：

```text
SIGNEDでlicense_idなし
CERTIFIEDでCertificate ACTIVEなし
Certificate ACTIVEでreview CLEAREDなし
Badge ISSUEDでCertificate ACTIVEなし
Submissionでlicense_idなし
Tokenでlicense_idなし
```

## Step 9

問題がないことを確認後、旧Admin契約一覧を非表示にする。

---

# 24. ロールバック方針

本修正は、既存列を削除せずdual-write期間を設ける。

ロールバック時は：

```text
1. 旧Admin UIへ戻す
2. contract_id参照へ戻す
3. 新license_id列は残す
4. migration結果は削除しない
```

とする。

データ列の削除を伴わないため、コードロールバックを容易にする。

---

# 25. Definition of Done

以下をすべて満たした時点でRP-002完了とする。

- [ ] CloudSign締結だけではCertificateが発行されない
- [ ] CLEARED後にのみCertificateがACTIVEになる
- [ ] BadgeはACTIVE Certificateに基づいて生成される
- [ ] `License_Cases`がcase_statusの唯一の業務正本である
- [ ] case_statusの更新がState Machine経由に限定される
- [ ] Access_Tokensがlicense_idを持つ
- [ ] Submissionsがlicense_idを持つ
- [ ] Certificatesがlicense_idを持つ
- [ ] Badgesがlicense_idを持つ
- [ ] Notification_Queueがlicense_idを持つ
- [ ] Admin DashboardがApplicationsを直接集計しない
- [ ] Admin通常画面に契約ID・申込IDを表示しない
- [ ] 契約書履歴をContract_Documentsから取得する
- [ ] GUIDEに振込先を表示しない
- [ ] ACCOUNTINGロールが廃止されている
- [ ] Finance_Handoffsがcase_statusに影響しない
- [ ] 既存データmigrationが冪等である
- [ ] 全自動テストがPASSする
- [ ] 手動E2EテストがPASSする

---

# 26. 実装開始時の推奨順序

最初に以下3点を同一ブランチで実装する。

```text
1. State Machine
2. license_id foreign key追加・migration
3. 認証発行タイミング修正
```

理由：Admin UIを先に直すと、内部状態がまだ旧設計のまま残る。今回の改修は画面整理ではなく、**SPLL案件の業務状態と認証の成立条件を正しく定義することが中核**である。

その後、Public Workflow → Admin UI → Legacy整理の順に進める。

---

# 27. 参照した現行実装

本修正案は少なくとも以下の現行ファイルを前提としている。

```text
spll_src/00_core.gs
spll_src/05_schema.gs
spll_src/10_auth.gs
spll_src/20_tokens.gs
spll_src/32_contract.gs
spll_src/40_public_pages.gs
spll_src/44_guide.gs
spll_src/50_admin.gs
spll_src/51_admin_contract_v4.gs
spll_src/admin.html
scripts/build.js
docs/SPLL_分断・簡素化実装計画_v1.0.md
```

特に以下の現行仕様を修正対象とする。

- `finishLicenseActivation_()` が締結時に認証・バッジを発行すること
- `Access_Tokens` が `contract_id` を参照すること
- `Submissions` / `Certificates` / `Badges` が `contract_id` を参照すること
- Admin DashboardがApplicationsを直接集計すること
- Adminに「契約管理」タブが独立して存在すること
- GUIDEが振込先情報を表示すること
- RBACに`ACCOUNTING`が残っていること

---

**以上**

---

# 付録A. 実装状況（2026-09-02・ブランチ `claude/new-design-implementation-wlqwv9`）

| § | 内容 | 状況 | 備考 |
|---|---|---|---|
| 3 | 認証発行を審査 CLEARED 後へ | 実装 | `41_certificate.gs` `completeCertification_`。締結後処理は `preparePostSigningWorkflow_` |
| 4 | State Machine | 実装 | `12_license_state.gs` `transitionLicenseCase_`。旧 `updateLicenseCase_` は `updateLicenseCaseRaw_`（移行のみ）／状態列以外は `updateLicenseCaseInfo_` |
| 4.4 | case_status 一覧 | 実装（1つ追加・了承済） | 提案に無い **HOLD**（締結したが条件不一致・法務確認待ち）を追加。契約は成立しているので MANUAL_REVIEW とは区別する |
| 5 | license_id 展開 | 実装 | 8テーブルに末尾追加・dual-write。`Badges.cert_id` も追加 |
| 6 | migration | 実装 | `setup_migrateLicenseForeignKeysV2`（PARTIAL／System_Errors・冪等）。申込段階の通知は reference_id（申込ID）経由も解決 |
| 7 | tokens | 実装 | `issueToken_` 等は SPLL番号でも契約IDでも受ける（`resolveLicenseRef_`）。`reference_id` 列追加 |
| 8 | public pages | 実装 | `tokenLicenseRef_` / `belongsToLicense_`。表示値は SPLL番号。新規案件の Drive は `SPLL-番号/`（`createCaseFolder_`）、旧案件は移動しない |
| 9.1 | GUIDE から振込先を削除 | 実装 | 振込先は**契約書本文に記載**する方針が決まったため（2026-09-02）。案内ページ・メール・管理画面の設定（PAYMENT_*）をすべて外し、口座情報の正本は契約書だけにした。CloudSign テンプレートへの振込先追記が必要 |
| 9.2 | GUIDE に審査状況・認証状況 | 実装 | `review_status` を表示。認証は「審査完了後に発行」と案内 |
| 10 | Contract_Documents 正本化 | 部分 | 詳細画面は Contract_Documents を表示。`currentSignedContract_` を追加。version の種別別採番は未着手（現状 ORIGINAL のみ運用） |
| 11 | Admin API | 実装 | `admin_dashboard`（case_status 集計＋要対応統合）／`admin_listLicenseCases(filters)`／`admin_getLicenseCase`／`admin_listCertifications`／`admin_listContracts` は @deprecated |
| 12 | admin.html | 実装（1点差異・了承済） | 契約管理タブ廃止・詳細ドロワー・認証管理タブ追加。**「原作・条件」タブは未分離**（設定タブ内の原作・料金表のまま） |
| 13 | RBAC | 実装 | ACCOUNTING 廃止・REVIEWER 追加。`setup_migrateAdminRolesV2`（ACCOUNTING→AUDITOR） |
| 14 | Fee 権限 | 実装 | `admin_saveFeeRow` は LEGAL_ADMIN |
| 15 | Notification | 実装 | `enqueueLicenseNotification_`。旧名は互換ラッパー |
| 16 | Certificate / Badge | 実装 | Badge に cert_id。整合監査で「Badge ISSUED なのに認証が ACTIVE でない」を検出 |
| 17 | Finance_Handoffs | 実装 | 状態に影響しないことを検査で固定。管理画面では詳細の「外部連携・互換（参照のみ）」に退避 |
| 18 | Drive | 実装 | 新規は SPLL番号フォルダ。既存は物理移動しない |
| 19 | Build | 実装 | `12_license_state.gs` は3プロジェクト、`41_certificate.gs` は workflow / admin |
| 23 Step8 | 整合性監査 | 実装 | `auditLicenseConsistency_`（日次・`admin_auditLicenseConsistency` で手動起動）。矛盾は `System_Errors`（LICENSE_INCONSISTENCY） |
| 22 | テスト | 実装 | 認証順序4件・不正遷移・migration 冪等・Admin・Finance 分離を `tests/harness.js` に追加 |

## 付録B. 切替手順（§23 の具体化）

1. 本番スプレッドシート・ScriptProperties・Drive をバックアップ
2. 3プロジェクトをデプロイ（`node scripts/build.js` → `deploy.js portal / workflow / admin`）、Cloud Run を再ビルド
3. admin で **`setup_migrate`**（SCHEMA_VERSION 11：license_id 列の追加）
4. admin で **`setup_migrateLicenseForeignKeysV2`**（旧行の license_id 補完・旧 case_status の正規化）。結果が PARTIAL なら System_Errors の対象IDを確認
5. admin で **`setup_migrateAdminRolesV2`**（ACCOUNTING → AUDITOR。必要な人だけ OPERATIONS 等へ再設定）
6. `node scripts/test-all.js` 全通過を確認
7. **切替前後は新規締結を一時的に止める**（認証発行タイミングの変更で、締結済・未提出の案件は「作品提出待ち」に留まる。既に認証を持つ旧案件はそのまま CERTIFIED として扱う）
8. `admin_auditLicenseConsistency` を実行し、矛盾が無いことを確認。以後は日次トリガーで監査
9. 手動E2E（`docs/SPLL_手動テスト手順_v1.0.md` フェーズ2〜3）

