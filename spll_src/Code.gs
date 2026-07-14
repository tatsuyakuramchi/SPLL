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

// ---- 環境（修正設計書 §22）：development / staging / production ----
// production ではフェイルクローズ（Webhook検証必須・匿名管理操作拒否・サンプル表示なし）。
function env_(){ return prop_('ENVIRONMENT') || 'development'; }
function isProd_(){ return env_() === 'production'; }

/** 障害記録（修正設計書 §21）。失敗を握りつぶさず System_Errors へ記録する。 */
function logError_(code, where, message, detail){
  try{
    appendRow_(ssOps_(),'System_Errors',{ error_id: Utilities.getUuid(), error_code: code||'PROCESSING_ERROR',
      source: where||'', message: String(message||'').slice(0,500), detail: JSON.stringify(detail||'').slice(0,1000),
      occurred_at: new Date().toISOString(), status:'OPEN' });
  }catch(e){ /* エラーログ自体の失敗は無視（無限ループ防止） */ }
}

/** 外部入力のSpreadsheet数式インジェクション対策（修正設計書 §6.2）。先頭が =,+,-,@ なら文字列化。 */
function sanitizeCell_(v){
  if(typeof v !== 'string') return v;
  return /^[=+\-@]/.test(v) ? "'" + v : v;
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

/**
 * 公開：申込導線の設定（クラウドサインフォームURL）。
 * application_ref と 対象原作（work_id_1..N / work_title_1..N）を hidden項目で引き継ぐ。
 * hiddenMap は「正規キー → formrunのhidden項目キー(_field_xxxx)」の対応表（設定で編集）。
 */
function api_getApplyConfig(){
  return {
    formUrl:   prop_('FORMRUN_FORM_URL') || '',
    refParam:  prop_('FORM_REF_PARAM')   || 'application_ref',   // 後方互換（hiddenMap未設定時）
    hiddenMap: parseJson_(prop_('FORM_HIDDEN_MAP'), {}),
    maxWorks:  parseInt(prop_('FORM_MAX_WORKS') || '5', 10) || 5
  };
}
function formMaxWorks_(){ return parseInt(prop_('FORM_MAX_WORKS') || '5', 10) || 5; }

// ============================================================
// 利用料条件（別紙2）：利用目的ごとの一律ルールを事前設定し、申込時に自動計算・反映
// ============================================================
/** 料金表（有効行のみ） */
function feeRows_(){ return readRows_(ssMaster_(),'Fee_Schedule').filter(function(r){ return String(r.active) !== 'false' && r.usage_category; }); }
/** 利用目的に対応する料金ルール（無ければ null） */
function feeRuleFor_(usageCategory){
  return feeRows_().find(function(r){ return String(r.usage_category) === String(usageCategory); }) || null;
}
/** 公開：利用目的の選択肢（申込フォーム用） */
function api_getUsageOptions(){
  return feeRows_().map(function(r){ return { category:r.usage_category, fee_model:r.fee_model, fee_label:r.fee_label || '' }; });
}
/**
 * 利用目的（と原作数）から別紙2の各条件を計算して返す。反映はこの結果を用いる。
 *  RATE=売上連動（率のみ・金額は後日利用報告で確定）／FLAT=定額（契約単位）／PER_WORK=原作数比例。
 */
function computeFeeTerms_(usageCategory, workCount){
  const n = Math.max(1, parseInt(workCount || 1, 10) || 1);
  const r = feeRuleFor_(usageCategory);
  if(!r){
    return { usage_category:usageCategory||'', fee_model:'', rate:null, amount:null,
      fee_amount_or_rate:'（利用目的が未設定です）', licensed_uses:'', payment_due:'', reporting_requirement:'',
      report_due:'', threshold_or_cap:'', reprint_rule:'', special_terms:'', found:false };
  }
  const model = String(r.fee_model || 'RATE').toUpperCase();
  const val = num_(r.fee_value);
  let rate = null, amount = null, feeText = r.fee_label || '';
  if(model === 'RATE'){
    rate = val;
    if(!feeText) feeText = '売上の' + Math.round(val * 1000) / 10 + '％';
  }else if(model === 'PER_WORK'){
    amount = Math.round(val) * n;
    feeText = (r.fee_label || (yen_(val) + '／原作')) + ' × ' + n + '件 ＝ ' + yen_(amount);
  }else{ // FLAT
    amount = Math.round(val);
    if(!feeText) feeText = yen_(amount);
  }
  return {
    usage_category: r.usage_category, fee_model: model, rate: rate, amount: amount,
    fee_amount_or_rate: feeText, licensed_uses: r.licensed_uses || '', payment_due: r.payment_due || '',
    reporting_requirement: r.reporting_requirement || '', report_due: r.report_due || '',
    threshold_or_cap: r.threshold_or_cap || '', reprint_rule: r.reprint_rule || '', special_terms: r.special_terms || '',
    found: true
  };
}
/** 公開：別紙2プレビュー（申込フォームで利用目的選択時に表示） */
function api_previewFeeTerms(usageCategory, workCount){ return computeFeeTerms_(usageCategory, workCount); }
/** 金額を三桁区切り＋「円」で整形（ICO非依存） */
function yen_(v){
  const s = String(Math.round(num_(v)));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円';
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
 * 管理コンソールの配信（修正設計書 SEC-01/§4）。
 * production：ログインユーザーを識別でき、かつ管理者登録済みの場合のみ配信（匿名は拒否）。
 * development：従来どおり（ADMIN_ENFORCE=true なら許可リスト制御）。
 */
function serveAdmin_(e){
  var email = ''; try{ email = Session.getActiveUser().getEmail() || ''; }catch(_){}
  if(isProd_()){
    if(!email) return htmlPage_('SPLL 管理コンソール',
      '<h2>アクセスできません</h2><p>管理コンソールの利用にはGoogleアカウントでのログインが必要です（匿名アクセス不可）。</p>');
    if(!roleOf_(email)) return htmlPage_('SPLL 管理コンソール',
      '<h2>アクセス権限がありません</h2><p>このアカウント（' + esc_(email) + '）は管理者として登録されていません。</p>');
  } else if(prop_('ADMIN_ENFORCE') === 'true' && email && !roleOf_(email) && !isAdminEmail_(email)){
    return htmlPage_('SPLL 管理コンソール',
      '<h2>アクセス権限がありません</h2><p>このアカウント（' + esc_(email) + '）は管理者として登録されていません。</p>' +
      '<p style="font-size:12px;color:#6A6577">管理者アカウントでログインし直すか、事務局にお問い合わせください。</p>');
  }
  return HtmlService.createHtmlOutputFromFile('admin').setTitle('SPLL 管理コンソール');
}

// ============================================================
// RBAC（修正設計書 SEC-02/§4）：全 admin_ 関数の入口で requireRole_() を実行
//   ロール：SYSTEM_ADMIN / LEGAL_ADMIN / OPERATIONS / ACCOUNTING / AUDITOR
//   SYSTEM_ADMIN は全操作可。AUDITOR ほか登録ロールは読取り関数（allowed=[]）のみ。
// ============================================================
const ADMIN_ROLES = ['SYSTEM_ADMIN','LEGAL_ADMIN','OPERATIONS','ACCOUNTING','AUDITOR'];

/** メール→有効ロール（Admin_Users。後方互換で ADMIN_EMAILS 登録者は SYSTEM_ADMIN 扱い） */
function roleOf_(email){
  email = String(email||'').toLowerCase();
  if(!email) return '';
  const u = readRows_(ssOps_(),'Admin_Users').find(function(x){
    return String(x.email||'').toLowerCase() === email && String(x.status) !== 'DISABLED'; });
  if(u && u.role) return String(u.role);
  return isAdminEmail_(email) ? 'SYSTEM_ADMIN' : '';
}

/**
 * 認可（サーバー側強制）。allowed=[] は「登録済みロールなら誰でも（読取り用）」。
 * production：メール未取得（匿名）は常に拒否。
 * development：管理者が一人も未登録なら開発用に SYSTEM_ADMIN として許可（本番では無効）。
 */
function requireRole_(allowed){
  var email = ''; try{ email = Session.getActiveUser().getEmail() || ''; }catch(e){}
  const registered = readRows_(ssOps_(),'Admin_Users').length > 0 || adminEmails_().length > 0;
  if(!email){
    if(!isProd_() && !registered) return { email:'dev-anonymous', role:'SYSTEM_ADMIN' };  // 開発初期のみ
    throw new Error('AUTHENTICATION_ERROR: ログインユーザーを確認できません（匿名では管理操作できません）');
  }
  var role = roleOf_(email);
  if(!role){
    if(!isProd_() && !registered) return { email:email, role:'SYSTEM_ADMIN' };            // 開発初期のみ
    throw new Error('AUTHORIZATION_ERROR: 管理者として登録されていません: ' + email);
  }
  if(role !== 'SYSTEM_ADMIN' && allowed && allowed.length && allowed.indexOf(role) < 0)
    throw new Error('AUTHORIZATION_ERROR: この操作の権限がありません（必要ロール: ' + allowed.join('/') + '）');
  return { email:email, role:role };
}

/** 初期管理者の登録（修正設計書 §4.3：公開URLからのbootstrapは廃止。GASエディタから1回実行） */
function setup_setInitialAdmin(email, role){
  if(!email) throw new Error('メールアドレスを指定してください（例: setup_setInitialAdmin("you@example.com","SYSTEM_ADMIN")）');
  role = role || 'SYSTEM_ADMIN';
  if(ADMIN_ROLES.indexOf(role) < 0) throw new Error('不正なロール: ' + role);
  appendRow_(ssOps_(),'Admin_Users',{ admin_user_id:Utilities.getUuid(), email:String(email).toLowerCase(),
    role:role, status:'ACTIVE', added_by:'setup', added_at:new Date().toISOString() });
  logEvent_('admin_user', email, 'setup', null, { role:role });
  return true;
}
/** 管理者一覧（SYSTEM_ADMIN） */
function admin_listAdminUsers(){
  requireRole_(['SYSTEM_ADMIN']);
  return readRows_(ssOps_(),'Admin_Users').map(function(u){
    return { email:u.email, role:u.role, status:u.status, added_by:u.added_by, added_at:String(u.added_at||'') }; });
}
/** 管理者の追加・更新（SYSTEM_ADMIN）。email一致でupsert。 */
function admin_saveAdminUser(email, role, status){
  const actor = requireRole_(['SYSTEM_ADMIN']);
  email = String(email||'').toLowerCase();
  if(!email) throw new Error('メールアドレスは必須です');
  if(ADMIN_ROLES.indexOf(role) < 0) throw new Error('不正なロール: ' + role);
  const patch = { role:role, status:(status||'ACTIVE'), added_by:actor.email, added_at:new Date().toISOString() };
  if(!updateRow_(ssOps_(),'Admin_Users','email',email,patch)){
    appendRow_(ssOps_(),'Admin_Users', Object.assign({ admin_user_id:Utilities.getUuid(), email:email }, patch));
  }
  logEvent_('admin_user', email, actor.email, null, { role:role, status:status||'ACTIVE' });
  return true;
}

/** 管理者アクセス設定の取得（許可リスト・強制ON/OFF・現在の閲覧者） */
function admin_getAdminAccess(){ requireRole_(['SYSTEM_ADMIN']);
  var viewer = ''; try{ viewer = Session.getActiveUser().getEmail() || ''; }catch(e){}
  return { emails: prop_('ADMIN_EMAILS') || '', enforce: prop_('ADMIN_ENFORCE') === 'true', viewer: viewer };
}
/** 管理者アクセス設定の保存（emails：カンマ/改行区切り、enforce：真偽） */
function admin_saveAdminAccess(c){ requireRole_(['SYSTEM_ADMIN']);
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
function admin_cloudSignTest(){ requireRole_(['SYSTEM_ADMIN']);
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
  return receiveWebhook_(hook === 'formrun' ? 'FORMRUN' : 'CLOUDSIGN', e);
}

// ============================================================
// Webhook受信（修正設計書 §5）：検証→受信記録（Webhook_Receipts）→業務処理→PROCESSED/ERROR
//   GASのdoPostはHTTPヘッダを受け取れないため、署名はURL共有秘密（?key=）方式＋
//   CloudSignはAPI照会（受信payloadだけで契約を作成しない）で真正性を担保する。
//   production：共有秘密未設定・不一致は受信拒否（フェイルクローズ）。
// ============================================================
function receiveWebhook_(provider, e){
  const raw = (e && e.postData && e.postData.contents) || '';
  const key = (e && e.parameter && (e.parameter.key || e.parameter.sig || e.parameter.signature)) || '';
  const sigValid = verifyWebhookKey_(provider, key);
  const phash = hash_(raw || 'empty');
  if(!sigValid && isProd_()){
    appendRow_(ssOps_(),'Webhook_Receipts',{ receipt_id:Utilities.getUuid(), provider:provider,
      external_event_id:'', payload_hash:phash, payload_json:'', signature_valid:'false',
      received_at:new Date().toISOString(), status:'REJECTED', retry_count:0, last_error:'共有秘密の不一致または未設定', processed_at:'' });
    logError_('AUTHENTICATION_ERROR','webhook:'+provider,'署名検証に失敗（production・受信拒否）');
    return ContentService.createTextOutput('rejected');
  }
  const body = parseWebhookBody_(raw, e);
  const extId = provider === 'CLOUDSIGN'
    ? String(body.documentID || body.document_id || body.id || '')
    : String(body.sequence_number || body.id || '');
  // 冪等：同一payloadの再送は処理しない（同一docの別イベントは通す→業務処理側で冪等化）
  const dup = readRows_(ssOps_(),'Webhook_Receipts').find(function(r){ return r.payload_hash === phash && r.status === 'PROCESSED'; });
  if(dup) return ContentService.createTextOutput('dup');
  const receiptId = Utilities.getUuid();
  appendRow_(ssOps_(),'Webhook_Receipts',{ receipt_id:receiptId, provider:provider,
    external_event_id:extId, payload_hash:phash, payload_json:sanitizeCell_(String(raw).slice(0,45000)),
    signature_valid:String(sigValid), received_at:new Date().toISOString(), status:'RECEIVED', retry_count:0, last_error:'', processed_at:'' });
  // 同期で業務処理を試行。失敗しても受信は記録済み → batch_processWebhookReceipts が再試行。
  try{
    const ack = processWebhookEvent_(provider, body, e);
    updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',receiptId,{ status:'PROCESSED', processed_at:new Date().toISOString() });
    return ContentService.createTextOutput(ack || 'ok');
  }catch(err){
    updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',receiptId,{ status:'ERROR', last_error:String(err && err.message || err).slice(0,300) });
    logError_('PROCESSING_ERROR','webhook:'+provider, err, { external_event_id:extId });
    return ContentService.createTextOutput('accepted');   // 受信自体は成功（再試行で回復）
  }
}
/** 共有秘密の検証。未設定時：development=通す／production=拒否（呼び出し側で判断） */
function verifyWebhookKey_(provider, key){
  const secret = prop_(provider === 'FORMRUN' ? 'FORMRUN_WEBHOOK_SECRET' : 'CLOUDSIGN_WEBHOOK_KEY');
  if(!secret) return !isProd_();
  return String(key) === String(secret);
}
function parseWebhookBody_(raw, e){
  try{ return JSON.parse(raw); }catch(_){}
  // application/x-www-form-urlencoded で JSON が payload 値に入るケース
  try{
    const params = {}; String(raw).split('&').forEach(function(kv){ const i=kv.indexOf('='); if(i>=0) params[decodeURIComponent(kv.slice(0,i))]=decodeURIComponent(kv.slice(i+1).replace(/\+/g,' ')); });
    const cand = params.payload || params.body || params.data || (Object.keys(params)[0] && params[Object.keys(params)[0]]);
    return JSON.parse(cand);
  }catch(_){ return (e && e.parameter) || {}; }
}
function processWebhookEvent_(provider, body, e){
  return provider === 'FORMRUN' ? processFormrunEvent_(body) : processCloudSignEvent_(body, e);
}
/** 未処理・エラーのWebhookを再処理（時間主導トリガー） */
function batch_processWebhookReceipts(){
  const rows = readRows_(ssOps_(),'Webhook_Receipts')
    .filter(function(r){ return (r.status==='RECEIVED' || r.status==='ERROR') && num_(r.retry_count) < 5; });
  let done = 0;
  rows.forEach(function(r){
    try{
      const body = parseWebhookBody_(String(r.payload_json||'').replace(/^'/,''), null);
      processWebhookEvent_(r.provider, body, null);
      updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',r.receipt_id,{ status:'PROCESSED', processed_at:new Date().toISOString() });
      done++;
    }catch(err){
      updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',r.receipt_id,
        { status:'ERROR', retry_count:num_(r.retry_count)+1, last_error:String(err && err.message || err).slice(0,300) });
    }
  });
  return { processed: rows.length, completed: done };
}

/**
 * 公開ポータルからの申込作成（複数原作）。application_ref を発行し、
 * Applications ＋ Application_Works を登録して application_ref を返す。
 * 突合キーは application_ref（メールハッシュ突合は廃止）。
 */
function web_createApplication(workIds, usageCategory){
  const ids = (workIds || []).filter(Boolean).map(String).filter(function(v,i,a){ return a.indexOf(v)===i; });   // 重複除去
  if(!ids.length) throw new Error('原作が選択されていません');
  const maxW = formMaxWorks_();
  if(ids.length > maxW) throw new Error('対象原作は最大' + maxW + '件までです（契約書テンプレートの制約）');
  // サーバー側検証（修正設計書 §7.1）：実在・公開中の原作のみ／利用目的は有効な料金表に存在
  const master = readRows_(ssMaster_(),'Works_Master');
  ids.forEach(function(wid){
    const w = master.find(function(x){ return x.work_id === wid; });
    if(!w) throw new Error('VALIDATION_ERROR: 存在しない原作です: ' + wid);
    if(w.publish_status !== 'PUBLISHED') throw new Error('VALIDATION_ERROR: 公開されていない原作です: ' + wid);
  });
  usageCategory = String(usageCategory || '');
  if(!usageCategory || !feeRuleFor_(usageCategory))
    throw new Error('VALIDATION_ERROR: 利用目的が未選択か、料金表に存在しません: ' + usageCategory);
  // 同意証跡：申込時点の同意文・規約のハッシュを保存（§7.2 の最小実装）
  const legal = api_getLegalTexts();
  const appId = newId_('APP');
  const ref   = newRef_();
  appendRow_(ssOps_(),'Applications',{ application_id:appId, application_ref:ref, usage_category:sanitizeCell_(usageCategory),
    privacy_hash: hash_(String(legal.privacy||'')), terms_hash: hash_(String(legal.termsTemplate||'')),
    status:'APPLICATION_CREATED', created_at:new Date().toISOString() });
  ids.forEach(function(wid){ appendRow_(ssOps_(),'Application_Works',{
    application_work_id:newId_('AW'), application_id:appId, work_id:wid }); });
  updateRow_(ssOps_(),'Applications','application_id',appId,{ status:'FORM_PENDING' });
  logEvent_('application', appId, 'portal', null, { application_ref:ref, works:ids.length, usage_category:usageCategory });
  return { application_id:appId, application_ref:ref };
}

/**
 * CloudSign 締結完了イベントの業務処理（修正設計書 §5.3/§8.1）。
 * production では必ず CloudSign API 照会で締結完了を確認する（受信payloadだけで契約を作成しない）。
 * application_ref で申込に突合 → 契約＋対象原作/条件スナップショット＋締結PDF＋認証＋提出トークン。
 */
function processCloudSignEvent_(body, e){
  body = body || {};
  const docId = body.document_id || body.documentID || body.id || (e && e.parameter && e.parameter.documentID);
  const event = body.event_type || body.status || body.event;
  if(!docId) return 'no-docid';
  if(!cs_isCompletedEvent_(event)) return 'ignored';
  // 冪等：同一書類の契約が既にあれば処理しない
  if(readRows_(ssOps_(),'Contracts').some(function(c){ return String(c.cloudsign_document_id) === String(docId); })) return 'dup';

  // 真正性：API照会で締結完了を確認（SEC-03）。productionでは必須（照会不能なら例外→受信キューで再試行）。
  let verifiedDoc = null;
  if(prop_('CLOUDSIGN_CLIENT_ID')){
    verifiedDoc = cs_fetch_('GET', '/documents/' + encodeURIComponent(docId), null, {});
    if(!cs_isCompletedEvent_(verifiedDoc && verifiedDoc.status))
      throw new Error('CloudSign照会結果が締結完了ではありません（document=' + docId + ', status=' + (verifiedDoc && verifiedDoc.status) + '）');
  } else if(isProd_()){
    throw new Error('CloudSign資格情報が未設定のため締結を検証できません（production では payload のみでの契約作成を禁止）');
  }

  const ref = extractApplicationRef_(body, e) || refFromText_(JSON.stringify(verifiedDoc || {}));
  const app = ref ? readRows_(ssOps_(),'Applications').find(function(a){ return a.application_ref === ref; }) : null;
  const linked = !!app;
  const contractId = newId_('CTR');
  appendRow_(ssOps_(),'Contracts',{ contract_id:contractId, cloudsign_document_id:docId,
    cloudsign_title: sanitizeCell_((verifiedDoc && (verifiedDoc.title || verifiedDoc.name)) || extractDocTitle_(body)),
    application_id: app ? app.application_id : '', application_ref: ref || '',
    status:'SIGNED', link_status: linked ? 'LINKED' : 'UNLINKED',
    signed_at:new Date().toISOString(), folder_id:createContractFolder_(contractId) });

  // 締結済原本PDFの保存（FUN-04）。失敗しても契約処理は継続（後で再取得可能）。
  try{ saveSignedPdf_(contractId, docId, verifiedDoc); }
  catch(err){ logError_('EXTERNAL_API_ERROR','saveSignedPdf', err, { contract_id:contractId, document_id:docId }); }

  if(linked){
    snapshotContractWorks_(contractId, app.application_id);
    snapshotContractTerms_(contractId, app);
    updateRow_(ssOps_(),'Applications','application_id',app.application_id,{ status:'SIGNED' });
    logEvent_('contract', contractId, 'cloudsign', null, { status:'SIGNED', link_status:'LINKED', application_ref:ref });
    finishContractLinkage_(contractId);
    return 'ok';
  }
  // 突合不能：締結は記録するが、認証・バッジ・提出トークンは手動紐付けまで保留（§5.3-7）
  logEvent_('contract', contractId, 'cloudsign', null,
    { status:'SIGNED', link_status:'UNLINKED', reason:(ref ? 'app-not-found' : 'no-ref'), application_ref:ref||'' });
  return 'ok-unlinked';
}

/** 締結済PDFをCloudSign APIから取得し、契約フォルダへハッシュ付きで保存（FUN-04/§8.2） */
function saveSignedPdf_(contractId, docId, doc){
  if(!prop_('CLOUDSIGN_CLIENT_ID')) return null;
  doc = doc || cs_fetch_('GET', '/documents/' + encodeURIComponent(docId), null, {});
  const files = (doc && doc.files) || [];
  if(!files.length) return null;
  const fileId = files[0].id || files[0].file_id;
  const res = UrlFetchApp.fetch(cs_baseUrl_() + '/documents/' + encodeURIComponent(docId) + '/files/' + encodeURIComponent(fileId),
    { method:'get', muteHttpExceptions:true, headers:{ Authorization:'Bearer ' + cloudSignAccessToken_() } });
  if(res.getResponseCode() >= 300) throw new Error('締結PDF取得 HTTP ' + res.getResponseCode());
  const blob = res.getBlob().setName('signed_' + contractId + '.pdf');
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; }) || {};
  const folder = contractSubFolder_(c, '01_Contract');
  const f = folder.createFile(blob);
  const fhash = sha256Bytes_(blob.getBytes());
  updateRow_(ssOps_(),'Contracts','contract_id',contractId,{ contract_file_id:f.getId(), contract_file_hash:fhash });
  logEvent_('contract', contractId, 'system', null, { contract_file_id:f.getId(), contract_file_hash:fhash });
  return f.getId();
}

/** 締結Webフックの text（"COMPLETED : <契約書タイトル> sent by …"）等から書類タイトルを取り出す */
function extractDocTitle_(body){
  if(body && body.title) return String(body.title);
  const m = String((body && body.text) || '').match(/:\s*(.+?)\s+sent by/i);
  return m ? m[1].trim() : String((body && body.text) || '');
}

/**
 * Application_Works → Contract_Works へスナップショット（既にあれば追加しない）。
 * 締結時点の作品名・権利者・クレジット等も固定保存（修正設計書 FLOW-02/§8.3）：
 * 契約後に原作マスタが変更されても、契約時点の条件を復元できる。
 */
function snapshotContractWorks_(contractId, applicationId){
  const already = readRows_(ssOps_(),'Contract_Works').some(function(x){ return x.contract_id === contractId; });
  if(already) return;
  const master = {}; readRows_(ssMaster_(),'Works_Master').forEach(function(w){ master[w.work_id] = w; });
  readRows_(ssOps_(),'Application_Works').filter(function(x){ return x.application_id === applicationId; })
    .forEach(function(x){
      const w = master[x.work_id] || {};
      appendRow_(ssOps_(),'Contract_Works',{ contract_work_id:newId_('CW'), contract_id:contractId, work_id:x.work_id,
        work_name_snapshot:sanitizeCell_(w.work_name||''), publisher_snapshot:sanitizeCell_(w.publisher||''),
        credit_snapshot:sanitizeCell_(w.credit_text||''), partner_id_snapshot:w.partner_id||'' });
    });
}

/** 締結時点の利用目的と別紙2条件を契約へスナップショット（法務証跡）。料金表の後日変更に影響されない。 */
function snapshotContractTerms_(contractId, app){
  const usage = (app && app.usage_category) || '';
  const workCount = readRows_(ssOps_(),'Contract_Works').filter(function(x){ return x.contract_id === contractId; }).length || 1;
  const terms = computeFeeTerms_(usage, workCount);
  updateRow_(ssOps_(),'Contracts','contract_id',contractId,
    { usage_category: usage, terms_snapshot: JSON.stringify(terms) });
  return terms;
}

/** 締結後の発行処理（認証ACTIVE＋バッジ＋提出/報告トークン＋定額系の請求起票）。冪等。紐付け完了時に呼ぶ。 */
function finishContractLinkage_(contractId){
  const cert = issueCert_(contractId);   // 平文コードはここでのみ取得可能（バッジQRへ焼き込む）
  if(prop_('BADGE_AUTO') !== 'false'){ try{ issueBadge_(contractId, cert && cert.verify_url); }catch(e){ logEvent_('badge', contractId, 'system', null, { issue_error:String(e) }); } }
  prepareSubmissionToken_(contractId);
  issueToken_(contractId, 'REPORT', 400, 24);              // 利用報告トークン（約13ヶ月・最大24回）
  try{ createInvoiceOnSigning_(contractId); }              // FLAT / PER_WORK は締結時に請求起票（FUN-02）
  catch(e){ logError_('PROCESSING_ERROR','createInvoiceOnSigning', e, { contract_id:contractId }); }
}

/** FLAT/PER_WORK 契約の請求を締結時に起票（無償・RATEは起票しない）。冪等。 */
function createInvoiceOnSigning_(contractId){
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; });
  if(!c || !c.terms_snapshot) return null;
  if(readRows_(ssOps_(),'Invoices').some(function(v){ return v.contract_id === contractId && v.source_type === 'CONTRACT'; })) return null;
  let t = {}; try{ t = JSON.parse(c.terms_snapshot); }catch(e){ return null; }
  const model = String(t.fee_model||'').toUpperCase();
  if(model !== 'FLAT' && model !== 'PER_WORK') return null;    // RATE は利用報告承認後に起票
  const amount = num_(t.amount);
  if(amount <= 0){ logEvent_('invoice', contractId, 'system', null, { skipped:'NOT_REQUIRED（無償）' }); return null; }
  const invId = newId_('INV');
  appendRow_(ssOps_(),'Invoices',{ invoice_id:invId, contract_id:contractId, period:currentPeriod_(),
    source_type:'CONTRACT', source_id:contractId, amount_rule:t.fee_amount_or_rate||'', amount:amount,
    status:'入金待ち', issued_at:new Date().toISOString().slice(0,10) });
  logEvent_('invoice', invId, 'system', null, { contract_id:contractId, amount:amount, model:model });
  return invId;
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
  // フォールバック：CloudSign API で書類を取得し、タイトル・入力フィールド・参加者名まで走査して抽出
  var docId = body.documentID || body.document_id || body.id || (e && e.parameter && e.parameter.documentID);
  if(docId && prop_('CLOUDSIGN_CLIENT_ID')){
    try{ var doc = cs_fetch_('GET', '/documents/' + docId, null, {}); ref = refFromText_(JSON.stringify(doc)) || ''; }
    catch(_){ /* 取得不能時は空 → 未紐付けとして記録し手動紐付けに委ねる */ }
  }
  return ref || '';
}
// 申込参照番号：推測耐性のため乱数要素を含む（修正設計書 §7.3）。旧形式（連番4桁）も突合可能。
function refFromText_(s){ const m = String(s||'').match(/REF-\d{6}-[A-Z0-9]{4,12}/); return m ? m[0] : ''; }
function newRef_(){
  const ym = Utilities.formatDate(new Date(), 'JST', 'yyyyMM');
  return 'REF-' + ym + '-' + randCode_(6);
}

/**
 * FormRun申込イベントの業務処理（修正設計書 §5.4）。
 * application_ref を受け、申込を CONTRACT_PENDING へ前進（申込作成はポータル側）。
 * ステータスの逆行は禁止。ref無し・申込不明はエラー記録（受信キューで追跡可能）。
 */
function processFormrunEvent_(body){
  body = body || {};
  const map  = parseJson_(prop_('FORMRUN_FIELD_MAP'), {});
  const canon = {};
  (body.columns || []).forEach(function(c){ const k = map[c.name || c.label]; if(k) canon[k] = c.value; });
  const ref = canon.application_ref || refFromText_(JSON.stringify(body));
  if(!ref){
    logError_('VALIDATION_ERROR','formrun','application_ref がWebhookに含まれていません', { keys:Object.keys(body) });
    return 'no-ref';
  }
  const app = readRows_(ssOps_(),'Applications').find(function(a){ return a.application_ref === ref; });
  if(!app){
    logError_('DATA_NOT_FOUND','formrun','application_ref に対応する申込がありません: ' + ref);
    return 'app-not-found';
  }
  // 逆行禁止：FORM_PENDING/APPLICATION_CREATED からのみ前進
  if(app.status === 'APPLICATION_CREATED' || app.status === 'FORM_PENDING'){
    updateRow_(ssOps_(),'Applications','application_id',app.application_id,{ status:'CONTRACT_PENDING' });
    logEvent_('application', app.application_id, 'formrun', {status:app.status}, { status:'CONTRACT_PENDING', application_ref:ref });
  }
  return 'ok';
}
function parseJson_(s, def){ try{ const v = JSON.parse(s); return (v==null ? def : v); }catch(e){ return def; } }
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
/** クライアントから google.script.run で呼ぶ：契約情報の取得（REPORT用途トークン） */
function report_getContext(token){
  const tok = resolveToken_(token, 'REPORT');
  if(!tok) throw new Error('報告用リンクが無効か、有効期限が切れています。');
  const c = readRows_(ssOps_(),'Contracts').find(x=>x.contract_id===tok.contract_id) || {};
  let fee = ''; try{ fee = JSON.parse(c.terms_snapshot||'{}').fee_amount_or_rate || ''; }catch(e){}
  return { contract_id:c.contract_id||'', work:contractWorkNames_(c.contract_id).join('、'), fee:fee, period:currentPeriod_() };
}
/**
 * 利用報告の登録 → Usage_Reports（修正設計書 §11.1）。
 * サーバー側検証：数値が0以上／控除+返品が総売上以下／URLはhttp(s)／同一契約・期間・チャネルの重複拒否。
 */
function report_submit(token, data){
  const tok = resolveToken_(token, 'REPORT');
  if(!tok) throw new Error('報告用リンクが無効か、有効期限が切れています。');
  data = data || {};
  const gross = num_(data.gross), returns = num_(data.returns), deductions = num_(data.deductions), qty = num_(data.qty);
  if(gross < 0 || returns < 0 || deductions < 0 || qty < 0) throw new Error('VALIDATION_ERROR: 数量・金額は0以上で入力してください。');
  if(returns + deductions > gross) throw new Error('VALIDATION_ERROR: 返品と控除の合計が総売上を超えています。');
  const url = String(data.url||'');
  if(url && !/^https?:\/\//i.test(url)) throw new Error('VALIDATION_ERROR: 証憑URLは http(s):// で始まる必要があります。');
  const period = String(data.period||''), channel = String(data.channel||'');
  const dup = readRows_(ssOps_(),'Usage_Reports').find(function(r){
    return r.contract_id === tok.contract_id && String(r.period) === period && String(r.channel) === channel &&
      r.status !== 'RETURNED' && r.status !== 'SUPERSEDED'; });
  if(dup) throw new Error('VALIDATION_ERROR: 同じ期間・チャネルの報告が既に提出されています（訂正は事務局へ）。');
  const reportId = newId_('RPT');
  const net = Math.max(0, gross - returns - deductions);
  appendRow_(ssOps_(),'Usage_Reports',{ report_id:reportId, contract_id:tok.contract_id,
    period:sanitizeCell_(period), channel:sanitizeCell_(channel), qty:qty, gross_sales:gross,
    returns:returns, deductions:deductions, net_sales:net, sales_url:sanitizeCell_(url),
    status:'SUBMITTED', submitted_at:new Date().toISOString() });
  consumeToken_(tok);
  logEvent_('usage_report', reportId, 'licensee', null, {status:'SUBMITTED'});
  return reportId;
}

// ---- 利用報告の管理（FUN-01/§11.1：SUBMITTED→RETURNED/APPROVED→LOCKED）----
function admin_listReports(){
  requireRole_([]);
  const ctrWorks = contractWorksMap_();
  return readRows_(ssOps_(),'Usage_Reports').map(function(r){ return {
    report_id:r.report_id, contract_id:r.contract_id, work:contractWorkLabel_(ctrWorks, r.contract_id),
    period:String(r.period||''), channel:String(r.channel||''), qty:String(r.qty||''),
    gross:String(r.gross_sales||''), net:String(r.net_sales||''), url:String(r.sales_url||''),
    status:r.status||'', submitted_at:String(r.submitted_at||'') }; });
}
function reportTransition_(reportId, from, patch, actorEmail){
  const r = readRows_(ssOps_(),'Usage_Reports').find(function(x){ return x.report_id === reportId; });
  if(!r) throw new Error('DATA_NOT_FOUND: 報告が見つかりません: ' + reportId);
  if(from.indexOf(r.status) < 0) throw new Error('DATA_CONFLICT: 現在の状態（' + r.status + '）からは実行できません');
  updateRow_(ssOps_(),'Usage_Reports','report_id',reportId,patch);
  logEvent_('usage_report', reportId, actorEmail, {status:r.status}, patch);
  return true;
}
/** 承認（SUBMITTED→APPROVED）。RATE契約はここから請求起票が可能になる。 */
function admin_approveReport(reportId){
  const actor = requireRole_(['ACCOUNTING']);
  return reportTransition_(reportId, ['SUBMITTED'], { status:'APPROVED', approved_by:actor.email, approved_at:new Date().toISOString() }, actor.email);
}
/** 差戻し（SUBMITTED→RETURNED）。理由必須。利用者は同期間を再提出できる。 */
function admin_returnReport(reportId, reason){
  const actor = requireRole_(['ACCOUNTING']);
  if(!reason) throw new Error('VALIDATION_ERROR: 差戻し理由は必須です');
  return reportTransition_(reportId, ['SUBMITTED'], { status:'RETURNED', returned_reason:sanitizeCell_(String(reason)) }, actor.email);
}
/** ロック（APPROVED→LOCKED）。清算・請求の対象として確定。 */
function admin_lockReport(reportId){
  const actor = requireRole_(['ACCOUNTING']);
  return reportTransition_(reportId, ['APPROVED'], { status:'LOCKED', locked_at:new Date().toISOString() }, actor.email);
}
/** RATE契約：承認済み報告から請求を起票（net×契約スナップショット率）。冪等（報告単位）。 */
function admin_generateInvoicesFromReports(period){
  const actor = requireRole_(['ACCOUNTING']);
  period = period || currentPeriod_();
  const contracts = {}; readRows_(ssOps_(),'Contracts').forEach(function(c){ contracts[c.contract_id] = c; });
  const invoiced = {}; readRows_(ssOps_(),'Invoices').forEach(function(v){ if(v.source_type==='REPORT') invoiced[v.source_id] = true; });
  const targets = readRows_(ssOps_(),'Usage_Reports').filter(function(r){
    return String(r.period) === String(period) && (r.status === 'APPROVED' || r.status === 'LOCKED') && !invoiced[r.report_id]; });
  const out = [];
  targets.forEach(function(r){
    const c = contracts[r.contract_id]; if(!c) return;
    let t = {}; try{ t = JSON.parse(c.terms_snapshot||'{}'); }catch(e){}
    if(String(t.fee_model).toUpperCase() !== 'RATE' || t.rate == null) return;
    const amount = Math.round(num_(r.net_sales) * num_(t.rate));
    if(amount <= 0) return;
    const invId = newId_('INV');
    appendRow_(ssOps_(),'Invoices',{ invoice_id:invId, contract_id:r.contract_id, period:period,
      source_type:'REPORT', source_id:r.report_id, amount_rule:t.fee_amount_or_rate||'', amount:amount,
      status:'入金待ち', issued_at:new Date().toISOString().slice(0,10) });
    logEvent_('invoice', invId, actor.email, null, { contract_id:r.contract_id, report_id:r.report_id, amount:amount });
    out.push({ invoice_id:invId, contract_id:r.contract_id, amount:amount });
  });
  return { period:period, generated:out.length, invoices:out };
}
/** 報告リンクの発行（当社からメール送信はしない） */
function admin_sendReportLink(contractId){
  requireRole_(['OPERATIONS','ACCOUNTING']);
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; });
  if(!c) throw new Error('契約が見つかりません: ' + contractId);
  const token = issueToken_(contractId, 'REPORT', 400, 24);
  let base = ''; try{ base = ScriptApp.getService().getUrl() || ''; }catch(e){}
  return { url:(base||'') + '?page=report&token=' + token, token:token };
}

// ============================================================
// 5.1 作品提出ページ（?page=upload&t=トークン）
//     受付番号のみのアクセスは不可。Access_Tokens（SUBMISSION用途）のトークンで認証。
//     再提出は新Submissionではなく同一Submission配下の版(Version)として管理。
// ============================================================
function serveUpload_(e){
  const t = HtmlService.createTemplateFromFile('upload');
  t.token = (e.parameter && (e.parameter.t || e.parameter.token)) || '';
  return t.evaluate().setTitle('SPLL 作品提出');
}

/** 提出ページのコンテキスト：契約番号・対象原作・既存提出（版履歴）・認証状態・バッジ取得URL */
function web_getSubmitContext(token){
  const tok = resolveToken_(token, 'SUBMISSION');
  if(!tok) throw new Error('提出用リンクが無効か、有効期限が切れています。');
  const contractId = tok.contract_id;
  const versions = readRows_(ssOps_(),'Submission_Versions');
  const subs = readRows_(ssOps_(),'Submissions').filter(s => s.contract_id===contractId).map(function(s){
    const vs = versions.filter(v => v.submission_id===s.submission_id)
      .sort(function(a,b){ return num_(a.version_no)-num_(b.version_no); })
      .map(function(v){ return { version_no:v.version_no, status:v.status, submitted_at:String(v.submitted_at||'') }; });
    return { submission_id:s.submission_id, title:s.title, status:s.status, versions:vs };
  });
  // バッジ取得導線（FUN-03）：発行済みならBADGE_DOWNLOADトークンを払い出してURLを返す
  let badgeUrl = '';
  const badge = readRows_(ssOps_(),'Badges').find(function(b){ return b.contract_id === contractId && String(b.status) === 'ISSUED'; });
  if(badge){
    revokeTokens_(contractId, 'BADGE_DOWNLOAD');
    const bt = issueToken_(contractId, 'BADGE_DOWNLOAD', 90, 20);
    let base = ''; try{ base = ScriptApp.getService().getUrl() || ''; }catch(e){}
    badgeUrl = (base||'') + '?page=badge&token=' + bt;
  }
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  const remaining = Math.max(0, num_(tok.max_uses) - num_(tok.used_count));
  return { contract_id:contractId, works:contractWorkNames_(contractId), submissions:subs,
    badge_url:badgeUrl, cert_status:(cert ? cert.status : 'NONE'),
    expires_at:String(tok.expires_at||'').slice(0,10), remaining_uploads:remaining };
}

/** アップロードのサーバー側検証（修正設計書 SEC-05/§6.3）：サイズ・拡張子・MIME・マジックバイト */
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const UPLOAD_TYPES = {
  pdf:  { mimes:['application/pdf'], magic:function(b){ return b.length>4 && b[0]===0x25 && b[1]===0x50 && b[2]===0x44 && b[3]===0x46; } },   // %PDF
  png:  { mimes:['image/png'],       magic:function(b){ return b.length>8 && (b[0]&255)===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47; } },
  jpg:  { mimes:['image/jpeg'],      magic:function(b){ return b.length>3 && (b[0]&255)===0xFF && (b[1]&255)===0xD8 && (b[2]&255)===0xFF; } },
  jpeg: { mimes:['image/jpeg'],      magic:function(b){ return b.length>3 && (b[0]&255)===0xFF && (b[1]&255)===0xD8 && (b[2]&255)===0xFF; } }
};
function validateUpload_(data){
  const name = String(data.filename||'file').split(/[\/\\]/).pop().replace(/[\x00-\x1f<>:"|?*]/g,'_').slice(0,120);
  const ext = (name.lastIndexOf('.')>=0 ? name.slice(name.lastIndexOf('.')+1) : '').toLowerCase();
  const rule = UPLOAD_TYPES[ext];
  if(!rule) throw new Error('VALIDATION_ERROR: 許可されていないファイル形式です（PDF・PNG・JPEGのみ）: ' + ext);
  let bytes;
  try{ bytes = Utilities.base64Decode(data.dataBase64); }catch(e){ throw new Error('VALIDATION_ERROR: ファイルデータを読み取れません。'); }
  if(!bytes || !bytes.length) throw new Error('VALIDATION_ERROR: 空のファイルは提出できません。');
  if(bytes.length > UPLOAD_MAX_BYTES) throw new Error('VALIDATION_ERROR: ファイルが20MBを超えています（' + Math.round(bytes.length/1024/1024) + 'MB）。');
  const mime = String(data.mimeType||'').toLowerCase();
  if(mime && rule.mimes.indexOf(mime) < 0) throw new Error('VALIDATION_ERROR: MIMEタイプが拡張子と一致しません: ' + mime);
  const head = []; for(var i=0;i<Math.min(16,bytes.length);i++){ var v=bytes[i]; head.push(v<0 ? v+256 : v); }
  if(!rule.magic(head)) throw new Error('VALIDATION_ERROR: ファイル内容が形式と一致しません（先頭シグネチャ不一致）。');
  return { bytes:bytes, name:name, mime:rule.mimes[0] };
}

/**
 * 作品提出（新規 or 再提出）。data:
 *   { submission_id?（再提出時）, title, filename, mimeType, dataBase64, note }
 * 新規は Submission＋v1、再提出は既存Submission配下に新しい版を追加。
 * 保存先: 契約フォルダ/02_Submissions/SUB-xxx/vN/。AI審査を起票して返す。
 */
function web_submitWork(token, data){
  const tok = resolveToken_(token, 'SUBMISSION');
  if(!tok) throw new Error('提出用リンクが無効か、有効期限が切れているか、提出回数の上限に達しています。');
  data = data || {};
  if(!data.dataBase64) throw new Error('作品ファイルが添付されていません。');
  const checked = validateUpload_(data);                       // サーバー側検証（SEC-05）
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

  // Driveへ保存（契約フォルダ/02_Submissions/SUB/vN）。検証済みの実体・正規化名・MIMEを使用。
  const blob = Utilities.newBlob(checked.bytes, checked.mime, checked.name);
  const subRoot = getOrCreateChildFolder_(contractSubFolder_(contract,'02_Submissions'), submissionId);
  const verFolder = subRoot.createFolder('v'+versionNo);
  const file = verFolder.createFile(blob);
  appendRow_(ssOps_(),'Submission_Files',{ submission_file_id:newId_('SBF'), version_id:versionId,
    drive_file_id:file.getId(), mime_type:checked.mime, size:checked.bytes.length, sha256:sha256Bytes_(checked.bytes),
    original_filename:sanitizeCell_(String(data.filename||'').slice(0,200)), magic_valid:'true' });
  consumeToken_(tok);                                          // 提出回数を消費（SEC-06）

  // AI一次審査を起票（→人手審査必須）
  const aiId = enqueueAiReview_(submissionId, versionId);
  logEvent_('submission', submissionId, 'licensee', null, {version_no:versionNo, ai_review_id:aiId});
  return { submission_id:submissionId, version_no:versionNo, ai_review_id:aiId };
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
function admin_dashboard(){ requireRole_([]);
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
function admin_reviewQueue(){ requireRole_([]);
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
function admin_setHumanReview(submissionId, result, comment, reviewer, versionId){ requireRole_(['OPERATIONS','LEGAL_ADMIN']);
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
function admin_listContracts(){ requireRole_([]);
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
 * 旧トークンを失効し、Access_Tokens（SUBMISSION用途）を新規発行して返す。
 */
function admin_sendUploadLink(contractId){ requireRole_(['OPERATIONS']);
  const c = readRows_(ssOps_(),'Contracts').find(x => x.contract_id===contractId);
  if(!c) throw new Error('契約が見つかりません: '+contractId);
  revokeTokens_(contractId, 'SUBMISSION');            // 再発行時は旧トークンを失効（§9.1）
  const token = prepareSubmissionToken_(contractId);
  let base = ''; try{ base = ScriptApp.getService().getUrl() || ''; }catch(e){}
  const url = base ? (base + '?page=upload&t=' + token) : ('?page=upload&t=' + token);
  logEvent_('contract', contractId, actor_(), null, {upload_link_issued:true});
  return { url:url, token:token };
}

// ---- 未紐付け締結の手動紐付け（ref突合できない場合のフォールバック） ----
/** 申込に突合できなかった締結（UNLINKED）の一覧。書類タイトルで判別できるようにする。 */
function admin_listUnlinkedContracts(){ requireRole_([]);
  return readRows_(ssOps_(),'Contracts')
    .filter(function(c){ return c.status==='SIGNED' && !c.application_id; })
    .map(function(c){ return {
      contract_id: c.contract_id, cloudsign_document_id: c.cloudsign_document_id||'',
      title: c.cloudsign_title||'', application_ref: c.application_ref||'', signed_at: String(c.signed_at||'')
    }; });
}
/** 手動紐付けの候補となる申込（未締結・未紐付け）。対象原作名つき。 */
function admin_listLinkableApplications(){ requireRole_([]);
  const linked = {}; readRows_(ssOps_(),'Contracts').forEach(function(c){ if(c.application_id) linked[c.application_id] = true; });
  const nameMap = worksNameMap_();
  const appWorks = {}; readRows_(ssOps_(),'Application_Works').forEach(function(x){
    (appWorks[x.application_id] = appWorks[x.application_id] || []).push(nameMap[x.work_id] || x.work_id); });
  return readRows_(ssOps_(),'Applications')
    .filter(function(a){ return a.status !== 'SIGNED' && !linked[a.application_id]; })
    .map(function(a){ return {
      application_id: a.application_id, application_ref: a.application_ref||'', status: a.status||'',
      works: (appWorks[a.application_id]||[]).join('、'), created_at: String(a.created_at||'')
    }; });
}
/**
 * 未紐付け締結を申込へ手動紐付け。対象原作を固定し、認証・バッジ・提出トークンを発行（冪等）。
 * ref突合が使えない運用（契約書タイトルにref差込不可等）の最終手段。
 */
function admin_linkContract(contractId, applicationId){ requireRole_(['OPERATIONS','LEGAL_ADMIN']);
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; });
  if(!c) throw new Error('契約が見つかりません: ' + contractId);
  if(c.application_id) throw new Error('この契約は既に申込 ' + c.application_id + ' に紐付いています');
  const app = readRows_(ssOps_(),'Applications').find(function(x){ return x.application_id === applicationId; });
  if(!app) throw new Error('申込が見つかりません: ' + applicationId);
  const dup = readRows_(ssOps_(),'Contracts').find(function(x){ return x.application_id === applicationId; });
  if(dup) throw new Error('この申込は既に契約 ' + dup.contract_id + ' に紐付いています');

  updateRow_(ssOps_(),'Contracts','contract_id',contractId,
    { application_id: applicationId, application_ref: app.application_ref || '', link_status: 'LINKED' });
  snapshotContractWorks_(contractId, applicationId);
  snapshotContractTerms_(contractId, app);
  updateRow_(ssOps_(),'Applications','application_id',applicationId,{ status:'SIGNED' });
  finishContractLinkage_(contractId);
  logEvent_('contract', contractId, actor_(), { link_status:'UNLINKED' },
    { link_status:'LINKED', application_id:applicationId, application_ref:app.application_ref||'' });
  return true;
}

/** 入金管理：請求(Invoices)に入金(Payments)状況・作品名を結合 */
function admin_listPayments(){ requireRole_([]);
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
function admin_recordPayment(contractId, invoiceId, amount, paidAt, recordedBy){ requireRole_(['ACCOUNTING']);
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
function admin_voidPayment(invoiceId){ requireRole_(['ACCOUNTING']);
  const pays = readRows_(ssOps_(),'Payments').filter(p => String(p.invoice_id)===String(invoiceId) && p.status==='入金済');
  pays.forEach(p => updateRow_(ssOps_(),'Payments','payment_id',p.payment_id,{status:'取消'}));
  if(invoiceId) updateRow_(ssOps_(),'Invoices','invoice_id',invoiceId,{status:'入金待ち'});
  logEvent_('payment', invoiceId, actor_(), {status:'入金済'}, {status:'取消'});
  return true;
}

/** 半期清算：計算書(Settlement_Statements)に配分額・パートナー名を結合 */
function admin_listSettlements(){ requireRole_([]);
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
function admin_approveStatement(statementId){ requireRole_(['ACCOUNTING']);
  updateRow_(ssOps_(),'Settlement_Statements','statement_id',statementId,{status:'APPROVED'});
  logEvent_('settlement_statement', statementId, actor_(), null, {status:'APPROVED'});
  return true;
}

// ---- バッチ手動起動（管理コンソールから・時間主導トリガーと共用） ----
/** QUEUEDのAI審査ジョブを実行 */
function admin_runAiReviews(){ requireRole_(['OPERATIONS']); const r = batch_runAiReviews_(); logEvent_('batch','ai_reviews',actor_(),null,r); return r; }
/** 当期（または指定期）の計算書をDRAFT生成 */
function admin_generateStatements(period){ requireRole_(['ACCOUNTING']); const r = batch_generateStatements(period||currentPeriod_()); logEvent_('batch','generate_statements',actor_(),null,r); return r; }
/** 承認済の計算書をCloudSign送信（みなし合意・発効日＋1ヶ月） */
function admin_sendApprovedStatements(){ requireRole_(['ACCOUNTING']); const r = batch_sendApprovedStatements_(); logEvent_('batch','send_statements',actor_(),null,r); return r; }

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

  const defaultRate  = num_(getConfig_('DEFAULT_ROYALTY_RATE', '0.10'));   // 既定ロイヤリティ率（フォールバック）
  const handlingRate = num_(getConfig_('HANDLING_FEE_RATE',   '0.30'));    // 事務手数料率
  // 契約ごとの売上連動率（締結時の別紙2スナップショット）。RATE以外・未設定は既定率にフォールバック。
  const ctrRate = {};
  readRows_(ssOps_(),'Contracts').forEach(function(c){
    let rate = null;
    if(c.terms_snapshot){ try{ const t = JSON.parse(c.terms_snapshot);
      if(t && String(t.fee_model).toUpperCase()==='RATE' && t.rate!=null && t.rate!=='') rate = num_(t.rate); }catch(e){} }
    ctrRate[c.contract_id] = rate;
  });

  // 配分スキーム（修正設計書 FLOW-04/§12.1）：暗黙のパートナー数均等を廃止し、方式を明示。
  //   BY_WORK_EQUAL（既定）＝対象原作数で均等配分（同一権利者の複数原作分は合算）
  //   BY_PARTNER_EQUAL     ＝重複除外した権利者数で均等配分
  const scheme = String(getConfig_('DEFAULT_ALLOCATION_SCHEME', 'BY_WORK_EQUAL')).toUpperCase();

  const byPartner = {};  // partner_id -> { partner, details:[], total }
  reports.forEach(r => {
    const net = num_(r.net_sales);
    const royaltyRate  = (ctrRate[r.contract_id] != null) ? ctrRate[r.contract_id] : defaultRate;
    const licenseFee   = Math.round(net * royaltyRate);
    const partnerShare = Math.round(licenseFee * (1 - handlingRate));
    const workIds = ctrWorkIds[r.contract_id] || [];
    // 配分単位のリストを作る：{ work_id, partner, ratio }
    let units = [];
    if(scheme === 'BY_PARTNER_EQUAL'){
      const pmap = {};
      workIds.forEach(function(wid){ const p = resolveWorkPartner_(workById[wid] || { work_id:wid, publisher:'' }, partners); pmap[p.partner_id] = p; });
      const plist = Object.keys(pmap).map(function(k){ return pmap[k]; });
      units = (plist.length ? plist : [resolveWorkPartner_({work_id:'',publisher:''}, partners)])
        .map(function(p){ return { work_id:'', partner:p, ratio: 1 / Math.max(1, plist.length || 1) }; });
    } else {  // BY_WORK_EQUAL（既定）
      const list = workIds.length ? workIds : [''];
      units = list.map(function(wid){
        return { work_id:wid, partner:resolveWorkPartner_(workById[wid] || { work_id:wid, publisher:'' }, partners), ratio: 1 / list.length };
      });
    }
    let allocated = 0;
    units.forEach(function(u, idx){
      const amt = (idx === units.length - 1) ? (partnerShare - allocated) : Math.floor(partnerShare * u.ratio);  // 端数は末尾へ
      allocated += amt;
      const key = u.partner.partner_id;
      if(!byPartner[key]) byPartner[key] = { partner:u.partner, details:[], total:0 };
      byPartner[key].details.push({
        contract_id: r.contract_id, work_id: u.work_id, partner_id: u.partner.partner_id,
        allocation_scheme: scheme, allocation_ratio: Math.round(u.ratio * 10000) / 10000,
        rate_snapshot: JSON.stringify({ royalty_rate:royaltyRate, handling_fee_rate:handlingRate,
          net_sales:net, license_fee:licenseFee, scheme:scheme, ratio:u.ratio, report_id:r.report_id }),
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
      contract_id:d.contract_id, work_id:d.work_id||'', partner_id:d.partner_id||'',
      allocation_scheme:d.allocation_scheme||'', allocation_ratio:d.allocation_ratio||'',
      rate_snapshot:d.rate_snapshot, amount:d.amount }));
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
function admin_recordObjection(statementId, note){ requireRole_(['ACCOUNTING','LEGAL_ADMIN']);
  updateRow_(ssOps_(),'Settlement_Statements','statement_id',statementId,{ status:'OBJECTION_RECEIVED' });
  logEvent_('settlement_statement', statementId, actor_(), null, { status:'OBJECTION_RECEIVED', note:note||'' });
  return true;
}
/** 支払確定（管理コンソール）：NO_OBJECTION_RECORDED → FINALIZED */
function admin_finalizeStatement(statementId){ requireRole_(['ACCOUNTING']);
  updateRow_(ssOps_(),'Settlement_Statements','statement_id',statementId,{ status:'FINALIZED', finalized_at:new Date().toISOString() });
  logEvent_('settlement_statement', statementId, actor_(), null, { status:'FINALIZED' });
  return true;
}

// ============================================================
// 8. 定期処理・トリガー・データ削除（修正設計書 §18/§20・OPS-01・FUN-05）
// ============================================================
/** バッチ実行ラッパ：開始・終了・件数・エラーを Batch_Runs に記録する */
function batchRun_(name, fn){
  const runId = Utilities.getUuid();
  appendRow_(ssOps_(),'Batch_Runs',{ batch_run_id:runId, batch_name:name,
    started_at:new Date().toISOString(), finished_at:'', processed:'', errors:'', status:'RUNNING', detail:'' });
  try{
    const r = fn() || {};
    updateRow_(ssOps_(),'Batch_Runs','batch_run_id',runId,{ finished_at:new Date().toISOString(),
      processed:(r.processed!=null?r.processed:''), errors:(r.errors!=null?r.errors:0), status:'DONE', detail:JSON.stringify(r).slice(0,500) });
    return r;
  }catch(err){
    updateRow_(ssOps_(),'Batch_Runs','batch_run_id',runId,{ finished_at:new Date().toISOString(), status:'ERROR', detail:String(err).slice(0,500) });
    logError_('PROCESSING_ERROR','batch:'+name, err);
    throw err;
  }
}
// ---- トリガー・ハンドラ（setup_triggers で作成） ----
function trigger_every5min(){                     // Webhook再処理＋AI審査キュー
  batchRun_('processWebhookReceipts', batch_processWebhookReceipts);
  batchRun_('runAiReviews', batch_runAiReviews_);
}
function trigger_daily(){                         // 期限処理・みなし確認・データ削除
  batchRun_('expireAccessTokens', batch_expireAccessTokens);
  batchRun_('closeObjectionPeriods', function(){ batch_confirmDeemed(); return {}; });
  batchRun_('purgeExpiredData', batch_purgeExpiredData);
}
/** トリガーの冪等セットアップ（Apps Scriptエディタから1回 Run） */
function setup_triggers(){
  const handlers = { trigger_every5min:'MIN5', trigger_daily:'DAILY' };
  const existing = {};
  ScriptApp.getProjectTriggers().forEach(function(t){ existing[t.getHandlerFunction()] = true; });
  const made = [];
  if(!existing.trigger_every5min){ ScriptApp.newTrigger('trigger_every5min').timeBased().everyMinutes(5).create(); made.push('trigger_every5min'); }
  if(!existing.trigger_daily){ ScriptApp.newTrigger('trigger_daily').timeBased().everyDays(1).atHour(3).create(); made.push('trigger_daily'); }
  logEvent_('batch','setup_triggers','setup',null,{ created:made });
  return { created:made, skipped:Object.keys(existing) };
}
/** 期限切れアクセストークンを EXPIRED へ（§18） */
function batch_expireAccessTokens(){
  const now = new Date(); let n = 0;
  readRows_(ssOps_(),'Access_Tokens')
    .filter(function(t){ return t.status === 'OPEN' && t.expires_at && new Date(t.expires_at) < now; })
    .forEach(function(t){ updateRow_(ssOps_(),'Access_Tokens','token_id',t.token_id,{ status:'EXPIRED' }); n++; });
  return { processed:n };
}
/**
 * 保有期間に基づく削除・匿名化（FUN-05/§20）。
 * 契約未成立の申込：APPLICATION_RETENTION_DAYS（既定365日）経過で参照情報を匿名化。
 */
function batch_purgeExpiredData(){
  const days = num_(getConfig_('APPLICATION_RETENTION_DAYS','365')) || 365;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  const contracted = {}; readRows_(ssOps_(),'Contracts').forEach(function(c){ if(c.application_id) contracted[c.application_id] = true; });
  let n = 0;
  readRows_(ssOps_(),'Applications')
    .filter(function(a){ return !contracted[a.application_id] && a.status !== 'SIGNED' && a.status !== 'PURGED' &&
      a.created_at && new Date(a.created_at) < cutoff; })
    .forEach(function(a){
      updateRow_(ssOps_(),'Applications','application_id',a.application_id,{ status:'PURGED', application_ref:'' });
      logEvent_('application', a.application_id, 'system', {status:a.status}, { purged:true, retention_days:days });
      n++;
    });
  return { processed:n };
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

function admin_getLegalTexts(){ requireRole_([]); return api_getLegalTexts(); }
function admin_saveLegalTexts(privacy, termsTemplate){ requireRole_(['LEGAL_ADMIN']);
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
function admin_listWorksMaster(){ requireRole_([]); return readRows_(ssMaster_(), 'Works_Master'); }

/** 作品の追加・更新（work_id一致でupsert）。media/ok/no はCSV文字列で保存。 */
function admin_saveWork(work){ requireRole_(['OPERATIONS']);
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

// ---- 利用料条件（別紙2）の料金表：事務局が編集 ----
const FEE_FIELDS = ['usage_category','fee_model','fee_value','fee_label','licensed_uses','payment_due','reporting_requirement','report_due','threshold_or_cap','reprint_rule','special_terms','active'];
/** 料金表全件（無効行も含む・管理用） */
function admin_getFeeSchedule(){ requireRole_([]); return readRows_(ssMaster_(),'Fee_Schedule'); }
/** 料金表の1行を追加・更新（usage_category 一致でupsert） */
function admin_saveFeeRow(row){ requireRole_(['ACCOUNTING','LEGAL_ADMIN']);
  const r = {}; FEE_FIELDS.forEach(function(k){ if(row[k] !== undefined) r[k] = row[k]; });
  if(!r.usage_category) throw new Error('利用目的（usage_category）は必須です');
  if(r.active === undefined) r.active = 'true';
  if(!updateRow_(ssMaster_(),'Fee_Schedule','usage_category', r.usage_category, r)){
    appendRow_(ssMaster_(),'Fee_Schedule', r);
  }
  logEvent_('config','FEE_SCHEDULE',actor_(),null,{ usage_category:r.usage_category, fee_model:r.fee_model });
  return true;
}

/** 公開状態の切替（PUBLISHED / DRAFT / UNPUBLISHED 等） */
function admin_setWorkPublish(workId, status){ requireRole_(['OPERATIONS']);
  updateRow_(ssMaster_(), 'Works_Master', 'work_id', workId, { publish_status: status });
  logEvent_('work', workId, actor_(), null, { publish_status: status });
  return true;   // X投稿は送信許可ポップアップ→admin_postWorkToX
}

// ---- 9.3 データソース設定（スプレッドシート/Drive/GCPの接続先） ----
function admin_getDataSourceConfig(){ requireRole_(['SYSTEM_ADMIN']);
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
function admin_saveDataSourceConfig(c){ requireRole_(['SYSTEM_ADMIN']);
  const sp = PropertiesService.getScriptProperties();
  ['SS_MASTER','SS_OPS','DRIVE_ROOT','GCP_PROJECT','GCP_REGION','GEMINI_MODEL']
    .forEach(k => { if(c[k] !== undefined) sp.setProperty(k, String(c[k])); });
  logEvent_('config', 'DATASOURCE', actor_(), null, { saved: true });
  return true;
}

// ---- 9.4 外部API：CloudSign / FormRun（秘密はScriptProperties・読み出しはマスク） ----
/** 設定の取得。secret等の機微情報は値を返さず「設定済みか」のみ返す。 */
function admin_getIntegrationConfig(){ requireRole_(['SYSTEM_ADMIN']);
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
      ref_param:          prop_('FORM_REF_PARAM')     || '',   // application_ref を引き継ぐhidden項目キー（例：_field_xxxxxx）
      hidden_map:         prop_('FORM_HIDDEN_MAP')    || '',   // 正規キー→hidden項目キー（JSON。application_ref/work_id_1../work_title_1..）
      max_works:          prop_('FORM_MAX_WORKS')     || '5'   // 契約書テンプレートの対象原作枠数
    }
  };
}
/** CloudSign設定の保存。secretは値が来た時のみ更新（空なら据え置き）。 */
function admin_saveCloudSignConfig(c){ requireRole_(['SYSTEM_ADMIN']);
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
function admin_saveFormRunConfig(c){ requireRole_(['SYSTEM_ADMIN']);
  const sp = PropertiesService.getScriptProperties();
  if(c.form_url       !== undefined) sp.setProperty('FORMRUN_FORM_URL',  String(c.form_url));
  if(c.webhook_secret)               sp.setProperty('FORMRUN_WEBHOOK_SECRET', String(c.webhook_secret));
  if(c.field_map      !== undefined) sp.setProperty('FORMRUN_FIELD_MAP', String(c.field_map));
  if(c.ref_param      !== undefined) sp.setProperty('FORM_REF_PARAM',    String(c.ref_param));
  if(c.hidden_map     !== undefined) sp.setProperty('FORM_HIDDEN_MAP',   String(c.hidden_map));
  if(c.max_works      !== undefined) sp.setProperty('FORM_MAX_WORKS',    String(parseInt(c.max_works,10) || 5));
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
  Reference_Assets:['asset_id','work_id','asset_type','drive_file_id','allowed_flag'],
  // 利用料条件（別紙2）の一律ルール。利用目的(usage_category)ごとに計算方式を持つ（事務局が編集）。
  //   fee_model: RATE=売上連動 / FLAT=定額(契約単位) / PER_WORK=原作数比例
  //   fee_value: RATEは率(0.10=10%)、FLAT/PER_WORKは金額(円)
  Fee_Schedule:    ['usage_category','fee_model','fee_value','fee_label','licensed_uses','payment_due','reporting_requirement','report_due','threshold_or_cap','reprint_rule','special_terms','active']
};
const SCHEMA_OPS = {
  // 申込：複数原作は中間テーブル Application_Works で管理（B経路固定・A/B分岐なし）
  //   usage_category：利用目的（別紙2の料金計算キー）／privacy_hash・terms_hash：同意時文書ハッシュ（§7.2）
  Applications:         ['application_id','application_ref','usage_category','privacy_hash','terms_hash','status','created_at'],
  Application_Works:    ['application_work_id','application_id','work_id'],
  // 契約：締結時に対象原作を Contract_Works へスナップショット（法務証跡）
  //   link_status: LINKED（申込突合済）/ UNLINKED（未突合＝手動紐付け待ち）
  //   contract_file_id/hash：締結済原本PDF（FUN-04）
  Contracts:            ['contract_id','cloudsign_document_id','cloudsign_title','application_id','application_ref','usage_category','terms_snapshot','status','link_status','signed_at','contract_file_id','contract_file_hash','folder_id'],
  Contract_Works:       ['contract_work_id','contract_id','work_id','work_name_snapshot','publisher_snapshot','credit_snapshot','partner_id_snapshot'],
  // 用途別アクセストークン（SEC-06/§9.1）：SUBMISSION / REPORT / BADGE_DOWNLOAD
  Access_Tokens:        ['token_id','contract_id','purpose','token_hash','status','expires_at','max_uses','used_count','last_used_at','issued_at','revoked_at'],
  Submissions:          ['submission_id','contract_id','title','status','submitted_at'],
  Submission_Versions:  ['version_id','submission_id','version_no','status','submitted_at'],
  Submission_Files:     ['submission_file_id','version_id','drive_file_id','mime_type','size','sha256','original_filename','magic_valid'],
  AI_Review_Jobs:       ['ai_review_id','submission_id','version_id','model','prompt_version','status','retry_count'],
  AI_Findings:          ['finding_id','ai_review_id','work_id','rule_id','severity','result','page','evidence','confidence'],
  Human_Reviews:        ['human_review_id','submission_id','version_id','reviewer','result','comments','reviewed_at'],
  Compliance_Alerts:    ['alert_id','contract_id','submission_id','severity','status','settlement_block'],
  // 利用報告（FUN-01/§11.1）：SUBMITTED→RETURNED/APPROVED→LOCKED（→SUPERSEDED）
  Usage_Reports:        ['report_id','contract_id','period','channel','qty','gross_sales','returns','deductions','net_sales','sales_url','status','submitted_at','approved_by','approved_at','locked_at','returned_reason'],
  // 請求（FUN-02）：source_type=CONTRACT（FLAT/PER_WORK締結時）/ REPORT（RATE報告承認後）
  Invoices:             ['invoice_id','contract_id','period','source_type','source_id','amount_rule','amount','status','issued_at'],
  Payments:             ['payment_id','invoice_id','contract_id','amount','paid_at','method','status','recorded_by'],
  Settlements:          ['settlement_id','partner_id','period','amount','status','hold_reason'],
  // 清算明細（FLOW-04/§12.2）：原作・権利者・配分方式・比率を明示
  Settlement_Details:   ['settlement_detail_id','settlement_id','contract_id','work_id','partner_id','allocation_scheme','allocation_ratio','rate_snapshot','amount'],
  // 清算ステータスは CONFIRMED を使わず OBJECTION_PERIOD→NO_OBJECTION_RECORDED→FINALIZED
  Settlement_Statements:['statement_id','settlement_id','partner_id','period','type','reg_number_snapshot','status','effective_date','objection_due','pdf_file_id','sheet_id','version','sent_at','finalized_at'],
  Partners:             ['partner_id','name','invoice_reg_number','is_qualified_issuer','bank','contact'],
  Badges:               ['badge_id','contract_id','issued_at','png_l','png_m','png_s','token_hash','status'],
  // 認証：状態＋変更理由・承認記録
  Certificates:         ['cert_id','contract_id','status','reason_code','reason_text','requested_by','approved_by','legal_case_id','effective_at','check_code_hash','issued_at'],
  Events:               ['event_id','entity_type','entity_id','actor','before','after','occurred_at'],
  Config:               ['config_key','value','environment','updated_at'],
  // ---- 修正設計書 §15.1 追加テーブル ----
  Admin_Users:          ['admin_user_id','email','role','status','added_by','added_at'],
  Webhook_Receipts:     ['receipt_id','provider','external_event_id','payload_hash','payload_json','signature_valid','received_at','status','retry_count','last_error','processed_at'],
  System_Errors:        ['error_id','error_code','source','message','detail','occurred_at','status'],
  Batch_Runs:           ['batch_run_id','batch_name','started_at','finished_at','processed','errors','status','detail'],
  X_Posts:              ['x_post_id','work_id','tweet_id','text','posted_by','posted_at']
};

const SAMPLE_WORKS_SEED = [
  {work_id:'WRK-ARK00045', work_name:'光砕のリヴァルチャー', publisher:'どらこにあん／アークライト', category:'TRPG / ルールブック', publish_status:'PUBLISHED', review_policy:'PATROL_ONLY（契約後審査）', fee_label:'書籍：16,500円／作品', media:'書籍,電子書籍,商品販売', ok_elements:'世界観設定,シナリオ,キャラクター名称', no_elements:'公式イラスト流用', credit_text:'指定の権利表記を記載', allocation_scheme_id:'', royalty_rate:'', partner_id:'PRT-DRACO'},
  {work_id:'WRK-ARK00012', work_name:'新クトゥルフ神話TRPG', publisher:'アークライト／KADOKAWA', category:'TRPG / ルールブック', publish_status:'PUBLISHED', review_policy:'PATROL_ONLY（契約後審査）', fee_label:'電子書籍：売上の10％', media:'書籍,電子書籍,商品販売', ok_elements:'世界観・神話設定,シナリオ', no_elements:'公式イラスト流用,ルールデータ転載', credit_text:'指定のシリーズ権利表記を記載', allocation_scheme_id:'', royalty_rate:'0.10', partner_id:'PRT-ARK'},
  {work_id:'WRK-BKK00019', work_name:'インセイン', publisher:'冒険企画局', category:'TRPG / ルールブック', publish_status:'DRAFT', review_policy:'PATROL_ONLY（契約後審査）', fee_label:'電子書籍：売上の10％', media:'電子書籍', ok_elements:'世界観設定,ハンドアウト形式', no_elements:'シナリオデータ転載', credit_text:'指定の権利表記を記載', allocation_scheme_id:'', royalty_rate:'0.10', partner_id:''}
];
const SAMPLE_PARTNERS_SEED = [
  {partner_id:'PRT-DRACO', name:'どらこにあん', invoice_reg_number:'T0000000000000', is_qualified_issuer:'true', bank:'', contact:''},
  {partner_id:'PRT-ARK',   name:'アークライト', invoice_reg_number:'T0000000000000', is_qualified_issuer:'true', bank:'', contact:''}
];
// 利用料条件（別紙2）の一律ルール初期値。金額・率・文言は事務局が設定画面で編集可能なプレースホルダ。
const SAMPLE_FEE_SCHEDULE_SEED = [
  {usage_category:'書籍', fee_model:'PER_WORK', fee_value:'16500', fee_label:'16,500円／原作',
   licensed_uses:'複製・頒布', payment_due:'契約締結後の請求書発行日から30日以内', reporting_requirement:'定額のため利用報告は原則不要',
   report_due:'－', threshold_or_cap:'－', reprint_rule:'増刷時も追加料金なし（要お申し出）', special_terms:'', active:'true'},
  {usage_category:'電子出版物', fee_model:'RATE', fee_value:'0.10', fee_label:'売上の10％',
   licensed_uses:'複製・公衆送信', payment_due:'半期ごとの計算書発効後', reporting_requirement:'半期ごとに販売実績を報告',
   report_due:'各半期終了後1ヶ月以内', threshold_or_cap:'－', reprint_rule:'－', special_terms:'', active:'true'},
  {usage_category:'商品販売', fee_model:'PER_WORK', fee_value:'16500', fee_label:'16,500円／原作',
   licensed_uses:'複製・頒布・販売', payment_due:'契約締結後の請求書発行日から30日以内', reporting_requirement:'定額のため利用報告は原則不要',
   report_due:'－', threshold_or_cap:'頒布数の上限は設けない', reprint_rule:'追加製造も追加料金なし（要お申し出）', special_terms:'', active:'true'},
  {usage_category:'サブスクリプション', fee_model:'RATE', fee_value:'0.10', fee_label:'売上の10％',
   licensed_uses:'公衆送信（継続的提供）', payment_due:'半期ごとの計算書発効後', reporting_requirement:'半期ごとに売上を報告',
   report_due:'各半期終了後1ヶ月以内', threshold_or_cap:'－', reprint_rule:'－', special_terms:'', active:'true'},
  {usage_category:'イベント', fee_model:'FLAT', fee_value:'0', fee_label:'無償（イベント頒布・要事前申告）',
   licensed_uses:'頒布・上演', payment_due:'－', reporting_requirement:'頒布実績を事後報告',
   report_due:'イベント終了後1ヶ月以内', threshold_or_cap:'－', reprint_rule:'－', special_terms:'営利目的の恒常販売には別区分が適用されます', active:'true'},
  {usage_category:'その他', fee_model:'RATE', fee_value:'0.10', fee_label:'売上の10％（個別協議）',
   licensed_uses:'別途協議', payment_due:'個別協議', reporting_requirement:'個別協議',
   report_due:'個別協議', threshold_or_cap:'個別協議', reprint_rule:'個別協議', special_terms:'内容により事務局と個別に条件を定めます', active:'true'}
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
  if(!prop_('FORM_MAX_WORKS'))               sp.setProperty('FORM_MAX_WORKS', '5');   // 契約書テンプレートの原作枠（当面5）
  if(!getConfig_('DEFAULT_ALLOCATION_SCHEME','')) setConfig_('DEFAULT_ALLOCATION_SCHEME','BY_WORK_EQUAL');  // 配分方式（FLOW-04）
  if(!getConfig_('APPLICATION_RETENTION_DAYS','')) setConfig_('APPLICATION_RETENTION_DAYS','365');           // 未成立申込の保有期間

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
  if(readRows_(ssMaster_(),'Fee_Schedule').length === 0){
    SAMPLE_FEE_SCHEDULE_SEED.forEach(f => appendRow_(ssMaster_(),'Fee_Schedule', f));
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
  const actor = requireRole_(['OPERATIONS']);
  const w = readRows_(ssMaster_(),'Works_Master').find(function(x){ return x.work_id === workId; });
  if(!w) throw new Error('作品が見つかりません: ' + workId);
  if(w.publish_status !== 'PUBLISHED') throw new Error('VALIDATION_ERROR: 公開(PUBLISHED)の作品のみ投稿できます');
  // 重複投稿防止（X_Posts テーブル・修正設計書 §14）
  if(readRows_(ssOps_(),'X_Posts').some(function(p){ return p.work_id === workId; }))
    throw new Error('DATA_CONFLICT: この作品は投稿済みです（再投稿は X_Posts を確認のうえ手動で）');
  const text = x_buildPostText_(w);
  const res  = x_postTweet_(text);
  const tid  = (res && res.data && res.data.id) || '';
  appendRow_(ssOps_(),'X_Posts',{ x_post_id:Utilities.getUuid(), work_id:workId, tweet_id:tid,
    text:sanitizeCell_(text), posted_by:actor.email, posted_at:new Date().toISOString() });
  logEvent_('work', workId, actor.email, null, { x_posted:true, tweet_id:tid });
  return { tweet_id: tid, text: text };
}
/**
 * 送信許可ポップアップ用のプレビュー。作品データ更新時にクライアントが呼び、
 * autopost=ON かつ 設定済み なら text を確認ダイアログに表示 → 承認で admin_postWorkToX。
 * （サイレント自動投稿はしない：送信は必ず人の許可を挟む）
 */
function admin_getXPostPreview(workId){ requireRole_([]);
  const w = readRows_(ssMaster_(),'Works_Master').find(function(x){ return x.work_id === workId; });
  if(!w) return { text:'', configured:false, autopost:false, published:false };
  return {
    text:       x_buildPostText_(w),
    configured: x_isConfigured_(),
    autopost:   x_autopost_(),
    published:  w.publish_status === 'PUBLISHED',
    already_posted: readRows_(ssOps_(),'X_Posts').some(function(p){ return p.work_id === workId; })
  };
}

// ============================================================
// 12. 認証バッジ（クレジット表記）：入金確認後にPNG3サイズを発行・配布
//     Google Slidesで1枚を組版→サムネイル(LARGE/MEDIUM/SMALL)をPNG化→Drive保存→トークンDLページ＋メール。
// ============================================================
const BADGE_SIZES = [{ key:'L', size:'LARGE' }, { key:'M', size:'MEDIUM' }, { key:'S', size:'SMALL' }];

// B経路固定：認証・バッジは締結時に発行（課金モデル分岐なし）。

/** バッジ発行（契約単位・冪等）。BADGE_TEMPLATE_IDがあればテンプレ差込、無ければ自動組版。 */
function issueBadge_(contractId, verifyUrl){
  const existing = readRows_(ssOps_(),'Badges').find(function(b){ return b.contract_id === contractId && b.status === 'ISSUED'; });
  if(existing) return { badge_id: existing.badge_id, reused:true };

  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; });
  if(!c) throw new Error('契約が見つかりません: ' + contractId);
  // 複数原作：Contract_Works からまとめた表示名を使う（契約単位のバッジ）
  const w = { work_name: contractWorkNames_(contractId).join('、'), credit_text:'', verify_url: verifyUrl || '' };
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
    pres.replaceAllText('{{verify_url}}', w.verify_url || '');
    pres.saveAndClose();
    return pres.getId();
  }
  // テンプレ未設定：暫定デザインを自動組版（検証URLを記載＝QR相当の照合手段）
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
  t = slide.insertTextBox(w.credit_text || '', 36, 285, 648, 40);
  t.getText().getTextStyle().setForegroundColor('#EDEAF4').setFontSize(12);
  if(w.verify_url){
    t = slide.insertTextBox('検証: ' + w.verify_url, 36, 330, 648, 30);
    t.getText().getTextStyle().setForegroundColor('#A99FC4').setFontSize(9);
  }
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
 * 当社からメールは送らない。バッジ取得URLは提出ページ（web_getSubmitContext）に表示され、
 * 用途別トークン（BADGE_DOWNLOAD・期限/回数付き）で配布する（修正設計書 §13.4）。
 */
function distributeBadge_(c, badgeId){
  const token = issueToken_(c.contract_id, 'BADGE_DOWNLOAD', 90, 20);
  let base = ''; try{ base = ScriptApp.getService().getUrl() || ''; }catch(e){}
  return (base||'') + '?page=badge&token=' + token;   // 利用時のみ使用（メール送信はしない）
}

/** バッジDLページ（BADGE_DOWNLOADトークン）：3サイズのプレビューとダウンロードリンク */
function serveBadge_(e){
  const token = (e.parameter && e.parameter.token) || '';
  const tok = resolveToken_(token, 'BADGE_DOWNLOAD');
  const b = tok ? readRows_(ssOps_(),'Badges').find(function(x){ return x.contract_id === tok.contract_id && String(x.status) === 'ISSUED'; }) : null;
  if(!b) return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">リンクが無効か、有効期限が切れています。</p>').setTitle('SPLL 認証バッジ');
  consumeToken_(tok);
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
function admin_getXConfig(){ requireRole_(['SYSTEM_ADMIN']);
  return {
    api_key:          prop_('X_API_KEY') || '',
    api_secret_set:   !!prop_('X_API_SECRET'),
    access_token:     prop_('X_ACCESS_TOKEN') || '',
    access_secret_set:!!prop_('X_ACCESS_SECRET'),
    autopost:         prop_('X_AUTOPOST') === 'true',
    template:         getConfig_('X_POST_TEMPLATE', X_DEFAULT_TEMPLATE)
  };
}
function admin_saveXConfig(c){ requireRole_(['SYSTEM_ADMIN']);
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
function admin_getBadgeConfig(){ requireRole_([]);
  return { auto: prop_('BADGE_AUTO') !== 'false', template_id: prop_('BADGE_TEMPLATE_ID') || '' };
}
function admin_saveBadgeConfig(c){ requireRole_(['SYSTEM_ADMIN']);
  const sp = PropertiesService.getScriptProperties();
  if(c.auto        !== undefined) sp.setProperty('BADGE_AUTO', c.auto ? 'true' : 'false');
  if(c.template_id !== undefined) sp.setProperty('BADGE_TEMPLATE_ID', String(c.template_id));
  logEvent_('config', 'BADGE', actor_(), null, { saved:true });
  return true;
}
/** バッジ手動発行 */
function admin_issueBadge(contractId){ requireRole_(['OPERATIONS']); const r = issueBadge_(contractId); logEvent_('badge', r.badge_id || contractId, actor_(), null, { manual:true }); return r; }

// ============================================================
// 13. 認証（証明書）・検証ポータル・失効制御（案③）
//     締結で「有効」→ 台帳連動で後から失効可能。検証は固定ポータル＋ID照会。
//     配布は当社メールを使わず、利用者は「受付番号」でポータルからバッジ取得。
// ============================================================
const CERT_STATES = ['ACTIVE','SUSPENDED','REVOKED','EXPIRED','TERMINATED','PAYMENT_HOLD'];

/**
 * 締結時に認証を発行（ACTIVE）。照合コードは12桁の暗号学的乱数とし、台帳にはハッシュのみ保存
 * （修正設計書 §13.2）。平文コードは戻り値と検証URL（バッジQR用）でのみ扱う。
 */
function issueCert_(contractId){
  const existing = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  if(existing) return { cert_id:existing.cert_id, check_code:null, reused:true };
  const certId = newId_('CERT');
  const code = randCode_(12);
  const now = new Date().toISOString();
  appendRow_(ssOps_(),'Certificates',{ cert_id:certId, contract_id:contractId, status:'ACTIVE',
    reason_code:'ISSUED', reason_text:'締結により発行', requested_by:'system', approved_by:'system',
    legal_case_id:'', effective_at:now, check_code_hash:hash_(code), issued_at:now.slice(0,10) });
  logEvent_('certificate', certId, 'system', null, { contract_id:contractId, status:'ACTIVE' });
  return { cert_id:certId, check_code:code, verify_url:verifyUrl_(certId, code) };
}
function verifyUrl_(certId, code){
  let base = ''; try{ base = ScriptApp.getService().getUrl() || ''; }catch(e){}
  return (base||'') + '?page=verify&id=' + encodeURIComponent(certId) + '&c=' + encodeURIComponent(code);
}
/** 照合コードの再発行（LEGAL_ADMIN）。旧QRは無効になる。平文は1回だけ返す。 */
function admin_rotateCertCode(contractId){
  const actor = requireRole_(['LEGAL_ADMIN']);
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  if(!cert) throw new Error('認証が見つかりません: ' + contractId);
  const code = randCode_(12);
  updateRow_(ssOps_(),'Certificates','cert_id',cert.cert_id,{ check_code_hash:hash_(code) });
  logEvent_('certificate', cert.cert_id, actor.email, null, { code_rotated:true });
  return { cert_id:cert.cert_id, check_code:code, verify_url:verifyUrl_(cert.cert_id, code) };
}
function randCode_(n){
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for(var i=0;i<n;i++) s += cs.charAt(Math.floor(Math.random()*cs.length));
  return s;
}
// ---- 用途別アクセストークン（修正設計書 SEC-06/§9.1）----
//   purpose: SUBMISSION（提出）/ REPORT（利用報告）/ BADGE_DOWNLOAD（バッジ取得）
//   平文は発行時のみ返し、台帳にはハッシュのみ保存。期限・回数をサーバー側で検証。
function issueToken_(contractId, purpose, days, maxUses){
  const token = Utilities.getUuid() + randCode_(8);
  appendRow_(ssOps_(),'Access_Tokens',{ token_id:Utilities.getUuid(), contract_id:contractId,
    purpose:purpose, token_hash:hash_(token), status:'OPEN', expires_at:addDaysIso_(days||30),
    max_uses:maxUses||10, used_count:0, last_used_at:'', issued_at:new Date().toISOString(), revoked_at:'' });
  return token;
}
/** トークン検証：用途一致・OPEN・期限内・回数内。期限切れは EXPIRED に更新して拒否。 */
function resolveToken_(token, purpose){
  if(!token) return null;
  const tok = readRows_(ssOps_(),'Access_Tokens').find(function(x){
    return x.token_hash === hash_(token) && x.purpose === purpose && x.status === 'OPEN'; });
  if(!tok) return null;
  if(tok.expires_at && new Date(tok.expires_at) < new Date()){
    updateRow_(ssOps_(),'Access_Tokens','token_id',tok.token_id,{ status:'EXPIRED' });
    return null;
  }
  if(num_(tok.max_uses) > 0 && num_(tok.used_count) >= num_(tok.max_uses)) return null;
  return tok;
}
/** トークン消費（提出・報告の実行時のみ）。上限到達で USED。 */
function consumeToken_(tok){
  const used = num_(tok.used_count) + 1;
  const patch = { used_count:used, last_used_at:new Date().toISOString() };
  if(num_(tok.max_uses) > 0 && used >= num_(tok.max_uses)) patch.status = 'USED';
  updateRow_(ssOps_(),'Access_Tokens','token_id',tok.token_id,patch);
}
/** 同一契約・同一用途の旧トークンを失効（再発行時） */
function revokeTokens_(contractId, purpose){
  readRows_(ssOps_(),'Access_Tokens')
    .filter(function(x){ return x.contract_id === contractId && x.purpose === purpose && x.status === 'OPEN'; })
    .forEach(function(x){ updateRow_(ssOps_(),'Access_Tokens','token_id',x.token_id,{ status:'REVOKED', revoked_at:new Date().toISOString() }); });
}
/** 作品提出トークンを用意（メール送信はしない） */
function prepareSubmissionToken_(contractId){ return issueToken_(contractId, 'SUBMISSION', 30, 10); }
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
function admin_setCertStatus(contractId, status, reasonCode, reasonText, legalCaseId){ requireRole_(['LEGAL_ADMIN']);
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
function admin_getCertStatus(contractId){ requireRole_([]);
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  return cert ? { cert_id:cert.cert_id, status:cert.status, reason_code:cert.reason_code, issued_at:cert.issued_at } : { status:'NONE' };
}

/** 検証ポータル（?page=verify）。id+照合コード（ハッシュ照合・§13.2）で認証状態を表示。 */
function serveVerify_(e){
  const p = e.parameter || {};
  if(!p.id) return verifyInputHtml_();
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.cert_id === p.id; });
  const codeOk = cert && cert.check_code_hash && String(cert.check_code_hash) === hash_(String(p.c||''));
  if(!cert || !codeOk){
    logEvent_('certificate', String(p.id||''), 'public', null, { verify:'MISMATCH' });   // 照会ログ（総当たり検知用）
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
