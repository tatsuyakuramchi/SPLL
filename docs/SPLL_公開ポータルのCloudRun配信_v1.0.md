# SPLL 公開ポータルの Cloud Run 配信 v1.0

**対応**：Public Web移行設計 §3（Public Webの構造）・§21.1・§23 Phase 2
**作成日**：2026-08-26

GASで作った申込窓口の画面を、そのままコンテナから配信する。
業務の正本はスプレッドシートのままで、Cloud Run はデータを持たない。

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
    └──────────┬──────────┘
               │ 署名付きPOST（共有鍵＋許可リスト）
               ▼
       GAS① portal doPost
               │
               ▼
      スプレッドシート（正本）
```

**画面の実装は二重に持たない。** コンテナは `spll_src/index.html` と
`spll_src/portal_contract_v4_patch.html`（GAS①が配信しているものと同一）を読み、
GAS① の `doGet` と同じ順序で結合して配信する。差分は「`google.script.run` のかわりに
HTTPでRPCする shim を先に読み込ませる」ことだけ。

意匠を直したいときは `spll_src/index.html` を直せば、GAS版とCloud Run版の両方に反映される。

---

## 2. RPC（データ取得）

`google.script.run` はGASのiframe内でしか動かないため、公開Webからは使えない。
そこで **限られた関数だけをJSONで呼べる口** をGAS①に用意した。

### 呼べる関数（これだけ）

```text
api_listWorks           原作一覧
api_getUsageOptions     利用目的の選択肢
api_previewFeeTerms     利用料条件のプレビュー
api_getLegalTexts       法務文書（旧API）
api_getLegalTextsV4     法務文書（PRIVACY＋GUIDELINE）
api_getApplyConfig      フォームURL・法人の案内先・上限件数
web_createApplicationV4 申込作成
```

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
| `PUBLIC_WEB_KEY` | ○ | — | GAS① の同名ScriptPropertyと同じ値 |
| `PORT` | — | 8080 | Cloud Runが渡す |
| `CACHE_TTL_SECONDS` | — | 60 | 読み取りキャッシュの保持時間 |
| `APPLY_RATE_LIMIT` | — | 5 | 申込作成の上限（IP／時間） |

`GAS_PORTAL_URL` か `PUBLIC_WEB_KEY` が未設定だと `/healthz` は 503 を返す。

### GAS①（スクリプト プロパティ）

| キー | 内容 |
|---|---|
| `PUBLIC_WEB_KEY` | 32文字以上の乱数。Cloud Run側と同じ値 |

鍵の作り方（どちらでも可）：

```bash
openssl rand -hex 24
```

---

## 4. デプロイ手順

### 4.1 GAS①側

1. `npm run deploy:portal` でRPCの受け口を含む版を反映する
2. GAS① の「プロジェクトの設定 → スクリプト プロパティ」に `PUBLIC_WEB_KEY` を追加
3. ウェブアプリのアクセス権は従来どおり **全員（匿名を含む）**
   （鍵を知らないPOSTは `doPost` が即座に拒否する）

### 4.2 Cloud Run側

```bash
# ビルド（リポジトリのルートで実行）
gcloud builds submit --tag asia-northeast1-docker.pkg.dev/PROJECT/spll/public-web

# デプロイ
gcloud run deploy spll-public-web \
  --image asia-northeast1-docker.pkg.dev/PROJECT/spll/public-web \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars GAS_PORTAL_URL=https://script.google.com/macros/s/XXXX/exec \
  --set-secrets PUBLIC_WEB_KEY=spll-public-web-key:latest
```

鍵は環境変数に直書きせず Secret Manager に置く。

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
PUBLIC_WEB_KEY=（同じ鍵） \
npm run web:dev
# → http://localhost:8080
```

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
| Webhook受信のCloud Run移行 | Phase 3。現状はGAS②が受ける |
| 作品提出ページ・QR取得／検証ページの移行 | Phase 4・5。現状はGAS②が配信 |
| GAS公開ページの停止 | Phase 6。現状はGAS①のURLも生きている |

いまはアクセスが集中する**申込窓口の画面だけ**をコンテナへ出した状態。
GAS①のURLも従来どおり動くので、切り戻しはDNS（またはリンク先）を戻すだけで済む。

---

## 7. テスト

`npm test` の `tests/public_web.js`（48件）で次を固定している。

- 画面がGASと同じ正本から組み立てられていること（意匠の二重管理をしていないこと）
- shim が本体スクリプトより先に読み込まれること（`hasGas` 判定に間に合うこと）
- 画面にもサーバーにも `admin_*` / `setup_*` / `api_getViewerRole` の経路が無いこと
- 読み取りはキャッシュされ、申込作成はキャッシュされないこと
- 申込作成がIPごとに制限されること
- GAS①の受け口が共有鍵を要求し、未設定なら常に拒否すること
- コンテナにリポジトリ全体を入れていないこと
