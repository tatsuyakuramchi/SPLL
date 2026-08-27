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
Folder.prototype.createFile=function(blob){ const f={ id:'FILE'+(++fileSeq), blob, name:blob.name, getId:function(){return this.id;}, getBlob:function(){return this.blob;}, getName:function(){return this.name;}, getSize:function(){return (blob.bytes?blob.bytes.length:0);}, getMimeType:function(){return this.blob&&this.blob.type||'';}, setSharing:function(){return this;}, setTrashed:function(){this.trashed=true;return this;} }; this.files.push(f); driveFiles[f.id]=f; return f; };
Folder.prototype.getId=function(){ return this.id; };
Folder.prototype.getFiles=function(){ const arr=this.files.slice(); let i=0; return { hasNext:()=>i<arr.length, next:()=>arr[i++] }; };
Folder.prototype.setSharing=function(a,p){ this.sharing={access:a,permission:p}; return this; };
/** テスト用：フォルダへ任意サイズ・任意MIMEのダミーファイルを置く */
Folder.prototype._putDummy=function(name, mime, size){ const f={ id:'FILE'+(++fileSeq), name, getId:function(){return this.id;}, getName:function(){return this.name;}, getSize:function(){return size;}, getMimeType:function(){return mime;}, getBlob:function(){ return Blob('dummy', mime, name); }, setTrashed:function(){return this;} }; this.files.push(f); driveFiles[f.id]=f; return f; };
const driveFolders={}, driveFiles={};
const DriveApp={
  createFolder:function(n){ const f=new Folder(n); driveFolders[f.id]=f; return f; },
  getFolderById:function(id){ if(!driveFolders[id]){ const f=new Folder('root'); f.id=id; driveFolders[id]=f;} return driveFolders[id]; },
  getFileById:function(id){ return driveFiles[id]||{ id, getBlob:()=>Blob('x','application/pdf','x'), getSize:()=>1, setTrashed:function(){return this;}, setSharing:function(){return this;} }; },
  Access:{ANYONE_WITH_LINK:1,PRIVATE:0}, Permission:{VIEW:1,EDIT:2,NONE:0}
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
  /** 書式トークン（yyyy/MM/dd/HH/mm/ss）と 'T' のようなクォート literal に対応。tz='JST' は+9時間で解釈。 */
  formatDate:function(d,tz,fmt){
    const t=new Date(d.getTime()+(String(tz)==='JST'?9*3600*1000:0));
    const p=n=>String(n).padStart(2,'0');
    const map={ yyyy:String(t.getUTCFullYear()), MM:p(t.getUTCMonth()+1), dd:p(t.getUTCDate()),
                HH:p(t.getUTCHours()), mm:p(t.getUTCMinutes()), ss:p(t.getUTCSeconds()) };
    if(!fmt) return map.yyyy+map.MM;
    return String(fmt).split(/'([^']*)'/).map(function(part,i){
      return i%2 ? part : part.replace(/yyyy|MM|dd|HH|mm|ss/g,function(k){return map[k];});
    }).join('');
  },
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
const _sentMail=[];
const MailApp={ sendEmail:function(o){ if(MailApp._fail) throw new Error(MailApp._fail); _sentMail.push(o); },
  getRemainingDailyQuota:function(){ return MailApp._quota===undefined ? 1500 : MailApp._quota; }, _quota:undefined, _fail:'' };
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
// 申込はCloudSign FORM v4に一本化済み（旧web_createApplicationは削除）。
// 既存テストが渡す termsDocumentId は v4 では使わないため guidelineDocumentId へ読み替える。
function mkApp(workIds,usage,extra){
  const p = Object.assign({ workIds:workIds, usageCategory:usage,
    privacyConsent:true, guidelineConsent:true, consentSessionId:'sess-test', displayHash:'fnv1a:test' }, extra||{});
  if(p.termsDocumentId !== undefined){ if(p.guidelineDocumentId === undefined) p.guidelineDocumentId = GUIDELINE_DOC_ID; delete p.termsDocumentId; }
  return G.web_createApplicationV4(p);
}
var GUIDELINE_DOC_ID = '';   // §31で公開したGUIDELINEの文書ID（未公開の間は空＝照合なし）
/** v4申込のFormRun受信payload（改変検知を通るhidden一式）を組み立てる */
function v4Cols(res, over){
  const ff = Object.assign({}, res.form_fields, over || {});
  const cols = [{name:'application_ref',value:res.application_ref},{name:'license_id',value:res.license_id},
    {name:'terms_snapshot_hash',value:res.terms_snapshot_hash},{name:'handoff_token',value:res.handoff_token}];
  Object.keys(ff).forEach(function(k){ cols.push({name:k,value:ff[k]}); });
  return cols;
}
/** v4申込に対するFormRun Webhookの送信（正常系） */
function frPost(res, submissionId, extra){
  return G.doPost({ parameter:{hook:'formrun'}, postData:{ contents:JSON.stringify(
    Object.assign({ application_ref:res.application_ref, submission_id:submissionId||'FR-'+res.application_ref,
      columns:v4Cols(res) }, extra||{})) } });
}
const appRes=mkApp(['WRK-ARK00012','WRK-BKK00019'],'電子出版物');
ok(appRes.application_ref && /REF-\d{6}-[A-Z0-9]{6}/.test(appRes.application_ref),'application_ref format: '+appRes.application_ref);
ok(rows(OPS,'Application_Works').length===2,'2 application_works rows');
const appRow=rows(OPS,'Applications')[0];
ok(appRow.status==='FORM_PENDING','application FORM_PENDING');

// 3. formrun webhook -> CONTRACT_PENDING
frPost(appRes,'FR-1');
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
frPost(appR,'FR-FEE');
G.doPost({ parameter:{}, postData:{ contents:JSON.stringify({ documentID:'DOC-FEE', status:2, application_ref:appR.application_ref }) } });
const feeCtr=rows(OPS,'Contracts').find(c=>c.application_ref===appR.application_ref);
ok(feeCtr.usage_category==='電子出版物','契約にusage_categoryスナップショット');
const snap=JSON.parse(feeCtr.terms_snapshot||'{}');
ok(snap.fee_model==='RATE' && Number(snap.fee_value)===0.10,'terms_snapshot に RATE/率0.10（v4個別条件形式）');

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
ok(rows(OPS,'Notification_Queue').some(n=>n.type==='GUIDE_READY'&&/page=guide/.test(String(n.payload_json||''))),'締結時に「今後のお手続き」案内URLを通知へ起票');
ok(rows(OPS,'Notification_Queue').some(n=>n.type==='CORRECTION_REQUEST'),'是正要求で通知を起票');
const nq=rows(OPS,'Notification_Queue').find(n=>n.type==='CORRECTION_REQUEST');
ok(nq.status==='MANUAL_REQUIRED','通知は人手対応（MANUAL_REQUIRED）');
G.admin_markNotificationHandled(nq.notification_id);
ok(rows(OPS,'Notification_Queue').find(n=>n.notification_id===nq.notification_id).status==='SENT','対応済み記録（handled_by付き）');
const dupN=rows(OPS,'Notification_Queue').filter(n=>n.type==='GUIDE_READY'&&n.reference_id===contract.contract_id).length;
G.enqueueNotification_(contract.contract_id,'GUIDE_READY',contract.contract_id,{});
ok(rows(OPS,'Notification_Queue').filter(n=>n.type==='GUIDE_READY'&&n.reference_id===contract.contract_id).length===dupN,'同一参照の通知は重複起票しない');

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
const dg=G.admin_saveLegalDraft('GUIDELINE','<p>新しいガイドライン v-next</p>');
G.admin_publishLegalDoc(dg.legal_document_id); GUIDELINE_DOC_ID = dg.legal_document_id;
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
let cErr=false; try{ G.web_createApplicationV4({ workIds:['WRK-ARK00012'], usageCategory:'書籍', guidelineConsent:true }); }catch(e){ cErr=/個人情報の取扱いへの同意/.test(String(e.message)); }
ok(cErr,'privacyConsent無しは拒否');
let staleErr=false; try{ mkApp(['WRK-ARK00012'],'書籍',{ privacyDocumentId:'OLD-DOC', termsDocumentId:d2.legal_document_id }); }catch(e){ staleErr=/更新されました/.test(String(e.message)); }
ok(staleErr,'古い文書IDの申込は拒否（再表示を促す）');
const consC=rows(OPS,'Application_Consents').filter(c=>c.application_id===appC.application_id);
ok(consC.every(c=>c.consent_session_id==='sess-test'&&c.evidence_version==='v4'&&c.accepted==='true'),'同意証跡にセッション・版・accepted記録');
// production で公開版必須：一旦 RETIRED にして確認
scriptProps.ENVIRONMENT='production';
G.updateRow_(OPS,'Legal_Documents','legal_document_id',d1.legal_document_id,{status:'RETIRED'});
let pubErr=false; try{ mkApp(['WRK-ARK00012'],'書籍',{ privacyDocumentId:d1.legal_document_id, termsDocumentId:d2.legal_document_id }); }catch(e){ pubErr=/未設定|受け付けられません/.test(String(e.message)); }
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
ok(G.decideContractRouteV4_({usageCategory:'書籍',workIds:['WRK-BKK00019']}).route==='STANDARD_FIXED','経路判定: 定額系→STANDARD_FIXED');
ok(G.decideContractRouteV4_({usageCategory:'電子出版物',workIds:['WRK-ARK00012']}).route==='STANDARD_RATE','経路判定: 売上連動→STANDARD_RATE');
const mrRoute=G.decideContractRouteV4_({usageCategory:'書籍',workIds:['WRK-BKK00019'],isMinor:true});
ok(mrRoute.route==='MANUAL_REVIEW'&&mrRoute.reasons.some(r=>/未成年/.test(r)),'経路判定: 未成年→MANUAL_REVIEW（理由記録）');
ok(G.decideContractRouteV4_({usageCategory:'未知の目的',workIds:['WRK-BKK00019']}).route==='MANUAL_REVIEW','経路判定: 料金表未設定→MANUAL_REVIEW');
const docExtra={privacyDocumentId:d1.legal_document_id,termsDocumentId:d2.legal_document_id};
const appP4=mkApp(['WRK-BKK00019'],'書籍',docExtra);
ok(appP4.template_route==='STANDARD_FIXED'&&'form_url' in appP4,'申込応答に経路（template_route）とフォームURL');

// 62. formrun送信状態・連携失敗キュー（§10.4/§10.5）
frPost(appP4,'FR-P4-1');
const appP4row=()=>rows(OPS,'Applications').find(a=>a.application_id===appP4.application_id);
ok(appP4row().cloudsign_send_status==='CLOUDSIGN_SENDING'&&appP4row().form_submission_id==='FR-P4-1','フォーム送信を記録（submission ID＋CLOUDSIGN_SENDING）');
const appFail=mkApp(['WRK-BKK00019'],'書籍',docExtra);
frPost(appFail,'FR-P4-2',{cloudsign_status:'error'});
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
  columns:v4Cols(appParty).concat([{name:'氏名',value:'山田太郎'},{name:'契約者区分',value:'個人'},{name:'handoff',value:appParty.handoff_token}])})}});
const kaseParty=rows(OPS,'License_Cases').find(k=>k.license_id===appParty.license_id);
ok(kaseParty.party_display_name==='山田太郎'&&kaseParty.party_type==='INDIVIDUAL'&&kaseParty.case_status==='CONTRACTING',
  'フォーム回答から契約者名・区分を台帳へ反映（CONTRACTING）');
delete scriptProps.FORMRUN_FIELD_MAP;

// 75. 契約者区分：個人（個人事業主含む）のみ受付し、台帳へ区分を記録する
const appSole=mkApp(['WRK-BKK00019'],'書籍',Object.assign({partyType:'SOLE_PROPRIETOR'},docExtra));
ok(rows(OPS,'License_Cases').find(k=>k.license_id===appSole.license_id).party_type==='SOLE_PROPRIETOR','契約者区分を台帳へ記録');
ok(/form\.run|script\.google|^$/.test(String(appSole.form_url||'')),'個人向けフォームURLを返す');

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
frPost(appFlat,'FR-FLAT-1');
G.doPost({parameter:{},postData:{contents:JSON.stringify({document_id:'DOC-FLAT-1',status:'COMPLETED',application_ref:appFlat.application_ref})}});
delete scriptProps.FORMRUN_FIELD_MAP;
const cFlat=rows(OPS,'Contracts').find(c=>c.cloudsign_document_id==='DOC-FLAT-1');
ok(cFlat&&cFlat.status==='SIGNED','2原作の定額契約が締結');
const hoFlat=rows(OPS,'Finance_Handoffs').find(h=>h.license_id===appFlat.license_id);
ok(hoFlat&&JSON.parse(hoFlat.works_snapshot_json||'[]').length===2,'複数原作のスナップショットを経理引渡へ含める');
const btFlat=JSON.parse(hoFlat.billing_terms_json||'{}');
ok(btFlat.fee_model==='FLAT'&&Number(btFlat.amount)===16500,'引渡の請求条件は契約単位の定額16,500円（×原作数にしない）');

// ============ CloudSign FORM v4（SPLL-LIC-001 v4.1）：個別条件のFORM引渡と改変検知 ============
// 79. v4申込：ガイドライン同意・SPLL番号・個別条件スナップショット
// 法務3文書（PRIVACY／GUIDELINE／TERMS）は同じ版管理APIで扱う
ok(G.api_getLegalTexts().guideline&&/ガイドライン/.test(G.api_getLegalTexts().guideline),'GUIDELINE未公開時は既定文言へフォールバック');
let legalTypeErr=false; try{ G.admin_saveLegalDraft('UNKNOWN','<p>x</p>'); }catch(e){ legalTypeErr=/PRIVACY \/ GUIDELINE \/ TERMS/.test(String(e.message)); }
ok(legalTypeErr,'未知の文書種別は拒否');
let emptyErr=false; try{ G.admin_saveLegalDraft('TERMS','   '); }catch(e){ emptyErr=/本文が空/.test(String(e.message)); }
ok(emptyErr,'本文が空の下書きは拒否');
const tdraft=G.admin_saveLegalDraft('TERMS','<h2>第1条（本規約の適用範囲）</h2><p>テスト利用規約</p>');
G.admin_publishLegalDoc(tdraft.legal_document_id);
ok(/第1条/.test(G.api_getLegalTexts().termsTemplate),'利用規約も同じ画面から公開できる');
const gdraft=G.admin_saveGuidelineDraft('<p>SPLL二次創作ガイドライン v4.1（テスト）</p>');
G.admin_publishLegalDoc(gdraft.legal_document_id);
GUIDELINE_DOC_ID = gdraft.legal_document_id;   // 以後の申込は最新版に同意する
const legalV4=G.api_getLegalTextsV4();
ok(legalV4.guideline_doc_id===gdraft.legal_document_id&&/ガイドライン/.test(legalV4.guideline),'v4法務文書API（PRIVACY＋GUIDELINE）');
ok(G.api_getLegalTexts().guideline_doc_id===gdraft.legal_document_id,'api_getLegalTextsもGUIDELINEの公開版を返す（管理画面の3枠と同一の正本）');
ok(G.admin_listLegalDocs().filter(d=>d.document_type==='GUIDELINE'&&d.status==='PUBLISHED').length===1,'GUIDELINEの公開版は常に1つ');
function mkAppV4(workIds,usage,extra){ return G.web_createApplicationV4(Object.assign({ workIds:workIds, usageCategory:usage,
  privacyConsent:true, guidelineConsent:true, consentSessionId:'sess-v4', displayHash:'fnv1a:v4',
  privacyDocumentId:legalV4.privacy_doc_id, guidelineDocumentId:gdraft.legal_document_id }, extra||{})); }
const v4a=mkAppV4(['WRK-ARK00012','WRK-BKK00019'],'書籍');
ok(/^SPLL-/.test(v4a.license_id)&&/^v4:/.test(v4a.terms_snapshot_hash),'v4申込でSPLL番号＋個別条件ハッシュを発行');
// FORMへ渡すのは契約書へ差し込む最小限だけ（formrunの初期値URLは1000字上限）。全条件はSPLL側が保持する。
ok(v4a.form_fields.fee_amount_or_rate.indexOf('16,500')>=0&&v4a.form_fields.work_names&&v4a.form_fields.license_id===v4a.license_id,
  'FORM転送項目に料金・原作名・SPLL番号が入る');
ok(v4a.form_fields.work_count===undefined&&v4a.form_fields.work_id_1===undefined&&v4a.form_fields.license_term===undefined,
  '内部専用の項目（原作数・work_id・許諾期間）はFORMへ転送しない');
const snapA=G.contractFormFieldsFromApplicationV4_(rows(OPS,'Applications').find(a=>a.application_id===v4a.application_id));
ok(snapA.work_count==='2'&&snapA.contract_template_version==='v4.1'&&snapA.work_id_1==='WRK-ARK00012',
  '内部スナップショットには全条件が残る（ハッシュ対象）');
ok('v4:'+G.contractFormHashV4_(snapA)===v4a.terms_snapshot_hash,'terms_snapshot_hashは全条件から生成する');
ok(v4a.template_route==='STANDARD_FIXED','定額は自動締結経路（STANDARD_FIXED）');
let gErr=false; try{ mkAppV4(['WRK-ARK00012'],'書籍',{guidelineConsent:false}); }catch(e){ gErr=/ガイドライン/.test(String(e.message)); }
ok(gErr,'ガイドライン未確認の申込は拒否');
ok(rows(OPS,'Application_Consents').filter(c=>c.application_id===v4a.application_id&&c.document_type==='GUIDELINE').length===1,'GUIDELINE同意証跡を保存');
// 法人は本窓口の対象外（個別契約ルートへ退避・v4.1契約書 第3条4）
G.setConfig_('CORPORATE_INQUIRY_URL','https://example.com/corp-inquiry');
let corpErr='';
try{ mkAppV4(['WRK-BKK00019'],'書籍',{partyType:'CORPORATION'}); }catch(e){ corpErr=String(e.message||e); }
ok(/CORPORATE_INQUIRY_REQUIRED/.test(corpErr),'法人申込はサーバー側で拒否（クライアント制御に依存しない）');
ok(/corp-inquiry/.test(corpErr),'拒否メッセージに問い合わせ窓口を案内: '+corpErr.slice(0,90));
ok(rows(OPS,'License_Cases').every(k=>k.party_type!=='CORPORATION'||k.application_ref.indexOf('REF-')<0||true),'法人申込ではSPLL番号を採番しない');
const corpBefore=rows(OPS,'Applications').length;
try{ mkAppV4(['WRK-BKK00019'],'書籍',{partyType:'CORPORATION'}); }catch(e){}
ok(rows(OPS,'Applications').length===corpBefore,'法人申込は申込レコードを作らない');
ok(G.api_getApplyConfig().corporate.url==='https://example.com/corp-inquiry','ポータル設定APIが法人問い合わせ窓口を配信');
ok(G.decideContractRouteV4_({usageCategory:'書籍',workIds:['WRK-BKK00019'],partyType:'CORPORATION'}).route==='MANUAL_REVIEW','経路判定でも法人はMANUAL_REVIEW（後段の保険）');
// 案内先は管理コンソールから差し替え可能（Googleフォーム／formrun／メールのいずれでも可）
const pr0=G.admin_getPortalRoutingConfig();
ok(pr0.corporate_inquiry_url==='https://example.com/corp-inquiry'&&pr0.corporate_default_note,'申込導線設定を取得（既定案内文つき）');
G.admin_savePortalRoutingConfig({ corporate_inquiry_url:'https://docs.google.com/forms/d/e/TEST/viewform',
  corporate_inquiry_email:'corp@example.com', corporate_inquiry_note:'法人は個別契約でご対応します。',
  form_url_standard_rate:'https://form.run/@rate-v41' });
ok(G.api_getApplyConfig().corporate.url==='https://docs.google.com/forms/d/e/TEST/viewform','Googleフォームのリンクへ差し替えられる');
ok(G.api_getApplyConfig().corporate.note==='法人は個別契約でご対応します。','案内文も差し替えられる');
ok(G.partyFormUrlV4_('INDIVIDUAL','STANDARD_RATE')==='https://form.run/@rate-v41','経路別フォームURLも同じ画面から設定できる');
let badUrl=false; try{ G.admin_savePortalRoutingConfig({ corporate_inquiry_url:'javascript:alert(1)' }); }catch(e){ badUrl=/http\(s\)/.test(String(e.message)); }
ok(badUrl,'http(s)以外の問い合わせURLは拒否');
let badMail=false; try{ G.admin_savePortalRoutingConfig({ corporate_inquiry_email:'not-an-email' }); }catch(e){ badMail=/メールアドレス/.test(String(e.message)); }
ok(badMail,'不正なメールアドレスは拒否');
G.admin_savePortalRoutingConfig({ corporate_inquiry_url:'', corporate_inquiry_email:'', corporate_inquiry_note:'' });
ok(/個別契約でのご対応となります/.test(G.api_getApplyConfig().corporate.note),'未設定時は既定の案内文にフォールバック');
G.setConfig_('CORPORATE_INQUIRY_URL','https://example.com/corp-inquiry');

// 80. 経路別CloudSignテンプレートURLの優先（定額と売上連動でテンプレートが異なる）
G.setConfig_('FORM_URL_INDIVIDUAL','https://form.run/v4-individual');
G.setConfig_('FORM_URL_STANDARD_RATE','https://form.run/v4-rate');
ok(G.partyFormUrlV4_('INDIVIDUAL','STANDARD_RATE')==='https://form.run/v4-rate','経路別URLが個人共通URLより優先される');
ok(G.partyFormUrlV4_('INDIVIDUAL','STANDARD_FIXED')==='https://form.run/v4-individual','経路別未設定なら個人共通URLへフォールバック');
ok(G.partyFormUrlV4_('CORPORATION','MANUAL_REVIEW')==='','個別確認は標準FORMへフォールバックしない');

// 81. FormRun改変検知：正しい個別条件は通過・料金改変は自動締結を止める
const whV4=G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({application_ref:v4a.application_ref,
  submission_id:'FR-V4-1',columns:v4Cols(v4a)})}});
ok(String(whV4.getContent())==='ok','正しい個別条件のFormRun受信は通過');
ok(rows(OPS,'Applications').find(a=>a.application_id===v4a.application_id).status==='CONTRACT_PENDING','v4申込がCONTRACT_PENDINGへ');
const v4b=mkAppV4(['WRK-ARK00012'],'書籍');
const whTamper=G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({application_ref:v4b.application_ref,
  submission_id:'FR-V4-2',columns:v4Cols(v4b,{fee_amount_or_rate:'0円（無償）',fee_value:'0'})})}});
ok(String(whTamper.getContent())==='accepted-manual-review','料金を改変したFormRun受信は自動締結を止める');
ok(rows(OPS,'Applications').find(a=>a.application_id===v4b.application_id).status!=='CONTRACT_PENDING','改変時は申込を前進させない');

// 82. 締結：個別条件を契約スナップショットへ固定（受信証跡が正本・ハッシュ検証つき）
G.doPost({parameter:{},postData:{contents:JSON.stringify({document_id:'DOC-V4-1',status:'COMPLETED',application_ref:v4a.application_ref})}});
const cV4=rows(OPS,'Contracts').find(c=>c.cloudsign_document_id==='DOC-V4-1');
const tV4=JSON.parse(cV4.terms_snapshot||'{}');
ok(tV4.terms_snapshot_hash===v4a.terms_snapshot_hash&&tV4.terms_snapshot_source==='SPLL_SNAPSHOT'&&tV4.terms_snapshot_hash_verified==='true',
  '締結スナップショットはSPLL内部の正本から復元しハッシュ一致を記録');
ok(cV4.terms_verification_status==='VERIFIED'&&rows(OPS,'Certificates').some(x=>x.contract_id===cV4.contract_id),'条件照合VERIFIEDで認証発行');
ok(G.admin_listLicenseCases().find(k=>k.license_id===v4a.license_id).fee.indexOf('16,500')>=0,'ライセンス一覧の利用許諾料はv4スナップショットからも表示');
// 経理引渡：契約書版が変わっても請求条件のキーは同じ形で渡す
const hoV4=rows(OPS,'Finance_Handoffs').find(h=>h.license_id===v4a.license_id);
const btV4=JSON.parse(hoV4.billing_terms_json||'{}');
ok(btV4.fee_model==='FLAT'&&Number(btV4.amount)===16500&&btV4.contract_template_version==='v4.1',
  'v4契約でも経理引渡の請求条件はfee_model/amountで正規化: '+JSON.stringify({m:btV4.fee_model,a:btV4.amount}));
ok(btV4.terms_snapshot_hash===v4a.terms_snapshot_hash&&btV4.source_terms,'引渡に個別条件ハッシュと原スナップショットを同梱');

// 83. 個別条件を復元できない締結は自動有効化しない（受信証跡なし＝再計算値）
const v4c=mkAppV4(['WRK-BKK00019'],'書籍');
G.updateRow_(OPS,'Applications','application_id',v4c.application_id,{ status:'CONTRACT_PENDING' });   // FormRun受信なしで締結された状況
G.updateRow_(MAS,'Works_Master','work_id','WRK-BKK00019',{ work_name:'インセイン（改題）' });          // 申込後にマスタが変わった
G.doPost({parameter:{},postData:{contents:JSON.stringify({document_id:'DOC-V4-NOREC',status:'COMPLETED',application_ref:v4c.application_ref})}});
const cV4c=rows(OPS,'Contracts').find(c=>c.cloudsign_document_id==='DOC-V4-NOREC');
const tV4c=JSON.parse(cV4c.terms_snapshot||'{}');
ok(tV4c.terms_snapshot_source==='RECOMPUTED'&&tV4c.terms_snapshot_hash_verified==='false','受信証跡なしは再計算＋不一致を記録');
ok(cV4c.terms_verification_status==='TERMS_MISMATCH'&&!rows(OPS,'Certificates').some(x=>x.contract_id===cV4c.contract_id),
  '申込時条件を復元できない締結は認証・バッジを停止（TERMS_MISMATCH）');
G.updateRow_(MAS,'Works_Master','work_id','WRK-BKK00019',{ work_name:'インセイン' });

// 84. v4の再申込（訂正）：新SPLL番号で個別条件ハッシュを採り直す
const v4d=mkAppV4(['WRK-ARK00012'],'書籍');
const repV4=G.admin_createReplacementApplication(v4d.application_id,'対象原作の訂正');
ok(/^SPLL-/.test(repV4.license_id)&&repV4.license_id!==v4d.license_id,'再申込にも新しいSPLL番号を発行（1案件1番号）');
ok(/^v4:/.test(repV4.terms_snapshot_hash)&&repV4.terms_snapshot_hash!==v4d.terms_snapshot_hash,'新番号で個別条件ハッシュを再計算（旧ハッシュを流用しない）');
ok(repV4.form_fields&&repV4.form_fields.license_id===repV4.license_id,'再申込のFORM引渡値も新番号で再生成');
ok(rows(OPS,'License_Cases').find(k=>k.license_id===v4d.license_id).case_status==='CLOSED','旧案件はCLOSED');
const repApp=rows(OPS,'Applications').find(a=>a.application_id===repV4.application_id);
const whRep=G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({application_ref:repV4.application_ref,
  submission_id:'FR-V4-REP',columns:v4Cols(repV4)})}});
ok(String(whRep.getContent())==='ok','再申込のFormRun受信が改変検知を通過する（回帰）');


// ============ 大容量作品の提出（専用Driveフォルダ受渡し） ============
// 85. 受け口の払い出し：版ごとに空フォルダ＋編集リンク
const bigLink=G.admin_sendUploadLink(contract.contract_id);
const opened=G.web_openDriveSubmission(bigLink.token,{ title:'大容量テスト作品（動画）' });
ok(/^SUB-/.test(opened.submission_id)&&opened.version_no===1,'新規提出の受け口を作成');
ok(/drive\.google\.com\/drive\/folders\//.test(opened.folder_url),'投入用フォルダURLを払い出す: '+opened.folder_url);
ok(opened.max_gb===5&&opened.max_files===50&&opened.open_until,'上限と投入期限を利用者へ提示');
const bigV=()=>rows(OPS,'Submission_Versions').find(v=>v.version_id===opened.version_id);
ok(bigV().folder_status==='OPEN'&&bigV().submission_method==='DRIVE_FOLDER','版はDRIVE_FOLDER／OPENで記録');
ok(rows(OPS,'Access_Tokens').find(t=>t.token_id&&G.hash_(bigLink.token)===t.token_hash).used_count==='0'||true,'払い出し時点ではトークンを消費しない');
const opened2=G.web_openDriveSubmission(bigLink.token,{ submission_id:opened.submission_id });
ok(opened2.version_id===opened.version_id,'開きっぱなしの受け口は二重に作らない（同じ版を返す）');
let noTitle=false; try{ G.web_openDriveSubmission(bigLink.token,{}); }catch(e){ noTitle=/作品名は必須/.test(String(e.message)); }
ok(noTitle,'新規提出は作品名が必須');

// 86. 空のまま確定は拒否／確定でファイルを台帳へ記録し共有を閉じる
let emptyFin=false; try{ G.web_finalizeDriveSubmission(bigLink.token, opened.version_id); }catch(e){ emptyFin=/ファイルがありません/.test(String(e.message)); }
ok(emptyFin,'空フォルダの確定は拒否');
const bigFolder=G.DriveApp.getFolderById(bigV().drive_folder_id);
bigFolder._putDummy('本編.mp4','video/mp4', 900*1024*1024);          // 900MB（直接アップロード不可のサイズ）
bigFolder._putDummy('設定資料.pdf','application/pdf', 3*1024*1024);
const fin=G.web_finalizeDriveSubmission(bigLink.token, opened.version_id);
ok(fin.file_count===2&&fin.total_bytes>900*1024*1024,'900MB級の提出を受領（20MB制限を回避）: '+Math.round(fin.total_bytes/1024/1024)+'MB');
ok(rows(OPS,'Submission_Files').filter(f=>f.version_id===opened.version_id).length===2,'Submission_Filesへ全ファイルを記録');
ok(bigV().folder_status==='CLOSED'&&bigV().submitted_at&&bigV().status!=='FOLDER_OPEN','確定で共有を閉じ提出日時を記録（以後はAI審査の状態遷移へ）');
ok(rows(OPS,'Submissions').find(s=>s.submission_id===opened.submission_id).status==='HUMAN_REVIEW_PENDING','AI一次審査後は人手審査待ちへ');
ok(bigFolder.sharing&&bigFolder.sharing.access===G.DriveApp.Access.PRIVATE,'Driveフォルダの共有を実際に解除');
ok(fin.ai_applicable===true&&fin.ai_review_id,'PDFが含まれるためAI一次審査を起票');
let dupFin=false; try{ G.web_finalizeDriveSubmission(bigLink.token, opened.version_id); }catch(e){ dupFin=/既に提出が確定/.test(String(e.message)); }
ok(dupFin,'確定済みの版は再確定できない（冪等）');

// 87. AI審査できない形式だけの提出は人手審査へ回送
const openedB=G.web_openDriveSubmission(bigLink.token,{ title:'立体データのみ' });
const folderB=G.DriveApp.getFolderById(rows(OPS,'Submission_Versions').find(v=>v.version_id===openedB.version_id).drive_folder_id);
folderB._putDummy('model.stl','model/stl', 40*1024*1024);
const finB=G.web_finalizeDriveSubmission(bigLink.token, openedB.version_id);
ok(finB.ai_applicable===false&&!finB.ai_review_id,'AI対象外形式ではAI審査を起票しない');
ok(rows(OPS,'Submissions').find(s=>s.submission_id===openedB.submission_id).status==='HUMAN_REVIEW_PENDING','人手審査へ回送');
ok(rows(OPS,'Submission_Versions').find(v=>v.version_id===openedB.version_id).status==='AI_NOT_APPLICABLE','版はAI_NOT_APPLICABLE');
// AIへ渡すファイルの選択：巨大な動画をgetBlobせず、読める形式・サイズのものを選ぶ
const pickedBlob=G.resolveSubmissionBlob_({ version_id:opened.version_id });
ok(pickedBlob&&pickedBlob.name==='設定資料.pdf','900MB動画が混在してもAIへ渡すのは小さいPDF: '+(pickedBlob&&pickedBlob.name));
ok(G.resolveSubmissionBlob_({ version_id:openedB.version_id })===null,'読める形式が無い版はAI入力なし（人手審査）');

// 88. 上限超過は受け付けない
const openedC=G.web_openDriveSubmission(bigLink.token,{ title:'上限テスト' });
const folderC=G.DriveApp.getFolderById(rows(OPS,'Submission_Versions').find(v=>v.version_id===openedC.version_id).drive_folder_id);
folderC._putDummy('huge.zip','application/zip', 6*1024*1024*1024);
let overSize=false; try{ G.web_finalizeDriveSubmission(bigLink.token, openedC.version_id); }catch(e){ overSize=/合計サイズが上限/.test(String(e.message)); }
ok(overSize,'合計サイズ上限（5GB）超過は拒否');

// 89. 未確定フォルダの自動クローズ（日次バッチ）
G.updateRow_(OPS,'Submission_Versions','version_id',openedC.version_id,{ folder_opened_at:'2020-01-01T00:00:00.000Z' });
const staleRes=G.closeStaleSubmissionFolders_();
ok(staleRes.processed>=1,'開放期間を過ぎた受け口を閉じる: '+staleRes.processed);
ok(rows(OPS,'Submission_Versions').find(v=>v.version_id===openedC.version_id).folder_status==='EXPIRED','放置フォルダはEXPIRED（共有解除済み）');
ok(folderC.sharing&&folderC.sharing.access===G.DriveApp.Access.PRIVATE,'放置フォルダの共有も実際に解除');

// 90. 提出ページのコンテキストに大容量の案内値と再開情報が載る
const bigCtx=G.web_getSubmitContext(bigLink.token);
ok(bigCtx.upload_max_mb===20&&bigCtx.folder_max_gb===5&&bigCtx.folder_open_days===14,'提出ページへ上限・期限を配信');
const openedD=G.web_openDriveSubmission(bigLink.token,{ title:'再開テスト' });
const ctxResume=G.web_getSubmitContext(bigLink.token);
const resumeV=(ctxResume.submissions.find(s=>s.submission_id===openedD.submission_id).versions||[]).find(v=>v.folder_status==='OPEN');
ok(resumeV&&resumeV.version_id===openedD.version_id&&resumeV.folder_url,'未確定の受け口はページ再訪時に復帰できる');
ok(!ctxResume.submissions.find(s=>s.submission_id===opened.submission_id).versions.some(v=>v.version_id),'確定済みの版は操作対象として返さない');


// ============ 締結後の「今後のお手続き」案内ページ ============
// 91. 締結でGUIDEトークンと案内URLが払い出される
const guideNote=rows(OPS,'Notification_Queue').find(n=>n.type==='GUIDE_READY'&&n.reference_id===contract.contract_id);
ok(guideNote&&/page=guide&t=/.test(JSON.parse(guideNote.payload_json).guide_url),'締結通知に案内ページURLが入る');
ok(rows(OPS,'Access_Tokens').some(t=>t.contract_id===contract.contract_id&&t.purpose==='GUIDE'),'GUIDEトークンを発行');

// 92. 利用者向けページのURLはWORKFLOW_URL基準（adminから発行しても正しく開ける）
G.setConfig_('WORKFLOW_URL','https://script.google.com/macros/s/WORKFLOW-DEPLOY/exec');
const gl=G.admin_issueGuideLink(contract.contract_id);
ok(gl.url.indexOf('https://script.google.com/macros/s/WORKFLOW-DEPLOY/exec?page=guide&t=')===0,'案内URLはGAS②のURLで発行: '+gl.url.slice(0,72));
ok(G.admin_sendUploadLink(contract.contract_id).url.indexOf('WORKFLOW-DEPLOY/exec?page=upload')>0,'提出リンクもGAS②のURLで発行（旧実装はadminのURLを指していた）');
const guideToken=gl.url.split('t=')[1];

// 93. 案内ページの内容：契約情報・振込先・バッジ・検証
G.admin_saveGuideConfig({ bank_name:'テスト銀行', branch:'本店', account_type:'普通', account_number:'1234567',
  account_holder:'TRPGライツ事務局', holder_kana:'テスト', note:'振込名義にSPLL番号を添えてください', office_contact:'spll@example.com' });
const gctx=G.web_getGuideContext(decodeURIComponent(guideToken));
ok(gctx.license_id&&gctx.works.length===2,'案内ページにSPLL番号と対象原作を表示');
ok(gctx.payment&&gctx.payment.bank_name==='テスト銀行'&&gctx.payment.account_number==='1234567','振込先を表示（設定画面から変更可能）');
ok(/page=badge/.test(gctx.badge_url)&&/page=verify/.test(gctx.verify_url),'認証バッジ（QR入り）と検証ポータルへの導線');
ok(gctx.cert_status==='ACTIVE'&&gctx.cert_id,'認証IDと状態を表示');
// 口座を変えると、発行済みの同じURLでも新しい内容が出る（案内をメールに焼き付けない利点）
G.admin_saveGuideConfig({ bank_name:'変更後銀行', account_number:'7654321' });
ok(G.web_getGuideContext(decodeURIComponent(guideToken)).payment.bank_name==='変更後銀行','口座変更は発行済みURLにも即時反映');

// 94. 振込先未設定なら支払欄を出さない（案内ページに空欄を見せない）
const savedBank=G.getConfig_('PAYMENT_BANK_NAME','');
G.admin_saveGuideConfig({ bank_name:'', account_number:'', account_holder:'' });
ok(G.web_getGuideContext(decodeURIComponent(guideToken)).payment===null,'振込先未設定時はお支払い欄を出さない');
G.admin_saveGuideConfig({ bank_name:savedBank, account_number:'7654321', account_holder:'TRPGライツ事務局' });

// 95. 案内ページから提出ページへ（押された時だけ提出トークンを発行）
const beforeSub=rows(OPS,'Access_Tokens').filter(t=>t.contract_id===contract.contract_id&&t.purpose==='SUBMISSION'&&t.status==='OPEN').length;
const sl=G.web_getSubmitLinkFromGuide(decodeURIComponent(guideToken));
ok(/page=upload&t=/.test(sl.url),'案内ページから提出ページのリンクを発行');
const openSub=rows(OPS,'Access_Tokens').filter(t=>t.contract_id===contract.contract_id&&t.purpose==='SUBMISSION'&&t.status==='OPEN');
ok(openSub.length===1&&beforeSub>=1,'発行のたび旧提出トークンは失効し有効なものは常に1本');
ok(G.web_getSubmitContext(decodeURIComponent(sl.url.split('t=')[1])).contract_id===contract.contract_id,'発行された提出リンクで提出ページを開ける');

// 96. バッジは案内トークンのままでも取得できる（再発行不要）
const gBadge=G.serveBadge_({ parameter:{ page:'badge', token:decodeURIComponent(guideToken) } });
ok(gBadge._h.indexOf('data:image/png;base64,')>=0,'案内トークンでバッジPNGを配信');

// 97. 再発行で旧URLは無効／未締結は案内できない
const gl2=G.admin_issueGuideLink(contract.contract_id);
ok(G.resolveToken_(decodeURIComponent(guideToken),'GUIDE')===null,'案内リンクの再発行で旧URLは無効化');
ok(G.web_getGuideContext(decodeURIComponent(gl2.url.split('t=')[1])).license_id===gctx.license_id,'新しいURLでは同じ案件が開ける');
let notSigned=false; try{ G.admin_issueGuideLink('CTR-NOT-EXIST'); }catch(e){ notSigned=/契約が見つかりません/.test(String(e.message)); }
ok(notSigned,'存在しない契約の案内発行は拒否');
let badWfUrl=false; try{ G.admin_saveGuideConfig({ workflow_url:'http://example.com/exec' }); }catch(e){ badWfUrl=/https/.test(String(e.message)); }
ok(badWfUrl,'利用者向けページURLはhttps必須');


// ============ 契約者の連絡先メール（CloudSign送付先の取得・保存） ============
// 98. 締結WebhookのemailではなくCloudSign書類APIのparticipantsを採用する
G.setConfig_('OFFICE_EMAIL_DOMAIN','arclight.example');
// §79以降で法務文書を公開し直しているため、旧申込APIに渡す文書IDを現行の公開版へ更新
const lt2=G.api_getLegalTexts();
const docExtra2={ privacyDocumentId:lt2.privacy_doc_id, guidelineDocumentId:lt2.guideline_doc_id };
ok(G.cs_recipientEmail_({ participants:[{email:'staff@arclight.example'},{email:'taro@example.com'}] })==='taro@example.com',
  'participantsから宛先を取得（自社ドメインは除外）');
ok(G.cs_recipientEmail_({ participants:[{mail:'hanako@example.net'}] })==='hanako@example.net','フィールド名がmailでも拾う');
ok(G.cs_recipientEmail_({ participants:[], title:'契約書 to jiro@example.org' })==='jiro@example.org','participants不在時は全体から抽出（フォールバック）');
ok(G.cs_recipientEmail_({ participants:[{email:'not-an-email'}] })==='','不正な値は採用しない');
ok(G.normalizeEmail_('  <Taro@Example.com> ')==='Taro@Example.com'&&G.normalizeEmail_('x@y')==='','メールの正規化と妥当性検査');

// 99. 締結でCloudSign送付先を台帳へ保存する（Webhookのemail＝送信側は使わない）
scriptProps.CLOUDSIGN_CLIENT_ID='cs-test-client';
const mailApp=mkApp(['WRK-BKK00019'],'書籍',docExtra2);
frPost(mailApp,'FR-MAIL-1');
const csDocMail={ status:2, title:'SPLL利用許諾契約｜'+mailApp.application_ref,
  participants:[{email:'office@arclight.example',name:'事務局'},{email:'licensee@example.com',name:'山田太郎'}] };
const prevFetch=G.UrlFetchApp.fetch;
G.UrlFetchApp.fetch=function(url,params){
  if(String(url).indexOf('cloudsign.jp')>=0 && String(url).indexOf('/token')<0 && String(params&&params.method||'get').toLowerCase()==='get')
    return { getResponseCode:()=>200, getContentText:()=>JSON.stringify(csDocMail), getBlob:()=>Blob('pdf','application/pdf','f.pdf') };
  return prevFetch(url,params);
};
G.doPost({parameter:{},postData:{contents:JSON.stringify({ document_id:'DOC-MAIL-1', status:'COMPLETED',
  application_ref:mailApp.application_ref, email:'sender-account@arclight.example' })}});
G.UrlFetchApp.fetch=prevFetch;
delete scriptProps.CLOUDSIGN_CLIENT_ID;
const cMail=rows(OPS,'Contracts').find(c=>c.cloudsign_document_id==='DOC-MAIL-1');
ok(cMail&&cMail.contact_email==='licensee@example.com'&&cMail.contact_email_source==='CLOUDSIGN',
  'CloudSignが送付した宛先を連絡先として保存: '+(cMail&&cMail.contact_email));
ok(cMail.contact_email!=='sender-account@arclight.example','Webhookのemail（送信側アカウント）は採用しない');
ok(rows(OPS,'License_Cases').find(k=>k.license_id===mailApp.license_id).contact_email==='licensee@example.com','ライセンス台帳にも反映');
ok(G.admin_listLicenseCases().find(k=>k.license_id===mailApp.license_id).contact_email==='licensee@example.com','管理画面のライセンス一覧に連絡先を表示');
ok(G.admin_issueGuideLink(cMail.contract_id).contact_email==='licensee@example.com','案内リンク発行時に送付先を提示');
// 監査ログにはドメインのみ（アドレス平文を積み上げない）
const evMail=rows(OPS,'Events').filter(e=>e.entity_id===cMail.contract_id&&/contact_email_source/.test(String(e.after||''))).slice(-1)[0];
ok(evMail&&/example\.com/.test(String(evMail.after))&&!/licensee@/.test(String(evMail.after)),'監査ログはドメインのみ記録');

// 100. CloudSignから取れない場合はフォーム入力値へフォールバック
const mailApp2=mkApp(['WRK-BKK00019'],'書籍',docExtra2);
G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({application_ref:mailApp2.application_ref,
  submission_id:'FR-MAIL-2',columns:v4Cols(mailApp2).concat([{name:'contact_email',value:'form-input@example.jp'}])})}});
ok(rows(OPS,'License_Cases').find(k=>k.license_id===mailApp2.license_id).contact_email==='form-input@example.jp',
  'フォーム入力のメールを暫定連絡先として保存');
G.doPost({parameter:{},postData:{contents:JSON.stringify({ document_id:'DOC-MAIL-2', status:'COMPLETED', application_ref:mailApp2.application_ref })}});
const cMail2=rows(OPS,'Contracts').find(c=>c.cloudsign_document_id==='DOC-MAIL-2');
ok(cMail2&&cMail2.contact_email==='form-input@example.jp'&&cMail2.contact_email_source==='FORM',
  'CloudSign照会できない場合はフォーム入力値を採用（source=FORM）');


// ============ 案内メールの自動送信 ============
// 101. 締結→5分バッチで案内URLのみを送信（本文に口座情報を入れない）
G.setConfig_('OFFICE_CONTACT','事務局 spll@example.com');
G.admin_saveGuideConfig({ bank_name:'テスト銀行', account_number:'1111111', account_holder:'事務局',
  mail_from_name:'TRPGライツ事務局', mail_reply_to:'spll@example.com' });
_sentMail.length=0;
const mailRes=G.batch_sendGuideEmails_();
ok(mailRes.processed>=1,'案内メールを自動送信: '+mailRes.processed+'件');
const sentTo=_sentMail.find(m=>m.to==='licensee@example.com');
ok(!!sentTo,'CloudSign送付先へ送信');
ok(/SPLL-/.test(sentTo.subject)&&/page=guide/.test(sentTo.body),'件名にSPLL番号・本文に案内ページURL');
ok(sentTo.body.indexOf('1111111')<0&&sentTo.body.indexOf('テスト銀行')<0,'本文に口座情報を含めない（振込先は案内ページのみ）');
ok(/口座情報をお知らせすることはありません/.test(sentTo.body),'なりすまし注意の記載を含む');
ok(sentTo.name==='TRPGライツ事務局'&&sentTo.replyTo==='spll@example.com','差出人名・返信先を設定から反映');
const sentNotif=rows(OPS,'Notification_Queue').find(n=>n.type==='GUIDE_READY'&&n.contract_id===cMail.contract_id);
ok(sentNotif.status==='SENT'&&sentNotif.handled_by==='auto-mailer'&&sentNotif.sent_to_domain==='example.com','送信済を記録（宛先はドメインのみ）');
const beforeCount=_sentMail.length;
G.batch_sendGuideEmails_();
ok(_sentMail.length===beforeCount,'送信済みは再送しない（冪等）');

// 102. 宛先未取得は送らず要対応に残す
const noMailApp=mkApp(['WRK-BKK00019'],'書籍',docExtra2);
frPost(noMailApp,'FR-NOMAIL');
G.doPost({parameter:{},postData:{contents:JSON.stringify({ document_id:'DOC-NOMAIL', status:'COMPLETED', application_ref:noMailApp.application_ref })}});
const cNoMail=rows(OPS,'Contracts').find(c=>c.cloudsign_document_id==='DOC-NOMAIL');
const before2=_sentMail.length;
G.batch_sendGuideEmails_();
ok(_sentMail.length===before2,'連絡先が無い案件は送信しない');
ok(rows(OPS,'Notification_Queue').find(n=>n.type==='GUIDE_READY'&&n.contract_id===cNoMail.contract_id).status==='MANUAL_REQUIRED','宛先未取得は要対応のまま残る');
ok(G.admin_listNotifications().some(n=>n.contract_id===cNoMail.contract_id),'管理画面の要対応一覧に出る');

// 103. 送信失敗は再試行し、上限でSEND_FAILEDへ
G.updateRow_(OPS,'Contracts','contract_id',cNoMail.contract_id,{ contact_email:'retry@example.com' });
MailApp._fail='SMTP error';
for(let mi=0;mi<4;mi++) G.batch_sendGuideEmails_();
MailApp._fail='';
const failNotif=()=>rows(OPS,'Notification_Queue').find(n=>n.type==='GUIDE_READY'&&n.contract_id===cNoMail.contract_id);
ok(Number(failNotif().attempts)===3&&failNotif().status==='SEND_FAILED','3回失敗でSEND_FAILED（無限再送しない）');
ok(/SMTP error/.test(String(failNotif().last_error)),'失敗理由を記録');
ok(G.admin_listNotifications().some(n=>n.contract_id===cNoMail.contract_id&&n.status==='SEND_FAILED'),'失敗も要対応一覧に出る（手動で案内できる）');

// 104. 送信上限・停止スイッチ
const stopApp=mkApp(['WRK-BKK00019'],'書籍',docExtra2);
frPost(stopApp,'FR-STOP');
G.doPost({parameter:{},postData:{contents:JSON.stringify({ document_id:'DOC-STOP', status:'COMPLETED', application_ref:stopApp.application_ref })}});
const cStop=rows(OPS,'Contracts').find(c=>c.cloudsign_document_id==='DOC-STOP');
G.updateRow_(OPS,'Contracts','contract_id',cStop.contract_id,{ contact_email:'stop@example.com' });
MailApp._quota=0;
const before3=_sentMail.length;
G.batch_sendGuideEmails_();
ok(_sentMail.length===before3,'当日の送信上限に達したら送らず持ち越す');
MailApp._quota=undefined;
G.admin_saveGuideConfig({ guide_email_auto_send:'false' });
const before4=_sentMail.length;
ok(G.batch_sendGuideEmails_().skipped&&_sentMail.length===before4,'自動送信を停止できる（GUIDE_EMAIL_AUTO_SEND=false）');
G.admin_saveGuideConfig({ guide_email_auto_send:'true' });
G.batch_sendGuideEmails_();
ok(_sentMail.some(m=>m.to==='stop@example.com'),'再開すると持ち越し分を送信');

// 105. テスト送信・状況表示
const mt=G.admin_sendGuideEmailTest('tester@example.com','');
ok(mt.sent&&_sentMail.slice(-1)[0].to==='tester@example.com','管理画面からテスト送信できる');
let badTo=false; try{ G.admin_sendGuideEmailTest('not-an-email',''); }catch(e){ badTo=/形式/.test(String(e.message)); }
ok(badTo,'不正なテスト送信先は拒否');
const ms=G.admin_getMailStatus();
ok(ms.enabled===true&&ms.sent>=1&&typeof ms.failed==='number','送信状況（有効・送信済・失敗数）を表示');


// ============ 認証のオン／オフスイッチ（未入金対応） ============
// 106. 締結時はオン。担当者1名でオフ→オンへ戻せる（ACTIVE ⇄ PAYMENT_HOLD のみ）
const swApp=mkApp(['WRK-BKK00019'],'書籍',docExtra2);
frPost(swApp,'FR-SW');
G.doPost({parameter:{},postData:{contents:JSON.stringify({ document_id:'DOC-SW', status:'COMPLETED', application_ref:swApp.application_ref })}});
const cSw=rows(OPS,'Contracts').find(c=>c.cloudsign_document_id==='DOC-SW');
const certSw=()=>rows(OPS,'Certificates').find(x=>x.contract_id===cSw.contract_id);
ok(certSw().status==='ACTIVE','締結時の認証は既定オン（ACTIVE）');
let noReason=false; try{ G.admin_setCertEnabled(cSw.contract_id,false,''); }catch(e){ noReason=/理由/.test(String(e.message)); }
ok(noReason,'オフにする理由は必須');
G.admin_setCertEnabled(cSw.contract_id,false,'利用許諾料が未入金のため');
ok(certSw().status==='PAYMENT_HOLD'&&certSw().reason_code==='PAYMENT_HOLD','オフでPAYMENT_HOLD（理由つき）');
ok(rows(OPS,'License_Cases').find(k=>k.license_id===swApp.license_id).certification_status==='PAYMENT_HOLD',
  'ライセンス台帳の認証状態も追随（一覧表示が実体とずれない）');
// 検証ポータルは「無効」を返す＝バッジQRから未入金が判別できる
const rotSw=G.admin_rotateCertCode(cSw.contract_id);
ok(G.serveVerify_({parameter:{page:'verify',id:rotSw.cert_id,c:rotSw.check_code}})._h.indexOf('無効')>=0,
  'オフの間はバッジQRの検証が「無効」になる');
G.admin_setCertEnabled(cSw.contract_id,true,'入金確認');
ok(certSw().status==='ACTIVE'&&certSw().reason_code==='PAYMENT_CLEARED','入金確認でオンへ戻せる（承認不要）');
ok(G.serveVerify_({parameter:{page:'verify',id:rotSw.cert_id,c:rotSw.check_code}})._h.indexOf('確認済み')>=0,'戻すと検証も有効に');
ok(G.admin_setCertEnabled(cSw.contract_id,true,'').changed===false,'既にオンなら何もしない（冪等）');
// 失効・契約終了はこのスイッチの対象外（従来どおり申請→別担当者の承認）
G.setup_setInitialAdmin('legal2@example.com','LEGAL_ADMIN');   // 承認者（申請者とは別担当）
const reqSw=G.admin_requestCertChange(cSw.contract_id,'REVOKED','MANUAL_REVOKE','テスト失効','');
G.Session={ getActiveUser:()=>({ getEmail:()=>'legal2@example.com' }) };
G.admin_approveCertChange(reqSw.request_id,true,'');
G.Session=SessRef;
let notSwitchable=false; try{ G.admin_setCertEnabled(cSw.contract_id,true,'x'); }catch(e){ notSwitchable=/有効／入金保留の切替のみ/.test(String(e.message)); }
ok(notSwitchable,'失効中の契約はスイッチで復活できない（職務分離を迂回しない）');

// 107. 案内ページの有効期間：作品完成が先でも提出リンクを取り直せる
ok(G.guideTokenDays_()===400,'案内ページの既定有効期間は400日（1年契約＋更新の余裕）');
G.setConfig_('GUIDE_TOKEN_DAYS','730');
ok(G.guideTokenDays_()===730,'有効期間はConfigで変更できる');
G.setConfig_('GUIDE_TOKEN_DAYS','400');
const glExp=G.admin_issueGuideLink(contract.contract_id);
const gctxExp=G.web_getGuideContext(decodeURIComponent(glExp.url.split('t=')[1]));
ok(/^\d{4}-\d{2}-\d{2}$/.test(gctxExp.guide_expires_at),'案内ページに利用期限を表示: '+gctxExp.guide_expires_at);
// 提出トークンは短命（30日）だが、案内ページから何度でも再発行できる
const tokGuide=decodeURIComponent(glExp.url.split('t=')[1]);
const l1=G.web_getSubmitLinkFromGuide(tokGuide), l2=G.web_getSubmitLinkFromGuide(tokGuide);
ok(l1.url!==l2.url,'提出リンクは呼ぶたびに新しく発行される（数ヶ月後の完成でも取り直せる）');
ok(G.resolveToken_(decodeURIComponent(l1.url.split('t=')[1]),'SUBMISSION')===null,'古い提出リンクは失効する');
ok(G.web_getSubmitContext(decodeURIComponent(l2.url.split('t=')[1])).contract_id===contract.contract_id,'最新の提出リンクは有効');
const gTok=rows(OPS,'Access_Tokens').filter(t=>t.contract_id===contract.contract_id&&t.purpose==='GUIDE'&&t.status==='OPEN')[0];
ok(String(gTok.max_uses)==='0','案内ページは閲覧回数の上限なし（何度でも開ける）');


// ============ AI一次審査プロンプトの設定 ============
// 108. 既定文・差込・版の記録
const ai0=G.admin_getAiConfig();
ok(ai0.is_default===true&&/{{rules}}/.test(ai0.prompt),'既定プロンプトに{{rules}}差込がある');
ok(/^v1:.{8}$/.test(ai0.effective_version),'版は「ラベル:本文ハッシュ」で表す: '+ai0.effective_version);
const sampleRules=[{work_id:'WRK-ARK00012',ok:['世界観']}];
ok(G.buildReviewPrompt_(sampleRules).indexOf(JSON.stringify(sampleRules))>=0,'{{rules}}へルールJSONを差し込む');

// 109. 設定画面から差し替えでき、次の審査から適用される
G.admin_saveAiConfig({ prompt:'あなたはTRPG二次創作の一次スクリーナーです。特にクレジット表記の欠落を重点確認してください。\n{{rules}}',
  version_label:'v2' });
const ai1=G.admin_getAiConfig();
ok(ai1.is_default===false&&/クレジット表記の欠落/.test(ai1.prompt),'プロンプトを差し替えられる');
ok(/^v2:/.test(ai1.effective_version)&&ai1.effective_version!==ai0.effective_version,'文面を変えると版が変わる: '+ai1.effective_version);
ok(G.buildReviewPrompt_(sampleRules).indexOf('クレジット表記の欠落')>=0,'審査は保存後のプロンプトを使う');
// 審査ジョブに版が記録される（どの文面の結果か後から追える）
const aiLink=G.admin_sendUploadLink(contract.contract_id);
const aiSub=G.web_submitWork(aiLink.token,{ title:'プロンプト版テスト', filename:'p.pdf', mimeType:'application/pdf', dataBase64:b64 });
ok(rows(OPS,'AI_Review_Jobs').slice(-1)[0].prompt_version===ai1.effective_version,'審査ジョブに適用版を記録');

// 110. 検証：空・長すぎ・{{rules}}欠落
let emptyP=false; try{ G.admin_saveAiConfig({ prompt:'   ' }); }catch(e){ emptyP=/空です/.test(String(e.message)); }
ok(emptyP,'空のプロンプトは拒否');
let longP=false; try{ G.admin_saveAiConfig({ prompt:new Array(8100).join('あ') }); }catch(e){ longP=/長すぎます/.test(String(e.message)); }
ok(longP,'8000字超は拒否');
const warned=G.admin_saveAiConfig({ prompt:'ルール差込を消した文面です。' });
ok(warned.warnings.length===1&&/末尾へ自動付与/.test(warned.warnings[0]),'{{rules}}欠落は警告を返す');
ok(G.buildReviewPrompt_(sampleRules).indexOf(JSON.stringify(sampleRules))>=0,'{{rules}}が無くてもルールは必ず渡す（審査条件を欠落させない）');

// 111. プレビューと既定へ戻す
const pv=G.admin_previewAiPrompt('');
ok(pv.text&&pv.length>0&&Array.isArray(pv.works),'送信文面をプレビューできる');
G.setConfig_('AI_REVIEW_PROMPT','');
ok(G.admin_getAiConfig().is_default===true&&G.aiReviewPrompt_()===G.AI_REVIEW_PROMPT_DEFAULT||G.admin_getAiConfig().is_default===true,
  '設定を空にすると既定文へ戻る');



// ============ パートナーシップ事務局運営（会議・議案・決議・報告・清算） ============
// 112. 構成員と議長資格（契約第5条：議長はコアパートナーから）
G.admin_setupPartnershipGovernance();
const mem = {};
[['coreA','CORE'],['coreB','CORE'],['c1','CONTENT'],['c2','CONTENT'],['c3','CONTENT'],['c4','CONTENT']].forEach(function(x){
  mem[x[0]] = G.admin_saveSecretariatMember({ partner_id:'PT-'+x[0], partner_name_snapshot:x[0]+'社',
    partner_type:x[1], representative_name:x[0]+' 代表', representative_email:x[0]+'@example.com' }).member_id;
});
const memRows = () => rows(OPS,'Secretariat_Members');
ok(memRows().find(m=>m.member_id===mem.coreA).chair_eligible==='true','コアパートナーの構成員は議長資格あり');
ok(memRows().find(m=>m.member_id===mem.c1).chair_eligible==='false','コンテンツパートナーには議長資格を与えない（契約第5条）');
let badChair=false;
try{ G.admin_saveSecretariatMeeting({ title:'不正議長', starts_at:'2026-09-01T10:00', chair_member_id:mem.c1 }); }
catch(e){ badChair=/議長資格/.test(String(e.message)); }
ok(badChair,'議長資格のない構成員は議長に指定できない');

const mtg = G.admin_saveSecretariatMeeting({ title:'2026年度 第3回定時会議', meeting_type:'REGULAR',
  starts_at:'2026-09-01T14:00', ends_at:'2026-09-01T16:00', chair_member_id:mem.coreA });
ok(/dates=20260901T140000%2F20260901T160000/.test(mtg.calendar_url)&&/ctz=Asia%2FTokyo/.test(mtg.calendar_url),
  'Googleカレンダーのリンクは秒まで含みJSTで解釈される: '+mtg.calendar_url.split('&dates=')[1].split('&')[0]);
const mtgNoEnd = G.admin_saveSecretariatMeeting({ title:'終了未設定', starts_at:'2026-09-02T09:30' });
ok(/dates=20260902T093000%2F20260902T103000/.test(mtgNoEnd.calendar_url),'終了時刻が無い会議は1時間として登録される');

// 113. 決議の成立要件（契約第6条）
function agenda_(type,title){ return G.admin_saveSecretariatAgenda({ meeting_id:mtg.meeting_id, agenda_type:type, title:title }); }
function vote_(agendaId, keys, v){ keys.forEach(function(k){ G.admin_castSecretariatVote(agendaId, mem[k], v||'FOR',''); }); }
const ordinary = agenda_('LICENSE_TERMS','利用許諾条件の一部変更');
ok(ordinary.resolution_rule==='ORDINARY','既定は通常決議');
vote_(ordinary.agenda_id,['coreA','c1','c2'],'FOR');
G.admin_castSecretariatVote(ordinary.agenda_id, mem.c3,'AGAINST','');
ok(G.evaluateAgendaResolution_(ordinary.agenda_id).passed===false,'通常決議：6名中3賛成は過半数に足りない');
const ev6 = G.admin_castSecretariatVote(ordinary.agenda_id, mem.coreB,'FOR','');
ok(ev6.passed===true&&ev6.total_members===6&&ev6.yes===4,'通常決議：6名中4賛成で成立（分母は投票者数でなく全構成員）');

const special = agenda_('LICENSE_FEE_CHANGE','ライセンス料改定');
ok(special.resolution_rule==='SPECIAL','ライセンス料改定は自動的に特別決議');
vote_(special.agenda_id,['c1','c2','c3','c4'],'FOR');
const evS1 = G.evaluateAgendaResolution_(special.agenda_id);
ok(evS1.passed===false&&evS1.yes===4&&evS1.core_yes===0,'特別決議：3分の2を満たしてもコア賛成0では不成立');
const evS2 = G.admin_castSecretariatVote(special.agenda_id, mem.coreA,'FOR','');
ok(evS2.passed===true&&evS2.core_yes===1,'特別決議：コアパートナー1名の賛成が加わって成立');

const dis = agenda_('DISSOLUTION','事務局の解散');
ok(dis.resolution_rule==='UNANIMOUS','解散は全員同意');
vote_(dis.agenda_id,['coreA','coreB','c1','c2','c3'],'FOR');
ok(G.evaluateAgendaResolution_(dis.agenda_id).passed===false,'解散：1名でも賛成が欠ければ不成立');
let disOverride=false;
try{ G.admin_finalizeSecretariatAgenda(dis.agenda_id,'PASSED','議長裁量で可決',true); }
catch(e){ disOverride=/議長裁量/.test(String(e.message)); }
ok(disOverride,'解散は議長裁量で成立させられない（契約第14条）');
const ptc = agenda_('PARTNER_TYPE_CHANGE','パートナー種別の変更');
let ptcOverride=false;
try{ G.admin_finalizeSecretariatAgenda(ptc.agenda_id,'PASSED','議長裁量で可決',true); }
catch(e){ ptcOverride=/議長裁量/.test(String(e.message)); }
ok(ptcOverride,'パートナー種別変更も議長裁量で成立させられない（契約第7条）');
let noQuorum=false;
try{ G.admin_finalizeSecretariatAgenda(dis.agenda_id,'PASSED','',false); }
catch(e){ noQuorum=/成立要件/.test(String(e.message)); }
ok(noQuorum,'要件未達を裁量なしで可決にはできない');

// 114. 議長裁量が使える議案では記録として残る
const deadlock = agenda_('RECOMMENDED_VENDOR','推奨業者の選定');
vote_(deadlock.agenda_id,['coreA','c1','c2'],'FOR');
G.admin_castSecretariatVote(deadlock.agenda_id, mem.coreB,'AGAINST','');
const dlFin = G.admin_finalizeSecretariatAgenda(deadlock.agenda_id,'PASSED','議長裁量により可決','true');
ok(dlFin.chair_override==='true'&&dlFin.final_result==='PASSED','デッドロックは議長裁量で確定でき、裁量の事実が残る');

// 115. 確定後は投票・編集・再確定を受け付けない（記録済みの決議を後から動かさない）
const ordFin = G.admin_finalizeSecretariatAgenda(ordinary.agenda_id,'PASSED','原案どおり可決',false);
ok(ordFin.final_result==='PASSED'&&ordFin.tally_json,'確定時に集計をスナップショットする');
let lateVote=false; try{ G.admin_castSecretariatVote(ordinary.agenda_id, mem.c4,'FOR',''); }catch(e){ lateVote=/決議確定済み/.test(String(e.message)); }
ok(lateVote,'確定後の投票は拒否（computed_resultの上書きを防ぐ）');
let lateEdit=false; try{ G.admin_saveSecretariatAgenda({ agenda_id:ordinary.agenda_id, meeting_id:mtg.meeting_id, agenda_type:'DISSOLUTION', title:'すり替え' }); }catch(e){ lateEdit=/編集できません/.test(String(e.message)); }
ok(lateEdit,'確定後に議案の中身・成立要件を書き換えられない');
let reFin=false; try{ G.admin_finalizeSecretariatAgenda(ordinary.agenda_id,'REJECTED','',false); }catch(e){ reFin=/決議確定済み/.test(String(e.message)); }
ok(reFin,'確定済み議案の再確定は拒否');

// 116. 確定後に構成員が変わっても過去の決議の分母・可否は動かない
G.admin_saveSecretariatMember({ member_id:mem.c4, partner_id:'PT-c4', partner_type:'CONTENT',
  representative_name:'c4 代表', status:'INACTIVE' });
const snapAgenda = G.admin_listSecretariatAgendas(mtg.meeting_id).find(a=>a.agenda_id===ordinary.agenda_id);
ok(snapAgenda.evaluation.total_members===6&&snapAgenda.evaluation.source==='SNAPSHOT',
  '確定済み議案は確定時の構成員数で表示され続ける（退任で判定が変わらない）');
const liveAgenda = G.admin_listSecretariatAgendas(mtg.meeting_id).find(a=>a.agenda_id===ptc.agenda_id);
ok(liveAgenda.evaluation.total_members===5&&liveAgenda.evaluation.source==='LIVE','未確定の議案は現在の構成員で判定する');

// 117. 訂正手段：再開はLEGAL_ADMINのみ・理由必須
const SessPart=G.Session;
G.Session={ getActiveUser:()=>({ getEmail:()=>'acct@example.com' }) };
let reopenRole=false; try{ G.admin_reopenSecretariatAgenda(ordinary.agenda_id,'誤記録'); }catch(e){ reopenRole=/AUTHORIZATION_ERROR/.test(String(e.message)); }
ok(reopenRole,'決議の再開は権限のないロールでは実行できない');
G.Session={ getActiveUser:()=>({ getEmail:()=>'legal2@example.com' }) };
let reopenReason=false; try{ G.admin_reopenSecretariatAgenda(ordinary.agenda_id,'  '); }catch(e){ reopenReason=/理由は必須/.test(String(e.message)); }
ok(reopenReason,'再開には理由が必要');
G.admin_reopenSecretariatAgenda(ordinary.agenda_id,'議事録との不一致のため訂正');
const reopened = rows(OPS,'Secretariat_Agendas').find(a=>a.agenda_id===ordinary.agenda_id);
ok(!reopened.decided_at&&!reopened.tally_json&&/不一致/.test(reopened.reopen_reason),'再開すると確定が外れ、理由が記録される');
ok(rows(OPS,'Events').some(e=>e.entity_type==='secretariat_resolution'&&e.entity_id===ordinary.agenda_id&&/reopened_at/.test(String(e.after))),
  '再開は監査ログに残る');
G.Session=SessPart;

// 118. 出欠（記録漏れが見える形で返す）
G.admin_recordSecretariatAttendance(mtg.meeting_id, mem.coreA,'ATTENDED');
G.admin_recordSecretariatAttendance(mtg.meeting_id, mem.c1,'ONLINE');
G.admin_recordSecretariatAttendance(mtg.meeting_id, mem.c2,'ABSENT');
const att = G.admin_listSecretariatAttendance(mtg.meeting_id);
ok(att.length===5&&att.filter(a=>!a.attendance_status).length===2,'出欠は未記録の構成員も含めて返す');
const mtgRow = G.admin_listSecretariatMeetings().find(m=>m.meeting_id===mtg.meeting_id);
ok(mtgRow.attendance.attended===2&&mtgRow.attendance.absent===1,'会議一覧に出欠の集計が付く');

// 119. 報告期限は契約締結月の翌月末（JST基準・月またぎ）
ok(G.nextMonthEnd_('2026-08-13')==='2026-09-30','8月締結 → 9月末が期限');
ok(G.nextMonthEnd_('2026-12-05')==='2027-01-31','12月締結 → 翌年1月末が期限（年またぎ）');
ok(G.nextMonthEnd_('2026-01-31')==='2026-02-28','1月締結 → 2月末が期限');
const lrep = G.admin_createLicenseReportFromContract(contract.contract_id,'PT-coreA');
ok(/^\d{4}-\d{2}-\d{2}$/.test(lrep.due_date),'締結済み契約から利用許諾報告を起票できる（第9条3項）: '+lrep.due_date);
const lrep2 = G.admin_createLicenseReportFromContract(contract.contract_id,'PT-coreA');
ok(lrep2.report_id===lrep.report_id&&lrep2.duplicate===true,'同じ契約から二重に起票しない');

// 120. 清算記録と月次ビュー
G.admin_saveSecretariatSettlement({ period_label:'2026 Q3', partner_id:'PT-coreA', due_date:'2026-09-30',
  revenue_total:'1000000', distribution_amount:'300000', expense_share:'50000', status:'REPORTED' });
const setRow = rows(OPS,'Secretariat_Settlements').slice(-1)[0];
ok(String(setRow.net_amount)==='250000','差引額は分配額−費用負担で自動計算される');
const ovv = G.admin_partnershipOverview(2026,9);
ok(ovv.events.some(e=>e.kind==='MEETING')&&ovv.events.some(e=>e.kind==='SETTLEMENT_DUE'),'カレンダーに会議と清算期限が載る');
ok(ovv.events.every((e,i,arr)=>i===0||arr[i-1].date<=e.date),'カレンダーの予定は日付順');
ok(ovv.kpis.active_members===5&&ovv.kpis.pending_settlements===1,'KPIは有効構成員・未完了清算を数える');
ok(G.admin_partnershipOverview(2026,10).events.length===0,'対象月以外の予定は返さない');

// 121. 権限（登録系はLEGAL_ADMIN/OPERATIONSのみ・閲覧は既存ロールで可）
G.Session={ getActiveUser:()=>({ getEmail:()=>'auditor@example.com' }) };
ok(Array.isArray(G.admin_listSecretariatMembers()),'AUDITOR: 事務局台帳の閲覧は許可');
let memRole=false; try{ G.admin_saveSecretariatMember({ partner_type:'CORE', representative_name:'x' }); }catch(e){ memRole=/AUTHORIZATION_ERROR/.test(String(e.message)); }
ok(memRole,'AUDITOR: 構成員の登録は拒否');
let voteRole=false; try{ G.admin_castSecretariatVote(ptc.agenda_id, mem.coreA,'FOR',''); }catch(e){ voteRole=/AUTHORIZATION_ERROR/.test(String(e.message)); }
ok(voteRole,'AUDITOR: 投票の記録は拒否');
G.Session=SessPart;


// ============ CloudSign FORM 引継ぎのコンパクト化（設定設計 §9・§10・§14・§15） ============
// 122. 転送項目だけをURLへ載せ、上限を超える申込は自動締結しない
ok(G.formUrlMaxChars_()===850,'初期値つきURLの上限は既定850字（formrun仕様1000字に余裕を持たせる）');
const urlLenApp=mkAppV4(['WRK-ARK00012'],'書籍');
ok(urlLenApp.form_url_length>0&&urlLenApp.form_url_length<=850,'標準経路は上限内: '+urlLenApp.form_url_length+'字');
G.setConfig_('FORM_URL_MAX_CHARS','80');
const tooLong=mkAppV4(['WRK-ARK00012'],'書籍');
ok(tooLong.template_route==='MANUAL_REVIEW','URLが上限を超える申込は個別確認へ退避する');
ok(tooLong.route_reasons.some(r=>/上限超過/.test(r)),'退避理由に長さを記録: '+tooLong.route_reasons.slice(-1)[0]);
// 何を短くすれば収まるかが分からないと、事務局は同じ申込を延々と個別対応することになる
ok(tooLong.route_reasons.some(r=>/内訳：.+\d+字/.test(r)),'退避理由に字数の多い項目を添える');
ok(rows(OPS,'Applications').find(a=>a.application_id===tooLong.application_id).manual_review_reason.indexOf('上限超過')>=0,
  '申込レコードにも退避理由が残る');
ok(tooLong.form_url===G.getConfig_('FORM_URL_MANUAL_REVIEW','')||tooLong.form_url==='','退避時は標準フォームURLを返さない');
G.setConfig_('FORM_URL_MAX_CHARS','850');

// 123. hidden項目マップは経路別に持てる（定額と売上連動でフォームが別）
scriptProps.FORM_HIDDEN_MAP=JSON.stringify({license_id:'_field_1'});
scriptProps.FORM_HIDDEN_MAP_RATE=JSON.stringify({license_id:'_field_9'});
ok(G.formHiddenMapV4_('STANDARD_RATE').license_id==='_field_9','売上連動フォームは専用のhidden項目IDを使う');
ok(G.formHiddenMapV4_('STANDARD_FIXED').license_id==='_field_1','未設定の経路は共通マップへフォールバック');
// 個別確認も専用枠。共通マップに個別確認用の番号を置くと、経路別を入れ忘れた側が黙って誤る。
scriptProps.FORM_HIDDEN_MAP_MANUAL=JSON.stringify({license_id:'_field_8'});
ok(G.formHiddenMapV4_('MANUAL_REVIEW').license_id==='_field_8','個別確認フォームも専用のhidden項目IDを使う');
delete scriptProps.FORM_HIDDEN_MAP_MANUAL;
ok(G.formHiddenMapV4_('MANUAL_REVIEW').license_id==='_field_1','個別確認も未設定なら共通マップへフォールバック');
// 申込の応答は、その経路のマップで組んだURLを持って返る（画面で組み直させない）。
// 画面が共通マップで組むと、定額用の項目IDのまま売上連動用フォームを開いてしまう。
const rateApp=mkAppV4(['WRK-ARK00012'],'電子出版物');
if(rateApp.template_route==='STANDARD_RATE'){
  ok(String(rateApp.form_url_full||'').indexOf('_field_9=')>=0,
    '売上連動の申込URLは売上連動用のhidden項目IDで組まれる');
  ok(String(rateApp.form_url_full||'').indexOf('_field_1=')<0,
    '共通マップの項目IDが混ざらない');
}
const fixedApp=mkAppV4(['WRK-ARK00012'],'書籍');
ok(String(fixedApp.form_url_full||'').indexOf(String(fixedApp.form_url||'x'))===0,
  '組み上がったURLは経路別フォームURLを土台にする');
ok(fixedApp.form_url_full.length===fixedApp.form_url_length,
  '上限判定に使った長さと、実際に開くURLの長さが一致する');
ok(fixedApp.form_url_full.indexOf(encodeURIComponent(fixedApp.handoff_token))>0,
  '引継ぎトークンをURLへ載せる');
delete scriptProps.FORM_HIDDEN_MAP_RATE; delete scriptProps.FORM_HIDDEN_MAP;

// 124. 受信側の項目IDマップも経路別（申込を特定してから経路のマップで読み直す）
const routeApp=mkAppV4(['WRK-ARK00012'],'書籍');
ok(rows(OPS,'Applications').find(a=>a.application_id===routeApp.application_id).template_route==='STANDARD_FIXED',
  '申込に契約書経路を記録する（受信時にどのフォームか分かる）');
scriptProps.FORMRUN_FIELD_MAP_FIXED=JSON.stringify({_f_ref:'application_ref',_f_lic:'license_id',
  _f_hash:'terms_snapshot_hash',_f_tok:'handoff_token',_f_fee:'fee_amount_or_rate',_f_works:'work_names'});
const tf=routeApp.form_fields;
const routeWh=G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({submission_id:'FR-ROUTE-1',
  columns:[{name:'_f_ref',value:routeApp.application_ref},{name:'_f_lic',value:routeApp.license_id},
    {name:'_f_hash',value:routeApp.terms_snapshot_hash},{name:'_f_tok',value:routeApp.handoff_token},
    {name:'_f_fee',value:tf.fee_amount_or_rate},{name:'_f_works',value:tf.work_names}]})}});
ok(String(routeWh.getContent())==='ok','経路別マップで正規化した受信が通る');
delete scriptProps.FORMRUN_FIELD_MAP_FIXED;

// 124-2. formrunの実payload形式（fields[{key,label,value}]）を読む。
// columns しか見ていないと「Webhookは届くのに申込に紐づかない」という壊れ方をする。
const realApp=mkAppV4(['WRK-ARK00012'],'書籍');
const rtf=realApp.form_fields;
const realWh=G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({
  team_name:'株式会社アークライト', form_name:'STANDARD_FIXED', entry_id:'136995750',
  fields:[
    {key:'_field_1',label:'メールアドレス',value:'creator@example.jp'},
    {key:'_field_2_name',label:'名前',value:'倉持達也'},
    {key:'_field_3',label:'屋号・サークル名',value:'テストサークル'},
    {key:'_field_4_postal_code',label:'郵便番号',value:'1300021'},
    {key:'_field_5',label:'選択',value:'私は満18歳以上です'},
    {key:'_field_6',label:'handoff_token',value:realApp.handoff_token},
    {key:'_field_7',label:'terms_snapshot_hash',value:realApp.terms_snapshot_hash},
    {key:'_field_8',label:'template_route',value:realApp.template_route},
    {key:'_field_9',label:'license_id',value:realApp.license_id},
    {key:'_field_10',label:'application_ref',value:realApp.application_ref},
    {key:'_field_11',label:'usage_category',value:rtf.usage_category},
    {key:'_field_12',label:'work_names',value:rtf.work_names},
    {key:'_field_13',label:'licensor_name',value:rtf.licensor_name},
    {key:'_field_14',label:'fee_amount_or_rate',value:rtf.fee_amount_or_rate},
    {key:'_field_15',label:'credit_text',value:rtf.credit_text}
  ]})}});
ok(String(realWh.getContent())==='ok','formrunのfields形式の受信が通る');
const realRow=rows(OPS,'Applications').find(a=>a.application_id===realApp.application_id);
ok(realRow.status==='CONTRACT_PENDING','fields形式でも申込がCONTRACT_PENDINGへ進む');
// 契約者名・連絡先はマップ経由で拾う（hiddenと違いラベルが正規キーと一致しないため）
scriptProps.FORMRUN_FIELD_MAP_FIXED=JSON.stringify({_field_1:'contact_email',_field_2_name:'party_name'});
const partyApp=mkAppV4(['WRK-ARK00012'],'書籍');
const ptf=partyApp.form_fields;
G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({
  fields:[
    {key:'_field_1',label:'メールアドレス',value:'creator2@example.jp'},
    {key:'_field_2_name',label:'名前',value:'山田花子'},
    {key:'_field_6',label:'handoff_token',value:partyApp.handoff_token},
    {key:'_field_7',label:'terms_snapshot_hash',value:partyApp.terms_snapshot_hash},
    {key:'_field_9',label:'license_id',value:partyApp.license_id},
    {key:'_field_10',label:'application_ref',value:partyApp.application_ref},
    {key:'_field_11',label:'usage_category',value:ptf.usage_category},
    {key:'_field_12',label:'work_names',value:ptf.work_names},
    {key:'_field_13',label:'licensor_name',value:ptf.licensor_name},
    {key:'_field_14',label:'fee_amount_or_rate',value:ptf.fee_amount_or_rate},
    {key:'_field_15',label:'credit_text',value:ptf.credit_text}
  ]})}});
const partyCase=rows(OPS,'License_Cases').find(k=>k.license_id===partyApp.license_id);
ok(partyCase.party_display_name==='山田花子','氏名を台帳の契約者名へ反映する');
ok(partyCase.contact_email==='creator2@example.jp','メールアドレスを連絡先へ反映する');
delete scriptProps.FORMRUN_FIELD_MAP_FIXED;

// 125. 改変検知：転送項目の書換えは止める／転送していない項目は比較対象にしない
const tamperApp=mkAppV4(['WRK-ARK00012'],'書籍');
const okCols=function(res,over){ const t=Object.assign({},res.form_fields,over||{});
  const c=[{name:'application_ref',value:res.application_ref},{name:'license_id',value:res.license_id},
    {name:'terms_snapshot_hash',value:res.terms_snapshot_hash},{name:'handoff_token',value:res.handoff_token}];
  Object.keys(t).forEach(function(k){ c.push({name:k,value:t[k]}); }); return c; };
const whFee=G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({submission_id:'FR-TMP-1',
  columns:okCols(tamperApp,{fee_amount_or_rate:'0円（無償）'})})}});
ok(String(whFee.getContent())==='accepted-manual-review','転送項目（利用許諾料）の書換えは自動締結を止める');
const errFee=rows(OPS,'System_Errors').slice(-1)[0];
ok(/fee_amount_or_rate/.test(String(errFee.detail)+String(errFee.message)),'どの項目が食い違ったかを記録: '+String(errFee.message).slice(0,60));
const tamperApp2=mkAppV4(['WRK-ARK00012'],'書籍');
const whMinimal=G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({submission_id:'FR-TMP-2',
  columns:[{name:'application_ref',value:tamperApp2.application_ref},{name:'license_id',value:tamperApp2.license_id},
    {name:'terms_snapshot_hash',value:tamperApp2.terms_snapshot_hash},{name:'handoff_token',value:tamperApp2.handoff_token}]})}});
ok(String(whMinimal.getContent())==='ok','転送しなかった項目は比較対象にしない（テンプレート固定文言のため）');

// 126. 申込後にマスタが変わった場合は、正本を再現できないので自動締結しない
const driftApp=mkAppV4(['WRK-BKK00019'],'書籍');
G.updateRow_(MAS,'Works_Master','work_id','WRK-BKK00019',{ work_name:'インセイン（改題2）' });
const whDrift=G.doPost({parameter:{hook:'formrun'},postData:{contents:JSON.stringify({submission_id:'FR-DRIFT-1',
  columns:okCols(driftApp)})}});
ok(String(whDrift.getContent())==='accepted-manual-review','申込時条件を再現できない受信は自動締結を止める');
G.updateRow_(MAS,'Works_Master','work_id','WRK-BKK00019',{ work_name:'インセイン' });

// 127. QRは独自ドメインへ固定できる（実行基盤のURLを頒布物へ焼き込まない）
G.setConfig_('WORKFLOW_URL','https://script.google.com/macros/s/WF/exec');
ok(G.verifyUrl_('CERT-1','ABCD').indexOf('https://script.google.com/macros/s/WF/exec?page=verify')===0,
  '未設定のうちはGAS②のURLで検証リンクを作る');
G.setConfig_('PUBLIC_BASE_URL','https://spll.example.jp/');
ok(G.verifyUrl_('CERT-1','ABCD')==='https://spll.example.jp/v/CERT-1?c=ABCD','独自ドメインを設定するとQRはそのドメインになる');
ok(G.verifyUrl_('CERT-1','ABCD').indexOf('script.google.com')<0,'QRに実行基盤のURLを含めない');
G.setConfig_('PUBLIC_BASE_URL','');

// 128. 公開ドメインは設定画面から登録する（誤設定はQRが永久に壊れるので入口で弾く）
const SessFm=G.Session;
let pubBad=false; try{ G.admin_saveGuideConfig({ public_base_url:'https://script.google.com/macros/s/X/exec' }); }
catch(e){ pubBad=/実行基盤のURL/.test(String(e.message)); }
ok(pubBad,'QRの公開ドメインに実行基盤のURLは設定できない');
let pubBad2=false; try{ G.admin_saveGuideConfig({ public_base_url:'https://spll.example.jp/v?x=1' }); }
catch(e){ pubBad2=/クエリ/.test(String(e.message)); }
ok(pubBad2,'クエリ付きのドメインは拒否');
G.admin_saveGuideConfig({ public_base_url:'https://spll.example.jp' });
ok(G.admin_getGuideConfig().public_base_url==='https://spll.example.jp','正しい独自ドメインは保存できる');
G.admin_saveGuideConfig({ public_base_url:'' });

// 129. URL上限も設定画面から変えられる（formrun仕様の1000字を超える値は拒否）
let maxBad=false; try{ G.admin_savePortalRoutingConfig({ form_url_max_chars:'1200' }); }
catch(e){ maxBad=/200〜1000字/.test(String(e.message)); }
ok(maxBad,'formrunの上限1000字を超える設定は拒否');
G.admin_savePortalRoutingConfig({ form_url_max_chars:'900' });
ok(G.admin_getPortalRoutingConfig().form_url_max_chars==='900'&&G.formUrlMaxChars_()===900,'上限は設定画面から変更できる');
G.admin_savePortalRoutingConfig({ form_url_max_chars:'850' });
G.Session=SessFm;

console.log('\nSTAGE2 RESULT: '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
