# SPLL CloudSign FORM 実装仕様 v2.0

**文書番号:** SPLL-FORM-FD-002  
**版数:** v2.0  
**作成日:** 2026-08-12  
**関連:** `SPLL_利用許諾契約書_CloudSign_FORM対応_v4.0.md`

---

## 1. 前提

CloudSign FORM powered by formrunは、Webフォームに入力された情報を契約書へ反映し、指定メールアドレスへの契約書送信までを自動化する構成を前提とする。

契約の成立点はformrunのフォーム送信時ではなく、CloudSign上で利用者が生成済み契約書を確認し、所定の同意操作を完了した時点とする。

CloudSign上のフリーテキスト、押印欄、チェックボックスは原則設定しない。

---

## 2. ユーザー体験

```text
SPLLポータル
  ↓
対象原作選択
  ↓
利用区分・料金等を確認
  ↓
license_id / application_ref 発行
  ↓
CloudSign FORM
  契約者情報のみ入力
  ↓
契約書生成・CloudSign自動送信
  ↓
利用者が契約書PDFを確認
  ↓
CloudSign上で同意
  ↓
契約成立
  ↓
CloudSign Webhook
  ↓
License_CasesをSIGNEDへ更新
```

---

## 3. フォーム項目

現行制度が法人を利用者として認めていないため、v2.0では個人契約のみを標準フローとする。

| 項目 | 必須 | 契約書差込 | SPLL台帳 | 備考 |
|---|---:|---:|---:|---|
| 氏名 | ○ | ○ | 表示名のみ | 実名 |
| 屋号・サークル名 | 任意 | ○ | 任意 | 契約者は実名 |
| 郵便番号 | ○ | ○ | 原則保持不要 | 住所生成補助 |
| 住所 | ○ | ○ | 原則保持不要 | 契約書上必要 |
| メールアドレス | ○ | 連絡先欄 | 原則保持最小化 | CloudSign送信先 |
| 成年確認 | ○ | × | 状態のみ | 生年月日は原則取得しない |
| 法定代理人手続 | 条件付 | 別途 | 必要最小限 | 未成年を受け付ける場合のみ |

---

## 4. フォームから削除する項目

通常フォームでは次を取得しない。

- 氏名フリガナ
- メールアドレス確認欄
- 電話番号
- 適格請求書発行事業者登録番号
- 制作物名
- 制作物概要
- 制作物形態
- 販売開始予定日
- 販売予定価格
- 製造予定数
- 販売場所
- 海外販売地域
- 使用言語
- 参考URL
- 既公開・既販売情報
- 利用料
- 料率
- 支払条件
- 報告条件
- クレジット条件

制作物に関する情報は作品提出時、売上・数量その他Finance情報は利用報告時に取得する。

---

## 5. SPLLポータル側で確定する情報

以下は利用者にCloudSign FORMで再入力させない。

```text
license_id
application_ref
work_id
work_name
licensor_name
usage_category
license_term
territory
fee_model
fee_value
payment_terms
reporting_terms
credit_text
special_terms
terms_snapshot_hash
```

---

## 6. hidden項目

CloudSign FORM / formrunへ渡す業務制御用hidden値は必要最小限とする。

```text
license_id
application_ref
handoff_token
terms_snapshot_hash
```

契約書へ差し込む個別条件は、可能な限りSPLLシステム上の確定値から生成する。

ブラウザ経由のhidden値のみを契約条件の正本として信用しない。

---

## 7. 契約書レイアウト

### 1ページ目

- タイトル
- 契約当事者
- 個別条件表
- 「以下の共通条件と併せて本契約を構成する」旨

### 2ページ目以降

- 共通契約条件

### CloudSign上

- 受信者入力項目：原則なし
- 押印欄：原則なし
- 署名欄：原則なし
- 契約書全体を確認後、CloudSign所定の同意操作を行う

---

## 8. 契約成立判定

### FORM送信

```text
FORM_SUBMITTED
```

契約未成立。

### CloudSign送信

```text
SIGNING
```

契約未成立。

### CloudSign同意完了Webhook

CloudSign上の締結完了を確認後、

```text
SIGNED
```

へ遷移する。

この時点を契約成立日時 `signed_at` とする。

---

## 9. CloudSign締結後の処理

```text
CloudSign completed
  ↓
document_id 突合
  ↓
license_id / application_ref 突合
  ↓
terms_snapshot_hash 検証
  ↓
締結PDF保存
  ↓
PDF hash保存
  ↓
Contract_Documents追加
  ↓
License_Cases.contract_status = SIGNED
  ↓
License側認証フロー開始
  ↓
Finance_Handoffs作成
```

Finance側で請求書を直接生成する処理は、License側CloudSign Webhookには置かない。

---

## 10. CloudSign書類情報との役割分担

CloudSignの書類情報を利用できる場合、次の情報はCloudSign側の管理情報として設定してよい。

- 契約相手の名称
- 契約締結日
- 契約開始日
- 契約終了日
- 自動更新の有無
- 解約通知期限
- 管理番号
- 取引金額

ただし、SPLL業務上の正本は `License_Cases` / `Contract_Documents` とし、CloudSign書類情報のみを業務DBの代替にはしない。

---

## 11. 例外フロー

次は自動締結から外し、事務局確認へ送る。

- 未成年
- 契約者情報の不整合
- 対象原作又は料金条件が標準ルール外
- terms snapshot不一致
- CloudSign書類とSPLL台帳の突合不能
- 法人申込
- イベント等、現行制度上の取扱いが未確定の利用
- その他個別特約を要する利用

---

## 12. 公式仕様上の前提

CloudSignの公式案内では、CloudSign FORM powered by formrunは、Webフォームの入力情報を契約書へ自動反映し、指定メールアドレスへの送信までを自動化するサービスとして案内されている。

またCloudSignでは、契約内容が完成したPDFであれば、フリーテキスト、押印、チェックボックス等の受信者入力項目を設けなくても、受信者が書類内容へ同意することで契約締結が可能と案内されている。

したがってSPLLでは、「フォームで契約条件を再入力させる方式」ではなく、「フォームは当事者情報取得、契約条件はSPLL台帳、CloudSignは最終契約書への同意」という責任分担を採用する。
