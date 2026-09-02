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
const adminHtml=read('spll_src/admin.html');
const entry=read('apps/portal/entry.gs');

ok(/function web_createApplicationV4\(/.test(f29),'v4申込APIが存在');
ok(/publishedLegalDoc_\('GUIDELINE'\)/.test(f29),'契約同意ではなくGUIDELINEを取得');
ok(/guidelineConsent/.test(f29) && !/termsConsent/.test(f29),'v4申込はtermsConsentを要求しない');
ok(/function contractFormHashV4_/.test(f28) && /'v4:' \+ contractFormHashV4_/.test(f29),'個別条件スナップショットをv4 hash化');
ok(/法人は本窓口の対象外/.test(f28),'法人は標準自動締結外');
ok(/CORPORATE_INQUIRY_REQUIRED/.test(f29),'法人申込は申込作成前に個別契約ルートへ退避');
ok(/corpNotice/.test(patch)&&/個別契約/.test(patch),'ポータルが法人に個別契約の問い合わせ窓口を案内');
ok(/イベント利用は制度条件の個別確認/.test(f28),'イベントは個別確認');
ok(/terms_snapshot_hash/.test(f36) && /CONTRACT_FORM_V4_TRANSFER_KEYS/.test(f36) && /contractFormFieldsFromApplicationV4_/.test(f36),
  'FormRun受信時にSPLL正本と転送項目を突合して改変を検知');
ok(/function snapshotContractTerms_\(/.test(f33) && /contract_template_version/.test(f28),'締結時スナップショットをv4個別条件化');
ok(/web_createApplicationV4/.test(patch),'ポータルがv4申込APIを使用');
ok(/ガイドライン/.test(patch) && /CloudSign上で/.test(patch),'ポータル表示がCloudSign締結点を明示');
ok(/28_contract_form_v4_shared\.gs/.test(build) && /29_contract_form_v4\.gs/.test(build) && /36_formrun_contract_v4\.gs/.test(build),'ビルドにv4モジュールを含む');
ok(/portal_contract_v4_patch/.test(entry),'portal entryがv4 UI patchを注入');

// 引継ぎのコンパクト化（設定設計 §9）：URLに載せるのは転送項目だけ
ok(/CONTRACT_FORM_V4_TRANSFER_KEYS/.test(f28) && /formUrlMaxChars_/.test(f28) && /estimateFormUrlLengthV4_/.test(f28),
  '転送項目とURL長の上限を定義');
ok(/FORM_HIDDEN_MAP_FIXED|formMapByRoute_/.test(f28),'hidden項目・受信項目のマップを経路別に持てる');
// クレジット表記は原作数に比例して膨らみ、2作品でformrunのURL上限に達する。
// 契約書は「甲が別途指定する権利表記」とし、実際の文言は案内ページ・検証ページで示す。
const transferKeys=(f28.match(/CONTRACT_FORM_V4_TRANSFER_KEYS = \[([\s\S]*?)\]/)||[])[1]||'';
ok(transferKeys.indexOf('credit_text')<0,'クレジット表記はFORMへ転送しない');
ok(/work_names/.test(transferKeys),'原著作物の特定（work_names）は転送する');
ok(/licensor_name/.test(transferKeys),'当事者の特定（licensor_name）は転送する');
const hashKeys=(f28.match(/CONTRACT_FORM_V4_HASH_KEYS = \[([\s\S]*?)\]/)||[])[1]||'';
ok(/credit_text/.test(hashKeys),'内部スナップショットにはクレジット表記を残す（改変検知の対象）');
const core=read('spll_src/00_core.gs');
ok(/function contractCreditTexts_/.test(core)&&/credit_snapshot/.test(core),
  'クレジット表記は締結時のスナップショットから示す');
ok(/credit_texts/.test(read('spll_src/40_public_pages.gs')),'検証ページでクレジット表記を示す');
ok(/credit_texts/.test(read('spll_src/44_guide.gs')),'案内ページでもクレジット表記を示す（公開前に必要）');
ok(/上限超過/.test(f29) && /MANUAL_REVIEW/.test(f29),'URL上限を超える申込は個別確認へ退避する');
ok(/転送項目/.test(patch) && /form_fields/.test(patch),'ポータルはサーバーが選んだ転送項目だけをURLへ載せる');
ok(/FORM_TRANSFER_KEYS/.test(adminHtml),'hidden項目ひな形は転送項目だけを出す');
ok(/id="set-privacy"/.test(adminHtml)&&/id="set-guideline"/.test(adminHtml)&&/id="set-terms"/.test(adminHtml),'管理画面 同意文・規約に3文書の枠がある');
ok(/loadLegalFile/.test(adminHtml)&&/previewLegal/.test(adminHtml),'HTMLファイル読込とプレビューを備える');
ok(!/id="gc-bank_name"/.test(adminHtml)&&/saveGuideConfig/.test(adminHtml)&&/振込先は契約書本文/.test(adminHtml),'管理画面に振込先の設定が無く、契約書に記載する旨を明示');
ok(/admin_issueGuideLink/.test(adminHtml),'契約管理から案内リンクを発行できる');
ok(/gc-guide_email_auto_send/.test(adminHtml)&&/sendMailTest/.test(adminHtml),'管理画面に案内メールの自動送信設定がある');
ok(/admin_setCertEnabled/.test(adminHtml),'契約管理に認証オン／オフのスイッチがある');
ok(/id="ai-prompt"/.test(adminHtml)&&/saveAiConfig/.test(adminHtml),'管理画面にAI審査プロンプトの設定がある');

// ポータルの見た目を変えても、v4パッチが差し込む先（DOM契約）は壊さない
const portalHtml=read('spll_src/index.html');
['ws0','ws1','ws2','ws3','wsDone','partySel','usageSel','selList','privacyText','termsText',
 'refBox','doneMsg','toForm','submit','n0','n1','n2','grid','q','detail','toAdd','cartbar','maxHint']
  .forEach(function(id){ ok(portalHtml.indexOf('id="'+id+'"')>=0, 'ポータルに #'+id+' がある（v4パッチ・スクリプトの差込先）'); });
['wtitle','wsub','check','ct','must','oath','warnnote','statblock','sbhead','sbrow','sbk','sbv','legaltext']
  .forEach(function(cls){ ok(portalHtml.indexOf(cls)>=0, 'ポータルに .'+cls+' がある'); });
// 世界観：明朝の見出しと真鍮の差し色（申込窓口・案内・提出で共通）
['spll_src/index.html','spll_src/guide.html','spll_src/upload.html'].forEach(function(f){
  const h=read(f);
  ok(/Zen\+Kaku\+Gothic|Zen Kaku Gothic/.test(h), f+' がゴシック書体を読み込む');
  ok(/--brand:#00AECE/.test(h) && /--navy:#1B3A6B/.test(h), f+' が共通の配色トークン（シアン・濃紺）を持つ');
});

console.log('\nFORM V4 RESULT: '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
