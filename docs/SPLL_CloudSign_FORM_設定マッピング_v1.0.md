# SPLL CloudSign FORM 設定マッピング v1.0

**対象:** CloudSign FORM powered by formrun / SPLL v4  
**作成日:** 2026-08-12

---

## 1. ユーザー入力フィールド

| canonical key | 表示名 | 必須 | CloudSign差込 |
|---|---|---:|---:|
| `party_name` | 氏名 | ○ | ○ |
| `circle_name` | 屋号・サークル名 | 任意 | ○ |
| `postal_code` | 郵便番号 | ○ | 住所補助 |
| `party_address` | 住所 | ○ | ○ |
| `email` | メールアドレス | ○ | 送信先・○ |
| `adult_confirmed` | 成年確認 | ○ | 原則差込なし |

契約本文への同意チェック、反社チェック、権利非侵害チェック等はFormRun上に重複配置しない。これらはCloudSignで締結する契約本文に含める。

---

## 2. システム引継ぎフィールド

次は利用者に編集させない。

```text
license_id
application_ref
handoff_token
terms_snapshot_hash
contract_template_version
usage_category
work_count
work_names
work_id_1
work_title_1
work_id_2
work_title_2
work_id_3
work_title_3
work_id_4
work_title_4
work_id_5
work_title_5
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
template_route
```

---

## 3. `FORM_HIDDEN_MAP`

方向は **canonical key → FormRun実フィールド名/ID**。

例：

```json
{
  "license_id": "_field_license_id",
  "application_ref": "_field_application_ref",
  "handoff_token": "_field_handoff_token",
  "terms_snapshot_hash": "_field_terms_snapshot_hash",
  "contract_template_version": "_field_contract_template_version",
  "usage_category": "_field_usage_category",
  "work_count": "_field_work_count",
  "work_names": "_field_work_names",
  "work_id_1": "_field_work_id_1",
  "work_title_1": "_field_work_title_1",
  "licensor_name": "_field_licensor_name",
  "license_term": "_field_license_term",
  "territory": "_field_territory",
  "fee_model": "_field_fee_model",
  "fee_value": "_field_fee_value",
  "fee_amount_or_rate": "_field_fee_label",
  "licensed_uses": "_field_licensed_uses",
  "payment_terms": "_field_payment_terms",
  "reporting_terms": "_field_reporting_terms",
  "credit_text": "_field_credit_text",
  "special_terms": "_field_special_terms"
}
```

実際のFormRunフィールドIDに置換する。

---

## 4. `FORMRUN_FIELD_MAP`

方向は **FormRun実フィールド名/ID → canonical key**。

`FORM_HIDDEN_MAP` の逆引きになるよう設定する。

例：

```json
{
  "_field_license_id": "license_id",
  "_field_application_ref": "application_ref",
  "_field_handoff_token": "handoff_token",
  "_field_terms_snapshot_hash": "terms_snapshot_hash",
  "_field_contract_template_version": "contract_template_version",
  "_field_usage_category": "usage_category",
  "_field_work_count": "work_count",
  "_field_work_names": "work_names",
  "_field_work_id_1": "work_id_1",
  "_field_work_title_1": "work_title_1",
  "_field_licensor_name": "licensor_name",
  "_field_license_term": "license_term",
  "_field_territory": "territory",
  "_field_fee_model": "fee_model",
  "_field_fee_value": "fee_value",
  "_field_fee_label": "fee_amount_or_rate",
  "_field_licensed_uses": "licensed_uses",
  "_field_payment_terms": "payment_terms",
  "_field_reporting_terms": "reporting_terms",
  "_field_credit_text": "credit_text",
  "_field_special_terms": "special_terms",
  "氏名": "party_name",
  "屋号・サークル名": "circle_name",
  "住所": "party_address",
  "メールアドレス": "email"
}
```

---

## 5. CloudSign契約書テンプレート差込

| 契約書欄 | FormRun canonical key |
|---|---|
| SPLL番号 | `license_id` |
| 利用者 | `party_name` |
| 屋号・サークル名 | `circle_name` |
| 住所 | `party_address` |
| メール | `email` |
| 対象作品 | `work_names` |
| ライセンサー | `licensor_name` |
| 利用区分 | `usage_category` |
| 許諾期間 | `license_term` |
| 利用地域 | `territory` |
| 利用許諾料 | `fee_amount_or_rate` |
| 支払時期・方法 | `payment_terms` |
| 利用報告 | `reporting_terms` |
| クレジット | `credit_text` |
| 特約 | `special_terms` |

`handoff_token`、`terms_snapshot_hash`、`fee_model`、`fee_value` 等は契約書本文への表示を必須としない。改変検知・業務処理用として保持する。

---

## 6. CloudSign FORM設定時の注意

- 契約書に表示する個別条件は利用者が編集できない状態にする。
- FormRunの完了画面だけで「契約成立」と表示しない。
- 「契約書をCloudSignから送付します。CloudSign上で内容を確認し同意すると契約成立です」と案内する。
- CloudSign側の受信者用押印・署名・チェック項目は原則設定しない。
- `terms_snapshot_hash` と `handoff_token` は必ずWebhookでSPLLへ返るよう設定する。
- 本番前にURLパラメータを手作業で改変し、`MANUAL_REVIEW`になることを確認する。
