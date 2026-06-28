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
/** 設定値の解決：ScriptProperties を優先し、無ければ CFG の既定値にフォールバック */
function cfg_(k){ return prop_(k) || CFG[k]; }
function ssMaster_(){ return SpreadsheetApp.openById(cfg_('SS_MASTER')); }
function ssOps_(){ return SpreadsheetApp.openById(cfg_('SS_OPS')); }
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

/** 公開：同意文（個人情報）・規約テンプレートを返す（管理コンソールから編集可能） */
function api_getLegalTexts(){
  return {
    privacy:       getConfig_('LEGAL_PRIVACY_TEXT', DEFAULT_PRIVACY),
    termsTemplate: getConfig_('LEGAL_TERMS_TEMPLATE', DEFAULT_TERMS_TEMPLATE)
  };
}

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
  const secret   = prop_('CLOUDSIGN_SECRET');
  if(!clientId || !secret) throw new Error('CloudSign未設定：管理コンソール「設定」から登録してください');
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
  const root = DriveApp.getFolderById(cfg_('DRIVE_ROOT'));
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
  ctx = ctx || {};
  let submissionId = ctx.submissionId || '';
  // 提出ファイルがあれば Submission / Submission_File を用意（A経路は申込時に作品提出）
  if(ctx.fileId && !submissionId){
    submissionId = newId_('SUB');
    appendRow_(ssOps_(),'Submissions',{ submission_id:submissionId,
      application_id:ctx.applicationId||'', contract_id:ctx.contractId||'',
      submission_no:1, status:'SUBMITTED', submitted_at:new Date().toISOString() });
    const meta = fileMeta_(ctx.fileId);
    appendRow_(ssOps_(),'Submission_Files',{ submission_file_id:newId_('SBF'),
      submission_id:submissionId, drive_file_id:ctx.fileId, sha256:meta.sha256, mime:meta.mime, size:meta.size });
  }
  const aiId = newId_('AIR');
  appendRow_(ssOps_(),'AI_Review_Jobs',{ ai_review_id:aiId, application_id:ctx.applicationId||'',
    submission_id:submissionId, model:cfg_('GEMINI_MODEL'), prompt_version:AI_PROMPT_VERSION, status:'QUEUED', retry_count:0 });
  logEvent_('ai_review', aiId, 'system', null, {status:'QUEUED'});
  // 即時実行を試行（失敗時はQUEUEDのまま batch_runAiReviews_ が再試行）
  try{ runAiReview_(aiId); }catch(e){ /* バッチ再試行に委ねる */ }
  return aiId;
}
/** Vertex AI Gemini 一次審査（response schema 指定・構造化出力） */
function geminiReview_(fileBlob, rules){
  const region=cfg_('GCP_REGION'), project=cfg_('GCP_PROJECT'), model=cfg_('GEMINI_MODEL');
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:generateContent`;
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
  const code = res.getResponseCode();
  if(code < 200 || code >= 300) throw new Error('Gemini HTTP '+code+': '+res.getContentText());
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

// ---- 4.1 AI審査ジョブ実行（runAiReview_） ----
const AI_PROMPT_VERSION = 'v1';
const AI_MAX_RETRY = 3;

/** QUEUEDのAI審査ジョブをまとめて実行（時間主導トリガー想定） */
function batch_runAiReviews_(){
  const jobs = readRows_(ssOps_(),'AI_Review_Jobs')
    .filter(j => j.status==='QUEUED' && (parseInt(j.retry_count||'0',10)||0) < AI_MAX_RETRY);
  let completed = 0;
  jobs.forEach(j => { try{ runAiReview_(j.ai_review_id); completed++; }catch(e){ /* 失敗はジョブ内で記録 */ } });
  return { processed: jobs.length, completed: completed };
}

/** 1件のAI審査を実行：ファイル取得→Gemini→Findings記録→経路別ルーティング */
function runAiReview_(aiReviewId){
  const job = readRows_(ssOps_(),'AI_Review_Jobs').find(j => j.ai_review_id===aiReviewId);
  if(!job) throw new Error('AI review job not found: '+aiReviewId);
  if(job.status==='COMPLETED') return 'COMPLETED';          // 冪等
  updateRow_(ssOps_(),'AI_Review_Jobs','ai_review_id',aiReviewId,{status:'SCANNING'});
  try{
    const blob = resolveSubmissionBlob_(job);
    if(!blob) throw new Error('提出ファイルが見つかりません');
    const work  = resolveJobWork_(job);
    const rules = buildRules_(work);
    const parsed = parseGeminiResult_(geminiReview_(blob, rules));   // 個人情報は送らず作品＋条件のみ
    writeFindings_(aiReviewId, parsed.findings);
    const overall = parsed.overall_result
      || (parsed.findings.length ? worstResult_(parsed.findings.map(f => ({severity:f.severity, result:f.result}))) : 'REVIEW_REQUIRED');
    updateRow_(ssOps_(),'AI_Review_Jobs','ai_review_id',aiReviewId,{status:'COMPLETED'});
    logEvent_('ai_review', aiReviewId, 'gemini', null, {overall_result:overall, findings:parsed.findings.length});
    postReviewRouting_(job, overall);
    return overall;
  }catch(err){
    const retry  = (parseInt(job.retry_count||'0',10)||0) + 1;
    const status = retry >= AI_MAX_RETRY ? 'ERROR' : 'QUEUED';
    updateRow_(ssOps_(),'AI_Review_Jobs','ai_review_id',aiReviewId,{status:status, retry_count:retry});
    logEvent_('ai_review', aiReviewId, 'system', null, {error:String(err), retry_count:retry, status:status});
    throw err;
  }
}

/** ジョブの提出ファイル（先頭）をBlobで取得。作品ファイルのみで個人情報は含めない。 */
function resolveSubmissionBlob_(job){
  if(!job.submission_id) return null;
  const f = readRows_(ssOps_(),'Submission_Files').find(x => String(x.submission_id)===String(job.submission_id));
  if(!f || !f.drive_file_id) return null;
  return DriveApp.getFileById(f.drive_file_id).getBlob();
}

/** ジョブ対象の作品（Works_Masterの行）を解決（A=申込, B=提出→契約 経由） */
function resolveJobWork_(job){
  let workId = '';
  if(job.application_id){
    const a = readRows_(ssOps_(),'Applications').find(x => x.application_id===job.application_id);
    if(a) workId = a.work_id;
  }
  if(!workId && job.submission_id){
    const s = readRows_(ssOps_(),'Submissions').find(x => x.submission_id===job.submission_id);
    if(s && s.contract_id){
      const c = readRows_(ssOps_(),'Contracts').find(x => x.contract_id===s.contract_id);
      if(c) workId = c.work_id;
    }
  }
  return readRows_(ssMaster_(),'Works_Master').find(w => w.work_id===workId) || { work_id:workId };
}

/** 作品別ルール＋契約条件を構造化（個人情報は含めない） */
function buildRules_(work){
  const rules = readRows_(ssMaster_(),'Review_Rules')
    .filter(r => r.work_id===work.work_id && ruleActive_(r))
    .map(r => ({ rule_id:r.rule_id, category:r.category, text:r.rule_text, severity:r.severity }));
  return {
    work_id: work.work_id || '',
    work_name: work.work_name || '',
    allowed_elements: csv_(work.ok_elements),
    prohibited_elements: csv_(work.no_elements),
    required_credit: work.credit_text || '',
    allowed_media: csv_(work.media),
    rules: rules
  };
}
function ruleActive_(r){
  const now = new Date();
  if(r.effective_from && new Date(r.effective_from) > now) return false;
  if(r.effective_to   && new Date(r.effective_to)   < now) return false;
  return true;
}
function csv_(v){ return String(v||'').split(',').map(s => s.trim()).filter(Boolean); }

/** Vertex生レスポンスから構造化結果(JSON)を取り出す */
function parseGeminiResult_(raw){
  let obj = raw;
  try{
    if(raw && raw.candidates && raw.candidates[0]){
      const parts = raw.candidates[0].content && raw.candidates[0].content.parts;
      const text  = parts && parts[0] && parts[0].text;
      if(text) obj = JSON.parse(text);
    }
  }catch(e){ /* 解析失敗時は空扱い → REVIEW_REQUIRED に倒す */ }
  if(!obj || typeof obj !== 'object') obj = {};
  if(!Array.isArray(obj.findings)) obj.findings = [];
  return obj;
}

/** Findings を AI_Findings へ記録 */
function writeFindings_(aiReviewId, findings){
  (findings||[]).forEach(f => appendRow_(ssOps_(),'AI_Findings',{
    finding_id: newId_('FND'), ai_review_id: aiReviewId,
    rule_id: f.rule_id||'', severity: f.severity||'', result: f.result||'',
    page: f.page||'', evidence: f.evidence||'', confidence: f.confidence||''
  }));
}

/** 総合結果に応じた経路別処理（A=締結リンク制御／B=コンプラ・アラート） */
function postReviewRouting_(job, overall){
  const high = (overall==='HIGH_RISK' || overall==='UNREADABLE');
  if(job.application_id){
    // A経路：審査後に契約リンク送付可否を決定
    const appId = job.application_id;
    updateRow_(ssOps_(),'Applications','application_id',appId,{status:'AI_SCREENED'});
    if(high){
      const until = addDaysIso_(CFG.RETENTION_DAYS_REJECTED);   // 落選データは1年保有→自動削除
      updateRow_(ssOps_(),'Applications','application_id',appId,{status:'REJECTED', retention_until:until});
      logEvent_('application', appId, 'system', {status:'AI_SCREENED'}, {status:'REJECTED', overall_result:overall});
    }else{
      // PASS候補／要確認 → 契約リンク（CloudSign）送付
      const app = readRows_(ssOps_(),'Applications').find(a => a.application_id===appId);
      if(app) sendContractForApplication_(app);
      updateRow_(ssOps_(),'Applications','application_id',appId,{status:'LINK_SENT'});
      logEvent_('application', appId, 'system', {status:'AI_SCREENED'}, {status:'LINK_SENT', overall_result:overall});
    }
  }else{
    // B経路：締結後審査。高リスクはアラート起票（既発生のパートナー配分は当然には消滅させない）
    if(high) createComplianceAlert_(job.submission_id, overall);
  }
}

/** A経路：審査通過後のCloudSign契約送信 */
function sendContractForApplication_(app){
  cloudSignSend_({ applicationId: app.application_id,
    payload: { email: app.applicant_email, name: app.applicant_name }, work: api_getWork(app.work_id) });
}

/** コンプライアンス・アラート起票（settlement_block空＝清算は止めない） */
function createComplianceAlert_(submissionId, overall){
  const sub = readRows_(ssOps_(),'Submissions').find(s => s.submission_id===submissionId) || {};
  appendRow_(ssOps_(),'Compliance_Alerts',{ alert_id:newId_('ALR'),
    contract_id: sub.contract_id||'', submission_id: submissionId||'',
    severity:'HIGH', status:'OPEN', settlement_block:'' });
  logEvent_('compliance_alert', submissionId, 'system', null, {severity:'HIGH', overall_result:overall});
}

/** Drive上のファイルのメタ情報（sha256/mime/size） */
function fileMeta_(fileId){
  try{
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    return { mime: blob.getContentType(), size: file.getSize(), sha256: sha256Bytes_(blob.getBytes()) };
  }catch(e){ return { mime:'', size:'', sha256:'' }; }
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
// ---- 結合・分類ヘルパ ----
function worksNameMap_(){
  const m = {}; readRows_(ssMaster_(), 'Works_Master').forEach(w => { m[w.work_id] = w.work_name; });
  return m;
}
function isHighRisk_(r){ return /HIGH/i.test(String(r.severity)) || /HIGH_RISK/i.test(String(r.result)); }
function sevRank_(f){
  const s = String(f.severity||'').toUpperCase(), r = String(f.result||'').toUpperCase();
  if(s.indexOf('HIGH')>=0 || r.indexOf('HIGH')>=0) return 3;
  if(s.indexOf('MED')>=0  || r.indexOf('REVIEW')>=0) return 2;
  if(s) return 1; return 0;
}
/** ジョブ配下のFindingsから総合結果を決める（最悪を優先） */
function worstResult_(findings){
  if(!findings.length) return 'PASS_CANDIDATE';
  const max = Math.max.apply(null, findings.map(sevRank_));
  if(max>=3) return 'HIGH_RISK';
  if(max>=2) return 'REVIEW_REQUIRED';
  return 'PASS_CANDIDATE';
}

/** ダッシュボード：6KPI＋直近の要対応（作品名を結合） */
function admin_dashboard(){
  const jobs      = readRows_(ssOps_(),'AI_Review_Jobs');
  const findings  = readRows_(ssOps_(),'AI_Findings');
  const contracts = readRows_(ssOps_(),'Contracts');
  const apps      = readRows_(ssOps_(),'Applications');
  const invoices  = readRows_(ssOps_(),'Invoices');
  const reports   = readRows_(ssOps_(),'Usage_Reports');
  const alerts    = readRows_(ssOps_(),'Compliance_Alerts');
  const human     = readRows_(ssOps_(),'Human_Reviews');
  const nameMap   = worksNameMap_();
  const ctrWork   = {}; contracts.forEach(c => { ctrWork[c.contract_id] = c.work_id; });
  const cleared   = {}; human.filter(h=>h.result==='CLEARED').forEach(h => { cleared[String(h.submission_id)] = true; });

  const kpis = {
    reviewPending: jobs.filter(j => j.status==='COMPLETED' && !cleared[String(j.submission_id||j.application_id)]).length,
    highRisk:      findings.filter(isHighRisk_).length,
    unscreened:    jobs.filter(j => j.status==='QUEUED' || j.status==='SCANNING').length,
    signing:       contracts.filter(c => c.status && c.status!=='SIGNED' && c.status!=='DECLINED' && c.status!=='CANCELLED').length
                   + apps.filter(a => a.status==='SENT').length,
    unpaid:        invoices.filter(v => v.status && v.status!=='入金済' && v.status!=='取消').length,
    reporting:     reports.filter(r => r.status && r.status!=='SUBMITTED' && r.status!=='APPROVED' && r.status!=='LOCKED').length
  };

  const rows = [];
  alerts.filter(a => a.status!=='CLOSED').forEach(a => rows.push({
    kind:'審査', target:a.submission_id||a.contract_id||'', work:nameMap[ctrWork[a.contract_id]]||'',
    status:String(a.severity||'ALERT'), cls:isHighRisk_(a)?'fail':'review', at:String(a.occurred_at||'')
  }));
  contracts.filter(c => c.status==='SENT').forEach(c => rows.push({
    kind:'契約', target:c.contract_id, work:nameMap[c.work_id]||'', status:'締結待ち', cls:'wait', at:String(c.signed_at||'')
  }));
  invoices.filter(v => v.status==='入金待ち').forEach(v => rows.push({
    kind:'入金', target:v.contract_id, work:nameMap[ctrWork[v.contract_id]]||'', status:'入金待ち', cls:'unpaid', at:String(v.issued_at||'')
  }));
  rows.sort((a,b) => String(b.at).localeCompare(String(a.at)));
  return { kpis: kpis, alerts: rows.slice(0,8) };
}

/** 審査キュー：ジョブ単位に総合結果・経路(A/B)・主指摘・作品名を結合 */
function admin_reviewQueue(){
  const jobs      = readRows_(ssOps_(),'AI_Review_Jobs');
  const findings  = readRows_(ssOps_(),'AI_Findings');
  const apps      = readRows_(ssOps_(),'Applications');
  const subs      = readRows_(ssOps_(),'Submissions');
  const contracts = readRows_(ssOps_(),'Contracts');
  const nameMap   = worksNameMap_();
  const appById   = {}; apps.forEach(a => { appById[a.application_id] = a; });
  const subById   = {}; subs.forEach(s => { subById[s.submission_id] = s; });
  const ctrWork   = {}; contracts.forEach(c => { ctrWork[c.contract_id] = c.work_id; });

  return jobs.map(j => {
    const fs = findings.filter(f => f.ai_review_id===j.ai_review_id);
    const top = fs.slice().sort((a,b)=>sevRank_(b)-sevRank_(a))[0];
    const timing = j.application_id ? 'A' : 'B';        // A=締結前提出 / B=締結後提出
    let workId = '';
    if(j.application_id && appById[j.application_id]) workId = appById[j.application_id].work_id;
    else if(j.submission_id && subById[j.submission_id]) workId = ctrWork[subById[j.submission_id].contract_id];
    return {
      id: j.submission_id || j.application_id || j.ai_review_id,
      ai_review_id: j.ai_review_id,
      work: nameMap[workId] || '',
      timing: timing,
      job_status: j.status,
      result: j.status==='COMPLETED' ? worstResult_(fs) : (j.status||'QUEUED'),
      finding: top ? String(top.evidence||top.result||'') : ''
    };
  });
}

/** 人手判断の記録（CLEARED / CORRECTION_REQUIRED / ESCALATED） */
function admin_setHumanReview(submissionId, result, comment, reviewer){
  reviewer = reviewer || actor_();
  appendRow_(ssOps_(),'Human_Reviews',{ human_review_id:newId_('HRV'), submission_id:submissionId,
    reviewer:reviewer, result:result, comments:comment||'', reviewed_at:new Date().toISOString() });
  logEvent_('human_review', submissionId, reviewer, null, {result:result});
  return true;
}

/** 契約一覧：締結済(Contracts)＋締結待ち(Applications status=SENT)を結合、契約者名はマスク */
function admin_listContracts(){
  const contracts = readRows_(ssOps_(),'Contracts');
  const apps      = readRows_(ssOps_(),'Applications');
  const nameMap   = worksNameMap_();
  const rows = contracts.map(c => ({
    contract_id:c.contract_id, application_id:c.application_id, work:nameMap[c.work_id]||'',
    applicant:'＊＊＊＊（個人）', status:c.status||'', signed_at:String(c.signed_at||'')
  }));
  const contracted = {}; contracts.forEach(c => { contracted[c.application_id] = true; });
  apps.filter(a => a.status==='SENT' && !contracted[a.application_id]).forEach(a => rows.push({
    contract_id:'—', application_id:a.application_id, work:nameMap[a.work_id]||'',
    applicant:'＊＊＊＊（個人）', status:'送信済・締結待ち', signed_at:''
  }));
  return rows;
}

/** B経路：締結済契約へ作品提出リンクを送付 */
function admin_sendUploadLink(contractId){
  const c = readRows_(ssOps_(),'Contracts').find(x => x.contract_id===contractId);
  if(!c) throw new Error('契約が見つかりません: '+contractId);
  const a = readRows_(ssOps_(),'Applications').find(x => x.application_id===c.application_id);
  if(!a || !a.applicant_email) throw new Error('申込メールが見つかりません');
  sendUploadLink_(contractId, a.applicant_email);
  logEvent_('contract', contractId, actor_(), null, {upload_link_sent:true});
  return true;
}

/** 入金管理：請求(Invoices)に入金(Payments)状況・作品名を結合 */
function admin_listPayments(){
  const invoices  = readRows_(ssOps_(),'Invoices');
  const payments  = readRows_(ssOps_(),'Payments');
  const contracts = readRows_(ssOps_(),'Contracts');
  const nameMap   = worksNameMap_();
  const ctrWork   = {}; contracts.forEach(c => { ctrWork[c.contract_id] = c.work_id; });
  return invoices.map(v => {
    const pay = payments.find(p => String(p.invoice_id)===String(v.invoice_id) && p.status==='入金済');
    return {
      invoice_id:v.invoice_id, contract_id:v.contract_id, work:nameMap[ctrWork[v.contract_id]]||'',
      amount:String(v.amount||v.amount_rule||''), status: pay ? '入金済' : (v.status||'入金待ち'),
      paid_at: pay ? String(pay.paid_at||'') : ''
    };
  });
}

/** 入金記録（結果入力）。recordedBy/paidAt は未指定なら補完。 */
function admin_recordPayment(contractId, invoiceId, amount, paidAt, recordedBy){
  recordedBy = recordedBy || actor_();
  paidAt = paidAt || new Date().toISOString().slice(0,10);
  appendRow_(ssOps_(),'Payments',{ payment_id:newId_('PAY'), invoice_id:invoiceId, contract_id:contractId,
    amount:amount, paid_at:paidAt, status:'入金済', recorded_by:recordedBy });
  if(invoiceId) updateRow_(ssOps_(),'Invoices','invoice_id',invoiceId,{status:'入金済'});
  logEvent_('payment', contractId, recordedBy, null, {amount:amount, paid_at:paidAt});
  return true;
}

/** 入金の取消（請求は入金待ちへ戻す） */
function admin_voidPayment(invoiceId){
  const pays = readRows_(ssOps_(),'Payments').filter(p => String(p.invoice_id)===String(invoiceId) && p.status==='入金済');
  pays.forEach(p => updateRow_(ssOps_(),'Payments','payment_id',p.payment_id,{status:'取消'}));
  if(invoiceId) updateRow_(ssOps_(),'Invoices','invoice_id',invoiceId,{status:'入金待ち'});
  logEvent_('payment', invoiceId, actor_(), {status:'入金済'}, {status:'取消'});
  return true;
}

/** 半期清算：計算書(Settlement_Statements)に配分額・パートナー名を結合 */
function admin_listSettlements(){
  const stmts       = readRows_(ssOps_(),'Settlement_Statements');
  const settlements = readRows_(ssOps_(),'Settlements');
  const partners    = readRows_(ssOps_(),'Partners');
  const pName = {}; partners.forEach(p => { pName[p.partner_id] = p.name; });
  const sAmt  = {}; settlements.forEach(s => { sAmt[s.settlement_id] = s.amount; });
  return stmts.map(s => ({
    statement_id:s.statement_id, period:String(s.period||''), partner:pName[s.partner_id]||String(s.partner_id||''),
    amount:String(sAmt[s.settlement_id]||''), status:s.status||'', objection_due:String(s.objection_due||'')
  }));
}

/** 計算書の承認（DRAFT→APPROVED）。送信は admin_sendApprovedStatements で実施。 */
function admin_approveStatement(statementId){
  updateRow_(ssOps_(),'Settlement_Statements','statement_id',statementId,{status:'APPROVED'});
  logEvent_('settlement_statement', statementId, actor_(), null, {status:'APPROVED'});
  return true;
}

// ---- バッチ手動起動（管理コンソールから・時間主導トリガーと共用） ----
/** QUEUEDのAI審査ジョブを実行 */
function admin_runAiReviews(){ const r = batch_runAiReviews_(); logEvent_('batch','ai_reviews',actor_(),null,r); return r; }
/** 当期（または指定期）の計算書をDRAFT生成 */
function admin_generateStatements(period){ const r = batch_generateStatements(period||currentPeriod_()); logEvent_('batch','generate_statements',actor_(),null,r); return r; }
/** 承認済の計算書をCloudSign送信（みなし合意・発効日＋1ヶ月） */
function admin_sendApprovedStatements(){ const r = batch_sendApprovedStatements_(); logEvent_('batch','send_statements',actor_(),null,r); return r; }

// ============================================================
// 7. 半期清算・計算書（仕入明細書方式・みなし合意）
// ============================================================
/**
 * 半期バッチ：確定済(APPROVED/LOCKED)の利用報告を集計し、パートナー別の
 * 計算書（仕入明細書方式・DRAFT）を生成する。
 * 計算チェーン（per Usage_Report）:
 *   net_sales → ×royalty_rate = license_fee → ×(1 - handling_fee_rate) = partner_share
 *   （rate は作品の royalty_rate 列、無ければ Config の既定値。スナップショットを保存）
 * 既に当期の有効な計算書がある場合は二重生成を避けてスキップする。
 */
function batch_generateStatements(period){
  period = period || currentPeriod_();
  const existing = readRows_(ssOps_(),'Settlement_Statements')
    .filter(s => String(s.period)===String(period) && s.status!=='SUPERSEDED');
  if(existing.length) return { period:period, skipped:true,
    reason:'当期の計算書が既に存在します（先に SUPERSEDED へ）', statements:existing.length };

  const reports = readRows_(ssOps_(),'Usage_Reports')
    .filter(r => String(r.period)===String(period) && (r.status==='APPROVED' || r.status==='LOCKED'));
  const contracts = readRows_(ssOps_(),'Contracts');
  const ctrWork = {}; contracts.forEach(c => { ctrWork[c.contract_id] = c.work_id; });
  const workById = {}; readRows_(ssMaster_(),'Works_Master').forEach(w => { workById[w.work_id] = w; });
  const partners = readRows_(ssOps_(),'Partners');

  const royaltyDefault = num_(getConfig_('DEFAULT_ROYALTY_RATE', '0.10'));   // 既定ロイヤリティ率
  const handlingRate   = num_(getConfig_('HANDLING_FEE_RATE',   '0.30'));    // 事務手数料率

  const byPartner = {};  // partner_id -> { partner, details:[], total }
  reports.forEach(r => {
    const work = workById[ctrWork[r.contract_id]] || { work_id:ctrWork[r.contract_id]||'', publisher:'' };
    const partner = resolveWorkPartner_(work, partners);
    const net = num_(r.net_sales);
    const royaltyRate = (work.royalty_rate!==undefined && work.royalty_rate!=='') ? num_(work.royalty_rate) : royaltyDefault;
    const licenseFee   = Math.round(net * royaltyRate);
    const partnerShare = Math.round(licenseFee * (1 - handlingRate));
    const key = partner.partner_id;
    if(!byPartner[key]) byPartner[key] = { partner:partner, details:[], total:0 };
    byPartner[key].details.push({
      contract_id: r.contract_id,
      rate_snapshot: JSON.stringify({ royalty_rate:royaltyRate, handling_fee_rate:handlingRate,
        net_sales:net, license_fee:licenseFee, report_id:r.report_id }),
      amount: partnerShare
    });
    byPartner[key].total += partnerShare;
  });

  const out = [];
  Object.keys(byPartner).forEach(pid => {
    const grp = byPartner[pid];
    const settlementId = newId_('STL');
    appendRow_(ssOps_(),'Settlements',{ settlement_id:settlementId, partner_id:pid,
      period:period, amount:grp.total, status:'DRAFT', hold_reason:'' });
    grp.details.forEach(d => appendRow_(ssOps_(),'Settlement_Details',{
      settlement_detail_id:newId_('STD'), settlement_id:settlementId,
      contract_id:d.contract_id, rate_snapshot:d.rate_snapshot, amount:d.amount }));
    const statementId = newId_('STM');
    appendRow_(ssOps_(),'Settlement_Statements',{ statement_id:statementId,
      settlement_id:settlementId, partner_id:pid, period:period, type:'PARTNER',
      reg_number_snapshot: grp.partner.invoice_reg_number || '',   // 登録番号(T番号)スナップショット
      status:'DRAFT', effective_date:'', objection_due:'', pdf_file_id:'', sheet_id:'',
      version:1, sent_at:'', confirmed_at:'' });
    logEvent_('settlement_statement', statementId, 'system', null,
      {status:'DRAFT', period:period, partner_id:pid, amount:grp.total, details:grp.details.length});
    out.push({ statement_id:statementId, partner:grp.partner.name, amount:grp.total, details:grp.details.length });
  });
  return { period:period, reports:reports.length, generated:out.length, statements:out };
}

/** 作品→パートナーの解決（partner_id列 → 出版社名突合 → 疑似パートナー） */
function resolveWorkPartner_(work, partners){
  if(work.partner_id){
    const p = partners.find(x => x.partner_id===work.partner_id);
    if(p) return p;
  }
  const pub = String(work.publisher||'');
  if(pub){
    const p = partners.find(x => x.name && (pub.indexOf(x.name)>=0 || String(x.name).indexOf(pub)>=0));
    if(p) return p;
  }
  return { partner_id: pub ? ('PUB:'+pub) : 'UNKNOWN', name: pub || '(未割当)', invoice_reg_number:'' };
}

/**
 * 承認済(APPROVED)の計算書を CloudSign 送信（みなし合意）：
 * 発効日=本日、異議期限=発効日+1ヶ月（OBJECTION_DAYS_RULE）に設定し SENT へ。
 */
function batch_sendApprovedStatements_(){
  const today = new Date();
  const eff = today.toISOString().slice(0,10);
  const due = addMonthsIso_(today, 1).slice(0,10);
  const list = readRows_(ssOps_(),'Settlement_Statements').filter(s => s.status==='APPROVED');
  list.forEach(s => {
    cloudSignSendStatement_(s);   // TODO: 仕入明細書PDF生成→CloudSign送信（みなし合意条項）
    updateRow_(ssOps_(),'Settlement_Statements','statement_id',s.statement_id,
      { status:'SENT', effective_date:eff, objection_due:due, sent_at:today.toISOString() });
    updateRow_(ssOps_(),'Settlements','settlement_id',s.settlement_id,{ status:'SENT' });
    logEvent_('settlement_statement', s.statement_id, 'system', {status:'APPROVED'},
      {status:'SENT', effective_date:eff, objection_due:due});
  });
  return { sent: list.length };
}
/** 計算書のCloudSign送信（実装時に最新API確認） */
function cloudSignSendStatement_(statement){
  // TODO: 仕入明細書PDFを生成 → CloudSign documents作成 → 送信（みなし合意付き）→ document_id控え
}

/** 日次：異議期間（発効日＋1ヶ月）到来かつ無申出を CONFIRMED へ（みなし確認） */
function batch_confirmDeemed(){
  const now = new Date();
  readRows_(ssOps_(),'Settlement_Statements')
    .filter(s=> s.status==='SENT' && s.objection_due && new Date(s.objection_due) <= now)
    .forEach(s=> {
      updateRow_(ssOps_(),'Settlement_Statements','statement_id',s.statement_id,
        {status:'CONFIRMED', confirmed_at: now.toISOString()});
      if(s.settlement_id) updateRow_(ssOps_(),'Settlements','settlement_id',s.settlement_id,{status:'CONFIRMED'});
      logEvent_('settlement_statement', s.statement_id, 'system', {status:'SENT'}, {status:'CONFIRMED'});
    });
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

// ============================================================
// 9. GAS③ 管理コンソール：設定
//    同意文・規約／作品マスタ／データソース／外部API（CloudSign・FormRun）
//    すべて google.script.run から呼ぶ。社内GWS限定で公開すること。
// ============================================================

/** 操作者メール（監査用）。取得不能時は 'admin'。 */
function actor_(){ try{ return Session.getActiveUser().getEmail() || 'admin'; }catch(e){ return 'admin'; } }

// ---- Config シート（業務台帳）read/write ----
function getConfig_(key, def){
  const r = readRows_(ssOps_(), 'Config').find(x => String(x.config_key) === key);
  return (r && r.value !== '' && r.value !== undefined) ? r.value : (def !== undefined ? def : '');
}
function setConfig_(key, value){
  const ss = ssOps_();
  const patch = { value: value, environment: 'default', updated_at: new Date().toISOString() };
  if(!updateRow_(ss, 'Config', 'config_key', key, patch)){
    appendRow_(ss, 'Config', Object.assign({ config_key: key }, patch));
  }
}

// ---- 9.1 同意文・規約 ----
const DEFAULT_PRIVACY =
'<h4>1. 取得する情報</h4><ol><li>氏名、連絡先（メールアドレス）</li><li>申込作品・利用態様、提出作品データ</li><li>契約に至る場合は、住所・振込先その他の契約履行に必要な情報</li></ol>'+
'<h4>2. 利用目的</h4><ol><li>SPLL利用許諾の審査・契約の締結および管理</li><li>提出作品の適合性審査（AIによる一次審査を含む）</li><li>利用許諾料・配分の計算および清算</li><li>お問い合わせ対応・連絡</li><li>法令遵守および権利保護</li></ol>'+
'<h4>3. 委託・第三者提供</h4><ol><li>契約締結のため電子契約サービス（CloudSign）に取扱いを委託します。</li><li>データの保管・処理のためGoogle Workspace／Google Cloud（Vertex AI Geminiによる作品審査を含む）に取扱いを委託します。</li><li>法令に基づく場合を除き、ご本人の同意なく第三者へ提供しません。</li></ol>'+
'<h4>4. 保有期間</h4><ol><li>契約に至らなかった申込情報・提出作品データは、取得から1年で削除します。</li><li>契約に至った場合は、契約期間および関係法令の定める期間、保有します。</li></ol>'+
'<h4>5. 開示等の請求</h4><ol><li>保有個人データの開示・訂正・利用停止等のご請求は、下記窓口で受け付けます。［窓口記載・法務確定前］</li></ol>';

// 規約はテンプレート。{{name}}{{pub}}{{ok}}{{no}}{{media}}{{fee}}{{credit}} を作品ごとに差込む。
const DEFAULT_TERMS_TEMPLATE =
'<h4>第1条（許諾の範囲）</h4><ol><li>本作品の許諾要素（{{ok}}）について、対象媒体（{{media}}）での二次創作・頒布を許諾します。</li><li>禁止要素（{{no}}）は利用できません。</li></ol>'+
'<h4>第2条（利用許諾料）</h4><ol><li>利用許諾料は {{fee}} とします。免除・追加契約の条件は別表によります。</li></ol>'+
'<h4>第3条（クレジット表記）</h4><ol><li>{{credit}}。「公式」「公認」等と誤認させる表示は行いません。</li></ol>'+
'<h4>第4条（作品審査・是正）</h4><ol><li>提出作品はAI（Vertex AI Gemini）による一次審査に付されます。AIの判定は最終決定ではなく、当社・事務局の人的判断と区別されます。</li><li>適合性に疑義がある場合、是正の要求・公開停止・許諾の取消し等を行うことがあります。</li></ol>'+
'<h4>第5条（非承認・非保証）</h4><ol><li>審査の通過、または一定期間の無指摘は、当社の承認・適法性保証・権利非侵害保証を意味しません。</li></ol>'+
'<h4>第6条（解除）</h4><ol><li>表明の虚偽、本規約違反その他の事由があるときは、本許諾を解除できます。［解除の遡及／非遡及は別途規定・法務確定前］</li></ol>'+
'<h4>第7条（準拠法・管轄）</h4><ol><li>日本法に準拠し、当社所在地を管轄する裁判所を専属的合意管轄とします。</li></ol>';

function admin_getLegalTexts(){ return api_getLegalTexts(); }
function admin_saveLegalTexts(privacy, termsTemplate){
  if(privacy !== undefined)        setConfig_('LEGAL_PRIVACY_TEXT', String(privacy));
  if(termsTemplate !== undefined)  setConfig_('LEGAL_TERMS_TEMPLATE', String(termsTemplate));
  logEvent_('config', 'LEGAL', actor_(), null, { saved: true });
  return true;
}

// ---- 9.2 作品マスタ（スプレッドシート設定） ----
const WORK_FIELDS = ['work_id','work_name','publisher','category','publish_status',
  'review_timing','review_policy','fee_label','media','ok_elements','no_elements',
  'credit_text','allocation_scheme_id'];

/** 作品マスタ全件（内部列含む。管理用なのでホワイトリストしない） */
function admin_listWorksMaster(){ return readRows_(ssMaster_(), 'Works_Master'); }

/** 作品の追加・更新（work_id一致でupsert）。media/ok/no はCSV文字列で保存。 */
function admin_saveWork(work){
  const row = {};
  WORK_FIELDS.forEach(k => { if(work[k] !== undefined) row[k] = work[k]; });
  if(!row.work_id) row.work_id = newId_('WRK');
  if(!row.publish_status) row.publish_status = 'DRAFT';
  if(!updateRow_(ssMaster_(), 'Works_Master', 'work_id', row.work_id, row)){
    appendRow_(ssMaster_(), 'Works_Master', row);
  }
  logEvent_('work', row.work_id, actor_(), null, { saved: true, publish_status: row.publish_status });
  return row.work_id;
}

/** 公開状態の切替（PUBLISHED / DRAFT / UNPUBLISHED 等） */
function admin_setWorkPublish(workId, status){
  updateRow_(ssMaster_(), 'Works_Master', 'work_id', workId, { publish_status: status });
  logEvent_('work', workId, actor_(), null, { publish_status: status });
  return true;
}

// ---- 9.3 データソース設定（スプレッドシート/Drive/GCPの接続先） ----
function admin_getDataSourceConfig(){
  return {
    SS_MASTER:   prop_('SS_MASTER')   || '',
    SS_OPS:      prop_('SS_OPS')      || '',
    DRIVE_ROOT:  prop_('DRIVE_ROOT')  || '',
    GCP_PROJECT: prop_('GCP_PROJECT') || '',
    GCP_REGION:  prop_('GCP_REGION')  || '',
    GEMINI_MODEL:prop_('GEMINI_MODEL')|| '',
    defaults: {  // 未設定時に使われる CFG 既定値（参考表示用）
      SS_MASTER:CFG.SS_MASTER, SS_OPS:CFG.SS_OPS, DRIVE_ROOT:CFG.DRIVE_ROOT,
      GCP_PROJECT:CFG.GCP_PROJECT, GCP_REGION:CFG.GCP_REGION, GEMINI_MODEL:CFG.GEMINI_MODEL
    }
  };
}
function admin_saveDataSourceConfig(c){
  const sp = PropertiesService.getScriptProperties();
  ['SS_MASTER','SS_OPS','DRIVE_ROOT','GCP_PROJECT','GCP_REGION','GEMINI_MODEL']
    .forEach(k => { if(c[k] !== undefined) sp.setProperty(k, String(c[k])); });
  logEvent_('config', 'DATASOURCE', actor_(), null, { saved: true });
  return true;
}

// ---- 9.4 外部API：CloudSign / FormRun（秘密はScriptProperties・読み出しはマスク） ----
/** 設定の取得。secret等の機微情報は値を返さず「設定済みか」のみ返す。 */
function admin_getIntegrationConfig(){
  return {
    cloudsign: {
      client_id:    prop_('CLOUDSIGN_CLIENT_ID')   || '',
      secret_set:   !!prop_('CLOUDSIGN_SECRET'),
      template_id:  prop_('CLOUDSIGN_TEMPLATE_ID') || '',
      callback_url: prop_('CLOUDSIGN_CALLBACK_URL')|| '',
      sandbox:      prop_('CLOUDSIGN_SANDBOX') === 'true'
    },
    formrun: {
      form_url:           prop_('FORMRUN_FORM_URL')   || '',
      webhook_secret_set: !!prop_('FORMRUN_WEBHOOK_SECRET'),
      field_map:          prop_('FORMRUN_FIELD_MAP')  || ''
    }
  };
}
/** CloudSign設定の保存。secretは値が来た時のみ更新（空なら据え置き）。 */
function admin_saveCloudSignConfig(c){
  const sp = PropertiesService.getScriptProperties();
  if(c.client_id    !== undefined) sp.setProperty('CLOUDSIGN_CLIENT_ID',    String(c.client_id));
  if(c.secret)                     sp.setProperty('CLOUDSIGN_SECRET',       String(c.secret));
  if(c.template_id  !== undefined) sp.setProperty('CLOUDSIGN_TEMPLATE_ID',  String(c.template_id));
  if(c.callback_url !== undefined) sp.setProperty('CLOUDSIGN_CALLBACK_URL', String(c.callback_url));
  if(c.sandbox      !== undefined) sp.setProperty('CLOUDSIGN_SANDBOX',      c.sandbox ? 'true' : 'false');
  logEvent_('config', 'CLOUDSIGN', actor_(), null, { saved: true });
  return true;
}
/** FormRun設定の保存。webhook_secretは値が来た時のみ更新。 */
function admin_saveFormRunConfig(c){
  const sp = PropertiesService.getScriptProperties();
  if(c.form_url       !== undefined) sp.setProperty('FORMRUN_FORM_URL',  String(c.form_url));
  if(c.webhook_secret)               sp.setProperty('FORMRUN_WEBHOOK_SECRET', String(c.webhook_secret));
  if(c.field_map      !== undefined) sp.setProperty('FORMRUN_FIELD_MAP', String(c.field_map));
  logEvent_('config', 'FORMRUN', actor_(), null, { saved: true });
  return true;
}

// ---- utils ----
function hash_(s){ return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)); }
function sha256Bytes_(bytes){ return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)); }
function addDaysIso_(d){ const t=new Date(); t.setDate(t.getDate()+d); return t.toISOString(); }
function addMonthsIso_(date, m){ const t=new Date(date.getTime()); t.setMonth(t.getMonth()+m); return t.toISOString(); }
function num_(v){ const n=parseFloat(String(v).replace(/[^0-9.\-]/g,'')); return isNaN(n)?0:n; }
function currentPeriod_(){ const d=new Date(); return d.getFullYear()+(d.getMonth()<6?'H1':'H2'); }
