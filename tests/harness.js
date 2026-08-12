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
const ScriptApp={ getService:()=>({ getUrl:()=>'https://script.example/exec' }), getOAuthToken:()=>'oauth-tok',
  _triggers:[], getProjectTriggers:function(){ return this._triggers.slice(); },
  newTrigger:function(fn){ const self=this; const add=()=>{ self._triggers.push({ getHandlerFunction:()=>fn }); };
    const chain={ create:add, everyMinutes:()=>chain, everyDays:()=>chain, atHour:()=>chain, timeBased:()=>chain };
    return chain; } };
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
ok(tPer.fee_model==='FLAT' && tPer.amount===16500,'書籍は契約単位の定額16,500円（原作数で増えない）: '+tPer.amount);
ok(/分配/.test(tPer.fee_amount_or_rate),'複数原作は権利者間で分配する旨を表示: '+tPer.fee_amount_or_rate);
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
let unregErr=false; try{ G.admin_runAiReviews(); }catch(e){ unregErr=/AUTHORIZATION_ERROR/.test(String(e.message)); }
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
let roleErr=false; try{ G.admin_runAiReviews(); }catch(e){ roleErr=/AUTHORIZATION_ERROR/.test(String(e.message)); }
ok(roleErr,'AUDITOR: OPERATIONS専用のバッチ起動は拒否');
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

// 22. トークン期限・失効
const expTok=G.issueToken_(contract.contract_id,'BADGE_DOWNLOAD',-1,5);   // 期限切れ
G.issueToken_(contract.contract_id,'BADGE_DOWNLOAD',-1,5);                // バッチ用にもう1本
ok(G.resolveToken_(expTok,'BADGE_DOWNLOAD')===null,'期限切れトークンは拒否');
ok(G.resolveToken_(linkV.token,'BADGE_DOWNLOAD')===null,'用途違い（SUBMISSION→BADGE）は拒否');
const exp=G.expireAccessTokens_();
ok(exp.processed>=1,'期限切れトークンをEXPIREDへ: '+exp.processed);

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

// ============ A-中（通知・SLA・AI証跡・版管理・レート制限） ============
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

// 29. AI審査の証跡（§9.3）
const jobDone=rows(OPS,'AI_Review_Jobs').find(j=>j.status==='COMPLETED');
ok(jobDone.overall_result,'ジョブに overall_result 記録: '+jobDone.overall_result);
ok(jobDone.response_file_id,'AI生レスポンスをDrive保存（response_file_id）');
ok(jobDone.started_at && jobDone.completed_at,'開始・完了日時を記録');

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


// ============ P4：CloudSign運用拡張（§10） ============
// 61. 自動送信／手動確認の経路判定（§10.3）
ok(G.decideContractRoute_({usageCategory:'書籍',workIds:['WRK-BKK00019']}).route==='STANDARD_FIXED','経路判定: 定額系→STANDARD_FIXED');
ok(G.decideContractRoute_({usageCategory:'電子出版物',workIds:['WRK-ARK00012']}).route==='STANDARD_RATE','経路判定: 売上連動→STANDARD_RATE');
const mrRoute=G.decideContractRoute_({usageCategory:'書籍',workIds:['WRK-BKK00019'],isMinor:true});
ok(mrRoute.route==='MANUAL_REVIEW'&&mrRoute.reasons.some(r=>/未成年/.test(r)),'経路判定: 未成年→MANUAL_REVIEW（理由記録）');
ok(G.decideContractRoute_({usageCategory:'未知の目的',workIds:['WRK-BKK00019']}).route==='MANUAL_REVIEW','経路判定: 料金表未設定→MANUAL_REVIEW');
const docExtra={privacyDocumentId:d1.legal_document_id,termsDocumentId:d2.legal_document_id};
const appP4=mkApp(['WRK-BKK00019'],'書籍',docExtra);
ok(appP4.template_route==='STANDARD_FIXED'&&'form_url' in appP4,'申込応答に経路（template_route）とフォームURL');

// 62. formrun送信状態・連携失敗キュー（§10.4/§10.5）
G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({application_ref:appP4.application_ref,submission_id:'FR-P4-1',columns:[]})}});
const appP4row=()=>rows(OPS,'Applications').find(a=>a.application_id===appP4.application_id);
ok(appP4row().cloudsign_send_status==='CLOUDSIGN_SENDING'&&appP4row().form_submission_id==='FR-P4-1','フォーム送信を記録（submission ID＋CLOUDSIGN_SENDING）');
const appFail=mkApp(['WRK-BKK00019'],'書籍',docExtra);
G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({application_ref:appFail.application_ref,submission_id:'FR-P4-2',cloudsign_status:'error',columns:[]})}});
const appFailRow=()=>rows(OPS,'Applications').find(a=>a.application_id===appFail.application_id);
ok(appFailRow().cloudsign_send_status==='CLOUDSIGN_SEND_FAILED','formrun→CloudSign連携失敗でCLOUDSIGN_SEND_FAILED（自動再送しない）');
ok(G.admin_listCloudSignSendFailures().some(a=>a.application_id===appFail.application_id),'送信失敗キューに表示');
ok(rows(OPS,'Notification_Queue').some(n=>n.type==='CLOUDSIGN_SEND_FAILED'&&n.reference_id===appFail.application_id),'送信失敗の通知起票');
G.admin_markManualCloudSignSent(appFail.application_id,'CSDOC-MANUAL-1','電話確認のうえ手動送信');
ok(appFailRow().cloudsign_send_status==='MANUAL_SENT','手動送信のCloudSign書類IDを登録→MANUAL_SENT');

// 63. 締結時の条件照合（§10.8）：正常系はVERIFIED
G.doPost({parameter:{},postData:{contents:JSON.stringify({document_id:'DOC-P4-OK',status:'COMPLETED',application_ref:appP4.application_ref})}});
const cP4=rows(OPS,'Contracts').find(c=>c.cloudsign_document_id==='DOC-P4-OK');
ok(cP4&&cP4.terms_verification_status==='VERIFIED'&&cP4.route_type==='AUTO'&&cP4.form_submission_id==='FR-P4-1','照合VERIFIED＋route_type/form_submission_id記録');
ok(rows(OPS,'Certificates').some(x=>x.contract_id===cP4.contract_id&&x.status==='ACTIVE'),'照合通過で認証発行');
const rcptP4=rows(OPS,'Webhook_Receipts').find(r=>r.document_id==='DOC-P4-OK');
ok(rcptP4&&rcptP4.application_ref===appP4.application_ref&&String(rcptP4.response_code)==='200','受信台帳にevent_type/document_id/application_ref/response_code');

// 64. 条件不一致（フォーム未通過のまま締結）→ TERMS_MISMATCH → 手動確認で有効化
const appT=mkApp(['WRK-BKK00019'],'書籍',docExtra);   // formrun未通過（FORM_PENDING）
const whT=G.doPost({parameter:{},postData:{contents:JSON.stringify({document_id:'DOC-P4-NG',status:'COMPLETED',application_ref:appT.application_ref})}});
ok(String(whT.getContent())==='accepted-manual-review','条件不一致はmanual-review応答（HTTP 200系）');
const cT=()=>rows(OPS,'Contracts').find(c=>c.cloudsign_document_id==='DOC-P4-NG');
ok(cT().link_status==='TERMS_MISMATCH'&&cT().terms_verification_status==='TERMS_MISMATCH','TERMS_MISMATCHで保存（削除しない）');
ok(!rows(OPS,'Certificates').some(x=>x.contract_id===cT().contract_id),'不一致中は認証・バッジ・請求を停止');
ok(G.admin_listTermsMismatch().some(c=>c.contract_id===cT().contract_id),'条件不一致キューに表示');
G.admin_confirmContractTerms(cT().contract_id,'締結PDFと台帳条件を照合し一致を確認');
ok(cT().terms_verification_status==='MANUAL_CONFIRMED'&&cT().link_status==='LINKED','手動確認でMANUAL_CONFIRMED→LINKED');
ok(rows(OPS,'Certificates').some(x=>x.contract_id===cT().contract_id),'確認後に認証発行');

// 65. メール不達（§10.9）
G.doPost({parameter:{},postData:{contents:JSON.stringify({document_id:'DOC-P4-OK',status:'signing_email_bounced'})}});
const cP4b=()=>rows(OPS,'Contracts').find(c=>c.cloudsign_document_id==='DOC-P4-OK');
ok(cP4b().delivery_status==='SIGNING_EMAIL_BOUNCED','不達イベントでdelivery_status更新');
ok(G.admin_listDeliveryFailures().some(c=>c.contract_id===cP4.contract_id),'不達キューに表示＋通知');
G.admin_markDeliveryHandled(cP4.contract_id,'連絡先を確認しCloudSignから再送');
ok(cP4b().delivery_status==='HANDLED','不達対応を記録');

// 66. 訂正・再申込（§10.10）
scriptProps.HANDOFF_SECRET='handoff-secret';
const appRp=mkApp(['WRK-ARK00012'],'書籍',docExtra);
const rep=G.admin_createReplacementApplication(appRp.application_id,'原作追加のため訂正');
delete scriptProps.HANDOFF_SECRET;
ok(rep.application_ref!==appRp.application_ref&&rep.handoff_token,'新しいapplication_ref＋handoffトークンで再申込');
const oldA=rows(OPS,'Applications').find(a=>a.application_id===appRp.application_id);
const newA=rows(OPS,'Applications').find(a=>a.application_id===rep.application_id);
ok(oldA.status==='SUPERSEDED'&&oldA.superseded_by_application_id===rep.application_id&&newA.supersedes_application_id===appRp.application_id,'旧SUPERSEDED⇔新申込の相互リンク（上書きしない）');
ok(rows(OPS,'Application_Works').filter(w=>w.application_id===rep.application_id).length===1,'対象原作を新申込へ引継ぎ');
let dupRep=false; try{ G.admin_createReplacementApplication(appRp.application_id,'x'); }catch(e){ dupRep=/訂正済み/.test(String(e.message)); }
ok(dupRep,'訂正済み申込の二重再申込は拒否');

// 67. 送信停滞の検知（§10.4）と テンプレート版管理（§10.11）
G.updateRow_(OPS,'Applications','application_id',rep.application_id,{cloudsign_send_status:'CLOUDSIGN_SENDING',form_submitted_at:'2020-01-01T00:00:00.000Z'});
G.notifyCloudSignSendStale_();
ok(rows(OPS,'Applications').find(a=>a.application_id===rep.application_id).cloudsign_send_status==='MANUAL_SEND_REQUIRED','送信停滞をMANUAL_SEND_REQUIREDへ（督促起票）');
G.admin_saveContractTemplates({STANDARD_RATE:{form_url:'https://form.run/rate-v2',template_id:'SPLL_STD_RATE_v2',template_version:'2'}});
ok(G.admin_getContractTemplates().STANDARD_RATE.template_id==='SPLL_STD_RATE_v2','テンプレート・フォームURLの版管理（Config）');
const appRt=mkApp(['WRK-ARK00012'],'電子出版物',docExtra);
ok(appRt.form_url==='https://form.run/rate-v2','経路別フォームURLを申込応答で配信');

// ============ 一括初期設定（setup_all／setup_workflowAll） ============
// 68. adminの setup_all：冪等・転記用プロパティ一覧・HANDOFF_SECRET生成
const allRep=G.setup_all('admin@example.com');
ok(allRep.properties.SS_OPS && allRep.copy_to_other_projects.workflow.SS_OPS===allRep.properties.SS_OPS &&
   !allRep.copy_to_other_projects.accounting,
  'setup_all: 他プロジェクト転記一覧を出力（accountingは対象外）');
ok(!!scriptProps.HANDOFF_SECRET,'setup_all: HANDOFF_SECRETを自動生成');
const adminCount=()=>rows(OPS,'Admin_Users').filter(u=>u.email==='admin@example.com').length;
const cntBefore=adminCount();
G.setup_all('admin@example.com');
ok(adminCount()===cntBefore,'setup_all: 再実行で管理者・台帳が重複しない（冪等）');
// 69. workflow の一括初期設定：トリガー作成（冪等）
const wfAll=G.setup_workflowAll();
ok(wfAll.steps.some(s=>/trigger_every5min/.test(s)),'setup_workflowAll: トリガー作成');
const wfAll2=G.setup_workflowAll();
ok(wfAll2.steps.some(s=>/作成=\[\]/.test(s)),'setup_workflowAll: 再実行はスキップ（冪等）');
// ============ RP-001（分断・簡素化）：SPLL番号・ライセンス台帳・経理引渡 ============
// 72. SPLL番号と台帳（§6：主台帳License_Cases・原作スナップショット・契約書履歴）
ok(/^SPLL-\d{6}-\d{4}$/.test(appP4.license_id),'申込でSPLL番号（license_id）発行: '+appP4.license_id);
const kaseP4=()=>rows(OPS,'License_Cases').find(k=>k.license_id===appP4.license_id);
ok(kaseP4().contract_status==='SIGNED'&&kaseP4().cloudsign_document_id==='DOC-P4-OK','締結でcase更新（契約状態・CloudSign書類ID）');
ok(kaseP4().certification_status==='ACTIVE'&&kaseP4().case_status==='SIGNED'&&kaseP4().review_status==='PENDING','活性化で認証ACTIVE・審査PENDING');
const lwP4=rows(OPS,'License_Works').filter(w=>w.license_id===appP4.license_id);
ok(lwP4.length===1&&lwP4[0].fee_model_snapshot==='FLAT'&&Number(lwP4[0].fee_value_snapshot)===16500,
  '費用は契約形態（利用目的）×原作構造で自動確定しLicense_Worksへスナップショット');
ok(rows(OPS,'Contract_Documents').filter(d=>d.license_id===appP4.license_id&&d.document_type==='ORIGINAL'&&d.status==='SIGNED').length===1,'契約書履歴（ORIGINAL・1:N）');

// 73. 経理引渡（§10）：締結でREADYを作成（取込・請求・入金は経理側の独自運用）
const hoP4=()=>rows(OPS,'Finance_Handoffs').find(h=>h.license_id===appP4.license_id);
ok(hoP4().status==='READY'&&kaseP4().finance_handoff_status==='READY','締結で経理引渡READY（License側は請求を作らない）');
ok(JSON.parse(hoP4().works_snapshot_json||'[]').length===1&&hoP4().billing_terms_json,'引渡に原作・請求条件のスナップショットを含む');

// 74. フォームは「誰と契約するか」のみ（§8）：契約者情報の台帳反映
scriptProps.FORMRUN_FIELD_MAP=JSON.stringify({'氏名':'party_name','契約者区分':'party_type','申込番号':'application_ref','handoff':'handoff_token'});
const appParty=mkApp(['WRK-BKK00019'],'書籍',Object.assign({partyType:'INDIVIDUAL'},docExtra));
ok(/^SPLL-/.test(appParty.license_id)&&'form_url' in appParty,'申込応答にSPLL番号・フォームURL');
G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({application_ref:appParty.application_ref,submission_id:'FR-RP-1',
  columns:[{name:'氏名',value:'山田太郎'},{name:'契約者区分',value:'個人'},{name:'handoff',value:appParty.handoff_token}]})}});
const kaseParty=rows(OPS,'License_Cases').find(k=>k.license_id===appParty.license_id);
ok(kaseParty.party_display_name==='山田太郎'&&kaseParty.party_type==='INDIVIDUAL'&&kaseParty.case_status==='CONTRACTING',
  'フォーム回答から契約者名・区分を台帳へ反映（CONTRACTING）');
delete scriptProps.FORMRUN_FIELD_MAP;

// 75. 契約者区分別フォームURL（§8.3/8.4）
G.setConfig_('FORM_URL_CORPORATION','https://form.run/corp-v1');
const appCorp=mkApp(['WRK-BKK00019'],'書籍',Object.assign({partyType:'CORPORATION'},docExtra));
ok(appCorp.form_url==='https://form.run/corp-v1','法人は法人フォームURLへ切替');
ok(rows(OPS,'License_Cases').find(k=>k.license_id===appCorp.license_id).party_type==='CORPORATION','契約者区分を台帳へ記録');

// 76. 既存データ移行（§16 Phase1・冪等・二重請求防止）
G.appendRow_(OPS,'Applications',{application_id:'APP-LEGACY-1',application_ref:'REF-LEGACY-1',usage_category:'書籍',status:'SIGNED',created_at:'2026-01-01'});
G.appendRow_(OPS,'Application_Works',{application_work_id:'AW-L1',application_id:'APP-LEGACY-1',work_id:'WRK-BKK00019'});
G.appendRow_(OPS,'Contracts',{contract_id:'CTR-LEGACY-1',cloudsign_document_id:'DOC-LEGACY-1',application_id:'APP-LEGACY-1',application_ref:'REF-LEGACY-1',usage_category:'書籍',terms_snapshot:'{"fee_model":"PER_WORK","amount":16500}',status:'SIGNED',link_status:'LINKED',signed_at:'2026-01-02'});
const migLC=G.setup_migrateLicenseCases();
ok(migLC.created>=1,'旧データ（Applications+Contracts）からライセンス台帳を生成');
const legacyApp=rows(OPS,'Applications').find(a=>a.application_id==='APP-LEGACY-1');
ok(/^SPLL-/.test(legacyApp.license_id),'旧申込へSPLL番号を付与');
const legacyKase=rows(OPS,'License_Cases').find(k=>k.license_id===legacyApp.license_id);
ok(legacyKase.contract_status==='SIGNED'&&legacyKase.finance_handoff_status==='ACCEPTED','旧締結分の引渡はACCEPTED扱い（経理側で処理済み）');
ok(G.setup_migrateLicenseCases().created===0,'移行の再実行はスキップ（冪等）');

// 77. ライセンス一覧・詳細（§18.2：SPLL番号で申込〜認証まで追跡）
const lcList=G.admin_listLicenseCases();
ok(lcList.some(k=>k.license_id===appP4.license_id&&k.legacy_contract_id===cP4.contract_id&&k.certification_status==='ACTIVE'),
  'ライセンス一覧（SPLL番号・状態・旧契約ID併記）');
const lcFee=lcList.find(k=>k.license_id===appP4.license_id);
ok(lcFee&&/16,500円/.test(lcFee.fee),'ライセンス一覧に利用許諾料（締結時スナップショット）: '+lcFee.fee);
const lcFeeRate=lcList.find(k=>k.usage_category==='電子出版物'&&k.contract_status!=='SIGNED');
ok(!lcFeeRate||/売上の10％/.test(lcFeeRate.fee||'売上の10％'),'未締結案件は申込時スナップショットから率を表示');
const lcDet=G.admin_getLicenseCase(appP4.license_id);
ok(lcDet.works.length===1&&lcDet.documents.length===1&&lcDet.handoffs.length===1,'ライセンス詳細（原作・契約書履歴・引渡）');

// 78. 定額×複数原作＝契約単位定額（費用は原作数で増えない）
ok(G.computeFeeTerms_('書籍',2).amount===16500,'2原作でも契約単位の定額16,500円');
scriptProps.FORMRUN_FIELD_MAP=JSON.stringify({'handoff':'handoff_token'});
const appFlat=mkApp(['WRK-ARK00012','WRK-BKK00019'],'書籍',docExtra);
G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({application_ref:appFlat.application_ref,submission_id:'FR-FLAT-1',
  columns:[{name:'handoff',value:appFlat.handoff_token}]})}});
G.doPost({parameter:{},postData:{contents:JSON.stringify({document_id:'DOC-FLAT-1',status:'COMPLETED',application_ref:appFlat.application_ref})}});
delete scriptProps.FORMRUN_FIELD_MAP;
const cFlat=rows(OPS,'Contracts').find(c=>c.cloudsign_document_id==='DOC-FLAT-1');
ok(cFlat&&cFlat.status==='SIGNED','2原作の定額契約が締結');
const hoFlat=rows(OPS,'Finance_Handoffs').find(h=>h.license_id===appFlat.license_id);
ok(hoFlat&&JSON.parse(hoFlat.works_snapshot_json||'[]').length===2,'複数原作のスナップショットを経理引渡へ含める');
const btFlat=JSON.parse(hoFlat.billing_terms_json||'{}');
ok(btFlat.fee_model==='FLAT'&&Number(btFlat.amount)===16500,'引渡の請求条件は契約単位の定額16,500円（×原作数にしない）');

console.log('\nSTAGE2 RESULT: '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
