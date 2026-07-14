/** SPLL 05_schema ― スキーマ・セットアップ（setup_* はGAS③管理プロジェクトからのみ実行） */


/** 初期管理者の登録（修正設計書 §4.3：公開URLからのbootstrapは廃止。GASエディタから1回実行） */
function setup_setInitialAdmin(email, role){
  if(readRows_(ssOps_(),'Admin_Users').length > 0) requireRole_(['SYSTEM_ADMIN']);   // 2人目以降は権限必須
  if(!email) throw new Error('メールアドレスを指定してください（例: setup_setInitialAdmin("you@example.com","SYSTEM_ADMIN")）');
  role = role || 'SYSTEM_ADMIN';
  if(ADMIN_ROLES.indexOf(role) < 0) throw new Error('不正なロール: ' + role);
  appendRow_(ssOps_(),'Admin_Users',{ admin_user_id:Utilities.getUuid(), email:String(email).toLowerCase(),
    role:role, status:'ACTIVE', added_by:'setup', added_at:new Date().toISOString() });
  logEvent_('admin_user', email, 'setup', null, { role:role });
  return true;
}

// ============================================================
// 10. セットアップ / インストーラ（Apps Scriptエディタから1回 Run）
//     スプレッドシート（SS_MASTER/SS_OPS）・Drive親フォルダを自動作成し、
//     各IDを ScriptProperties へ登録、既定設定とサンプルを投入する。冪等。
// ============================================================
const SCHEMA_MASTER = {
  Works_Master:    ['work_id','work_name','publisher','category','publish_status','review_timing','review_policy','fee_label','media','ok_elements','no_elements','credit_text','allocation_scheme_id','royalty_rate','partner_id','billing_type'],
  Review_Rules:    ['rule_id','work_id','category','rule_text','severity','effective_from','effective_to'],
  Reference_Assets:['asset_id','work_id','asset_type','drive_file_id','allowed_flag'],
  // 利用料条件（別紙2）の一律ルール。利用目的(usage_category)ごとに計算方式を持つ（事務局が編集）。
  //   fee_model: RATE=売上連動 / FLAT=定額(契約単位) / PER_WORK=原作数比例
  //   fee_value: RATEは率(0.10=10%)、FLAT/PER_WORKは金額(円)
  Fee_Schedule:    ['usage_category','fee_model','fee_value','fee_label','licensed_uses','payment_due','reporting_requirement','report_due','threshold_or_cap','reprint_rule','special_terms','active']
};
const SCHEMA_OPS = {
  // 申込：複数原作は中間テーブル Application_Works で管理（B経路固定・A/B分岐なし）
  //   usage_category：利用目的（別紙2の料金計算キー）／privacy_hash・terms_hash：同意時文書ハッシュ（§7.2）
  Applications:         ['application_id','application_ref','usage_category','privacy_hash','terms_hash','status','created_at'],
  Application_Works:    ['application_work_id','application_id','work_id'],
  // 契約：締結時に対象原作を Contract_Works へスナップショット（法務証跡）
  //   link_status: LINKED（申込突合済）/ UNLINKED（未突合＝手動紐付け待ち）
  //   contract_file_id/hash：締結済原本PDF（FUN-04）
  Contracts:            ['contract_id','cloudsign_document_id','cloudsign_title','application_id','application_ref','usage_category','terms_snapshot','status','link_status','signed_at','contract_file_id','contract_file_hash','folder_id'],
  Contract_Works:       ['contract_work_id','contract_id','work_id','work_name_snapshot','publisher_snapshot','credit_snapshot','partner_id_snapshot'],
  // 用途別アクセストークン（SEC-06/§9.1）：SUBMISSION / REPORT / BADGE_DOWNLOAD
  Access_Tokens:        ['token_id','contract_id','purpose','token_hash','status','expires_at','max_uses','used_count','last_used_at','issued_at','revoked_at'],
  Submissions:          ['submission_id','contract_id','title','status','submitted_at'],
  Submission_Versions:  ['version_id','submission_id','version_no','status','submitted_at'],
  Submission_Files:     ['submission_file_id','version_id','drive_file_id','mime_type','size','sha256','original_filename','magic_valid'],
  AI_Review_Jobs:       ['ai_review_id','submission_id','version_id','model','prompt_version','status','retry_count','overall_result','risk_score','human_review_required','response_file_id','started_at','completed_at','last_error'],
  AI_Findings:          ['finding_id','ai_review_id','work_id','rule_id','severity','result','page','evidence','confidence'],
  Human_Reviews:        ['human_review_id','submission_id','version_id','reviewer','result','comments','reviewed_at'],
  Compliance_Alerts:    ['alert_id','contract_id','submission_id','severity','status','settlement_block'],
  // 利用報告（FUN-01/§11.1）：SUBMITTED→RETURNED/APPROVED→LOCKED（→SUPERSEDED）
  Usage_Reports:        ['report_id','contract_id','period','channel','qty','gross_sales','returns','deductions','net_sales','sales_url','status','submitted_at','approved_by','approved_at','locked_at','returned_reason'],
  // 請求（FUN-02）：source_type=CONTRACT（FLAT/PER_WORK締結時）/ REPORT（RATE報告承認後）
  Invoices:             ['invoice_id','contract_id','period','source_type','source_id','amount_rule','amount','tax_rate','tax_amount','total_amount','due_date','status','issued_at','void_reason'],
  Payments:             ['payment_id','invoice_id','contract_id','amount','paid_at','method','status','recorded_by','void_reason'],
  Settlements:          ['settlement_id','partner_id','period','amount','status','hold_reason'],
  // 清算明細（FLOW-04/§12.2）：原作・権利者・配分方式・比率を明示
  Settlement_Details:   ['settlement_detail_id','settlement_id','contract_id','work_id','partner_id','allocation_scheme','allocation_ratio','rate_snapshot','amount'],
  // 清算ステータスは CONFIRMED を使わず OBJECTION_PERIOD→NO_OBJECTION_RECORDED→FINALIZED
  Settlement_Statements:['statement_id','settlement_id','partner_id','period','type','reg_number_snapshot','status','effective_date','objection_due','pdf_file_id','sheet_id','version','sent_at','finalized_at'],
  Partners:             ['partner_id','name','invoice_reg_number','is_qualified_issuer','bank','contact'],
  Badges:               ['badge_id','contract_id','issued_at','png_l','png_m','png_s','token_hash','status'],
  // 認証：状態＋変更理由・承認記録
  Certificates:         ['cert_id','contract_id','status','reason_code','reason_text','requested_by','approved_by','legal_case_id','effective_at','check_code_hash','issued_at'],
  Events:               ['event_id','entity_type','entity_id','actor','before','after','occurred_at'],
  Config:               ['config_key','value','environment','updated_at'],
  // ---- 修正設計書 §15.1 追加テーブル ----
  Admin_Users:          ['admin_user_id','email','role','status','added_by','added_at'],
  Webhook_Receipts:     ['receipt_id','provider','external_event_id','payload_hash','payload_json','signature_valid','received_at','status','retry_count','last_error','processed_at'],
  System_Errors:        ['error_id','error_code','source','message','detail','occurred_at','status'],
  Batch_Runs:           ['batch_run_id','batch_name','started_at','finished_at','processed','errors','status','detail'],
  X_Posts:              ['x_post_id','work_id','tweet_id','text','posted_by','posted_at'],
  // 規約・同意文の版管理（§7.2）：DRAFT→PUBLISHED→RETIRED
  Legal_Documents:      ['legal_document_id','document_type','version','content_html','content_hash','effective_from','effective_to','status','approved_by','approved_at'],
  Application_Consents: ['consent_id','application_id','document_type','legal_document_id','content_hash','consented_at','consent_method'],
  // 通知キュー（§10）：メール非保持方針下の「誰に何を通知すべきか」の記録
  Notification_Queue:   ['notification_id','contract_id','type','reference_id','payload_json','status','created_at','sent_at','handled_by']
};

const SAMPLE_WORKS_SEED = [
  {work_id:'WRK-ARK00045', work_name:'光砕のリヴァルチャー', publisher:'どらこにあん／アークライト', category:'TRPG / ルールブック', publish_status:'PUBLISHED', review_policy:'PATROL_ONLY（契約後審査）', fee_label:'書籍：16,500円／作品', media:'書籍,電子書籍,商品販売', ok_elements:'世界観設定,シナリオ,キャラクター名称', no_elements:'公式イラスト流用', credit_text:'指定の権利表記を記載', allocation_scheme_id:'', royalty_rate:'', partner_id:'PRT-DRACO'},
  {work_id:'WRK-ARK00012', work_name:'新クトゥルフ神話TRPG', publisher:'アークライト／KADOKAWA', category:'TRPG / ルールブック', publish_status:'PUBLISHED', review_policy:'PATROL_ONLY（契約後審査）', fee_label:'電子書籍：売上の10％', media:'書籍,電子書籍,商品販売', ok_elements:'世界観・神話設定,シナリオ', no_elements:'公式イラスト流用,ルールデータ転載', credit_text:'指定のシリーズ権利表記を記載', allocation_scheme_id:'', royalty_rate:'0.10', partner_id:'PRT-ARK'},
  {work_id:'WRK-BKK00019', work_name:'インセイン', publisher:'冒険企画局', category:'TRPG / ルールブック', publish_status:'DRAFT', review_policy:'PATROL_ONLY（契約後審査）', fee_label:'電子書籍：売上の10％', media:'電子書籍', ok_elements:'世界観設定,ハンドアウト形式', no_elements:'シナリオデータ転載', credit_text:'指定の権利表記を記載', allocation_scheme_id:'', royalty_rate:'0.10', partner_id:''}
];
const SAMPLE_PARTNERS_SEED = [
  {partner_id:'PRT-DRACO', name:'どらこにあん', invoice_reg_number:'T0000000000000', is_qualified_issuer:'true', bank:'', contact:''},
  {partner_id:'PRT-ARK',   name:'アークライト', invoice_reg_number:'T0000000000000', is_qualified_issuer:'true', bank:'', contact:''}
];
// 利用料条件（別紙2）の一律ルール初期値。金額・率・文言は事務局が設定画面で編集可能なプレースホルダ。
const SAMPLE_FEE_SCHEDULE_SEED = [
  {usage_category:'書籍', fee_model:'PER_WORK', fee_value:'16500', fee_label:'16,500円／原作',
   licensed_uses:'複製・頒布', payment_due:'契約締結後の請求書発行日から30日以内', reporting_requirement:'定額のため利用報告は原則不要',
   report_due:'－', threshold_or_cap:'－', reprint_rule:'増刷時も追加料金なし（要お申し出）', special_terms:'', active:'true'},
  {usage_category:'電子出版物', fee_model:'RATE', fee_value:'0.10', fee_label:'売上の10％',
   licensed_uses:'複製・公衆送信', payment_due:'半期ごとの計算書発効後', reporting_requirement:'半期ごとに販売実績を報告',
   report_due:'各半期終了後1ヶ月以内', threshold_or_cap:'－', reprint_rule:'－', special_terms:'', active:'true'},
  {usage_category:'商品販売', fee_model:'PER_WORK', fee_value:'16500', fee_label:'16,500円／原作',
   licensed_uses:'複製・頒布・販売', payment_due:'契約締結後の請求書発行日から30日以内', reporting_requirement:'定額のため利用報告は原則不要',
   report_due:'－', threshold_or_cap:'頒布数の上限は設けない', reprint_rule:'追加製造も追加料金なし（要お申し出）', special_terms:'', active:'true'},
  {usage_category:'サブスクリプション', fee_model:'RATE', fee_value:'0.10', fee_label:'売上の10％',
   licensed_uses:'公衆送信（継続的提供）', payment_due:'半期ごとの計算書発効後', reporting_requirement:'半期ごとに売上を報告',
   report_due:'各半期終了後1ヶ月以内', threshold_or_cap:'－', reprint_rule:'－', special_terms:'', active:'true'},
  {usage_category:'イベント', fee_model:'FLAT', fee_value:'0', fee_label:'無償（イベント頒布・要事前申告）',
   licensed_uses:'頒布・上演', payment_due:'－', reporting_requirement:'頒布実績を事後報告',
   report_due:'イベント終了後1ヶ月以内', threshold_or_cap:'－', reprint_rule:'－', special_terms:'営利目的の恒常販売には別区分が適用されます', active:'true'},
  {usage_category:'その他', fee_model:'RATE', fee_value:'0.10', fee_label:'売上の10％（個別協議）',
   licensed_uses:'別途協議', payment_due:'個別協議', reporting_requirement:'個別協議',
   report_due:'個別協議', threshold_or_cap:'個別協議', reprint_rule:'個別協議', special_terms:'内容により事務局と個別に条件を定めます', active:'true'}
];

/** シートをスキーマ通りに用意（ヘッダ設定・先頭行固定・既定シート削除）。既存ヘッダは上書きしない。 */
function initSheets_(ss, schema){
  const names = Object.keys(schema);
  names.forEach(name => {
    let sh = ss.getSheetByName(name);
    if(!sh) sh = ss.insertSheet(name);
    const headers = schema[name];
    const first = sh.getRange(1,1,1,Math.max(1,sh.getLastColumn())).getValues()[0];
    const hasHeader = first && String(first[0]||'') !== '';
    if(!hasHeader){
      sh.getRange(1,1,1,headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
  });
  // schema に無い既定シート（'シート1' / 'Sheet1' 等）を削除
  ss.getSheets().filter(sh => names.indexOf(sh.getName()) < 0).forEach(sh => {
    if(ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
}

/**
 * ワンクリック・セットアップ。Apps Scriptエディタで関数 setup_bootstrap を選び Run。
 * opts: { force:true で既存IDを無視して再作成, seed:false でサンプル投入なし }
 * 返り値（実行ログにも出力）に作成した各IDを含む。
 */
function setup_bootstrap(opts){
  opts = opts || {};
  const sp = PropertiesService.getScriptProperties();
  const out = { created:{}, reused:{} };

  // 1) 作品マスタ
  let masterId = sp.getProperty('SS_MASTER');
  if(masterId && !opts.force){ out.reused.SS_MASTER = masterId; }
  else {
    const ss = SpreadsheetApp.create('SPLL 作品マスタ (SS_MASTER)');
    initSheets_(ss, SCHEMA_MASTER);
    masterId = ss.getId(); sp.setProperty('SS_MASTER', masterId);
    out.created.SS_MASTER = masterId;
  }
  // 2) 業務台帳
  let opsId = sp.getProperty('SS_OPS');
  if(opsId && !opts.force){ out.reused.SS_OPS = opsId; }
  else {
    const ss = SpreadsheetApp.create('SPLL 業務台帳 (SS_OPS)');
    initSheets_(ss, SCHEMA_OPS);
    opsId = ss.getId(); sp.setProperty('SS_OPS', opsId);
    out.created.SS_OPS = opsId;
  }
  // 3) Drive 親フォルダ
  let rootId = sp.getProperty('DRIVE_ROOT');
  if(rootId && !opts.force){ out.reused.DRIVE_ROOT = rootId; }
  else {
    rootId = DriveApp.createFolder('SPLL 契約フォルダ (DRIVE_ROOT)').getId();
    sp.setProperty('DRIVE_ROOT', rootId);
    out.created.DRIVE_ROOT = rootId;
  }

  // 4) 既定設定（未設定のみ）
  if(!getConfig_('LEGAL_PRIVACY_TEXT',''))   setConfig_('LEGAL_PRIVACY_TEXT',   DEFAULT_PRIVACY);
  if(!getConfig_('LEGAL_TERMS_TEMPLATE','')) setConfig_('LEGAL_TERMS_TEMPLATE', DEFAULT_TERMS_TEMPLATE);
  if(!getConfig_('DEFAULT_ROYALTY_RATE','')) setConfig_('DEFAULT_ROYALTY_RATE','0.10');
  if(!getConfig_('HANDLING_FEE_RATE',''))    setConfig_('HANDLING_FEE_RATE',   '0.30');
  if(!prop_('FORM_MAX_WORKS'))               sp.setProperty('FORM_MAX_WORKS', '5');   // 契約書テンプレートの原作枠（当面5）
  if(!getConfig_('DEFAULT_ALLOCATION_SCHEME','')) setConfig_('DEFAULT_ALLOCATION_SCHEME','BY_WORK_EQUAL');  // 配分方式（FLOW-04）
  if(!getConfig_('APPLICATION_RETENTION_DAYS','')) setConfig_('APPLICATION_RETENTION_DAYS','365');           // 未成立申込の保有期間
  if(!getConfig_('TAX_RATE',''))                  setConfig_('TAX_RATE','0.10');                             // 消費税率（請求）
  if(!getConfig_('INVOICE_DUE_DAYS',''))          setConfig_('INVOICE_DUE_DAYS','30');                       // 支払期日（発行から日数）
  if(!getConfig_('REVIEW_SLA_DAYS',''))           setConfig_('REVIEW_SLA_DAYS','5');                         // 人手審査SLA（営業日相当・暦日）

  // 5) サンプル投入（既定ON・既存があればスキップ）
  if(opts.seed !== false) setup_seedSamples_();

  out.properties = { SS_MASTER:masterId, SS_OPS:opsId, DRIVE_ROOT:rootId };
  out.urls = {
    SS_MASTER:'https://docs.google.com/spreadsheets/d/'+masterId,
    SS_OPS:'https://docs.google.com/spreadsheets/d/'+opsId,
    DRIVE_ROOT:'https://drive.google.com/drive/folders/'+rootId
  };
  logEvent_('batch','bootstrap','setup', null, out.properties);
  Logger.log('SS_MASTER = %s', masterId);
  Logger.log('SS_OPS    = %s', opsId);
  Logger.log('DRIVE_ROOT= %s', rootId);
  Logger.log('done: %s', JSON.stringify(out));
  return out;
}

/** サンプル作品・パートナーを投入（各シートが空のときのみ） */
function setup_seedSamples_(){
  if(readRows_(ssMaster_(),'Works_Master').length === 0){
    SAMPLE_WORKS_SEED.forEach(w => appendRow_(ssMaster_(),'Works_Master', w));
  }
  if(readRows_(ssOps_(),'Partners').length === 0){
    SAMPLE_PARTNERS_SEED.forEach(p => appendRow_(ssOps_(),'Partners', p));
  }
  if(readRows_(ssMaster_(),'Fee_Schedule').length === 0){
    SAMPLE_FEE_SCHEDULE_SEED.forEach(f => appendRow_(ssMaster_(),'Fee_Schedule', f));
  }
}

/**
 * 作り直し：既存IDを無視して SS_MASTER / SS_OPS / DRIVE_ROOT を新規に作成し直す。
 * 本番データが無い前提。Apps Scriptエディタで setup_reset を選んで Run。
 * ※ 旧スプレッドシート/フォルダはDriveに残るため、不要なら手動でゴミ箱へ。
 */
function setup_reset(){
  if(readRows_(ssOps_(),'Admin_Users').length > 0) requireRole_(['SYSTEM_ADMIN']);   // 初回のみ無条件
  return setup_bootstrap({ force:true });
}

/** 現在の接続先IDを確認（エディタ実行用）。 */
function setup_status(){
  const s = { SS_MASTER:prop_('SS_MASTER')||'(未設定)', SS_OPS:prop_('SS_OPS')||'(未設定)',
    DRIVE_ROOT:prop_('DRIVE_ROOT')||'(未設定)' };
  Logger.log(JSON.stringify(s)); return s;
}
