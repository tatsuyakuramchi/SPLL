/** SPLL 51_admin_contract_v4 ― CloudSign FORM v4 法務文書管理 */

/** GUIDELINE下書き保存（後方互換の別名）。本体は admin_saveLegalDraft が3種別を扱う。 */
function admin_saveGuidelineDraft(contentHtml){
  return admin_saveLegalDraft('GUIDELINE', contentHtml);
}

/** v4切替に必要な設定が揃っているかを管理画面から確認。 */
function admin_getContractV4Status(){
  requireRole_([]);
  const p = publishedLegalDoc_('PRIVACY');
  const g = publishedLegalDoc_('GUIDELINE');
  return {
    privacy_published: !!p,
    guideline_published: !!g,
    form_url_individual: !!(getConfig_('FORM_URL_INDIVIDUAL','') || prop_('FORMRUN_FORM_URL')),
    form_hidden_map: !!prop_('FORM_HIDDEN_MAP'),
    formrun_field_map: !!prop_('FORMRUN_FIELD_MAP'),
    handoff_secret: !!handoffSecret_(),
    contract_template_version: CONTRACT_FORM_V4_VERSION
  };
}
