/**
 * SEC-01 権限分離テスト（修正設計書 §3・§26）
 * scripts/build.js の生成物（apps/{portal,workflow,admin}/dist）を検証：
 *   構文・admin_/Webhook/トークン処理の不在・OAuthスコープ最小・DOMAIN限定。
 * 実行: npm test（build後に実行される）
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');

function combined(app){
  const d = path.join(ROOT, 'apps', app, 'dist');
  return fs.readdirSync(d).filter(f => f.endsWith('.gs')).sort()
    .map(f => fs.readFileSync(path.join(d, f), 'utf8')).join('\n');
}
let pass = 0, fail = 0;
function ok(c, msg){ if(c){ pass++; } else { fail++; console.log('  FAIL:', msg); } }

for(const app of ['portal','workflow','admin']){
  const c = combined(app);
  try{ new vm.Script(c); ok(true, ''); }catch(e){ ok(false, app + ' 構文エラー: ' + e.message); }
}
const p = combined('portal'), w = combined('workflow'), a = combined('admin');

// portal（匿名公開・最小権限）
ok(!/function admin_/.test(p),               'portal に admin_ 関数が含まれない');
ok(!/function setup_/.test(p),               'portal に setup_ 関数が含まれない');
// portal の doPost は公開Web（Cloud Run）からのデータ取得口だけ。Webhook受信ではない。
ok(!/receiveWebhook_|processWebhookEvent_/.test(p), 'portal の doPost はWebhook受信を行わない');
ok(!/function doPost/.test(p) || /publicWebRpcHandlers_/.test(p),
  'portal に doPost があるなら公開WebのRPC受け口に限る');
ok(!/function doPost/.test(p) || /PUBLIC_WEB_KEY/.test(p),
  'portal のRPC受け口は共有鍵を要求する');
ok(!/function doPost/.test(p) || /if\(!expected\) return false;/.test(p),
  'portal のRPC受け口は鍵未設定なら常に拒否する（フェイルクローズ）');
ok(!/function issueToken_/.test(p),          'portal にトークン発行が無い');
ok(!/function receiveWebhook_/.test(p),      'portal にWebhook処理が無い');
ok(/function web_createApplicationV4/.test(p), 'portal に申込作成（v4）がある');
ok(!/function web_createApplication\(/.test(p), 'portal に旧申込API（web_createApplication）が残っていない');
// workflow（匿名公開・トークン/Webhook防御）
ok(!/function admin_/.test(w),               'workflow に admin_ 関数が含まれない');
ok(!/function setup_bootstrap/.test(w),      'workflow に setup_bootstrap（台帳作り直し）が無い');
ok(/function receiveWebhook_/.test(w),       'workflow にWebhook処理がある');
ok(/function web_submitWork/.test(w),        'workflow に提出処理がある');
ok(/function setup_triggers/.test(w),        'workflow に setup_triggers がある');
// admin（組織内限定）
ok(!/function receiveWebhook_/.test(a),      'admin にWebhook受信が無い');
ok(!/function web_submitWork/.test(a),       'admin に匿名提出処理が無い');
ok(/function admin_dashboard/.test(a),       'admin に管理機能がある');
ok(/function setup_bootstrap/.test(a),       'admin に setup_bootstrap がある');
// マニフェスト（最小権限・公開範囲）
const pj = JSON.parse(fs.readFileSync(path.join(ROOT,'apps/portal/dist/appsscript.json'),'utf8'));
ok(!pj.oauthScopes.some(s => /drive|cloud-platform|external_request|presentations/.test(s)),
   'portal のOAuthスコープ最小（Drive/GCP/外部APIなし）');
const aj = JSON.parse(fs.readFileSync(path.join(ROOT,'apps/admin/dist/appsscript.json'),'utf8'));
ok(aj.webapp.access === 'DOMAIN',            'admin は組織内限定（DOMAIN）');
const wj = JSON.parse(fs.readFileSync(path.join(ROOT,'apps/workflow/dist/appsscript.json'),'utf8'));
ok(wj.webapp.access === 'ANYONE_ANONYMOUS',  'workflow は匿名（トークン/Webhook防御あり）');
// 案内メールの自動送信（MailApp）に必要。未宣言だと承認画面に出ず送信時に落ちる
ok(wj.oauthScopes.indexOf('https://www.googleapis.com/auth/script.send_mail') >= 0,
   'workflow にメール送信スコープがある（案内メールの自動送信）');
ok(aj.oauthScopes.indexOf('https://www.googleapis.com/auth/script.send_mail') >= 0,
   'admin にメール送信スコープがある（テスト送信）');
ok(!pj.oauthScopes.some(s => /send_mail/.test(s)), 'portal はメール送信スコープを持たない');
// RP-002：状態遷移は3プロジェクトで同じ遷移表を使う（片方だけ古いと台帳の状態がずれる）
['portal','workflow','admin'].forEach(function(app){
  const c = combined(app);
  ok(/function transitionLicenseCase_/.test(c), app + ' に状態遷移（transitionLicenseCase_）がある');
  ok(!/function updateLicenseCase_\(/.test(c), app + ' に旧 updateLicenseCase_（状態列の直接更新）が残っていない');
});
console.log('\nSEC01 RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
