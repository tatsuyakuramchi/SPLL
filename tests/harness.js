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
Folder.prototype.createFile=function(blob){ const f={ id:'FILE'+(++fileSeq), blob, name:blob.name, getId:function(){return this.id;}, getBlob:function(){return this.blob;}, getName:function(){return this.name;}, getSize:function(){return (blob.bytes?blob.bytes.length:0);}, setSharing:function(){return this;}, setTrashed:function(){this.trashed=true;return this;} }; this.files.push(f); driveFiles[f.id]=f; return f; };
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
    getDataAsString:function(charset){ return Buffer.from(this.bytes).toString('utf8'); },
    setName:function(n){this.name=n;return this;}, getAs:function(t){ return Blob(content, t, this.name); } };
}
const Utilities={
  formatDate:function(d,tz,fmt){ const p=n=>String(n).padStart(2,'0'); return ''+d.getFullYear()+p(d.getMonth()+1); },
  getUuid:function(){ return 'uuid-'+Math.random().toString(36).slice(2,10); },
  newBlob:function(c,t,n){ return Blob(c,t,n); },
  base64Encode:function(x){ if(Array.isArray(x)) return Buffer.from(x).toString('base64'); return Buffer.from(String(x),'utf8').toString('base64'); },
  base64Decode:function(s){ return Array.from(Buffer.from(String(s),'base64')); },
  computeDigest:function(alg,val){ const crypto=require('crypto');
    const buf=Array.isArray(val)?Buffer.from(val):Buffer.from(String(val),'utf8');
    return Array.from(crypto.createHash('sha256').update(buf).digest()); },
  computeHmacSignature:function(a,b,c){ return Array.from(Buffer.from(b+c).slice(0,20)); },
  computeHmacSha256Signature:function(payload,secret){ const crypto=require('crypto'); return Array.from(crypto.createHmac('sha256',String(secret)).update(String(payload)).digest()); },
  base64EncodeWebSafe:function(x){ const b=Array.isArray(x)?Buffer.from(x):Buffer.from(String(x),'utf8'); return b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_'); },
  parseCsv:function(text){
    const rows=[]; let row=[], cell='', inQ=false; const s=String(text);
    for(let i=0;i<s.length;i++){
      const ch=s[i];
      if(inQ){ if(ch==='"'){ if(s[i+1]==='"'){ cell+='"'; i++; } else inQ=false; } else cell+=ch; }
      else if(ch==='"') inQ=true;
      else if(ch===','){ row.push(cell); cell=''; }
      else if(ch==='\n'||ch==='\r'){ if(ch==='\r'&&s[i+1]==='\n') i++; row.push(cell); rows.push(row); row=[]; cell=''; }
      else cell+=ch;
    }
    if(cell!==''||row.length){ row.push(cell); rows.push(row); }
    return rows;
  },
  zip:function(blobs,name){ return Blob('ZIP:'+(blobs||[]).map(b=>b.name).join('|'),'application/zip',name||'archive.zip'); },
  DigestAlgorithm:{SHA_256:1}, MacAlgorithm:{HMAC_SHA_1:1}
};

// ---- Properties / Cache / Lock ----
const scriptProps={};
const PropertiesService={ getScriptProperties:()=>({
  getProperty:k=>(k in scriptProps?scriptProps[k]:null),
  setProperty:(k,v)=>{scriptProps[k]=String(v);},
  deleteProperty:k=>{delete scriptProps[k];}
})};
const _cache={};
const CacheService={ getScriptCache:()=>({ get:k=>(k in _cache?_cache[k]:null), put:(k,v)=>{_cache[k]=String(v);} }) };
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
  if(String(url).indexOf('cloudsign.jp')>=0){
    if(String(url).indexOf('/token')>=0) return { getResponseCode:()=>200, getContentText:()=>JSON.stringify({access_token:'cs-tok',expires_in:3000}) };
    if(params && String(params.method).toLowerCase()==='post' && String(url).endsWith('/documents'))
      return { getResponseCode:()=>200, getContentText:()=>JSON.stringify({id:'CSDOC-'+(++fileSeq)}) };
    return { getResponseCode:()=>200, getContentText:()=>'{}', getBlob:()=>Blob('pdf','application/pdf','f.pdf') };
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
const code=gsFiles.map(f=>fs.readFileSync(gsDir+'/'+f,'utf8')).join('\n')
  + '\n' + fs.readFileSync(path.join(__dirname,'..','apps','workflow','entry.gs'),'utf8');   // doGet/doPost（GAS②）
vm.runInContext(code, sandbox, {filename:'spll_src(combined)'});
const G=sandbox;

scriptProps.ENVIRONMENT='development';
scriptProps.ALLOW_DEV_BOOTSTRAP='true';

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
function mkApp(workIds,usage,extra){ return G.web_createApplication(Object.assign({ workIds:workIds, usageCategory:usage,
  privacyConsent:true, termsConsent:true, consentSessionId:'sess-test', displayHash:'fnv1a:test' }, extra||{})); }
const appRes=mkApp(['WRK-ARK00012','WRK-BKK00019'],'電子出版物');
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

// 11. cert states（V2-018：重要変更は申請→別担当者の承認・職務分離）
G.admin_setCertStatus(contract.contract_id,'SUSPENDED','PAYMENT','支払保留','LC-1');
ok(rows(OPS,'Certificates')[0].status==='SUSPENDED','cert SUSPENDED（非重要は直接変更可）');
let critErr=false; try{ G.admin_setCertStatus(contract.contract_id,'REVOKED','X','x',''); }catch(e){ critErr=/申請・承認の分離/.test(String(e.message)); }
ok(critErr,'重要状態（REVOKED等）の直接変更は拒否');
const reqA=G.admin_reactivateCert(contract.contract_id);
ok(reqA && reqA.request_id,'再有効化は申請を作成（即時変更しない）');
ok(rows(OPS,'Certificates')[0].status==='SUSPENDED','承認前は状態が変わらない');
ok(G.admin_listCertChangeRequests().some(r=>r.request_id===reqA.request_id),'承認待ち一覧に出る');
let selfErr=false; try{ G.admin_approveCertChange(reqA.request_id,true,''); }catch(e){ selfErr=/本人は承認できません/.test(String(e.message)); }
ok(selfErr,'申請者本人の承認は拒否（職務分離）');
const SessA=G.Session;
G.Session={ getActiveUser:()=>({ getEmail:()=>'legal2@example.com' }) };
G.admin_approveCertChange(reqA.request_id,true,'');
G.Session=SessA;
ok(rows(OPS,'Certificates')[0].status==='ACTIVE','別担当者の承認で再有効化（APPLIED）');
const reqRowA=rows(OPS,'Certificate_Change_Requests').find(r=>r.request_id===reqA.request_id);
ok(reqRowA.status==='APPLIED' && reqRowA.approved_by==='legal2@example.com' && !reqRowA.emergency_override,'申請APPLIED＋承認者記録（override無し）');
// 再有効化で照合コード再発行＋バッジ再生成（旧QR差替え・V2-015）
ok(rows(OPS,'Badges').some(b=>b.contract_id===contract.contract_id&&b.status==='SUPERSEDED'),'旧バッジをSUPERSEDED');
ok(rows(OPS,'Badge_Jobs').some(j=>j.contract_id===contract.contract_id&&j.status==='ISSUED'),'バッジ再生成ジョブがISSUED');
ok(rows(OPS,'Badges').filter(b=>b.contract_id===contract.contract_id&&b.status==='ISSUED').length===1,'有効バッジは常に1枚');
// 緊急時のみ本人承認可＝EMERGENCY_OVERRIDE として記録
const reqB=G.admin_revokeCert(contract.contract_id,'緊急停止テスト');
G.admin_approveCertChange(reqB.request_id,true,'権利者からの緊急要請');
const reqRowB=rows(OPS,'Certificate_Change_Requests').find(r=>r.request_id===reqB.request_id);
ok(rows(OPS,'Certificates')[0].status==='REVOKED' && String(reqRowB.emergency_override).indexOf('EMERGENCY_OVERRIDE')===0,'緊急承認はEMERGENCY_OVERRIDEとして記録');
let dupAppr=false; try{ G.admin_approveCertChange(reqB.request_id,true,'x'); }catch(e){ dupAppr=/処理済み/.test(String(e.message)); }
ok(dupAppr,'処理済み申請の再承認は拒否');
// 却下は状態を変えない
const reqC=G.admin_requestCertChange(contract.contract_id,'ACTIVE','REACTIVATE','誤操作のため再有効化','');
G.Session={ getActiveUser:()=>({ getEmail:()=>'legal2@example.com' }) };
G.admin_approveCertChange(reqC.request_id,false,'');
G.Session=SessA;
ok(rows(OPS,'Certificate_Change_Requests').find(r=>r.request_id===reqC.request_id).status==='REJECTED','却下でREJECTED');
ok(rows(OPS,'Certificates')[0].status==='REVOKED','却下は状態を変えない');
// 後続テストのためACTIVEへ戻す（申請→別担当者承認）
const reqD=G.admin_reactivateCert(contract.contract_id);
G.Session={ getActiveUser:()=>({ getEmail:()=>'legal2@example.com' }) };
G.admin_approveCertChange(reqD.request_id,true,'');
G.Session=SessA;
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
const app2=mkApp(['WRK-BKK00019'],'書籍');
// ref無しの締結Webhook（status=2, textにREF含まず、application_ref無し）
const before=rows(OPS,'Contracts').length;
const whU=G.doPost({ parameter:{}, postData:{ contents:JSON.stringify({ documentID:'DOC-NOREF', status:2, userID:'u', email:'sender@corp.jp', text:'COMPLETED : 名称未設定の契約 sent by Jane' }) } });
ok(String(whU.getContent())==='accepted-manual-review','ref無し締結は手動確認キューへ（accepted-manual-review）');
ok(rows(OPS,'Webhook_Receipts').some(r=>r.status==='MANUAL_REVIEW'&&r.manual_review_reason),'受信が MANUAL_REVIEW＋理由つきで残る');
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
let capErr=false; try{ mkApp(['W1','W2','W3','W4','W5','W6'],'書籍'); }catch(e){ capErr=/最大5件|最大 5/.test(String(e.message||e)); }
ok(capErr,'6件選択はエラー（最大5件）');
const dedup=mkApp(['WRK-ARK00012','WRK-ARK00012','WRK-BKK00019'],'電子出版物');
ok(rows(OPS,'Application_Works').filter(x=>x.application_id===dedup.application_id).length===2,'重複原作は除去して2件');
const acfg=G.api_getApplyConfig();
ok(acfg.maxWorks===5 && typeof acfg.hiddenMap==='object','api_getApplyConfig: maxWorks=5 / hiddenMap object');
// 上限を設定で3に変更したら3件超はエラー
scriptProps.FORM_MAX_WORKS='3';
let cap3=false; try{ mkApp(['A','B','C','D'],'書籍'); }catch(e){ cap3=/最大3件|最大 3/.test(String(e.message||e)); }
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
const appR=mkApp(['WRK-ARK00012'],'電子出版物');
ok(rows(OPS,'Applications').find(a=>a.application_id===appR.application_id).usage_category==='電子出版物','申込にusage_category保存');
G.doPost({ parameter:{hook:'formrun'}, postData:{ contents:JSON.stringify({ application_ref:appR.application_ref, columns:[] }) } });
G.doPost({ parameter:{}, postData:{ contents:JSON.stringify({ documentID:'DOC-FEE', status:2, application_ref:appR.application_ref }) } });
const feeCtr=rows(OPS,'Contracts').find(c=>c.application_ref===appR.application_ref);
ok(feeCtr.usage_category==='電子出版物','契約にusage_categoryスナップショット');
const snap=JSON.parse(feeCtr.terms_snapshot||'{}');
ok(snap.fee_model==='RATE' && snap.rate===0.10,'terms_snapshot に RATE/率0.10');
// 清算：契約のスナップショット率(0.10)が使われる（既定と別の率で検証）
G.setConfig_('DEFAULT_ROYALTY_RATE','0.99');   // 既定を極端値に→スナップショット率が優先されることを確認
const rptF=G.report_submit(G.admin_sendReportLink(feeCtr.contract_id).token, { period:G.currentPeriod_(), channel:'DL', qty:1, gross:10000, returns:0, deductions:0, url:'' });
G.updateRow_(OPS,'Usage_Reports','report_id',rptF,{ status:'APPROVED' });
const genF=G.generateStatements_(G.currentPeriod_());   // 追加清算（per-report冪等・V2-011）
ok(genF.generated>=1,'後から承認された報告だけを追加清算できる: '+genF.generated);
const genAgain=G.generateStatements_(G.currentPeriod_());
ok(genAgain.generated===0,'再実行では二重清算しない（report_id単位の冪等）');
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
// 管理画面スイッチ（3プロジェクト分割後は ADMIN_CONSOLE_URL を指す）
scriptProps.ADMIN_CONSOLE_URL='https://script.google.com/macros/s/ADMIN-DEPLOY/exec';
const vr=G.api_getViewerRole();
ok(vr.isAdmin===true && vr.identified===true,'Admin_Users 登録者は isAdmin（ADMIN_EMAILS不要）');
ok(vr.adminUrl==='https://script.google.com/macros/s/ADMIN-DEPLOY/exec','スイッチ先は ADMIN_CONSOLE_URL');
G.Session={ getActiveUser:()=>({ getEmail:()=>'nobody@example.com' }) };
ok(G.api_getViewerRole().isAdmin===false,'未登録ユーザーは isAdmin=false');
delete scriptProps.ADMIN_CONSOLE_URL;
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
let negErr=false; try{ G.report_submit(rl2.token,{ period:G.currentPeriod_(), channel:'委託販売', qty:-1, gross:100, returns:0, deductions:0 }); }catch(e){ negErr=/0以上/.test(String(e.message)); }
ok(negErr,'負数は拒否');
let dedErr=false; try{ G.report_submit(rl2.token,{ period:G.currentPeriod_(), channel:'委託販売', qty:1, gross:100, returns:60, deductions:50 }); }catch(e){ dedErr=/超えています/.test(String(e.message)); }
let futErr=false; try{ G.report_submit(rl2.token,{ period:'2098H1', channel:'委託販売', qty:1, gross:100, returns:0, deductions:0 }); }catch(e){ futErr=/報告できない期/.test(String(e.message)); }
ok(futErr,'将来期の報告は拒否');
let fmtErr=false; try{ G.report_submit(rl2.token,{ period:'2026-上期', channel:'委託販売', qty:1, gross:100, returns:0, deductions:0 }); }catch(e){ fmtErr=/期の形式/.test(String(e.message)); }
ok(fmtErr,'期の形式違反は拒否');
ok(dedErr,'控除+返品>総売上は拒否');
const rpt98=G.report_submit(rl2.token,{ period:G.currentPeriod_(), channel:'委託販売', qty:1, gross:100000, returns:0, deductions:0 });
let dupErr2=false; try{ G.report_submit(rl2.token,{ period:G.currentPeriod_(), channel:'委託販売', qty:1, gross:200, returns:0, deductions:0 }); }catch(e){ dupErr2=/既に提出/.test(String(e.message)); }
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
// RATE: 承認→起票
G.admin_approveReport(rpt98);
const gen2=G.admin_generateInvoicesFromReports(G.currentPeriod_());
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

// ============ A-中（通知・SLA・AI証跡・請求・版管理・レート制限） ============
// 27. 通知キュー（§10）
ok(rows(OPS,'Notification_Queue').some(n=>n.type==='UPLOAD_GUIDE'),'締結時に提出案内の通知を起票');
ok(rows(OPS,'Notification_Queue').some(n=>n.type==='CORRECTION_REQUEST'),'是正要求で通知を起票');
const nq=rows(OPS,'Notification_Queue').find(n=>n.type==='CORRECTION_REQUEST');
ok(nq.status==='MANUAL_REQUIRED','通知は人手対応（MANUAL_REQUIRED）');
G.admin_markNotificationHandled(nq.notification_id);
ok(rows(OPS,'Notification_Queue').find(n=>n.notification_id===nq.notification_id).status==='SENT','対応済み記録（handled_by付き）');
const dupN=rows(OPS,'Notification_Queue').filter(n=>n.type==='UPLOAD_GUIDE'&&n.reference_id===contract.contract_id).length;
G.enqueueNotification_(contract.contract_id,'UPLOAD_GUIDE',contract.contract_id,{});
ok(rows(OPS,'Notification_Queue').filter(n=>n.type==='UPLOAD_GUIDE'&&n.reference_id===contract.contract_id).length===dupN,'同一参照の通知は重複起票しない');

// 28. SLA監視（§18）— 起点は「最新版の提出日時」（V2-017：再提出でSLAを再計算）
G.updateRow_(OPS,'Submissions','submission_id',sub1.submission_id,{ status:'HUMAN_REVIEW_PENDING', submitted_at:'2020-01-01T00:00:00.000Z' });
const sla0=G.notifyReviewSla_();
ok(sla0.processed===0,'最新版が新しい間はSLA超過にしない（再提出でリセット）: '+sla0.processed);
const lv28=rows(OPS,'Submission_Versions').filter(v=>v.submission_id===sub1.submission_id).sort((a,b)=>Number(b.version_no)-Number(a.version_no))[0];
G.updateRow_(OPS,'Submission_Versions','version_id',lv28.version_id,{ submitted_at:'2020-01-02T00:00:00.000Z' });
const sla=G.notifyReviewSla_();
ok(sla.processed>=1,'審査SLA超過を通知キューへ: '+sla.processed);
ok(rows(OPS,'Notification_Queue').some(n=>n.type==='REVIEW_SLA_OVERDUE'),'REVIEW_SLA_OVERDUE 起票');
const due=G.notifyReportDue_();
ok(typeof due.processed==='number'||due.skipped,'報告期限監視が実行できる: '+JSON.stringify(due));

// 29. AI審査の証跡（§9.3）
const jobDone=rows(OPS,'AI_Review_Jobs').find(j=>j.status==='COMPLETED');
ok(jobDone.overall_result,'ジョブに overall_result 記録: '+jobDone.overall_result);
ok(jobDone.response_file_id,'AI生レスポンスをDrive保存（response_file_id）');
ok(jobDone.started_at && jobDone.completed_at,'開始・完了日時を記録');

// 30. 請求の税・期日・入金検証（§11.3/§11.4）
const invT=rows(OPS,'Invoices').find(v=>v.source_type==='CONTRACT');
ok(num_ll(invT.tax_amount)===Math.round(num_ll(invT.amount)*0.10),'税額=本体×10%: '+invT.tax_amount);
ok(num_ll(invT.total_amount)===num_ll(invT.amount)+num_ll(invT.tax_amount),'税込合計が一致');
ok(invT.due_date && /^\d{4}-\d{2}-\d{2}$/.test(invT.due_date),'支払期日を設定: '+invT.due_date);
function num_ll(v){ return parseFloat(String(v))||0; }
// 過入金の検出
// 一部入金→残額→全額→過入金（V2-010）
const half=Math.floor(num_ll(invT.total_amount)/2);
const p1=G.admin_recordPayment(invT.contract_id, invT.invoice_id, half, '2026-07-14', 'BANK-001');
ok(p1.status==='PARTIALLY_PAID' && p1.balance===num_ll(invT.total_amount)-half,'一部入金で PARTIALLY_PAID＋残額');
let refDup=false; try{ G.admin_recordPayment(invT.contract_id, invT.invoice_id, 1, '2026-07-14', 'BANK-001'); }catch(e){ refDup=/入金参照番号/.test(String(e.message)); }
ok(refDup,'同一入金参照番号は拒否');
const p2=G.admin_recordPayment(invT.contract_id, invT.invoice_id, num_ll(invT.total_amount)-half+500, '2026-07-15', 'BANK-002');
ok(p2.status==='OVERPAID' && p2.diff===500,'累計で過入金 +500 を検出（OVERPAID）');
let wrongC=false; try{ G.admin_recordPayment('CTR-WRONG', invT.invoice_id, 1, '2026-07-15', 'BANK-003'); }catch(e){ wrongC=/契約が一致しません/.test(String(e.message)); }
ok(wrongC,'別契約の請求への入金は拒否');
let noInv=false; try{ G.admin_recordPayment(invT.contract_id, 'INV-NONE', 1, '2026-07-15'); }catch(e){ noInv=/請求が見つかりません/.test(String(e.message)); }
ok(noInv,'存在しない請求への入金は拒否');
// 取消は理由必須
let vrErr=false; try{ G.admin_voidPayment(invT.invoice_id,''); }catch(e){ vrErr=/取消理由は必須/.test(String(e.message)); }
ok(vrErr,'取消理由なしは拒否');
G.admin_voidPayment(invT.invoice_id,'金額誤り（過入金の訂正）');
ok(rows(OPS,'Payments').some(p=>p.status==='VOID'&&p.void_reason&&p.voided_by),'取消理由・取消者を記録');
ok(rows(OPS,'Invoices').find(v=>v.invoice_id===invT.invoice_id).status==='UNPAID','取消後に UNPAID へ再計算');

// 31. 規約の版管理（§7.2）
const d1=G.admin_saveLegalDraft('PRIVACY','<p>新しい同意文 v-next</p>');
const d2=G.admin_saveLegalDraft('TERMS','<p>新しい規約 v-next</p>');
ok(d1.version>=1 && d2.version>=1,'DRAFT作成（版番号採番）');
// 公開前は既定文のまま
ok(G.api_getLegalTexts().privacy.indexOf('v-next')<0,'公開前のDRAFTは申込に使われない');
G.admin_publishLegalDoc(d1.legal_document_id); G.admin_publishLegalDoc(d2.legal_document_id);
const lt=G.api_getLegalTexts();
ok(lt.privacy.indexOf('v-next')>=0 && lt.privacy_version===d1.version,'公開後は新版が配信される（版番号つき）');
// 申込の同意証跡に文書IDが紐付く
const appC=mkApp(['WRK-ARK00012'],'書籍',{ privacyDocumentId:d1.legal_document_id, termsDocumentId:d2.legal_document_id });
const cons=rows(OPS,'Application_Consents').filter(c=>c.application_id===appC.application_id);
ok(cons.length===2 && cons.every(c=>c.legal_document_id),'同意証跡2件（文書ID・ハッシュ付き）');

// 32. レート制限（§6.4）
ok(G.rateLimit_('t1',3,60) && G.rateLimit_('t1',3,60) && G.rateLimit_('t1',3,60),'上限内は許可');
ok(!G.rateLimit_('t1',3,60),'上限超過で拒否');
for(var ri=0;ri<30;ri++) G.rateLimit_('verify:'+rot.cert_id,30,3600);
const vLim=G.serveVerify_({ parameter:{ page:'verify', id:rot.cert_id, c:'x' } });
ok(vLim._h.indexOf('照会回数が上限')>=0,'検証ポータルの照会回数制限');

// ============ 修正設計書v2 追加検証 ============
// 33. ENVIRONMENT必須（V2-002）
delete scriptProps.ENVIRONMENT;
let envErr=false; try{ G.env_(); }catch(e){ envErr=/ENVIRONMENT is required/.test(String(e.message)); }
ok(envErr,'ENVIRONMENT未設定は停止');
scriptProps.ENVIRONMENT='invalid-env';
let envErr2=false; try{ G.env_(); }catch(e){ envErr2=/Invalid ENVIRONMENT/.test(String(e.message)); }
ok(envErr2,'不正なENVIRONMENTは停止');
scriptProps.ENVIRONMENT='development';

// 34. 同意の厳格化（V2-005/006）
let cErr=false; try{ G.web_createApplication({ workIds:['WRK-ARK00012'], usageCategory:'書籍', termsConsent:true }); }catch(e){ cErr=/個人情報の取扱いへの同意/.test(String(e.message)); }
ok(cErr,'privacyConsent無しは拒否');
let staleErr=false; try{ mkApp(['WRK-ARK00012'],'書籍',{ privacyDocumentId:'OLD-DOC', termsDocumentId:d2.legal_document_id }); }catch(e){ staleErr=/更新されました/.test(String(e.message)); }
ok(staleErr,'古い文書IDの申込は拒否（再表示を促す）');
const consC=rows(OPS,'Application_Consents').filter(c=>c.application_id===appC.application_id);
ok(consC.every(c=>c.consent_session_id==='sess-test'&&c.evidence_version==='v2'&&c.accepted==='true'),'同意証跡にセッション・版・accepted記録');
// production で公開版必須：一旦 RETIRED にして確認
scriptProps.ENVIRONMENT='production';
G.updateRow_(OPS,'Legal_Documents','legal_document_id',d1.legal_document_id,{status:'RETIRED'});
let pubErr=false; try{ mkApp(['WRK-ARK00012'],'書籍',{ privacyDocumentId:d1.legal_document_id, termsDocumentId:d2.legal_document_id }); }catch(e){ pubErr=/受け付けられません/.test(String(e.message)); }
ok(pubErr,'production: 公開済み法務文書なしでは申込拒否');
G.updateRow_(OPS,'Legal_Documents','legal_document_id',d1.legal_document_id,{status:'PUBLISHED'});
scriptProps.ENVIRONMENT='development';

// 35. handoff_token（フォーム項目設計 §4.1.1）
scriptProps.HANDOFF_SECRET='handoff-secret';
const appH=mkApp(['WRK-ARK00012'],'書籍',{ privacyDocumentId:d1.legal_document_id, termsDocumentId:d2.legal_document_id });
ok(appH.handoff_token && appH.handoff_token.length>=16,'handoff_token発行');
const appHrow=rows(OPS,'Applications').find(a=>a.application_id===appH.application_id);
const okTok=G.verifyHandoffToken_(appHrow, ['WRK-ARK00012'], appH.handoff_token);
ok(okTok.ok===true,'正しいhandoff_tokenは検証通過');
const ngTok=G.verifyHandoffToken_(appHrow, ['WRK-ARK00012'], 'TAMPERED');
ok(ngTok.ok===false,'改変されたhandoff_tokenは拒否');
// formrun経由の改変検知 → MANUAL_REVIEW
const frBad=G.doPost({ parameter:{hook:'formrun'}, postData:{ contents:JSON.stringify({ application_ref:appH.application_ref, columns:[{name:'handoff',value:'x'}], handoff_token:'TAMPERED' }) } });
delete scriptProps.HANDOFF_SECRET;

// 36. スキーマ移行（V2-003）
const m1=G.ensureSheetColumns_(OPS,'Migration_Test',['a','b']);
ok(m1.createdSheet===true,'移行: 新規シート作成');
const m2=G.ensureSheetColumns_(OPS,'Migration_Test',['a','b','c','d']);
ok(m2.addedColumns.length===2 && m2.addedColumns[0]==='c','移行: 不足列を末尾に追加');
const m3=G.ensureSheetColumns_(OPS,'Migration_Test',['a','b','c','d']);
ok(m3.addedColumns.length===0,'移行: 2回実行しても列が重複しない');
const mig=G.migrateSchema_();
ok(rows(OPS,'Migration_Runs').some(r=>r.status==='DONE'),'Migration_Runs に DONE 記録');
ok(rows(OPS,'Schema_Versions').length>=2,'Schema_Versions に MASTER/OPS 記録');
// production では setup_reset 禁止（V2-004）
scriptProps.ENVIRONMENT='production';
let resetErr=false; try{ G.setup_reset(); }catch(e){ resetErr=/production では setup_reset/.test(String(e.message)); }
ok(resetErr,'production: setup_reset禁止');
scriptProps.ENVIRONMENT='development';

// 37. 清算送信の冪等（V2-012）
scriptProps.CLOUDSIGN_CLIENT_ID='cs-test-client';
const apStmts=rows(OPS,'Settlement_Statements').filter(x=>x.status==='APPROVED');
if(apStmts.length){
  const s1=G.batch_sendApprovedStatements_();
  ok(s1.sent>=1,'承認済み計算書を送信: '+s1.sent);
  const stSent=rows(OPS,'Settlement_Statements').find(x=>x.send_status==='SENT');
  ok(stSent && stSent.send_attempt_id,'送信試行ID・send_statusを記録');
  G.updateRow_(OPS,'Settlement_Statements','statement_id',stSent.statement_id,{status:'APPROVED'});   // 台帳更新失敗を再現
  const s2=G.batch_sendApprovedStatements_();
  ok(rows(OPS,'Settlement_Statements').filter(x=>x.statement_id===stSent.statement_id&&x.cloudsign_document_id).length===1 && s2.sent===0,
    '外部書類ID保持により二重送信しない');
}
delete scriptProps.CLOUDSIGN_CLIENT_ID;

// ============ P1（V2-014〜018）追加検証 ============
// 38. 照合コードの暗号学的生成（V2-015：Math.random不使用・紛らわしい文字なし）
const codes=new Set(); for(let ci=0;ci<50;ci++) codes.add(G.randCode_(12));
ok(codes.size===50,'randCode_ 50回で重複なし');
ok(Array.from(codes).every(c=>/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/.test(c)),'randCode_ 文字集合・桁数（I/O/0/1を含まない）');

// 39. バッジ配信（V2-014）：共有リンク不使用・トークン検証後にデータURIで配信
const bJobs=rows(OPS,'Badge_Jobs');
ok(bJobs.length>=1 && bJobs.every(j=>['QUEUED','GENERATING','ISSUED','RETRY_WAIT','ERROR'].indexOf(j.status)>=0),'Badge_Jobs に発行履歴を記録');
const bview=G.serveBadge_({ parameter:{ page:'badge', token:linkV.token } });   // 提出トークンのまま閲覧可（再発行不要）
ok(bview._h.indexOf('data:image/png;base64,')>=0,'バッジはdata URIで配信（Drive共有リンク不使用）');
ok(bview._h.indexOf('download=')>=0,'PNGダウンロード属性あり');
const bbad=G.serveBadge_({ parameter:{ page:'badge', token:'WRONG-TOKEN' } });
ok(bbad._h.indexOf('無効')>=0,'不正トークンはバッジ拒否');

// 40. AI出力の無害化＋recommended_action（V2-016：数式インジェクション対策）
geminiResponder=()=>({ overall_result:'REVIEW_REQUIRED', findings:[{ work_id:'WRK-ARK00012', rule_id:'=CMD()', severity:'MEDIUM',
  result:'REVIEW_REQUIRED', page:1, evidence:'=HYPERLINK("http://evil")', recommended_action:'+SUM(A1)対応を推奨' }] });
const linkAI=G.admin_sendUploadLink(contract.contract_id);
const subAI=G.web_submitWork(linkAI.token,{ title:'AI無害化テスト', filename:'ai.pdf', mimeType:'application/pdf', dataBase64:b64 });
const fAI=rows(OPS,'AI_Findings').slice(-1)[0];
ok(fAI.evidence.charAt(0)==="'" && fAI.rule_id.charAt(0)==="'" && fAI.recommended_action.charAt(0)==="'",'AI出力の式文字を無害化（先頭引用符）');
ok(fAI.recommended_action.indexOf('SUM')>=0,'recommended_action を保存');

// 41. AI利用不能時（V2-016）：提出を失わず AI_UNAVAILABLE→人手審査へ
geminiResponder=()=>{ throw new Error('Gemini unavailable'); };
G.web_submitWork(linkAI.token,{ submission_id:subAI.submission_id, title:'AI失敗テスト', filename:'ai2.pdf', mimeType:'application/pdf', dataBase64:b64 });
for(let ri2=0;ri2<5;ri2++){ try{ G.batch_runAiReviews_(); }catch(e){} }
const deadJob=rows(OPS,'AI_Review_Jobs').slice(-1)[0];
ok(deadJob.status==='ERROR' && deadJob.last_error,'AI失敗が再試行上限でERROR（理由記録）');
ok(rows(OPS,'Submission_Versions').find(v=>v.version_id===deadJob.version_id).status==='AI_UNAVAILABLE','版は AI_UNAVAILABLE（提出は消失しない）');
ok(rows(OPS,'Submissions').find(s=>s.submission_id===subAI.submission_id).status==='HUMAN_REVIEW_PENDING','人手審査へ回送');
ok(rows(OPS,'Notification_Queue').some(n=>n.reference_id==='AIERR:'+deadJob.version_id),'人手対応の通知を起票');
geminiResponder=()=>({ overall_result:'PASS_CANDIDATE', findings:[] });

// 42. 報告期限監視（V2-017：契約条件から期限窓を判定・契約×期で1回）
const t42=JSON.parse(rows(OPS,'Contracts').find(c=>c.contract_id===contract.contract_id).terms_snapshot||'{}');
t42.requires_usage_report=true; t42.report_due_days=400;   // テスト実行日に依らず期限窓内にする
G.updateRow_(OPS,'Contracts','contract_id',contract.contract_id,{ signed_at:'2020-01-15', terms_snapshot:JSON.stringify(t42) });
const due42=G.notifyReportDue_();
ok(rows(OPS,'Notification_Queue').some(n=>n.type==='REPORT_REQUEST'&&String(n.reference_id).indexOf(contract.contract_id)===0),'期限窓内の未報告契約へ REPORT_REQUEST 起票');
const due42b=G.notifyReportDue_();
ok(due42b.processed===0,'同一契約×期は重複起票しない');

// ============ 経理連携（SPLL-SYS-AD-001）P0：基盤 ============
// 43. ブートストラップ・スキーマ（§17 M1）
G.setup_accountingBootstrap();
ok(scriptProps.SS_ACCOUNTING_MASTER && scriptProps.SS_ACCOUNTING_CURRENT,'経理マスタ・年度ブック作成＋プロパティ登録');
const ACCM=G.ssAccMaster_(), ACCY=G.ssAccYear_();
ok(rows(ACCM,'Sales_Channels').length===6,'販売チャネル初期値6件（BOOTH/TALTO/DLSITE/BANK_DIRECT/AMBASS/PAPER）');
ok(rows(ACCM,'Accounting_Export_Profiles').length===4,'出力プロファイル初期値4件');
ok(rows(ACCM,'Accounting_Books').some(b=>b.status==='OPEN'),'年度台帳にOPEN登録');
const accBoot2=G.setup_accountingBootstrap();
ok(accBoot2.reused.SS_ACCOUNTING_MASTER && rows(ACCM,'Sales_Channels').length===6,'再実行は再利用・初期値重複なし（冪等）');
ok(ACCY.getSheetByName('Sales_Ledger') && ACCY.getSheetByName('Allocation_Runs'),'年度ブックに取引系シート作成');

// 44. 一括I/O（§8.1）
G.accEnsureSheet_(ACCM,'Bulk_Test',['k','v']);
const bulkMany=[]; for(let bi=0;bi<1234;bi++) bulkMany.push({k:'K'+bi,v:bi});
ok(G.appendRowsBulk_(ACCM,'Bulk_Test',bulkMany,500)===1234,'1,234行を一括追記（chunk 500）');
ok(G.readTableBulk_(ACCM,'Bulk_Test').length===1234,'一括読取りで全行取得');
const up=G.upsertRowsBulk_(ACCM,'Bulk_Test','k',[{k:'K10',v:'upd'},{k:'K-new',v:'new'}]);
ok(up.updated===1 && up.inserted===1,'upsert：更新1・追加1');
ok(G.readTableBulk_(ACCM,'Bulk_Test').find(r=>r.k==='K10').v==='upd','一括更新が反映');
const bulkIdx=G.buildIndex_(G.readTableBulk_(ACCM,'Bulk_Test'),r=>r.k);
ok(bulkIdx['K999'] && bulkIdx['K-new'],'buildIndex_ でキー参照');
G.replaceRowsBulk_(ACCM,'Bulk_Test',[{k:'only',v:1}]);
ok(G.readTableBulk_(ACCM,'Bulk_Test').length===1,'洗い替えで1行（空行はスキップ）');

// 45. Drive原票保存・二重取込防止（§7.5/§15）
const accCsv=G.Utilities.newBlob('a,b\n1,2','text/csv','ピクシブ_Booth_明細書_2026.6.csv');
const accSaved=G.accSaveOriginalFile_('BOOTH',accCsv);
ok(accSaved.drive_file_id && accSaved.file_hash,'原票をDrive保存しSHA-256記録');
G.appendRowsBulk_(ACCY,'Sales_Import_Batches',[{import_batch_id:'IB-DUP',channel_id:'BOOTH',file_hash:accSaved.file_hash,status:'PARSED'}]);
ok(G.accFindBatchByHash_('Sales_Import_Batches',accSaved.file_hash).import_batch_id==='IB-DUP','同一ハッシュの二重取込を検知');
G.upsertRowsBulk_(ACCY,'Sales_Import_Batches','import_batch_id',[{import_batch_id:'IB-DUP',status:'SUPERSEDED'}]);
ok(!G.accFindBatchByHash_('Sales_Import_Batches',accSaved.file_hash),'SUPERSEDED後は再取込可');

// 46. ジョブ基盤（§8.2/§8.3）：カーソル分割・再試行・停滞回復
const realSalesParse=G.accJobSalesParse_;
G.accJobSalesParse_=function(job){ const total=250, next=Math.min(job.cursor+100,total);
  return { done: next>=total, cursor: next, processed: next-job.cursor, total: total }; };
const accJid=G.enqueueAccountingJob_('SALES_PARSE','BATCH-CURSOR',{});
const accJob=()=>rows(ACCM,'Accounting_Jobs').find(x=>x.job_id===accJid);
ok(accJob().status==='QUEUED' && String(accJob().cursor)==='100','1ステップ後にカーソル保存（100）して継続待ち');
G.runAccountingJobs_(); G.runAccountingJobs_();
ok(accJob().status==='DONE' && String(accJob().processed_count)==='250','カーソルから再開して完了（250行）');
G.accJobSalesParse_=function(){ throw new Error('parse fail'); };
const accJid2=G.enqueueAccountingJob_('SALES_PARSE','BATCH-ERR',{});
const accJob2=()=>rows(ACCM,'Accounting_Jobs').find(x=>x.job_id===accJid2);
ok(accJob2().status==='RETRY_WAIT' && accJob2().next_retry_at,'失敗はRETRY_WAIT＋バックオフ時刻');
for(let ri3=0;ri3<6;ri3++){ G.upsertRowsBulk_(ACCM,'Accounting_Jobs','job_id',[{job_id:accJid2,next_retry_at:'2000-01-01T00:00:00.000Z'}]); G.runAccountingJobs_(); }
ok(accJob2().status==='ERROR' && accJob2().last_error,'再試行上限でERROR（理由記録）');
G.accJobSalesParse_=function(job){ return { done:true, cursor:0, processed:1 }; };
const accJid3=G.enqueueAccountingJob_('SALES_PARSE','BATCH-STALE',{});
G.upsertRowsBulk_(ACCM,'Accounting_Jobs','job_id',[{job_id:accJid3,status:'RUNNING',started_at:'2000-01-01T00:00:00.000Z',finished_at:''}]);
G.runAccountingJobs_();
ok(rows(ACCM,'Accounting_Jobs').find(x=>x.job_id===accJid3).status==='DONE','停滞RUNNINGを回復して完了');
let badType=false; try{ G.enqueueAccountingJob_('NOT_A_TYPE','x',{}); }catch(e){ badType=/不正なジョブ種別/.test(String(e.message)); }
ok(badType,'不正なジョブ種別は拒否');
G.accJobSalesParse_=realSalesParse;

// ============ 経理連携 P1：販売原票取込・突合 ============
// 47. パーサー単体（§7）
const taltoText='集計期間,2025/12/01-2025/12/31\n総額,4591\n\n許諾番号,プロジェクトID,作品名,販売数,販売額計,売上計,販売許諾料小計\nSPLL-T0001,PJ-1,作品A,3,3000,2400,300\nSPLL-T0002,PJ-2,作品B,1,"1,000",800,100';
const taltoRes=G.parseSalesFile_(taltoText,{parser_type:'TALTO',channel_id:'TALTO',sales_period:'2025-12'});
ok(taltoRes.rows.length===2 && taltoRes.source_total_amount===400,'TALTO: プリアンブル付きCSVを解析（2件・許諾料400円）');
ok(taltoRes.rows[1].quantity===1 && taltoRes.rows[1].gross_sales_amount===1000,'TALTO: 引用符付き金額を数値化');
const dlText='DLsite作品ID,作品名,SPLL申請番号,販売本数,ライセンス料合計\nRJ001,作品X,SPLL:E107009,10,657\nRJ002,作品Y,SPLL:E108001,5,500';
const dlRes=G.parseSalesFile_(dlText,{parser_type:'DLSITE',channel_id:'DLSITE',sales_period:'2026-05'});
ok(dlRes.rows.length===2 && dlRes.source_total_amount===1157,'DLsite: 2件・許諾料合計1,157円（受入基準の形）');
let hdrErr=false; try{ G.parseSalesFile_(dlText,{parser_type:'BOOTH',channel_id:'BOOTH',sales_period:'2026-05'}); }catch(e){ hdrErr=/一致しません/.test(String(e.message)); }
ok(hdrErr,'ヘッダ不一致は取込停止');
let negAmtErr=false; try{ G.parseSalesFile_('DLsite作品ID,作品名,SPLL申請番号,販売本数,ライセンス料合計\nRJ,X,S,1,-100',{parser_type:'DLSITE'}); }catch(e){ negAmtErr=/負数/.test(String(e.message)); }
ok(negAmtErr,'負数金額は拒否');
ok(G.accNormalizeLicenseRef_('ｓｐｌｌ－ e107009 ')==='SPLL-E107009','SPLL番号正規化（全角・空白・大文字）');
ok(G.accExtractLegacyCode_('E107009')==='107','旧SPLL番号から原作コード抽出（E107009→107）');

// 48. BOOTH取込→突合（License_Identifiers／Legacy_Work_Codes／マッピング）
G.appendRowsBulk_(ACCM,'Legacy_Work_Codes',[{legacy_code:'107',work_id:'WRK-ARK00012',status:'ACTIVE',updated_by:'t',updated_at:'2026-01-01'}]);
G.admin_accountingLinkLicenseRef('REF-LINKED-1', unlinkedC.contract_id);   // 単一原作契約へ紐付け
const boothCsv=['ショップ名,商品番号,商品名,SPLL申請番号,小売価格,数量,BOOST計,売上（税込）,ライセンス料（税込）',
  'ショップA,P-100,狂気山脈シナリオ,E107009,"1,500",2,0,3000,300',
  'ショップB,P-200,インセイン本,REF-LINKED-1,1000,1,100,1100,110',
  'ショップC,P-300,未知の作品,E999001,500,1,0,500,50',
  'ショップD,P-400,番号なし商品,,500,1,0,500,25'].join('\n');
const upRes=G.admin_accountingUploadSalesFile({channelId:'BOOTH',salesPeriod:'2026-06',fileName:'ピクシブ_Booth_明細書_2026.6.csv'},Buffer.from(boothCsv,'utf8').toString('base64'));
ok(upRes.import_batch_id && upRes.file_hash,'BOOTH原票アップロード（原本保存＋ハッシュ）');
let dupUp=false; try{ G.admin_accountingUploadSalesFile({channelId:'BOOTH',salesPeriod:'2026-06',fileName:'x.csv'},Buffer.from(boothCsv,'utf8').toString('base64')); }catch(e){ dupUp=/取込済み/.test(String(e.message)); }
ok(dupUp,'同一内容の二重取込を拒否（§18.2-13）');
const pv=G.admin_accountingPreviewImport(upRes.import_batch_id);
ok(pv.source_row_count===4 && pv.source_total_amount===485,'プレビュー：原票4件・許諾料合計485円');
G.admin_accountingStartImport(upRes.import_batch_id);
let ledger=G.readTableBulk_(ACCY,'Sales_Ledger').filter(r=>r.import_batch_id===upRes.import_batch_id);
ok(ledger.length===4,'Sales_Ledger へ4行を一括正規化');
const batchRow=()=>G.readTableBulk_(ACCY,'Sales_Import_Batches').find(b=>b.import_batch_id===upRes.import_batch_id);
ok(String(batchRow().normalized_total_amount)==='485' && String(batchRow().source_total_amount)==='485','原票合計＝正規化合計（485円）');
ok(batchRow().status==='REVIEW_REQUIRED','未解決ありでREVIEW_REQUIRED');
ok(ledger.find(r=>r.external_license_ref==='E107009').match_status==='MATCHED','旧原作コードで自動突合');
ok(ledger.find(r=>r.external_license_ref==='REF-LINKED-1').match_status==='MATCHED','License_Identifiers→単一原作契約で自動突合');
ok(ledger.find(r=>r.external_license_ref==='E999001').match_status==='REVIEW_REQUIRED','未知の番号は要確認');
ok(ledger.find(r=>!r.external_license_ref).match_status==='UNMATCHED','番号なしはUNMATCHED');
const mres=G.readTableBulk_(ACCY,'Sales_Match_Results');
ok(mres.some(r=>r.match_method==='LEGACY_CODE'&&r.work_id==='WRK-ARK00012'),'突合結果にLEGACY_CODE記録');
ok(mres.some(r=>r.match_method==='CONTRACT_SNAPSHOT'&&r.contract_id===unlinkedC.contract_id&&r.work_id==='WRK-BKK00019'),'突合結果にCONTRACT_SNAPSHOT記録');

// 49. 未解決画面→マッピング保存→再突合（§11.4/§12.2）
const unm=G.admin_accountingListUnmatched({});
ok(unm.length===2,'未解決2グループ（E999001＋番号なし）');
G.admin_accountingSaveMapping({external_license_ref:'E999001',match_scope:'LICENSE_ONLY',works:[{work_id:'WRK-ARK00012',weight:2},{work_id:'WRK-BKK00019',weight:1}]});
let mapErr=false; try{ G.admin_accountingSaveMapping({external_license_ref:'EX',match_scope:'LICENSE_ONLY',works:[{work_id:'WRK-NONE',weight:1}]}); }catch(e){ mapErr=/原作がありません/.test(String(e.message)); }
ok(mapErr,'存在しない原作のマッピングは拒否');
G.admin_accountingRematch(upRes.import_batch_id);
ledger=G.readTableBulk_(ACCY,'Sales_Ledger').filter(r=>r.import_batch_id===upRes.import_batch_id);
ok(ledger.find(r=>r.external_license_ref==='E999001').match_status==='MATCHED','マッピング適用で解決');
const multiRes=G.readTableBulk_(ACCY,'Sales_Match_Results').filter(r=>r.sales_row_id===ledger.find(x=>x.external_license_ref==='E999001').sales_row_id&&r.status==='CONFIRMED');
ok(multiRes.length===2,'複数原作マッピングは原作ごとに結果2行');
ok(G.admin_accountingListUnmatched({}).length===1,'残る未解決は番号なし1グループ');
ok(batchRow().status==='REVIEW_REQUIRED','番号なしが残るためREVIEW_REQUIRED維持');

// 50. 形式不正の取込はバッチERROR（再試行しない）
const badUp=G.admin_accountingUploadSalesFile({channelId:'DLSITE',salesPeriod:'2026-05',fileName:'bad.csv'},Buffer.from(boothCsv+'\n','utf8').toString('base64'));
G.admin_accountingStartImport(badUp.import_batch_id);
const badBatch=G.readTableBulk_(ACCY,'Sales_Import_Batches').find(b=>b.import_batch_id===badUp.import_batch_id);
ok(badBatch.status==='ERROR' && /一致しません/.test(badBatch.error_summary),'ヘッダ不一致はバッチERROR＋理由記録');
ok(rows(ACCM,'Accounting_Jobs').filter(j=>j.target_id===badUp.import_batch_id&&j.job_type==='SALES_PARSE').every(j=>j.status==='DONE'),'形式不正は再試行せずジョブ完了');

console.log('\nSTAGE2 RESULT: '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
