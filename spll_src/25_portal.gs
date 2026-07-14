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
function web_createApplication(workIds, usageCategory){
  if(!rateLimit_('createApp', 100, 3600)) throw new Error('現在申込が混み合っています。時間をおいて再度お試しください。');   // §6.4 大量生成対策
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
  // 同意証跡（§7.2）：同意時点の文書版・ハッシュを Application_Consents へ記録
  [['PRIVACY', legal.privacy, legal.privacy_doc_id], ['TERMS', legal.termsTemplate, legal.terms_doc_id]]
    .forEach(function(x){ appendRow_(ssOps_(),'Application_Consents',{ consent_id:Utilities.getUuid(),
      application_id:appId, document_type:x[0], legal_document_id:x[2]||'',
      content_hash:hash_(String(x[1]||'')), consented_at:new Date().toISOString(), consent_method:'PORTAL_CHECKBOX' }); });
  updateRow_(ssOps_(),'Applications','application_id',appId,{ status:'FORM_PENDING' });
  logEvent_('application', appId, 'portal', null, { application_ref:ref, works:ids.length, usage_category:usageCategory });
  return { application_id:appId, application_ref:ref };
}
