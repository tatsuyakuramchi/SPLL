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
  // report_* 構造化列（V2-017）：報告要否・期限を文言でなく構造化値で保持
  Fee_Schedule:    ['usage_category','fee_model','fee_value','fee_label','licensed_uses','payment_due','reporting_requirement','report_due','threshold_or_cap','reprint_rule','special_terms','active','requires_usage_report','report_frequency','report_due_days','report_due_base']
};
const SCHEMA_OPS = {
  // 申込：複数原作は中間テーブル Application_Works で管理（B経路固定・A/B分岐なし）
  //   usage_category：利用目的（別紙2の料金計算キー）／privacy_hash・terms_hash：同意時文書ハッシュ（§7.2）
  // adult_check: フォームの生年月日から求めた成年判定（ADULT/MINOR/UNKNOWN）。生年月日そのものは持たない。
  Applications:         ['application_id','application_ref','usage_category','privacy_hash','terms_hash','handoff_expires_at','status','created_at','form_submission_id','form_submitted_at','cloudsign_send_status','cloudsign_send_error','manual_review_reason','template_route','adult_check','supersedes_application_id','superseded_by_application_id','license_id'],
  Application_Works:    ['application_work_id','application_id','work_id'],
  // 契約：締結時に対象原作を Contract_Works へスナップショット（法務証跡）
  //   link_status: LINKED（申込突合済）/ UNLINKED（未突合＝手動紐付け待ち）
  //   contract_file_id/hash：締結済原本PDF（FUN-04）
  //   contact_email/source：CloudSignが実際に契約書を送付した宛先（案内送付・不達対応の連絡先）
  Contracts:            ['contract_id','cloudsign_document_id','cloudsign_title','application_id','application_ref','usage_category','terms_snapshot','status','link_status','signed_at','contract_file_id','contract_file_hash','folder_id','form_submission_id','route_type','terms_verification_status','terms_verification_detail','delivery_status','last_delivery_event_at','license_id','contact_email','contact_email_source'],
  // 清算は契約時スナップショットを正本とする（V2-011）：権利者・登録番号・料率・配分方式まで固定
  Contract_Works:       ['contract_work_id','contract_id','work_id','work_name_snapshot','publisher_snapshot','credit_snapshot','partner_id_snapshot','partner_name_snapshot','invoice_reg_number_snapshot','allocation_scheme_snapshot','royalty_rate_snapshot','handling_fee_rate_snapshot'],
  // 用途別アクセストークン（SEC-06/§9.1）：SUBMISSION / BADGE_DOWNLOAD
  Access_Tokens:        ['token_id','contract_id','purpose','token_hash','status','expires_at','max_uses','used_count','last_used_at','issued_at','revoked_at'],
  // submission_method: UPLOAD（20MBまでの直接アップロード）/ DRIVE_FOLDER（大容量・専用Driveフォルダ受渡）
  Submissions:          ['submission_id','contract_id','title','status','submitted_at','submission_method'],
  // DRIVE_FOLDER の版は、フォルダ払出し（OPEN）→クリエーターが投入→提出完了（確定）で成立する
  Submission_Versions:  ['version_id','submission_id','version_no','status','submitted_at','submission_method','drive_folder_id','folder_status','folder_opened_at','folder_closed_at','file_count','total_bytes'],
  Submission_Files:     ['submission_file_id','version_id','drive_file_id','mime_type','size','sha256','original_filename','magic_valid'],
  AI_Review_Jobs:       ['ai_review_id','submission_id','version_id','model','prompt_version','status','retry_count','overall_result','risk_score','human_review_required','response_file_id','started_at','completed_at','last_error'],
  AI_Findings:          ['finding_id','ai_review_id','work_id','rule_id','severity','result','page','evidence','recommended_action','confidence'],
  Human_Reviews:        ['human_review_id','submission_id','version_id','reviewer','result','comments','reviewed_at'],
  Compliance_Alerts:    ['alert_id','contract_id','submission_id','severity','status','settlement_block'],
  // ※利用報告・請求・入金・清算（Usage_Reports/Invoices/Payments/Settlements系）は
  //   本システムの管理対象外（経理は独自運用）。既存シートがあっても触らない。
  Partners:             ['partner_id','name','invoice_reg_number','is_qualified_issuer','bank','contact'],
  Badges:               ['badge_id','contract_id','issued_at','png_l','png_m','png_s','token_hash','status'],
  // 認証：状態＋変更理由・承認記録
  Certificates:         ['cert_id','contract_id','status','reason_code','reason_text','requested_by','approved_by','legal_case_id','effective_at','check_code_hash','issued_at'],
  Events:               ['event_id','entity_type','entity_id','actor','before','after','occurred_at'],
  Config:               ['config_key','value','environment','updated_at'],
  // ---- 修正設計書 §15.1 追加テーブル ----
  Admin_Users:          ['admin_user_id','email','role','status','added_by','added_at'],
  // 受信キュー（V2-007）：RECEIVED→PROCESSING→PROCESSED／RETRY_WAIT／MANUAL_REVIEW／REJECTED／DEAD_LETTER
  Webhook_Receipts:     ['receipt_id','provider','external_event_id','idempotency_key','payload_hash','payload_json','signature_valid','received_at','status','retry_count','last_error','processed_at','processing_started_at','processing_owner','manual_review_reason','next_retry_at','event_type','document_id','application_ref','response_code'],
  System_Errors:        ['error_id','error_code','source','message','detail','occurred_at','status'],
  Batch_Runs:           ['batch_run_id','batch_name','started_at','finished_at','processed','errors','status','detail'],
  X_Posts:              ['x_post_id','work_id','tweet_id','text','posted_by','posted_at'],
  // ---- SPLLライセンス台帳（分断・簡素化計画 SPLL-SYS-RP-001 §6）----
  // 主台帳：1案件（SPLL番号）1行。申込〜契約〜審査〜認証を1つの状態遷移として扱う
  License_Cases:        ['license_id','application_ref','party_type','party_display_name','contact_email','usage_category','case_status','contract_status','cloudsign_document_id','signed_at','signed_pdf_file_id','signed_pdf_hash','review_status','certification_status','finance_handoff_status','created_at','updated_at'],
  // 対象原作（1:N）：契約条件は申込時点でスナップショット（費用＝契約形態×原作構造で自動確定）
  License_Works:        ['license_work_id','license_id','work_id','work_name_snapshot','credit_snapshot','fee_model_snapshot','fee_value_snapshot','reporting_requirement_snapshot','active'],
  // 契約書履歴（1:N）：原本は締結済PDF＋ハッシュ（台帳に契約全文を再現しない）
  Contract_Documents:   ['contract_document_id','license_id','document_type','version','cloudsign_document_id','status','signed_at','file_id','file_hash','created_at'],
  // License→Finance引渡（§10）：契約成立とFinance処理の境界。READY→ACCEPTED（冪等キー license_id+handoff_version）
  Finance_Handoffs:     ['handoff_id','license_id','handoff_version','signed_at','party_display_name','usage_category','works_snapshot_json','billing_terms_json','contract_status','status','created_at','accepted_at'],
  // 規約・同意文の版管理（§7.2）：DRAFT→PUBLISHED→RETIRED
  Legal_Documents:      ['legal_document_id','document_type','version','content_html','content_hash','effective_from','effective_to','status','approved_by','approved_at'],
  Application_Consents: ['consent_id','application_id','document_type','legal_document_id','legal_document_version','content_hash','display_hash','consent_session_id','accepted','accepted_at','consented_at','consent_method','evidence_version'],
  // 通知キュー（§10）：メール非保持方針下の「誰に何を通知すべきか」の記録
  // 自動送信（GUIDE_READY等）：MANUAL_REQUIRED→SENT／SEND_FAILED。attempts で再試行を制御
  Notification_Queue:   ['notification_id','contract_id','type','reference_id','payload_json','status','created_at','sent_at','handled_by','attempts','last_error','sent_to_domain'],
  // スキーマ移行（V2-003）
  // バッジ発行ジョブ（V2-014）：QUEUED→GENERATING→ISSUED／ERROR→RETRY_WAIT
  Badge_Jobs:           ['badge_job_id','contract_id','status','retry_count','last_error','created_at','finished_at'],
  // 認証状態変更の職務分離（V2-018）：申請→承認→適用
  Certificate_Change_Requests: ['request_id','cert_id','contract_id','requested_status','reason_code','reason_text','legal_case_id','requested_by','requested_at','approved_by','approved_at','status','emergency_override'],
  Schema_Versions:      ['schema_name','version','applied_at','applied_by','checksum'],
  Migration_Runs:       ['migration_run_id','migration_name','started_at','finished_at','status','before_snapshot','after_snapshot','error_detail']
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
  {usage_category:'書籍', fee_model:'FLAT', fee_value:'16500', fee_label:'16,500円／契約（複数原作は権利者へ均等分配）',
   licensed_uses:'複製・頒布', payment_due:'契約締結後の請求書発行日から30日以内', reporting_requirement:'定額のため利用報告は原則不要',
   report_due:'－', threshold_or_cap:'－', reprint_rule:'増刷時も追加料金なし（要お申し出）', special_terms:'', active:'true',
   requires_usage_report:'false', report_frequency:'', report_due_days:'', report_due_base:''},
  {usage_category:'電子出版物', fee_model:'RATE', fee_value:'0.10', fee_label:'売上の10％',
   licensed_uses:'複製・公衆送信', payment_due:'半期ごとの計算書発効後', reporting_requirement:'半期ごとに販売実績を報告',
   report_due:'各半期終了後1ヶ月以内', threshold_or_cap:'－', reprint_rule:'－', special_terms:'', active:'true',
   requires_usage_report:'true', report_frequency:'HALF_YEARLY', report_due_days:'30', report_due_base:'PERIOD_END'},
  {usage_category:'商品販売', fee_model:'FLAT', fee_value:'16500', fee_label:'16,500円／契約（複数原作は権利者へ均等分配）',
   licensed_uses:'複製・頒布・販売', payment_due:'契約締結後の請求書発行日から30日以内', reporting_requirement:'定額のため利用報告は原則不要',
   report_due:'－', threshold_or_cap:'頒布数の上限は設けない', reprint_rule:'追加製造も追加料金なし（要お申し出）', special_terms:'', active:'true'},
  {usage_category:'サブスクリプション', fee_model:'RATE', fee_value:'0.10', fee_label:'売上の10％',
   licensed_uses:'公衆送信（継続的提供）', payment_due:'半期ごとの計算書発効後', reporting_requirement:'半期ごとに売上を報告',
   report_due:'各半期終了後1ヶ月以内', threshold_or_cap:'－', reprint_rule:'－', special_terms:'', active:'true',
   requires_usage_report:'true', report_frequency:'HALF_YEARLY', report_due_days:'30', report_due_base:'PERIOD_END'},
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
  if(!sp.getProperty('ENVIRONMENT')) sp.setProperty('ENVIRONMENT','development');   // 明示値を必ず持つ（V2-002）
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
  if(!getConfig_('LEGAL_GUIDELINE_TEXT','')) setConfig_('LEGAL_GUIDELINE_TEXT', DEFAULT_GUIDELINE);
  if(!getConfig_('DEFAULT_ROYALTY_RATE','')) setConfig_('DEFAULT_ROYALTY_RATE','0.10');
  if(!getConfig_('HANDLING_FEE_RATE',''))    setConfig_('HANDLING_FEE_RATE',   '0.30');
  if(!prop_('FORM_MAX_WORKS'))               sp.setProperty('FORM_MAX_WORKS', '5');   // 契約書テンプレートの原作枠（当面5）
  if(!getConfig_('DEFAULT_ALLOCATION_SCHEME','')) setConfig_('DEFAULT_ALLOCATION_SCHEME','BY_WORK_EQUAL');  // 配分方式（FLOW-04）
  if(!getConfig_('APPLICATION_RETENTION_DAYS','')) setConfig_('APPLICATION_RETENTION_DAYS','365');           // 未成立申込の保有期間
  if(!getConfig_('REVIEW_SLA_DAYS',''))           setConfig_('REVIEW_SLA_DAYS','5');                         // 人手審査SLA（営業日相当・暦日）
  // 大容量提出（専用Driveフォルダ受渡）の上限・開放期間
  if(!getConfig_('SUBMIT_FOLDER_MAX_FILES',''))   setConfig_('SUBMIT_FOLDER_MAX_FILES','50');                // 1版あたりの最大ファイル数
  if(!getConfig_('SUBMIT_FOLDER_MAX_GB',''))      setConfig_('SUBMIT_FOLDER_MAX_GB','5');                    // 1版あたりの合計サイズ上限（GB）
  if(!getConfig_('SUBMIT_FOLDER_OPEN_DAYS',''))   setConfig_('SUBMIT_FOLDER_OPEN_DAYS','14');                // 投入用リンクの開放日数（超過で共有解除）
  // 締結後の案内メール（自動送信）。本文には振込先を書かず、案内ページURLのみを載せる
  if(!getConfig_('GUIDE_EMAIL_AUTO_SEND','')) setConfig_('GUIDE_EMAIL_AUTO_SEND','true');
  if(!getConfig_('GUIDE_EMAIL_SUBJECT',''))   setConfig_('GUIDE_EMAIL_SUBJECT', GUIDE_EMAIL_DEFAULT_SUBJECT);
  if(!getConfig_('GUIDE_EMAIL_BODY',''))      setConfig_('GUIDE_EMAIL_BODY', GUIDE_EMAIL_DEFAULT_BODY);
  // 法人の退避先（窓口は個人専用）。ダミー値を置き、実運用の受け口が決まり次第
  // 管理コンソール「設定→申込導線」で差し替える（Googleフォーム／formrun／メールいずれも可）
  if(!getConfig_('CORPORATE_INQUIRY_EMAIL','')) setConfig_('CORPORATE_INQUIRY_EMAIL','spll-corporate@example.com');
  // CloudSign FORM（formrun）の初期値つきURLは1000字まで。余裕を見て超過分は個別確認へ退避させる
  if(!getConfig_('FORM_URL_MAX_CHARS',''))    setConfig_('FORM_URL_MAX_CHARS','850');

  // 5) サンプル投入（既定ON・既存があればスキップ）
  if(opts.seed !== false) setup_seedSamples_();

  // 既存シートへの不足列追加（V2-003）。新規作成時も冪等に実行。
  try{ migrateSchema_(); }catch(e){ logError_('PROCESSING_ERROR','bootstrap:migrate', e); }

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
  if(isProd_()) return;   // productionではサンプル投入を常に禁止（V2-004）
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

// ---- スキーマ移行（修正設計書v2 V2-003）----
const SCHEMA_VERSION = 11;  // v11: 成年確認の判定結果（adult_check）。v10: 申込の契約書経路（template_route）。v9: 案内メールの自動送信（通知の送信状態）。v8: 連絡先メール。v7: 大容量提出

/**
 * 既存スプレッドシートへ不足シート・不足列を追加する（既存列の削除・並び替えはしない）。
 * LockServiceで排他し、Migration_Runs に前後スナップショット（シート数・総行数）を記録。冪等。
 */
function migrateSchema_(){
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  const runId = Utilities.getUuid();
  try{
    // Migration_Runs / Schema_Versions 自身を先に用意
    [['Migration_Runs', SCHEMA_OPS.Migration_Runs], ['Schema_Versions', SCHEMA_OPS.Schema_Versions]]
      .forEach(function(x){ ensureSheetColumns_(ssOps_(), x[0], x[1]); });
    appendRow_(ssOps_(),'Migration_Runs',{ migration_run_id:runId, migration_name:'migrateSchema v'+SCHEMA_VERSION,
      started_at:new Date().toISOString(), finished_at:'', status:'RUNNING',
      before_snapshot:JSON.stringify(schemaSnapshot_()), after_snapshot:'', error_detail:'' });
    let added = { sheets:0, columns:0, warnings:[] };
    [[ssMaster_(), SCHEMA_MASTER, 'MASTER'], [ssOps_(), SCHEMA_OPS, 'OPS']].forEach(function(t){
      const ss = t[0], schema = t[1], name = t[2];
      Object.keys(schema).forEach(function(sheetName){
        const r = ensureSheetColumns_(ss, sheetName, schema[sheetName]);
        added.sheets += r.createdSheet ? 1 : 0; added.columns += r.addedColumns.length;
        added.warnings = added.warnings.concat(r.warnings);
      });
      const patch = { version:SCHEMA_VERSION, applied_at:new Date().toISOString(), applied_by:actor_(),
        checksum:hash_(JSON.stringify(schema)) };
      if(!updateRow_(ssOps_(),'Schema_Versions','schema_name',name,patch))
        appendRow_(ssOps_(),'Schema_Versions', Object.assign({ schema_name:name }, patch));
    });
    updateRow_(ssOps_(),'Migration_Runs','migration_run_id',runId,{ finished_at:new Date().toISOString(),
      status:'DONE', after_snapshot:JSON.stringify(schemaSnapshot_()),
      error_detail:added.warnings.length ? ('警告: ' + added.warnings.join(' / ')).slice(0,500) : '' });
    logEvent_('batch','migrateSchema',actor_(),null,added);
    return added;
  }catch(err){
    try{ updateRow_(ssOps_(),'Migration_Runs','migration_run_id',runId,{ finished_at:new Date().toISOString(),
      status:'ERROR', error_detail:String(err).slice(0,500) }); }catch(e){}
    throw err;
  }finally{ lock.releaseLock(); }
}
/** シートが無ければ作成、あれば不足列だけをヘッダ末尾へ追加。重複・空ヘッダは警告。 */
function ensureSheetColumns_(ss, name, headers){
  let sh = ss.getSheetByName(name);
  const out = { createdSheet:false, addedColumns:[], warnings:[] };
  if(!sh){
    sh = ss.insertSheet(name);
    sh.getRange(1,1,1,headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    out.createdSheet = true;
    return out;
  }
  const lastCol = Math.max(1, sh.getLastColumn());
  const cur = sh.getRange(1,1,1,lastCol).getValues()[0].map(String);
  const curSet = {};
  cur.forEach(function(h,i){
    if(h === ''){ if(i < lastCol-1) out.warnings.push(name+': 空ヘッダ列'+(i+1)); return; }
    if(curSet[h] !== undefined) out.warnings.push(name+': ヘッダ重複 '+h);
    curSet[h] = i;
  });
  const missing = headers.filter(function(h){ return curSet[h] === undefined; });
  if(missing.length){
    const start = (cur[cur.length-1] === '' && cur.length === 1) ? 1 : cur.filter(String).length + 1;
    sh.getRange(1, start, 1, missing.length).setValues([missing]);
    out.addedColumns = missing;
  }
  headers.length && cur.filter(String).forEach(function(h){
    if(headers.indexOf(h) < 0) out.warnings.push(name+': スキーマ外の列 '+h);
  });
  return out;
}
/** 移行前後スナップショット：シートごとの行数 */
function schemaSnapshot_(){
  const snap = {};
  [[ssMaster_(),'M'],[ssOps_(),'O']].forEach(function(t){
    t[0].getSheets().forEach(function(sh){ snap[t[1]+':'+sh.getName()] = sh.getLastRow(); });
  });
  return snap;
}
/** エディタ実行用：スキーマ移行（管理者登録済みなら SYSTEM_ADMIN 必須） */
function setup_migrate(){
  if(readRows_(ssOps_(),'Admin_Users').length > 0) requireRole_(['SYSTEM_ADMIN']);
  return migrateSchema_();
}

/**
 * 作り直し：既存IDを無視して SS_MASTER / SS_OPS / DRIVE_ROOT を新規に作成し直す。
 * 本番データが無い前提。Apps Scriptエディタで setup_reset を選んで Run。
 * ※ 旧スプレッドシート/フォルダはDriveに残るため、不要なら手動でゴミ箱へ。
 */
function setup_reset(){
  if(isProd_()) throw new Error('AUTHORIZATION_ERROR: production では setup_reset は実行できません（V2-004）。スキーマ変更は setup_migrate を使用してください。');
  if(readRows_(ssOps_(),'Admin_Users').length > 0) requireRole_(['SYSTEM_ADMIN']);   // 初回のみ無条件
  return setup_bootstrap({ force:true });
}

/** 現在の接続先IDを確認（エディタ実行用）。 */
function setup_status(){
  const s = { SS_MASTER:prop_('SS_MASTER')||'(未設定)', SS_OPS:prop_('SS_OPS')||'(未設定)',
    DRIVE_ROOT:prop_('DRIVE_ROOT')||'(未設定)' };
  Logger.log(JSON.stringify(s)); return s;
}

// ============================================================
// 一括初期設定（adminのGASエディタから setup_all を1回実行）
//   台帳・Drive・スキーマ移行・初期管理者までを一気に整え、
//   他プロジェクト（portal/workflow）へ転記するプロパティ一覧をログに出力する。
//   冪等：既存の設定・台帳は再利用し、作り直さない。
// ============================================================
function setup_all(adminEmail){
  const sp = PropertiesService.getScriptProperties();
  const report = { steps: [], properties: {}, copy_to_other_projects: {} };

  // 1) ENVIRONMENT（未設定なら development）
  if(!sp.getProperty('ENVIRONMENT')){ sp.setProperty('ENVIRONMENT','development'); report.steps.push('ENVIRONMENT=development を設定'); }
  else report.steps.push('ENVIRONMENT: ' + sp.getProperty('ENVIRONMENT') + '（既存を維持）');

  // 2) 台帳・Drive・既定Config・スキーマ移行（既存IDは再利用・冪等）
  const boot = setup_bootstrap({ seed: env_() !== 'production' });
  report.steps.push('setup_bootstrap: ' + JSON.stringify({ created: Object.keys(boot.created||{}), reused: Object.keys(boot.reused||{}) }));

  // 3) 初期管理者（引数省略時は実行者自身）
  let email = String(adminEmail || '').toLowerCase();
  if(!email){ try{ email = String(Session.getActiveUser().getEmail() || '').toLowerCase(); }catch(e){} }
  if(!email) throw new Error('管理者メールを取得できません。setup_all("you@example.com") の形式で実行してください。');
  const admins = readRows_(ssOps_(),'Admin_Users');
  if(!admins.length){ setup_setInitialAdmin(email, 'SYSTEM_ADMIN'); report.steps.push('初期管理者を登録: ' + email); }
  else if(!admins.some(function(u){ return String(u.email).toLowerCase() === email && u.status !== 'DISABLED'; })){
    setup_setInitialAdmin(email, 'SYSTEM_ADMIN');   // 2人目以降はSYSTEM_ADMIN権限が必要（実行者が権限を持つ場合のみ成功）
    report.steps.push('管理者を追加登録: ' + email);
  } else report.steps.push('管理者登録済み: ' + email);

  // 4) HANDOFF_SECRET（フォーム引継ぎHMAC鍵）：未生成なら採番して保持
  if(!sp.getProperty('HANDOFF_SECRET')){
    sp.setProperty('HANDOFF_SECRET', Utilities.getUuid().replace(/-/g,'') + Utilities.getUuid().replace(/-/g,''));
    report.steps.push('HANDOFF_SECRET を生成（portal/workflowへ転記が必要）');
  }

  // 5) ライセンス台帳移行（RP-001）：既存申込・契約をSPLL番号（License_Cases）へ
  try{ const lm = setup_migrateLicenseCases(); report.steps.push('setup_migrateLicenseCases: ' + JSON.stringify(lm)); }
  catch(e){ report.steps.push('setup_migrateLicenseCases 失敗: ' + String(e && e.message || e)); }

  // 6) 転記用プロパティ一覧（ScriptPropertiesはプロジェクトごとに独立）
  const P = function(k){ return sp.getProperty(k) || ''; };
  report.properties = { ENVIRONMENT: P('ENVIRONMENT'), SS_MASTER: P('SS_MASTER'), SS_OPS: P('SS_OPS'),
    DRIVE_ROOT: P('DRIVE_ROOT'), HANDOFF_SECRET: P('HANDOFF_SECRET') };
  report.copy_to_other_projects = {
    portal:     { ENVIRONMENT: P('ENVIRONMENT'), SS_MASTER: P('SS_MASTER'), SS_OPS: P('SS_OPS'),
                  HANDOFF_SECRET: P('HANDOFF_SECRET'), ADMIN_CONSOLE_URL: '（adminのウェブアプリURL /exec を設定）' },
    workflow:   { ENVIRONMENT: P('ENVIRONMENT'), SS_MASTER: P('SS_MASTER'), SS_OPS: P('SS_OPS'),
                  DRIVE_ROOT: P('DRIVE_ROOT'), HANDOFF_SECRET: P('HANDOFF_SECRET') } };

  Logger.log('===== setup_all 完了 =====');
  report.steps.forEach(function(s){ Logger.log('・' + s); });
  Logger.log('');
  Logger.log('▼ 他プロジェクトの「プロジェクトの設定→スクリプト プロパティ」へ転記してください');
  Object.keys(report.copy_to_other_projects).forEach(function(app){
    Logger.log('--- %s ---', app);
    const props = report.copy_to_other_projects[app];
    Object.keys(props).forEach(function(k){ Logger.log('%s = %s', k, props[k]); });
  });
  Logger.log('');
  Logger.log('▼ 残りの手作業');
  Logger.log('・workflow のエディタで setup_workflowAll を実行（トリガー作成）');
  Logger.log('・portal の ADMIN_CONSOLE_URL に adminのウェブアプリURL（/exec）を設定');
  return report;
}

/**
 * 既存データのライセンス台帳移行（RP-001 §16 Phase1・冪等）。
 * Applications＋Contracts＋Contract_Works から License_Cases／License_Works／
 * Contract_Documents／Finance_Handoffs を生成する。既存の旧テーブルは削除しない。
 * 旧フローで請求済みの締結案件は引渡をACCEPTEDで記録（二重請求防止）。
 */
function setup_migrateLicenseCases(){
  if(readRows_(ssOps_(),'Admin_Users').length > 0) requireRole_(['SYSTEM_ADMIN']);
  const ops = ssOps_();
  const contracts = readRows_(ops,'Contracts');
  const certs = readRows_(ops,'Certificates');
  const appWorks = readRows_(ops,'Application_Works');
  let created = 0, skipped = 0;
  readRows_(ops,'Applications').forEach(function(a){
    if(a.license_id || a.status === 'PURGED'){ skipped++; return; }
    const workIds = appWorks.filter(function(w){ return w.application_id === a.application_id; })
      .map(function(w){ return w.work_id; });
    const lid = createLicenseCase_(a.application_id, a.application_ref, a.usage_category, workIds, '');
    updateRow_(ops,'Applications','application_id',a.application_id,{ license_id: lid });
    const st = { APPLICATION_CREATED:'APPLIED', FORM_PENDING:'APPLIED', CONTRACT_PENDING:'CONTRACTING',
      SIGNED:'SIGNED', SUPERSEDED:'CLOSED', CANCELLED:'CLOSED' };
    updateLicenseCase_(lid, { case_status: st[String(a.status)] || 'APPLIED' });
    const c = contracts.find(function(x){ return x.application_id === a.application_id; });
    if(c){
      updateRow_(ops,'Contracts','contract_id',c.contract_id,{ license_id: lid });
      syncLicenseOnSigning_(c.contract_id, lid, 'SIGNED');
      const cert = certs.find(function(x){ return x.contract_id === c.contract_id; });
      updateLicenseCase_(lid, {
        certification_status: cert ? String(cert.status) : 'NOT_ISSUED',
        review_status: cert ? 'PENDING' : 'NOT_REQUIRED',
        finance_handoff_status: 'ACCEPTED' });
      const now = new Date().toISOString();
      appendRow_(ops,'Finance_Handoffs',{ handoff_id: Utilities.getUuid(), license_id: lid, handoff_version: 1,
        signed_at: c.signed_at || '', party_display_name: '', usage_category: c.usage_category || '',
        works_snapshot_json: '[]', billing_terms_json: c.terms_snapshot || '{}',
        contract_status: 'ACTIVE', status: 'ACCEPTED', created_at: now, accepted_at: now });
    }
    created++;
  });
  logEvent_('license_case', 'migrateLicenseCases', actor_(), null, { created: created, skipped: skipped });
  return { created: created, skipped: skipped };
}
