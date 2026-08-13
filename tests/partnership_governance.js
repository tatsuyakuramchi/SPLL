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
console.log('\nPARTNERSHIP RESULT: '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
