/** SPLL パートナーシップ事務局運営 静的テスト */
const fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..'); let pass=0,fail=0;
function ok(c,m){if(c)pass++;else{fail++;console.log('  FAIL:',m)}}
function read(p){return fs.readFileSync(path.join(ROOT,p),'utf8')}
const gs=read('spll_src/52_admin_partnership.gs');
const ui=read('spll_src/admin_partnership_patch.html');
const build=read('scripts/build.js');
const entry=read('apps/admin/entry.gs');
ok(/Secretariat_Meetings/.test(gs)&&/Secretariat_Agendas/.test(gs)&&/Secretariat_Votes/.test(gs),'会議・議案・投票テーブル');
ok(/Secretariat_Reports/.test(gs)&&/Secretariat_Settlements/.test(gs),'報告・清算記録テーブル');
ok(/LICENSE_FEE_CHANGE[\s\S]*SPECIAL/.test(gs)||/case 'LICENSE_FEE_CHANGE'[\s\S]*return 'SPECIAL'/.test(gs),'ライセンス料改定は特別決議');
ok(/REVENUE_DISTRIBUTION_CHANGE/.test(gs)&&/PARTNER_TYPE_CHANGE/.test(gs),'収益分配・種別変更を特別議案として定義');
ok(/DISSOLUTION'[\s\S]*UNANIMOUS/.test(gs),'解散は全員同意');
ok(/yes\*3>=total\*2&&coreYes>=1/.test(gs),'特別決議は3分の2以上＋コア賛成');
ok(/yes\*2>total/.test(gs),'通常決議は全構成員の過半数');
ok(/PARTNER_TYPE_CHANGE[\s\S]*DISSOLUTION[\s\S]*議長裁量/.test(gs),'議長裁量の禁止例外');
ok(/nextMonthEnd_/.test(gs)&&/LICENSE_AGREEMENT/.test(gs),'利用許諾報告の翌月末期限');
ok(/Googleカレンダーに追加/.test(ui)&&/partRenderCalendar/.test(ui),'カレンダーベースUI');
ok(/議案・決議/.test(ui)&&/報告・清算/.test(ui)&&/構成員・議長/.test(ui),'事務局運営サブタブ');
ok(/52_admin_partnership\.gs/.test(build)&&/admin_partnership_patch\.html/.test(build),'adminビルドへ追加');
ok(/admin_partnership_patch/.test(entry),'admin entryでUI patch注入');
// 決議の記録が後から動かないこと（確定ガード・スナップショット）
ok(/decided_at\)\s*throw new Error\('DATA_CONFLICT/.test(gs),'確定済み議案は投票・編集・再確定を拒否');
ok(/tally_json/.test(gs)&&/source:'SNAPSHOT'/.test(gs),'確定時の集計をスナップショットして表示に使う');
ok(/function admin_reopenSecretariatAgenda/.test(gs)&&/requireRole_\(\['LEGAL_ADMIN'\]\)/.test(gs),'訂正は理由付きの再開手続きに限定');
// 日付はJST基準（GASのtoISOStringはUTCで1日ずれる）
ok(!/toISOString\(\)\.slice\(0,10\)/.test(gs.replace(/Date\.UTC[\s\S]{0,80}?toISOString\(\)\.slice\(0,10\)/g,'')),'期限・当日判定にUTCのtoISOStringを使わない');
ok(/Utilities\.formatDate\(new Date\(\), 'JST'/.test(gs),'当日・現在時刻はJSTで求める');
ok(/ctz=Asia%2FTokyo/.test(gs)&&/calDateTime_/.test(gs),'カレンダーURLは秒まで含みJSTで解釈させる');
// 契約第5条：議長はコアパートナーから
ok(/議長資格のない構成員は議長に指定できません/.test(gs),'議長資格をサーバー側で検証');
ok(/pt==='CORE'&&data\.chair_eligible!==false/.test(gs),'議長資格はコアパートナーに限る');
// シート読取のN+1回避
ok(/function partnershipContext_/.test(gs)&&/listAgendas_\(ctx/.test(gs),'一覧は読み取りを1回にまとめる');
// 画面からの導線
ok(/partOpenAttendance/.test(ui)&&/admin_listSecretariatAttendance/.test(ui),'出欠を画面から記録できる');
ok(/partReportFromContract/.test(ui)&&/admin_createLicenseReportFromContract/.test(ui),'締結済み契約から報告を起票できる');
ok(/partReopenAgenda/.test(ui),'確定した決議を画面から再開できる');
console.log('\nPARTNERSHIP RESULT: '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
