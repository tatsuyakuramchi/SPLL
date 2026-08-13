/**
 * SPLL 44_guide ― 締結後の「今後のお手続き」案内ページ（トークンアクセス）
 *
 * CloudSign締結 → 業務台帳に載った時点で GUIDE トークンを発行し、案内ページのURLを払い出す。
 * ページには、SPLL番号・利用許諾料・振込先・作品提出の導線・認証バッジ（QR）・今後の流れを載せる。
 *
 * 振込先をメール本文へ直接書かず、この1枚に集約する理由：
 *   ・口座変更時に過去の案内と食い違わない（常に最新のConfigを表示）
 *   ・振込先を騙る偽装メールとの区別がつきやすい（正規の導線が1つに定まる）
 *   ・作品提出用フォルダを「必要になった時だけ」開ける（編集リンクの開放期間を短くできる）
 */

/** 振込先（管理コンソール「設定→手続き案内」で編集） */
function paymentInfo_(){
  return {
    bank_name:      getConfig_('PAYMENT_BANK_NAME',''),
    branch:         getConfig_('PAYMENT_BRANCH',''),
    account_type:   getConfig_('PAYMENT_ACCOUNT_TYPE',''),
    account_number: getConfig_('PAYMENT_ACCOUNT_NUMBER',''),
    account_holder: getConfig_('PAYMENT_ACCOUNT_HOLDER',''),
    holder_kana:    getConfig_('PAYMENT_HOLDER_KANA',''),
    note:           getConfig_('PAYMENT_NOTE',''),
    contact:        getConfig_('OFFICE_CONTACT','')
  };
}
/** 振込先が1つでも入力されているか（未設定なら案内ページに枠を出さない） */
function paymentConfigured_(){
  const p = paymentInfo_();
  return !!(p.bank_name || p.account_number || p.account_holder);
}

/** 締結時にGUIDEトークンを発行して案内URLを返す（冪等：既存があれば作り直さない） */
function prepareGuideToken_(contractId){
  return issueToken_(contractId, 'GUIDE', 400, 200);   // 契約期間中は開ける想定（長期・多数回）
}

function serveGuide_(e){
  const t = HtmlService.createTemplateFromFile('guide');
  t.token = (e.parameter && (e.parameter.t || e.parameter.token)) || '';
  return t.evaluate().setTitle('SPLL 今後のお手続き');
}

/** 案内ページの表示内容（GUIDEトークン） */
function web_getGuideContext(token){
  const tok = resolveToken_(token, 'GUIDE');
  if(!tok) throw new Error('案内リンクが無効か、有効期限が切れています。事務局へお問い合わせください。');
  const contractId = tok.contract_id;
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; }) || {};
  const kase = c.license_id
    ? (readRows_(ssOps_(),'License_Cases').find(function(k){ return k.license_id === c.license_id; }) || {}) : {};
  let terms = {}; try{ terms = JSON.parse(c.terms_snapshot || '{}'); }catch(err){}
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  const badge = readRows_(ssOps_(),'Badges').find(function(b){ return b.contract_id === contractId && String(b.status) === 'ISSUED'; });
  const subs = readRows_(ssOps_(),'Submissions').filter(function(s){ return s.contract_id === contractId; });

  return {
    license_id: c.license_id || '',
    party_name: kase.party_display_name || '',
    usage_category: c.usage_category || '',
    works: contractWorkNames_(contractId),
    signed_at: String(c.signed_at || '').slice(0,10),
    fee_label: String(terms.fee_amount_or_rate || ''),
    payment_terms: String(terms.payment_terms || terms.payment_due || ''),
    payment: paymentConfigured_() ? paymentInfo_() : null,
    cert_id: cert ? cert.cert_id : '',
    cert_status: cert ? cert.status : 'NONE',
    badge_url: badge ? userPageUrl_('badge','token',token) : '',   // バッジPNGに検証QRが焼き込まれている
    verify_url: workflowUrl_() + '?page=verify',
    submitted_count: subs.length,
    office_contact: getConfig_('OFFICE_CONTACT','')
  };
}

/**
 * 案内ページから作品提出ページへ進む。押されたときにSUBMISSIONトークンを発行する
 * （締結時から提出用リンクを開けっ放しにしない）。旧トークンは失効させる。
 */
function web_getSubmitLinkFromGuide(token){
  const tok = resolveToken_(token, 'GUIDE');
  if(!tok) throw new Error('案内リンクが無効か、有効期限が切れています。');
  if(!rateLimit_('guideSubmit:' + tok.token_id, 20, 3600))
    throw new Error('操作回数が上限に達しました。時間をおいて再度お試しください。');
  revokeTokens_(tok.contract_id, 'SUBMISSION');
  const st = prepareSubmissionToken_(tok.contract_id);
  logEvent_('contract', tok.contract_id, 'licensee', null, { submit_link_issued_from:'GUIDE' });
  return { url: userPageUrl_('upload','t',st) };
}
