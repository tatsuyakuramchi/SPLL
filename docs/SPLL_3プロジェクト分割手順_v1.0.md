# SPLL GAS プロジェクト分割 セットアップ手順（SEC-01＋経理連携）

**対応**：修正設計書 v1.0（SPLL-SYS-RD-001）§3・§22・§29 ／ SEC-01 ／ 経理設計書（SPLL-SYS-AD-001）§4
**版**：v1.1（GAS④ Accounting を追加）

> **v1.1追記**：経理連携（SPLL-SYS-AD-001）により **GAS④ accounting** が加わりました。
> セットアップは①〜③と同様（`apps/accounting/.clasp.json` にスクリプトIDを記入し `npm run push:accounting`）。
> ScriptPropertiesは `ENVIRONMENT`（必須）・`SS_MASTER`・`SS_OPS`・`DRIVE_ROOT` を設定後、
> **admin または accounting のエディタで `setup_accountingBootstrap` を1回実行**（経理マスタ・年度別台帳・
> Driveフォルダを自動作成し `SS_ACCOUNTING_MASTER`／`SS_ACCOUNTING_CURRENT` を自動登録。
> adminで実行した場合は表示されたIDを accounting 側のプロパティにも転記）。
> 最後に **accounting で `setup_accountingTriggers`**（5分毎の経理ジョブ実行）。
> 既存3プロジェクトはスキーマ更新のため admin で `setup_migrate` を再実行してください（SCHEMA_VERSION=4）。

## 1. 構成

正本コードは `spll_src/*.gs`（単一の定義元）。`npm run build` がマニフェスト（`scripts/build.js`）に従い、
各プロジェクトへ**必要なファイルだけ**を `apps/<app>/dist/` に配布します。

| プロジェクト | 役割 | 公開範囲 | 含まれないもの（権限分離） |
|---|---|---|---|
| **GAS① portal** | 原作検索・申込作成・公開API | 匿名公開 | admin_関数・setup_・Webhook・トークン発行・Drive/GCP/外部APIスコープ |
| **GAS② workflow** | Webhook受信・提出・報告・バッジ・検証・バッチ | 匿名公開（トークン/Webhook検証で防御） | admin_関数・setup_bootstrap |
| **GAS③ admin** | 管理コンソール・セットアップ | **組織内限定（DOMAIN）** | Webhook受信・匿名提出処理 |

> **モノリス（単一プロジェクト）デプロイ経路は廃止しました（修正設計書v2 P0-01）。**
> `npm run push` 等のルート直下pushスクリプトは存在せず、配布は `push:portal/workflow/admin/all` のみです。
> 旧エントリは `reference/90_main.gs.reference`（参照用・配布対象外）。

## 2. 初回セットアップ（ローカルPCで実施）

```bash
git pull origin claude/new-design-implementation-wlqwv9
npm install
npm run login                     # clasp ログイン（済みなら不要）
```

### 2.1 GASプロジェクトを3つ作成

[script.google.com](https://script.google.com) で空のプロジェクトを3つ作成し、それぞれの**スクリプトID**を控える
（プロジェクト設定 → スクリプトID）。

### 2.2 .clasp.json を配置（Gitにはコミットしない）

各 `apps/<app>/.clasp.json.example` をコピーして実IDを記入：

```bash
copy apps\portal\.clasp.json.example   apps\portal\.clasp.json     # scriptId を記入
copy apps\workflow\.clasp.json.example apps\workflow\.clasp.json
copy apps\admin\.clasp.json.example    apps\admin\.clasp.json
```

### 2.3 ビルド＆push

```bash
npm run push:all        # build → portal/workflow/admin/accounting を順に push
```

個別push：`npm run push:portal` / `push:workflow` / `push:admin` / `push:accounting`

> **注意**：`push` はコードを更新するだけで、公開URL（/exec）には反映されません。
> 公開URLへの反映は次の 2.4 の `deploy` コマンドを使うか、GASエディタで「デプロイ→編集→新バージョン」。

### 2.4 デプロイ（push＋公開URLへ新バージョン反映を1コマンドで）

初回のみ、各アプリのデプロイIDを登録します：

1. GASで一度だけ手動で「ウェブアプリ」としてデプロイ（公開範囲は§3の表どおり）
2. デプロイIDを確認：`cd apps\portal && npx clasp deployments`（`AKfycb...` で始まる行。`@HEAD` ではない方）
3. `apps/portal/.deploy.json` を作成（Gitにはコミットされません）：

```json
{ "deploymentId": "AKfycb..." }
```

（workflow / admin / accounting も同様）

以後は次の1コマンドで build → push → 公開URLへ新バージョン反映まで完了します（URLは変わりません）：

```bash
npm run deploy:all          # 4プロジェクトすべて
npm run deploy:portal       # 個別（deploy:workflow / deploy:admin / deploy:accounting）
```

バージョンメモは自動で「日時＋gitハッシュ」が入ります（`node scripts/deploy.js portal "任意メモ"` で指定も可）。

## 3. プロジェクト別の初期設定

**ScriptProperties は プロジェクトごとに独立**です。各プロジェクトの「プロジェクト設定 → スクリプト プロパティ」に
以下を設定してください（値は admin で `setup_bootstrap` 実行後に表示されるIDを共有）。

| プロパティ | portal | workflow | admin |
|---|:-:|:-:|:-:|
| `SS_MASTER` / `SS_OPS` | ✔ | ✔ | ✔ |
| `DRIVE_ROOT` | — | ✔ | ✔ |
| `GCP_PROJECT` / `GCP_REGION` / `GEMINI_MODEL` | — | ✔ | ✔ |
| `FORMRUN_FORM_URL` / `FORM_REF_PARAM` / `FORM_HIDDEN_MAP` / `FORM_MAX_WORKS` | ✔ | — | ✔ |
| `CLOUDSIGN_CLIENT_ID` ほかCloudSign系 | — | ✔ | ✔ |
| `FORMRUN_WEBHOOK_SECRET` / `CLOUDSIGN_WEBHOOK_KEY` | — | ✔ | — |
| `X_API_KEY` ほかX系 | — | — | ✔ |
| `ENVIRONMENT`（**必須**。development / staging / production。未設定は起動停止） | ✔ | ✔ | ✔ |
| `ALLOW_DEV_BOOTSTRAP`（development で管理者未登録時の暫定操作を許可する場合のみ true） | — | — | ✔ |
| `HANDOFF_SECRET`（フォーム引継ぎ改変検知・HMAC鍵） | ✔ | ✔ | — |
| `ADMIN_CONSOLE_URL`（adminのウェブアプリURL。ポータルの「管理コンソール」スイッチ先） | ✔ | — | — |

### 実行する関数（GASエディタから1回ずつ）

| 関数 | 実行場所 | 内容 |
|---|---|---|
| `setup_bootstrap` | **admin** | 台帳・マスタ・Drive作成＋初期設定＋スキーマ移行（作り直しは `setup_reset`※devのみ） |
| `setup_migrate` | **admin** | **既存シートへ不足列を追加**（スキーマ更新時。productionでも実行可・冪等） |
| `setup_setInitialAdmin("you@example.com","SYSTEM_ADMIN")` | **admin** | 初期管理者登録（2人目以降はSYSTEM_ADMIN権限が必要） |
| `setup_triggers` | **workflow** | 5分毎（Webhook再処理・AI審査）＋日次（期限・みなし確認・削除）トリガー作成（冪等） |

### デプロイ（ウェブアプリ）

| プロジェクト | アクセスできるユーザー |
|---|---|
| portal | 全員（匿名を含む） |
| workflow | 全員（匿名を含む） |
| admin | **同じ組織内（DOMAIN）** ※appsscript.jsonで指定済み |

## 4. 外部サービスのURL設定

- **CloudSign Webhook** → workflow の `/exec`（`?key=CLOUDSIGN_WEBHOOK_KEYの値` を付与）
- **formrun Webhook** → workflow の `/exec?hook=formrun&key=FORMRUN_WEBHOOK_SECRETの値`
- **クラウドサインフォームURL**（portalの遷移先）→ admin「設定 → クラウドサインフォーム連携」で登録
- 提出・報告・バッジ・検証の各リンクは workflow のURLで発行されます

## 5. 検証（リリース判定 §26 抜粋）

- [ ] portal のURLで `admin_*`・`setup_*` が呼び出せない（存在しない）
- [ ] admin のURLに匿名でアクセスできない（DOMAIN 制限＋production では serveAdmin_ 拒否）
- [ ] workflow への偽造Webhook（key無し）が `ENVIRONMENT=production` で `rejected` になる
- [ ] `npm run build` が closure OK（未解決参照なし）で完了する
