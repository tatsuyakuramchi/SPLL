/**
 * SPLL 13_agreement_state ― 利用許諾契約 v5.0（クリエーター1人1本・契約番号）の台帳と状態（改修計画 P1-4）
 *
 * 利用許諾契約は formrun（CloudSign FORM）→ CloudSign で締結し、締結 Webhook で回収した
 * CloudSign の締結書類を台帳（Agreements）のもとにする（設計書 §10.2）。住所は持たない。
 * 作品ごとの許諾は別紙（License_Cases の1行＝SPLL番号）で、Agreements.agreement_no にひも付く。
 *
 * 状態：ACTIVE（有効）→ TERMINATED（終了）。終了すると、その契約の別紙に基づく許諾もすべて終わる
 * （利用許諾契約書 第12条第3項）。終了の波及は GAS③ の terminateAgreement_（54_admin_agreement）が行う。
 */
const AGREEMENT_STATUSES = ['ACTIVE','TERMINATED'];
/** 契約番号の接頭辞（C-YYYYMM-####） */
const AGREEMENT_NO_PREFIX = 'C';

function agreementByNo_(no){
  return readRows_(ssOps_(),'Agreements').find(function(a){ return a.agreement_no === String(no || ''); }) || null;
}
function agreementByDocument_(documentId){
  if(!documentId) return null;
  return readRows_(ssOps_(),'Agreements').find(function(a){ return a.cloudsign_document_id === String(documentId); }) || null;
}
/** その契約にひも付く別紙（案件） */
function agreementCases_(no){
  return readRows_(ssOps_(),'License_Cases').filter(function(k){ return k.agreement_no === String(no || ''); });
}

/**
 * 締結済みの CloudSign 書類から利用許諾契約を作る。同じ書類からは1つだけ作る（冪等）。
 *   d … { cloudsign_document_id（必須）, party_display_name, contact_email, intake_ref, template_version,
 *         signed_at, signed_pdf_file_id, signed_pdf_hash, partner_list_version }
 * 戻り値：{ agreement_no, created }（created=false は既存を返した）
 * 書類の真正性（CloudSign API での取り直し）と受付番号の検証は呼び出し側（締結処理）が済ませておく。
 */
function createAgreementFromSigned_(d, actor){
  d = d || {};
  const docId = String(d.cloudsign_document_id || '').trim();
  if(!docId) throw new Error('VALIDATION_ERROR: CloudSign の書類IDがありません');
  return withLicenseLock_(function(){
    const existing = agreementByDocument_(docId);
    if(existing) return { agreement_no: existing.agreement_no, created: false };
    const no = newIdUnlocked_(AGREEMENT_NO_PREFIX);   // withLicenseLock_ の中なのでロックを取り直さない
    const now = new Date().toISOString();
    const row = {
      agreement_no: no, status: 'ACTIVE',
      party_display_name: sanitizeCell_(String(d.party_display_name || '').slice(0, 100)),
      contact_email: normalizeEmail_(d.contact_email || ''),
      intake_ref: sanitizeCell_(String(d.intake_ref || '').slice(0, 200)),
      cloudsign_document_id: docId,
      template_version: sanitizeCell_(String(d.template_version || '')),
      signed_at: d.signed_at || now,
      signed_pdf_file_id: String(d.signed_pdf_file_id || ''),
      signed_pdf_hash: String(d.signed_pdf_hash || ''),
      partner_list_version: String(d.partner_list_version || ''),
      terminated_at: '', terminated_reason: '', created_at: now, updated_at: now
    };
    appendRow_(ssOps_(), 'Agreements', row);
    logEvent_('agreement', no, actor || 'system', { status: '' },
      { status: 'ACTIVE', cloudsign_document_id: docId, intake_ref: row.intake_ref, template_version: row.template_version });
    return { agreement_no: no, created: true };
  });
}

/** 有効な利用許諾契約か（専用ページ・別紙の作成で使う） */
function agreementActive_(no){
  const a = agreementByNo_(no);
  return !!a && a.status === 'ACTIVE';
}
