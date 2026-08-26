/** SPLL 32_contract ― 契約成立処理：スナップショット・認証・バッジ・締結PDF（GAS②/③共用） */


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

/** 原作→権利者の解決（partner_id優先→出版社名の部分一致→未割当）。契約時スナップショットで使用。 */
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
 * Application_Works → Contract_Works へスナップショット（既にあれば追加しない）。
 * 締結時点の作品名・権利者・クレジット等も固定保存（修正設計書 FLOW-02/§8.3）：
 * 契約後に原作マスタが変更されても、契約時点の条件を復元できる。
 */
function snapshotContractWorks_(contractId, applicationId){
  const already = readRows_(ssOps_(),'Contract_Works').some(function(x){ return x.contract_id === contractId; });
  if(already) return;
  const master = {}; readRows_(ssMaster_(),'Works_Master').forEach(function(w){ master[w.work_id] = w; });
  const partners = readRows_(ssOps_(),'Partners');
  const scheme = String(getConfig_('DEFAULT_ALLOCATION_SCHEME','BY_WORK_EQUAL')).toUpperCase();
  const handling = getConfig_('HANDLING_FEE_RATE','0.30');
  readRows_(ssOps_(),'Application_Works').filter(function(x){ return x.application_id === applicationId; })
    .forEach(function(x){
      const w = master[x.work_id] || {};
      const p = resolveWorkPartner_(w, partners);   // 権利者は契約時点で確定（V2-011）
      appendRow_(ssOps_(),'Contract_Works',{ contract_work_id:newId_('CW'), contract_id:contractId, work_id:x.work_id,
        work_name_snapshot:sanitizeCell_(w.work_name||''), publisher_snapshot:sanitizeCell_(w.publisher||''),
        credit_snapshot:sanitizeCell_(w.credit_text||''), partner_id_snapshot:p.partner_id||'',
        partner_name_snapshot:sanitizeCell_(p.name||''), invoice_reg_number_snapshot:p.invoice_reg_number||'',
        allocation_scheme_snapshot:scheme, royalty_rate_snapshot:(w.royalty_rate!==undefined?w.royalty_rate:''),
        handling_fee_rate_snapshot:handling });
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

/**
 * 契約成立後処理（RP-001 §13.1で分解）：
 *   License活性化（認証・バッジ・提出）と経理向け引渡データ作成のみを行う。
 *   請求・入金・清算は本システムの対象外（経理側の独自運用が引渡データを参照する）。
 */
function finishContractLinkage_(contractId){
  finishLicenseActivation_(contractId);
  createFinanceHandoff_(contractId);
}
/** License活性化：認証・バッジ・提出トークン・案内。 */
function finishLicenseActivation_(contractId){
  const cert = issueCert_(contractId);   // 平文コードはここでのみ取得可能（バッジQRへ焼き込む）
  if(prop_('BADGE_AUTO') !== 'false'){ enqueueBadgeJob_(contractId, cert && cert.verify_url); }   // 失敗時はBadge_Jobsで再実行（V2-014-8）
  prepareSubmissionToken_(contractId);
  // 締結直後に「今後のお手続き」案内ページのURLを払い出す（振込先・提出導線・バッジをまとめた1枚）
  const guideToken = prepareGuideToken_(contractId);
  enqueueNotification_(contractId, 'GUIDE_READY', contractId,
    { guide_url: userPageUrl_('guide','t',guideToken),
      note:'締結完了。この案内ページURLを契約者へお伝えください（振込先・作品提出・認証バッジを含みます）' });
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; });
  if(c && c.license_id) updateLicenseCase_(c.license_id, { certification_status:'ACTIVE', review_status:'PENDING' });
}
/**
 * 経理向け引渡データの作成（RP-001 §10）。締結内容のスナップショットを
 * Finance_Handoffs（READY）へ置くだけ。取込・請求は経理側の独自運用で行う。
 * 冪等キー：license_id + handoff_version。
 */
/**
 * 経理引渡の請求条件を正規化する。terms_snapshot は契約書テンプレート版で構造が異なる
 * （v4: fee_value ／ 旧: rate・amount）ため、経理側が単一の形で読めるよう揃える。
 *   fee_model / rate（RATEのみ）/ amount（FLAT等のみ・税抜）/ fee_amount_or_rate（表示文言）
 * 元のスナップショットは source_terms として保持し、契約書との突合に使えるようにする。
 */
function billingTerms_(termsSnapshotJson){
  let t = {}; try{ t = JSON.parse(termsSnapshotJson || '{}') || {}; }catch(e){ t = {}; }
  const model = String(t.fee_model || '').toUpperCase();
  let rate = (t.rate === undefined || t.rate === null || t.rate === '') ? null : num_(t.rate);
  let amount = (t.amount === undefined || t.amount === null || t.amount === '') ? null : num_(t.amount);
  if(t.fee_value !== undefined && t.fee_value !== null && String(t.fee_value) !== ''){
    if(model === 'RATE' && rate === null) rate = num_(t.fee_value);
    if(model !== 'RATE' && amount === null) amount = num_(t.fee_value);
  }
  return { fee_model: model, rate: rate, amount: amount,
    fee_amount_or_rate: String(t.fee_amount_or_rate || ''),
    payment_terms: String(t.payment_terms || t.payment_due || ''),
    reporting_terms: String(t.reporting_terms || t.reporting_requirement || ''),
    contract_template_version: String(t.contract_template_version || ''),
    terms_snapshot_hash: String(t.terms_snapshot_hash || ''),
    source_terms: t };
}
function createFinanceHandoff_(contractId){
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; });
  if(!c) return null;
  const licenseId = c.license_id || '';
  if(!licenseId){ logEvent_('finance_handoff', contractId, 'system', null, { skipped:'license_id無し（旧データ）' }); return null; }
  const version = readRows_(ssOps_(),'Finance_Handoffs')
    .filter(function(h){ return h.license_id === licenseId; }).length + 1;
  const works = readRows_(ssOps_(),'Contract_Works')
    .filter(function(w){ return w.contract_id === contractId; })
    .map(function(w){ return { work_id:w.work_id, work_name:w.work_name_snapshot, partner_id:w.partner_id_snapshot,
      royalty_rate:w.royalty_rate_snapshot, allocation_scheme:w.allocation_scheme_snapshot }; });
  const kase = readRows_(ssOps_(),'License_Cases').find(function(x){ return x.license_id === licenseId; }) || {};
  const handoffId = Utilities.getUuid();
  appendRow_(ssOps_(),'Finance_Handoffs',{
    handoff_id: handoffId, license_id: licenseId, handoff_version: version,
    signed_at: c.signed_at || '', party_display_name: kase.party_display_name || '',
    usage_category: c.usage_category || '', works_snapshot_json: JSON.stringify(works),
    billing_terms_json: JSON.stringify(billingTerms_(c.terms_snapshot)), contract_status: 'ACTIVE',
    status: 'READY', created_at: new Date().toISOString(), accepted_at: '',
  });
  updateLicenseCase_(licenseId, { finance_handoff_status:'READY' });
  logEvent_('finance_handoff', handoffId, 'system', null, { license_id:licenseId, version:version, contract_id:contractId });
  return handoffId;
}
/** メールアドレスの正規化・妥当性検査（不正値は空を返す＝台帳に汚れを入れない） */
function normalizeEmail_(v){
  const m = String(v == null ? '' : v).trim().replace(/^<|>$/g, '');
  if(!/^[^@\s"'<>]+@[^@\s"'<>]+\.[^@\s"'<>]+$/.test(m)) return '';
  return m.slice(0, 254);
}

/**
 * 契約者の連絡先メールを確定して台帳へ保存する（RP-001：案内・通知の宛先）。
 * 優先順位：
 *   1. CLOUDSIGN … CloudSign書類APIのparticipants＝実際に契約書が届いた宛先（最も確実）
 *   2. FORM      … 申込フォームの入力値（License_Casesへ暫定保存済みのもの）
 * 締結Webhookのpayload.emailは送信側アカウントを指すため採用しない。
 */
function captureContactEmail_(contractId, verifiedDoc, app){
  let email = '', source = '';
  try{ email = normalizeEmail_(cs_recipientEmail_(verifiedDoc)); }catch(e){ email = ''; }
  if(email){ source = 'CLOUDSIGN'; }
  else if(app && app.license_id){
    const kase = readRows_(ssOps_(),'License_Cases').find(function(k){ return k.license_id === app.license_id; });
    email = normalizeEmail_(kase && kase.contact_email);
    if(email) source = 'FORM';
  }
  if(!email){
    logEvent_('contract', contractId, 'system', null, { contact_email:'（取得できず）' });
    return '';
  }
  updateRow_(ssOps_(),'Contracts','contract_id',contractId,
    { contact_email: sanitizeCell_(email), contact_email_source: source });
  if(app && app.license_id) updateLicenseCase_(app.license_id, { contact_email: sanitizeCell_(email) });
  // 監査ログにはドメインのみ残す（本文へアドレスを平文で積み上げない）
  logEvent_('contract', contractId, 'system', null,
    { contact_email_source: source, contact_email_domain: email.split('@')[1] || '' });
  return email;
}

/** 締結情報をライセンス台帳へ同期（契約書履歴の追記含む）。webhook／手動紐付けの両方から使用。 */
function syncLicenseOnSigning_(contractId, licenseId, caseStatus){
  if(!licenseId) return false;
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; }) || {};
  updateLicenseCase_(licenseId, {
    case_status: caseStatus || 'SIGNED', contract_status: 'SIGNED',
    cloudsign_document_id: c.cloudsign_document_id || '', signed_at: c.signed_at || '',
    signed_pdf_file_id: c.contract_file_id || '', signed_pdf_hash: c.contract_file_hash || '' });
  appendContractDocument_(licenseId, 'ORIGINAL', c.cloudsign_document_id || '', 'SIGNED',
    c.signed_at || '', c.contract_file_id || '', c.contract_file_hash || '');
  return true;
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
  // 表示・クレジットは契約時スナップショットから生成（V2-014-1）
  const cws = readRows_(ssOps_(),'Contract_Works').filter(function(x){ return x.contract_id === contractId; });
  const names = cws.map(function(x){ return x.work_name_snapshot || x.work_id; });
  const credits = cws.map(function(x){ return x.credit_snapshot; }).filter(Boolean)
    .filter(function(v,i,a){ return a.indexOf(v)===i; });
  const w = { work_name: names.join('、'), credit_text: credits.join(' ／ '), verify_url: verifyUrl || '' };
  const badgeId  = newId_('BDG');
  const issuedAt = new Date().toISOString().slice(0,10);

  const presId = buildBadgeSlide_(badgeId, w, c, issuedAt);
  const folder = badgeFolder_(c);
  const files = BADGE_SIZES.map(function(s){
    const blob = slideThumbnailPng_(presId, s.size).setName('SPLL_badge_' + badgeId + '_' + s.key + '.png');
    const f = folder.createFile(blob);   // 共有設定はしない（トークン検証後にGASが配信・V2-014-3/4）
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
    t = slide.insertTextBox('検証: ' + w.verify_url, 36, 330, 500, 30);
    t.getText().getTextStyle().setForegroundColor('#A99FC4').setFontSize(9);
    try{ const qr = fetchQrPng_(w.verify_url); if(qr) slide.insertImage(qr, 560, 260, 110, 110); }
    catch(e){ logError_('EXTERNAL_API_ERROR','badgeQr', e); }   // QR取得失敗でも発行は継続
  }
  pres.saveAndClose();
  return pres.getId();
}
/** 検証URLのQRコードPNGを取得（V2-014-2）。既定は quickchart.io（QR_API_URLで変更可）。 */
function fetchQrPng_(url){
  const api = prop_('QR_API_URL') || 'https://quickchart.io/qr?size=220&text=';
  const res = UrlFetchApp.fetch(api + encodeURIComponent(url), { muteHttpExceptions:true });
  if(res.getResponseCode() >= 300) return null;
  return res.getBlob();
}

// ---- バッジ発行ジョブ（V2-014-8）：失敗時に再実行可能 ----
function enqueueBadgeJob_(contractId, verifyUrl){
  const jobId = Utilities.getUuid();
  appendRow_(ssOps_(),'Badge_Jobs',{ badge_job_id:jobId, contract_id:contractId, status:'QUEUED',
    retry_count:0, last_error:'', created_at:new Date().toISOString(), finished_at:'' });
  try{ runBadgeJob_(jobId, verifyUrl); }catch(e){ /* バッチ再試行に委ねる */ }
  return jobId;
}
function runBadgeJob_(jobId, verifyUrl){
  const job = readRows_(ssOps_(),'Badge_Jobs').find(function(j){ return j.badge_job_id === jobId; });
  if(!job || job.status === 'ISSUED') return;
  updateRow_(ssOps_(),'Badge_Jobs','badge_job_id',jobId,{ status:'GENERATING' });
  try{
    issueBadge_(job.contract_id, verifyUrl);
    updateRow_(ssOps_(),'Badge_Jobs','badge_job_id',jobId,{ status:'ISSUED', finished_at:new Date().toISOString(), last_error:'' });
  }catch(err){
    const retry = num_(job.retry_count) + 1;
    updateRow_(ssOps_(),'Badge_Jobs','badge_job_id',jobId,
      { status:(retry >= 3 ? 'ERROR' : 'RETRY_WAIT'), retry_count:retry, last_error:String(err && err.message || err).slice(0,300) });
    throw err;
  }
}
/** RETRY_WAITのバッジジョブ再実行（5分バッチから） */
function retryBadgeJobs_(){
  const jobs = readRows_(ssOps_(),'Badge_Jobs').filter(function(j){ return j.status === 'RETRY_WAIT'; });
  let done = 0;
  jobs.forEach(function(j){ try{ runBadgeJob_(j.badge_job_id); done++; }catch(e){} });
  return { processed:jobs.length, completed:done };
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

/**
 * 当社からメールは送らない。バッジ取得URLは提出ページ（web_getSubmitContext）に表示され、
 * 用途別トークン（BADGE_DOWNLOAD・期限/回数付き）で配布する（修正設計書 §13.4）。
 */
function distributeBadge_(c, badgeId){
  const token = issueToken_(c.contract_id, 'BADGE_DOWNLOAD', 90, 20);
  return userPageUrl_('badge','token',token);   // 利用時のみ使用（メール送信はしない）
}

// ============================================================
// 13. 認証（証明書）・検証ポータル・失効制御（案③）
//     締結で「有効」→ 台帳連動で後から失効可能。検証は固定ポータル＋ID照会。
//     配布は当社メールを使わず、クリエーターは「受付番号」でポータルからバッジ取得。
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
