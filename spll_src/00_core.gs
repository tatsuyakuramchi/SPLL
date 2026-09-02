/** SPLL 00_core ― 共通コア：設定・台帳I/O・ID採番・監査/障害ログ・ユーティリティ・同意文既定値（全プロジェクト共通） */

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

// ---- 環境（修正設計書v2 V2-002）：ENVIRONMENT は必須。未設定・不正値は起動時に停止 ----
// production ではフェイルクローズ（Webhook検証必須・匿名管理操作拒否・サンプル表示なし）。
function env_(){
  const v = prop_('ENVIRONMENT');
  if(!v) throw new Error('ENVIRONMENT is required（ScriptProperties に development / staging / production を設定してください）');
  if(['development','staging','production'].indexOf(v) < 0) throw new Error('Invalid ENVIRONMENT: ' + v);
  return v;
}
function isProd_(){ return env_() === 'production'; }
/** 開発用の匿名bootstrapは development かつ ALLOW_DEV_BOOTSTRAP=true の双方が必要（V2-002） */
function devBootstrapAllowed_(){ return env_() === 'development' && prop_('ALLOW_DEV_BOOTSTRAP') === 'true'; }

/** 公開入力の厳格数値変換（V2-009）。num_()の寛容変換を公開入力に使わない。 */
function requireNonNegativeNumber_(value, fieldName){
  if(value === '' || value === null || value === undefined) throw new Error('VALIDATION_ERROR: ' + fieldName + ' は必須です');
  const n = Number(value);
  if(!isFinite(n) || n < 0) throw new Error('VALIDATION_ERROR: ' + fieldName + ' は0以上の数値で入力してください');
  return n;
}

// ---- 引継ぎ改変検知（フォーム項目設計 §4.1.1）：handoff_token = HMAC-SHA256 ----
function handoffSecret_(){ return prop_('HANDOFF_SECRET') || ''; }
function makeHandoffToken_(appId, ref, workIds, usage, termsHash, expiresAt){
  const secret = handoffSecret_(); if(!secret) return '';
  const payload = [appId, ref, (workIds||[]).join(','), usage, termsHash, expiresAt].join('|');
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret)).slice(0, 32);
}
function verifyHandoffToken_(app, workIds, token){
  const secret = handoffSecret_(); if(!secret) return { ok:true, skipped:true };   // 未設定時は検証スキップ（devのみ想定）
  if(!token) return { ok:false, reason:'handoff_token欠落' };
  const expect = makeHandoffToken_(app.application_id, app.application_ref, workIds, app.usage_category, app.terms_hash || '', app.handoff_expires_at || '');
  if(String(token) !== expect) return { ok:false, reason:'handoff_token不一致（改変の疑い）' };
  if(app.handoff_expires_at && new Date(app.handoff_expires_at) < new Date()) return { ok:false, reason:'handoff有効期限切れ' };
  return { ok:true };
}

/** 署名失敗等の大量イベントは1件ずつシートへ書かず、集約カウンタ＋サンプリング記録（V2-007/§3.6） */
function recordRejectedAggregate_(kind, detail){
  try{
    const cache = CacheService.getScriptCache();
    const k = 'AGG_' + kind;
    const n = parseInt(cache.get(k) || '0', 10) + 1;
    cache.put(k, String(n), 21600);
    Logger.log('[REJECTED] %s #%s %s', kind, n, detail || '');
    if(n === 1 || n === 10 || n === 100 || n % 1000 === 0)
      logError_('AUTHENTICATION_ERROR', 'webhook:' + kind, '検証失敗の集約記録（直近6hで' + n + '件目）', { sample:detail });
  }catch(e){}
}

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

/**
 * 公開：同意文（個人情報）・規約テンプレートを返す。
 * 版管理（Legal_Documents・§7.2）の PUBLISHED 最新版を優先し、
 * 無ければ Config → 既定文にフォールバック。版番号・文書IDも返す（同意証跡用）。
 */
function api_getLegalTexts(){
  const p = publishedLegalDoc_('PRIVACY');
  const t = publishedLegalDoc_('TERMS');
  const g = publishedLegalDoc_('GUIDELINE');
  return {
    privacy:         p ? p.content_html : getConfig_('LEGAL_PRIVACY_TEXT', DEFAULT_PRIVACY),
    termsTemplate:   t ? t.content_html : getConfig_('LEGAL_TERMS_TEMPLATE', DEFAULT_TERMS_TEMPLATE),
    guideline:       g ? g.content_html : getConfig_('LEGAL_GUIDELINE_TEXT', DEFAULT_GUIDELINE),
    privacy_version: p ? p.version : '', privacy_doc_id: p ? p.legal_document_id : '',
    terms_version:   t ? t.version : '', terms_doc_id:   t ? t.legal_document_id : '',
    guideline_version: g ? g.version : '', guideline_doc_id: g ? g.legal_document_id : ''
  };
}
/**
 * クリエーター向けページ（提出・手続き案内・バッジ・検証）を配信するGAS②のURL。
 * admin（GAS③）から発行するリンクは自プロジェクトのURLでは開けないため、Configで明示する。
 * 未設定時は自プロジェクトURLへフォールバック（単一プロジェクト構成・開発時の互換）。
 */
function workflowUrl_(){
  const cfg = String(getConfig_('WORKFLOW_URL','') || '').trim();
  if(cfg) return cfg.replace(/\/+$/, '');
  let base = ''; try{ base = ScriptApp.getService().getUrl() || ''; }catch(e){}
  return String(base).replace(/\/+$/, '');
}
/** クリエーター向けページのURLを組み立てる（page＋トークン） */
function userPageUrl_(page, tokenParam, token){
  const base = workflowUrl_();
  return (base || '') + '?page=' + encodeURIComponent(page) + '&' + tokenParam + '=' + encodeURIComponent(token);
}

/** 管理対象の法務文書（管理コンソール「同意文・規約」の3枠） */
const LEGAL_DOC_TYPES = ['PRIVACY','GUIDELINE','TERMS'];
const LEGAL_DOC_LABELS = { PRIVACY:'個人情報の取得同意', GUIDELINE:'SPLL二次創作ガイドライン', TERMS:'利用規約' };
/** 指定種別の PUBLISHED 最新版（version降順） */
function publishedLegalDoc_(type){
  return readRows_(ssOps_(),'Legal_Documents')
    .filter(function(d){ return d.document_type === type && d.status === 'PUBLISHED'; })
    .sort(function(a,b){ return num_(b.version) - num_(a.version); })[0] || null;
}

/**
 * 通知キュー（修正設計書 §10）：メール非保持方針のため、システムは「誰に何を通知すべきか」を
 * 記録し、管理コンソールで人手対応（MANUAL_REQUIRED）する。referenceId で重複起票を防止。
 */
function enqueueNotification_(contractId, type, referenceId, payload){
  const dup = readRows_(ssOps_(),'Notification_Queue').some(function(n){
    return n.type === type && String(n.reference_id) === String(referenceId||''); });
  if(dup) return null;
  const id = Utilities.getUuid();
  appendRow_(ssOps_(),'Notification_Queue',{ notification_id:id, contract_id:contractId||'',
    type:type, reference_id:referenceId||'', payload_json:JSON.stringify(payload||{}).slice(0,2000),
    status:'MANUAL_REQUIRED', created_at:new Date().toISOString(), sent_at:'', handled_by:'' });
  return id;
}

/**
 * レート制限（修正設計書 §6.4）。CacheServiceのカウンタ方式（ベストエフォート）。
 * 上限到達で false。GASの制約上WAF代替ではない点は設計書どおり。
 */
function rateLimit_(key, max, windowSec){
  try{
    const cache = CacheService.getScriptCache();
    const k = 'RL_' + key;
    const cur = parseInt(cache.get(k) || '0', 10);
    if(cur >= max) return false;
    cache.put(k, String(cur + 1), windowSec || 3600);
    return true;
  }catch(e){ return true; }   // キャッシュ障害時は業務を止めない
}
/** 金額を三桁区切り＋「円」で整形（ICO非依存） */
function yen_(v){
  const s = String(Math.round(num_(v)));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円';
}
// 申込参照番号：推測耐性のため乱数要素を含む（修正設計書 §7.3）。旧形式（連番4桁）も突合可能。
function refFromText_(s){ const m = String(s||'').match(/REF-\d{6}-[A-Z0-9]{4,12}/); return m ? m[0] : ''; }
function newRef_(){
  const ym = Utilities.formatDate(new Date(), 'JST', 'yyyyMM');
  return 'REF-' + ym + '-' + randCode_(6);
}
function parseJson_(s, def){ try{ const v = JSON.parse(s); return (v==null ? def : v); }catch(e){ return def; } }

// ============================================================
// 4. Drive 提出・Gemini 一次審査
// ============================================================
function createContractFolder_(contractId){
  const root = DriveApp.getFolderById(cfg_('DRIVE_ROOT'));
  const f = root.createFolder(contractId);
  ['01_Contract','02_Submissions','03_AI_Reviews','04_Human_Reviews']
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
function ruleActive_(r){
  const now = new Date();
  if(r.effective_from && new Date(r.effective_from) > now) return false;
  if(r.effective_to   && new Date(r.effective_to)   < now) return false;
  return true;
}
function csv_(v){ return String(v||'').split(',').map(s => s.trim()).filter(Boolean); }

/** Drive上のファイルのメタ情報（sha256/mime/size） */
function fileMeta_(fileId){
  try{
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    return { mime: blob.getContentType(), size: file.getSize(), sha256: sha256Bytes_(blob.getBytes()) };
  }catch(e){ return { mime:'', size:'', sha256:'' }; }
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
/** 提出の最新版ID */
function latestVersionId_(submissionId){
  const vs = readRows_(ssOps_(),'Submission_Versions').filter(v => v.submission_id===submissionId)
    .sort(function(a,b){ return num_(b.version_no)-num_(a.version_no); });
  return vs.length ? vs[0].version_id : '';
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
'<h4>1の2. AIによる審査処理</h4><ol><li>提出作品はVertex AI Gemini による一次審査に付されます。提出作品に個人情報が含まれる場合、当該情報もAI処理の対象となります（審査以外の目的には使用しません）。</li></ol>'+
'<h4>2. 利用目的</h4><ol><li>SPLL利用許諾の審査・契約の締結および管理</li><li>提出作品の適合性審査（AIによる一次審査を含む）</li><li>利用許諾料・配分の計算および清算</li><li>お問い合わせ対応・連絡</li><li>法令遵守および権利保護</li></ol>'+
'<h4>3. 委託・第三者提供</h4><ol><li>契約締結のため電子契約サービス（CloudSign）に取扱いを委託します。</li><li>データの保管・処理のためGoogle Workspace／Google Cloud（Vertex AI Geminiによる作品審査を含む）に取扱いを委託します。</li><li>法令に基づく場合を除き、ご本人の同意なく第三者へ提供しません。</li></ol>'+
'<h4>4. 保有期間</h4><ol><li>契約に至らなかった申込情報・提出作品データは、取得から1年で削除します。</li><li>契約に至った場合は、契約期間および関係法令の定める期間、保有します。</li></ol>'+
'<h4>5. 開示等の請求</h4><ol><li>保有個人データの開示・訂正・利用停止等のご請求は、下記窓口で受け付けます。［窓口記載・法務確定前］</li></ol>';

// 二次創作ガイドライン（SPLL-GDL-001）の既定文。正本は docs/SPLL_二次創作ガイドライン_v4.1.md で、
// 公開用HTMLは docs/legal/spll_guideline.body.html（node docs/build_legal_html.js で生成）。
// 実運用では管理コンソール「設定→同意文・規約」からHTML全文を登録・公開する。
const DEFAULT_GUIDELINE =
'<h4>SPLL二次創作ガイドライン（未登録）</h4>' +
'<p>ガイドライン本文が登録されていません。管理コンソール「設定 → 同意文・規約 → SPLL二次創作ガイドライン」に ' +
'<code>docs/legal/spll_guideline.body.html</code> の内容を貼り付け、公開してください。</p>';

// 規約はテンプレート。{{name}}{{pub}}{{ok}}{{no}}{{media}}{{fee}}{{credit}} を作品ごとに差込む。
const DEFAULT_TERMS_TEMPLATE =
'<h4>第1条（許諾の範囲）</h4><ol><li>本作品の許諾要素（{{ok}}）について、対象媒体（{{media}}）での二次創作・頒布を許諾します。</li><li>禁止要素（{{no}}）は利用できません。</li></ol>'+
'<h4>第2条（利用許諾料）</h4><ol><li>利用許諾料は {{fee}} とします。免除・追加契約の条件は別表によります。</li></ol>'+
'<h4>第3条（クレジット表記）</h4><ol><li>{{credit}}。「公式」「公認」等と誤認させる表示は行いません。</li></ol>'+
'<h4>第4条（作品審査・是正）</h4><ol><li>提出作品はAI（Vertex AI Gemini）による一次審査に付されます。AIの判定は最終決定ではなく、当社・事務局の人的判断と区別されます。</li><li>適合性に疑義がある場合、是正の要求・公開停止・許諾の取消し等を行うことがあります。</li></ol>'+
'<h4>第5条（非承認・非保証）</h4><ol><li>審査の通過、または一定期間の無指摘は、当社の承認・適法性保証・権利非侵害保証を意味しません。</li></ol>'+
'<h4>第6条（解除）</h4><ol><li>表明の虚偽、本規約違反その他の事由があるときは、本許諾を解除できます。［解除の遡及／非遡及は別途規定・法務確定前］</li></ol>'+
'<h4>第7条（準拠法・管轄）</h4><ol><li>日本法に準拠し、当社所在地を管轄する裁判所を専属的合意管轄とします。</li></ol>';

function badgeFolder_(c){
  try{ if(c.folder_id) return DriveApp.getFolderById(c.folder_id); }catch(e){}
  return DriveApp.getFolderById(cfg_('DRIVE_ROOT'));
}
/**
 * QR・バッジに焼き込む公開ドメイン（設定設計 §1.3）。
 * QRは頒布物に印刷されて永続するため、実行基盤のURL（script.google.com・*.run.app等）を入れない。
 * 独自ドメインを立てたらPUBLIC_BASE_URLへ設定する。以後、基盤を移してもDNSの向き先を変えるだけで済む。
 * 未設定の間は現行どおりGAS②のURLを使う（設定した瞬間から新規発行分に適用される）。
 */
function publicBaseUrl_(){
  return String(getConfig_('PUBLIC_BASE_URL','') || '').trim().replace(/\/+$/, '');
}
function verifyUrl_(certId, code){
  const pub = publicBaseUrl_();
  if(pub) return pub + '/v/' + encodeURIComponent(certId) + '?c=' + encodeURIComponent(code);
  // 発行元はGAS②（クリエーター向けページ）。adminから再発行してもadminのURLを焼き込まない。
  return workflowUrl_() + '?page=verify&id=' + encodeURIComponent(certId) + '&c=' + encodeURIComponent(code);
}
/** 暗号学的乱数コード（V2-014-5：Math.random不使用）。UUID×2のSHA-256から生成。 */
function randCode_(n){
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  while(s.length < n){
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
    for(var i=0; i<bytes.length && s.length<n; i++){ s += cs.charAt(((bytes[i]%256)+256) % cs.length); }
  }
  return s;
}
/** 契約の対象原作名リスト（Contract_Works→Works_Master） */
function contractWorkNames_(contractId){
  const nameMap = worksNameMap_();
  return readRows_(ssOps_(),'Contract_Works').filter(function(x){ return x.contract_id === contractId; })
    .map(function(x){ return nameMap[x.work_id] || x.work_id; });
}
/**
 * 契約が求めるクレジット表記。契約書には具体的な文言を差し込まず「甲が別途指定する権利表記」とし、
 * 実際の文言はここから案内ページ・検証ページで示す（CloudSign FORMのURLは1000字までで、
 * クレジット表記は原作数に比例して膨らむため、契約書へ列挙すると2作品で上限に達する）。
 * 出所は締結時のスナップショットとする。原作マスタを後から直しても、締結済の契約が求める表記は変わらない。
 */
function contractCreditTexts_(contractId){
  return readRows_(ssOps_(),'Contract_Works').filter(function(x){ return x.contract_id === contractId; })
    .map(function(x){ return String(x.credit_snapshot || ''); }).filter(Boolean)
    .filter(function(v, i, a){ return a.indexOf(v) === i; });
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

// ============================================================
// SPLLライセンス台帳ヘルパー（分断・簡素化計画 SPLL-SYS-RP-001 §6）
//   license_id（SPLL番号）を全業務の主キーとし、申込〜認証を1案件として扱う。
// ============================================================
/** 申込からライセンス案件（License_Cases＋License_Works）を作成し license_id を返す。 */
function createLicenseCase_(appId, applicationRef, usageCategory, workIds, partyType){
  const licenseId = newId_('SPLL');
  const now = new Date().toISOString();
  // 初期状態は状態遷移表の APPLICATION_CREATED と同じ（12_license_state）
  appendRow_(ssOps_(), 'License_Cases', {
    license_id: licenseId, application_ref: applicationRef,
    party_type: sanitizeCell_(String(partyType || '')), party_display_name: '',
    usage_category: sanitizeCell_(String(usageCategory || '')),
    case_status: 'APPLICATION_RECEIVED', contract_status: 'NOT_STARTED',
    cloudsign_document_id: '', signed_at: '', signed_pdf_file_id: '', signed_pdf_hash: '',
    review_status: 'NOT_STARTED', certification_status: 'NOT_ISSUED',
    finance_handoff_status: 'NOT_REQUIRED', created_at: now, updated_at: now,
  });
  logEvent_('license_case', licenseId, 'portal', { transition_event:'APPLICATION_CREATED' },
    { transition_event:'APPLICATION_CREATED', case_status:'APPLICATION_RECEIVED', contract_status:'NOT_STARTED',
      review_status:'NOT_STARTED', certification_status:'NOT_ISSUED', application_ref: applicationRef });
  // 対象原作＋契約条件スナップショット（費用＝契約形態（利用目的）×原作構造で自動確定・原則5）
  const master = readRows_(ssMaster_(), 'Works_Master');
  const rule = (typeof feeRuleFor_ === 'function') ? feeRuleFor_(usageCategory) : null;
  (workIds || []).forEach(function(wid){
    const w = master.find(function(x){ return x.work_id === wid; }) || {};
    appendRow_(ssOps_(), 'License_Works', {
      license_work_id: Utilities.getUuid(), license_id: licenseId, work_id: wid,
      work_name_snapshot: sanitizeCell_(String(w.work_name || wid)),
      credit_snapshot: sanitizeCell_(String(w.credit_text || '')),
      fee_model_snapshot: rule ? String(rule.fee_model || '') : '',
      fee_value_snapshot: rule ? String(rule.fee_value || '') : '',
      reporting_requirement_snapshot: rule ? String(rule.requires_usage_report || '') : '',
      active: 'true',
    });
  });
  return licenseId;
}
/**
 * ライセンス案件の生更新（updated_at自動）。
 * 状態列（case_status 等）の変更は transitionLicenseCase_、それ以外は updateLicenseCaseInfo_ を使う。
 * ここを業務処理から直接呼ばない（12_license_state と移行処理だけが使う）。
 */
function updateLicenseCaseRaw_(licenseId, patch){
  if(!licenseId) return false;
  patch = patch || {};
  patch.updated_at = new Date().toISOString();
  return updateRow_(ssOps_(), 'License_Cases', 'license_id', licenseId, patch);
}
/** 契約書履歴の追記（1案件1書類とは限らない・§6.3）。 */
function appendContractDocument_(licenseId, docType, cloudsignDocId, status, signedAt, fileId, fileHash){
  const versions = readRows_(ssOps_(), 'Contract_Documents')
    .filter(function(d){ return d.license_id === licenseId; });
  const docId = Utilities.getUuid();
  appendRow_(ssOps_(), 'Contract_Documents', {
    contract_document_id: docId, license_id: licenseId,
    document_type: docType || 'ORIGINAL', version: versions.length + 1,
    cloudsign_document_id: cloudsignDocId || '', status: status || 'SIGNED',
    signed_at: signedAt || '', file_id: fileId || '', file_hash: fileHash || '',
    created_at: new Date().toISOString(),
  });
  return docId;
}
