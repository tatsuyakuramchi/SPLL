# SPLL 分断・簡素化 実装計画 v1.0

**文書番号:** SPLL-SYS-RP-001  
**作成日:** 2026-08-12  
**対象リポジトリ:** `tatsuyakuramchi/SPLL`  
**対象ブランチ:** `claude/new-design-implementation-wlqwv9`  
**ステータス:** Implementation Plan

---

## 1. 目的

現行SPLLシステムは、原作選択、申込、契約、作品提出、審査、認証、利用報告、請求、入金、債権管理、売上突合、権利者配分、清算までを一連の業務フローとして管理している。

本改修では、これを次の2業務領域に分断する。

1. **SPLL License**
   - 原作選択
   - 申込
   - 契約管理
   - 作品提出・審査
   - 認証管理

2. **SPLL Finance**
   - 利用報告
   - 請求
   - 入金
   - 債権管理
   - 売上突合
   - 権利者配分
   - 清算
   - 各種報告書・計算書作成

併せて、現行の「業務台帳」を **SPLLライセンス台帳＝契約台帳** として再設計し、CloudSignフォームを「契約当事者を特定するための最小フォーム」へ簡素化する。

---

# 2. 改修方針

## 2.1 基本原則

本改修では次の原則を採用する。

### 原則1：契約とFinanceを分断する

契約成立後に請求・入金・清算処理を直接起動しない。

```text
SPLL License
  契約成立
     │
     ├─ 作品審査・認証へ
     │
     └─ Finance引渡データ作成
              │
              ▼
        SPLL Finance
```

License側はFinance側の請求・入金・清算状態を更新しない。

Finance側もLicense側の契約・認証状態を直接更新しない。

---

### 原則2：SPLL番号を全業務の主キーとする

従来の `application_id`、`contract_id`、CloudSign書類IDを管理画面上の中心概念とせず、1案件につき1つの **license_id（SPLL番号）** を発行する。

例：

```text
SPLL-202608-0001
```

申込から契約、審査、認証まで同じlicense_idで管理する。

---

### 原則3：業務台帳を契約台帳に統合する

管理画面上の主台帳は `License_Cases` とする。

申込と契約を別々の台帳として表示せず、

```text
申込受付
→ 契約手続中
→ 締結済
→ 審査中
→ 認証済
```

という1案件の状態遷移として扱う。

契約書原本や変更契約等は `Contract_Documents` へ1:Nで保持する。

---

### 原則4：契約書の正本は締結済PDF

台帳上に契約書全文を再現するための情報を重複保持しない。

契約書の正本は、

- CloudSign書類
- 締結済PDF
- PDFハッシュ

とする。

台帳には検索・業務判断・連携に必要な情報のみ保持する。

---

### 原則5：CloudSignフォームでは契約条件を入力させない

原作、利用目的、料金、クレジット、報告条件等はSPLLポータル・マスタ側で確定する。

CloudSignフォームでは原則として、

> **誰と契約するか**

のみを取得する。

---

### 原則6：証跡と業務台帳を分ける

ライセンス台帳は簡潔にする一方、

- 同意証跡
- Webhook受信証跡
- AI審査結果
- 監査ログ
- 契約書ハッシュ

等は内部証跡テーブルとして保持する。

「台帳を簡素化する」ことと「証跡を削除する」ことは分けて考える。

---

# 3. 目標アーキテクチャ

```text
┌────────────────────────────────────────────┐
│                 SPLL License               │
│                                            │
│ Works / Fee Rules                          │
│       ↓                                    │
│ 原作選択 → 申込 → 契約 → 作品審査 → 認証 │
│                    │                       │
│                    └─ Contract Snapshot    │
└──────────────────────┬─────────────────────┘
                       │
                       │ Finance Handoff
                       ▼
┌────────────────────────────────────────────┐
│                 SPLL Finance               │
│                                            │
│ 利用報告 → 請求 → 入金 → 債権             │
│                      ↓                     │
│ 販売実績 → 突合 → 配分 → 清算             │
│                      ↓                     │
│              各種報告書・計算書           │
└────────────────────────────────────────────┘
```

---

# 4. SPLL License の責務

## 4.1 対象業務

SPLL Licenseは以下を担当する。

1. 原作マスタ管理
2. 利用目的・標準条件管理
3. 原作選択
4. 利用条件提示
5. 規約・個人情報通知の表示・同意
6. SPLL番号発行
7. CloudSignフォームへの引渡
8. 契約締結
9. 契約原本管理
10. 作品提出
11. AI一次審査
12. 人手審査
13. 是正管理
14. 認証発行
15. 認証停止・失効
16. バッジ管理

Financeに属する請求・入金・債権・配分・清算は担当しない。

---

# 5. SPLL Finance の責務

## 5.1 対象業務

SPLL Financeは以下を担当する。

1. Licenseからの契約条件取込
2. 利用報告受付
3. 利用報告承認・差戻し
4. 請求額計算
5. 請求管理
6. 入金管理
7. 入金消込
8. 一部入金・過入金管理
9. 未収債権管理
10. 売上原票取込
11. 契約・原作との突合
12. 権利者別配分
13. 銀行入金照合
14. 権利者清算
15. 仕入明細書等の生成
16. 月次・半期・権利者別等の各種報告書生成

---

# 6. SPLLライセンス台帳の再設計

## 6.1 主台帳 `License_Cases`

1案件1行の主台帳とする。

### 推奨列

| 列 | 内容 |
|---|---|
| `license_id` | SPLL番号。全工程の主キー |
| `application_ref` | 外部フォーム等との突合用参照番号 |
| `party_type` | INDIVIDUAL / SOLE_PROPRIETOR / CORPORATION |
| `party_display_name` | 管理画面表示用契約者名 |
| `usage_category` | 書籍、電子出版物、商品等 |
| `case_status` | 案件全体の状態 |
| `contract_status` | NOT_STARTED / SIGNING / SIGNED / TERMINATED |
| `cloudsign_document_id` | 現行有効契約のCloudSign書類ID |
| `signed_at` | 締結日時 |
| `signed_pdf_file_id` | 締結済PDF |
| `signed_pdf_hash` | PDFハッシュ |
| `review_status` | NOT_REQUIRED / PENDING / IN_REVIEW / CLEARED / CORRECTION_REQUIRED |
| `certification_status` | NOT_ISSUED / ACTIVE / SUSPENDED / REVOKED |
| `finance_handoff_status` | NOT_REQUIRED / READY / SENT / ERROR |
| `created_at` | 作成日時 |
| `updated_at` | 更新日時 |

原則としてこの台帳を契約台帳・ライセンス台帳として使用する。

---

## 6.2 対象原作 `License_Works`

複数原作対応のため、原作だけは別表とする。

| 列 | 内容 |
|---|---|
| `license_work_id` | 行ID |
| `license_id` | SPLL番号 |
| `work_id` | 原作ID |
| `work_name_snapshot` | 契約時原作名 |
| `credit_snapshot` | 契約時クレジット |
| `fee_model_snapshot` | RATE / FLAT / PER_WORK |
| `fee_value_snapshot` | 契約時料率・金額 |
| `reporting_requirement_snapshot` | 利用報告要否 |
| `active` | 有効状態 |

権利者配分・銀行情報等のFinance専用情報はここでは保持しない。

---

## 6.3 契約書履歴 `Contract_Documents`

契約書は1案件1書類とは限らないため、主台帳から分離する。

| 列 | 内容 |
|---|---|
| `contract_document_id` | ID |
| `license_id` | SPLL番号 |
| `document_type` | ORIGINAL / AMENDMENT / TERMINATION / REEXECUTION |
| `version` | 版 |
| `cloudsign_document_id` | CloudSign書類ID |
| `status` | DRAFT / SENT / SIGNED / VOID |
| `signed_at` | 締結日時 |
| `file_id` | PDF |
| `file_hash` | PDFハッシュ |
| `created_at` | 作成日時 |

これにより契約変更・再締結・解除合意等を同一SPLL番号配下で管理できる。

---

# 7. 内部証跡テーブル

以下は台帳画面の主役にはしないが、法務・監査・セキュリティ上維持する。

- `Application_Consents`
- `Webhook_Receipts`
- `Events`
- `System_Errors`
- `Submission_Versions`
- `Submission_Files`
- `AI_Review_Jobs`
- `AI_Findings`
- `Human_Reviews`
- `Certificate_Change_Requests`

---

# 8. CloudSignフォーム簡素化

## 8.1 CloudSignフォームの役割

CloudSignフォームの目的を次の1点へ限定する。

> 契約当事者を特定し、電子契約を成立させるために必要な情報を取得する。

原作・料金・利用条件・審査情報・販売計画等を申込者に再入力させない。

---

## 8.2 ポータルで確定する情報

次はCloudSignフォームの入力項目としない。

- SPLL番号
- 対象原作
- 利用目的
- 利用許諾料
- 料金モデル
- 支払条件
- 利用報告条件
- クレジット条件
- 禁止事項
- 標準特約
- 利用規約
- 個人情報通知

必要なものは表示専用又は契約書へ自動差込する。

---

## 8.3 個人・個人事業主フォーム

### 残す項目

| 項目 | 必須 |
|---|---:|
| 契約者区分 | ○ |
| 氏名 | ○ |
| 屋号・サークル名 | 任意 |
| 住所 | ○ |
| メールアドレス | ○ |
| 未成年確認 | ○ |
| 契約内容確認 | ○ |

### 原則削除

- 氏名フリガナ
- メールアドレス確認欄
- 電話番号
- 適格請求書発行事業者登録番号
- 生年月日（未成年判定を年齢確認で代替できる場合）
- 制作物予定情報
- 販売予定情報

適格請求書発行事業者登録番号は必要時にFinance側で取得する。

---

## 8.4 法人フォーム

### 残す項目

| 項目 | 必須 |
|---|---:|
| 契約者区分 | ○ |
| 法人名 | ○ |
| 所在地 | ○ |
| 契約締結者氏名 | ○ |
| 契約締結者役職 | ○ |
| メールアドレス | ○ |
| 契約締結権限確認 | ○ |

### 原則削除

- 法人名フリガナ
- 法人番号
- 担当部署
- 担当者電話番号
- 適格請求書発行事業者登録番号
- 委任・権限根拠の自由記述

例外案件のみ手動確認で補完する。

---

## 8.5 制作・頒布予定情報

CloudSignフォームから原則として削除する。

対象：

- 制作物・商品名
- 制作者・サークル名
- 制作物概要
- 制作物形態
- 販売・頒布開始予定日
- 販売場所
- 販売予定価格
- 初回製造予定数
- 販売地域
- 使用言語
- 参考URL
- 既公開・既販売情報

必要な情報は以下へ移す。

| 情報 | 取得タイミング |
|---|---|
| 完成作品名 | 作品提出時 |
| 作品概要 | 作品提出時 |
| 販売URL | 作品提出時又はFinance利用報告時 |
| 売上・数量 | Finance利用報告時 |
| 海外・外国語等の例外条件 | 原作選択ポータル又は個別審査 |

---

## 8.6 確認チェック

現行の多数の確認チェックを次の2項目へ集約する。

1. **契約内容確認**
   - 「申込内容及びSPLL利用許諾契約の内容を確認し、これに同意します。」

2. **契約締結権限確認**
   - 「私は本契約を締結する権限を有しています。」

反社、禁止事項、審査、是正、利用報告等は契約本文で規定する。

---

# 9. CloudSignへのhidden値

## 9.1 必須

原則として次だけを必須とする。

```text
license_id
application_ref
handoff_token
```

## 9.2 表示・差込用

契約書生成上必要な場合のみ追加する。

```text
usage_category
work_name_1...
fee_label
credit_text
```

これらは業務処理の正本としない。

締結後の正本はLicense側に保存した契約時スナップショットとする。

---

# 10. License → Finance 引渡仕様

## 10.1 引渡単位

契約締結時に `Finance_Handoffs` を作成する。

LicenseからFinanceを直接呼び出して請求書を作成しない。

---

## 10.2 `Finance_Handoffs`

| 列 | 内容 |
|---|---|
| `handoff_id` | ID |
| `license_id` | SPLL番号 |
| `handoff_version` | 引渡版 |
| `signed_at` | 締結日 |
| `party_display_name` | 契約者表示名 |
| `usage_category` | 利用目的 |
| `works_snapshot_json` | 原作・料金条件スナップショット |
| `billing_terms_json` | Finance用契約条件 |
| `contract_status` | ACTIVE等 |
| `status` | READY / SENT / ACCEPTED / ERROR |
| `created_at` | 作成日 |
| `accepted_at` | Finance受領日 |

---

## 10.3 Finance側の正本化

Financeは受領時に自システムの `Finance_Contracts` へコピーする。

その後の料金計算・請求・清算ではLicenseのマスタを直接参照しない。

---

# 11. SPLL Finance の主要テーブル

## 11.1 最小論理構造

```text
Finance_Contracts
Usage_Reports
Invoices
Payments
Sales
Bank_Transactions
Allocations
Settlements
Reports
Events
```

現行の詳細テーブルは内部実装上必要であれば維持してよいが、管理画面上の業務概念は上記へ整理する。

---

# 12. 現行ソース移管方針

| 現行ファイル | 移管先 | 方針 |
|---|---|---|
| `00_core.gs` | 共通から分割 | License Core / Finance Coreへ分離 |
| `05_schema.gs` | 分割 | License Schema / Finance Schema |
| `10_auth.gs` | 両方 | 各システムRBACへ |
| `15_fee.gs` | 主にLicense | 契約条件確定。Financeはスナップショット利用 |
| `20_tokens.gs` | 分割 | SUBMISSION/BADGE=License、REPORT=Finance |
| `25_portal.gs` | License | 継続 |
| `30_cloudsign.gs` | License | 継続 |
| `32_contract.gs` | License | 請求処理を除去 |
| `35_webhooks.gs` | License | FormRun/CloudSignのみ |
| `37_ai.gs` | License | 継続 |
| `40_public_pages.gs` | 分割 | upload/badge/verify=License、report=Finance |
| `45_settlement.gs` | Finance | 全移管 |
| `47_batches.gs` | 分割 | License Batch / Finance Batch |
| `50_admin.gs` | 分割 | License Admin / Finance Admin |
| `55_accounting_master.gs` | Finance | 全移管 |
| `60_sales_import.gs` | Finance | 全移管 |
| `62_sales_match.gs` | Finance | 全移管 |
| `64_sales_allocation.gs` | Finance | 全移管 |
| `66_bank_reconciliation.gs` | Finance | 全移管 |
| `68_accounting_export.gs` | Finance | 全移管 |
| `69_accounting_jobs.gs` | Finance | 全移管 |

---

# 13. 重要なコード変更

## 13.1 `finishContractLinkage_()` の分解

現行では契約成立後に、

- 認証発行
- バッジ
- 提出トークン
- 報告トークン
- 請求書発行

まで連鎖している。

これを次のように分解する。

```text
finishLicenseActivation_()
  ├─ 認証
  ├─ バッジ
  └─ 提出案内

createFinanceHandoff_()
  └─ Finance引渡データ作成
```

License側では請求書を生成しない。

---

## 13.2 `createInvoiceOnSigning_()` の移管

`32_contract.gs` から削除し、Finance側へ移管する。

Financeは `Finance_Contracts` 取込後に、

- FLAT
- PER_WORK

について必要な債権を生成する。

RATEは利用報告承認時に生成する。

---

## 13.3 利用報告機能の移管

以下をLicense Adminから除去する。

- `admin_listReports`
- `admin_approveReport`
- `admin_returnReport`
- `admin_lockReport`
- `admin_generateInvoicesFromReports`
- `admin_sendReportLink`

Finance側へ移管する。

---

## 13.4 AdminからAccountingコードを除去

現行 `scripts/build.js` ではAdmin配布物にもAccounting系ファイルが含まれている。

Adminから以下を外す。

```text
55_accounting_master.gs
60_sales_import.gs
62_sales_match.gs
64_sales_allocation.gs
66_bank_reconciliation.gs
68_accounting_export.gs
69_accounting_jobs.gs
```

---

# 14. デプロイ構成

## 14.1 論理システムとGASデプロイを分けて考える

業務上は2システムとするが、セキュリティ上、匿名公開と社内管理画面は同一デプロイにまとめない。

### 推奨構成

```text
SPLL License
  ├─ license-portal      匿名公開
  ├─ license-workflow    Webhook / upload / badge / verify
  └─ license-admin       DOMAIN限定

SPLL Finance
  ├─ finance-public      利用報告等のトークン画面
  └─ finance-admin       DOMAIN限定
```

業務上は2システム、技術上は5デプロイとする。

段階移行中は現行4デプロイを維持してもよいが、最終的には上記を推奨する。

---

# 15. スプレッドシート分離

## 15.1 License

```text
SPLL_LICENSE_DB
```

主なシート：

```text
Works
Fee_Rules
License_Cases
License_Works
Contract_Documents
Submissions
Submission_Versions
Submission_Files
AI_Review_Jobs
AI_Findings
Human_Reviews
Certificates
Badges
Application_Consents
Webhook_Receipts
Finance_Handoffs
Events
System_Errors
```

---

## 15.2 Finance

```text
SPLL_FINANCE_DB
```

主なシート：

```text
Finance_Contracts
Usage_Reports
Invoices
Payments
Sales_Imports
Sales_Rows
Bank_Transactions
Allocation_Runs
Allocation_Details
Settlements
Settlement_Details
Settlement_Statements
Reports
Events
System_Errors
```

FinanceはLicense DBを直接更新しない。

---

# 16. 移行計画

## Phase 0：現行凍結・棚卸し

- 現行スキーマのバックアップ
- 本番ScriptProperties一覧取得
- GASデプロイID一覧取得
- CloudSignテンプレート／FormRun設定一覧取得
- 現行テスト全件実行
- 現行業務状態別件数を記録

### 完了条件

現行状態を復元可能なバックアップが存在すること。

---

## Phase 1：新ライセンス台帳追加

新規に以下を追加する。

- `License_Cases`
- `License_Works`
- `Contract_Documents`
- `Finance_Handoffs`

既存の `Applications` / `Contracts` はこの時点では削除しない。

### 移行

既存案件について、

```text
Applications
+
Contracts
+
Contract_Works
```

から `License_Cases` / `License_Works` / `Contract_Documents` を生成する。

### 完了条件

現行全契約が新SPLL番号単位で検索可能であること。

---

## Phase 2：License側UI切替

Admin画面の主表示を `License_Cases` 中心へ変更する。

旧：

```text
申込管理
契約管理
審査管理
入金
経理
...
```

新：

```text
ライセンス
原作
作品審査
認証
契約書
設定
```

ライセンス詳細画面に、

```text
契約
対象原作
作品提出
審査
認証
契約書履歴
証跡
```

をまとめる。

### 完了条件

通常業務で `Applications` / `Contracts` の直接一覧を参照しなくてよいこと。

---

## Phase 3：CloudSignフォーム簡素化

新CloudSign/FormRunフォームを作成する。

### 実施事項

- 制作・頒布予定情報を削除
- Finance情報を削除
- 契約者情報を最小化
- hidden項目を最小化
- 契約書テンプレートを修正
- `license_id` を主参照番号へ変更
- 例外案件を手動処理へ送る

### 完了条件

通常案件のフォーム入力項目が概ね7項目前後で完了すること。

---

## Phase 4：Finance分断

- `SPLL_FINANCE_DB` 作成
- `Finance_Contracts` 作成
- 利用報告移管
- 請求移管
- 入金移管
- Accounting系処理移管
- Finance Admin作成

### 完了条件

License側からInvoices、Payments、Settlementsを更新するコードがなくなること。

---

## Phase 5：システム間引渡切替

契約締結時に、

```text
Finance_Handoffs = READY
```

を生成する。

Finance側の取込処理で、

```text
READY
→ ACCEPTED
```

とし、`Finance_Contracts` に保存する。

冪等キー：

```text
license_id + handoff_version
```

### 完了条件

同じ引渡を複数回実行してもFinance契約が重複しないこと。

---

## Phase 6：旧テーブル読取専用化

以下を新規書込禁止とする。

- `Applications`
- `Application_Works`
- `Contracts`
- `Contract_Works`

移行検証後、旧テーブルはLegacy領域へ移す。

いきなり削除しない。

---

# 17. テスト計画

## 17.1 License

最低限次を確認する。

1. 個人の新規申込
2. 個人事業主の新規申込
3. 法人の新規申込
4. 複数原作
5. 定額契約
6. RATE契約
7. CloudSign締結
8. Webhook重複
9. 契約突合不能
10. 契約変更
11. 作品提出
12. AI審査
13. 人手審査
14. 是正再提出
15. 認証発行
16. 認証停止・取消
17. Finance引渡

---

## 17.2 Finance

1. Finance契約取込
2. 重複取込
3. 定額債権
4. RATE利用報告
5. 利用報告差戻し
6. 請求
7. 一部入金
8. 全額入金
9. 過入金
10. 入金取消
11. 未収債権
12. 売上取込
13. 原作突合
14. 権利者配分
15. 銀行照合
16. 清算
17. 計算書
18. 各種報告書

---

# 18. 受入基準

## 18.1 業務分断

- LicenseからFinanceの請求・入金・清算テーブルを直接更新しない
- FinanceからLicenseの契約・認証テーブルを直接更新しない
- システム間連携はFinance Handoffを介する

---

## 18.2 台帳

- 1つのSPLL番号で申込から認証まで追跡できる
- 契約書の履歴を1:Nで参照できる
- 契約者、原作、利用目的、契約状態、審査状態、認証状態を一覧で確認できる
- 日常運用で旧Applications/Contracts一覧を参照しなくてよい

---

## 18.3 CloudSignフォーム

通常案件では入力項目を次の水準まで削減する。

### 個人

概ね6～7項目。

### 法人

概ね7項目。

以下を通常フォームから除外する。

- 制作計画
- 販売計画
- 売上予定
- 数量予定
- Finance情報
- 条件の再入力
- 多数の個別確認チェック

---

## 18.4 Finance

- 契約時スナップショットのみで債権計算可能
- Licenseマスタ変更が過去請求・配分へ影響しない
- 入金残高と債権残高を独立管理できる
- Financeだけで利用報告から各種報告書作成まで完結する

---

# 19. 実装優先順位

### P0

1. `License_Cases` 設計・追加
2. `License_Works` 設計・追加
3. `Contract_Documents` 設計・追加
4. 既存データ移行
5. License Adminを新台帳中心へ変更
6. CloudSignフォーム簡素化
7. `finishContractLinkage_()` から請求処理を除去
8. `Finance_Handoffs` 実装

### P1

9. SPLL Finance DB作成
10. 利用報告移管
11. Invoices / Payments移管
12. Accountingモジュール完全移管
13. Finance Admin構築
14. AdminからAccountingコードを除去

### P2

15. 旧Applications / Contractsの書込停止
16. 旧Finance関連シートの書込停止
17. 物理デプロイ分離
18. Legacy整理

---

# 20. 最初に実装する変更単位

最初の実装は次の1セットとする。

```text
① License_Cases
② License_Works
③ Contract_Documents
④ Finance_Handoffs
⑤ 既存データ変換
⑥ Admin一覧をLicense_Casesへ切替
⑦ finishContractLinkage_の分解
```

この段階ではFinanceそのものはまだ移動しない。

まず、

> **「契約・ライセンス管理を単独で完結できる状態」**

を作る。

その後Financeを切り離す。

これにより、一度に全面置換するよりも移行リスクを抑えられる。

---

# 21. 完成後の業務イメージ

## SPLL License

```text
原作を選ぶ
  ↓
利用目的を選ぶ
  ↓
条件を確認する
  ↓
SPLL番号発行
  ↓
最小CloudSignフォーム
  ↓
契約締結
  ↓
作品提出
  ↓
審査
  ↓
認証
```

## SPLL Finance

```text
契約情報受領
  ↓
利用報告
  ↓
債権確定
  ↓
請求
  ↓
入金・消込
  ↓
未収管理
  ↓
売上突合
  ↓
配分
  ↓
清算
  ↓
報告書・計算書
```

---

# 22. 結論

本改修では、「一気通貫のSPLLシステム」を単純に2つの画面へ分けるのではなく、

1. **SPLL番号中心のライセンス台帳へ再構成する**
2. **業務台帳と契約台帳を統合する**
3. **CloudSignフォームを契約者特定に必要な最小情報へ縮小する**
4. **契約成立とFinance処理の間に明確な引渡境界を置く**
5. **Financeを独立した債権・入金・報告システムとして成立させる**

ことを実装の中心とする。

特に、第1段階ではFinanceの全面移行より先に、`License_Cases` を正本化して契約管理側を簡素化することを優先する。

---

# 23. 実装状況

> **方針転換（2026-08-12）**：経理（Finance）は本システムの外で独自運用を構築することが決定した。
> 本計画の「Finance側」実装（利用報告・請求・入金・清算・経理連携GAS④）は**全削除**し、
> 本システムは**契約管理（作品の認証管理・バッジ・検証を含む）専用**とする。
> License→経理の境界は `Finance_Handoffs`（締結スナップショットのREADY引渡）として存置し、
> 経理側の独自運用がこれを参照する。P1（Finance DB分離）・P2は対象外となった。

| 項目（§19/§20） | 状態 |
|---|---|
| ① License_Cases | **実装済**：SCHEMA_OPSへ追加。申込時に`newId_('SPLL')`でSPLL番号発行・1案件1行 |
| ② License_Works | **実装済**：費用＝契約形態（利用目的）×原作構造をポータルで自動確定しスナップショット |
| ③ Contract_Documents | **実装済**：締結ごとにORIGINAL等を1:N追記（PDF・ハッシュ） |
| ④ Finance_Handoffs | **実装済**：締結でREADY作成（冪等・license_id+version）。取込（ACCEPTED化）・請求は経理側の独自運用 |
| ⑤ 既存データ変換 | **実装済**：`setup_migrateLicenseCases`（冪等・旧締結分はACCEPTED扱い・setup_allに組込み） |
| ⑥ Admin一覧切替 | **実装済**：「ライセンス」タブ（License_Cases一覧＝SPLL番号/契約者/状態/経理引渡・旧契約ID併記） |
| ⑦ finishContractLinkage_分解 | **実装済**：`finishLicenseActivation_`（認証・バッジ・提出）＋`createFinanceHandoff_`。請求生成は削除 |
| CloudSignフォーム簡素化（P0-6） | **実装済（システム側）**：hidden最小化（license_id/application_ref/handoff_token＋表示用）・契約者区分でフォームURL切替（FORM_URL_INDIVIDUAL/CORPORATION）・契約者名/区分の台帳自動反映。フォーム項目設計v2.0（SPLL-SYS-FD-002）を発行。formrun側の作り直しは利用者作業 |
| Finance領域（利用報告・請求・入金・清算・経理連携GAS④） | **削除済**（2026-08-12 方針転換：経理は独自運用） |
| テスト | harness 212件／sec01 21件 全通過（Finance関連テストを剪定） |
