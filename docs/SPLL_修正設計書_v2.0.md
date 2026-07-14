# SPLL申込・契約・作品審査・報告・清算システム 修正設計書 v2.0

| 項目 | 内容 |
|---|---|
| 文書番号 | SPLL-SYS-RD-002 |
| 版数 | v2.0 |
| 作成日 | 2026年7月14日 |
| 対象リポジトリ | `tatsuyakuramchi/SPLL` |
| 基準ブランチ | `claude/new-design-implementation-wlqwv9` |
| 基準コミット | `545c69221611b33c57927e43cb2f5719e4d31b81` |
| ステータス | Draft（実装・受入確認前） |

---

## 1. 目的

本書は、SPLLシステムの現行実装を本番運用可能な状態へ移行するため、再レビューで確認された残課題について、修正対象、具体的な変更仕様、データ移行、例外処理、テスト及び完了条件を定めるものである。

v1で指摘した匿名管理操作、Webhook真正性、入力検証、利用報告・請求処理等については相当程度改善されている。本v2では、次の残課題を中心に扱う。

1. 誤デプロイ時にモノリス版が匿名公開される危険
2. 既存スプレッドシートに対するスキーマ移行不足
3. 同意操作と同意証跡の不一致
4. Webhook・契約作成等の並行実行時の重複処理
5. 利用報告・入金・請求の状態管理不足
6. 清算における契約時スナップショット未使用
7. バッジ・認証の配布及び再発行処理の未完成
8. AI審査、通知期限、承認分離等の業務フロー不整合

---

## 2. 現状評価

### 2.1 総合判定

現行実装は、ステージング環境での結合試験を開始できる水準に達している。一方、P0課題が残っているため、本番公開の承認条件は未充足とする。

| 評価領域 | 現状 | 判定 |
|---|---|---|
| 3GAS分離 | 配布ビルド及び個別マニフェストあり | 概ね適合 |
| 管理者認証 | サーバー側RBACあり | 適合 |
| Webhook真正性 | 共有秘密及びCloudSign API照会あり | 条件付き適合 |
| ファイル提出 | サイズ・拡張子・MIME・マジックバイト検証あり | 適合 |
| トークン | ハッシュ、期限、用途、回数管理あり | 条件付き適合 |
| 同意証跡 | 文書版・ハッシュ保存あり | 不十分 |
| 利用報告・請求 | 承認、ロック、請求起票あり | 条件付き適合 |
| 入金管理 | 一件入金を前提とする実装 | 不十分 |
| 清算 | 原作単位配分、仕入明細書生成あり | 不十分 |
| バッジ・認証 | 発行、検証、DL導線あり | 不十分 |
| テスト | インメモリ機能テストあり | 条件付き適合 |

### 2.2 本番停止条件

以下のP0項目が未完了の場合、本番デプロイを行わない。

- モノリス版のデプロイ経路廃止
- `ENVIRONMENT=production` の明示及びフェイルクローズ
- 既存シートのスキーマ移行
- productionにおける公開済規約・個人情報通知の必須化
- Webhook及び契約作成の排他・冪等化
- 請求書と入金の整合性検証
- 清算における契約時スナップショットの使用
- 実サービスを用いたステージング結合試験

---

## 3. 修正後の基本原則

### 3.1 フェイルクローズ

設定不足、認証不能、外部API照合不能、規約未公開等の場合、productionでは処理を継続しない。開発用フォールバックは、明示的な開発フラグが設定されている場合に限る。

### 3.2 配布単位の物理分離

正本ソースは共有してよいが、実際にGASへ配布されるファイル及び権限は次の3プロジェクトに限定する。

| GAS | 公開範囲 | 主機能 | 禁止する機能 |
|---|---|---|---|
| GAS① Portal | 匿名公開 | 原作一覧、条件表示、申込作成 | 管理、Webhook、提出、清算 |
| GAS② Workflow | 匿名公開 | Webhook、提出、報告、認証照会 | 管理画面、設定変更 |
| GAS③ Admin | Google Workspaceドメイン限定 | 管理、審査、請求、清算、設定 | 匿名利用者向け画面 |

### 3.3 契約時点情報の不変化

契約成立後の請求、清算、認証及び表示には、現在のマスタではなく契約時に保存したスナップショットを使用する。

### 3.4 状態遷移の明示

状態更新は任意文字列の上書きではなく、許可された遷移だけを受け付ける。

### 3.5 外部送信の冪等性

CloudSign、X、通知その他の外部送信は、送信要求ID、外部ID及び送信状態を保存し、再実行しても二重送信しない。

### 3.6 証跡の分離

業務データ、監査証跡、システムエラー及び認証失敗ログを分離する。攻撃的な大量アクセスを業務スプレッドシートへ一件ずつ追記しない。

---

# 4. P0：本番前の必須修正

## 4.1 P0-01 モノリス版デプロイ経路の廃止

### 対象

- `package.json`
- `spll_src/appsscript.json`
- `spll_src/90_main.gs`
- `.claspignore`
- `scripts/build.js`
- CI設定

### 修正仕様

1. ルートディレクトリから直接実行する次のスクリプトを廃止する。
   - `npm run push`
   - `npm run deploy`
   - `npm run create`
   - `npm run setup`
2. 正式な配布コマンドを次に限定する。
   - `push:portal`
   - `push:workflow`
   - `push:admin`
   - `push:all`
3. `spll_src/appsscript.json` は削除するか、デプロイ不可能な参照用ファイルへ移動する。
4. `90_main.gs` は `reference/` 配下へ移動するか、CIで配布対象外であることを検証する。
5. `scripts/build.js` は各distについて禁止関数の混入を検証する。

### 禁止関数例

- portal：`admin_`、`receiveWebhook_`、`web_submitWork`、`report_submit`
- workflow：`admin_save`、`setup_reset`、`setup_setInitialAdmin`
- admin：匿名利用者用の提出・報告トークン受付エントリ

### 環境制御

`env_()` は未設定をdevelopmentとせず、次の仕様へ変更する。

```javascript
function env_(){
  const v = prop_('ENVIRONMENT');
  if (!v) throw new Error('ENVIRONMENT is required');
  if (['development','staging','production'].indexOf(v) < 0)
    throw new Error('Invalid ENVIRONMENT: ' + v);
  return v;
}
```

開発用匿名bootstrapは、`ENVIRONMENT=development` かつ `ALLOW_DEV_BOOTSTRAP=true` の双方を満たす場合に限る。

### 受入基準

- ルートから`clasp push`しても本番用GASへ配布できない
- productionで`ENVIRONMENT`未設定の場合、起動時に停止する
- Portal distに管理関数が含まれない
- Admin manifestが`DOMAIN`以外の場合、CIが失敗する
- Workflow及びPortalの権限が必要最小限である

---

## 4.2 P0-02 スキーマ移行機構の追加

### 問題

現行の`initSheets_()`は既存ヘッダがある場合に不足列を追加しない。このため、コード上は新項目を保存していても、既存環境では値が静かに欠落する。

### 追加テーブル

#### Schema_Versions

| 列 | 内容 |
|---|---|
| schema_name | `MASTER`又は`OPS` |
| version | 適用済スキーマ版 |
| applied_at | 適用日時 |
| applied_by | 実行者 |
| checksum | ヘッダ定義のハッシュ |

#### Migration_Runs

| 列 | 内容 |
|---|---|
| migration_run_id | 実行ID |
| migration_name | 移行名 |
| started_at | 開始日時 |
| finished_at | 完了日時 |
| status | RUNNING／DONE／ERROR |
| before_snapshot | 移行前情報 |
| after_snapshot | 移行後情報 |
| error_detail | エラー内容 |

### 実装仕様

1. `migrateSchema_()`を追加する。
2. 各シートの現在ヘッダを読み、不足列を末尾へ追加する。
3. 既存列の削除及び順序変更は自動で行わない。
4. 列名重複、空列、想定外列は警告として記録する。
5. 移行は`LockService`で排他する。
6. 移行前後の行数、主要金額合計、主キー重複数を記録する。
7. productionでは`setup_reset()`を無効化する。
8. productionではサンプル投入を常に禁止する。

### 初回移行対象

- `Contracts.contract_file_id`
- `Contracts.contract_file_hash`
- `Contract_Works.*_snapshot`
- `Access_Tokens.max_uses`、`used_count`、`revoked_at`
- `AI_Review_Jobs`の結果・証跡列
- `Invoices`の税率・税額・税込額・支払期日・取消理由
- `Payments`の取消理由
- `Legal_Documents`
- `Application_Consents`
- `Notification_Queue`
- 本書で追加する各列

### 受入基準

- 旧スキーマのテストデータに対して移行を実行し、新規列が追加される
- 移行を2回実行しても列が重複しない
- 既存行数及び金額合計が変化しない
- 移行失敗時に`Migration_Runs=ERROR`となる

---

## 4.3 P0-03 規約公開及び同意証跡の厳格化

### API変更

現行：

```javascript
web_createApplication(workIds, usageCategory)
```

修正後：

```javascript
web_createApplication({
  workIds,
  usageCategory,
  privacyConsent,
  termsConsent,
  privacyDocumentId,
  termsDocumentId,
  consentSessionId
})
```

### サーバー側検証

1. `privacyConsent === true`
2. `termsConsent === true`
3. 指定文書IDが現在有効な`PUBLISHED`文書である
4. 文書の`effective_from`が現在以前である
5. `effective_to`が空又は現在より後である
6. 画面表示時の文書IDと申込送信時の文書IDが一致する
7. productionではフォールバック文書を使用しない

### Application_Consents追加列

| 列 | 内容 |
|---|---|
| legal_document_version | 同意版番号 |
| consent_session_id | ブラウザで生成した申込セッションID |
| display_hash | 画面表示内容のハッシュ |
| accepted | true |
| accepted_at | サーバー受信日時 |
| evidence_version | 証跡仕様版 |

### 法務文書の公開要件

productionでは、PRIVACY及びTERMSの双方に有効な`PUBLISHED`版がない場合、申込画面に受付停止を表示し、申込作成を拒否する。

既定文中の以下の暫定記載は、本番前に確定文へ置き換える。

- 個人情報に関する問い合わせ窓口
- 解除の遡及・非遡及
- 管轄裁判所の具体的表示
- Geminiを含む委託先・国外移転・データ所在の説明

### 受入基準

- チェックなしの直接API呼出しが拒否される
- 古い文書IDによる申込が拒否され、再表示を促す
- 申込から同意文書の完全な版・ハッシュを復元できる
- productionで未公開文書へのフォールバックが発生しない

---

## 4.4 P0-04 Webhook受信及び契約作成の冪等化

### Webhook_Receipts追加列

| 列 | 内容 |
|---|---|
| idempotency_key | `provider:eventId`又はpayload hash |
| processing_started_at | 処理開始日時 |
| processing_owner | 実行ID |
| manual_review_reason | 手動確認理由 |
| next_retry_at | 次回再試行日時 |

### 状態

`RECEIVED` → `PROCESSING` → `PROCESSED`

例外時：

- 回復可能：`RETRY_WAIT`
- 参照番号欠落等：`MANUAL_REVIEW`
- 認証失敗：`REJECTED`
- 再試行上限超過：`DEAD_LETTER`

### 処理仕様

1. `receiveWebhook_()`で受信記録を作る前に、短時間のレート制限を適用する。
2. 署名不一致は業務スプレッドシートへ一件ずつ保存せず、集約カウンタ及びCloud Loggingへ記録する。
3. `processWebhookReceipts_()`は`LockService`で対象行を`PROCESSING`へ確保する。
4. `processCloudSignEvent_()`はCloudSign書類ID単位で排他する。
5. 契約作成前に同一`cloudsign_document_id`の再確認を行う。
6. `no-ref`及び`app-not-found`は成功扱いにせず`MANUAL_REVIEW`へ送る。
7. CloudSign API照会により、書類状態、書類ID及び必要な契約情報を確認する。
8. 外部API照合不能時は契約を作らず再試行する。

### Contracts制約

論理的に次を一意とする。

- `cloudsign_document_id`
- 一つの`application_id`に対する有効な契約

SpreadsheetではDB制約を設定できないため、書込前後の二重チェック、ロック及び日次整合性チェックを併用する。

### 受入基準

- 同一Webhookを同時に10件送っても契約は1件のみ
- 同一payloadの再送は`dup`として終了する
- refなしイベントは`MANUAL_REVIEW`へ残る
- CloudSign照合不能時に契約が作成されない

---

## 4.5 P0-05 利用報告の入力・期間検証

### 入力検証

`num_()`による寛容な変換を公開入力に使用しない。次の厳格関数を追加する。

```javascript
function requireNonNegativeNumber_(value, fieldName) {
  if (value === '' || value === null || value === undefined) throw new Error(fieldName + ' is required');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(fieldName + ' must be a non-negative number');
  return n;
}
```

### 報告可能期間

1. 契約の`terms_snapshot`から報告要否及び報告期限を判定する。
2. `period`を利用者に自由入力させず、サーバーが選択肢を返す。
3. 許容形式は`YYYYH1`又は`YYYYH2`に限定する。
4. 将来期及び契約締結前の期を拒否する。
5. RATE以外でも`reporting_requirement`がある契約は報告対象とする。
6. 返品、控除、売上の関係を検証する。
7. URLは許可スキーム、最大長及び危険文字を検証する。

### 訂正フロー

`SUBMITTED` → `RETURNED` → 新規訂正版`SUBMITTED`

旧報告は削除せず`SUPERSEDED`へ遷移し、新報告の`supersedes_report_id`を保存する。

### 受入基準

- 不正数値文字列が0として登録されない
- 対象外期間の報告が拒否される
- イベント等の定額契約でも報告義務があれば通知・提出できる
- 訂正前後の報告履歴を追跡できる

---

## 4.6 P0-06 請求・入金状態管理の再設計

### Invoices状態

- `DRAFT`
- `ISSUED`
- `UNPAID`
- `PARTIALLY_PAID`
- `PAID`
- `OVERPAID`
- `VOID`

### Payments状態

- `RECORDED`
- `VOID`

### 追加列

#### Invoices

- `paid_amount`
- `balance_amount`
- `payment_status_updated_at`
- `currency`
- `invoice_number`

#### Payments

- `payment_reference`
- `method`
- `note`
- `voided_at`
- `voided_by`

### 入金登録仕様

1. 請求書の存在を最初に確認する。
2. 引数の契約IDと請求書の契約IDを照合する。
3. `VOID`請求への入金を拒否する。
4. 同一`payment_reference`の重複を拒否する。
5. 入金後、取消されていないPaymentsを合計する。
6. 税込請求額と累計入金額を比較し状態を決定する。
7. 一部入金を許容する。
8. 過入金を`OVERPAID`として表示し、解消理由を記録する。
9. 入金取消後に状態及び残額を再計算する。

### 請求書発行

請求行を作るだけでなく、少なくとも次を固定する。

- 課税区分
- 税率
- 税額端数処理
- 税込額
- 支払期日
- 利用目的
- 対象原作
- 契約ID
- 適格請求書発行事業者情報

### 受入基準

- 存在しない請求IDへの入金が登録されない
- 別契約の請求に入金を付けられない
- 50%入金で`PARTIALLY_PAID`となる
- 全額入金で`PAID`となる
- 超過入金で`OVERPAID`となる
- 取消後に残額・状態が正しく戻る

---

## 4.7 P0-07 清算のスナップショット化及び送信冪等性

### 契約時スナップショット追加

`Contract_Works`に次を追加又は確実に保存する。

- `partner_id_snapshot`
- `partner_name_snapshot`
- `invoice_reg_number_snapshot`
- `allocation_scheme_snapshot`
- `allocation_ratio_snapshot`
- `royalty_rate_snapshot`
- `handling_fee_rate_snapshot`
- `credit_snapshot`

清算時は`Works_Master.partner_id`や出版社文字列による再解決を原則禁止する。

### 清算生成単位

「対象期に計算書が1件あれば全件スキップ」を廃止し、次の単位で生成済みを判定する。

- `report_id`
- `partner_id_snapshot`
- `statement_version`

`Settlement_Details`に`report_id`を追加する。

### Settlement_Statements追加列

- `cloudsign_document_id`
- `send_attempt_id`
- `send_status`
- `send_error`
- `approved_by`
- `approved_at`
- `objection_note`
- `objection_received_at`

### 送信状態

`DRAFT` → `APPROVED` → `SENDING` → `OBJECTION_PERIOD`

送信結果不明：`SEND_UNKNOWN`

送信失敗：`SEND_FAILED`

`SEND_UNKNOWN`の場合は、CloudSign APIで書類タイトル、送信先、ファイル等を照合し、再送前に外部書類の存在を確認する。

### 仕入明細書の記載

- 発行者情報
- 相手方名称
- 登録番号
- 対象期間
- 原作名
- 契約ID
- 売上
- 許諾料率
- 事務手数料率
- 配分率
- 配分額
- 税区分及び税額が必要な場合の表示
- 異議申立期限
- 異議申立方法

### 受入基準

- 契約後に作品マスタの権利者を変更しても過去契約の配分先が変わらない
- 後から承認された報告だけを追加清算できる
- CloudSign送信後の台帳更新失敗を再現しても二重送信しない
- 計算書から各報告及び契約へ遡及できる

---

## 4.8 P0-08 実サービス結合試験

### 対象

- Google Apps Script実環境
- Google Drive共有ドライブ又は検証用Drive
- CloudSignサンドボックス
- FormRun検証フォーム
- Vertex AI Gemini検証プロジェクト

### 必須シナリオ

1. 原作1件、定額契約
2. 原作5件、原作数比例契約
3. 売上連動契約
4. FormRunからCloudSignへの参照番号引継ぎ
5. CloudSign締結Webhookの正常処理
6. Webhook重複送信
7. 参照番号なし締結の手動紐付け
8. 提出ファイル正常・異常形式
9. AI審査失敗・再試行
10. 是正要求・再提出
11. 利用報告・差戻し・再報告
12. 一部入金・全額入金・過入金・取消
13. 計算書生成・承認・CloudSign送信
14. 異議申立・みなし確認・確定
15. 認証失効後の検証画面

### 完了条件

- 全シナリオの証跡がスプレッドシート、Drive及びEventsに残る
- 手動復旧手順が確認できる
- 権限不足時に処理が拒否される
- 外部API失敗時に二重処理が生じない

---

# 5. P1：本番初期運用までに修正する項目

## 5.1 P1-01 バッジ・認証の完成

### 修正内容

1. クレジットは`Contract_Works.credit_snapshot`から生成する。
2. URL文字列ではなく実際のQRコード画像をバッジへ挿入する。
3. バッジファイルを`ANYONE_WITH_LINK`で公開しない。
4. GASがトークン検証後に画像を返す構成へ変更する。
5. 照合コード生成に`Math.random()`を使用しない。
6. 認証コード再発行時にバッジも再生成する。
7. バッジDLページ表示のたびに旧トークンを失効・再発行しない。
8. 発行失敗時に再実行可能な`Badge_Jobs`を追加する。

### Badge_Jobs状態

`QUEUED` → `GENERATING` → `ISSUED`

例外：`ERROR`、`RETRY_WAIT`

### 受入基準

- DriveのURLだけでは画像を取得できない
- QRから正しい認証画面を開ける
- 認証コード再発行後、旧QRは無効、新QRは有効となる
- バッジに契約時クレジットが表示される

---

## 5.2 P1-02 AI審査の個人情報・証跡強化

### 修正内容

- Gemini送信対象に個人情報が含まれ得ることを法務文書へ明示する
- GCPプロジェクト、リージョン、ログ保持、学習利用条件を確定する
- AI出力の全文字列にSpreadsheet数式無害化を行う
- `recommended_action`をAI_Findingsへ保存する
- AIジョブ取得を排他し、同一ジョブの二重実行を防止する
- 原本、AI入力コピー、生レスポンスの保有期間を定義する
- AI失敗時は人手審査へ回せる状態を追加する

### 状態追加

- `AI_UNAVAILABLE`
- `MANUAL_REVIEW_REQUIRED`

AIが利用不能でも提出自体を消失させず、管理画面から人手審査へ進める。

---

## 5.3 P1-03 通知期限及びSLA計算の修正

### 問題

- 再提出時に初回提出日時を参照している
- 報告期間が固定月判定である
- RATE契約以外の報告義務を除外している

### 修正内容

1. SLAは`Submission_Versions.submitted_at`の最新版を使用する。
2. 再提出時に審査期限を再計算する。
3. 報告要否は`terms_snapshot.reporting_requirement`で判断する。
4. 報告期限は`report_due`の構造化値から計算する。
5. 固定文言ではなく、次の構造化列をFee_Scheduleへ追加する。

- `report_frequency`
- `report_due_days`
- `report_due_base`
- `requires_usage_report`

6. 通知キューには期限、通知対象、対応方法を保存する。

---

## 5.4 P1-04 認証状態変更の職務分離

### 修正内容

重要状態への変更は申請と承認を分ける。

対象状態：

- `REVOKED`
- `TERMINATED`
- `PAYMENT_HOLD`
- `ACTIVE`への再有効化

### 追加テーブル Certificate_Change_Requests

| 列 | 内容 |
|---|---|
| request_id | 申請ID |
| cert_id | 認証ID |
| requested_status | 変更後状態 |
| reason_code | 理由コード |
| reason_text | 理由 |
| legal_case_id | 法務案件ID |
| requested_by | 申請者 |
| requested_at | 申請日時 |
| approved_by | 承認者 |
| approved_at | 承認日時 |
| status | REQUESTED／APPROVED／REJECTED／APPLIED |

同一人物による申請・承認は原則拒否する。緊急処理の場合は`EMERGENCY_OVERRIDE`と理由を必須とする。

---

# 6. P2：安定運用・保守性の改善

## 6.1 実行監視

- 5分バッチの連続失敗
- WebhookのDEAD_LETTER
- AIジョブERROR
- 未紐付け契約
- 支払期限超過
- 清算送信失敗
- 保有期間削除失敗

これらを管理ダッシュボードの主要アラートとして表示する。

## 6.2 性能改善

現在の`readRows_()`は多くの処理で全件読取を行う。データ増加に備え、次を実施する。

- 同一処理内の読取結果をキャッシュ
- バッチ対象の期間・状態を限定
- 大量行更新を`setValues()`で一括処理
- 日次アーカイブ又は年度別シート分割の基準を定義

## 6.3 運用手順書

次の手順を文書化する。

- 初期セットアップ
- スキーマ移行
- 3GASデプロイ
- ScriptProperties設定
- CloudSign・FormRun Webhook設定
- 未紐付け契約の解消
- AI再試行
- 入金訂正
- 清算再送
- 認証停止・再有効化
- 障害時のロールバック

---

# 7. 実装バックログ案

| ID | 優先度 | 件名 | 主対象 |
|---|---:|---|---|
| V2-001 | P0 | モノリスデプロイ経路を廃止する | package/build/manifest |
| V2-002 | P0 | ENVIRONMENTを必須化しフェイルクローズする | core/auth |
| V2-003 | P0 | スキーマ移行・Migration_Runsを実装する | schema/setup |
| V2-004 | P0 | productionのサンプル投入とresetを禁止する | setup |
| V2-005 | P0 | 同意APIとApplication_Consentsを厳格化する | portal/legal |
| V2-006 | P0 | productionで公開済法務文書を必須化する | legal/portal |
| V2-007 | P0 | Webhook受信を排他・冪等化する | webhook |
| V2-008 | P0 | no-ref等を手動確認キューへ送る | webhook/admin |
| V2-009 | P0 | 利用報告の数値・期間・訂正を厳格化する | report |
| V2-010 | P0 | 請求・入金を累計残高方式へ変更する | invoice/payment |
| V2-011 | P0 | 清算で契約時スナップショットを使用する | settlement |
| V2-012 | P0 | CloudSign計算書送信を冪等化する | settlement/cloudsign |
| V2-013 | P0 | 実サービス結合テストを追加する | staging/test |
| V2-014 | P1 | バッジを非公開配布・QR対応する | badge |
| V2-015 | P1 | 認証コードとバッジ再発行を連動する | certificate/badge |
| V2-016 | P1 | AI出力無害化・二重実行防止を実装する | AI |
| V2-017 | P1 | 報告期限・審査SLAを契約条件ベースにする | batch/notification |
| V2-018 | P1 | 認証状態変更の申請・承認を分離する | certificate/admin |
| V2-019 | P2 | 障害監視ダッシュボードを強化する | admin |
| V2-020 | P2 | 運用手順書・復旧手順を整備する | docs |

---

# 8. テスト計画

## 8.1 単体テスト

- 状態遷移関数
- 同意文書ID検証
- 厳格数値変換
- 入金累計・残額計算
- 配分端数計算
- 報告期限計算
- スキーマ差分検出
- トークン期限・回数・失効

## 8.2 並行実行テスト

- 同一Webhookの同時受信
- 同一請求への同時入金
- 同一AIジョブの同時実行
- 同一計算書の同時送信
- 同一トークンの上限直前での同時利用

## 8.3 セキュリティテスト

- 匿名管理関数呼出し
- 別ロールによる権限外操作
- 未署名Webhook
- URL共有秘密の総当たり
- 巨大base64及び偽装MIME
- 数式インジェクション
- 古い規約版を用いた申込
- 他契約のsubmission_id指定
- 他契約のinvoice_id指定

## 8.4 移行テスト

- v1旧ヘッダからv2へ移行
- 既存金額・件数の不変確認
- 途中失敗後の再実行
- 新旧コードのロールバック可能性確認

---

# 9. 完了定義

本修正案v2は、次の全条件を満たした時点で完了とする。

1. P0バックログがすべて完了している
2. 既存データに対するスキーマ移行が成功している
3. 3GAS以外のデプロイ経路が存在しない
4. production設定不足時に処理が停止する
5. 規約・個人情報通知の公開版なしでは申込できない
6. Webhook同時実行で重複契約が生成されない
7. 請求・入金・残額・取消の整合性が保たれる
8. 清算が契約時スナップショットに基づいている
9. CloudSign計算書の二重送信が防止されている
10. 実サービス結合試験が完了している
11. 障害復旧及び手動処理の運用手順が存在する
12. 法務、経理、事務局及びシステム管理者が受入確認を行っている

---

# 10. 要決定事項

実装開始前に次を確定する。

1. 本番個人情報問い合わせ窓口
2. 契約解除の遡及・非遡及
3. Gemini利用リージョン及びデータ取扱条件
4. 税額端数処理単位
5. 一部入金及び過入金の経理運用
6. 仕入明細書の税務上の記載内容
7. 配分方式を契約単位、原作単位、権利者単位のいずれで固定するか
8. 認証停止における緊急例外手続
9. 報告義務の対象となる料金区分
10. 未成立申込、提出物、AI証跡、契約、請求及び清算証跡の保有期間

以上
