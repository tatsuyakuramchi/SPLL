# SPLL 公開ポータル（Cloud Run）
# 依存パッケージなし。画面の正本 spll_src と、この配下だけを持ち込む。
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# 画面の正本（GASが配信しているものと同じHTML）
COPY spll_src/index.html                    ./spll_src/index.html
COPY spll_src/portal_contract_v4_patch.html ./spll_src/portal_contract_v4_patch.html
COPY spll_src/guide.html                    ./spll_src/guide.html
COPY spll_src/upload.html                   ./spll_src/upload.html
# サーバー
COPY apps/public-web/                       ./apps/public-web/

# Cloud Run は PORT を渡してくる
ENV PORT=8080
EXPOSE 8080
USER node

# 起動直後にHTMLを組み立てて常駐する
CMD ["node", "apps/public-web/server.js"]
