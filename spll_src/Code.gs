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
  if(page === 'badge')  return serveBadge_(e);              // 認証バッジDL（トークン）
  if(page === 'verify') return serveVerify_(e);             // 認証の検証ポータル（ID照会・受付番号）
  if(page === 'admin')  return serveAdmin_(e);              // 管理コンソール（任意で許可リスト制御）
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

/** 公開：申込導線の設定（クラウドサインフォームURL）。application_ref を引き継ぐ。 */
function api_getApplyConfig(){
  return { formUrl: prop_('FORMRUN_FORM_URL') || '', refParam: prop_('FORM_REF_PARAM') || 'application_ref' };
}

// ---- ログインユーザーの役割（管理者判定）：管理画面スイッチ用 ----
/** 管理者メールの許可リスト（ADMIN_EMAILS：カンマ/空白区切り・小文字比較） */
function adminEmails_(){
  return String(prop_('ADMIN_EMAILS') || '').split(/[,\s]+/).map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean);
}
function isAdminEmail_(email){
  email = String(email || '').toLowerCase();
  if(!email) return false;
  return adminEmails_().indexOf(email) >= 0;
}
/** 現在のログインユーザーの役割。identified=false は匿名アクセス（メール取得不可）を意味する。 */
function api_getViewerRole(){
  var email = ''; try{ email = Session.getActiveUser().getEmail() || ''; }catch(e){}
  var listed = adminEmails_().length > 0;
  var adminUrl = '?page=admin'; try{ adminUrl = ScriptApp.getService().getUrl() + '?page=admin'; }catch(e){}
  var homeUrl = ''; try{ homeUrl = ScriptApp.getService().getUrl(); }catch(e){}
  return {
    email: email,
    identified: !!email,                 // 匿名デプロイでは空になる
    isAdmin: isAdminEmail_(email),
    bootstrap: !listed,                   // 管理者未登録（初期セットアップ状態）
    adminUrl: adminUrl,
    homeUrl: homeUrl
  };
}

/**
 * 管理コンソールの配信。ADMIN_ENFORCE=true かつ 閲覧者を識別できる場合のみ、
 * 許可リスト外を拒否する（匿名デプロイでは識別不可のため素通り）。
 */
function serveAdmin_(e){
  if(prop_('ADMIN_ENFORCE') === 'true'){
    var email = ''; try{ email = Session.getActiveUser().getEmail() || ''; }catch(_){}
    if(email && !isAdminEmail_(email)){
      return htmlPage_('SPLL 管理コンソール',
        '<h2>アクセス権限がありません</h2><p>このアカウント（' + esc_(email) + '）は管理者として登録されていません。</p>' +
        '<p style="font-size:12px;color:#6A6577">管理者アカウントでログインし直すか、事務局にお問い合わせください。</p>');
    }
  }
  return HtmlService.createHtmlOutputFromFile('admin').setTitle('SPLL 管理コンソール');
}

/** 管理者アクセス設定の取得（許可リスト・強制ON/OFF・現在の閲覧者） */
function admin_getAdminAccess(){
  var viewer = ''; try{ viewer = Session.getActiveUser().getEmail() || ''; }catch(e){}
  return { emails: prop_('ADMIN_EMAILS') || '', enforce: prop_('ADMIN_ENFORCE') === 'true', viewer: viewer };
}
/** 管理者アクセス設定の保存（emails：カンマ/改行区切り、enforce：真偽） */
function admin_saveAdminAccess(c){
  var sp = PropertiesService.getScriptProperties();
  if(c.emails  !== undefined) sp.setProperty('ADMIN_EMAILS', String(c.emails).replace(/\n/g, ','));
  if(c.enforce !== undefined) sp.setProperty('ADMIN_ENFORCE', c.enforce ? 'true' : 'false');
  logEvent_('config', 'ADMIN_ACCESS', actor_(), null, { saved: true, enforce: !!c.enforce });
  return true;
}

// ============================================================
// 2. 申込 → Applications（B経路固定）
//    申込の作成は公開ポータルの web_createApplication（複数原作）で行う。
//    A経路（作品審査後に締結）は廃止したため、申込時の作品提出は存在しない。
// ============================================================
// 3. CloudSign API 送信・締結Webhook（D-11）
// ============================================================
// ---- 3.1 CloudSign クライアント（サンドボックス既定） ----
// ※ エンドポイント/ステータス値は CloudSign 公式 Web API ドキュメントで最新仕様を確認すること。
//   サンドボックス: https://api-sandbox.cloudsign.jp ／ 本番: https://api.cloudsign.jp
function cs_isSandbox_(){ return prop_('CLOUDSIGN_SANDBOX') !== 'false'; }   // 既定はサンドボックス
function cs_baseUrl_(){ return cs_isSandbox_() ? 'https://api-sandbox.cloudsign.jp' : 'https://api.cloudsign.jp'; }

/** アクセストークン取得（短期キャッシュ）。POST /token?client_id= */
function cloudSignAccessToken_(){
  const cache = CacheService.getScriptCache();
  const hit = cache.get('cs_token');
  if(hit) return hit;
  const clientId = prop_('CLOUDSIGN_CLIENT_ID');
  if(!clientId) throw new Error('CloudSign未設定：管理コンソール「設定」でClient IDを登録してください');
  const res = cs_fetch_('POST', '/token?client_id=' + encodeURIComponent(clientId), null, { auth:false });
  const token = res.access_token;
  if(!token) throw new Error('CloudSignトークン取得失敗: ' + JSON.stringify(res));
  const ttl = Math.max(60, Math.min((parseInt(res.expires_in||'3000',10) - 60), 21600)); // CacheServiceは最大6h
  cache.put('cs_token', token, ttl);
  return token;
}

/** CloudSign API 共通呼び出し。JSONを返す。opt.multipart=true でファイル送信。 */
function cs_fetch_(method, path, body, opt){
  opt = opt || {};
  const headers = {};
  if(opt.auth !== false) headers['Authorization'] = 'Bearer ' + cloudSignAccessToken_();
  const params = { method: method, muteHttpExceptions: true, headers: headers };
  if(body && opt.multipart){ params.payload = body; }                     // {field: Blob} → 自動でmultipart
  else if(body){ params.contentType = 'application/json'; params.payload = JSON.stringify(body); }
  const res  = UrlFetchApp.fetch(cs_baseUrl_() + path, params);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if(code < 200 || code >= 300) throw new Error('CloudSign ' + method + ' ' + path + ' → HTTP ' + code + ': ' + text);
  try{ return text ? JSON.parse(text) : {}; }catch(e){ return { raw: text }; }
}

// ---- 3.2 書類ライフサイクル ----
function cs_createDocument_(title, message){ return cs_fetch_('POST', '/documents', { title: title, message: message || '' }); }
function cs_attachFile_(docId, blob, filename){ return cs_fetch_('POST', '/documents/' + docId + '/files', { uploadfile: blob.setName(filename || 'document.pdf') }, { multipart:true }); }
function cs_attachFromTemplate_(docId, templateId){ return cs_fetch_('POST', '/documents/' + docId + '/files', { template_id: templateId }); }
function cs_addParticipant_(docId, email, name){ return cs_fetch_('POST', '/documents/' + docId + '/participants', { email: email, name: name || '', organization: '' }); }
function cs_sendDocument_(docId){ return cs_fetch_('POST', '/documents/' + docId + '/sent', {}); }

/** 接続テスト（サンドボックス資格情報の確認用）。トークン全体は返さない。 */
function admin_cloudSignTest(){
  try{
    const t = cloudSignAccessToken_();
    return { ok:true, sandbox:cs_isSandbox_(), base:cs_baseUrl_(), token_prefix:String(t).slice(0,6) + '…' };
  }catch(e){
    return { ok:false, sandbox:cs_isSandbox_(), base:cs_baseUrl_(), error:String(e.message || e) };
  }
}

// 注：契約書の作成・送信は「クラウドサインフォーム powered by formrun」で完結する。
// GAS からの CloudSign 送信は行わない（申込→締結は FormRun→CloudSign 直結）。
// GAS が CloudSign API を使うのは清算計算書のみ（cloudSignSendStatement_）。

/** Webフック受け口。?hook=formrun は申込連携、既定は CloudSign 締結完了。 */
function doPost(e){
  const hook = (e && e.parameter && e.parameter.hook) || '';
  if(hook === 'formrun') return handleFormrunWebhook_(e);   // FormRun申込（案③）
  return handleCloudSignWebhook_(e);                        // CloudSign締結完了
}

/**
 * 公開ポータルからの申込作成（複数原作）。application_ref を発行し、
 * Applications ＋ Application_Works を登録して application_ref を返す。
 * 突合キーは application_ref（メールハッシュ突合は廃止）。
 */
function web_createApplication(workIds){
  const ids = (workIds || []).filter(Boolean);
  if(!ids.length) throw new Error('原作が選択されていません');
  const appId = newId_('APP');
  const ref   = newId_('REF');
  appendRow_(ssOps_(),'Applications',{ application_id:appId, application_ref:ref,
    status:'APPLICATION_CREATED', created_at:new Date().toISOString() });
  ids.forEach(function(wid){ appendRow_(ssOps_(),'Application_Works',{
    application_work_id:newId_('AW'), application_id:appId, work_id:wid }); });
  updateRow_(ssOps_(),'Applications','application_id',appId,{ status:'FORM_PENDING' });
  logEvent_('application', appId, 'portal', null, { application_ref:ref, works:ids.length });
  return { application_id:appId, application_ref:ref };
}

/** CloudSign 締結完了Webhook：application_ref で申込に突合 → 契約＋対象原作スナップショット＋認証＋提出トークン */
function handleCloudSignWebhook_(e){
  let body = {};
  try{ body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch(_){ body = (e && e.parameter) || {}; }
  const docId = body.document_id || body.documentID || body.id || (e && e.parameter && e.parameter.documentID);
  const event = body.event_type || body.status || body.event;
  const ref   = extractApplicationRef_(body, e);
  if(!docId) return ContentService.createTextOutput('no-docid');
  if(!cs_isCompletedEvent_(event)) return ContentService.createTextOutput('ignored');
  if(isDuplicateWebhook_(docId, 'COMPLETED')) return ContentService.createTextOutput('dup');

  const app = ref ? readRows_(ssOps_(),'Applications').find(function(a){ return a.application_ref === ref; }) : null;
  const contractId = newId_('CTR');
  appendRow_(ssOps_(),'Contracts',{ contract_id:contractId, cloudsign_document_id:docId,
    application_id: app ? app.application_id : '', application_ref: ref || '',
    status:'SIGNED', signed_at:new Date().toISOString(), folder_id:createContractFolder_(contractId) });

  // 契約対象原作を Application_Works からスナップショット（法務証跡）
  if(app){
    readRows_(ssOps_(),'Application_Works').filter(function(x){ return x.application_id === app.application_id; })
      .forEach(function(x){ appendRow_(ssOps_(),'Contract_Works',{ contract_work_id:newId_('CW'), contract_id:contractId, work_id:x.work_id }); });
    updateRow_(ssOps_(),'Applications','application_id',app.application_id,{ status:'SIGNED' });
  }
  logEvent_('contract', contractId, 'cloudsign', null, { status:'SIGNED', application_ref:ref });

  // 認証を発行（締結で ACTIVE）＋ 認証バッジ ＋ 作品提出トークン（メールは送らない）
  issueCert_(contractId);
  if(prop_('BADGE_AUTO') !== 'false'){ try{ issueBadge_(contractId); }catch(e){ logEvent_('badge', contractId, 'system', null, { issue_error:String(e) }); } }
  prepareSubmissionToken_(contractId);
  return ContentService.createTextOutput('ok');
}

/**
 * Webフックから application_ref を取り出す。
 * CloudSign締結Webhookのペイロードは { documentID, status, userID, email, text } のみで、
 * フォーム入力値は含まれない。application_ref は契約書タイトル（text 内 "COMPLETED : <タイトル> sent by …"）
 * に埋め込む運用とし、まず text から抽出。取れなければ書類取得APIでタイトルを引いてフォールバック。
 */
function extractApplicationRef_(body, e){
  var ref = body.application_ref || body.reference || body.external_id ||
    (body.metadata && body.metadata.application_ref) ||
    (e && e.parameter && e.parameter.ref) ||
    refFromText_(body.text) || refFromText_(body.title) || refFromText_(body.subject) || '';
  if(ref) return ref;
  // フォールバック：CloudSign API で書類タイトルを取得して application_ref を抽出
  var docId = body.documentID || body.document_id || body.id || (e && e.parameter && e.parameter.documentID);
  if(docId && prop_('CLOUDSIGN_CLIENT_ID')){
    try{ var doc = cs_fetch_('GET', '/documents/' + docId, null, {}); ref = refFromText_(doc && (doc.title || doc.name)) || ''; }
    catch(_){ /* 取得不能時は空 */ }
  }
  return ref || '';
}
function refFromText_(s){ const m = String(s||'').match(/REF-\d{6}-\d{4}/); return m ? m[0] : ''; }

/** FormRun申込Webフック：application_ref を受け、申込のステータスを進める（申込作成はポータル側） */
function handleFormrunWebhook_(e){
  if(!verifyFormrunSig_(e)) return ContentService.createTextOutput('bad-sig');
  const body = parseFormrunBody_(e);
  const map  = parseJson_(prop_('FORMRUN_FIELD_MAP'), {});
  const canon = {};
  (body.columns || []).forEach(function(c){ const k = map[c.name || c.label]; if(k) canon[k] = c.value; });
  const ref = canon.application_ref || refFromText_(JSON.stringify(body));
  if(ref){
    const app = readRows_(ssOps_(),'Applications').find(function(a){ return a.application_ref === ref; });
    if(app) updateRow_(ssOps_(),'Applications','application_id',app.application_id,{ status:'CONTRACT_PENDING' });
    logEvent_('application', app ? app.application_id : '', 'formrun', null, { application_ref:ref });
  }
  return ContentService.createTextOutput('ok');
}
function parseJson_(s, def){ try{ const v = JSON.parse(s); return (v==null ? def : v); }catch(e){ return def; } }
function verifyFormrunSig_(e){
  const secret = prop_('FORMRUN_WEBHOOK_SECRET');
  if(!secret) return true;                                     // 未設定なら検証しない
  const sig = (e && e.parameter && (e.parameter.sig || e.parameter.signature)) || '';
  // TODO: FormRunの署名仕様に合わせてHMAC等で検証（公式仕様確認）
  return sig ? true : true;
}
function parseFormrunBody_(e){
  const raw = (e && e.postData && e.postData.contents) || '';
  try{ return JSON.parse(raw); }catch(_){}
  // application/x-www-form-urlencoded で JSON が payload 値に入るケースに対応
  try{
    const params = {}; raw.split('&').forEach(function(kv){ const i=kv.indexOf('='); if(i>=0) params[decodeURIComponent(kv.slice(0,i))]=decodeURIComponent(kv.slice(i+1).replace(/\+/g,' ')); });
    const cand = params.payload || params.body || params.data || Object.keys(params)[0] && params[Object.keys(params)[0]];
    return JSON.parse(cand);
  }catch(_){ return { sequence_number:'', columns:[] }; }
}
function isDuplicateWebhook_(docId, event){
  const key = 'WH_'+docId+'_'+event;
  if(prop_(key)) return true;
  PropertiesService.getScriptProperties().setProperty(key,'1'); return false;
}
/**
 * CloudSignの「締結完了」イベントか。
 * 公式仕様：Webhookの status は 1=先方確認中 / 2=締結完了 / 3=取消・却下。
 * 締結完了は status===2（または text/イベント名の "COMPLETED"）。※ 3は取消なので締結ではない。
 */
function cs_isCompletedEvent_(s){
  s = String(s);
  return s==='2' || s==='COMPLETED' || s==='completed' || s==='signed' || s==='SIGNED';
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

/** 契約フォルダ配下の指定サブフォルダを取得（無ければ作成） */
function contractSubFolder_(contract, name){
  let base;
  try{ base = contract.folder_id ? DriveApp.getFolderById(contract.folder_id) : DriveApp.getFolderById(cfg_('DRIVE_ROOT')); }
  catch(e){ base = DriveApp.getFolderById(cfg_('DRIVE_ROOT')); }
  const it = base.getFoldersByName(name);
  return it.hasNext() ? it.next() : base.createFolder(name);
}

/**
 * 版(Submission_Versions)単位でAI審査ジョブを起票。
 * B経路固定：審査対象は提出済みの版。application 経由の起票は行わない。
 */
function enqueueAiReview_(submissionId, versionId){
  const aiId = newId_('AIR');
  appendRow_(ssOps_(),'AI_Review_Jobs',{ ai_review_id:aiId, submission_id:submissionId||'', version_id:versionId||'',
    model:cfg_('GEMINI_MODEL'), prompt_version:AI_PROMPT_VERSION, status:'QUEUED', retry_count:0 });
  logEvent_('ai_review', aiId, 'system', null, {status:'QUEUED', version_id:versionId||''});
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
    work_id:{type:'string'}, rule_id:{type:'string'}, severity:{type:'string'}, result:{type:'string'},
    page:{type:'integer'}, evidence:{type:'string'}, recommended_action:{type:'string'}, confidence:{type:'number'}
  }}}
}};
function buildReviewPrompt_(rules){
  return [
    'あなたは審査者ではなく一次スクリーナーです。根拠箇所を示し、不明は不明としてください。',
    '本提出作品は、複数の原作を同時に利用している可能性があります。',
    '各指摘(finding)には、どの原作(work_id)のルールに関するものかを必ず付与してください。',
    '次の原作別ルールと契約条件に対する適合候補・要確認・高リスク候補を抽出してください。',
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

/** 1件のAI審査を実行：ファイル取得→Gemini（複数原作ルール）→Findings記録→人手審査へ */
function runAiReview_(aiReviewId){
  const job = readRows_(ssOps_(),'AI_Review_Jobs').find(j => j.ai_review_id===aiReviewId);
  if(!job) throw new Error('AI review job not found: '+aiReviewId);
  if(job.status==='COMPLETED') return 'COMPLETED';          // 冪等
  updateRow_(ssOps_(),'AI_Review_Jobs','ai_review_id',aiReviewId,{status:'SCANNING'});
  markVersionStatus_(job.version_id, 'AI_SCREENING');
  try{
    const blob = resolveSubmissionBlob_(job);
    if(!blob) throw new Error('提出ファイルが見つかりません');
    const works = resolveJobWorks_(job);                            // 契約対象原作（複数）
    const rules = buildRulesMulti_(works);
    const parsed = parseGeminiResult_(geminiReview_(blob, rules));  // 個人情報は送らず作品＋条件のみ
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

/** ジョブの提出ファイル（版の先頭）をBlobで取得。作品ファイルのみで個人情報は含めない。 */
function resolveSubmissionBlob_(job){
  const vid = job.version_id;
  if(!vid) return null;
  const f = readRows_(ssOps_(),'Submission_Files').find(x => String(x.version_id)===String(vid));
  if(!f || !f.drive_file_id) return null;
  return DriveApp.getFileById(f.drive_file_id).getBlob();
}

/** ジョブ対象の契約対象原作（Works_Master行の配列）を解決：提出→契約→Contract_Works */
function resolveJobWorks_(job){
  const sub = readRows_(ssOps_(),'Submissions').find(x => x.submission_id===job.submission_id);
  const contractId = sub && sub.contract_id;
  if(!contractId) return [];
  const workIds = readRows_(ssOps_(),'Contract_Works')
    .filter(x => x.contract_id===contractId).map(x => x.work_id);
  const byId = {}; readRows_(ssMaster_(),'Works_Master').forEach(w => { byId[w.work_id] = w; });
  return workIds.map(id => byId[id] || { work_id:id });
}

/** 複数原作の作品別ルール＋契約条件を構造化（個人情報は含めない） */
function buildRulesMulti_(works){
  const allRules = readRows_(ssMaster_(),'Review_Rules');
  return {
    works: (works||[]).map(function(work){
      const rules = allRules
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
    })
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

/** Findings を AI_Findings へ記録（原作ごとに work_id を保持） */
function writeFindings_(aiReviewId, findings){
  (findings||[]).forEach(f => appendRow_(ssOps_(),'AI_Findings',{
    finding_id: newId_('FND'), ai_review_id: aiReviewId, work_id: f.work_id||'',
    rule_id: f.rule_id||'', severity: f.severity||'', result: f.result||'',
    page: f.page||'', evidence: f.evidence||'', confidence: f.confidence||''
  }));
}

/**
 * AI審査結果のルーティング（B経路固定）。AIは一次スクリーナーであり、
 * 判定だけで自動不採用にはしない。必ず人手審査を必須とする。
 *   PASS_CANDIDATE → 版=AI_SCREENED・人手簡易確認
 *   REVIEW_REQUIRED → 版=AI_SCREENED・通常審査
 *   HIGH_RISK/UNREADABLE → 版=AI_SCREENED・法務上申＋コンプラ・アラート
 */
function postReviewRouting_(job, overall){
  const high = (overall==='HIGH_RISK' || overall==='UNREADABLE');
  markVersionStatus_(job.version_id, 'AI_SCREENED');
  // 提出(Submission)を人手審査待ちへ
  if(job.submission_id) updateRow_(ssOps_(),'Submissions','submission_id',job.submission_id,{ status:'HUMAN_REVIEW_PENDING' });
  logEvent_('submission', job.submission_id||'', 'system', null, {overall_result:overall, status:'HUMAN_REVIEW_PENDING'});
  if(high) createComplianceAlert_(job.submission_id, overall);   // 既発生のパートナー配分は当然には消滅させない
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
  const tok = readRows_(ssOps_(),'Submission_Access').find(x=>x.token_hash===hash_(token) && x.status==='OPEN');
  if(!tok) throw new Error('invalid token');
  const c = readRows_(ssOps_(),'Contracts').find(x=>x.contract_id===tok.contract_id) || {};
  return { contract_id:c.contract_id||'', work:contractWorkNames_(c.contract_id).join('、'), fee:'', period:currentPeriod_() };
}
/** 利用報告の登録 → Usage_Reports（トークンは Submission_Access を共用） */
function report_submit(token, data){
  const tok = readRows_(ssOps_(),'Submission_Access').find(x=>x.token_hash===hash_(token) && x.status==='OPEN');
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

// ============================================================
// 5.1 作品提出ページ（?page=upload&t=トークン）
//     受付番号のみのアクセスは不可。Submission_Access のトークンで認証。
//     再提出は新Submissionではなく同一Submission配下の版(Version)として管理。
// ============================================================
function serveUpload_(e){
  const t = HtmlService.createTemplateFromFile('upload');
  t.token = (e.parameter && (e.parameter.t || e.parameter.token)) || '';
  return t.evaluate().setTitle('SPLL 作品提出');
}

/** 提出ページのコンテキスト：契約番号・対象原作・既存提出（版履歴つき）を返す */
function web_getSubmitContext(token){
  const tok = resolveSubmissionToken_(token);
  if(!tok) throw new Error('提出用リンクが無効か、有効期限が切れています。');
  const contractId = tok.contract_id;
  const versions = readRows_(ssOps_(),'Submission_Versions');
  const subs = readRows_(ssOps_(),'Submissions').filter(s => s.contract_id===contractId).map(function(s){
    const vs = versions.filter(v => v.submission_id===s.submission_id)
      .sort(function(a,b){ return num_(a.version_no)-num_(b.version_no); })
      .map(function(v){ return { version_no:v.version_no, status:v.status, submitted_at:String(v.submitted_at||'') }; });
    return { submission_id:s.submission_id, title:s.title, status:s.status, versions:vs };
  });
  return { contract_id:contractId, works:contractWorkNames_(contractId), submissions:subs };
}

/**
 * 作品提出（新規 or 再提出）。data:
 *   { submission_id?（再提出時）, title, filename, mimeType, dataBase64, note }
 * 新規は Submission＋v1、再提出は既存Submission配下に新しい版を追加。
 * 保存先: 契約フォルダ/02_Submissions/SUB-xxx/vN/。AI審査を起票して返す。
 */
function web_submitWork(token, data){
  const tok = resolveSubmissionToken_(token);
  if(!tok) throw new Error('提出用リンクが無効か、有効期限が切れています。');
  data = data || {};
  if(!data.dataBase64) throw new Error('作品ファイルが添付されていません。');
  const contractId = tok.contract_id;
  const contract = readRows_(ssOps_(),'Contracts').find(x => x.contract_id===contractId) || {};

  // 提出（新規 or 既存）
  let submissionId = data.submission_id || '';
  let sub = submissionId ? readRows_(ssOps_(),'Submissions').find(s => s.submission_id===submissionId) : null;
  if(sub && sub.contract_id !== contractId) throw new Error('この提出は対象の契約に属していません。');
  const now = new Date().toISOString();
  if(!sub){
    submissionId = newId_('SUB');
    appendRow_(ssOps_(),'Submissions',{ submission_id:submissionId, contract_id:contractId,
      title:data.title||'', status:'SUBMITTED', submitted_at:now });
    logEvent_('submission', submissionId, 'licensee', null, {status:'SUBMITTED', contract_id:contractId});
  }else{
    updateRow_(ssOps_(),'Submissions','submission_id',submissionId,{ status:'SUBMITTED' });
    if(data.title) updateRow_(ssOps_(),'Submissions','submission_id',submissionId,{ title:data.title });
  }

  // 版（version_no = 既存最大+1）
  const existingVers = readRows_(ssOps_(),'Submission_Versions').filter(v => v.submission_id===submissionId);
  const versionNo = existingVers.reduce(function(m,v){ return Math.max(m, num_(v.version_no)); }, 0) + 1;
  const versionId = newId_('SV');
  appendRow_(ssOps_(),'Submission_Versions',{ version_id:versionId, submission_id:submissionId,
    version_no:versionNo, status:'SUBMITTED', submitted_at:now });

  // Driveへ保存（契約フォルダ/02_Submissions/SUB/vN）
  const blob = Utilities.newBlob(Utilities.base64Decode(data.dataBase64),
    data.mimeType || 'application/octet-stream', data.filename || ('submission_v'+versionNo));
  const subRoot = getOrCreateChildFolder_(contractSubFolder_(contract,'02_Submissions'), submissionId);
  const verFolder = subRoot.createFolder('v'+versionNo);
  const file = verFolder.createFile(blob);
  const bytes = blob.getBytes();
  appendRow_(ssOps_(),'Submission_Files',{ submission_file_id:newId_('SBF'), version_id:versionId,
    drive_file_id:file.getId(), mime_type:blob.getContentType(), size:file.getSize(), sha256:sha256Bytes_(bytes) });

  // AI一次審査を起票（→人手審査必須）
  const aiId = enqueueAiReview_(submissionId, versionId);
  logEvent_('submission', submissionId, 'licensee', null, {version_no:versionNo, ai_review_id:aiId});
  return { submission_id:submissionId, version_no:versionNo, ai_review_id:aiId };
}

/** Submission_Access トークン検証（OPEN・期限内のみ有効） */
function resolveSubmissionToken_(token){
  if(!token) return null;
  const tok = readRows_(ssOps_(),'Submission_Access').find(x => x.token_hash===hash_(token) && x.status==='OPEN');
  if(!tok) return null;
  if(tok.expires_at && new Date(tok.expires_at) < new Date()) return null;
  return tok;
}
function getOrCreateChildFolder_(parent, name){
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
/** 版のステータス更新（存在すれば） */
function markVersionStatus_(versionId, status){
  if(!versionId) return;
  updateRow_(ssOps_(),'Submission_Versions','version_id',versionId,{ status:status });
}

// ============================================================
// 6. GAS③ 管理コンソール（D-12）― google.script.run で呼ぶ
// ============================================================
// ---- 結合・分類ヘルパ ----
function worksNameMap_(){
  const m = {}; readRows_(ssMaster_(), 'Works_Master').forEach(w => { m[w.work_id] = w.work_name; });
  return m;
}
/** 契約ID → 対象原作名リスト（Contract_Works）。一括読みで構築（複数原作対応）。 */
function contractWorksMap_(){
  const nameMap = worksNameMap_();
  const m = {};
  readRows_(ssOps_(),'Contract_Works').forEach(function(x){
    (m[x.contract_id] = m[x.contract_id] || []).push(nameMap[x.work_id] || x.work_id);
  });
  return m;
}
/** 契約ID → 対象原作名（表示用の結合文字列） */
function contractWorkLabel_(map, contractId){ const a = map[contractId]; return a && a.length ? a.join('、') : ''; }
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
  const ctrWorks  = contractWorksMap_();
  const cleared   = {}; human.filter(h=>h.result==='CLEARED').forEach(h => { cleared[String(h.submission_id)] = true; });

  const kpis = {
    reviewPending: jobs.filter(j => j.status==='COMPLETED' && !cleared[String(j.submission_id)]).length,
    highRisk:      findings.filter(isHighRisk_).length,
    unscreened:    jobs.filter(j => j.status==='QUEUED' || j.status==='SCANNING').length,
    signing:       apps.filter(a => a.status && a.status!=='SIGNED' && a.status!=='CANCELLED').length,
    unpaid:        invoices.filter(v => v.status && v.status!=='入金済' && v.status!=='取消').length,
    reporting:     reports.filter(r => r.status && r.status!=='SUBMITTED' && r.status!=='APPROVED' && r.status!=='LOCKED').length
  };

  const subCtr = {}; readRows_(ssOps_(),'Submissions').forEach(s => { subCtr[s.submission_id] = s.contract_id; });
  const rows = [];
  alerts.filter(a => a.status!=='CLOSED').forEach(a => rows.push({
    kind:'審査', target:a.submission_id||a.contract_id||'', work:contractWorkLabel_(ctrWorks, a.contract_id||subCtr[a.submission_id]),
    status:String(a.severity||'ALERT'), cls:isHighRisk_(a)?'fail':'review', at:String(a.occurred_at||'')
  }));
  invoices.filter(v => v.status==='入金待ち').forEach(v => rows.push({
    kind:'入金', target:v.contract_id, work:contractWorkLabel_(ctrWorks, v.contract_id), status:'入金待ち', cls:'unpaid', at:String(v.issued_at||'')
  }));
  rows.sort((a,b) => String(b.at).localeCompare(String(a.at)));
  return { kpis: kpis, alerts: rows.slice(0,8) };
}

/** 審査キュー：提出版(version)単位に総合結果・主指摘・対象原作(複数)を結合（B経路固定） */
function admin_reviewQueue(){
  const jobs      = readRows_(ssOps_(),'AI_Review_Jobs');
  const findings  = readRows_(ssOps_(),'AI_Findings');
  const subs      = readRows_(ssOps_(),'Submissions');
  const nameMap   = worksNameMap_();
  const ctrWorks  = contractWorksMap_();
  const subById   = {}; subs.forEach(s => { subById[s.submission_id] = s; });

  return jobs.map(j => {
    const fs = findings.filter(f => f.ai_review_id===j.ai_review_id);
    const top = fs.slice().sort((a,b)=>sevRank_(b)-sevRank_(a))[0];
    const sub = subById[j.submission_id] || {};
    const topWork = top && top.work_id ? (nameMap[top.work_id] || top.work_id) : '';
    return {
      id: j.submission_id || j.ai_review_id,
      ai_review_id: j.ai_review_id,
      submission_id: j.submission_id || '',
      version_id: j.version_id || '',
      title: sub.title || '',
      work: contractWorkLabel_(ctrWorks, sub.contract_id),
      job_status: j.status,
      result: j.status==='COMPLETED' ? worstResult_(fs) : (j.status||'QUEUED'),
      finding: top ? (topWork ? '['+topWork+'] ' : '') + String(top.evidence||top.result||'') : ''
    };
  });
}

/** 人手判断の記録（CLEARED / CORRECTION_REQUIRED / ESCALATED）。版・提出状態も更新。 */
function admin_setHumanReview(submissionId, result, comment, reviewer, versionId){
  reviewer = reviewer || actor_();
  appendRow_(ssOps_(),'Human_Reviews',{ human_review_id:newId_('HRV'), submission_id:submissionId,
    version_id:versionId||latestVersionId_(submissionId), reviewer:reviewer, result:result,
    comments:comment||'', reviewed_at:new Date().toISOString() });
  const subStatus = result==='CLEARED' ? 'CLEARED'
    : (result==='CORRECTION_REQUIRED' ? 'CORRECTION_REQUIRED'
    : (result==='ESCALATED' ? 'ESCALATED' : 'HUMAN_REVIEW_PENDING'));
  updateRow_(ssOps_(),'Submissions','submission_id',submissionId,{ status:subStatus });
  markVersionStatus_(versionId||latestVersionId_(submissionId), result==='CLEARED' ? 'CLEARED' : result);
  logEvent_('human_review', submissionId, reviewer, null, {result:result});
  return true;
}
/** 提出の最新版ID */
function latestVersionId_(submissionId){
  const vs = readRows_(ssOps_(),'Submission_Versions').filter(v => v.submission_id===submissionId)
    .sort(function(a,b){ return num_(b.version_no)-num_(a.version_no); });
  return vs.length ? vs[0].version_id : '';
}

/** 契約一覧：締結済(Contracts)＋締結待ち(Applications)を結合、契約者名はマスク、対象原作は複数表示 */
function admin_listContracts(){
  const contracts = readRows_(ssOps_(),'Contracts');
  const apps      = readRows_(ssOps_(),'Applications');
  const ctrWorks  = contractWorksMap_();
  const appWorks  = {};   // application_id → 原作名リスト（締結前）
  const nameMap   = worksNameMap_();
  readRows_(ssOps_(),'Application_Works').forEach(function(x){
    (appWorks[x.application_id] = appWorks[x.application_id] || []).push(nameMap[x.work_id] || x.work_id);
  });
  const certs = readRows_(ssOps_(),'Certificates');
  const certByContract = {}; certs.forEach(x => { certByContract[x.contract_id] = x.status; });
  const rows = contracts.map(c => ({
    contract_id:c.contract_id, application_id:c.application_id, application_ref:c.application_ref||'',
    work:contractWorkLabel_(ctrWorks, c.contract_id),
    applicant:'＊＊＊＊（個人）', status:c.status||'', signed_at:String(c.signed_at||''),
    cert_status: certByContract[c.contract_id] || 'NONE'
  }));
  const contracted = {}; contracts.forEach(c => { if(c.application_id) contracted[c.application_id] = true; });
  apps.filter(a => a.status && a.status!=='SIGNED' && !contracted[a.application_id]).forEach(a => rows.push({
    contract_id:'—', application_id:a.application_id, application_ref:a.application_ref||'',
    work:(appWorks[a.application_id]||[]).join('、'),
    applicant:'＊＊＊＊（個人）', status:'締結待ち（'+(a.status||'')+'）', signed_at:'', cert_status:'NONE'
  }));
  return rows;
}

/**
 * B経路：締結済契約の作品提出リンクを発行して返す（当社からメール送信はしない）。
 * 既存の有効トークンがあれば再利用し、無ければ Submission_Access を新規発行。
 */
function admin_sendUploadLink(contractId){
  const c = readRows_(ssOps_(),'Contracts').find(x => x.contract_id===contractId);
  if(!c) throw new Error('契約が見つかりません: '+contractId);
  let token = '';
  const existing = readRows_(ssOps_(),'Submission_Access')
    .find(x => x.contract_id===contractId && x.status==='OPEN' && (!x.expires_at || new Date(x.expires_at) > new Date()));
  if(existing){
    // トークン実体は保存していないため、再掲不可の場合は新規発行し直す
    token = prepareSubmissionToken_(contractId);
  }else{
    token = prepareSubmissionToken_(contractId);
  }
  let base = ''; try{ base = ScriptApp.getService().getUrl() || ''; }catch(e){}
  const url = base ? (base + '?page=upload&t=' + token) : ('?page=upload&t=' + token);
  logEvent_('contract', contractId, actor_(), null, {upload_link_issued:true});
  return { url:url, token:token };
}

/** 入金管理：請求(Invoices)に入金(Payments)状況・作品名を結合 */
function admin_listPayments(){
  const invoices  = readRows_(ssOps_(),'Invoices');
  const payments  = readRows_(ssOps_(),'Payments');
  const ctrWorks  = contractWorksMap_();
  return invoices.map(v => {
    const pay = payments.find(p => String(p.invoice_id)===String(v.invoice_id) && p.status==='入金済');
    return {
      invoice_id:v.invoice_id, contract_id:v.contract_id, work:contractWorkLabel_(ctrWorks, v.contract_id),
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
  // 認証・バッジは締結時に発行済み（B経路固定）。入金では発行しない。
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
  // 契約→対象原作（Contract_Works）。複数原作を1契約で包括許諾（契約単位でロイヤリティ計算）。
  const ctrWorkIds = {}; readRows_(ssOps_(),'Contract_Works').forEach(x => { (ctrWorkIds[x.contract_id] = ctrWorkIds[x.contract_id] || []).push(x.work_id); });
  const workById = {}; readRows_(ssMaster_(),'Works_Master').forEach(w => { workById[w.work_id] = w; });
  const partners = readRows_(ssOps_(),'Partners');

  const royaltyRate  = num_(getConfig_('DEFAULT_ROYALTY_RATE', '0.10'));   // 契約単位の既定ロイヤリティ率
  const handlingRate = num_(getConfig_('HANDLING_FEE_RATE',   '0.30'));    // 事務手数料率

  const byPartner = {};  // partner_id -> { partner, details:[], total }
  reports.forEach(r => {
    const net = num_(r.net_sales);
    const licenseFee   = Math.round(net * royaltyRate);
    const partnerShare = Math.round(licenseFee * (1 - handlingRate));
    // 契約対象原作のパートナー群へ均等配分（原作ごとの別料金は設けない）
    const workIds = ctrWorkIds[r.contract_id] || [];
    const pmap = {};   // partner_id -> partner
    workIds.forEach(function(wid){ const p = resolveWorkPartner_(workById[wid] || { work_id:wid, publisher:'' }, partners); pmap[p.partner_id] = p; });
    let plist = Object.keys(pmap).map(function(k){ return pmap[k]; });
    if(!plist.length) plist = [ resolveWorkPartner_({ work_id:'', publisher:'' }, partners) ];   // 未割当
    const each = Math.floor(partnerShare / plist.length);
    let remainder = partnerShare - each * plist.length;
    plist.forEach(function(partner){
      const amt = each + (remainder-- > 0 ? 1 : 0);   // 端数は先頭から1ずつ
      const key = partner.partner_id;
      if(!byPartner[key]) byPartner[key] = { partner:partner, details:[], total:0 };
      byPartner[key].details.push({
        contract_id: r.contract_id,
        rate_snapshot: JSON.stringify({ royalty_rate:royaltyRate, handling_fee_rate:handlingRate,
          net_sales:net, license_fee:licenseFee, works:workIds.length, partners:plist.length, report_id:r.report_id }),
        amount: amt
      });
      byPartner[key].total += amt;
    });
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
      version:1, sent_at:'', finalized_at:'' });
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
      { status:'OBJECTION_PERIOD', effective_date:eff, objection_due:due, sent_at:today.toISOString() });
    updateRow_(ssOps_(),'Settlements','settlement_id',s.settlement_id,{ status:'SENT' });
    logEvent_('settlement_statement', s.statement_id, 'system', {status:'APPROVED'},
      {status:'OBJECTION_PERIOD', effective_date:eff, objection_due:due});
  });
  return { sent: list.length };
}
/** 計算書（仕入明細書）をPDF化→Drive保存→CloudSign送信（みなし合意付き） */
function cloudSignSendStatement_(statement){
  const partner = readRows_(ssOps_(),'Partners').find(p => p.partner_id===statement.partner_id) || {};
  const pdf  = buildStatementPdf_(statement, partner);
  const file = DriveApp.getFolderById(cfg_('DRIVE_ROOT'))
    .createFile(pdf.setName('statement_' + statement.period + '_' + statement.partner_id + '.pdf'));
  updateRow_(ssOps_(),'Settlement_Statements','statement_id',statement.statement_id,{ pdf_file_id: file.getId() });

  const title = 'SPLL 仕入明細書 ' + statement.period + '（' + (partner.name || statement.partner_id) + '）';
  const note  = 'みなし合意：発効日から1ヶ月以内にご異議のない場合、本仕入明細書の内容にご同意いただいたものとみなします。';
  const doc   = cs_createDocument_(title, note);
  cs_attachFile_(doc.id, file.getBlob(), file.getName());
  if(partner.contact) cs_addParticipant_(doc.id, partner.contact, partner.name || '');
  cs_sendDocument_(doc.id);
  logEvent_('settlement_statement', statement.statement_id, 'cloudsign', null,
    { cloudsign_document_id: doc.id, pdf_file_id: file.getId(), sandbox: cs_isSandbox_() });
  return doc.id;
}

/** 仕入明細書PDFを生成（明細＝Settlement_Details、登録番号スナップショット付き） */
function buildStatementPdf_(statement, partner){
  const details = readRows_(ssOps_(),'Settlement_Details')
    .filter(d => d.settlement_id===statement.settlement_id);
  const rows = details.map(d => {
    let snap = {}; try{ snap = JSON.parse(d.rate_snapshot || '{}'); }catch(e){}
    return '<tr><td>' + (d.contract_id||'') + '</td><td style="text-align:right">' + (snap.net_sales!=null?snap.net_sales:'') +
      '</td><td style="text-align:right">' + (snap.royalty_rate!=null?snap.royalty_rate:'') +
      '</td><td style="text-align:right">' + (snap.handling_fee_rate!=null?snap.handling_fee_rate:'') +
      '</td><td style="text-align:right">' + (d.amount||0) + '</td></tr>';
  }).join('');
  const total = details.reduce((s,d)=> s + num_(d.amount), 0);
  const html = '<html><head><meta charset="utf-8"><style>body{font-family:sans-serif;}'
    + 'table{border-collapse:collapse;width:100%;}th,td{border:1px solid #999;padding:6px;font-size:12px;}'
    + 'th{background:#eee;}</style></head><body>'
    + '<h1>仕入明細書</h1>'
    + '<p>対象期：' + (statement.period||'') + '　／　パートナー：' + (partner.name || statement.partner_id || '') + '</p>'
    + '<p>登録番号：' + (statement.reg_number_snapshot || partner.invoice_reg_number || '（未登録）') + '</p>'
    + '<table><thead><tr><th>契約ID</th><th>純売上</th><th>ロイヤリティ率</th><th>事務手数料率</th><th>配分額</th></tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '<tfoot><tr><th colspan="4" style="text-align:right">合計</th><th style="text-align:right">' + total + '</th></tr></tfoot></table>'
    + '<p style="font-size:11px;color:#555;margin-top:14px;">本明細は仕入明細書方式により作成しています。発効日から1ヶ月以内にご異議のない場合、内容にご同意いただいたものとみなします。</p>'
    + '</body></html>';
  return Utilities.newBlob(html, 'text/html', 'statement.html').getAs('application/pdf');
}

/**
 * 日次：異議期間（発効日＋1ヶ月）到来かつ無申出を NO_OBJECTION_RECORDED → FINALIZED へ。
 * ※ 相手方の積極的確認と誤認されうる CONFIRMED は使用しない。
 */
function batch_confirmDeemed(){
  const now = new Date();
  readRows_(ssOps_(),'Settlement_Statements')
    .filter(s=> s.status==='OBJECTION_PERIOD' && s.objection_due && new Date(s.objection_due) <= now)
    .forEach(s=> {
      updateRow_(ssOps_(),'Settlement_Statements','statement_id',s.statement_id,
        {status:'NO_OBJECTION_RECORDED', finalized_at: now.toISOString()});
      if(s.settlement_id) updateRow_(ssOps_(),'Settlements','settlement_id',s.settlement_id,{status:'NO_OBJECTION_RECORDED'});
      logEvent_('settlement_statement', s.statement_id, 'system', {status:'OBJECTION_PERIOD'}, {status:'NO_OBJECTION_RECORDED'});
    });
}
/** 異議申立の記録（管理コンソール） */
function admin_recordObjection(statementId, note){
  updateRow_(ssOps_(),'Settlement_Statements','statement_id',statementId,{ status:'OBJECTION_RECEIVED' });
  logEvent_('settlement_statement', statementId, actor_(), null, { status:'OBJECTION_RECEIVED', note:note||'' });
  return true;
}
/** 支払確定（管理コンソール）：NO_OBJECTION_RECORDED → FINALIZED */
function admin_finalizeStatement(statementId){
  updateRow_(ssOps_(),'Settlement_Statements','statement_id',statementId,{ status:'FINALIZED', finalized_at:new Date().toISOString() });
  logEvent_('settlement_statement', statementId, actor_(), null, { status:'FINALIZED' });
  return true;
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
  'credit_text','allocation_scheme_id','billing_type'];

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
  return row.work_id;   // X投稿は保存後にクライアント側で送信許可ポップアップ→admin_postWorkToX
}

/** 公開状態の切替（PUBLISHED / DRAFT / UNPUBLISHED 等） */
function admin_setWorkPublish(workId, status){
  updateRow_(ssMaster_(), 'Works_Master', 'work_id', workId, { publish_status: status });
  logEvent_('work', workId, actor_(), null, { publish_status: status });
  return true;   // X投稿は送信許可ポップアップ→admin_postWorkToX
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
      sandbox:      prop_('CLOUDSIGN_SANDBOX') !== 'false'   // 既定はサンドボックスON
    },
    formrun: {
      form_url:           prop_('FORMRUN_FORM_URL')   || '',
      webhook_secret_set: !!prop_('FORMRUN_WEBHOOK_SECRET'),
      field_map:          prop_('FORMRUN_FIELD_MAP')  || '',
      ref_param:          prop_('FORM_REF_PARAM')     || ''   // application_ref を引き継ぐhidden項目キー（例：_field_xxxxxx）
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
  if(c.ref_param      !== undefined) sp.setProperty('FORM_REF_PARAM',    String(c.ref_param));
  logEvent_('config', 'FORMRUN', actor_(), null, { saved: true });
  return true;
}

// ============================================================
// 10. セットアップ / インストーラ（Apps Scriptエディタから1回 Run）
//     スプレッドシート（SS_MASTER/SS_OPS）・Drive親フォルダを自動作成し、
//     各IDを ScriptProperties へ登録、既定設定とサンプルを投入する。冪等。
// ============================================================
const SCHEMA_MASTER = {
  Works_Master:    ['work_id','work_name','publisher','category','publish_status','review_timing','review_policy','fee_label','media','ok_elements','no_elements','credit_text','allocation_scheme_id','royalty_rate','partner_id','billing_type'],
  Review_Rules:    ['rule_id','work_id','category','rule_text','severity','effective_from','effective_to'],
  Reference_Assets:['asset_id','work_id','asset_type','drive_file_id','allowed_flag']
};
const SCHEMA_OPS = {
  // 申込：複数原作は中間テーブル Application_Works で管理（B経路固定・A/B分岐なし）
  Applications:         ['application_id','application_ref','status','created_at'],
  Application_Works:    ['application_work_id','application_id','work_id'],
  // 契約：締結時に対象原作を Contract_Works へスナップショット（法務証跡）
  Contracts:            ['contract_id','cloudsign_document_id','application_id','application_ref','status','signed_at','folder_id'],
  Contract_Works:       ['contract_work_id','contract_id','work_id'],
  // 提出：トークンでアクセス、版(Version)で再提出管理
  Submission_Access:    ['token_id','contract_id','token_hash','status','expires_at','max_uploads'],
  Submissions:          ['submission_id','contract_id','title','status','submitted_at'],
  Submission_Versions:  ['version_id','submission_id','version_no','status','submitted_at'],
  Submission_Files:     ['submission_file_id','version_id','drive_file_id','mime_type','size','sha256'],
  AI_Review_Jobs:       ['ai_review_id','submission_id','version_id','model','prompt_version','status','retry_count'],
  AI_Findings:          ['finding_id','ai_review_id','work_id','rule_id','severity','result','page','evidence','confidence'],
  Human_Reviews:        ['human_review_id','submission_id','version_id','reviewer','result','comments','reviewed_at'],
  Compliance_Alerts:    ['alert_id','contract_id','submission_id','severity','status','settlement_block'],
  Usage_Reports:        ['report_id','contract_id','period','channel','qty','gross_sales','returns','deductions','net_sales','sales_url','status','submitted_at'],
  Invoices:             ['invoice_id','contract_id','period','amount_rule','amount','status','issued_at'],
  Payments:             ['payment_id','invoice_id','contract_id','amount','paid_at','method','status','recorded_by'],
  Settlements:          ['settlement_id','partner_id','period','amount','status','hold_reason'],
  Settlement_Details:   ['settlement_detail_id','settlement_id','contract_id','rate_snapshot','amount'],
  // 清算ステータスは CONFIRMED を使わず OBJECTION_PERIOD→NO_OBJECTION_RECORDED→FINALIZED
  Settlement_Statements:['statement_id','settlement_id','partner_id','period','type','reg_number_snapshot','status','effective_date','objection_due','pdf_file_id','sheet_id','version','sent_at','finalized_at'],
  Partners:             ['partner_id','name','invoice_reg_number','is_qualified_issuer','bank','contact'],
  Badges:               ['badge_id','contract_id','issued_at','png_l','png_m','png_s','token_hash','status'],
  // 認証：状態＋変更理由・承認記録
  Certificates:         ['cert_id','contract_id','status','reason_code','reason_text','requested_by','approved_by','legal_case_id','effective_at','check_code','issued_at'],
  Events:               ['event_id','entity_type','entity_id','actor','before','after','occurred_at'],
  Config:               ['config_key','value','environment','updated_at']
};

const SAMPLE_WORKS_SEED = [
  {work_id:'WRK-ARK00045', work_name:'光砕のリヴァルチャー', publisher:'どらこにあん／アークライト', category:'TRPG / ルールブック', publish_status:'PUBLISHED', review_timing:'A', review_policy:'PRE_CONTRACT（契約前審査）', fee_label:'書籍：16,500円／作品', media:'書籍,電子書籍,商品販売', ok_elements:'世界観設定,シナリオ,キャラクター名称', no_elements:'公式イラスト流用', credit_text:'指定の権利表記を記載', allocation_scheme_id:'', royalty_rate:'', partner_id:'PRT-DRACO'},
  {work_id:'WRK-ARK00012', work_name:'新クトゥルフ神話TRPG', publisher:'アークライト／KADOKAWA', category:'TRPG / ルールブック', publish_status:'PUBLISHED', review_timing:'B', review_policy:'PATROL_ONLY（契約後審査）', fee_label:'電子書籍：売上の10％', media:'書籍,電子書籍,商品販売', ok_elements:'世界観・神話設定,シナリオ', no_elements:'公式イラスト流用,ルールデータ転載', credit_text:'指定のシリーズ権利表記を記載', allocation_scheme_id:'', royalty_rate:'0.10', partner_id:'PRT-ARK'},
  {work_id:'WRK-BKK00019', work_name:'インセイン', publisher:'冒険企画局', category:'TRPG / ルールブック', publish_status:'DRAFT', review_timing:'B', review_policy:'PATROL_ONLY（契約後審査）', fee_label:'電子書籍：売上の10％', media:'電子書籍', ok_elements:'世界観設定,ハンドアウト形式', no_elements:'シナリオデータ転載', credit_text:'指定の権利表記を記載', allocation_scheme_id:'', royalty_rate:'0.10', partner_id:''}
];
const SAMPLE_PARTNERS_SEED = [
  {partner_id:'PRT-DRACO', name:'どらこにあん', invoice_reg_number:'T0000000000000', is_qualified_issuer:'true', bank:'', contact:''},
  {partner_id:'PRT-ARK',   name:'アークライト', invoice_reg_number:'T0000000000000', is_qualified_issuer:'true', bank:'', contact:''}
];

/** シートをスキーマ通りに用意（ヘッダ設定・先頭行固定・既定シート削除）。既存ヘッダは上書きしない。 */
function initSheets_(ss, schema){
  const names = Object.keys(schema);
  names.forEach(name => {
    let sh = ss.getSheetByName(name);
    if(!sh) sh = ss.insertSheet(name);
    const headers = schema[name];
    const first = sh.getRange(1,1,1,Math.max(1,sh.getLastColumn())).getValues()[0];
    const hasHeader = first && String(first[0]||'') !== '';
    if(!hasHeader){
      sh.getRange(1,1,1,headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
  });
  // schema に無い既定シート（'シート1' / 'Sheet1' 等）を削除
  ss.getSheets().filter(sh => names.indexOf(sh.getName()) < 0).forEach(sh => {
    if(ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
}

/**
 * ワンクリック・セットアップ。Apps Scriptエディタで関数 setup_bootstrap を選び Run。
 * opts: { force:true で既存IDを無視して再作成, seed:false でサンプル投入なし }
 * 返り値（実行ログにも出力）に作成した各IDを含む。
 */
function setup_bootstrap(opts){
  opts = opts || {};
  const sp = PropertiesService.getScriptProperties();
  const out = { created:{}, reused:{} };

  // 1) 作品マスタ
  let masterId = sp.getProperty('SS_MASTER');
  if(masterId && !opts.force){ out.reused.SS_MASTER = masterId; }
  else {
    const ss = SpreadsheetApp.create('SPLL 作品マスタ (SS_MASTER)');
    initSheets_(ss, SCHEMA_MASTER);
    masterId = ss.getId(); sp.setProperty('SS_MASTER', masterId);
    out.created.SS_MASTER = masterId;
  }
  // 2) 業務台帳
  let opsId = sp.getProperty('SS_OPS');
  if(opsId && !opts.force){ out.reused.SS_OPS = opsId; }
  else {
    const ss = SpreadsheetApp.create('SPLL 業務台帳 (SS_OPS)');
    initSheets_(ss, SCHEMA_OPS);
    opsId = ss.getId(); sp.setProperty('SS_OPS', opsId);
    out.created.SS_OPS = opsId;
  }
  // 3) Drive 親フォルダ
  let rootId = sp.getProperty('DRIVE_ROOT');
  if(rootId && !opts.force){ out.reused.DRIVE_ROOT = rootId; }
  else {
    rootId = DriveApp.createFolder('SPLL 契約フォルダ (DRIVE_ROOT)').getId();
    sp.setProperty('DRIVE_ROOT', rootId);
    out.created.DRIVE_ROOT = rootId;
  }

  // 4) 既定設定（未設定のみ）
  if(!getConfig_('LEGAL_PRIVACY_TEXT',''))   setConfig_('LEGAL_PRIVACY_TEXT',   DEFAULT_PRIVACY);
  if(!getConfig_('LEGAL_TERMS_TEMPLATE','')) setConfig_('LEGAL_TERMS_TEMPLATE', DEFAULT_TERMS_TEMPLATE);
  if(!getConfig_('DEFAULT_ROYALTY_RATE','')) setConfig_('DEFAULT_ROYALTY_RATE','0.10');
  if(!getConfig_('HANDLING_FEE_RATE',''))    setConfig_('HANDLING_FEE_RATE',   '0.30');

  // 5) サンプル投入（既定ON・既存があればスキップ）
  if(opts.seed !== false) setup_seedSamples_();

  out.properties = { SS_MASTER:masterId, SS_OPS:opsId, DRIVE_ROOT:rootId };
  out.urls = {
    SS_MASTER:'https://docs.google.com/spreadsheets/d/'+masterId,
    SS_OPS:'https://docs.google.com/spreadsheets/d/'+opsId,
    DRIVE_ROOT:'https://drive.google.com/drive/folders/'+rootId
  };
  logEvent_('batch','bootstrap','setup', null, out.properties);
  Logger.log('SS_MASTER = %s', masterId);
  Logger.log('SS_OPS    = %s', opsId);
  Logger.log('DRIVE_ROOT= %s', rootId);
  Logger.log('done: %s', JSON.stringify(out));
  return out;
}

/** サンプル作品・パートナーを投入（各シートが空のときのみ） */
function setup_seedSamples_(){
  if(readRows_(ssMaster_(),'Works_Master').length === 0){
    SAMPLE_WORKS_SEED.forEach(w => appendRow_(ssMaster_(),'Works_Master', w));
  }
  if(readRows_(ssOps_(),'Partners').length === 0){
    SAMPLE_PARTNERS_SEED.forEach(p => appendRow_(ssOps_(),'Partners', p));
  }
}

/**
 * 作り直し：既存IDを無視して SS_MASTER / SS_OPS / DRIVE_ROOT を新規に作成し直す。
 * 本番データが無い前提。Apps Scriptエディタで setup_reset を選んで Run。
 * ※ 旧スプレッドシート/フォルダはDriveに残るため、不要なら手動でゴミ箱へ。
 */
function setup_reset(){ return setup_bootstrap({ force:true }); }

/** 現在の接続先IDを確認（エディタ実行用）。 */
function setup_status(){
  const s = { SS_MASTER:prop_('SS_MASTER')||'(未設定)', SS_OPS:prop_('SS_OPS')||'(未設定)',
    DRIVE_ROOT:prop_('DRIVE_ROOT')||'(未設定)' };
  Logger.log(JSON.stringify(s)); return s;
}

// ============================================================
// 11. X（Twitter）連携：作品公開時の告知投稿
//     資格情報は ScriptProperties（X_API_KEY 等）。投稿は X API v2 /2/tweets（OAuth1.0a）。
// ============================================================
const X_DEFAULT_TEMPLATE =
  '【SPLL 対象作品】{name}（{publisher}）\n二次創作の有料頒布ライセンスのお申込みを受付中です。 #SPLL #TRPG\n{url}';

function x_isConfigured_(){
  return !!(prop_('X_API_KEY') && prop_('X_API_SECRET') && prop_('X_ACCESS_TOKEN') && prop_('X_ACCESS_SECRET'));
}
function x_autopost_(){ return prop_('X_AUTOPOST') === 'true'; }

/** 投稿文の組み立て（作品情報を差込） */
function x_buildPostText_(work){
  const tmpl = getConfig_('X_POST_TEMPLATE', X_DEFAULT_TEMPLATE);
  let url = ''; try{ url = ScriptApp.getService().getUrl() || ''; }catch(e){}
  return tmpl
    .replace(/{name}/g, work.work_name || work.name || '')
    .replace(/{publisher}/g, work.publisher || work.pub || '')
    .replace(/{fee}/g, work.fee_label || work.fee || '')
    .replace(/{url}/g, url);
}

/** X API v2 にツイート送信（OAuth1.0a 署名） */
function x_postTweet_(text){
  if(!x_isConfigured_()) throw new Error('X未設定：管理コンソール「設定」でAPIキーを登録してください');
  const url = 'https://api.twitter.com/2/tweets';
  const oauth = {
    oauth_consumer_key: prop_('X_API_KEY'),
    oauth_token:        prop_('X_ACCESS_TOKEN'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:    String(Math.floor(Date.now() / 1000)),
    oauth_nonce:        Utilities.getUuid().replace(/-/g, ''),
    oauth_version:      '1.0'
  };
  // v2のJSONボディは署名対象に含めない（oauth_*パラメータのみ）
  oauth.oauth_signature = x_oauth1Signature_('POST', url, oauth, prop_('X_API_SECRET'), prop_('X_ACCESS_SECRET'));
  const header = 'OAuth ' + Object.keys(oauth).sort().map(function(k){ return x_enc_(k) + '="' + x_enc_(oauth[k]) + '"'; }).join(', ');
  const res = UrlFetchApp.fetch(url, { method:'post', contentType:'application/json',
    headers:{ Authorization: header }, payload: JSON.stringify({ text: text }), muteHttpExceptions:true });
  const code = res.getResponseCode();
  if(code < 200 || code >= 300) throw new Error('X API HTTP ' + code + ': ' + res.getContentText());
  return JSON.parse(res.getContentText());
}
function x_enc_(s){ return encodeURIComponent(String(s)).replace(/[!*'()]/g, function(c){ return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); }
function x_oauth1Signature_(method, url, oauthParams, consumerSecret, tokenSecret){
  const pstr = Object.keys(oauthParams).sort().map(function(k){ return x_enc_(k) + '=' + x_enc_(oauthParams[k]); }).join('&');
  const base = [method.toUpperCase(), x_enc_(url), x_enc_(pstr)].join('&');
  const key  = x_enc_(consumerSecret) + '&' + x_enc_(tokenSecret);
  return Utilities.base64Encode(Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, base, key));
}

/** 作品をXへ投稿（管理コンソール・手動/自動から呼ぶ）。冪等（作品ごと1回）。 */
function admin_postWorkToX(workId){
  const w = readRows_(ssMaster_(),'Works_Master').find(function(x){ return x.work_id === workId; });
  if(!w) throw new Error('作品が見つかりません: ' + workId);
  const text = x_buildPostText_(w);
  const res  = x_postTweet_(text);
  const tid  = (res && res.data && res.data.id) || '';
  PropertiesService.getScriptProperties().setProperty('XP_' + workId, tid || 'posted');
  logEvent_('work', workId, actor_(), null, { x_posted:true, tweet_id:tid });
  return { tweet_id: tid, text: text };
}
/**
 * 送信許可ポップアップ用のプレビュー。作品データ更新時にクライアントが呼び、
 * autopost=ON かつ 設定済み なら text を確認ダイアログに表示 → 承認で admin_postWorkToX。
 * （サイレント自動投稿はしない：送信は必ず人の許可を挟む）
 */
function admin_getXPostPreview(workId){
  const w = readRows_(ssMaster_(),'Works_Master').find(function(x){ return x.work_id === workId; });
  if(!w) return { text:'', configured:false, autopost:false, published:false };
  return {
    text:       x_buildPostText_(w),
    configured: x_isConfigured_(),
    autopost:   x_autopost_(),
    published:  w.publish_status === 'PUBLISHED',
    already_posted: !!prop_('XP_' + workId)
  };
}

// ============================================================
// 12. 認証バッジ（クレジット表記）：入金確認後にPNG3サイズを発行・配布
//     Google Slidesで1枚を組版→サムネイル(LARGE/MEDIUM/SMALL)をPNG化→Drive保存→トークンDLページ＋メール。
// ============================================================
const BADGE_SIZES = [{ key:'L', size:'LARGE' }, { key:'M', size:'MEDIUM' }, { key:'S', size:'SMALL' }];

// B経路固定：認証・バッジは締結時に発行（課金モデル分岐なし）。

/** バッジ発行（契約単位・冪等）。BADGE_TEMPLATE_IDがあればテンプレ差込、無ければ自動組版。 */
function issueBadge_(contractId){
  const existing = readRows_(ssOps_(),'Badges').find(function(b){ return b.contract_id === contractId && b.status === 'ISSUED'; });
  if(existing) return { badge_id: existing.badge_id, reused:true };

  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; });
  if(!c) throw new Error('契約が見つかりません: ' + contractId);
  // 複数原作：Contract_Works からまとめた表示名を使う（契約単位のバッジ）
  const w = { work_name: contractWorkNames_(contractId).join('、'), credit_text:'' };
  const badgeId  = newId_('BDG');
  const issuedAt = new Date().toISOString().slice(0,10);

  const presId = buildBadgeSlide_(badgeId, w, c, issuedAt);
  const folder = badgeFolder_(c);
  const files = BADGE_SIZES.map(function(s){
    const blob = slideThumbnailPng_(presId, s.size).setName('SPLL_badge_' + badgeId + '_' + s.key + '.png');
    const f = folder.createFile(blob);
    try{ f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}
    return { size:s.key, file_id:f.getId() };
  });
  try{ DriveApp.getFileById(presId).setTrashed(true); }catch(e){}   // 一時Slidesは破棄

  appendRow_(ssOps_(),'Badges', { badge_id:badgeId, contract_id:contractId,
    issued_at:issuedAt, png_l:files[0].file_id, png_m:files[1].file_id, png_s:files[2].file_id,
    token_hash:'', status:'ISSUED' });
  distributeBadge_(c, badgeId);
  logEvent_('badge', badgeId, 'system', null, { contract_id:contractId, files:files });
  return { badge_id:badgeId, files:files };
}

/** バッジ1枚をSlidesで組版し presentationId を返す */
function buildBadgeSlide_(badgeId, w, c, issuedAt){
  const templateId = prop_('BADGE_TEMPLATE_ID');
  if(templateId){
    const copy = DriveApp.getFileById(templateId).makeCopy('SPLL_badge_' + badgeId);
    const pres = SlidesApp.openById(copy.getId());
    pres.replaceAllText('{{work_name}}', w.work_name || '');
    pres.replaceAllText('{{license_id}}', c.contract_id || '');
    pres.replaceAllText('{{issued_at}}', issuedAt);
    pres.replaceAllText('{{credit}}', w.credit_text || '');
    pres.saveAndClose();
    return pres.getId();
  }
  // テンプレ未設定：暫定デザインを自動組版
  const pres  = SlidesApp.create('SPLL_badge_' + badgeId);
  const slide = pres.getSlides()[0];
  slide.getBackground().setSolidFill('#3D2F6B');
  var t;
  t = slide.insertTextBox('SPLL 正規ライセンス', 36, 40, 648, 60);
  t.getText().getTextStyle().setForegroundColor('#FFFFFF').setBold(true).setFontSize(28);
  t = slide.insertTextBox(w.work_name || '', 36, 120, 648, 70);
  t.getText().getTextStyle().setForegroundColor('#F4EBD8').setBold(true).setFontSize(24);
  t = slide.insertTextBox('ライセンスID: ' + (c.contract_id || '') + '\n発行日: ' + issuedAt, 36, 205, 648, 70);
  t.getText().getTextStyle().setForegroundColor('#D7CFEC').setFontSize(14);
  t = slide.insertTextBox(w.credit_text || '', 36, 290, 648, 60);
  t.getText().getTextStyle().setForegroundColor('#EDEAF4').setFontSize(12);
  pres.saveAndClose();
  return pres.getId();
}

/** Slides REST の getThumbnail でPNG化（size: LARGE/MEDIUM/SMALL） */
function slideThumbnailPng_(presId, size){
  const pageId = SlidesApp.openById(presId).getSlides()[0].getObjectId();
  const url = 'https://slides.googleapis.com/v1/presentations/' + presId + '/pages/' + pageId +
    '/thumbnail?thumbnailProperties.thumbnailSize=' + size + '&thumbnailProperties.mimeType=PNG';
  const meta = UrlFetchApp.fetch(url, { headers:{ Authorization:'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions:true });
  if(meta.getResponseCode() >= 300) throw new Error('Slides thumbnail HTTP ' + meta.getResponseCode() + ': ' + meta.getContentText());
  const contentUrl = JSON.parse(meta.getContentText()).contentUrl;
  return UrlFetchApp.fetch(contentUrl, { muteHttpExceptions:true }).getBlob();
}

function badgeFolder_(c){
  try{ if(c.folder_id) return DriveApp.getFolderById(c.folder_id); }catch(e){}
  return DriveApp.getFolderById(cfg_('DRIVE_ROOT'));
}

/**
 * 案③：当社からメールは送らない。バッジは検証ポータル（受付番号）から利用者がダウンロードする。
 * バッジ行にDLトークンも保持しておく（トークン直リンクでの配布が必要になった場合に備える）。
 */
function distributeBadge_(c, badgeId){
  const token = Utilities.getUuid();
  updateRow_(ssOps_(),'Badges','badge_id',badgeId,{ token_hash: hash_(token) });
  return ScriptApp.getService().getUrl() + '?page=badge&token=' + token;   // 利用時のみ使用（メール送信はしない）
}

/** バッジDLページ（トークン）：3サイズのプレビューとダウンロードリンク */
function serveBadge_(e){
  const token = (e.parameter && e.parameter.token) || '';
  const b = readRows_(ssOps_(),'Badges').find(function(x){ return x.token_hash === hash_(token) && String(x.status) === 'ISSUED'; });
  if(!b) return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">リンクが無効です。</p>').setTitle('SPLL 認証バッジ');
  const workNames = contractWorkNames_(b.contract_id).join('、');   // 契約単位（複数原作）
  const rows = [['大 (L)', b.png_l], ['中 (M)', b.png_m], ['小 (S)', b.png_s]].map(function(p){
    const view = 'https://drive.google.com/uc?id=' + p[1];
    const dl   = 'https://drive.google.com/uc?export=download&id=' + p[1];
    return '<div style="margin:18px 0"><div style="font-weight:600;margin-bottom:6px">' + p[0] + '</div>' +
      '<img src="' + view + '" style="max-width:100%;border:1px solid #ccc;border-radius:8px"><br>' +
      '<a href="' + dl + '" style="display:inline-block;margin-top:6px">PNGをダウンロード</a></div>';
  }).join('');
  const html = '<div style="font-family:sans-serif;max-width:720px;margin:0 auto;padding:24px">' +
    '<h2>SPLL 認証バッジ</h2><p>' + esc_(workNames) + ' ／ ライセンスID: ' + b.contract_id +
    ' ／ 発行日: ' + b.issued_at + '</p>' + rows +
    '<p style="font-size:12px;color:#666">クレジット表記としてご利用ください。表示位置・改変の可否は利用規約に従います。</p></div>';
  return HtmlService.createHtmlOutput(html).setTitle('SPLL 認証バッジ');
}

// ---- 11/12 管理コンソール設定・手動操作 ----
function admin_getXConfig(){
  return {
    api_key:          prop_('X_API_KEY') || '',
    api_secret_set:   !!prop_('X_API_SECRET'),
    access_token:     prop_('X_ACCESS_TOKEN') || '',
    access_secret_set:!!prop_('X_ACCESS_SECRET'),
    autopost:         prop_('X_AUTOPOST') === 'true',
    template:         getConfig_('X_POST_TEMPLATE', X_DEFAULT_TEMPLATE)
  };
}
function admin_saveXConfig(c){
  const sp = PropertiesService.getScriptProperties();
  if(c.api_key      !== undefined) sp.setProperty('X_API_KEY', String(c.api_key));
  if(c.api_secret)                 sp.setProperty('X_API_SECRET', String(c.api_secret));
  if(c.access_token !== undefined) sp.setProperty('X_ACCESS_TOKEN', String(c.access_token));
  if(c.access_secret)              sp.setProperty('X_ACCESS_SECRET', String(c.access_secret));
  if(c.autopost     !== undefined) sp.setProperty('X_AUTOPOST', c.autopost ? 'true' : 'false');
  if(c.template     !== undefined) setConfig_('X_POST_TEMPLATE', String(c.template));
  logEvent_('config', 'X', actor_(), null, { saved:true });
  return true;
}
function admin_getBadgeConfig(){
  return { auto: prop_('BADGE_AUTO') !== 'false', template_id: prop_('BADGE_TEMPLATE_ID') || '' };
}
function admin_saveBadgeConfig(c){
  const sp = PropertiesService.getScriptProperties();
  if(c.auto        !== undefined) sp.setProperty('BADGE_AUTO', c.auto ? 'true' : 'false');
  if(c.template_id !== undefined) sp.setProperty('BADGE_TEMPLATE_ID', String(c.template_id));
  logEvent_('config', 'BADGE', actor_(), null, { saved:true });
  return true;
}
/** バッジ手動発行 */
function admin_issueBadge(contractId){ const r = issueBadge_(contractId); logEvent_('badge', r.badge_id || contractId, actor_(), null, { manual:true }); return r; }

// ============================================================
// 13. 認証（証明書）・検証ポータル・失効制御（案③）
//     締結で「有効」→ 台帳連動で後から失効可能。検証は固定ポータル＋ID照会。
//     配布は当社メールを使わず、利用者は「受付番号」でポータルからバッジ取得。
// ============================================================
const CERT_STATES = ['ACTIVE','SUSPENDED','REVOKED','EXPIRED','TERMINATED','PAYMENT_HOLD'];

/** 締結時に認証を発行（ACTIVE）。照合コード付き。理由=ISSUED。 */
function issueCert_(contractId){
  const existing = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  if(existing) return existing.cert_id;
  const certId = newId_('CERT');
  const now = new Date().toISOString();
  appendRow_(ssOps_(),'Certificates',{ cert_id:certId, contract_id:contractId, status:'ACTIVE',
    reason_code:'ISSUED', reason_text:'締結により発行', requested_by:'system', approved_by:'system',
    legal_case_id:'', effective_at:now, check_code:randCode_(6), issued_at:now.slice(0,10) });
  logEvent_('certificate', certId, 'system', null, { contract_id:contractId, status:'ACTIVE' });
  return certId;
}
function randCode_(n){
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for(var i=0;i<n;i++) s += cs.charAt(Math.floor(Math.random()*cs.length));
  return s;
}
/** 作品提出トークン（Submission_Access）を用意。メール送信はしない。 */
function prepareSubmissionToken_(contractId){
  const token = Utilities.getUuid();
  appendRow_(ssOps_(),'Submission_Access',{ token_id:Utilities.getUuid(), contract_id:contractId,
    token_hash:hash_(token), status:'OPEN', expires_at:addDaysIso_(30), max_uploads:10 });
  return token;
}
/** 契約の対象原作名リスト（Contract_Works→Works_Master） */
function contractWorkNames_(contractId){
  const nameMap = worksNameMap_();
  return readRows_(ssOps_(),'Contract_Works').filter(function(x){ return x.contract_id === contractId; })
    .map(function(x){ return nameMap[x.work_id] || x.work_id; });
}

/**
 * 認証の状態変更（理由・承認記録付き）。status は CERT_STATES のいずれか。
 * 例：SUSPENDED / REVOKED / PAYMENT_HOLD / ACTIVE(再有効) / TERMINATED / EXPIRED
 */
function admin_setCertStatus(contractId, status, reasonCode, reasonText, legalCaseId){
  if(CERT_STATES.indexOf(status) < 0) throw new Error('不正な状態: ' + status);
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  if(!cert) throw new Error('認証が見つかりません: ' + contractId);
  const before = cert.status;
  updateRow_(ssOps_(),'Certificates','cert_id',cert.cert_id,{
    status:status, reason_code:reasonCode||'', reason_text:reasonText||'',
    requested_by:actor_(), approved_by:actor_(), legal_case_id:legalCaseId||'',
    effective_at:new Date().toISOString() });
  logEvent_('certificate', cert.cert_id, actor_(), {status:before}, {status:status, reason_code:reasonCode||''});
  return true;
}
// UI互換の薄いラッパ
function admin_revokeCert(contractId, reasonText){ return admin_setCertStatus(contractId, 'REVOKED', 'MANUAL_REVOKE', reasonText||'', ''); }
function admin_reactivateCert(contractId){ return admin_setCertStatus(contractId, 'ACTIVE', 'REACTIVATE', '', ''); }
function admin_getCertStatus(contractId){
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  return cert ? { cert_id:cert.cert_id, status:cert.status, reason_code:cert.reason_code, issued_at:cert.issued_at } : { status:'NONE' };
}

/** 検証ポータル（?page=verify）。id+照合コードで認証状態を表示（受付番号アクセスは廃止）。 */
function serveVerify_(e){
  const p = e.parameter || {};
  if(!p.id) return verifyInputHtml_();
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.cert_id === p.id; });
  if(!cert || (cert.check_code && String(cert.check_code) !== String(p.c||''))){
    return verifyHtml_('gray', '確認できません', '正規に発行された認証ではないか、照合コードが一致しません。', '');
  }
  const works = contractWorkNames_(cert.contract_id);
  const meta = '対象原作：' + (works.length ? esc_(works.join('、')) : '—') +
    '<br>ライセンスID：' + esc_(cert.contract_id) + '<br>発行日：' + esc_(cert.issued_at) +
    '<br>状態：' + esc_(cert.status);
  return cert.status === 'ACTIVE'
    ? verifyHtml_('ok', '正規ライセンス 確認済み', 'このライセンスは有効です。', meta)
    : verifyHtml_('ng', '無効', 'このライセンスは現在有効ではありません（' + esc_(cert.status) + '）。', meta);
}

function verifyInputHtml_(){
  return htmlPage_('SPLL ライセンス認証', '<h2>SPLL ライセンス認証</h2>' +
    '<p>認証バッジのQRから開くと、正規ライセンスかどうかを確認できます。</p>' +
    '<form method="get"><input type="hidden" name="page" value="verify">' +
    '<p>ライセンスID <input name="id" placeholder="CTR-…"> 照合コード <input name="c" placeholder="XXXXXX"></p>' +
    '<button type="submit">確認する</button></form>');
}
function verifyHtml_(kind, title, msg, meta){
  const color = kind==='ok' ? '#2F7D5B' : (kind==='ng' ? '#A6342F' : '#8A8496');
  const icon  = kind==='ok' ? '✓' : (kind==='ng' ? '!' : '?');
  return htmlPage_('SPLL ライセンス認証',
    '<div style="text-align:center;margin:24px 0">' +
    '<div style="width:64px;height:64px;border-radius:50%;background:' + color + ';color:#fff;font-size:32px;display:inline-flex;align-items:center;justify-content:center">' + icon + '</div>' +
    '<h2 style="color:' + color + '">' + esc_(title) + '</h2><p>' + esc_(msg) + '</p>' +
    (meta ? '<div style="border:1px solid #ddd;border-radius:10px;padding:12px;max-width:360px;margin:0 auto;text-align:left;font-size:13px">' + meta + '</div>' : '') +
    '</div>');
}
function htmlPage_(title, inner){
  return HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#211E2B">' + inner + '</div>'
  ).setTitle(title);
}
function esc_(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

// ---- utils ----
function hash_(s){ return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)); }
function sha256Bytes_(bytes){ return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)); }
function addDaysIso_(d){ const t=new Date(); t.setDate(t.getDate()+d); return t.toISOString(); }
function addMonthsIso_(date, m){ const t=new Date(date.getTime()); t.setMonth(t.getMonth()+m); return t.toISOString(); }
function num_(v){ const n=parseFloat(String(v).replace(/[^0-9.\-]/g,'')); return isNaN(n)?0:n; }
function currentPeriod_(){ const d=new Date(); return d.getFullYear()+(d.getMonth()<6?'H1':'H2'); }
