# SPLL CloudSign FORM 実装仕様 v2.1

**文書番号:** SPLL-FORM-FD-002  
**版数:** v2.1  
**作成日:** 2026-08-12  
**関連:** `SPLL_利用許諾契約書_CloudSign_FORM対応_v4.0.md`  
**変更点:** CloudSign FORMの実製品仕様に合わせ、ユーザー入力項目とシステム引継ぎ項目を明確に分離

---

## 1. 結論

CloudSign FORM powered by formrunでは、フォーム入力情報をCloudSignテンプレートへ反映し、指定されたメールアドレスへ契約書を自動送信する。

そのためSPLLでは、次の責任分担とする。

```text
SPLLポータル
  原作・利用区分・料金等を確定
        ↓
CloudSign FORM
  利用者は契約者情報だけ入力
  SPLL確定条件はシステム項目として引継ぎ
        ↓
CloudSign
  完成済み契約書PDFを確認
  「同意して確認完了」
        ↓
契約成立
```

**FORMの画面を簡素化することと、CloudSignテンプレートへ渡すシステム項目を減らすことは別問題である。**

個別条件を契約書へ自動反映するため、利用者には表示・入力させないシステム項目をFormRunへ引き継ぐ。

---

## 2. 契約成立点

- SPLLポータルでの申込作成：契約未成立
- CloudSign FORM送信：契約未成立
- formrunからCloudSignへの契約書自動送信：契約未成立
- CloudSign上で利用者が契約書を確認し、所定の同意操作を完了：**契約成立**

申込フォーム上ではSPLL利用許諾契約本文への同意を取得しない。

ポータルで取得する法務証跡は原則として次の2点のみとする。

1. 個人情報の取扱いへの同意
2. SPLL二次創作ガイドラインの確認

---

## 3. ユーザー入力項目

現行制度では法人を標準SPLL契約の対象外とするため、通常のCloudSign FORMは個人用とする。

| 項目 | 必須 | 用途 |
|---|---:|---|
| 氏名 | ○ | 契約当事者 |
| 屋号・サークル名 | 任意 | 契約書表示補助 |
| 郵便番号 | ○ | 住所入力補助 |
| 住所 | ○ | 契約当事者特定 |
| メールアドレス | ○ | CloudSign送信先 |
| 成年確認 | ○ | 標準フロー適格性確認 |

未成年・法人は標準自動締結から外し、個別確認とする。

### 取得しない項目

通常FORMでは次を利用者に入力させない。

- フリガナ
- 電話番号
- 適格請求書発行事業者番号
- 制作物名・概要
- 販売予定価格・製造予定数
- 販売場所・販売予定地域
- 使用言語
- 利用料・料率
- 支払条件
- 利用報告条件
- クレジット条件

---

## 4. SPLLからFORMへ渡すシステム項目

次の情報はSPLL側で確定し、利用者に再入力させない。

### 業務制御・改変検知

```text
license_id
application_ref
handoff_token
terms_snapshot_hash
contract_template_version
```

### 契約個別条件

```text
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

これらはFormRunのhidden項目又は利用者が編集できない項目として保持し、CloudSign契約書テンプレートへ差し込む。

---

## 5. 改変検知

ブラウザのURLパラメータ及びFormRun hidden項目は、利用者が技術的に変更できることを前提とする。

したがって、SPLLは契約個別条件の全項目を固定順に正規化し、SHA-256ハッシュを作成する。

```text
terms_snapshot_hash = "v4:" + SHA-256(canonical_contract_fields)
```

さらに、従来どおり次の情報をHMACで署名する。

```text
application_id
application_ref
work_ids
usage_category
terms_snapshot_hash
expires_at
```

FormRun Webhook受信時に、次を全て検証する。

1. `license_id` が申込台帳と一致する
2. `application_ref` が一致する
3. `terms_snapshot_hash` が申込時保存値と一致する
4. Webhookで返された個別条件から再計算したハッシュが一致する
5. `handoff_token` が有効である
6. 有効期限内である

不一致の場合は契約処理を前進させず `MANUAL_REVIEW` とする。

---

## 6. 契約書レイアウト

### 1ページ目：個別条件

- SPLL番号
- 利用者
- 住所
- 対象作品
- ライセンサー
- 利用区分
- 許諾期間
- 利用地域
- 利用許諾料
- 支払条件
- 利用報告
- クレジット
- 特約

### 2ページ目以降：共通条件

`SPLL_利用許諾契約書_CloudSign_FORM対応_v4.0.md` の共通条項を使用する。

CloudSign上の受信者用フリーテキスト・押印欄・署名欄・チェックボックスは原則設けない。

---

## 7. 法人・イベント等

次は `MANUAL_REVIEW` とし、標準CloudSign FORMへ自動遷移させない。

- 法人
- 未成年
- 海外居住者
- イベント利用
- 「その他」利用
- 個別特約が必要な案件
- 標準料金モデルに該当しない案件

`FORM_URL_MANUAL_REVIEW` が設定されている場合のみ、個別確認フォームを案内する。

標準フォームURLへのフォールバックは行わない。

---

## 8. コード構成

```text
28_contract_form_v4_shared.gs
  contractFormFieldsV4_
  contractFormHashV4_
  formrunCanonV4_
  decideContractRouteV4_

29_contract_form_v4.gs
  api_getLegalTextsV4
  web_createApplicationV4

33_contract_snapshot_v4.gs
  snapshotContractTerms_

36_formrun_contract_v4.gs
  verifyFormrunContractV4_
  processWebhookEvent_ override

portal_contract_v4_patch.html
  ポータルUIをガイドライン確認型へ変更
  web_createApplicationV4を利用
  個別条件をFORM URLへ引継ぎ

51_admin_contract_v4.gs / admin_contract_v4_patch.html
  GUIDELINEの版管理・公開
  v4必須設定の状態確認
```

---

## 9. 既存フローとの互換性

旧申込は `Applications.terms_hash` が `v4:` で始まらない。

新申込のみ、

```text
v4:<hash>
```

として保存する。

FormRun v4改変検知は `v4:` 申込だけに適用し、既存申込・既締結案件には影響を与えない。

---

## 10. CloudSign/FormRun側で必要な設定

コードをデプロイするだけではCloudSign FORMの外部設定は変更されない。

本番切替前に、次を実施する。

1. `GUIDELINE` v4.0を `Legal_Documents` にPUBLISHED登録
2. CloudSignにv4.0契約書テンプレートを登録
3. FormRunの個人向けフォームを作成又は変更
4. ユーザー入力項目を6項目前後へ縮小
5. システム項目をhidden項目として追加
6. FormRun項目とCloudSignテンプレート項目を連携
7. `FORM_HIDDEN_MAP` を設定
8. `FORMRUN_FIELD_MAP` を設定
9. `FORM_URL_INDIVIDUAL` を設定
10. 法人等の個別確認を使う場合のみ `FORM_URL_MANUAL_REVIEW` を設定
11. stagingでFORM→CloudSign→Webhookの一連テストを行う

---

## 11. 公式仕様との整合

CloudSign公式案内では、CloudSign FORM powered by formrunは、Webフォーム入力情報を契約書へ自動反映し、指定メールアドレスへの契約書送信までを自動化するサービスとされている。

またCloudSignでは、契約内容が完成したPDFであれば、受信者用のフリーテキスト、押印、チェックボックス等を設けず、受信者が書類内容へ同意することで締結できる。

この仕様を前提として、SPLLでは「ユーザー入力は最小」「契約個別条件はシステム引継ぎ」「最終同意はCloudSign」とする。
