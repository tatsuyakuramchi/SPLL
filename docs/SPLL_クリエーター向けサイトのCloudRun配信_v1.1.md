# SPLL クリエーター向けサイトの Cloud Run 配信 v1.1

**対応**：Public Web移行設計 §3・§21.1・§21.4・§21.5・§23 Phase 2〜5
**作成日**：2026-08-26（v1.1：提出・案内・検証・バッジの各ページを追加）

GASで作ったクリエーター向けの画面を、そのままコンテナから配信する。
業務の正本はスプレッドシートのままで、Cloud Run はデータを持たない。

**GASを2プロジェクトへ集約するための前段**でもある。公開ページをすべてCloud Runへ移すと、
GASに残るのは「業務処理（Webhook・バッチ）」と「管理コンソール」だけになる（§8）。

---

## 1. 構成

```text
          ブラウザ
             │  HTML（コンテナから配信）
             ▼
    ┌─────────────────────┐
    │ Cloud Run           │
    │ apps/public-web     │
    │  ・画面の配信        │
    │  ・/api/rpc         │
    │  ・読み取りキャッシュ │
    └──────┬───────┬──────┘
           │       │ 署名付きPOST（共有鍵＋許可リスト）
           ▼       ▼
     GAS① portal  GAS② workflow
     （申込）      （提出・案内・検証・バッジ／Webhook）
           │       │
           ▼       ▼
      スプレッドシート（正本）
```

### 配信するページ

URLの形はGAS②と同じにしてある。**`WORKFLOW_URL` を差し替えるだけ**で、
発行済みリンクの作り方を変えずに移行できる。

| URL | 内容 | データの取得先 |
|---|---|---|
| `/` | 申込窓口 | GAS① |
| `/?page=guide&t=…` | 締結後のお手続き案内 | GAS② |
| `/?page=upload&t=…` | 作品提出 | GAS② |
| `/?page=badge&t=…` | 認証バッジの取得 | GAS② |
| `/?page=verify&id=&c=…` | ライセンス認証の確認（QRの遷移先） | GAS② |

トークン付きのページは `Cache-Control: no-store` で返す。

**画面の実装は二重に持たない。** コンテナは `spll_src/*.html`（GASが配信しているものと同一）を読み、
GASの `doGet` と同じ結合・差込を行う。差分は「`google.script.run` のかわりに
HTTPでRPCする shim を先に読み込ませる」ことだけ。

- 申込窓口：`index.html` ＋ `portal_contract_v4_patch.html` を結合
- 案内・提出：`guide.html` / `upload.html` の `<?= token ?>` にトークンを差し込む
  （差込はこの1箇所だけ。トークンはURLに現れる文字以外を落としてから入れる）
- 検証・バッジ：GAS側でもサーバー描画だったため、Cloud Run でもサーバー側で組む
  （判定はGAS②の `web_verifyCertificate` / `web_getBadgeContext` が行い、表示だけを担う）

意匠を直したいときは `spll_src/*.html` を直せば、GAS版とCloud Run版の両方に反映される。

---

## 2. RPC（データ取得）

`google.script.run` はGASのiframe内でしか動かないため、公開Webからは使えない。
そこで **限られた関数だけをJSONで呼べる口** をGAS①に用意した。

### 呼べる関数（これだけ）

**GAS①（申込。スプレッドシートしか触れない狭い権限）**

```text
api_listWorks           原作一覧
api_getUsageOptions     利用目的の選択肢
api_previewFeeTerms     利用料条件のプレビュー
api_getLegalTexts       法務文書（旧API）
api_getLegalTextsV4     法務文書（PRIVACY＋GUIDELINE）
api_getApplyConfig      フォームURL・法人の案内先・上限件数
web_createApplicationV4 申込作成
```

**GAS②（提出・案内・検証・バッジ。各関数の中でトークン／照合コードを検証する）**

```text
web_getSubmitContext         提出ページの内容
web_submitWork               作品の提出（20MBまで）
web_openDriveSubmission      大容量提出のフォルダ払出し
web_finalizeDriveSubmission  大容量提出の確定
web_getGuideContext          案内ページの内容（振込先・提出・バッジ）
web_getSubmitLinkFromGuide   提出リンクの再発行
web_verifyCertificate        認証の照会
web_getBadgeContext          バッジのメタ情報
web_getBadgeImage            バッジ画像（1枚ずつ）
```

GAS②のRPCは**Webhookと同じURLに同居する**ため、`?rpc=1` が付いたPOSTだけをRPCとして扱う。
Webhookの受信経路は従来どおり変わらない。

`admin_*` / `setup_*` / トークン発行は **portal のコードに存在しない**（SEC-01のビルド分割）うえ、
許可リストにも無いので二重に届かない。`api_getViewerRole`（管理者判定）も外してある。
公開サイトにGoogleログインの概念が無く、管理コンソールの入口を出す意味がないため、
shim側で常に「非管理者」を返して打ち切る。

### 守り方

| # | 何を | どう |
|---|---|---|
| 1 | 呼べる関数 | 名前の一致だけでは呼ばない。`publicWebRpcHandlers_()` に書いた関数だけを呼ぶ（グローバルからの動的解決をしない） |
| 2 | 呼べる相手 | `PUBLIC_WEB_KEY` と一致しないリクエストは処理しない。**未設定なら常に拒否**（フェイルクローズ） |
| 3 | 呼べる回数 | 申込作成はコンテナ側でIPごとに時間あたり5回まで。GAS側の `rateLimit_` も従来どおり効く |
| 4 | 応答 | 常に `{ok:boolean, ...}`。拒否の文言は共通にして、関数の存在を推測させない |

申込が拒否された理由（法人お断り・原作の非公開・同意の版ずれ）は**利用者への案内**なので、
そのまま画面へ返す。

### 読み取りキャッシュ

`api_listWorks` などの読み取りは、コンテナのメモリに既定60秒だけ保持する。
一覧を開くたびにスプレッドシートを読まないため、アクセスが集中してもGASの実行回数が増えない。
`web_createApplicationV4` はキャッシュしない。

---

## 3. 設定値

### Cloud Run（環境変数）

| 変数 | 必須 | 既定 | 内容 |
|---|:-:|---|---|
| `GAS_PORTAL_URL` | ○ | — | GAS① のウェブアプリURL（`/exec`） |
| `GAS_WORKFLOW_URL` | ○ | — | GAS② のウェブアプリURL（`/exec`） |
| `PUBLIC_WEB_KEY` | ○ | — | GAS①・GAS② の同名ScriptPropertyと同じ値 |
| `PORT` | — | 8080 | Cloud Runが渡す |
| `CACHE_TTL_SECONDS` | — | 60 | 読み取りキャッシュの保持時間 |
| `APPLY_RATE_LIMIT` | — | 5 | 申込作成の上限（IP／時間） |

`GAS_PORTAL_URL` か `PUBLIC_WEB_KEY` が未設定だと `/healthz` は 503 を返す。

### GAS①・GAS②（スクリプト プロパティ）

| キー | 内容 |
|---|---|
| `PUBLIC_WEB_KEY` | 32文字以上の乱数。**3か所（GAS①・GAS②・Cloud Run）で同じ値** |

鍵の作り方（どちらでも可）：

```bash
openssl rand -hex 24
```

---

## 4. デプロイ手順

### 4.1 GAS側

1. `npm run deploy:all` でRPCの受け口を含む版を反映する
2. **GAS① と GAS② の両方**の「プロジェクトの設定 → スクリプト プロパティ」に
   `PUBLIC_WEB_KEY`（同じ値）を追加
3. ウェブアプリのアクセス権は従来どおり **全員（匿名を含む）**
   （鍵を知らないPOSTは `doPost` が即座に拒否する）

### 4.2 Cloud Run側

**Dockerfile はリポジトリのルートに置いていない**（`spll_src/*.html` を拾うためコンテキストはルート、
Dockerfile は `apps/public-web/`）。`gcloud builds submit --tag` はコンテキスト直下の Dockerfile しか
見ないので、同梱の `cloudbuild.yaml` を指定する。

```bash
# 0. 置き場所と鍵（初回のみ）
gcloud artifacts repositories create spll \
  --repository-format=docker --location=asia-northeast1

openssl rand -hex 24 | gcloud secrets create spll-public-web-key --data-file=-

# 1. ビルド（リポジトリのルートで実行）
gcloud builds submit --config apps/public-web/cloudbuild.yaml \
  --substitutions _IMAGE=asia-northeast1-docker.pkg.dev/PROJECT/spll/public-web

# 2. デプロイ
gcloud run deploy spll-public-web \
  --image asia-northeast1-docker.pkg.dev/PROJECT/spll/public-web:latest \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars GAS_PORTAL_URL=https://script.google.com/macros/s/XXXX/exec,GAS_WORKFLOW_URL=https://script.google.com/macros/s/YYYY/exec \
  --set-secrets PUBLIC_WEB_KEY=spll-public-web-key:latest

# 3. Cloud Run のサービスアカウントに鍵の読み取りを許可（初回のみ）
gcloud secrets add-iam-policy-binding spll-public-web-key \
  --member=serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

鍵は環境変数に直書きせず Secret Manager に置く。**同じ値を GAS① のスクリプト プロパティ
`PUBLIC_WEB_KEY` にも入れる**（`gcloud secrets versions access latest --secret=spll-public-web-key` で取り出せる）。

イメージに入るのは次の5ファイルだけ（約100KB）。台帳・鍵・GASの管理コードは入らない。

```text
apps/public-web/Dockerfile
apps/public-web/cloudbuild.yaml
apps/public-web/page.js
apps/public-web/server.js
apps/public-web/verify-page.js
spll_src/index.html
spll_src/portal_contract_v4_patch.html
spll_src/guide.html
spll_src/upload.html
```

### 4.3 動作確認

```bash
curl -s https://（Cloud RunのURL）/healthz
# → {"ok":true,"service":"spll-public-web","gas":true,"key":true}
```

そのうえで画面を開き、**原作一覧が表示されること**（＝RPCが通っていること）を確認する。
取得に失敗した場合、画面は「現在申込を受け付けられません」を表示して申込を止める（フェイルクローズ）。

### 4.4 ローカルでの確認

```bash
GAS_PORTAL_URL=https://script.google.com/macros/s/XXXX/exec \
GAS_WORKFLOW_URL=https://script.google.com/macros/s/YYYY/exec \
PUBLIC_WEB_KEY=（同じ鍵） \
npm run web:dev
# → http://localhost:8080
```

### 4.5 リンクの向き先を切り替える

ここまでで Cloud Run 上に全ページが揃う。管理コンソール「設定」で次を切り替えると、
**以後に発行する案内・提出・バッジ・検証のリンクがCloud Runを指す**。

| 設定 | 値 | 効くもの |
|---|---|---|
| `WORKFLOW_URL` | Cloud RunのURL | 案内ページ・提出リンク・バッジ配布リンク |
| `PUBLIC_BASE_URL` | 独自ドメイン | 認証バッジのQR（`https://（ドメイン）/v/…`） |

`PUBLIC_BASE_URL` は**そのドメインで検証ページが開けるようになってから**設定する。
QRは頒布物に印刷されて回収できない。なおCloud Runの検証ページは現状 `?page=verify&id=&c=` 形式で、
`/v/{cert_id}?c=` 形式のQRを使うならロードバランサ等での書き換えが要る（未実装）。

---

## 5. 独自ドメイン

Cloud Run のドメインマッピング、またはロードバランサで独自ドメインを当てる。
**QRの発行先は別の設定**である点に注意する。認証バッジのQRは `PUBLIC_BASE_URL`（Config）で決まり、
検証ページは現状GAS②が配信している。QRを独自ドメインへ向けるのは、
そのドメインで検証ページが開けるようになってからにする（QRは頒布物に印刷されて回収できない）。

---

## 6. この段階でやっていないこと

| 内容 | いつ |
|---|---|
| PostgreSQL（public projection・Webhook受信箱・ジョブ） | 移行設計 §4.2／Phase 3以降 |
| Webhook受信のCloud Run移行 | Phase 3。現状はGAS②が受ける（受ける必要がある：formrun/CloudSignは匿名POST） |
| `/v/{cert_id}` 形式のQR URL | ロードバランサでの書き換え、またはルート追加 |
| GAS公開ページの停止 | Phase 6。現状はGASのURLも生きている |

GASのURLも従来どおり動くので、切り戻しは `WORKFLOW_URL` を戻すだけで済む。

---

## 8. GASを2プロジェクトへ集約する（次の段階）

公開ページがCloud Runへ揃ったので、GASに残る役割は次の2つになる。

| 残すもの | 中身 | アクセス |
|---|---|---|
| **業務処理** | Webhook受信（formrun・CloudSign）、定期バッチ、AI審査、バッジ生成、公開Web向けRPC | 匿名（鍵・署名で防御） |
| **管理コンソール** | 台帳・審査・契約管理・事務局運営・設定・セットアップ | 組織内限定 |

GAS① portal は、画面の配信をやめた今、申込RPCだけを持つ。これを業務処理側へ移せば2つになる。

**移すときに失うもの**：GAS① は3つの中で最も権限が狭い（スプレッドシート＋メアドのみ）。
統合すると、匿名で叩かれる申込RPCが Drive・Gemini・メール送信・トリガーを持つプロジェクトの中に入る。
許可リストと共有鍵は維持されるため到達できる関数は変わらないが、**万一の踏み台としての射程は広がる**。

判断の材料：

- 統合する利点 … clasp・ScriptProperties・デプロイが1つ減る
- 統合しない利点 … 申込の入口を最小権限に閉じ込めたままにできる

いずれにせよ、まずは本書の切替（`WORKFLOW_URL`）を本番で動かし、
Cloud Run 経由の導線が安定してから判断するのが安全。

---

## 7. テスト

`npm test` の `tests/public_web.js`（103件）で次を固定している。

- 画面がGASと同じ正本から組み立てられていること（意匠の二重管理をしていないこと）
- shim が本体スクリプトより先に読み込まれること（`hasGas` 判定に間に合うこと）
- 画面にもサーバーにも `admin_*` / `setup_*` / `api_getViewerRole` の経路が無いこと
- 提出・案内ページのトークン差込が1箇所であり、URL以外の文字を差し込まないこと
- 検証ページが状態で表示を変え、無効の理由を出さないこと
- バッジ画像がサイズごとに別URLで、1回の応答を重くしないこと
- GAS②が `?rpc=1` のPOSTだけをRPCとして扱い、Webhookと混ざらないこと
- 読み取りはキャッシュされ、申込作成はキャッシュされないこと
- 申込作成がIPごとに制限されること
- GAS①の受け口が共有鍵を要求し、未設定なら常に拒否すること
- 申込→フォーム引継ぎが成立すること（RPCの応答が `form_url` / `form_fields` /
  `handoff_token` / `terms_snapshot_hash` / `template_route` を運び、v4パッチの
  `buildFormUrl` でhidden項目IDに載ったURLが上限内で組み上がること）
- Webhookの受け口をCloud Runへ移していないこと（締結はGAS②のまま）
- コンテナにリポジトリ全体を入れていないこと・Cloud Buildの設定が正しいこと
