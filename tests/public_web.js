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
process.env.GAS_WORKFLOW_URL = process.env.GAS_WORKFLOW_URL || 'https://script.google.com/macros/s/TEST2/exec';
process.env.PUBLIC_WEB_KEY = process.env.PUBLIC_WEB_KEY || 'test-key';

const { buildPortalPage, buildTokenPage, RPC_FUNCTIONS, RPC_TARGETS } = require(path.join(ROOT, 'apps/public-web/page.js'));
const server = require(path.join(ROOT, 'apps/public-web/server.js'));

// ---- 1. 画面はGASと同じ正本から組み立てる ----
const page = buildPortalPage();
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
  const wentry = read('apps/workflow/entry.gs');
  RPC_FUNCTIONS.forEach((fn) => {
    const target = RPC_TARGETS[fn] === 'workflow' ? wentry : entry;
    const label = RPC_TARGETS[fn] === 'workflow' ? 'GAS②' : 'GAS①';
    ok(new RegExp(fn + ':\\s*function').test(target), label + 'が ' + fn + ' を公開する');
  });
  ok(!/admin_|setup_/.test(entry.split('publicWebRpcHandlers_')[1] || ''), 'GAS①の受け口に管理系・セットアップ系を並べない');
  // GAS②はWebhookと同じURLに同居するので、RPCとWebhookの振り分けが明示されていること
  ok(/function doPost\(e\)/.test(wentry) && /rpc \|\| ''\) === '1'/.test(wentry),
    'GAS②は ?rpc=1 のPOSTだけをRPCとして扱う（Webhookと混ざらない）');
  ok(/PUBLIC_WEB_KEY/.test(wentry) && /if\(!expected\) return false;/.test(wentry),
    'GAS②のRPC受け口も共有鍵を要求し、未設定なら常に拒否する');
  ok(!/admin_|setup_/.test(wentry.split('workflowRpcHandlers_')[1] || ''), 'GAS②の受け口に管理系・セットアップ系を並べない');
  ok(/receiveWebhook_/.test(wentry), 'GAS②のWebhook受信は従来どおり残る');

  // ---- 4.5 クリエーター向けページ（提出・案内・検証・バッジ） ----
  // GASのテンプレート差込（<?= token ?>）と同じ位置に、同じ値を入れているか
  ['guide.html','upload.html'].forEach((f) => {
    const src = read('spll_src/' + f);
    ok(src.indexOf('var TOKEN = "<?= token ?>"') >= 0, f + ' の差込はTOKENの1箇所だけ');
    const built = buildTokenPage(f, 'TKN-abc123');
    ok(built.indexOf('var TOKEN = "TKN-abc123"') >= 0, f + ' にトークンを差し込む');
    ok(built.indexOf('<?= token ?>') < 0, f + ' にテンプレート記法を残さない');
    ok(built.indexOf('window.google.script') < built.indexOf('var TOKEN'), f + ' もshimを先に読み込む');
  });
  // トークンはURLに現れる文字だけを通す（差込先はJS文字列リテラルのため）
  ok(buildTokenPage('guide.html', 'a"+alert(1)+"b').indexOf('alert(1)') < 0, 'トークンに紛れ込んだJSを差し込まない');

  // 検証ページ：状態で表示が変わり、無効の理由は出さない
  const { verifyPage, badgePage } = require(path.join(ROOT, 'apps/public-web/verify-page.js'));
  const okPage = verifyPage({ state:'ACTIVE', title:'正規ライセンス 確認済み', message:'このライセンスは有効です。',
    work_names:['新クトゥルフ神話TRPG'], license_id:'SPLL-202608-0042', issued_at:'2026-08-11', status:'ACTIVE' });
  ok(/確認済み/.test(okPage) && /SPLL-202608-0042/.test(okPage), '有効な認証はSPLL番号とともに確認済みを示す');
  const ngPage = verifyPage({ state:'INACTIVE', title:'無効', message:'このライセンスは現在有効ではありません（PAYMENT_HOLD）。',
    work_names:[], license_id:'SPLL-1', issued_at:'2026-08-10', status:'PAYMENT_HOLD' });
  ok(/無効/.test(ngPage), '停止中の認証は無効と示す');
  ok(verifyPage({ state:'INPUT' }).indexOf('name="id"') >= 0, 'IDが無いときは入力フォームを出す');
  ok(/確認できません/.test(verifyPage({ state:'MISMATCH', title:'確認できません', message:'一致しません。' })),
    '照合できない場合は理由を明かさず「確認できません」に統一する');

  // バッジページ：画像は1枚ずつ別URLから取る（1回の応答を重くしない）
  const bp = badgePage({ license_id:'SPLL-1', badge_id:'BDG-1', issued_at:'2026-08-11', work_names:'作品A',
    sizes:[{key:'l',label:'大 (L)'},{key:'m',label:'中 (M)'},{key:'s',label:'小 (S)'}] }, 'TKN-1');
  ok((bp.match(/\/badge-image\?t=TKN-1/g) || []).length >= 3, 'バッジ画像は size ごとに別URLで取得する');
  ok(/リンクが無効です/.test(badgePage(null, 'x')), 'トークンが無効なら案内を出す');

  // ---- 5. 申込 → クラウドサインフォームへの引継ぎ（Cloud Run経由でも成立するか） ----
  // GASが返す申込結果が、画面がフォームURLを組み立てるのに必要な項目を全部持っているか。
  const HANDOFF = {
    application_id:'APP-1', application_ref:'REF-2608-0001', license_id:'SPLL-202608-0042',
    handoff_token:'HMACxxxxxxxxxxxxxxxxxxxxxxxxxxxx', terms_snapshot_hash:'v4:abcdef',
    template_route:'STANDARD_FIXED', route_reasons:[], form_url_length:420,
    form_url:'https://form.run/@spll-fixed',
    form_fields:{ license_id:'SPLL-202608-0042', application_ref:'REF-2608-0001', usage_category:'書籍',
      work_names:'新クトゥルフ神話TRPG、光砕のリヴァルチャー', licensor_name:'アークライト',
      fee_amount_or_rate:'16,500円／契約', credit_text:'指定のシリーズ権利表記を記載' }
  };
  const applyRpc = async (url, init) => {
    const body = JSON.parse(init.body);
    ok(body.fn === 'web_createApplicationV4', '申込作成はRPCとしてGASへ渡る');
    return { status:200, text: async () => JSON.stringify({ ok:true, result: HANDOFF }) };
  };
  const applied = await rpc({ fn:'web_createApplicationV4', args:[{ workIds:['WRK-1'], usageCategory:'書籍' }] },
    { fetchImpl: applyRpc, ip:'9.9.9.9' });
  const res = applied.body.result;
  ['form_url','form_fields','handoff_token','terms_snapshot_hash','template_route']
    .forEach((k) => ok(res[k] !== undefined, 'RPCの応答が ' + k + ' を運ぶ'));

  // 画面が実際に使う buildFormUrl（v4パッチの実物）へ通し、フォームURLが組み上がるか
  const src = patchHtml.match(/buildFormUrl = function\(res\)\{[\s\S]*?\n  \};/)[0];
  const APPLY = { formUrl:'', hiddenMap:{ handoff_token:'_field_1', terms_snapshot_hash:'_field_2',
    template_route:'_field_3', license_id:'_field_4', application_ref:'_field_5', usage_category:'_field_6',
    work_names:'_field_7', licensor_name:'_field_8', fee_amount_or_rate:'_field_9', credit_text:'_field_10' } };
  let buildFormUrl;
  eval(src.replace('buildFormUrl = function(res)', 'buildFormUrl = function(res)'));
  const formUrl = buildFormUrl(res);
  ok(formUrl.indexOf('https://form.run/@spll-fixed?') === 0, '経路に応じたフォームURLを土台にする: ' + formUrl.slice(0, 40));
  ok(/_field_1=HMAC/.test(formUrl), 'handoff_token をhidden項目IDへ載せる');
  ok(/_field_2=v4%3Aabcdef/.test(formUrl), 'terms_snapshot_hash を載せる（改変検知の突合キー）');
  ok(/_field_4=SPLL-202608-0042/.test(formUrl), 'SPLL番号を載せる');
  ok(/_field_7=%E6%96%B0%E3%82%AF/.test(formUrl), '選択した原作名を載せる');
  ok(/_field_9=16%2C500/.test(formUrl), '利用許諾料を載せる');
  ok(formUrl.indexOf('work_id_1') < 0 && formUrl.indexOf('license_term') < 0,
    '内部専用の項目はURLへ載せない（formrunの1000字上限）');
  ok(formUrl.length <= 850, '組み上がったURLが上限内: ' + formUrl.length + '字');

  // 締結の受け口はCloud Runへ移していない（Webhookは従来どおりGAS②）
  const buildJs = read('scripts/build.js');
  ok(/workflow:[\s\S]*?35_webhooks\.gs/.test(buildJs), 'formrun/CloudSignのWebhookはGAS②が受ける');
  ok(!/35_webhooks|receiveWebhook_/.test(read('apps/public-web/server.js')),
    'Cloud RunはWebhookを受けない（締結の経路を変えていない）');

  // ---- 5. コンテナ ----
  const dockerfile = read('apps/public-web/Dockerfile');
  ok(/COPY spll_src\/index\.html/.test(dockerfile), '画面の正本をイメージへ入れる');
  ok(/ENV PORT=8080/.test(dockerfile) && /USER node/.test(dockerfile), 'Cloud RunのPORTを受け、rootで動かさない');
  ok(!/COPY \. /.test(dockerfile), 'リポジトリ全体を入れない（台帳・鍵の混入を避ける）');
  // Dockerfile がルートに無いため、--tag ではなく設定ファイルでビルドする必要がある
  const cb = read('apps/public-web/cloudbuild.yaml');
  ok(/-f[\s\S]{0,40}apps\/public-web\/Dockerfile/.test(cb), 'Cloud Build がDockerfileの場所を明示する');
  ok(/\n\s+- '\.'/.test(cb), 'ビルドコンテキストはリポジトリのルート（spll_src を拾うため）');

  console.log('\nPUBLIC WEB RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
