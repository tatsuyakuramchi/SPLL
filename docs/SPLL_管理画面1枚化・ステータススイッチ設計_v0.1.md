# SPLL 管理画面1枚化・ステータススイッチ設計 v0.1（たたき台）

**対象:** GAS③ 管理コンソール（`spll_src/admin.html` / `50_admin.gs` ほか）
**作成日:** 2026-11-17
**目的:** 日常業務を「1枚の画面」で完結させる。案件の状態を一覧で見せ、状態の変更は**ステータススイッチ**だけで行う。

---

## 1. 方針

| 現状 | 1枚化後 |
|---|---|
| ダッシュボード／ライセンス／作品審査／認証管理／設定の5タブを行き来する | **案件ボード1枚**。左：状態の集計、中央：案件一覧、右：選んだ案件の詳細とスイッチ |
| 操作ボタンが画面ごとに散らばり、引数が契約ID・申込ID・提出IDでばらばら | 操作はすべて**SPLL番号＋スイッチ名**で呼ぶ（サーバー側で各IDへ解決） |
| 押せない操作も表示され、押した後にエラーで拒否される | 遷移表（`LICENSE_TRANSITIONS`）で**事前検証した結果だけ**をスイッチの「押せる／押せない（理由）」として表示 |
| 設定は日常業務と同じタブ列にある | 設定は右上の歯車から開く**別パネル**（日常業務の画面からは外す） |

状態遷移のルールそのもの（`12_license_state.gs`）は変えない。画面と、画面から呼ぶ入口だけを作り直す。

---

## 2. 画面構成（ワイヤーフレーム）

```
┌────────────────────────────────────────────────────────────────────────────┐
│ SPLL 管理   [SPLL番号・氏名・作品名で検索___________]   要対応 7   ⚙設定  👤 │
├──────────────┬──────────────────────────────────────┬──────────────────────┤
│ 状態ボード    │ 案件一覧（絞り込み：要対応 ▼）            │ SPLL-2026-0123        │
│              │                                        │ 山田太郎／○○サークル   │
│ ▼申込〜締結   │ SPLL番号   契約者  現在地  契約 審査 認証 │──────────────────────│
│  申込受付   3 │ 0123      山田    審査中  ●  ◐  ○   │ ■ 状態（4軸）          │
│  契約書送付待 2│ 0120      佐藤    是正中  ●  ✕  ○   │  現在地  REVIEWING     │
│  個別確認  ⚠1 │ 0117      鈴木    認証済  ●  ●  ●   │  契約    SIGNED   ●    │
│  署名待ち   4 │ 0111      高橋    停止中  ●  ●  ‖   │  審査    IN_REVIEW ◐   │
│  条件不一致⚠1 │ …                                      │  認証    NOT_ISSUED ○  │
│ ▼締結後       │                                        │──────────────────────│
│  提出待ち  12 │                                        │ ■ ステータススイッチ    │
│  審査中   ⚠5 │                                        │  審査判定 [承認|是正|上申]│
│  是正中     2 │                                        │  入金未確認で停止 ( ○━ )│
│ ▼認証        │                                        │  一時停止(他理由) 申請▸ │
│  認証済    40 │                                        │  失効       申請▸ 🔒   │
│  停止中     3 │                                        │  契約終了   申請▸ 🔒   │
│ ▼終了        │                                        │  申込取消   ── 不可 ⓘ  │
│  終了       5 │                                        │──────────────────────│
│  取消       8 │                                        │ ■ 作業                │
│──────────────│                                        │  案内リンク発行 / バッジ │
│ 承認待ち    ⚠2│                                        │  再試行 / 照合コード再発行│
│ 通知失敗    ⚠1│                                        │──────────────────────│
│ 整合性エラー 0│                                        │ ■ 中身（折りたたみ）    │
│              │                                        │  契約・原作・提出・AI結果 │
│              │                                        │  ・認証・バッジ・履歴     │
└──────────────┴──────────────────────────────────────┴──────────────────────┘
```

- **左（状態ボード）**：`case_status` ごとの件数。クリックで中央の一覧を絞り込む。⚠ は事務局が動かないと進まない状態（§3の「要対応」列）。下段に状態以外の要対応（承認待ち、通知の送信失敗、整合性エラー）を並べる。
- **中央（案件一覧）**：1行＝1 SPLL番号。4軸の状態を記号で並べ、どこで止まっているかを一目で分かるようにする。
- **右（詳細）**：状態の4軸、ステータススイッチ、状態を変えない作業、中身（折りたたみ）。作品審査は右パネル内で提出物・AI指摘を開いて判定する（別タブに移らない）。
- スマホ幅では左→中央→右を縦に積み、右パネルは全画面のシートとして開く。

---

## 3. ステータス一覧

### 3.1 案件の現在地 `case_status`（左ボードの行）

| 区分 | 値 | 表示名 | 意味 | 次に進める人 | 要対応 |
|---|---|---|---|---|:-:|
| 申込〜締結 | `APPLICATION_RECEIVED` | 申込受付 | SPLL番号を発行し、別表（対象作品）を確定した | システム／クリエーター | |
| | `CONTRACT_PENDING` | 基本契約待ち | 参加者の基本契約が未締結（formrun → CloudSign で同意待ち） | クリエーター | |
| | `MANUAL_REVIEW` | 個別確認 | 申込の条件が自動締結に載らない／審査の上申 | **事務局** | ⚠ |
| | `SIGNING` | 個別契約の同意待ち | 個別利用許諾書を CloudSign API で送付済み | クリエーター | |
| | `HOLD` | 条件不一致 | 締結した書類が台帳と合わない（基本契約の版違い・個別利用許諾書の照合コード不一致） | **事務局（法務）** | ⚠ |
| 締結後 | `AWAITING_SUBMISSION` | 提出待ち | 個別契約が成立、作品の提出待ち | クリエーター | |
| | `REVIEWING` | 審査中 | 提出済み（AI一次審査→人手審査） | **事務局** | ⚠ |
| | `CORRECTION_REQUIRED` | 是正中 | 是正を依頼した | クリエーター | |
| 認証 | `CERTIFIED` | 認証済 | 認証が有効 | — | |
| | `SUSPENDED` | 停止中 | 認証を一時停止中 | 事務局 | |
| 終了 | `TERMINATED` | 終了 | 失効・契約終了 | — | |
| | `CANCELLED` | 取消 | 申込取消・再申込で置換 | — | |

### 3.2 4軸の状態（一覧の記号）

| 軸 | 値 | 記号 |
|---|---|:-:|
| 基本契約（参加者ごと）`Participants.agreement_status` | `NOT_STARTED` / `SIGNING` / `ACTIVE` / `TERMINATED` | ○ / ◐ / ● / ✕ |
| 個別契約 `contract_status` | `NOT_STARTED` / `SIGNING` / `SIGNED` / `TERMINATED` | ○ / ◐ / ● / ✕ |
| 審査 `review_status` | `NOT_STARTED`・`AWAITING_SUBMISSION` / `IN_REVIEW`・`PENDING` / `CLEARED` / `CORRECTION_REQUIRED` / `ESCALATED` | ○ / ◐ / ● / ✕ / ⚠ |
| 認証 `certification_status` | `NOT_ISSUED` / `ACTIVE` / `SUSPENDED` / `EXPIRED` / `REVOKED` / `TERMINATED` | ○ / ● / ‖ / ⌛ / ✕ / ✕ |

停止の理由は `Certificates.reason_code` に持つ（例：`FEE_PAYMENT_UNCONFIRMED`）。一覧では「‖ 入金未確認」のように理由を添える。

---

## 4. ステータススイッチ

### 4.1 考え方

- スイッチ1つが、遷移表のイベント1つ（または1組）に対応する。
- 画面を開いたとき、サーバーが**全スイッチを事前検証**（`validateLicenseTransition_` を書き込みなしで実行）し、
  `enabled`（押せる）／`disabled_reason`（押せない理由）／`needs_approval`（申請が要る）を返す。画面はそれを描くだけ。
  押せないスイッチは灰色にして、理由をツールチップで表示する。
- 押した後の処理は、**既存の業務関数をそのまま呼ぶ**（認証行の更新、バッジ生成ジョブ、メール送信などの副作用がそちらにあるため）。
  `transitionLicenseCase_` を画面から直接呼ぶことはしない。
- 重い変更（失効・契約終了・入金以外の理由の停止／復帰）は、今と同じく**申請→別担当者の承認**とする。
  スイッチは「申請」になり、承認待ちの間は「承認待ち（申請者・日時）」を表示する。

### 4.2 スイッチ一覧

| # | スイッチ | 形 | 遷移イベント | 押せる現在地 | 呼ぶ既存関数 | 承認 | ロール |
|---:|---|---|---|---|---|:-:|---|
| S1 | 個別利用許諾書を作成して送付（CloudSign API） | ボタン（送付前にプレビュー） | `CLOUDSIGN_SENT` | 申込受付・個別確認（基本契約が ACTIVE のとき） | 新設：個別利用許諾書PDFの生成 → `cs_createDocument_` / `cs_attachFile_` / `cs_addParticipant_` / `cs_sendDocument_`（§8） | — | OPERATIONS |
| S2 | 条件を確認して有効化 | ボタン | `CLOUDSIGN_SIGNED` | 条件不一致 | `admin_confirmContractTerms(contractId, note)` | — | LEGAL_ADMIN |
| S3 | 審査判定 | 3択（承認／是正／上申） | `HUMAN_REVIEW_CLEARED` / `CORRECTION_REQUIRED` / `REVIEW_ESCALATED` | 審査中・是正中・個別確認・認証済・停止中 | `admin_setHumanReview(submissionId, result, comment, reviewer, versionId)` | — | REVIEWER |
| S4 | 入金未確認で停止 | オン／オフ（2名体制では申請） | `CERTIFICATE_SUSPENDED` ⇄ `CERTIFICATE_RESTORED` | 認証が ACTIVE、またはこの理由で停止中 | `admin_setCertEnabled(contractId, enabled, reason)`（2名体制では `admin_requestCertChange` → `admin_approveCertChange`） | 設定で切替 | OPERATIONS |
| S5 | 一時停止（その他の理由）／復帰 | 申請 | `CERTIFICATE_SUSPENDED` / `CERTIFICATE_RESTORED` | 認証あり | `admin_requestCertChange(...)` → `admin_approveCertChange(...)` | ✔ | LEGAL_ADMIN |
| S6 | 失効 | 申請 | `CERTIFICATE_REVOKED` | 認証あり | 同上（`requestedStatus='REVOKED'`） | ✔ | LEGAL_ADMIN |
| S7 | 個別契約の終了 | 申請 | `CONTRACT_TERMINATED` | 個別契約 SIGNED | 同上（`requestedStatus='TERMINATED'`） | ✔ | LEGAL_ADMIN |
| S10 | 基本契約の終了 | 申請 | 参加者の `AGREEMENT_TERMINATED` → その参加者の全案件に `CONTRACT_TERMINATED` | 基本契約 ACTIVE | 新設 | ✔ | LEGAL_ADMIN |
| S8 | 失効からの再有効化 | 申請 | `CERTIFICATE_RESTORED` | 契約 SIGNED かつ認証 REVOKED 等 | 同上（`requestedStatus='ACTIVE'`） | ✔ | LEGAL_ADMIN |
| S9 | 申込取消 | ボタン（確認つき） | `APPLICATION_CANCELLED` | 申込受付〜条件不一致 | `admin_cancelApplication(applicationId, reason)` | — | OPERATIONS |

**スイッチにしないもの**（システムだけが起こす遷移）：`APPLICATION_CREATED`、`FORM_SUBMITTED`、`MANUAL_REVIEW_REQUIRED`、
`TERMS_MISMATCH`、`SUBMISSION_CREATED`、`CERTIFICATE_ISSUED`（S3 の「承認」から自動で続く）。
画面には履歴として表示するだけにする。

**状態を変えない作業**（スイッチ欄の下に並べる）：案内リンク発行、提出リンク発行、バッジ生成ジョブの再試行、照合コードの再発行、再申込（訂正）。

### 4.3 スイッチの見え方

| 状態 | 表示 |
|---|---|
| 押せる | 通常色 |
| 押せない | 灰色＋理由（例：「契約が成立していません（contract_status=SIGNING）」）。遷移表のガード文言をそのまま使う |
| 権限がない | 鍵アイコン＋必要なロール |
| 承認待ち | 「承認待ち：申請者・日時」。申請者本人以外の承認者にだけ［承認］［却下］を表示 |
| 押した直後 | 確認ダイアログ（理由入力が必須のものは入力欄つき）→ 成功したら右パネルと左ボードの件数を再取得 |

---

## 5. サーバー側に追加するもの

既存の `admin_*` は引数が契約ID・申込ID・提出IDでばらばらなので、SPLL番号で受ける入口を3つ足す。

```js
/** 左ボード＋中央一覧。件数と、絞り込んだ案件の行（4軸の状態・要対応フラグ） */
admin_getCaseBoard({ filter, query, page })
  → { counts: { case_status: n, ... , pending_approvals, mail_failures, inconsistencies },
      rows: [{ license_id, party, case_status, contract_status, review_status,
               certification_status, cert_reason_code, needs_action, updated_at }] }

/** 右パネル。案件の中身と、全スイッチの事前検証結果 */
admin_getCasePanel(licenseId)
  → { license, contract, works, submissions, review, certificate, badge, timeline,
      switches: [{ key:'S3', enabled, disabled_reason, needs_approval, pending_request, required_role }] }

/** スイッチを押す。SPLL番号から各IDを解決して既存関数へ振り分ける */
admin_applySwitch(licenseId, switchKey, params)   // params: { value, reason, note, ... }
  → { ok, panel: admin_getCasePanel(licenseId) の結果 }
```

- 事前検証は `validateLicenseTransition_` に加えて、既存関数が持つ追加条件（職務分離、入金停止の理由一致など）も
  同じ判定を返す関数に切り出して使う。画面で押せたのにサーバーで拒否される、という食い違いを作らないため。
- ロール判定は既存の権限チェックを `admin_applySwitch` の入口でも行う（画面の鍵表示は案内であって、制御はサーバー側）。
- 一覧は `License_Cases` だけを読む（4軸の状態がそろっているため）。認証の理由とバッジの有無だけを `Certificates` / `Badges` から1回まとめて引く。

---

## 6. 移行の進め方

1. `admin_getCaseBoard` / `admin_getCasePanel` / `admin_applySwitch` を追加し、テスト（`tests/harness.js`）で
   「スイッチの enabled と、実際に押した結果が一致する」ことを全スイッチ・全現在地の組み合わせで確かめる。
2. 新画面 `admin_board.html` を作り、旧画面と並べて置く（`?view=board`）。
3. 運用で問題がなければ既定の画面を新画面に切り替え、旧タブ（ダッシュボード／ライセンス／作品審査／認証管理）を外す。設定は歯車パネルへ移す。

## 7. 決定事項（2026-11-17）

| 論点 | 決定 |
|---|---|
| 事務局運営（会議・議決・報告・精算） | 1枚には入れない。設定と同じ**別パネル**（歯車から開く。タブ「設定」「事務局運営」） |
| S4 入金未確認で停止 | 当面は**担当者1名のスイッチ**。のちに**申請→別担当者の承認（2名体制）**へ移す。切り替えは設定パネルの運用ルール `FEE_HOLD_TWO_PERSON`（Config）で行い、コードの書き換えなしで移行できるようにする |
| 契約書の送り方 | **2段契約にする**（§8）。基本契約（参加契約）は formrun（CloudSign FORM）→ CloudSign で1人1回。個別契約（個別利用許諾書）は SPLL が台帳から作り **CloudSign API で送る**。※当初の「全部を API 送付」は、個人情報の入力を formrun に置くため取りやめ |
| 基本契約の相手方 | 未決（法務確認）。案A：事務局が各権利者の代理人として締結／案B：事務局が再許諾権に基づき自ら締結。ひな形は両案を併記 |

未決：一覧の既定の絞り込み（モックは「要対応」）。

## 8. 2段契約（基本契約＋個別契約）

### 8.1 契約の構成

| | 基本契約（参加契約） | 個別契約（個別利用許諾書） |
|---|---|---|
| 単位 | クリエーター1人につき1本（参加者番号） | ライセンス1本ごと（SPLL番号）。数の上限なし |
| 中身 | 当事者（氏名・住所・メール）、共通条件、振込先、個別契約の成立方法 | 対象作品（別表1・行数の上限なし）、利用区分、許諾期間、利用許諾料、支払期日、利用報告、権利表記、特約 |
| 作る人 | クラウドサインのテンプレート（固定文面）。formrun が当事者欄を差し込む | SPLL が台帳（申込時に確定した条件）から PDF を作る |
| 送り方 | サイト → formrun（CloudSign FORM）→ CloudSign | CloudSign API（POST /documents → /files → /participants → /sent） |
| 個人情報 | formrun で入力。SPLL が受け取るのは氏名・メール（今と同じ） | 氏名・参加者番号・送付先メールだけ。住所は載せない |
| 正本 | `docs/SPLL_基本契約書_参加契約_v5.0.md` | `docs/SPLL_個別利用許諾書_v1.0.md` |

サンプルPDF（基本契約 案A／案B、個別利用許諾書 3作品／25作品）は `docs/contract/`。組み立ては `docs/contract/build_contract.js`。

### 8.2 流れ

```
【初回】
サイトで原作を選んで申込 → SPLL番号・別表を確定（APPLICATION_RECEIVED）
  └ 基本契約が無い → formrun へ（URL に載せるのは 参加者番号・照合トークン・ハッシュだけ）（CONTRACT_PENDING）
       → CloudSign で基本契約に同意 → 締結 Webhook → 参加者の基本契約 ACTIVE
  → 待っている個別契約を自動で作成・送付（CLOUDSIGN_SENT → SIGNING）
  → CloudSign で個別利用許諾書に同意 → 締結 Webhook → 照合コードを確認（CLOUDSIGN_SIGNED → AWAITING_SUBMISSION）

【2本目以降】
サイトで原作を選んで申込（基本契約の登録メール宛ての申込リンクから）→ すぐに個別利用許諾書を送付 → 同意 → 提出待ち
```

- 個別確認（`MANUAL_REVIEW`）に回った申込は、事務局の確認後に S1 で送る。
- 個別利用許諾書の作成と送付は申込の処理と切り離し、即時起動のトリガーか5分バッチで行う（GAS の実行時間とサイトの応答時間のため）。完了画面は「契約書を数分以内にメールでお送りします」。
- 申込から送付までに原作マスタが変わっても、個別利用許諾書は申込時に確定した内容で作る。

### 8.3 これで不要になるもの

- formrun の URL 長の検査（`FORM_URL_MAX_CHARS`）と、3作品を超えたら個別確認に回す処理。
- 作品名・金額・権利表記を formrun の hidden 項目で運ぶこと（`FORM_HIDDEN_MAP_*` は当事者欄と照合用の項目だけになる）。
- 締結後の条件照合で HOLD になる経路の大半（基本契約は固定文面、個別契約は SPLL が作るため）。

### 8.4 システムへの影響

- 台帳：`Participants`（参加者番号・氏名・メール・基本契約の CloudSign 書類ID・版・状態・締結日時）を新設。`License_Cases` に `participant_id` を足す。
- 状態遷移：参加者側に `AGREEMENT_SIGNED` / `AGREEMENT_TERMINATED` を新設。基本契約の締結で、待っている案件に `CLOUDSIGN_SENT` を自動で起こす。基本契約の終了で、その参加者の全案件に `CONTRACT_TERMINATED`。
- 締結 Webhook：書類IDで「基本契約」か「個別契約」かを振り分ける。
- 管理画面：案件の詳細に「参加者（基本契約）」欄を足す。S1 は個別利用許諾書の送付、S10（基本契約の終了・承認制）を追加。
- 確認が要ること：CloudSign のプランで API 送付が使えるか。API で送った書類でも、受信者の同意操作が FORM 経由と同じになるか。

## 9. モック

`docs/SPLL_管理画面1枚化モック_v0.1.html`（サンプルデータで操作できる）。操作者の切り替えで権限と職務分離、
設定パネルの「2名体制」で S4 の形の変化、個別利用許諾書のプレビューで作品数を増やしたときの別表のページ送り、
「基本契約待ち」の案件で基本契約の締結から個別契約の自動送付までの流れを確認できる。

---

# 付録：CloudSign FORM で「作品数の上限なし」にできるか

## 結論

**今の方式（formrun の初期値つきURLで条件を渡し、CloudSign のテンプレートに差し込む）では、上限なしにはできない。**
制約は2か所にある。

| 箇所 | 制約 | 根拠 |
|---|---|---|
| ① フォームへの受け渡し | 初期値つき公開フォームURLは**1000文字まで**。超えるとエラーページになる | formrun 公式FAQ「フォームに初期値を設定する方法」 |
| ② 契約書のレイアウト | CloudSign のテンプレートは**決まったPDFの上に入力欄を置く**方式。欄は文字量に応じて伸びず、ページも増えない。1行おおむね60字で自動改行し、フォントの変更はできない（大きさの扱いはヘルプ間で記述が分かれる） | クラウドサイン ヘルプ（テキストの改行、フォント・サイズ） |

いまの実装では①により、URLの安全上限を850字（`FORM_URL_MAX_CHARS`）に置き、**実測で3作品まで**が自動締結の対象になっている
（`docs/SPLL_CloudSign_FORM_実装仕様_v2.1.md` §4）。`FORM_MAX_WORKS` は5だが、URL長の検査が先に効く。

## ① 受け渡しの上限は外せる見込みがある

formrun の「コード型フォーム」（自前のHTMLから formrun へPOSTする形式）は、クラウドサイン連携の対象と案内されている。
URLに値を載せないため1000字の制約がなくなり、1行テキストは10,000字まで入る。
公開サイト（Cloud Run）からPOSTすれば、作品数を増やしても受け渡しはできる。

ただし次は**実機で確認が要る**：コード型フォームで hidden 項目がクラウドサインの差込欄に紐づけられるか、
2024年7月の「クリエイターフォームでのコード型フォーム併用の廃止」が今の構成に影響しないか。

## ② 契約書の差し込みは、テンプレート方式のままでは上限が残る

受け渡しの上限を外しても、テンプレート上の欄の大きさは決まっている。

- **作品名を1つの欄に連結する方式（現行）**：欄の高さを超えた分は表示されない（または欄からはみ出す）。何作品まで入るかは欄の大きさと作品名の長さで決まり、固定の上限にはならないが、無制限にもならない。
- **作品ごとに欄を並べる方式**（`work_title_1`〜`_N`）：上限は欄の数Nになる。

## 上限なしにするための選択肢

| 案 | 内容 | 作品数 | 主な手間・リスク |
|---|---|---|---|
| A. 別紙目録で特定する | 契約書には「対象作品：SPLL番号○○に係る別紙目録記載のとおり（計N作品・目録ハッシュ××）」とだけ差し込み、目録は締結前に公開サイトで提示し、締結後は検証ページで公開する | 無制限 | 目録が契約書PDFの外にある。**法務の判断が要る**（契約書だけで原著作物を特定できない） |
| B. CloudSign API で直接送る | 作品数に合わせた契約書PDFをGAS（Googleドキュメントのひな形→PDF）で作り、CloudSign API で送付する。`30_cloudsign.gs` に書類作成・PDF添付・送付の関数（`cs_createDocument_` / `cs_attachFile_` / `cs_sendDocument_`）がすでにある | 無制限（ページが伸びる） | PDF生成と送付処理の実装。フォーム画面は公開サイトの申込ウィザードが担う。CloudSign API が使えるプランかの確認 |
| C. 現行のまま | 3作品を超える申込は個別確認（`MANUAL_REVIEW`）へ回す | 3程度 | 4作品以上は事務局の手作業 |

**推奨は B。** ※最終的には、基本契約を formrun 経由・個別契約を API 送付とする2段契約を採用した（本文 §8）。 1ライセンス＝1作品で、1作品が複数の原作を使う形なので、「対象原作」は契約の中核であり、契約書PDFの中に全件を載せるべき。
B なら formrun の1000字制約とテンプレートの欄の大きさの両方から外れる。締結の Webhook（`35_webhooks.gs` の CloudSign 受信）と
条件の改変検知（スナップショットのハッシュ）はそのまま使える。
B に移るまでの間は C を続け、必要ならコード型フォームで①だけを外して上限を3から数件増やす。

## 参照

- formrun FAQ「フォームに初期値を設定する方法」 https://faq.form.run/en/faq/initialvalue
- formrun FAQ「フォームに設置できる項目について」 https://faq.form.run/faq/formtab
- formrun FAQ「クラウドサイン連携について」 https://faq.form.run/faq/cloudsign-form-integration
- formrun「すべてのプランでご利用可能なクラウドサイン連携がリリースされました」 https://form.run/media/news/cloudsign-integration202405/
- formrun「クリエイターフォームにおけるコード型フォームの併用利用を廃止いたします」 https://form.run/media/news/form-abolition-202407/
- クラウドサイン ヘルプ「テキストの改行」 https://help.cloudsign.jp/en/articles/996851
- クラウドサイン ヘルプ「フリーテキスト/押印のサイズ・フォント変更」 https://help.cloudsign.jp/en/articles/2084651

※ formrun FAQ の本文は、この作業環境からは直接開けなかった。検索結果に出た記述をもとにしている。
