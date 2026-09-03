# SPLL 初期設定チェックリスト（②設定投入）

**版**：v1.0（2026-08-13）
**対象**：3プロジェクト構成（portal／workflow／admin）・SCHEMA_VERSION 9
**前提**：`npm run deploy:all` が3プロジェクトとも成功していること

この文書は「デプロイ済みの空のシステム」を「申込を受けられる状態」にするまでの投入手順です。
上から順に実施してください。**各ステップは冪等**（何度実行しても壊れません）。

---

## Step 0. 用語：設定値は2か所にある

| 置き場所 | 何が入るか | 変更方法 | 反映範囲 |
|---|---|---|---|
| **ScriptProperties** | 秘密情報・接続先ID（`SS_OPS`／API鍵など） | GASエディタ「プロジェクトの設定 → スクリプト プロパティ」または管理画面「設定」 | **プロジェクトごとに独立**（3つに転記が必要） |
| **Config（SS_OPSのConfigシート）** | 運用値（フォームURL・案内文面・連絡先など。振込先は含まない＝契約書に記載） | 管理画面「設定」 | **3プロジェクト共通・即時反映**（再デプロイ不要） |

秘密情報をConfigシートへ入れないでください（Configは台帳上の平文です）。

---

## Step 1. admin で `setup_all` を実行

script.google.com → **admin** プロジェクト → 関数選択で `setup_all` → 実行。

- 台帳スプレッドシート（SS_MASTER／SS_OPS）とDriveルートを作成（既存があれば再利用）
- 不足列の追加（＝`setup_migrate` 相当）まで自動実行
- 実行者を初期管理者（SYSTEM_ADMIN）として登録
- `HANDOFF_SECRET` を生成
- **他プロジェクトへ転記すべきプロパティ一覧をログに出力**

> すでに `setup_bootstrap` 済みで列追加だけしたい場合は `setup_migrate` のみでも可。

実行ログの `▼ 他プロジェクトの…へ転記してください` 以下を控えます。

- [ ] 実行が完了し、ログに `===== setup_all 完了 =====` が出た

事務局運営（パートナーシップ契約の会議・議案・報告・清算）を使う場合は、続けて admin で
`admin_setupPartnershipGovernance` を実行します（`Secretariat_*` シートを作成。初回に画面を開いても自動作成されます）。

- [ ] （事務局運営を使う場合）`admin_setupPartnershipGovernance` を実行した

---

## Step 2. ScriptProperties を3プロジェクトへ転記

各プロジェクトの「プロジェクトの設定 → スクリプト プロパティ」で設定します。

### portal

| キー | 値 |
|---|---|
| `ENVIRONMENT` | `development` → 本番移行時に `production` |
| `SS_MASTER` / `SS_OPS` | Step 1 のログの値 |
| `HANDOFF_SECRET` | Step 1 のログの値 |
| `ADMIN_CONSOLE_URL` | admin のウェブアプリURL（`/exec`） |

### workflow

| キー | 値 |
|---|---|
| `ENVIRONMENT` | portal と同じ |
| `SS_MASTER` / `SS_OPS` / `DRIVE_ROOT` | Step 1 のログの値 |
| `HANDOFF_SECRET` | Step 1 のログの値 |
| `CLOUDSIGN_WEBHOOK_KEY` | 任意の長い乱数（CloudSign WebhookのURLに `?key=` で付ける） |
| `FORMRUN_WEBHOOK_SECRET` | 任意の長い乱数（formrun WebhookのURLに `&key=` で付ける） |
| `CLOUDSIGN_CLIENT_ID` ほかCloudSign系 | ③フォーム構築時に設定（この時点では空でよい） |
| `GCP_PROJECT` / `GCP_REGION` / `GEMINI_MODEL` | AI一次審査を使うとき |

### admin

Step 1 で自動設定済み。追加で必要になるのは CloudSign／X 連携の鍵のみ（管理画面の「設定」から投入可）。

- [ ] portal に4件、workflow に必要分を設定した

> `ENVIRONMENT` は3つとも同じ値にしてください。未設定だと起動を止めます。

---

## Step 3. workflow で `setup_workflowAll` を実行

script.google.com → **workflow** プロジェクト → `setup_workflowAll` → 実行。

**初回は権限の承認ダイアログが出ます。** 承認する権限の一覧に次が含まれることを確認してください：

- スプレッドシートの参照・編集
- Google ドライブのファイルの参照・編集
- 外部サービスへの接続
- **メールを送信する** ← 案内メールの自動送信に必要

ログに次が出れば成功です：

```
・トリガー: 作成=["trigger_every5min","trigger_daily"] 既存=[]
===== setup_workflowAll 完了 =====
```

`必須プロパティが未設定です: ...` と出た場合は Step 2 の転記漏れです。

- [ ] トリガー2件が作成された（「トリガー」画面で確認できる）
- [ ] 承認一覧に「メールを送信する」が含まれていた

---

## Step 4. Config 投入（管理画面「設定」タブ）

admin のウェブアプリURL（`/exec`）を開き、「設定」タブで入力します。

### 4-1. 利用者向けページURL（最優先）

**手続き案内** サブタブの「クリエーター向けページのURL」に **workflow の `/exec`** を入れます（`WORKFLOW_URL`）。

これが未設定だと、案内ページ・提出リンク・バッジ配布リンクがすべて admin のURLで発行され、
利用者が開けません。**この1件だけは他より先に**設定してください。

- [ ] `WORKFLOW_URL` = workflow の `https://script.google.com/macros/s/AKfycb.../exec`

### 4-2. 手続き案内（事務局連絡先・ドメイン）

| 項目 | Configキー | 例 |
|---|---|---|
| 事務局連絡先 | `OFFICE_CONTACT` | SPLL事務局 spll@example.com |
| 自社メールドメイン | `OFFICE_EMAIL_DOMAIN` | example.com |
| QR・バッジの公開ドメイン | `PUBLIC_BASE_URL` | https://spll.example.jp（任意） |

`OFFICE_EMAIL_DOMAIN` は、CloudSignの書類から契約者のメールアドレスを取り出すときに
**自社側の宛先を除外する**ために使います。未設定だと自社アドレスを契約者として拾う場合があります。

**利用許諾料の振込先はシステムに設定しません。** 振込先は CloudSign の契約書テンプレート（個別条件）に
固定文言として記載し、契約書だけが口座情報の記載場所になります（案内ページ・メールには載せません）。
旧版の `PAYMENT_*` キーが Config に残っていても参照されません。

- [ ] `OFFICE_CONTACT` / `OFFICE_EMAIL_DOMAIN` を入力・保存した
- [ ] CloudSign テンプレートの個別条件に振込先（金融機関・支店・口座種別・口座番号・口座名義）を記載した

### 4-3. 案内メールの自動送信

| 項目 | Configキー | 既定 |
|---|---|---|
| 自動送信 | `GUIDE_EMAIL_AUTO_SEND` | `true`（有効） |
| 差出人名 | `MAIL_FROM_NAME` | TRPGライツ事務局 |
| 返信先 | `MAIL_REPLY_TO` | （空＝実行アカウント） |
| 件名 | `GUIDE_EMAIL_SUBJECT` | 既定文面あり |
| 本文 | `GUIDE_EMAIL_BODY` | 既定文面あり |

差込変数：`{{license_id}}` `{{party_name}}` `{{guide_url}}` `{{office_contact}}` `{{usage_category}}` `{{works}}`

入力後、同じ画面の **「テスト送信」** で自分宛に届くことを確認してください。
（送信は workflow の5分バッチが行います。admin からのテスト送信は admin のアカウントで送られます。）

- [ ] テストメールが届いた
- [ ] 本文に口座情報が書かれていない（意図した設計です。振込詐欺との区別のため）

### 4-4. 申込導線・法人の案内先

| 項目 | Configキー | 備考 |
|---|---|---|
| 定額用フォームURL | `FORM_URL_STANDARD_FIXED` | ③で発行 |
| 売上連動用フォームURL | `FORM_URL_STANDARD_RATE` | ③で発行 |
| 個人用（共通フォールバック） | `FORM_URL_INDIVIDUAL` | 上2つ未設定時に使用 |
| 個別確認ルート | `FORM_URL_MANUAL_REVIEW` | 要審査案件の送付先 |
| 法人の問い合わせURL | `CORPORATE_INQUIRY_URL` | Googleフォーム／formrun等 |
| 法人の問い合わせメール | `CORPORATE_INQUIRY_EMAIL` | 既定はダミー `spll-corporate@example.com` |
| 法人向け案内文 | `CORPORATE_INQUIRY_NOTE` | 空なら既定文 |

**法人は本窓口の対象外**です。ポータルで法人を選ぶとフォームへ進まず問い合わせ先を案内し、
サーバー側でも申込を拒否します（申込レコード・SPLL番号を作りません）。

フォームURLは③（CloudSign FORM 実構築）で確定するため、この時点では**法人の問い合わせ先だけ**を
本物に差し替えれば十分です。

- [ ] `CORPORATE_INQUIRY_EMAIL` をダミーから実アドレスへ変更した（または問い合わせURLを設定した）

### 4-5. 法務3文書の公開

「設定」タブの上部、**個人情報の取得同意／SPLL二次創作ガイドライン／利用規約** の3枠に
リポジトリの HTML本文を貼り付けます。

| 画面の枠 | 貼り付け元 | Configキー |
|---|---|---|
| 個人情報の取得同意 | `docs/legal/spll_privacy.body.html` | `LEGAL_PRIVACY_TEXT` |
| SPLL二次創作ガイドライン | `docs/legal/spll_guideline.body.html` | `LEGAL_GUIDELINE_TEXT` |
| 利用規約 | `docs/legal/spll_terms.body.html` | `LEGAL_TERMS_TEMPLATE` |

`*.body.html` は**本文だけ**のファイルです（`<html>` や `<head>` を含みません）。
スタンドアロンで配布する場合は `*.html`（同ディレクトリ）を使ってください。
更新は `node docs/build_legal_html.js` でMarkdownから再生成します。

- [ ] 3文書を貼り付け・保存した
- [ ] ポータルの同意リンクから3文書が表示できる

### 4-6. AI一次審査のプロンプト

既定プロンプトのままでも動きます。文言を変える場合のみ「AI一次審査のプロンプト」枠で編集します。
`{{rules}}` は禁止事項ルールの差込位置です（省略すると末尾へ自動付加）。
「プレビュー」で実際に送られる文字列を確認できます。保存後の提出から適用されます。

- [ ] （任意）プロンプトを確認した

---

## Step 5. 作品マスタの投入

「設定 → 作品一覧（Works_Master）」から取り込みます。

| 対象 | 件数（想定） |
|---|---|
| Works | 113 |
| Partners | 17 |
| Legacy_Work_Codes | 130 |

- [ ] 件数が想定どおり表示された
- [ ] ポータルの検索で作品がヒットする

---

## Step 5.5. AI一次審査（Vertex AI）を有効にする

AI一次審査は **GAS②(workflow) から Vertex AI を直接呼びます**。呼び出しの認証には
`ScriptApp.getOAuthToken()`（＝スクリプトを動かしている本人の資格情報）を使うため、
**課金の請求先は `GCP_PROJECT`、API を有効にする必要があるのは「スクリプトが載っている GCP プロジェクト」** という
2つのプロジェクトが登場します。Slides API のときと同じ構造で、ここを取り違えると
`SERVICE_DISABLED`（HTTP 403）になります。

1. **GAS②（と③）を自社の GCP プロジェクトに載せ替える**
   Apps Script エディタ → プロジェクトの設定 → 「Google Cloud Platform（GCP）プロジェクト」→ 変更 →
   プロジェクト番号を入力。既定で作られる「スクリプト専用プロジェクト」のままだと、
   こちらから API を有効にできません（＝永久に 403）。
2. **その GCP プロジェクトで API を有効にする**
   `gcloud services enable aiplatform.googleapis.com --project=<プロジェクトID>`
   （バッジ画像を出すために `slides.googleapis.com` も同じプロジェクトで有効にします）
3. **ScriptProperties を入れる**（GAS②／③・管理画面「設定 → データソース接続」からでも可）

   | キー | 値の例 | 意味 |
   |---|---|---|
   | `GCP_PROJECT` | `legalbridge-488506` | Vertex AI の呼び出し先＝**課金先**のプロジェクトID |
   | `GCP_REGION` | `asia-northeast1` | モデルのリージョン。**作品データの所在地**になるため国内を推奨 |
   | `GEMINI_MODEL` | `gemini-2.5-flash` | リージョンで提供されているモデル名 |

4. **接続を確認する**
   管理画面「設定 → AI一次審査 → Vertex AI への接続確認」で「接続を確認する」。
   ここは審査ジョブを作らず、短い問い合わせを1回だけ送ります。
   失敗したときは Vertex AI が返した理由をそのまま表示します（`SERVICE_DISABLED` のメッセージに
   出るプロジェクト番号が、上の 1. で載せ替えるべきプロジェクトです）。
5. **プロンプトを確認する**
   同じ画面のプロンプト欄。`{{rules}}` に対象原作のルールと契約条件が JSON で差し込まれます。
   出力形式はサーバー側のスキーマで固定しているため、文面を変えても壊れません。

> **審査に回せるのは、直接アップロードの上限内の PDF・PNG・JPEG です。**
> 上限は「設定 → AI一次審査 → 作品提出の受け入れ条件」（`UPLOAD_MAX_MB`）で変更します。
> 大容量提出（Driveフォルダ）も、フォルダ内に**この上限以内の PDF・PNG・JPEG が1つでもあれば**
> それを代表としてAIへ回します。動画・音楽・立体データだけの提出はAI対象外となり、
> `AI_NOT_APPLICABLE` として審査キューへ回送されます（＝上限を上げると、AIに回せる提出も増えます）。

- [ ] GAS②（③）が自社の GCP プロジェクトに載っている
- [ ] `aiplatform.googleapis.com` が有効
- [ ] 接続確認が「接続できました」になる

---

## Step 6. 通し確認

`docs/SPLL_手動テスト手順_v1.0.md` のフェーズ0〜3を実施します。特に次を確認してください。

- [ ] ポータルで**個人**を選ぶとフォームへ進める／**法人**を選ぶと問い合わせ案内になる
- [ ] 締結Webhook受信後、Contracts に `contact_email` が入り `contact_email_source` が `CLOUDSIGN` になる
- [ ] 5分以内に案内メールが届き、案内ページで **SPLL番号・提出リンク・バッジ** が見える（振込先は出ない。契約書に記載）
- [ ] 提出リンクからDriveフォルダが開き、ファイル投入後「提出を確定」で共有が解除される
- [ ] 管理画面の**認証スイッチ**で停止（SUSPENDED／理由 FEE_PAYMENT_UNCONFIRMED）にすると検証ページが「有効」でなくなり、バッジも取得できなくなる

---

## 次のフェーズ

| # | 内容 |
|---|---|
| ③ | CloudSign FORM の実構築（formrun＋テンプレートv4.1・定額用／売上連動用の2種）→ `FORM_URL_*` を確定 |
| ④ | 法務レビュー（利用規約v1.0は新規作成・`[法務確定前]` 箇所・ガイドラインv4.1の未決5項目） |
| ⑤ | ステージング統合テスト（`ENVIRONMENT=staging`）→ 本番切替 |
