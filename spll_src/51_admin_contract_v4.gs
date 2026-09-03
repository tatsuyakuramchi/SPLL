/** SPLL 51_admin_contract_v4 ― CloudSign FORM v4 法務文書管理 */

/** GUIDELINE下書き保存（後方互換の別名）。本体は admin_saveLegalDraft が3種別を扱う。 */
function admin_saveGuidelineDraft(contentHtml){
  return admin_saveLegalDraft('GUIDELINE', contentHtml);
}

/**
 * v4切替に必要な設定が揃っているかを管理画面から確認。
 *
 * 確認できるのは Config台帳（3プロジェクトが同じスプレッドシートを見る）に置かれた設定だけ。
 * hidden項目マッピング等は ScriptProperties＝プロジェクトごとに別物で、GAS③から
 * GAS①/②のプロパティは読めない。ここでadminのプロパティを見て○×を出すと、
 * 「adminにだけ値がある＝実際は未設定なのに設定済みに見える」という逆に危険な表示になるため、
 * それらは判定せず「どのプロジェクトで設定するか」を返して画面に案内させる。
 */
function admin_getContractV4Status(){
  requireRole_([]);
  const p = publishedLegalDoc_('PRIVACY');
  const g = publishedLegalDoc_('GUIDELINE');
  return {
    privacy_published: !!p,
    guideline_published: !!g,
    form_url_individual: !!(getConfig_('FORM_URL_STANDARD_FIXED','') || getConfig_('FORM_URL_STANDARD_RATE','') ||
                            getConfig_('FORM_URL_INDIVIDUAL','')),
    contract_template_version: CONTRACT_FORM_V4_VERSION,
    // adminからは検証できない設定（各プロジェクトのScriptPropertiesで設定する）
    elsewhere: [
      { key:'FORM_HIDDEN_MAP',    where:'GAS①(portal)',   what:'申込URLへ初期値を載せるhidden項目キー' },
      { key:'FORMRUN_FIELD_MAP',  where:'GAS②(workflow)', what:'Webhookのフィールド名→正規キー' },
      { key:'HANDOFF_SECRET',     where:'GAS①・GAS②',     what:'申込引き継ぎの署名鍵（両者で同じ値）' }
    ]
  };
}
