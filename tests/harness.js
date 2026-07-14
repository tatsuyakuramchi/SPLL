/**
 * SPLL 機能テストハーネス（修正設計書 §23 の単体・結合・セキュリティテスト）
 * GASスタブ（インメモリSpreadsheet/Drive/Utilities）上で spll_src/*.gs を実行。
 * 実行: npm test（node tests/harness.js）
 */
const fs = require('fs'), vm = require('vm'), path = require('path');

// ---- in-memory spreadsheet ----
function makeSheet(name){ return { name, rows: [] /* array of arrays incl header at [0] */ }; }
function Spreadsheet(id){ this.id=id; this.sheets={}; }
Spreadsheet.prototype.getSheetByName=function(n){ return this.sheets[n]||null; };
Spreadsheet.prototype.insertSheet=function(n){ const sh=sheetObj(n); this.sheets[n]=sh; this._order.push(n); return sh; };
Spreadsheet.prototype.getSheets=function(){ return this._order.map(n=>this.sheets[n]); };
Spreadsheet.prototype.deleteSheet=function(sh){ const i=this._order.indexOf(sh.name); if(i>=0)this._order.splice(i,1); delete this.sheets[sh.name]; };
Spreadsheet.prototype.getId=function(){ return this.id; };

function sheetObj(name){
  const data=[]; // 2D
  const sh={ name,
    getName:()=>name,
    getDataRange:()=> ({ getValues:()=> data.map(r=>r.slice()) }),
    getLastColumn:()=> data.length? data[0].length : 0,
    getLastRow:()=> data.length,
    setFrozenRows:()=>{},
    getRange:function(r,c,nr,nc){
      return {
        getValues:function(){ const out=[]; for(let i=0;i<(nr||1);i++){ const row=[]; for(let j=0;j<(nc||1);j++){ const rr=data[r-1+i]||[]; row.push(rr[c-1+j]!==undefined?rr[c-1+j]:''); } out.push(row); } return out; },
        setValues:function(vals){ for(let i=0;i<vals.length;i++){ if(!data[r-1+i])data[r-1+i]=[]; for(let j=0;j<vals[i].length;j++){ data[r-1+i][c-1+j]=vals[i][j]; } } return this; },
        setValue:function(v){ if(!data[r-1])data[r-1]=[]; data[r-1][c-1]=v; return this; }
      };
    },
    appendRow:function(arr){ data.push(arr.slice()); },
    _data:data
  };
  return sh;
}
Spreadsheet.prototype._init=function(){ this._order=[]; };

const stores = {}; // id -> Spreadsheet
function newSS(id, title){ const ss=new Spreadsheet(id); ss._init(); ss.title=title; ss.insertSheet('Sheet1'); stores[id]=ss; return ss; }

let ssSeq=0;
const SpreadsheetApp={
  create:function(title){ const id='SS'+(++ssSeq); return newSS(id,title); },
  openById:function(id){ if(!stores[id]) newSS(id,'auto'); return stores[id]; }
};

// ---- Drive ----
let fSeq=0, fileSeq=0;
function Folder(name){ this.name=name; this.id='FLD'+(++fSeq); this.folders=[]; this.files=[]; }
Folder.prototype.createFolder=function(n){ const f=new Folder(n); this.folders.push(f); return f; };
Folder.prototype.getFoldersByName=function(n){ const arr=this.folders.filter(f=>f.name===n); let i=0; return { hasNext:()=>i<arr.length, next:()=>arr[i++] }; };
Folder.prototype.createFile=function(blob){ const f={ id:'FILE'+(++fileSeq), blob, name:blob.name, getId:function(){return this.id;}, getBlob:function(){return this.blob;}, getSize:function(){return (blob.bytes?blob.bytes.length:0);}, setSharing:function(){return this;}, setTrashed:function(){this.trashed=true;return this;} }; this.files.push(f); driveFiles[f.id]=f; return f; };
Folder.prototype.getId=function(){ return this.id; };
const driveFolders={}, driveFiles={};
const DriveApp={
  createFolder:function(n){ const f=new Folder(n); driveFolders[f.id]=f; return f; },
  getFolderById:function(id){ if(!driveFolders[id]){ const f=new Folder('root'); f.id=id; driveFolders[id]=f;} return driveFolders[id]; },
  getFileById:function(id){ return driveFiles[id]||{ id, getBlob:()=>Blob('x','application/pdf','x'), getSize:()=>1, setTrashed:function(){return this;}, setSharing:function(){return this;} }; },
  Access:{ANYONE_WITH_LINK:1}, Permission:{VIEW:1}
};

// ---- Blob/Utilities ----
function Blob(content, type, name){
  let bytes;
  if(Array.isArray(content)) bytes=content;
  else bytes=Array.from(Buffer.from(String(content),'utf8'));
  return { bytes, type:type||'application/octet-stream', name:name||'blob',
    getBytes:function(){return this.bytes;}, getContentType:function(){return this.type;},
    setName:function(n){this.name=n;return this;}, getAs:function(t){ return Blob(content, t, this.name); } };
}
const Utilities={
  formatDate:function(d,tz,fmt){ const p=n=>String(n).padStart(2,'0'); return ''+d.getFullYear()+p(d.getMonth()+1); },
  getUuid:function(){ return 'uuid-'+Math.random().toString(36).slice(2,10); },
  newBlob:function(c,t,n){ return Blob(c,t,n); },
  base64Encode:function(x){ if(Array.isArray(x)) return Buffer.from(x).toString('base64'); return Buffer.from(String(x),'utf8').toString('base64'); },
  base64Decode:function(s){ return Array.from(Buffer.from(String(s),'base64')); },
  computeDigest:function(alg,val){ // deterministic: char codes
    const s=String(val); const out=[]; for(let i=0;i<Math.min(s.length,32);i++) out.push(s.charCodeAt(i)%256); while(out.length<32)out.push(0); return out; },
  computeHmacSignature:function(a,b,c){ return Array.from(Buffer.from(b+c).slice(0,20)); },
  DigestAlgorithm:{SHA_256:1}, MacAlgorithm:{HMAC_SHA_1:1}
};

// ---- Properties / Cache / Lock ----
const scriptProps={};
const PropertiesService={ getScriptProperties:()=>({
  getProperty:k=>(k in scriptProps?scriptProps[k]:null),
  setProperty:(k,v)=>{scriptProps[k]=String(v);},
  deleteProperty:k=>{delete scriptProps[k];}
})};
const CacheService={ getScriptCache:()=>({ get:()=>null, put:()=>{} }) };
const LockService={ getScriptLock:()=>({ waitLock:()=>{}, releaseLock:()=>{} }) };
const SlidesApp={ create:function(n){ const id='PRES'+Math.random().toString(36).slice(2,7); return { getId:()=>id, getSlides:()=>[{ getObjectId:()=>'p1', getBackground:()=>({setSolidFill:()=>{}}), insertTextBox:()=>({ getText:()=>({ getTextStyle:()=>({ setForegroundColor:function(){return this;}, setBold:function(){return this;}, setFontSize:function(){return this;} }) }) }) }], saveAndClose:()=>{} }; }, openById:function(id){ return { getSlides:()=>[{ getObjectId:()=>'p1' }], replaceAllText:()=>{}, saveAndClose:()=>{}, getId:()=>id }; } };
const ScriptApp={ getService:()=>({ getUrl:()=>'https://script.example/exec' }), getOAuthToken:()=>'oauth-tok' };
const Session={ getActiveUser:()=>({ getEmail:()=>'admin@example.com' }) };
const Logger={ log:function(){ } };
const MailApp={ sendEmail:function(){} };
const ContentService={ createTextOutput:function(s){ return { _t:s, getContent:()=>s }; } };
const HtmlService={ createHtmlOutput:function(h){ return { _h:h, setTitle:function(){return this;} }; },
  createHtmlOutputFromFile:function(f){ return { file:f, setTitle:function(){return this;} }; },
  createTemplateFromFile:function(f){ return { file:f, evaluate:function(){ return { setTitle:function(){return this;} }; } }; } };

// ---- UrlFetch stub (Gemini) ----
let geminiResponder = () => ({ overall_result:'REVIEW_REQUIRED', findings:[{ work_id:'WRK-ARK00012', rule_id:'R1', severity:'MEDIUM', result:'REVIEW_REQUIRED', page:1, evidence:'テスト指摘' }] });
const UrlFetchApp={ fetch:function(url, params){
  if(String(url).indexOf('aiplatform')>=0 || String(url).indexOf('generateContent')>=0){
    const obj=geminiResponder();
    const body={ candidates:[{ content:{ parts:[{ text:JSON.stringify(obj) }] } }] };
    return { getResponseCode:()=>200, getContentText:()=>JSON.stringify(body) };
  }
  return { getResponseCode:()=>200, getContentText:()=>'{}', getBlob:()=>Blob('img','image/png','b.png') };
}};

const sandbox={ console, Buffer, Date, Math, JSON, String, Number, Array, Object, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, RegExp,
  SpreadsheetApp, DriveApp, Utilities, PropertiesService, CacheService, LockService, SlidesApp, ScriptApp, Session, Logger, MailApp, ContentService, HtmlService, UrlFetchApp };
sandbox.global=sandbox;
vm.createContext(sandbox);
// 分割後：spll_src/*.gs を辞書順に結合（GASと同じロード規則）
const gsDir=path.join(__dirname,'..','spll_src');
const gsFiles=fs.readdirSync(gsDir).filter(f=>f.endsWith('.gs')).sort();
const code=gsFiles.map(f=>fs.readFileSync(gsDir+'/'+f,'utf8')).join('\n');
vm.runInContext(code, sandbox, {filename:'spll_src(combined)'});
const G=sandbox;

// ---- assertions ----
let pass=0, fail=0;
function ok(cond,msg){ if(cond){pass++; /*console.log('  ok:',msg);*/} else {fail++; console.log('  FAIL:',msg);} }
function rows(ss,name){ return G.readRows_(ss,name); }

// 1. bootstrap
const boot=G.setup_bootstrap({});
ok(boot.properties.SS_OPS,'bootstrap creates SS_OPS');
const OPS=G.ssOps_(), MAS=G.ssMaster_();
ok(rows(MAS,'Works_Master').length>=3,'sample works seeded');

// 2. application (multi-work)
G.updateRow_(MAS,'Works_Master','work_id','WRK-BKK00019',{publish_status:'PUBLISHED'});   // 検証用に公開
const appRes=G.web_createApplication(['WRK-ARK00012','WRK-BKK00019'],'電子出版物');
ok(appRes.application_ref && /REF-\d{6}-[A-Z0-9]{6}/.test(appRes.application_ref),'application_ref format: '+appRes.application_ref);
ok(rows(OPS,'Application_Works').length===2,'2 application_works rows');
const appRow=rows(OPS,'Applications')[0];
ok(appRow.status==='FORM_PENDING','application FORM_PENDING');

// 3. formrun webhook -> CONTRACT_PENDING
G.doPost({ parameter:{hook:'formrun'}, postData:{ contents:JSON.stringify({ application_ref:appRes.application_ref, columns:[] }) } });
ok(rows(OPS,'Applications')[0].status==='CONTRACT_PENDING','formrun sets CONTRACT_PENDING');

// 4. cloudsign completion webhook -> contract + contract_works + cert + badge + token
const wh=G.doPost({ parameter:{}, postData:{ contents:JSON.stringify({ document_id:'DOC-1', status:'COMPLETED', application_ref:appRes.application_ref }) } });
ok(String(wh.getContent())==='ok','cloudsign webhook ok');
const contract=rows(OPS,'Contracts')[0];
ok(contract && contract.status==='SIGNED','contract SIGNED');
ok(contract.application_ref===appRes.application_ref,'contract linked by application_ref');
ok(rows(OPS,'Contract_Works').filter(x=>x.contract_id===contract.contract_id).length===2,'contract_works snapshot 2');
ok(rows(OPS,'Applications')[0].status==='SIGNED','application SIGNED');
const cert=rows(OPS,'Certificates')[0];
ok(cert && cert.status==='ACTIVE' && cert.reason_code==='ISSUED','cert ACTIVE ISSUED');
ok(cert.check_code_hash && !cert.check_code,'cert stores hash only (no plaintext)');
ok(rows(OPS,'Badges').length===1,'badge issued at signing');
ok(rows(OPS,'Access_Tokens').filter(t=>t.contract_id===contract.contract_id&&t.purpose==='SUBMISSION').length>=1,'SUBMISSION token prepared');
ok(rows(OPS,'Access_Tokens').filter(t=>t.contract_id===contract.contract_id&&t.purpose==='REPORT').length>=1,'REPORT token prepared');

// 5. get submit token (need raw token). prepareSubmissionToken_ stores only hash. Use admin_sendUploadLink to get raw token.
const link=G.admin_sendUploadLink(contract.contract_id);
ok(link.token && link.url.indexOf('page=upload')>=0,'admin_sendUploadLink returns url+token');
const ctx=G.web_getSubmitContext(link.token);
ok(ctx.contract_id===contract.contract_id,'submit context contract');
ok(ctx.works.length===2,'submit context 2 works');

// 6. submit work v1
const b64=Buffer.from('%PDF-1.4 dummy-pdf-content').toString('base64');
const sub1=G.web_submitWork(link.token, { title:'二次創作X', filename:'x.pdf', mimeType:'application/pdf', dataBase64:b64, note:'' });
ok(sub1.submission_id && sub1.version_no===1,'submit v1 created');
const subRow=rows(OPS,'Submissions').find(s=>s.submission_id===sub1.submission_id);
// after AI review -> HUMAN_REVIEW_PENDING
ok(subRow.status==='HUMAN_REVIEW_PENDING','submission moved to HUMAN_REVIEW_PENDING after AI');
ok(rows(OPS,'Submission_Versions').filter(v=>v.submission_id===sub1.submission_id).length===1,'1 version');
ok(rows(OPS,'Submission_Files').length===1,'1 submission file');
const job1=rows(OPS,'AI_Review_Jobs')[0];
ok(job1.status==='COMPLETED' && job1.version_id,'AI job completed with version_id');
const finds=rows(OPS,'AI_Findings');
ok(finds.length>=1 && finds[0].work_id==='WRK-ARK00012','findings carry work_id');
const ver1=rows(OPS,'Submission_Versions').find(v=>v.submission_id===sub1.submission_id);
ok(ver1.status==='AI_SCREENED','version AI_SCREENED');

// 7. human review CLEARED
G.admin_setHumanReview(sub1.submission_id,'CLEARED','ok','rev@example.com', ver1.version_id);
ok(rows(OPS,'Submissions').find(s=>s.submission_id===sub1.submission_id).status==='CLEARED','submission CLEARED');
ok(rows(OPS,'Human_Reviews')[0].version_id===ver1.version_id,'human review has version_id');

// 8. resubmission -> v2 same submission
const sub2=G.web_submitWork(link.token, { submission_id:sub1.submission_id, title:'二次創作X', filename:'x2.pdf', mimeType:'application/pdf', dataBase64:b64 });
ok(sub2.version_no===2,'resubmission is v2');
ok(rows(OPS,'Submission_Versions').filter(v=>v.submission_id===sub1.submission_id).length===2,'2 versions total');
ok(rows(OPS,'Submissions').filter(s=>s.contract_id===contract.contract_id).length===1,'still 1 submission (no dup)');

// 9. admin review queue
const q=G.admin_reviewQueue();
ok(q.length===2 && q[0].work.indexOf('クトゥルフ')>=0,'review queue shows work names: '+(q[0]&&q[0].work));

// 10. admin list contracts multi-work
const lc=G.admin_listContracts();
const lcRow=lc.find(r=>r.contract_id===contract.contract_id);
ok(lcRow && lcRow.work.split('、').length===2,'listContracts shows 2 works: '+(lcRow&&lcRow.work));
ok(lcRow.cert_status==='ACTIVE','listContracts cert ACTIVE');

// 11. cert states
G.admin_setCertStatus(contract.contract_id,'SUSPENDED','PAYMENT','支払保留','LC-1');
ok(rows(OPS,'Certificates')[0].status==='SUSPENDED','cert SUSPENDED');
G.admin_reactivateCert(contract.contract_id);
ok(rows(OPS,'Certificates')[0].status==='ACTIVE','cert reactivated');

// 12. verify portal
const rot=G.admin_rotateCertCode(contract.contract_id);   // 平文コードは再発行でのみ取得
const vout=G.serveVerify_({ parameter:{ page:'verify', id:rot.cert_id, c:rot.check_code } });
ok(vout._h.indexOf('確認済み')>=0,'verify shows active');
const vbad=G.serveVerify_({ parameter:{ page:'verify', id:rot.cert_id, c:'WRONG1' } });
ok(vbad._h.indexOf('確認できません')>=0,'verify rejects wrong code');

// 13. settlement flow (multi-work split)
// approve a usage report first
const rlink=G.admin_sendReportLink(contract.contract_id);
const rptId=G.report_submit(rlink.token, { period:G.currentPeriod_(), channel:'DL', qty:10, gross:100000, returns:0, deductions:0, url:'' });
ok(rptId,'usage report submitted');
G.updateRow_(OPS,'Usage_Reports','report_id',rptId,{ status:'APPROVED' });
const gen=G.generateStatements_(G.currentPeriod_());
ok(gen.generated>=1,'statements generated: '+gen.generated);
const details=rows(OPS,'Settlement_Details');
ok(details.length>=1,'settlement details created');
const stmt=rows(OPS,'Settlement_Statements')[0];
ok(stmt.status==='DRAFT','statement DRAFT');
G.admin_approveStatement(stmt.statement_id);
ok(rows(OPS,'Settlement_Statements').find(s=>s.statement_id===stmt.statement_id).status==='APPROVED','statement APPROVED');

// 14. 未紐付け締結（ref無し）→ 手動紐付けフォールバック
geminiResponder=()=>({overall_result:'PASS_CANDIDATE',findings:[]});
// 別の申込を作成（複数原作）
const app2=G.web_createApplication(['WRK-BKK00019'],'書籍');
// ref無しの締結Webhook（status=2, textにREF含まず、application_ref無し）
const before=rows(OPS,'Contracts').length;
const whU=G.doPost({ parameter:{}, postData:{ contents:JSON.stringify({ documentID:'DOC-NOREF', status:2, userID:'u', email:'sender@corp.jp', text:'COMPLETED : 名称未設定の契約 sent by Jane' }) } });
ok(String(whU.getContent())==='ok-unlinked','ref無し締結は ok-unlinked を返す');
const unlinkedC=rows(OPS,'Contracts')[rows(OPS,'Contracts').length-1];
ok(unlinkedC.status==='SIGNED' && unlinkedC.link_status==='UNLINKED','未紐付け契約がSIGNED/UNLINKEDで記録される');
ok(!unlinkedC.application_id,'未紐付け契約は application_id 空');
ok(unlinkedC.cloudsign_title.indexOf('名称未設定')>=0,'書類タイトルを保存: '+unlinkedC.cloudsign_title);
// 未紐付けの間は認証・提出トークンを発行しない
ok(!rows(OPS,'Certificates').some(x=>x.contract_id===unlinkedC.contract_id),'未紐付けは認証未発行');
ok(!rows(OPS,'Access_Tokens').some(x=>x.contract_id===unlinkedC.contract_id&&x.purpose==='SUBMISSION'),'未紐付けは提出トークン未発行');
ok(!rows(OPS,'Contract_Works').some(x=>x.contract_id===unlinkedC.contract_id),'未紐付けは対象原作未固定');
// 一覧
const unlinkedList=G.admin_listUnlinkedContracts();
ok(unlinkedList.some(u=>u.contract_id===unlinkedC.contract_id),'admin_listUnlinkedContracts に出る');
const linkable=G.admin_listLinkableApplications();
ok(linkable.some(a=>a.application_id===app2.application_id),'app2 が紐付け候補に出る');
ok(!linkable.some(a=>a.application_id===appRow.application_id),'締結済み申込は候補に出ない');
// 手動紐付け
G.admin_linkContract(unlinkedC.contract_id, app2.application_id);
const relinked=rows(OPS,'Contracts').find(x=>x.contract_id===unlinkedC.contract_id);
ok(relinked.application_id===app2.application_id && relinked.link_status==='LINKED','手動紐付けでLINKED');
ok(rows(OPS,'Contract_Works').some(x=>x.contract_id===unlinkedC.contract_id && x.work_id==='WRK-BKK00019'),'紐付けで対象原作を固定');
ok(rows(OPS,'Certificates').some(x=>x.contract_id===unlinkedC.contract_id && x.status==='ACTIVE'),'紐付けで認証ACTIVE発行');
ok(rows(OPS,'Access_Tokens').some(x=>x.contract_id===unlinkedC.contract_id&&x.purpose==='SUBMISSION'),'紐付けで提出トークン発行');
ok(rows(OPS,'Applications').find(a=>a.application_id===app2.application_id).status==='SIGNED','紐付けで申込SIGNED');
// 二重紐付け防止
let dupErr=false; try{ G.admin_linkContract(unlinkedC.contract_id, appRow.application_id); }catch(e){ dupErr=true; }
ok(dupErr,'紐付け済み契約への再紐付けは拒否');
// status=3（取消）は契約化しない
const c_before=rows(OPS,'Contracts').length;
G.doPost({ parameter:{}, postData:{ contents:JSON.stringify({ documentID:'DOC-CANCEL', status:3, text:'CANCELED : x sent by y' }) } });
ok(rows(OPS,'Contracts').length===c_before,'status=3(取消)は契約を作らない');

// 15. 原作上限（最大5件・契約書テンプレート枠）と重複除去、申込導線設定
let capErr=false; try{ G.web_createApplication(['W1','W2','W3','W4','W5','W6']); }catch(e){ capErr=/最大5件|最大 5/.test(String(e.message||e)); }
ok(capErr,'6件選択はエラー（最大5件）');
const dedup=G.web_createApplication(['WRK-ARK00012','WRK-ARK00012','WRK-BKK00019'],'電子出版物');
ok(rows(OPS,'Application_Works').filter(x=>x.application_id===dedup.application_id).length===2,'重複原作は除去して2件');
const acfg=G.api_getApplyConfig();
ok(acfg.maxWorks===5 && typeof acfg.hiddenMap==='object','api_getApplyConfig: maxWorks=5 / hiddenMap object');
// 上限を設定で3に変更したら3件超はエラー
scriptProps.FORM_MAX_WORKS='3';
let cap3=false; try{ G.web_createApplication(['A','B','C','D']); }catch(e){ cap3=/最大3件|最大 3/.test(String(e.message||e)); }
ok(cap3,'設定変更で最大3件に反映');
ok(G.api_getApplyConfig().maxWorks===3,'api_getApplyConfig maxWorks=3 に反映');
scriptProps.FORM_MAX_WORKS='5';

// 16. 利用料条件（別紙2）：料金表・計算・スナップショット・清算率
ok(rows(MAS,'Fee_Schedule').length>=6,'Fee_Schedule seeded');
const uopts=G.api_getUsageOptions();
ok(uopts.some(o=>o.category==='電子出版物'),'api_getUsageOptions returns categories');
const tRate=G.api_previewFeeTerms('電子出版物',2);
ok(tRate.fee_model==='RATE' && tRate.rate===0.10,'RATE: 率0.10');
const tPer=G.api_previewFeeTerms('書籍',3);
ok(tPer.fee_model==='PER_WORK' && tPer.amount===16500*3,'PER_WORK: 16500×3='+tPer.amount);
ok(/×\s*3件/.test(tPer.fee_amount_or_rate),'PER_WORK 表示に×3件: '+tPer.fee_amount_or_rate);
const tFlat=G.api_previewFeeTerms('イベント',2);
ok(tFlat.fee_model==='FLAT' && tFlat.amount===0,'FLAT: 定額0');
// 申込に usage_category を保存 → 締結でスナップショット
const appR=G.web_createApplication(['WRK-ARK00012'],'電子出版物');
ok(rows(OPS,'Applications').find(a=>a.application_id===appR.application_id).usage_category==='電子出版物','申込にusage_category保存');
G.doPost({ parameter:{hook:'formrun'}, postData:{ contents:JSON.stringify({ application_ref:appR.application_ref, columns:[] }) } });
G.doPost({ parameter:{}, postData:{ contents:JSON.stringify({ documentID:'DOC-FEE', status:2, application_ref:appR.application_ref }) } });
const feeCtr=rows(OPS,'Contracts').find(c=>c.application_ref===appR.application_ref);
ok(feeCtr.usage_category==='電子出版物','契約にusage_categoryスナップショット');
const snap=JSON.parse(feeCtr.terms_snapshot||'{}');
ok(snap.fee_model==='RATE' && snap.rate===0.10,'terms_snapshot に RATE/率0.10');
// 清算：契約のスナップショット率(0.10)が使われる（既定と別の率で検証）
G.setConfig_('DEFAULT_ROYALTY_RATE','0.99');   // 既定を極端値に→スナップショット率が優先されることを確認
const rptF=G.report_submit(G.admin_sendReportLink(feeCtr.contract_id).token, { period:'2099H1', channel:'DL', qty:1, gross:10000, returns:0, deductions:0, url:'' });
G.updateRow_(OPS,'Usage_Reports','report_id',rptF,{ status:'APPROVED' });
const genF=G.generateStatements_('2099H1');
const detF=rows(OPS,'Settlement_Details').filter(d=>d.contract_id===feeCtr.contract_id);
ok(detF.length>=1,'清算明細が作成される');
const snapF=JSON.parse(detF[0].rate_snapshot||'{}');
ok(snapF.royalty_rate===0.10,'清算はスナップショット率0.10を使用（既定0.99ではない）: '+snapF.royalty_rate);

// ============ 修正設計書 セキュリティテスト（§23.3） ============
// 17. Webhook受信記録
ok(rows(OPS,'Webhook_Receipts').length>=3,'Webhook_Receipts に受信記録あり: '+rows(OPS,'Webhook_Receipts').length);
ok(rows(OPS,'Webhook_Receipts').every(r=>r.payload_hash),'全受信にpayload_hash');

// 18. production フェイルクローズ
scriptProps.ENVIRONMENT='production';
const rej=G.doPost({ parameter:{hook:'formrun'}, postData:{ contents:JSON.stringify({application_ref:'REF-000000-XXXXXX'}) } });
ok(String(rej.getContent())==='rejected','production: 秘密未設定のformrun Webhookは受信拒否');
// 共有秘密を設定して一致すれば受理
scriptProps.FORMRUN_WEBHOOK_SECRET='sec123';
const acc=G.doPost({ parameter:{hook:'formrun', key:'sec123'}, postData:{ contents:JSON.stringify({application_ref:'REF-000000-XXXXXX'}) } });
ok(String(acc.getContent())!=='rejected','production: 共有秘密一致で受理');
const bad=G.doPost({ parameter:{hook:'formrun', key:'WRONG'}, postData:{ contents:JSON.stringify({application_ref:'REF-000000-YYYYYY'}) } });
ok(String(bad.getContent())==='rejected','production: 共有秘密不一致は拒否');
// CloudSign: 資格情報なしのpayloadだけでは契約を作らない（ERROR受信→再試行待ち）
const cBefore=rows(OPS,'Contracts').length;
G.doPost({ parameter:{}, postData:{ contents:JSON.stringify({ documentID:'DOC-FORGED', status:2, text:'COMPLETED : x sent by y' }) } });
ok(rows(OPS,'Contracts').length===cBefore,'production: API照会できない締結Webhookでは契約を作成しない');

// 19. production 管理関数の匿名／未登録拒否
const SessRef=G.Session;
G.Session={ getActiveUser:()=>({ getEmail:()=>'' }) };   // 匿名
let anonErr=false; try{ G.admin_dashboard(); }catch(e){ anonErr=/AUTHENTICATION_ERROR/.test(String(e.message)); }
ok(anonErr,'production: 匿名の admin_ 呼出しは AUTHENTICATION_ERROR');
G.Session={ getActiveUser:()=>({ getEmail:()=>'stranger@example.com' }) };
let unregErr=false; try{ G.admin_recordPayment('C','I',1,'2026-01-01'); }catch(e){ unregErr=/AUTHORIZATION_ERROR/.test(String(e.message)); }
ok(unregErr,'production: 未登録ユーザーは AUTHORIZATION_ERROR');
// ロール登録＋権限外（初回登録は無条件、以降はSYSTEM_ADMIN必須）
G.setup_setInitialAdmin('admin@example.com','SYSTEM_ADMIN');    // 初回（テーブル空）
G.Session={ getActiveUser:()=>({ getEmail:()=>'admin@example.com' }) };
let selfReg=false; try{ G.setup_setInitialAdmin('auditor@example.com','AUDITOR'); selfReg=true; }catch(e){}
ok(selfReg,'SYSTEM_ADMIN による追加登録は許可');
G.Session={ getActiveUser:()=>({ getEmail:()=>'stranger@example.com' }) };
let hijack=false; try{ G.setup_setInitialAdmin('evil@example.com','SYSTEM_ADMIN'); }catch(e){ hijack=true; }
ok(hijack,'未登録ユーザーによる管理者追加は拒否（bootstrap乗っ取り防止）');
G.Session={ getActiveUser:()=>({ getEmail:()=>'admin@example.com' }) };
G.Session={ getActiveUser:()=>({ getEmail:()=>'auditor@example.com' }) };
ok(Array.isArray(G.admin_dashboard().alerts),'AUDITOR: 読取り関数は許可');
let roleErr=false; try{ G.admin_recordPayment('C','I',1,'2026-01-01'); }catch(e){ roleErr=/AUTHORIZATION_ERROR/.test(String(e.message)); }
ok(roleErr,'AUDITOR: 入金記録（ACCOUNTING専用）は拒否');
G.Session={ getActiveUser:()=>({ getEmail:()=>'admin@example.com' }) };
G.setup_setInitialAdmin('acct@example.com','ACCOUNTING');
G.Session={ getActiveUser:()=>({ getEmail:()=>'acct@example.com' }) };
let sysErr=false; try{ G.admin_saveAdminAccess({emails:'x'}); }catch(e){ sysErr=/AUTHORIZATION_ERROR/.test(String(e.message)); }
ok(sysErr,'ACCOUNTING: SYSTEM_ADMIN専用の設定保存は拒否');
G.Session=SessRef; scriptProps.ENVIRONMENT='development';

// 20. ファイル検証（SEC-05）
const linkV=G.admin_sendUploadLink(contract.contract_id);
let magErr=false; try{ G.web_submitWork(linkV.token,{ title:'x', filename:'evil.pdf', mimeType:'application/pdf', dataBase64:Buffer.from('MZ執行ファイル').toString('base64') }); }catch(e){ magErr=/シグネチャ不一致/.test(String(e.message)); }
ok(magErr,'マジックバイト不一致のPDFは拒否');
let extErr=false; try{ G.web_submitWork(linkV.token,{ title:'x', filename:'run.exe', mimeType:'application/pdf', dataBase64:b64 }); }catch(e){ extErr=/許可されていないファイル形式/.test(String(e.message)); }
ok(extErr,'拡張子exeは拒否');
let mimeErr=false; try{ G.web_submitWork(linkV.token,{ title:'x', filename:'a.pdf', mimeType:'text/html', dataBase64:b64 }); }catch(e){ mimeErr=/MIMEタイプ/.test(String(e.message)); }
ok(mimeErr,'MIME不一致は拒否');

// 21. 利用報告の入力検証・重複
const rl2=G.admin_sendReportLink(contract.contract_id);
let negErr=false; try{ G.report_submit(rl2.token,{ period:'2098H1', channel:'DL', qty:-1, gross:100, returns:0, deductions:0 }); }catch(e){ negErr=/0以上/.test(String(e.message)); }
ok(negErr,'負数は拒否');
let dedErr=false; try{ G.report_submit(rl2.token,{ period:'2098H1', channel:'DL', qty:1, gross:100, returns:60, deductions:50 }); }catch(e){ dedErr=/超えています/.test(String(e.message)); }
ok(dedErr,'控除+返品>総売上は拒否');
const rpt98=G.report_submit(rl2.token,{ period:'2098H1', channel:'DL', qty:1, gross:100000, returns:0, deductions:0 });
let dupErr2=false; try{ G.report_submit(rl2.token,{ period:'2098H1', channel:'DL', qty:1, gross:200, returns:0, deductions:0 }); }catch(e){ dupErr2=/既に提出/.test(String(e.message)); }
ok(dupErr2,'同一期間・チャネルの重複報告は拒否');

// 22. トークン期限・失効
const expTok=G.issueToken_(contract.contract_id,'REPORT',-1,5);   // 期限切れ
G.issueToken_(contract.contract_id,'REPORT',-1,5);                // バッチ用にもう1本
ok(G.resolveToken_(expTok,'REPORT')===null,'期限切れトークンは拒否');
ok(G.resolveToken_(rl2.token,'SUBMISSION')===null,'用途違い（REPORT→SUBMISSION）は拒否');
const exp=G.expireAccessTokens_();
ok(exp.processed>=1,'期限切れトークンをEXPIREDへ: '+exp.processed);

// 23. 請求起票（FUN-02）
// FLAT/PER_WORK: 書籍(PER_WORK)契約=app2由来 → 締結時起票済みのはず
ok(rows(OPS,'Invoices').some(v=>v.source_type==='CONTRACT'),'PER_WORK契約の請求が締結時に起票');
// RATE: 承認→起票（2098H1 の新規報告を承認して起票）
G.admin_approveReport(rpt98);
const gen2=G.admin_generateInvoicesFromReports('2098H1');
ok(gen2.generated>=1,'RATE請求を承認済み報告から起票: '+gen2.generated);
ok(rows(OPS,'Invoices').some(v=>v.source_type==='REPORT'),'REPORT由来の請求が存在');

// 24. 配分スキーム明示（FLOW-04）
const det2=rows(OPS,'Settlement_Details');
ok(det2.length && det2.every(d=>d.allocation_scheme==='BY_WORK_EQUAL'),'明細に配分スキーム記録');
ok(det2.some(d=>d.work_id),'明細に原作ID記録');

// 25. 人手審査のサーバー検証（§9.4：コメント必須・最新版チェック・列挙値）
let cmtErr=false; try{ G.admin_setHumanReview(sub1.submission_id,'CORRECTION_REQUIRED',''); }catch(e){ cmtErr=/コメント（理由）が必須/.test(String(e.message)); }
ok(cmtErr,'是正要求はコメント必須');
let enumErr=false; try{ G.admin_setHumanReview(sub1.submission_id,'DELETE_ALL','x'); }catch(e){ enumErr=/不正な審査結果/.test(String(e.message)); }
ok(enumErr,'不正な結果値は拒否');
const v1id=rows(OPS,'Submission_Versions').filter(v=>v.submission_id===sub1.submission_id).sort((a,b)=>a.version_no-b.version_no)[0].version_id;
let oldErr=false; try{ G.admin_setHumanReview(sub1.submission_id,'CLEARED','',null,v1id); }catch(e){ oldErr=/最新版ではありません/.test(String(e.message)); }
ok(oldErr,'旧版への審査は拒否（最新版チェック）');
G.admin_setHumanReview(sub1.submission_id,'CORRECTION_REQUIRED','クレジット表記が欠落しています。奥付に指定表記を追加してください。');
ok(rows(OPS,'Submissions').find(x=>x.submission_id===sub1.submission_id).status==='CORRECTION_REQUIRED','是正要求が記録される');
const hr=rows(OPS,'Human_Reviews').slice(-1)[0];
ok(hr.reviewer==='admin@example.com','審査者は認証済み操作者（クライアント入力を無視）');
// 26. 是正内容の利用者向け表示（§17.2）
const ctx2=G.web_getSubmitContext(linkV.token);
const subCtx=ctx2.submissions.find(x=>x.submission_id===sub1.submission_id);
ok(subCtx && subCtx.correction && /クレジット表記/.test(subCtx.correction.comment),'提出ページに是正コメントが返る');
ok(ctx2.badge_url && ctx2.badge_url.indexOf('page=badge')>=0,'提出ページにバッジ取得URLが返る');

console.log('\nSTAGE2 RESULT: '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
