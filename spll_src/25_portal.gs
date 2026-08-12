/** SPLL 25_portal ― GAS① 公開ポータルAPI：原作一覧・申込作成（application_ref発行） */


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

/**
 * 公開ポータルからの申込作成（複数原作）。application_ref を発行し、
 * Applications ＋ Application_Works を登録して application_ref を返す。
 * 突合キーは application_ref（メールハッシュ突合は廃止）。
 */
/**
 * 申込作成（修正設計書v2 P0-03）。params:
 *   { workIds, usageCategory, privacyConsent, termsConsent,
 *     privacyDocumentId, termsDocumentId, consentSessionId, displayHash }
 * サーバー側で同意・文書版・原作・利用目的を検証し、同意証跡を保存。
 * production では公開済み法務文書（PUBLISHED）が無い場合は受付停止。
 */
function web_createApplication(params){
  if(!rateLimit_('createApp', 100, 3600)) throw new Error('現在申込が混み合っています。時間をおいて再度お試しください。');   // §6.4
  params = params || {};
  if(Array.isArray(params)) throw new Error('VALIDATION_ERROR: 旧形式の申込APIは廃止されました（同意情報が必要です）');
  const ids = (params.workIds || []).filter(Boolean).map(String).filter(function(v,i,a){ return a.indexOf(v)===i; });
  const usageCategory = String(params.usageCategory || '');
  if(!ids.length) throw new Error('原作が選択されていません');
  const maxW = formMaxWorks_();
  if(ids.length > maxW) throw new Error('対象原作は最大' + maxW + '件までです（契約書テンプレートの制約）');
  // 同意チェック（サーバー側必須・P0-03）
  if(params.privacyConsent !== true) throw new Error('VALIDATION_ERROR: 個人情報の取扱いへの同意が必要です');
  if(params.termsConsent !== true) throw new Error('VALIDATION_ERROR: 利用規約への同意が必要です');
  // 文書版の照合：公開版がある場合、画面表示時の文書IDと一致しなければ再表示を促す
  const pubP = publishedLegalDoc_('PRIVACY'), pubT = publishedLegalDoc_('TERMS');
  if(isProd_() && (!pubP || !pubT))
    throw new Error('SERVICE_UNAVAILABLE: 現在申込を受け付けられません（規約・個人情報通知の公開版が未設定です）');
  if(pubP && String(params.privacyDocumentId||'') !== String(pubP.legal_document_id))
    throw new Error('VALIDATION_ERROR: 個人情報通知が更新されました。ページを再読み込みして内容をご確認ください。');
  if(pubT && String(params.termsDocumentId||'') !== String(pubT.legal_document_id))
    throw new Error('VALIDATION_ERROR: 利用規約が更新されました。ページを再読み込みして内容をご確認ください。');
  // 原作・利用目的のサーバー検証（§7.1）
  const master = readRows_(ssMaster_(),'Works_Master');
  ids.forEach(function(wid){
    const w = master.find(function(x){ return x.work_id === wid; });
    if(!w) throw new Error('VALIDATION_ERROR: 存在しない原作です: ' + wid);
    if(w.publish_status !== 'PUBLISHED') throw new Error('VALIDATION_ERROR: 公開されていない原作です: ' + wid);
  });
  if(!usageCategory || !feeRuleFor_(usageCategory))
    throw new Error('VALIDATION_ERROR: 利用目的が未選択か、料金表に存在しません: ' + usageCategory);

  const legal = api_getLegalTexts();
  const appId = newId_('APP');
  const ref   = newRef_();
  const termsHash = hash_(String(legal.termsTemplate||''));
  const handoffExpires = addDaysIso_(14);   // フォーム入力の引継ぎ有効期限
  appendRow_(ssOps_(),'Applications',{ application_id:appId, application_ref:ref, usage_category:sanitizeCell_(usageCategory),
    privacy_hash: hash_(String(legal.privacy||'')), terms_hash: termsHash, handoff_expires_at:handoffExpires,
    status:'APPLICATION_CREATED', created_at:new Date().toISOString() });
  ids.forEach(function(wid){ appendRow_(ssOps_(),'Application_Works',{
    application_work_id:newId_('AW'), application_id:appId, work_id:wid }); });
  // 同意証跡（P0-03）：版番号・セッション・表示ハッシュつき
  const sess = sanitizeCell_(String(params.consentSessionId||'').slice(0,64));
  const disp = sanitizeCell_(String(params.displayHash||'').slice(0,128));
  const now = new Date().toISOString();
  [['PRIVACY', legal.privacy, pubP], ['TERMS', legal.termsTemplate, pubT]]
    .forEach(function(x){ appendRow_(ssOps_(),'Application_Consents',{ consent_id:Utilities.getUuid(),
      application_id:appId, document_type:x[0], legal_document_id:(x[2]?x[2].legal_document_id:''),
      legal_document_version:(x[2]?x[2].version:''), content_hash:hash_(String(x[1]||'')),
      display_hash:disp, consent_session_id:sess, accepted:'true', accepted_at:now,
      consented_at:now, consent_method:'PORTAL_CHECKBOX', evidence_version:'v2' }); });
  // 自動送信／手動確認の経路判定（経理設計書 §10.3）
  const route = decideContractRoute_({ usageCategory: usageCategory, workIds: ids,
    isMinor: params.isMinor === true, isOverseas: params.isOverseas === true,
    hasSpecialTerms: params.hasSpecialTerms === true });
  // SPLL番号（license_id）発行＋ライセンス台帳作成（SPLL-SYS-RP-001 原則2/3）
  const partyType = ['INDIVIDUAL','SOLE_PROPRIETOR','CORPORATION'].indexOf(String(params.partyType||'')) >= 0
    ? String(params.partyType) : '';
  const licenseId = createLicenseCase_(appId, ref, usageCategory, ids, partyType);
  updateRow_(ssOps_(),'Applications','application_id',appId,{ status:'FORM_PENDING',
    license_id: licenseId, cloudsign_send_status:'NOT_STARTED',
    manual_review_reason: route.route === 'MANUAL_REVIEW' ? sanitizeCell_(route.reasons.join('、')) : '' });
  logEvent_('license_case', licenseId, 'portal', null,
    { application_ref:ref, works:ids.length, usage_category:usageCategory, route:route.route, reasons:route.reasons, party_type:partyType });
  // 引継ぎ改変検知トークン（フォーム項目設計 §4.1.1）
  const handoff = makeHandoffToken_(appId, ref, ids, usageCategory, termsHash, handoffExpires);
  return { application_id:appId, application_ref:ref, license_id:licenseId,
    handoff_token:handoff, handoff_expires_at:handoffExpires,
    template_route: route.route, route_reasons: route.reasons,
    form_url: partyFormUrl_(partyType, route.route) };
}

/** 契約者区分別フォームURL（フォーム簡素化・RP-001 §8.3/8.4）。未設定は経路別→共通へフォールバック。 */
function partyFormUrl_(partyType, route){
  const byParty = partyType === 'CORPORATION' ? getConfig_('FORM_URL_CORPORATION','')
    : (partyType ? getConfig_('FORM_URL_INDIVIDUAL','') : '');
  return byParty || routeFormUrl_(route);
}

/**
 * 契約経路の判定（経理設計書 §10.3）。
 *   STANDARD_FIXED（定額系）／STANDARD_RATE（売上連動）はCloudSign自動送信、
 *   MANUAL_REVIEW（未成年・海外・その他・特約・上限超過等）は自動送信しない。
 */
function decideContractRoute_(ctx){
  ctx = ctx || {};
  const reasons = [];
  const rule = ctx.usageCategory ? feeRuleFor_(ctx.usageCategory) : null;
  if(!rule) reasons.push('料金表が未設定');
  if(/その他|OTHER/i.test(String(ctx.usageCategory||''))) reasons.push('利用目的がその他');
  const maxW = formMaxWorks_();
  if((ctx.workIds || []).length > maxW) reasons.push('対象原作数が上限超過');
  if(ctx.isMinor) reasons.push('未成年');
  if(ctx.isOverseas) reasons.push('海外居住・海外法人');
  if(ctx.hasSpecialTerms) reasons.push('特約あり');
  // クレジット・原作名がテンプレート上限を超える場合（既定400字）
  if(ctx.workIds && ctx.workIds.length){
    const master = readRows_(ssMaster_(),'Works_Master');
    const creditLen = ctx.workIds.map(function(id){ const w = master.find(function(x){ return x.work_id === id; });
      return (w ? String(w.credit_text||'') + String(w.work_name||'') : ''); }).join('').length;
    if(creditLen > (num_(getConfig_('CS_CREDIT_MAX_CHARS','400')) || 400)) reasons.push('クレジット表記が上限超過');
  }
  const model = rule ? String(rule.fee_model||'').toUpperCase() : '';
  if(rule && ['RATE','FLAT','PER_WORK'].indexOf(model) < 0) reasons.push('利用目的と料金モデルが不整合');
  if(reasons.length) return { route:'MANUAL_REVIEW', reasons:reasons };
  return { route: model === 'RATE' ? 'STANDARD_RATE' : 'STANDARD_FIXED', reasons: [] };
}
/** 経路別フォームURL（§10.11：Configで版管理。未設定は共通URLへフォールバック）。 */
function routeFormUrl_(route){
  return getConfig_('FORM_URL_' + route, '') || prop_('FORMRUN_FORM_URL') || '';
}
