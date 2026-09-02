/**
 * SPLL 44_guide ― 締結後の「今後のお手続き」案内ページ（トークンアクセス）
 *
 * CloudSign締結 → 業務台帳に載った時点で GUIDE トークンを発行し、案内ページのURLを払い出す。
 * ページには、SPLL番号・契約条件の概要・クレジット表記・審査状況・作品提出の導線・認証バッジ（審査完了後）・今後の流れを載せる。
 *
 * 利用許諾料の振込先はここには載せない（RP-002 §9.1）。振込先は契約書本文に記載し、契約書が唯一の正本になる。
 * 案内ページ・メールに口座情報を持たせないので、振込先を騙る偽装メールとの区別がつく（正規の口座は契約書にだけある）。
 */

/**
 * 締結時にGUIDEトークンを発行する。
 * 作品の完成時期は契約者ごとに大きく異なる（数日〜1年以上）ため、案内ページは
 * 「契約期間をカバーする長期の入口」として扱い、短命な提出リンクはここから都度発行する。
 * 既定400日（1年契約＋更新手続きの余裕）。GUIDE_TOKEN_DAYS で変更可能。
 */
function guideTokenDays_(){ return num_(getConfig_('GUIDE_TOKEN_DAYS','400')) || 400; }
function prepareGuideToken_(idOrLicense){
  return issueToken_(idOrLicense, 'GUIDE', guideTokenDays_(), 0);   // 回数制限なし（何度でも開ける）
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
  // 正本はSPLL番号。契約（互換テーブル）は条件スナップショット・締結日の参照に使う
  const ref = tokenLicenseRef_(tok);
  const contractId = ref.contractId, c = ref.contract;
  const kase = ref.licenseId
    ? (readRows_(ssOps_(),'License_Cases').find(function(k){ return k.license_id === ref.licenseId; }) || {}) : {};
  let terms = {}; try{ terms = JSON.parse(c.terms_snapshot || '{}'); }catch(err){}
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return belongsToLicense_(x, ref); });
  const badge = distributableBadgeFor_(ref);   // 認証が ACTIVE のときだけ配布導線を出す
  const subs = readRows_(ssOps_(),'Submissions').filter(function(s){ return belongsToLicense_(s, ref); });

  return {
    guide_expires_at: String(tok.expires_at || '').slice(0,10),
    license_id: ref.licenseId || c.license_id || '',
    case_status: kase.case_status || '', review_status: kase.review_status || '',
    party_name: kase.party_display_name || '',
    usage_category: c.usage_category || '',
    works: contractWorkNames_(contractId),
    // 契約書には具体的な文言を差し込まず「甲が別途指定する権利表記」としているため、
    // クリエーターが公開前に確認できるようここで示す
    credit_texts: contractCreditTexts_(contractId),
    signed_at: String(kase.signed_at || c.signed_at || '').slice(0,10),
    fee_label: String(terms.fee_amount_or_rate || ''),
    payment_terms: String(terms.payment_terms || terms.payment_due || ''),
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
  const ref = tokenLicenseRef_(tok);
  const key = ref.licenseId || tok.contract_id;
  revokeTokens_(key, 'SUBMISSION');
  const st = prepareSubmissionToken_(key);
  logEvent_('license_case', key, 'licensee', null, { submit_link_issued_from:'GUIDE' });
  return { url: userPageUrl_('upload','t',st) };
}
