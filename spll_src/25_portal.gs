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
    maxWorks:  parseInt(prop_('FORM_MAX_WORKS') || '5', 10) || 5,
    officeContact: getConfig_('OFFICE_CONTACT',''),   // ヘッダーの「お問い合わせ」の宛先
    corporate: corporateInquiry_()   // 法人は本窓口の対象外（別ルート＝個別契約）
  };
}

const CORPORATE_INQUIRY_DEFAULT_NOTE =
  '法人によるご利用は、本窓口の標準契約とは別に個別契約でのご対応となります。下記よりお問い合わせください。';
/**
 * 法人向け問い合わせ窓口（CloudSign FORMの対象外）。
 * 本窓口は個人（個人事業主を含む）専用のため、法人は個別契約ルートへ案内する。
 * 受け口はGoogleフォーム・formrun・メールのいずれでもよく、管理コンソールから差し替える。
 */
function corporateInquiry_(){
  return {
    url:   getConfig_('CORPORATE_INQUIRY_URL',''),
    email: getConfig_('CORPORATE_INQUIRY_EMAIL',''),
    note:  getConfig_('CORPORATE_INQUIRY_NOTE','') || CORPORATE_INQUIRY_DEFAULT_NOTE
  };
}

/**
 * 申込作成は CloudSign FORM v4（29_contract_form_v4.gs の web_createApplicationV4）へ一本化した。
 * 旧API web_createApplication と partyFormUrl_ は削除済み（2026-08-13）。
 *   ・旧APIはガイドライン確認・法人の個別契約ルート判定を持たず、直接呼ばれると新方針を迂回できた
 *   ・経路判定は decideContractRouteV4_、フォームURLは partyFormUrlV4_ が正
 */

