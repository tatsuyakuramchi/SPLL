/**
 * SEC-01（修正設計書 §3/§22/§29）：3 GASプロジェクトへの配布ビルド。
 * 正本は spll_src/*.gs（単一の定義元）。本スクリプトがマニフェストに従い
 * apps/{portal,workflow,admin}/dist へ必要ファイルだけをコピーする。
 *   ・portal   … 匿名公開。原作検索・申込作成のみ（admin_/webhook/トークン処理を含めない）
 *   ・workflow … Webhook・提出・報告・バッジ・検証・バッチ
 *   ・admin    … 管理コンソール（組織内限定）・セットアップ
 * 使い方: node scripts/build.js   → 各 dist/ を再生成（クローズドチェック付き）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'spll_src');

const MANIFEST = {
  portal: {
    gs: ['00_core.gs','10_auth.gs','15_fee.gs','25_portal.gs'],
    html: ['index.html'],
    title: 'SPLL 公開ポータル (GAS①)',
  },
  workflow: {
    gs: ['00_core.gs','15_fee.gs','20_tokens.gs','30_cloudsign.gs','32_contract.gs','35_webhooks.gs','37_ai.gs','40_public_pages.gs','45_settlement.gs','47_batches.gs'],
    html: ['upload.html','report.html'],
    title: 'SPLL 契約・提出・報告 (GAS②)',
  },
  admin: {
    gs: ['00_core.gs','05_schema.gs','10_auth.gs','15_fee.gs','20_tokens.gs','30_cloudsign.gs','32_contract.gs','37_ai.gs','45_settlement.gs','50_admin.gs'],
    html: ['admin.html'],
    title: 'SPLL 管理コンソール (GAS③)',
  },
};

// GAS組込み・グローバル（未定義参照チェックの除外リスト）
const GAS_GLOBALS = new Set(['SpreadsheetApp','DriveApp','Utilities','PropertiesService','CacheService','LockService','SlidesApp','ScriptApp','Session','Logger','MailApp','ContentService','HtmlService','UrlFetchApp','JSON','Math','Date','String','Number','Object','Array','RegExp','parseInt','parseFloat','isNaN','encodeURIComponent','decodeURIComponent','Error']);

function definedNames(code){
  const names = new Set();
  for(const m of code.matchAll(/^(?:function\s+([A-Za-z0-9_]+)|const\s+([A-Za-z0-9_]+)|var\s+([A-Za-z0-9_]+))/gm)) names.add(m[1]||m[2]||m[3]);
  for(const m of code.matchAll(/\bfunction\s+([A-Za-z0-9_]+)\s*\(/g)) names.add(m[1]);   // ネスト定義も認識
  return names;
}
function referencedPrivate(code){
  // 私有関数呼出し（末尾_）を収集。定数はチェック対象外（文字列との誤検知が多いため）。
  const refs = new Set();
  for(const m of code.matchAll(/\b([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*_)\s*\(/g)) refs.add(m[1]);
  return refs;
}

// 各distに含まれてはならない関数（修正設計書v2 P0-01）
const FORBIDDEN = {
  portal:   [/function admin_/, /function setup_/, /function receiveWebhook_/, /function web_submitWork/, /function report_submit/, /function issueToken_/],
  workflow: [/function admin_save/, /function setup_reset/, /function setup_setInitialAdmin/, /function serveAdmin_/, /function setup_bootstrap/],
  admin:    [/function receiveWebhook_/, /function web_submitWork/, /function report_submit/],
};
let failed = false;
for(const [app, mf] of Object.entries(MANIFEST)){
  const appDir = path.join(ROOT, 'apps', app);
  const dist = path.join(appDir, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  let combined = '';
  for(const f of mf.gs){
    const body = fs.readFileSync(path.join(SRC, f), 'utf8');
    fs.writeFileSync(path.join(dist, f), body);
    combined += body + '\n';
  }
  // アプリ固有エントリ
  const entry = fs.readFileSync(path.join(appDir, 'entry.gs'), 'utf8');
  fs.writeFileSync(path.join(dist, '99_entry.gs'), entry);
  combined += entry + '\n';
  // HTML
  for(const h of mf.html) fs.copyFileSync(path.join(SRC, h), path.join(dist, h));
  // マニフェスト（appsscript.json はアプリ側の最小権限版）
  fs.copyFileSync(path.join(appDir, 'appsscript.json'), path.join(dist, 'appsscript.json'));

  // クローズドチェック：私有関数・定数の未解決参照を検出
  // 禁止関数の混入検査（P0-01）
  for(const re of (FORBIDDEN[app] || [])){
    if(re.test(combined)){ console.error('[' + app + '] 禁止関数が混入: ' + re); failed = true; }
  }
  // マニフェスト検査：admin=DOMAIN限定、portal=最小スコープ
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'appsscript.json'), 'utf8'));
  if(app === 'admin' && manifest.webapp.access !== 'DOMAIN'){ console.error('[admin] webapp.access は DOMAIN 必須'); failed = true; }
  if(app === 'portal' && manifest.oauthScopes.some(s => /drive|cloud-platform|external_request|presentations/.test(s))){
    console.error('[portal] OAuthスコープが過大'); failed = true; }
  if(fs.existsSync(path.join(dist, '90_main.gs'))){ console.error('[' + app + '] モノリスエントリが混入'); failed = true; }

  const defined = definedNames(combined);
  const unresolved = [...referencedPrivate(combined)]
    .filter(n => !defined.has(n) && !GAS_GLOBALS.has(n));
  if(unresolved.length){
    console.error('[' + app + '] 未解決参照: ' + unresolved.join(', '));
    failed = true;
  }
  console.log('[' + app + '] dist生成: ' + mf.gs.length + ' gs + entry + ' + mf.html.length + ' html' + (unresolved.length ? '（要修正）' : ' / closure OK'));
}
if(failed){ console.error('ビルド失敗：マニフェストにファイルを追加してください'); process.exit(1); }
console.log('build done');
