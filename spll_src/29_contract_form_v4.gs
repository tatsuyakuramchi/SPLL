/** SPLL 29_contract_form_v4 ― CloudSign FORM v4：ガイドライン確認・個別条件スナップショット・FORM引渡 */

const CONTRACT_FORM_V4_VERSION = 'v4.0';
const CONTRACT_FORM_V4_HASH_KEYS = [
  'contract_template_version','license_id','application_ref','usage_category','work_count','work_names',
  'work_id_1','work_title_1','work_id_2','work_title_2','work_id_3','work_title_3',
  'work_id_4','work_title_4','work_id_5','work_title_5',
  'licensor_name','license_term','territory','fee_model','fee_value','fee_amount_or_rate',
  'licensed_uses','payment_terms','reporting_terms','credit_text','special_terms'
];

/** CloudSign FORM v4で利用する公開法務文書。契約本文への同意はCloudSign上で取得するため、ポータルはPRIVACY＋GUIDELINEのみ。 */
function api_getLegalTextsV4(){
  const p = publishedLegalDoc_('PRIVACY');
  const g = publishedLegalDoc_('GUIDELINE');
  return {
    privacy: p ? p.content_html : getConfig_('LEGAL_PRIVACY_TEXT', DEFAULT_PRIVACY),
    guideline: g ? g.content_html : getConfig_('LEGAL_GUIDELINE_TEXT', ''),
    privacy_version: p ? p.version : '', privacy_doc_id: p ? p.legal_document_id : '',
    guideline_version: g ? g.version : '', guideline_doc_id: g ? g.legal_document_id : ''
  };
}

/** 料金・原作条件からCloudSign FORMへ渡す個別条件を生成。ユーザー入力ではなくSPLL側の確定値。 */
function contractFormFieldsV4_(appId, licenseId, ref, usageCategory, workIds){
  const ids = (workIds || []).map(String).filter(Boolean).slice(0, formMaxWorks_());
  const master = readRows_(ssMaster_(),'Works_Master');
  const partners = readRows_(ssOps_(),'Partners');
  const works = ids.map(function(id){
    const w = master.find(function(x){ return String(x.work_id) === id; }) || {};
    let licensor = '';
    if(w.partner_id){
      const p = partners.find(function(x){ return String(x.partner_id) === String(w.partner_id); });
      if(p) licensor = String(p.name || '');
    }
    if(!licensor) licensor = String(w.publisher || '');
    return { id:id, title:String(w.work_name || id), credit:String(w.credit_text || ''), licensor:licensor };
  });
  const terms = computeFeeTerms_(usageCategory, Math.max(1, works.length));
  const licensors = works.map(function(w){ return w.licensor; }).filter(Boolean)
    .filter(function(v,i,a){ return a.indexOf(v) === i; });
  const credits = works.map(function(w){ return w.credit; }).filter(Boolean)
    .filter(function(v,i,a){ return a.indexOf(v) === i; });
  const reportParts = [terms.reporting_requirement, terms.report_due ? ('期限：' + terms.report_due) : ''].filter(Boolean);
  const specialParts = [terms.threshold_or_cap, terms.reprint_rule, terms.special_terms].filter(function(v){ return v && v !== '－'; });
  const feeValue = terms.fee_model === 'RATE' ? terms.rate : terms.amount;
  const out = {
    contract_template_version: CONTRACT_FORM_V4_VERSION,
    license_id: String(licenseId || ''), application_ref: String(ref || ''),
    usage_category: String(usageCategory || ''), work_count: String(works.length),
    work_names: works.map(function(w){ return w.title; }).join('、'),
    licensor_name: licensors.join('、'),
    license_term: getConfig_('LICENSE_TERM_LABEL','契約成立日から1年間（自動更新）'),
    territory: getConfig_('LICENSE_TERRITORY_LABEL','全世界'),
    fee_model: String(terms.fee_model || ''), fee_value: feeValue === null || feeValue === undefined ? '' : String(feeValue),
    fee_amount_or_rate: String(terms.fee_amount_or_rate || ''),
    licensed_uses: String(terms.licensed_uses || ''), payment_terms: String(terms.payment_due || ''),
    reporting_terms: reportParts.join(' ／ '), credit_text: credits.join(' ／ '), special_terms: specialParts.join(' ／ ')
  };
  for(let i=0;i<formMaxWorks_();i++){
    const w = works[i] || {};
    out['work_id_' + (i+1)] = w.id || '';
    out['work_title_' + (i+1)] = w.title || '';
  }
  return out;
}

/** ハッシュ対象を固定順に正規化。terms_snapshot_hash自身は含めない。 */
function contractFormHashV4_(fields){
  fields = fields || {};
  const pairs = CONTRACT_FORM_V4_HASH_KEYS.map(function(k){ return [k, String(fields[k] === undefined || fields[k] === null ? '' : fields[k])]; });
  return hash_(JSON.stringify(pairs));
}

/** Applicationsから同一のFORM個別条件を再構成（管理・締結スナップショット用）。 */
function contractFormFieldsFromApplicationV4_(app){
  if(!app) return {};
  const ids = readRows_(ssOps_(),'Application_Works')
    .filter(function(x){ return String(x.application_id) === String(app.application_id); })
    .map(function(x){ return x.work_id; });
  return contractFormFieldsV4_(app.application_id, app.license_id, app.application_ref, app.usage_category, ids);
}

/** FormRun payloadをcanonical keyへ正規化。FORMRUN_FIELD_MAPは「実フィールド名/ID → canonical key」。 */
function formrunCanonV4_(body){
  body = body || {};
  const map = parseJson_(prop_('FORMRUN_FIELD_MAP'), {});
  const canon = {};
  function put(rawKey, value){
    if(rawKey === undefined || rawKey === null) return;
    const key = map[String(rawKey)] || String(rawKey);
    canon[key] = value;
  }
  (body.columns || []).forEach(function(c){
    put(c.name || c.label || c.id || c.key, c.value);
    if(c.id) put(c.id, c.value);
  });
  Object.keys(body).forEach(function(k){
    if(['columns','data','payload'].indexOf(k) < 0 && typeof body[k] !== 'object') put(k, body[k]);
  });
  if(body.data && typeof body.data === 'object') Object.keys(body.data).forEach(function(k){ put(k, body.data[k]); });
  return canon;
}

/** FormRun受信証跡から、申込時ハッシュと一致する実際の契約個別条件を復元する。 */
function contractFormFieldsFromReceiptV4_(app){
  if(!app || !/^v4:/.test(String(app.terms_hash || ''))) return null;
  const rows = readRows_(ssOps_(),'Webhook_Receipts')
    .filter(function(r){ return r.provider === 'FORMRUN' &&
      (String(r.application_ref || '') === String(app.application_ref || '') || String(r.payload_json || '').indexOf(String(app.application_ref || '')) >= 0); })
    .sort(function(a,b){ return String(b.received_at || '').localeCompare(String(a.received_at || '')); });
  for(let i=0;i<rows.length;i++){
    let raw = String(rows[i].payload_json || '');
    if(raw.charAt(0) === "'" && raw.charAt(1) === '{') raw = raw.slice(1);
    let body = {}; try{ body = JSON.parse(raw); }catch(e){ continue; }
    const canon = formrunCanonV4_(body);
    const fields = {};
    CONTRACT_FORM_V4_HASH_KEYS.forEach(function(k){ fields[k] = canon[k] === undefined || canon[k] === null ? '' : String(canon[k]); });
    if('v4:' + contractFormHashV4_(fields) === String(app.terms_hash || '')) return fields;
  }
  return null;
}

/** v4の自動締結経路。法人・未成年・海外・イベント・その他・特約は個別確認。 */
function decideContractRouteV4_(ctx){
  ctx = ctx || {};
  const reasons = [];
  const rule = ctx.usageCategory ? feeRuleFor_(ctx.usageCategory) : null;
  if(!rule) reasons.push('料金表が未設定');
  if(String(ctx.partyType || '') === 'CORPORATION') reasons.push('法人申込は現行制度の標準契約対象外');
  if(/イベント|EVENT/i.test(String(ctx.usageCategory||''))) reasons.push('イベント利用は制度条件の個別確認が必要');
  if(/その他|OTHER/i.test(String(ctx.usageCategory||''))) reasons.push('利用目的がその他');
  if((ctx.workIds || []).length > formMaxWorks_()) reasons.push('対象原作数が上限超過');
  if(ctx.isMinor) reasons.push('未成年');
  if(ctx.isOverseas) reasons.push('海外居住');
  if(ctx.hasSpecialTerms) reasons.push('特約あり');
  const model = rule ? String(rule.fee_model||'').toUpperCase() : '';
  if(rule && ['RATE','FLAT','PER_WORK'].indexOf(model) < 0) reasons.push('利用目的と料金モデルが不整合');
  if(reasons.length) return { route:'MANUAL_REVIEW', reasons:reasons };
  return { route:model === 'RATE' ? 'STANDARD_RATE' : 'STANDARD_FIXED', reasons:[] };
}

/** MANUAL_REVIEWは標準CloudSign FORMへフォールバックさせない。 */
function partyFormUrlV4_(partyType, route){
  if(route === 'MANUAL_REVIEW') return getConfig_('FORM_URL_MANUAL_REVIEW','');
  return getConfig_('FORM_URL_INDIVIDUAL','') || getConfig_('FORM_URL_' + route,'') || prop_('FORMRUN_FORM_URL') || '';
}

/**
 * CloudSign FORM v4用申込作成。
 * ポータルでの契約同意は取得せず、PRIVACYとGUIDELINEの確認証跡のみを保存する。
 * 契約成立はCloudSign上の同意完了時。
 */
function web_createApplicationV4(params){
  if(!rateLimit_('createAppV4', 100, 3600)) throw new Error('現在申込が混み合っています。時間をおいて再度お試しください。');
  params = params || {};
  const ids = (params.workIds || []).filter(Boolean).map(String).filter(function(v,i,a){ return a.indexOf(v) === i; });
  const usageCategory = String(params.usageCategory || '');
  const partyType = ['INDIVIDUAL','SOLE_PROPRIETOR','CORPORATION'].indexOf(String(params.partyType||'')) >= 0
    ? String(params.partyType) : 'INDIVIDUAL';
  if(!ids.length) throw new Error('原作が選択されていません');
  if(ids.length > formMaxWorks_()) throw new Error('対象原作は最大' + formMaxWorks_() + '件までです');
  if(params.privacyConsent !== true) throw new Error('VALIDATION_ERROR: 個人情報の取扱いへの同意が必要です');
  if(params.guidelineConsent !== true) throw new Error('VALIDATION_ERROR: SPLL二次創作ガイドラインの確認が必要です');

  const pubP = publishedLegalDoc_('PRIVACY');
  const pubG = publishedLegalDoc_('GUIDELINE');
  if(isProd_() && (!pubP || !pubG))
    throw new Error('SERVICE_UNAVAILABLE: CloudSign FORM v4の公開版PRIVACY/GUIDELINEが未設定です');
  if(pubP && String(params.privacyDocumentId||'') !== String(pubP.legal_document_id))
    throw new Error('VALIDATION_ERROR: 個人情報通知が更新されました。再度ご確認ください。');
  if(pubG && String(params.guidelineDocumentId||'') !== String(pubG.legal_document_id))
    throw new Error('VALIDATION_ERROR: SPLL二次創作ガイドラインが更新されました。再度ご確認ください。');

  const master = readRows_(ssMaster_(),'Works_Master');
  ids.forEach(function(wid){
    const w = master.find(function(x){ return String(x.work_id) === wid; });
    if(!w || w.publish_status !== 'PUBLISHED') throw new Error('VALIDATION_ERROR: 利用できない原作です: ' + wid);
  });
  if(!usageCategory || !feeRuleFor_(usageCategory))
    throw new Error('VALIDATION_ERROR: 利用目的が未選択か、料金表に存在しません: ' + usageCategory);

  const appId = newId_('APP');
  const ref = newRef_();
  const handoffExpires = addDaysIso_(14);
  const licenseId = createLicenseCase_(appId, ref, usageCategory, ids, partyType);
  const formFields = contractFormFieldsV4_(appId, licenseId, ref, usageCategory, ids);
  const snapshotHash = 'v4:' + contractFormHashV4_(formFields);
  const legal = api_getLegalTextsV4();
  const guidelineHash = hash_(String(legal.guideline || ''));

  appendRow_(ssOps_(),'Applications',{ application_id:appId, application_ref:ref, usage_category:sanitizeCell_(usageCategory),
    privacy_hash:hash_(String(legal.privacy||'')), terms_hash:snapshotHash, handoff_expires_at:handoffExpires,
    status:'APPLICATION_CREATED', created_at:new Date().toISOString(), license_id:licenseId });
  ids.forEach(function(wid){ appendRow_(ssOps_(),'Application_Works',{
    application_work_id:newId_('AW'), application_id:appId, work_id:wid }); });

  const sess = sanitizeCell_(String(params.consentSessionId||'').slice(0,64));
  const disp = sanitizeCell_(String(params.displayHash||'').slice(0,128));
  const now = new Date().toISOString();
  [['PRIVACY', legal.privacy, pubP], ['GUIDELINE', legal.guideline, pubG]].forEach(function(x){
    appendRow_(ssOps_(),'Application_Consents',{ consent_id:Utilities.getUuid(), application_id:appId,
      document_type:x[0], legal_document_id:(x[2]?x[2].legal_document_id:''), legal_document_version:(x[2]?x[2].version:''),
      content_hash:hash_(String(x[1]||'')), display_hash:disp, consent_session_id:sess, accepted:'true', accepted_at:now,
      consented_at:now, consent_method:'PORTAL_CHECKBOX', evidence_version:'v4' });
  });

  const route = decideContractRouteV4_({ usageCategory:usageCategory, workIds:ids, partyType:partyType,
    isMinor:params.isMinor===true, isOverseas:params.isOverseas===true, hasSpecialTerms:params.hasSpecialTerms===true });
  updateRow_(ssOps_(),'Applications','application_id',appId,{ status:'FORM_PENDING', cloudsign_send_status:'NOT_STARTED',
    manual_review_reason:route.route === 'MANUAL_REVIEW' ? sanitizeCell_(route.reasons.join('、')) : '' });
  logEvent_('license_case', licenseId, 'portal', null,
    { application_ref:ref, form_version:CONTRACT_FORM_V4_VERSION, guideline_hash:guidelineHash,
      terms_snapshot_hash:snapshotHash, route:route.route, reasons:route.reasons });

  const handoff = makeHandoffToken_(appId, ref, ids, usageCategory, snapshotHash, handoffExpires);
  return { application_id:appId, application_ref:ref, license_id:licenseId,
    handoff_token:handoff, handoff_expires_at:handoffExpires, terms_snapshot_hash:snapshotHash,
    template_route:route.route, route_reasons:route.reasons,
    form_url:partyFormUrlV4_(partyType, route.route), form_fields:formFields };
}
