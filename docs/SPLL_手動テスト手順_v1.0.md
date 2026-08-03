# SPLL 手動テスト手順（開発環境）

**版** v1.0 ／ **対象** development環境での動作確認（formrun・CloudSign実連携なしでの擬似テスト）
**前提** portal / workflow / admin がデプロイ済み（`npm run deploy:*`）

> 本手順は「実外部サービスを使わずに全業務フローを一周する」ためのものです。
> ステージング統合テスト（実CloudSign接続・15シナリオ）はフォーム構築後に別途実施します。

---

## フェーズ0：事前チェック（5分）

> **初期設定がまだ・不安な場合**：adminのGASエディタで **`setup_all`** を1回実行すると、
> ENVIRONMENT・台帳・スキーマ移行（v4）・初期管理者・HANDOFF_SECRET・経理台帳までまとめて整い、
> 他プロジェクトへ転記するプロパティ一覧が実行ログに出ます（冪等・既存は再利用）。
> その後 workflow で `setup_workflowAll`、accounting で `setup_accountingAll` を実行。

adminのGASエディタで一時関数を実行して確認：

```javascript
function checkReady(){
  Logger.log('ENVIRONMENT: ' + PropertiesService.getScriptProperties().getProperty('ENVIRONMENT'));   // development
  Logger.log('管理者: ' + JSON.stringify(readRows_(ssOps_(),'Admin_Users').map(u=>u.email+'/'+u.role)));
  Logger.log('スキーマ: ' + JSON.stringify(readRows_(ssOps_(),'Schema_Versions').slice(-2)));          // version 4
  Logger.log('Applicationsに新列: ' + (readRows_(ssOps_(),'Applications').length===0 ? '（行なしのため列ヘッダをシートで確認）'
    : ('cloudsign_send_status' in readRows_(ssOps_(),'Applications')[0])));
}
```

- [ ] `ENVIRONMENT = development`（3プロジェクトとも）
- [ ] 管理者に自分のアカウントが SYSTEM_ADMIN で登録済み
- [ ] `setup_migrate` 実行済み（Schema_Versions に version 4）
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
3. `ADMIN_URL` → 各タブ（ダッシュボード／作品審査管理／契約管理／入金・清算／**経理連携**／設定）がエラーなく開く
4. 経理連携タブの7サブタブ（原票取込〜処理ジョブ）が開く（データ0件表示でOK）
5. `WF_URL?page=verify` → 検証ポータルの入力画面が出る

---

## フェーズ2：申込〜契約〜認証（Webhook擬似送信・15分）

### 2.1 申込作成（portal）

1. `PORTAL_URL` で原作を選択（例：2作品）→ 利用目的を選択 → 同意チェック → 申込
2. 完了画面の **application_ref（REF-YYYYMM-XXXXXX）を控える**
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
- [ ] Certificates・Badges（またはBadge_Jobs）・Access_Tokens（SUBMISSION/REPORT）が発行
- [ ] 利用目的が定額系なら Invoices に請求が自動起票

### 2.4 条件不一致（TERMS_MISMATCH）の確認

2.1でもう1件申込を作成し、**2.2をスキップして** 2.3の締結Webhookだけ送る（document_idは別の値に）。

期待：応答 `accepted-manual-review`。契約は作成されるが認証は発行されず、
admin「経理連携→CloudSign例外対応→条件不一致」に表示 → 「条件確認済み（有効化）」で認証発行。

### 2.5 メール不達の確認

```bat
curl -L -H "Content-Type: application/json" -d "{\"document_id\":\"DOC-TEST-1\",\"status\":\"signing_email_bounced\"}" "WF_URL"
```

期待：「CloudSign例外対応→メール不達」に表示 → 「対応済みにする」で消える。

---

## フェーズ3：提出〜審査〜報告（15分）

1. admin「契約管理」→ 対象契約の「提出リンク発行」→ URLを開く
2. PDFを提出 → AI一次チェック
   - GCP/Gemini設定済み：AI_SCREENED → 審査キューへ
   - 未設定：自動再試行の後 **AI_UNAVAILABLE → 人手審査へ回送**（これも正常系）
3. 提出ページに「認証バッジ」リンク → バッジPNGが表示・ダウンロードできる
4. admin「作品審査管理」→ 承認／是正（是正コメントが提出ページに出る）
5. 検証ポータル：admin契約管理で照合コード再発行（rotate）→ 表示されたURLで「確認済み」表示
6. 報告リンク発行 → 売上報告 → admin「入金・清算」で承認

---

## フェーズ4：経理連携（20分）

### 4.1 経理台帳の初期化（初回のみ）

adminのGASエディタで `setup_accountingBootstrap` を実行（経理マスタ・年度台帳・Driveフォルダが自動作成される）。

### 4.2 テスト用CSVの用意

メモ帳に貼り付けて保存。**BOOTHはShift_JIS想定のため「ANSI」で保存**（または経理マスタの
Sales_Channels シートで BOOTH の default_encoding を UTF-8 に変更）。

`test_booth.csv`：
```csv
ショップ名,商品番号,商品名,SPLL申請番号,小売価格,数量,BOOST計,売上（税込）,ライセンス料（税込）
テストショップA,P-100,テストシナリオ集,SPLL:E107009,1500,2,0,3000,300
テストショップB,P-200,テスト商品,REF-XXXXXX-XXXXXX,1000,1,0,1000,100
テストショップC,P-300,不明な商品,SPLL:E999001,500,1,0,500,50
```
（2行目の `REF-…` はフェーズ2で締結済みの application_ref に差し替え）

`test_bank.csv`（ANSI保存）：
```csv
1,20260801,ヘッダ
2,2026-08-01,振込,ピクシブ（カ,0,450,100450
9,合計,1
```

### 4.3 取込→突合→配分→照合→出力

1. **原票取込**：対象月・BOOTH・`test_booth.csv` → アップロード → プレビュー（3件・450円）→ 取込開始
2. バッチが「要解決」になる → **未解決データ**：
   - `REF-…` の行 →「契約に紐付け」で契約IDを入力
   - `E999001` →「原作を設定」（例：`WRK-ARK00012:2,WRK-BKK00019:1`）
   - 原票取込に戻り「再突合」→ バッチが「突合済」
3. **配分プロファイル**（初回のみ・adminのGASエディタで）：
```javascript
function seedProfiles(){
  admin_accountingSaveDistributionProfile({work_id:'WRK-ARK00012',profile_name:'テスト配分',lines:[
    {partner_id:'PRT-ARK',calculation_type:'RATE',rate:0.25},
    {partner_id:'PRT-KAD',calculation_type:'RESIDUAL'}]});
  admin_accountingSaveDistributionProfile({work_id:'WRK-BKK00019',lines:[
    {partner_id:'PRT-BKK',calculation_type:'RESIDUAL'}]});
}
```
4. **配分確認**：対象月を選び「突合済バッチから作成」→ 状態が「承認待ち」・**差額0円**を確認 → サマリー表示 →「承認」
   - 作成者本人の承認は拒否される（職務分離）→ 別の管理者で承認するか、緊急理由を入力（EMERGENCY_OVERRIDE記録）
5. **入金照合**：`test_bank.csv` を取込 → 「照合候補を提示」→ ピクシブ入金450円がBOOTH候補に出る → 確定
6. **ファイル出力**：配分runのIDを入力 → 「経理（旧形式）」「権利者別（月次＋ZIP）」→ 出力履歴がGENERATED →
   Driveの `Accounting/2026/02_Accounting_Exports` 等にファイルができている → 「承認」→「清算連携」
7. 「入金・清算」タブ／Settlementsシートに権利者別の確定額が入り、**同じrunをもう一度連携すると拒否される**ことを確認

### 4.4 処理ジョブの確認

経理連携→処理ジョブ：SALES_PARSE / SALES_MATCH / ALLOCATION_CALCULATE などが「完了」になっていること。
（自動再試行のトリガー運用はGAS④作成後：`setup_accountingTriggers`）

---

## フェーズ5：後片付け

- [ ] workflowの `CLOUDSIGN_CLIENT_ID` を元に戻す（2.3で空にした場合）
- [ ] テストで作った申込・契約はそのままでOK（developmentの台帳）。本番移行前に `setup_reset` などで作り直す

## 既知の制約（このテストでは対象外）

- formrun・CloudSignの実接続（フォーム構築後のステージング統合テストで実施）
- X（Twitter）投稿・実メール
- 配分プロファイルの編集UI（当面はGASエディタの関数呼び出しで登録）
