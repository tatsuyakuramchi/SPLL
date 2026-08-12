/** CloudSign FORM v4 静的契約テスト */
const fs=require('fs'), path=require('path');
const ROOT=path.join(__dirname,'..');
let pass=0, fail=0;
function ok(c,m){ if(c) pass++; else { fail++; console.log('  FAIL:',m); } }
function read(p){ return fs.readFileSync(path.join(ROOT,p),'utf8'); }
const f28=read('spll_src/28_contract_form_v4_shared.gs');
const f29=read('spll_src/29_contract_form_v4.gs');
const f33=read('spll_src/33_contract_snapshot_v4.gs');
const f36=read('spll_src/36_formrun_contract_v4.gs');
const patch=read('spll_src/portal_contract_v4_patch.html');
const build=read('scripts/build.js');
const entry=read('apps/portal/entry.gs');

ok(/function web_createApplicationV4\(/.test(f29),'v4申込APIが存在');
ok(/publishedLegalDoc_\('GUIDELINE'\)/.test(f29),'契約同意ではなくGUIDELINEを取得');
ok(/guidelineConsent/.test(f29) && !/termsConsent/.test(f29),'v4申込はtermsConsentを要求しない');
ok(/function contractFormHashV4_/.test(f28) && /'v4:' \+ contractFormHashV4_/.test(f29),'個別条件スナップショットをv4 hash化');
ok(/法人申込は現行制度の標準契約対象外/.test(f28),'法人は標準自動締結外');
ok(/イベント利用は制度条件の個別確認/.test(f28),'イベントは個別確認');
ok(/terms_snapshot_hash/.test(f36) && /contractFormHashV4_\(received\)/.test(f36),'FormRun受信時に個別条件改変を検知');
ok(/function snapshotContractTerms_\(/.test(f33) && /contract_template_version/.test(f28),'締結時スナップショットをv4個別条件化');
ok(/web_createApplicationV4/.test(patch),'ポータルがv4申込APIを使用');
ok(/ガイドライン/.test(patch) && /CloudSign上で/.test(patch),'ポータル表示がCloudSign締結点を明示');
ok(/28_contract_form_v4_shared\.gs/.test(build) && /29_contract_form_v4\.gs/.test(build) && /36_formrun_contract_v4\.gs/.test(build),'ビルドにv4モジュールを含む');
ok(/portal_contract_v4_patch/.test(entry),'portal entryがv4 UI patchを注入');

console.log('\nFORM V4 RESULT: '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
