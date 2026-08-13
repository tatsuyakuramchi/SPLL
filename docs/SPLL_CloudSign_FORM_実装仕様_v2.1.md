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
法人は本窓口では受け付けず、別途の問い合わせ窓口から個別契約とする（§7.0）。

| 項目 | 必須 | 用途 |
|---|---:|---|
| 氏名 | ○ | 契約当事者 |
| 屋号・サークル名 | 任意 | 契約書表示補助 |
| 郵便番号 | ○ | 住所入力補助 |
| 住所 | ○ | 契約当事者特定 |
| メールアドレス | ○ | CloudSign送信先 |
| 成年確認 | ○ | 標準フロー適格性確認 |

未成年は標準自動締結から外し、個別確認とする。法人は窓口の対象外とする（§7.0）。

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

### 7.0 法人（窓口の対象外）

本CloudSign FORM窓口は**個人（個人事業主を含む）専用**とする。
法人によるSPLL利用は標準契約の対象外であり（利用許諾契約書v4.1 第3条1(1)・第3条4）、
**別途の問い合わせ窓口から個別契約ルートへ退避**させる。

- ポータルで「法人」を選択した時点で申込ボタンを無効化し、問い合わせ窓口を表示する
- サーバー側でも `web_createApplicationV4` が `CORPORATE_INQUIRY_REQUIRED` で拒否する
  （クライアント制御に依存しない）。**申込レコード・SPLL番号は採番しない**
- 案内先はConfigで設定する

| Config | 内容 |
|---|---|
| `CORPORATE_INQUIRY_URL` | 法人向け問い合わせフォームのURL（Googleフォーム／formrun／自社フォームいずれも可） |
| `CORPORATE_INQUIRY_EMAIL` | 法人向け問い合わせ先メールアドレス |
| `CORPORATE_INQUIRY_NOTE` | 案内文（未設定時は既定文言） |

いずれも**管理コンソール「設定 → FormRun／クラウドサインフォーム → 申込導線」**から編集する
（`admin_getPortalRoutingConfig` / `admin_savePortalRoutingConfig`）。URLとメールの両方を設定した場合は
URLを優先して案内し、どちらも未設定の場合は「事務局までご確認ください」と表示する。
受け口が未定の間は `setup_bootstrap` が置くダミー（`spll-corporate@example.com`）のままでも
導線は成立するが、**本番切替前に必ず実アドレス又はフォームURLへ差し替えること**。

同画面から経路別フォームURL（`FORM_URL_STANDARD_FIXED` / `FORM_URL_STANDARD_RATE` /
`FORM_URL_INDIVIDUAL` / `FORM_URL_MANUAL_REVIEW`）も設定できる。

`decideContractRouteV4_` も法人をMANUAL_REVIEWとするが、これは旧データの再申込など
後段経路での保険であり、通常フローでは到達しない。

### 7.1 個別確認（MANUAL_REVIEW）

法人以外で標準自動締結に載せない案件は、申込（SPLL番号）を発行したうえで個別確認とする。

- 未成年
- 海外居住者
- イベント利用
- 「その他」利用
- 個別特約が必要な案件
- 標準料金モデルに該当しない案件

`FORM_URL_MANUAL_REVIEW` が設定されている場合のみ、個別確認フォームを案内する。
未設定の場合は「事務局から連絡する」旨を完了画面に表示する（案内を途切れさせない）。

標準フォームURLへのフォールバックは行わない。

### 7.2 標準経路のフォームURL解決順

定額（`STANDARD_FIXED`）と売上連動（`STANDARD_RATE`）ではCloudSignテンプレートが異なるため、
`partyFormUrlV4_` は次の順で解決する。

1. `FORM_URL_<route>`（`FORM_URL_STANDARD_FIXED` / `FORM_URL_STANDARD_RATE`）
2. `FORM_URL_INDIVIDUAL`（経路別未設定時の共通フォーム）
3. `FORMRUN_FORM_URL`（旧設定の互換）

経路別URLを設定した場合に共通URLで上書きされない順序とする（誤ったテンプレートの送付を防ぐため）。

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

1. 法務3文書を `Legal_Documents` にPUBLISHED登録（管理コンソール 設定→同意文・規約）
   - 正本は `docs/*.md`、公開用HTMLは `docs/legal/*.html`（`node docs/build_legal_html.js` で生成）
   - 管理画面の各枠で `docs/legal/<doc>.body.html` を「HTMLファイルから読み込む」→「下書き保存」→「この文書を公開する」

   | 文書種別 | 正本Markdown | 公開用HTML | ポータルでの用途 |
   |---|---|---|---|
   | `PRIVACY` | `SPLL_個人情報取得同意_v1.0.md` | `legal/spll_privacy.html` | ステップ1で同意取得 |
   | `GUIDELINE` | `SPLL_二次創作ガイドライン_v4.1.md` | `legal/spll_guideline.html` | ステップ2で確認取得 |
   | `TERMS` | `SPLL_利用規約_v1.0.md` | `legal/spll_terms.html` | 窓口の利用条件（掲示） |
2. CloudSignにv4.1契約書テンプレートを登録（定額用・売上連動用）
3. FormRunの個人向けフォームを作成又は変更
4. ユーザー入力項目を6項目前後へ縮小
5. システム項目をhidden項目として追加
6. FormRun項目とCloudSignテンプレート項目を連携
7. `FORM_HIDDEN_MAP` を設定
8. `FORMRUN_FIELD_MAP` を設定
9. `FORM_URL_STANDARD_FIXED` / `FORM_URL_STANDARD_RATE`（テンプレートが1種類なら `FORM_URL_INDIVIDUAL`）を設定
10. 個別確認（未成年・イベント等）を使う場合のみ `FORM_URL_MANUAL_REVIEW` を設定
10.5. 管理コンソール「設定→申込導線」で `CORPORATE_INQUIRY_URL`（又は `CORPORATE_INQUIRY_EMAIL`）を
    実運用の受け口へ差し替える＝法人の退避先（初期値はダミーアドレス）
11. stagingでFORM→CloudSign→Webhookの一連テストを行う
12. 締結後に `Contracts.terms_snapshot` の `terms_snapshot_hash_verified` が `true` であることを確認する
    （`false` の場合は個別条件を受信証跡から復元できておらず、TERMS_MISMATCHで自動有効化が止まる）

---

## 11. 公式仕様との整合

CloudSign公式案内では、CloudSign FORM powered by formrunは、Webフォーム入力情報を契約書へ自動反映し、指定メールアドレスへの契約書送信までを自動化するサービスとされている。

またCloudSignでは、契約内容が完成したPDFであれば、受信者用のフリーテキスト、押印、チェックボックス等を設けず、受信者が書類内容へ同意することで締結できる。

この仕様を前提として、SPLLでは「ユーザー入力は最小」「契約個別条件はシステム引継ぎ」「最終同意はCloudSign」とする。
