# SPLL 手動テスト手順（開発環境）

**版** v1.1（Finance削除を反映） ／ **対象** development環境での動作確認（formrun・CloudSign実連携なしでの擬似テスト）
**前提** portal / workflow / admin がデプロイ済み（`npm run deploy:*`）

> 本手順は「実外部サービスを使わずに全業務フローを一周する」ためのものです。
> ステージング統合テスト（実CloudSign接続・15シナリオ）はフォーム構築後に別途実施します。

---

## フェーズ0：事前チェック（5分）

> **初期設定がまだ・不安な場合**：adminのGASエディタで **`setup_all`** を1回実行すると、
> ENVIRONMENT・台帳・スキーマ移行・初期管理者・HANDOFF_SECRET・ライセンス台帳移行までまとめて整い、
> 他プロジェクトへ転記するプロパティ一覧が実行ログに出ます（冪等・既存は再利用）。
> その後 workflow で `setup_workflowAll` を実行。

adminのGASエディタで一時関数を実行して確認：

```javascript
function checkReady(){
  Logger.log('ENVIRONMENT: ' + PropertiesService.getScriptProperties().getProperty('ENVIRONMENT'));   // development
  Logger.log('管理者: ' + JSON.stringify(readRows_(ssOps_(),'Admin_Users').map(u=>u.email+'/'+u.role)));
  Logger.log('スキーマ: ' + JSON.stringify(readRows_(ssOps_(),'Schema_Versions').slice(-2)));          // version 6
  Logger.log('Applicationsに新列: ' + (readRows_(ssOps_(),'Applications').length===0 ? '（行なしのため列ヘッダをシートで確認）'
    : ('cloudsign_send_status' in readRows_(ssOps_(),'Applications')[0])));
}
```

- [ ] `ENVIRONMENT = development`（3プロジェクトとも）
- [ ] 管理者に自分のアカウントが SYSTEM_ADMIN で登録済み
- [ ] `setup_migrate` 実行済み（Schema_Versions に version 6）
- [ ] portalの ScriptProperties に `ADMIN_CONSOLE_URL`（adminの/exec URL）

以降で使うURLを控える：

| 記号 | URL |
|---|---|
| `PORTAL_URL` | portalの `https://script.google.com/.../exec` |
| `WF_URL` | workflowの `https://script.google.com/.../exec` |
| `ADMIN_URL` | adminの `https://script.google.com/.../exec` |

---

## フェーズ1：画面スモークテスト（10分）

1. `PORTAL_URL` を開く → 公開作品一覧が表示される
2. ログイン状態（管理者アカウント）で「管理コンソール」ボタンが表示され、クリックで admin へ遷移
3. `ADMIN_URL` → 各タブ（ダッシュボード／ライセンス／作品審査管理／契約管理／設定）がエラーなく開く
4. `WF_URL?page=verify` → 検証ポータルの入力画面が出る

---

## フェーズ2：申込〜契約〜認証（Webhook擬似送信・15分）

### 2.1 申込作成（portal）

1. `PORTAL_URL` で原作を選択（例：2作品）→ 利用目的を選択 → 同意チェック → 申込
2. 完了画面の **application_ref（REF-YYYYMM-XXXXXX）を控える**

> **法人の退避確認（CloudSign FORM v4）**：契約者の区分で「法人」を選ぶと、申込ボタンが
> 無効化され法人向け問い合わせ窓口が表示されること（申込レコード・SPLL番号は作られない）。
> 案内先は admin「設定→FormRun／クラウドサインフォーム→申込導線」で差し替えられる
> （URL／メールどちらでも可・プレビューで表示を確認）。初期値はダミーアドレスのため、
> 本番前に実際の受け口へ変更すること。
3. admin「契約管理」に申込が「締結待ち」で出ることを確認

### 2.2 formrun Webhook（フォーム回答の擬似送信）

コマンドプロンプトから（`REF-…` と `WF_URL` を差し替え）：

```bat
curl -L -H "Content-Type: application/json" -d "{\"application_ref\":\"REF-XXXXXX-XXXXXX\",\"submission_id\":\"TEST-FR-1\",\"columns\":[]}" "WF_URL?hook=formrun"
```

期待：`ok` が返り、台帳の Applications が `CONTRACT_PENDING`／`cloudsign_send_status=CLOUDSIGN_SENDING` になる。

### 2.3 CloudSign締結Webhook（締結の擬似送信）

> **重要**：workflowの ScriptProperties に `CLOUDSIGN_CLIENT_ID` が設定されていると、実APIへ照会に行き
> 擬似書類IDでは失敗します。**擬似テスト中は一時的に `CLOUDSIGN_CLIENT_ID` の値を空にする**（テスト後に戻す）。

```bat
curl -L -H "Content-Type: application/json" -d "{\"document_id\":\"DOC-TEST-1\",\"status\":\"COMPLETED\",\"application_ref\":\"REF-XXXXXX-XXXXXX\"}" "WF_URL"
```

期待：`ok` が返り、
- [ ] admin「契約管理」で契約が **SIGNED／認証=有効**
- [ ] 台帳 Contracts の `terms_verification_status=VERIFIED`
- [ ] Certificates・Badges（またはBadge_Jobs）・Access_Tokens（SUBMISSION）が発行
- [ ] License_Cases が SIGNED／Finance_Handoffs に READY の引渡行（経理側が参照するスナップショット）

### 2.3.0 連絡先メールの取得

締結後、`Contracts` の `contact_email` / `contact_email_source` を確認する。

- [ ] `contact_email_source = CLOUDSIGN`（CloudSign照会が効いている＝実際に契約書が届いた宛先）
- [ ] 自社アカウントのアドレスになっていない（`OFFICE_EMAIL_DOMAIN` を設定しておく）
- [ ] admin「ライセンス」タブの契約者欄に連絡先が併記される

> CloudSign資格情報が未設定の開発環境では `FORM`（フォーム入力値）にフォールバックします。
> その場合は `FORMRUN_FIELD_MAP` に `"メールアドレス":"contact_email"` を追加してください。

### 2.3.1 「今後のお手続き」案内ページ

締結すると、ダッシュボードの「要対応の通知」に <span class="mono">GUIDE_READY</span> が起票され、案内ページURLが入ります。

1. admin「設定→手続き案内・振込先」で振込先と `WORKFLOW_URL`（GAS②の /exec）を設定
2. admin「契約管理」→ 対象契約の「案内リンク」→ 表示されたURLを開く
   - [ ] SPLL番号・契約者・対象原作・利用許諾料が出る
   - [ ] 振込先が出る（未設定ならお支払い欄そのものが出ない）
   - [ ] 「作品提出ページを開く」で提出ページが別タブで開く
   - [ ] 「認証バッジをダウンロード」でQR入りPNGが取得できる
3. 振込先を変更して保存 → **同じURLを再読込すると新しい口座が表示される**（案内はメールに焼き付けない）
4. 「案内リンク」を再発行 → 以前のURLを開くとエラーになる

### 2.3.2 案内メールの自動送信

1. admin「設定→手続き案内・振込先→案内メールの自動送信」で、差出人名・返信先を設定し「テスト送信」で自分宛に見本を受信
   - [ ] 件名にSPLL番号、本文に案内ページURLが入っている
   - [ ] **本文に口座情報が入っていない**（振込先は案内ページのみ）
2. 締結から5分待つ（またはworkflowのGASエディタで `trigger_every5min` を手動実行）
   - [ ] 契約者の連絡先へ案内メールが届く
   - [ ] ダッシュボードの要対応一覧から `GUIDE_READY` が消える（送信済）
3. 連絡先が取れていない案件は送信されず、要対応一覧に残ることを確認

> 停止したい場合は同画面のチェックを外します（`GUIDE_EMAIL_AUTO_SEND=false`）。
> 送信失敗は3回まで自動再試行し、超えると `SEND_FAILED` として要対応一覧に理由つきで残ります。

### 2.3.3 認証のオン／オフ（未入金対応）

1. admin「契約管理」→ 締結済み契約の「**認証をオフ（未入金）**」→ 理由を入力
   - [ ] 認証が「未入金で停止」表示になる
   - [ ] ライセンスタブの認証状態も同じになる
   - [ ] バッジQR（または検証ページ）で照会すると「**無効**」と表示される
2. 「**認証をオン（入金確認）**」で戻す
   - [ ] 検証が「確認済み」に戻る

> 失効（REVOKED）は別扱いで、申請→別担当者の承認が必要です。失効中の契約はこのスイッチでは戻せません。

### 2.4 条件不一致（TERMS_MISMATCH）の確認

2.1でもう1件申込を作成し、**2.2をスキップして** 2.3の締結Webhookだけ送る（document_idは別の値に）。

期待：応答 `accepted-manual-review`。契約は作成されるが認証は発行されず、
admin「契約管理」タブの「条件不一致（TERMS_MISMATCH）」に表示 → 「条件確認済み（有効化）」で認証発行。

### 2.5 メール不達の確認

```bat
curl -L -H "Content-Type: application/json" -d "{\"document_id\":\"DOC-TEST-1\",\"status\":\"signing_email_bounced\"}" "WF_URL"
```

期待：「契約管理」タブの「メール不達」に表示 → 「対応済みにする」で消える。

---

## フェーズ3：提出〜審査（15分）

1. admin「契約管理」→ 対象契約の「提出リンク発行」→ URLを開く
2. PDFを提出 → AI一次チェック
   - GCP/Gemini設定済み：AI_SCREENED → 審査キューへ
   - 未設定：自動再試行の後 **AI_UNAVAILABLE → 人手審査へ回送**（これも正常系）
3. 提出ページに「認証バッジ」リンク → バッジPNGが表示・ダウンロードできる
4. admin「作品審査管理」→ 承認／是正（是正コメントが提出ページに出る）
5. 検証ポータル：admin契約管理で照合コード再発行（rotate）→ 表示されたURLで「確認済み」表示


### 3.1 大容量提出（専用Driveフォルダ）

20MBを超える作品（動画・音楽・印刷入稿データ・立体データ等）の経路を確認する。

1. 提出ページで作品名を入力 →「大容量ファイルを提出」を選択 → 「提出用フォルダを作成する」
2. 「提出用フォルダを開く」でDriveが開く → 大きめのファイルを投入（形式は自由）
3. ページに戻って「提出を確定する」
   - [ ] 受領ファイル数・合計サイズが完了画面に出る
   - [ ] Driveフォルダの共有が解除されている（シークレットウィンドウでURLを開くと権限なし）
   - [ ] `Submission_Files` に全ファイルが記録されている
   - [ ] PDF/PNG/JPEGを含む場合はAI審査が起票、含まない場合は「人手審査で確認します」と表示
4. 確定せずにページを閉じ、再度提出リンクを開くと **受け口が復帰**して「提出を確定する」から続行できる
5. 空のまま確定 → エラー、上限（既定50ファイル・5GB）超過 → エラー

> 上限と開放日数はConfigで変更できます：`SUBMIT_FOLDER_MAX_FILES` / `SUBMIT_FOLDER_MAX_GB` /
> `SUBMIT_FOLDER_OPEN_DAYS`（未確定のまま期限を過ぎたフォルダは日次バッチが共有解除します）。

---

## フェーズ4：経理引渡データの確認（5分）

利用報告・請求・入金・清算は本システムの対象外（経理は独自運用）。締結時に作成される
**Finance_Handoffs**（SS_OPSシート）だけを確認する：

- [ ] 締結済み案件ごとに `status=READY` の行がある（license_id・handoff_version・works_snapshot_json・billing_terms_json）
- [ ] billing_terms_json の内容が契約条件（FLAT定額16,500円／RATE率）と一致
- [ ] 経理側の独自運用がこのシートを参照して請求・入金・清算を行う（取込後の状態更新は経理側の設計に従う）

---

## フェーズ5：後片付け

- [ ] workflowの `CLOUDSIGN_CLIENT_ID` を元に戻す（2.3で空にした場合）
- [ ] テストで作った申込・契約はそのままでOK（developmentの台帳）。本番移行前に `setup_reset` などで作り直す

## 既知の制約（このテストでは対象外）

- formrun・CloudSignの実接続（フォーム構築後のステージング統合テストで実施）
- X（Twitter）投稿・実メール
- 経理業務（利用報告・請求・入金・清算）：経理側の独自運用で実施
