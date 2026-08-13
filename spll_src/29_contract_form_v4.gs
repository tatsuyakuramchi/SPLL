/** SPLL 29_contract_form_v4 ― CloudSign FORM v4 ポータル：法務文書・申込作成・FORM引渡 */

/** CloudSign FORM v4で利用する公開法務文書。契約本文への同意はCloudSign上で取得するため、ポータルはPRIVACY＋GUIDELINEのみ。 */
function api_getLegalTextsV4(){
  const p = publishedLegalDoc_('PRIVACY');
  const g = publishedLegalDoc_('GUIDELINE');
  return {
    privacy: p ? p.content_html : getConfig_('LEGAL_PRIVACY_TEXT', DEFAULT_PRIVACY),
    guideline: g ? g.content_html : getConfig_('LEGAL_GUIDELINE_TEXT', DEFAULT_GUIDELINE),
    privacy_version: p ? p.version : '', privacy_doc_id: p ? p.legal_document_id : '',
    guideline_version: g ? g.version : '', guideline_doc_id: g ? g.legal_document_id : ''
  };
}

/**
 * MANUAL_REVIEWは標準CloudSign FORMへフォールバックさせない。
 * 経路別URL（FORM_URL_STANDARD_FIXED / _STANDARD_RATE）を最優先する：定額と売上連動で
 * CloudSignテンプレートが異なるため、個人共通URLで上書きすると誤ったテンプレートが送付される。
 * partyType は現行制度では個人のみ標準対象（法人はdecideContractRouteV4_でMANUAL_REVIEW）。
 */
function partyFormUrlV4_(partyType, route){
  if(route === 'MANUAL_REVIEW') return getConfig_('FORM_URL_MANUAL_REVIEW','');
  return getConfig_('FORM_URL_' + route,'') || getConfig_('FORM_URL_INDIVIDUAL','') || prop_('FORMRUN_FORM_URL') || '';
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
  // 本窓口は個人専用（利用許諾契約書v4.1 第3条1(1)・同条4）。法人は個別契約ルートへ退避させる。
  if(partyType === 'CORPORATION'){
    const inq = corporateInquiry_();
    throw new Error('CORPORATE_INQUIRY_REQUIRED: ' + inq.note +
      (inq.url ? '（' + inq.url + '）' : (inq.email ? '（' + inq.email + '）' : '')));
  }
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
