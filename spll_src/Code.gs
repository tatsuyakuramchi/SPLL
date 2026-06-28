/**
 * SPLL システム ― GAS サーバーサイド雛形
 * SPLL-SYS-BD-001 v1.0 / Claude Code 実装用スケルトン
 *
 * デプロイは3つのGASプロジェクトに分割する想定（clasp）:
 *   GAS① 公開入口（doGet=index.html, 作品公開API）          … インターネット公開
 *   GAS② 契約・審査（CloudSign Webhook, Gemini, Drive, 清算） … 限定公開＋Webhook
 *   GAS③ 管理コンソール（doGet=admin.html）                  … 社内GWS限定
 * 本ファイルは共通ライブラリ＋各プロジェクトの関数を1枚に集約した参照実装。
 * 実装時はプロジェクトごとにファイル分割すること。
 *
 * 秘密情報は ScriptProperties（CLOUDSIGN_CLIENT_ID 等）に置き、コミットしない。
 */

// ============================================================
// 0. 設定・共通ヘルパ
// ============================================================
const CFG = {
  SS_MASTER:   'PUT_WORKS_MASTER_SPREADSHEET_ID',   // 作品マスタ
  SS_OPS:      'PUT_OPS_SPREADSHEET_ID',            // 業務台帳
  DRIVE_ROOT:  'PUT_SHARED_DRIVE_FOLDER_ID',        // 契約別フォルダの親
  GEMINI_MODEL:'gemini-2.5-flash',                  // 実装時にGAモデルを確認
  GCP_PROJECT: 'PUT_GCP_PROJECT_ID',
  GCP_REGION:  'us-central1',                       // データ所在地要件を確認
  OBJECTION_DAYS_RULE: 'EFFECTIVE_PLUS_1_MONTH',    // 計算書みなし確認：発効日＋1ヶ月
  RETENTION_DAYS_REJECTED: 365,                     // A経路落選データ保有：1年
};
function prop_(k){ return PropertiesService.getScriptProperties().getProperty(k); }
function ssMaster_(){ return SpreadsheetApp.openById(CFG.SS_MASTER); }
function ssOps_(){ return SpreadsheetApp.openById(CFG.SS_OPS); }
function sheet_(ss, name){ return ss.getSheetByName(name); }

/** シートを連想配列の配列で読む（1行目をヘッダとみなす） */
function readRows_(ss, name){
  const sh = sheet_(ss, name); if(!sh) return [];
  const v = sh.getDataRange().getValues(); if(v.length < 2) return [];
  const head = v[0];
  return v.slice(1).map(r => head.reduce((o,k,i)=>(o[k]=r[i],o),{}));
}
/** 1行追記（objのキーをヘッダに突合） */
function appendRow_(ss, name, obj){
  const sh = sheet_(ss, name);
  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  sh.appendRow(head.map(k => obj[k] !== undefined ? obj[k] : ''));
}
/** 主キー一致行を更新 */
function updateRow_(ss, name, keyCol, keyVal, patch){
  const sh = sheet_(ss, name);
  const data = sh.getDataRange().getValues(); const head = data[0];
  const kc = head.indexOf(keyCol);
  for(let i=1;i<data.length;i++){
    if(String(data[i][kc])===String(keyVal)){
      head.forEach((k,c)=>{ if(patch[k]!==undefined) sh.getRange(i+1,c+1).setValue(patch[k]); });
      return true;
    }
  }
  return false;
}
/** ID採番： PREFIX-YYYYMM-#### */
function newId_(prefix){
  const ym = Utilities.formatDate(new Date(), 'JST', 'yyyyMM');
  const key = prefix+'-'+ym;
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  const sp = PropertiesService.getScriptProperties();
  const n = (parseInt(sp.getProperty(key)||'0',10)+1);
  sp.setProperty(key, String(n)); lock.releaseLock();
  return `${prefix}-${ym}-${String(n).padStart(4,'0')}`;
}
function logEvent_(entityType, entityId, actor, before, after){
  appendRow_(ssOps_(), 'Events', {
    event_id: Utilities.getUuid(), entity_type: entityType, entity_id: entityId,
    actor: actor||'system', before: JSON.stringify(before||''), after: JSON.stringify(after||''),
    occurred_at: new Date().toISOString()
  });
}

// ============================================================
// 1. GAS① 公開入口Webアプリ
// ============================================================
function doGet(e){
  // プロジェクトごとに出し分け（GAS①=index, GAS③=admin, 利用報告=report?token=）
  const page = (e && e.parameter && e.parameter.page) || 'index';
  if(page === 'report') return serveReport_(e);             // 利用報告（トークン）
  if(page === 'upload') return serveUpload_(e);             // 作品提出（トークン）
  if(page === 'admin')  return HtmlService.createHtmlOutputFromFile('admin').setTitle('SPLL 管理コンソール');
  return HtmlService.createHtmlOutputFromFile('index').setTitle('SPLL 利用申込窓口');
}

/** 作品公開API：公開承認済み・期間内の作品だけ返す（内部メモ・配分は返さない） */
function api_listWorks(){
  return readRows_(ssMaster_(), 'Works_Master')
    .filter(w => w.publish_status === 'PUBLISHED')
    .map(w => ({
      id:w.work_id, name:w.work_name, pub:w.publisher, cat:w.category,
      timing:w.review_timing,                 // 内部属性：UIではバッジに出さない
      fee:w.fee_label, media:String(w.media||'').split(',').filter(Boolean),
      ok:String(w.ok_elements||'').split(',').filter(Boolean),
      no:String(w.no_elements||'').split(',').filter(Boolean),
      credit:w.credit_text, policy:w.review_policy
    }));
}
function api_getWork(workId){ return api_listWorks().find(w=>w.id===workId) || null; }

// ============================================================
// 2. 申込 → Applications 書き出し（D-11）
// ============================================================
/**
 * FormRun申込の受け口。FormRunのWebhook(doPost)またはGAS①からの送信を受ける。
 * A経路：作品提出を伴う（Drive一時保存→審査Job）。B経路：CloudSign送信へ。
 */
function createApplication_(payload){
  const work = api_getWork(payload.work_id);
  const appId = newId_('APP');
  appendRow_(ssOps_(), 'Applications', {
    application_id: appId, work_id: payload.work_id, review_timing: work.timing,
    applicant_email: payload.email, applicant_name: payload.name,
    status: 'RECEIVED',
    retention_until: '',           // A-FAIL確定時に new Date()+365d をセット
    created_at: new Date().toISOString()
  });
  logEvent_('application', appId, payload.email, null, {status:'RECEIVED'});
  if(work.timing === 'A'){
    // A経路：作品をDrive一時保存→AI審査Job作成（審査後にリンク送付制御）
    enqueueAiReview_({applicationId:appId, fileId:payload.file_id, work});
  } else {
    // B経路：CloudSign APIで送信→締結
    cloudSignSend_({applicationId:appId, payload, work});
    updateRow_(ssOps_(),'Applications','application_id',appId,{status:'SENT'});
  }
  return appId;
}

// ============================================================
// 3. CloudSign API 送信・締結Webhook（D-11）
// ============================================================
/** CloudSign APIで契約書を作成・送信（実装時に最新のAPI仕様を確認） */
function cloudSignSend_(ctx){
  const token = cloudSignAccessToken_();
  // TODO: documents作成 → 当事者(受信者)設定 → テンプレ差込 → send
  // const res = UrlFetchApp.fetch('https://api.cloudsign.jp/documents', {...});
  // CloudSignのdocument_idをApplicationsへ控える
  // updateRow_(ssOps_(),'Applications','application_id',ctx.applicationId,{cloudsign_document_id: docId});
}
function cloudSignAccessToken_(){
  const clientId = prop_('CLOUDSIGN_CLIENT_ID');
  // TODO: OAuth client_credentials等でアクセストークン取得
  return 'TODO';
}
/** 締結完了Webhook（doPost）：締結有無をContractsへ書き戻す（D-11） */
function doPost(e){
  const body = JSON.parse(e.postData.contents || '{}');
  // documentID＋event種別で重複排除
  const docId = body.document_id, event = body.event_type;
  if(event !== 'COMPLETED') return ContentService.createTextOutput('ignored');
  if(isDuplicateWebhook_(docId, event)) return ContentService.createTextOutput('dup');

  const app = readRows_(ssOps_(),'Applications').find(a=>a.cloudsign_document_id===docId);
  const contractId = newId_('CTR');
  appendRow_(ssOps_(),'Contracts',{
    contract_id: contractId, cloudsign_document_id: docId,
    application_id: app ? app.application_id : '', work_id: app ? app.work_id : '',
    review_timing: app ? app.review_timing : '',
    status: 'SIGNED', signed_at: new Date().toISOString(),
    folder_id: createContractFolder_(contractId)
  });
  if(app) updateRow_(ssOps_(),'Applications','application_id',app.application_id,{status:'SIGNED'});
  logEvent_('contract', contractId, 'cloudsign', null, {status:'SIGNED'});

  // B経路：締結後に作品審査用アップロードリンクを送付（全員一択）
  if(app && app.review_timing === 'B') sendUploadLink_(contractId, app.applicant_email);
  return ContentService.createTextOutput('ok');
}
function isDuplicateWebhook_(docId, event){
  const key = 'WH_'+docId+'_'+event;
  if(prop_(key)) return true;
  PropertiesService.getScriptProperties().setProperty(key,'1'); return false;
}

// ============================================================
// 4. Drive 提出・Gemini 一次審査
// ============================================================
function createContractFolder_(contractId){
  const root = DriveApp.getFolderById(CFG.DRIVE_ROOT);
  const f = root.createFolder(contractId);
  ['01_Contract','02_Submissions','03_AI_Reviews','04_Human_Reviews','05_Usage_Reports','06_Settlements']
    .forEach(n=>f.createFolder(n));
  return f.getId();
}
function sendUploadLink_(contractId, email){
  const token = Utilities.getUuid();
  appendRow_(ssOps_(),'Upload_Tokens',{ token_id:Utilities.getUuid(), contract_id:contractId,
    token_hash: hash_(token), status:'OPEN', expires_at: addDaysIso_(14) });
  const url = ScriptApp.getService().getUrl()+'?page=upload&token='+token;
  MailApp.sendEmail(email, 'SPLL 作品提出のご案内', '提出はこちら: '+url);
}
function enqueueAiReview_(ctx){
  const aiId = newId_('AIR');
  appendRow_(ssOps_(),'AI_Review_Jobs',{ ai_review_id:aiId, application_id:ctx.applicationId||'',
    submission_id:ctx.submissionId||'', model:CFG.GEMINI_MODEL, status:'QUEUED', retry_count:0 });
  // 時間主導トリガー or 即時で runAiReview_(aiId)
}
/** Vertex AI Gemini 一次審査（response schema 指定・構造化出力） */
function geminiReview_(fileBlob, rules){
  const url = `https://${CFG.GCP_REGION}-aiplatform.googleapis.com/v1/projects/${CFG.GCP_PROJECT}/locations/${CFG.GCP_REGION}/publishers/google/models/${CFG.GEMINI_MODEL}:generateContent`;
  const payload = {
    contents:[{ role:'user', parts:[
      { text: buildReviewPrompt_(rules) },
      { inlineData:{ mimeType:fileBlob.getContentType(), data:Utilities.base64Encode(fileBlob.getBytes()) } }
    ]}],
    generationConfig:{ responseMimeType:'application/json', responseSchema: REVIEW_SCHEMA }
  };
  const res = UrlFetchApp.fetch(url, { method:'post', contentType:'application/json',
    headers:{ Authorization:'Bearer '+ScriptApp.getOAuthToken() },
    payload: JSON.stringify(payload), muteHttpExceptions:true });
  return JSON.parse(res.getContentText());
}
const REVIEW_SCHEMA = { type:'object', properties:{
  overall_result:{ type:'string', enum:['PASS_CANDIDATE','REVIEW_REQUIRED','HIGH_RISK','UNREADABLE'] },
  risk_score:{ type:'integer' }, human_review_required:{ type:'boolean' },
  findings:{ type:'array', items:{ type:'object', properties:{
    rule_id:{type:'string'}, severity:{type:'string'}, result:{type:'string'},
    page:{type:'integer'}, evidence:{type:'string'}, recommended_action:{type:'string'}, confidence:{type:'number'}
  }}}
}};
function buildReviewPrompt_(rules){
  return [
    'あなたは審査者ではなく一次スクリーナーです。根拠箇所を示し、不明は不明としてください。',
    '次の作品別ルールと契約条件に対する適合候補・要確認・高リスク候補を抽出してください。',
    JSON.stringify(rules)
  ].join('\n');
}

// ============================================================
// 5. 利用報告ページ（D-13・トークンアクセス）
// ============================================================
function serveReport_(e){
  const t = HtmlService.createTemplateFromFile('report');
  t.token = (e.parameter && e.parameter.token) || '';
  return t.evaluate().setTitle('SPLL 利用報告');
}
/** クライアントから google.script.run で呼ぶ：契約情報の取得 */
function report_getContext(token){
  const tok = readRows_(ssOps_(),'Upload_Tokens').find(x=>x.token_hash===hash_(token) && x.status==='OPEN');
  if(!tok) throw new Error('invalid token');
  const c = readRows_(ssOps_(),'Contracts').find(x=>x.contract_id===tok.contract_id);
  const w = api_getWork(c.work_id);
  return { contract_id:c.contract_id, work:w.name, fee:w.fee, period:currentPeriod_() };
}
/** 利用報告の登録 → Usage_Reports */
function report_submit(token, data){
  const tok = readRows_(ssOps_(),'Upload_Tokens').find(x=>x.token_hash===hash_(token) && x.status==='OPEN');
  if(!tok) throw new Error('invalid token');
  const reportId = newId_('RPT');
  const net = Math.max(0,(+data.gross||0)-(+data.returns||0)-(+data.deductions||0));
  appendRow_(ssOps_(),'Usage_Reports',{ report_id:reportId, contract_id:tok.contract_id,
    period:data.period, channel:data.channel, qty:data.qty, gross_sales:data.gross,
    returns:data.returns, deductions:data.deductions, net_sales:net, sales_url:data.url,
    status:'SUBMITTED', submitted_at:new Date().toISOString() });
  logEvent_('usage_report', reportId, 'licensee', null, {status:'SUBMITTED'});
  return reportId;
}

/** 作品提出ページ（トークン）：B経路締結後のアップロード受け口 */
function serveUpload_(e){
  const t = HtmlService.createTemplateFromFile('report');   // 暫定：提出UIはreportに集約 or upload.htmlを追加
  t.token = (e.parameter && e.parameter.token) || '';
  return t.evaluate().setTitle('SPLL 作品提出');
}

// ============================================================
// 6. GAS③ 管理コンソール（D-12）― google.script.run で呼ぶ
// ============================================================
function admin_dashboard(){
  const subs = readRows_(ssOps_(),'AI_Review_Jobs');
  const contracts = readRows_(ssOps_(),'Contracts');
  const payments = readRows_(ssOps_(),'Payments');
  const reports = readRows_(ssOps_(),'Usage_Reports');
  return {
    review: subs.filter(s=>s.status==='COMPLETED').length,   // 詳細はAI_Findingsで分類
    signing: contracts.filter(c=>c.status!=='SIGNED').length,
    unpaid: payments.filter(p=>p.status==='入金待ち').length,
    reporting: reports.filter(r=>r.status!=='SUBMITTED').length
  };
}
function admin_reviewQueue(){ return readRows_(ssOps_(),'AI_Findings'); }
function admin_setHumanReview(submissionId, result, reviewer, comment){
  appendRow_(ssOps_(),'Human_Reviews',{ human_review_id:newId_('HRV'), submission_id:submissionId,
    reviewer:reviewer, result:result, comments:comment, reviewed_at:new Date().toISOString() });
  logEvent_('human_review', submissionId, reviewer, null, {result});
}
function admin_listContracts(){ return readRows_(ssOps_(),'Contracts'); }
function admin_recordPayment(contractId, invoiceId, amount, paidAt, recordedBy){
  appendRow_(ssOps_(),'Payments',{ payment_id:newId_('PAY'), invoice_id:invoiceId, contract_id:contractId,
    amount:amount, paid_at:paidAt, status:'入金済', recorded_by:recordedBy });
  if(invoiceId) updateRow_(ssOps_(),'Invoices','invoice_id',invoiceId,{status:'入金済'});
  logEvent_('payment', contractId, recordedBy, null, {amount, paid_at:paidAt});
}

// ============================================================
// 7. 半期清算・計算書（仕入明細書方式・みなし合意）
// ============================================================
/** 半期バッチ：APPROVED/LOCKEDの報告を集計→計算書（DRAFT）生成 */
function batch_generateStatements(period){
  // TODO: Usage_Reports集計→11.1計算チェーン→スナップショット→Settlement_Statements(DRAFT)
  // 承認後 batch_sendStatement_() でCloudSign送信（みなし合意付き、発効日＋1ヶ月）
}
/** 日次：異議期間（発効日＋1ヶ月）到来かつ無申出を CONFIRMED へ */
function batch_confirmDeemed(){
  const now = new Date();
  readRows_(ssOps_(),'Settlement_Statements')
    .filter(s=>s.status==='SENT' && new Date(s.objection_due) <= now)
    .forEach(s=> updateRow_(ssOps_(),'Settlement_Statements','statement_id',s.statement_id,
      {status:'CONFIRMED', confirmed_at: now.toISOString()}));
}

// ============================================================
// 8. 定期処理・データ削除
// ============================================================
/** A経路落選データの保有1年・自動削除（Q-04） */
function batch_purgeRejected(){
  const now = new Date();
  readRows_(ssOps_(),'Applications')
    .filter(a=>a.status==='REJECTED' && a.retention_until && new Date(a.retention_until)<=now)
    .forEach(a=>{ /* TODO: Drive一時ファイル削除＋行マスク */ logEvent_('application',a.application_id,'system',{status:'REJECTED'},{purged:true}); });
}

// ---- utils ----
function hash_(s){ return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)); }
function addDaysIso_(d){ const t=new Date(); t.setDate(t.getDate()+d); return t.toISOString(); }
function currentPeriod_(){ const d=new Date(); return d.getFullYear()+(d.getMonth()<6?'H1':'H2'); }
