# SPLL 法務3文書（公開用HTML）

正本は `docs/` 直下の Markdown、このディレクトリのHTMLはそこから生成した公開用ファイルです。

| 文書種別 | 正本Markdown | 公開用ページ | 貼り付け用フラグメント |
|---|---|---|---|
| `PRIVACY`（個人情報の取得同意） | `../SPLL_個人情報取得同意_v1.0.md` | `spll_privacy.html` | `spll_privacy.body.html` |
| `GUIDELINE`（SPLL二次創作ガイドライン） | `../SPLL_二次創作ガイドライン_v4.1.md` | `spll_guideline.html` | `spll_guideline.body.html` |
| `TERMS`（利用規約） | `../SPLL_利用規約_v1.0.md` | `spll_terms.html` | `spll_terms.body.html` |

## 生成

```bash
npm i                      # marked が必要（初回のみ）
node docs/build_legal_html.js
```

Markdownを更新したら必ず再生成してください（HTMLは生成物であり、直接編集しません）。

## SPLLへの反映

1. 管理コンソール → 設定 → 同意文・規約
2. 各文書の「HTMLファイルから読み込む」で `*.body.html` を選択
   （`*.html`（公開用ページ）を選んでも `<main>` の中身だけを取り込みます）
3. 「下書き保存（新しい版）」→ 内容をプレビューで確認 → 「この文書を公開する」

公開した版が、以後の申込の同意証跡（`Application_Consents`）に版番号・ハッシュ付きで記録されます。

## 外部公開

`spll_privacy.html` / `spll_guideline.html` / `spll_terms.html` はスタイルを内包した単体ページです。
Webサーバー・GitHub Pages・Driveの公開フォルダ等へそのまま設置できます。
