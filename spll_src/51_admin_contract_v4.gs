/** SPLL 51_admin_contract_v4 ― CloudSign FORM v4 法務文書管理 */

/** GUIDELINE専用の版管理下書き保存。既存admin_saveLegalDraftのPRIVACY/TERMS互換を壊さない。 */
function admin_saveGuidelineDraft(contentHtml){
  const actor = requireRole_(['LEGAL_ADMIN']);
  const documentType = 'GUIDELINE';
  const rows = readRows_(ssOps_(),'Legal_Documents').filter(function(d){ return d.document_type === documentType; });
  const nextVer = rows.reduce(function(m,d){ return Math.max(m, num_(d.version)); }, 0) + 1;
  const id = Utilities.getUuid();
  appendRow_(ssOps_(),'Legal_Documents',{ legal_document_id:id, document_type:documentType, version:nextVer,
    content_html:String(contentHtml||''), content_hash:hash_(String(contentHtml||'')),
    effective_from:'', effective_to:'', status:'DRAFT', approved_by:'', approved_at:'' });
  logEvent_('legal_document', id, actor.email, null, { document_type:documentType, version:nextVer, status:'DRAFT' });
  return { legal_document_id:id, version:nextVer };
}

/** v4切替に必要な設定が揃っているかを管理画面から確認。 */
function admin_getContractV4Status(){
  requireRole_([]);
  const p = publishedLegalDoc_('PRIVACY');
  const g = publishedLegalDoc_('GUIDELINE');
  return {
    privacy_published: !!p,
    guideline_published: !!g,
    form_url_individual: !!getConfig_('FORM_URL_INDIVIDUAL',''),
    form_hidden_map: !!prop_('FORM_HIDDEN_MAP'),
    formrun_field_map: !!prop_('FORMRUN_FIELD_MAP'),
    handoff_secret: !!handoffSecret_(),
    contract_template_version: CONTRACT_FORM_V4_VERSION
  };
}
