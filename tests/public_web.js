/**
 * 公開ポータル（Cloud Run）の検査。
 * 画面はGASと同じ正本から組み立てているか、RPCの許可リストが効いているかを確かめる。
 * 実行: node tests/public_web.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg){ if(cond){ pass++; } else { fail++; console.log('  FAIL:', msg); } }

// 転送先とキーは環境変数で受け取る。server.js を読む前に入れておく。
process.env.GAS_PORTAL_URL = process.env.GAS_PORTAL_URL || 'https://script.google.com/macros/s/TEST/exec';
process.env.PUBLIC_WEB_KEY = process.env.PUBLIC_WEB_KEY || 'test-key';

const { buildPage, RPC_FUNCTIONS } = require(path.join(ROOT, 'apps/public-web/page.js'));
const server = require(path.join(ROOT, 'apps/public-web/server.js'));

// ---- 1. 画面はGASと同じ正本から組み立てる ----
const page = buildPage();
const indexHtml = read('spll_src/index.html');
const patchHtml = read('spll_src/portal_contract_v4_patch.html');
ok(page.indexOf('SPLL 利用申込窓口') >= 0, 'ポータルのタイトルを含む');
ok(page.indexOf('function renderGrid()') >= 0, 'index.html の本体スクリプトを含む');
ok(page.indexOf('buildFormUrl = function(res)') >= 0, 'v4パッチを結合している（GAS① doGet と同じ順序）');
ok(page.indexOf('--brand:#00AECE') >= 0, '意匠（配色トークン）はGAS版と同一');
ok(page.indexOf(indexHtml.slice(indexHtml.length - 200)) >= 0 || page.indexOf('loadUsageOptions();') >= 0,
  'index.html を書き換えずに使っている');
ok(patchHtml.length > 0 && page.length > indexHtml.length, 'パッチのぶんだけ増えている');

// shim は本体スクリプトより前に置く（hasGas 判定に間に合わせるため）
ok(page.indexOf('window.google.script') < page.indexOf('const hasGas'), 'RPC shim を本体スクリプトより前に読み込ませる');
ok(page.indexOf("Object.defineProperty(window.google.script, 'run'") >= 0, 'google.script.run 互換の入口を用意する');
ok(/withSuccessHandler[\s\S]{0,400}withFailureHandler/.test(page), 'ハンドラの連鎖に対応する');

// ---- 2. 画面から呼べる関数は許可リストのぶんだけ ----
RPC_FUNCTIONS.forEach((fn) => ok(page.indexOf('"' + fn + '"') >= 0, 'shim が ' + fn + ' を生やす'));
['admin_dashboard', 'admin_saveGuideConfig', 'setup_bootstrap', 'setup_all', 'issueToken_', 'api_getViewerRole']
  .forEach((fn) => ok(!RPC_FUNCTIONS.includes(fn), 'shim に ' + fn + ' を生やさない'));
ok(page.indexOf('window.api_getViewerRole = null') >= 0, '管理コンソール切替は公開サイトでは無効化する');

// ---- 3. サーバー側の許可リスト（画面を書き換えられても越えられない壁） ----
async function rpc(payload, opts){ return server.handleRpc(payload, opts || {}); }
(async () => {
  const denied = await rpc({ fn: 'admin_dashboard', args: [] });
  ok(denied.status === 403 && denied.body.ok === false, '管理系のRPCは403で拒否する');
  const denied2 = await rpc({ fn: 'setup_bootstrap', args: [] });
  ok(denied2.status === 403, 'セットアップ系のRPCも拒否する');
  const denied3 = await rpc({ fn: 'api_getViewerRole', args: [] });
  ok(denied3.status === 403, '管理者判定のRPCは公開サイトからは呼べない');
  ok(denied.body.error === denied2.body.error && denied2.body.error === denied3.body.error,
    '拒否の文言を共通にする（関数の存在を推測させない）');

  // 許可された関数はGASへ転送される
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { status: 200, text: async () => JSON.stringify({ ok: true, result: [{ id: 'WRK-1' }] }) };
  };
  const okRes = await rpc({ fn: 'api_listWorks', args: [] }, { fetchImpl: fakeFetch });
  ok(okRes.status === 200 && okRes.body.ok === true && okRes.body.result[0].id === 'WRK-1', '許可された関数はGASへ転送する');
  ok(calls.length === 1 && calls[0].fn === 'api_listWorks' && 'key' in calls[0], '転送時に関数名と共有鍵を載せる');

  // 読み取りは短時間キャッシュし、一覧表示のたびにスプレッドシートを読まない
  const again = await rpc({ fn: 'api_listWorks', args: [] }, { fetchImpl: fakeFetch });
  ok(again.body.cached === true && calls.length === 1, '読み取り結果はキャッシュから返す');

  // 申込作成はキャッシュしない
  const applyFetch = async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, result: { license_id: 'SPLL-1' } }) });
  const a1 = await rpc({ fn: 'web_createApplicationV4', args: [{}] }, { fetchImpl: applyFetch, ip: '1.1.1.1' });
  const a2 = await rpc({ fn: 'web_createApplicationV4', args: [{}] }, { fetchImpl: applyFetch, ip: '1.1.1.1' });
  ok(a1.body.ok === true && a2.body.cached === undefined, '申込作成はキャッシュしない');

  // 同一IPからの連投は止める
  let limited = null;
  for(let i = 0; i < 10; i++) limited = await rpc({ fn: 'web_createApplicationV4', args: [{}] }, { fetchImpl: applyFetch, ip: '2.2.2.2' });
  ok(limited.status === 429, '申込作成はIPごとに回数を制限する');

  // GASのエラー文言（法人お断り等）は利用者への案内なのでそのまま返す
  const errFetch = async () => ({ status: 200, text: async () => JSON.stringify({ ok: false, error: 'CORPORATE_INQUIRY_REQUIRED: 法人は個別契約です' }) });
  const err = await rpc({ fn: 'web_createApplicationV4', args: [{}] }, { fetchImpl: errFetch, ip: '3.3.3.3' });
  ok(err.body.ok === false && /CORPORATE_INQUIRY_REQUIRED/.test(err.body.error), '申込が拒否された理由は画面へ返す');

  // ---- 4. GAS①側の受け口 ----
  const entry = read('apps/portal/entry.gs');
  ok(/function doPost\(e\)/.test(entry), 'GAS①にRPCの受け口がある');
  ok(/PUBLIC_WEB_KEY/.test(entry) && /if\(!expected\) return false;/.test(entry),
    '共有鍵が未設定なら常に拒否する（フェイルクローズ）');
  ok(/hasOwnProperty\.call\(handlers, fn\)/.test(entry), '許可リストにある名前だけを呼ぶ');
  ok(!/this\[fn\]/.test(entry), '関数名から動的に解決しない');
  RPC_FUNCTIONS.forEach((fn) => ok(new RegExp(fn + ':\\s*function').test(entry), 'GAS①が ' + fn + ' を公開する'));
  ok(!/admin_|setup_/.test(entry.split('publicWebRpcHandlers_')[1] || ''), 'GAS①の受け口に管理系・セットアップ系を並べない');

  // ---- 5. コンテナ ----
  const dockerfile = read('apps/public-web/Dockerfile');
  ok(/COPY spll_src\/index\.html/.test(dockerfile), '画面の正本をイメージへ入れる');
  ok(/ENV PORT=8080/.test(dockerfile) && /USER node/.test(dockerfile), 'Cloud RunのPORTを受け、rootで動かさない');
  ok(!/COPY \. /.test(dockerfile), 'リポジトリ全体を入れない（台帳・鍵の混入を避ける）');

  console.log('\nPUBLIC WEB RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
