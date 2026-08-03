/**
 * SPLL 55_accounting_master ― 経理連携基盤（経理設計書 SPLL-SYS-AD-001 §4/§6/§8/§15）
 *   ・経理専用Spreadsheet（SS_ACCOUNTING_MASTER／年度別 SS_ACCOUNTING_YYYY）の解決
 *   ・経理スキーマ定義と移行（既存 SS_OPS には触れない）
 *   ・一括I/O共通関数（appendRow/セル単位setValueを使わない・§8.1）
 *   ・Drive原票保存（SHA-256・二重取込防止・§15/§7.5）
 */

// ============================================================
// スキーマ（§6）。マスタ系＝SS_ACCOUNTING_MASTER／取引系＝年度別ブック
// ============================================================
const ACC_SCHEMA_MASTER = {
  Accounting_Books:        ['year','spreadsheet_id','status','opened_at','closed_at','closed_by'],
  Sales_Channels:          ['channel_id','channel_name','parser_type','default_encoding','payer_aliases_json','receivable_account','statement_basis','active','updated_by','updated_at'],
  License_Identifiers:     ['license_identifier_id','contract_id','identifier_type','identifier_value','identifier_normalized','status','effective_from','effective_to','source','created_by','created_at'],
  Legacy_Work_Codes:       ['legacy_code','work_id','effective_from','effective_to','status','note','updated_by','updated_at'],
  Sales_Work_Mappings:     ['mapping_id','external_license_ref','channel_id','source_product_id','product_name_key','match_scope','work_id','allocation_weight','priority','status','effective_from','effective_to','approved_by','approved_at'],
  Distribution_Profiles:   ['distribution_profile_id','work_id','profile_name','version','rounding_method','status','effective_from','effective_to','approved_by','approved_at','created_at'],
  Distribution_Profile_Lines: ['profile_line_id','distribution_profile_id','partner_id','role_code','calculation_type','rate','tax_treatment','account_code','sort_order','active'],
  Accounting_Export_Profiles: ['export_profile_id','export_type','profile_name','template_drive_file_id','version','status','config_json','updated_by','updated_at'],
  Accounting_Jobs:         ['job_id','job_type','target_id','status','cursor','total_count','processed_count','retry_count','next_retry_at','started_at','finished_at','owner','last_error','detail_json'],
};
const ACC_SCHEMA_YEAR = {
  Sales_Import_Batches:    ['import_batch_id','channel_id','sales_period','file_name','drive_file_id','file_hash','parser_version','source_row_count','source_total_amount','normalized_row_count','normalized_total_amount','status','supersedes_batch_id','imported_by','imported_at','started_at','finished_at','error_summary'],
  Sales_Ledger:            ['sales_row_id','import_batch_id','source_row_no','channel_id','sales_period','source_product_id','source_project_id','product_name','seller_name','external_license_ref','unit_price','quantity','boost_amount','gross_sales_amount','platform_net_sales_amount','license_fee_amount','currency','raw_row_hash','match_status','allocation_status','created_at'],
  Sales_Match_Results:     ['match_result_id','sales_row_id','contract_id','work_id','match_method','confidence','mapping_id','status','reviewed_by','reviewed_at','note'],
  Allocation_Runs:         ['allocation_run_id','sales_period','import_batch_ids_json','rule_snapshot_hash','status','source_total_amount','allocated_total_amount','difference_amount','exception_count','prepared_by','prepared_at','approved_by','approved_at','posted_at','error_summary'],
  Allocation_Details:      ['allocation_detail_id','allocation_run_id','sales_row_id','contract_id','work_id','partner_id','work_allocation_weight','partner_rate','base_license_fee_amount','work_allocated_amount','allocated_amount','payable_amount','rounding_adjustment','tax_treatment_snapshot','profile_id_snapshot','profile_version_snapshot','calculation_json','status','created_at'],
  Bank_Import_Batches:     ['bank_import_batch_id','bank_code','account_key','file_name','drive_file_id','file_hash','source_row_count','status','imported_by','imported_at','error_summary'],
  Bank_Transactions:       ['bank_transaction_id','bank_import_batch_id','source_row_no','transaction_date','transaction_type','payer_name_raw','payer_name_normalized','debit_amount','credit_amount','balance','raw_row_hash','match_status','created_at'],
  Bank_Reconciliations:    ['reconciliation_id','target_type','target_id','expected_amount','applied_amount','difference_amount','status','confirmed_by','confirmed_at','note'],
  Bank_Reconciliation_Lines: ['reconciliation_line_id','reconciliation_id','bank_transaction_id','applied_amount','created_at'],
  Accounting_Exports:      ['export_id','allocation_run_id','export_type','export_profile_id','template_version','version','drive_file_id','zip_file_id','file_hash','status','generated_by','generated_at','approved_by','approved_at','delivered_at'],
};

// ============================================================
// Spreadsheet解決（§4.2）
// ============================================================
function ssAccMaster_(){
  const id = prop_('SS_ACCOUNTING_MASTER');
  if(!id) throw new Error('CONFIG_ERROR: SS_ACCOUNTING_MASTER が未設定です（setup_accountingBootstrap を実行してください）');
  return SpreadsheetApp.openById(id);
}
/** 現年度の経理ブック。year指定時は Accounting_Books から解決。 */
function ssAccYear_(year){
  if(!year){
    const id = prop_('SS_ACCOUNTING_CURRENT');
    if(!id) throw new Error('CONFIG_ERROR: SS_ACCOUNTING_CURRENT が未設定です（setup_accountingBootstrap を実行してください）');
    return SpreadsheetApp.openById(id);
  }
  const row = readTableBulk_(ssAccMaster_(), 'Accounting_Books').find(function(b){ return String(b.year) === String(year); });
  if(!row) throw new Error('DATA_NOT_FOUND: 年度ブックがありません: ' + year);
  return SpreadsheetApp.openById(row.spreadsheet_id);
}
function accCurrentYear_(){ return String(prop_('ACC_CURRENT_YEAR') || new Date().getFullYear()); }

// ============================================================
// 一括I/O（§8.1）。経理処理では appendRow_/セル単位setValue を使わない
// ============================================================
/** シート全体を1回のI/Oで読み、オブジェクト配列で返す（1行目=ヘッダ）。 */
function readTableBulk_(ss, sheetName){
  const sh = ss.getSheetByName(sheetName); if(!sh) return [];
  const v = sh.getDataRange().getValues(); if(v.length < 2) return [];
  const head = v[0];
  const out = [];
  for(let i = 1; i < v.length; i++){
    let empty = true;
    const o = {};
    for(let j = 0; j < head.length; j++){
      o[head[j]] = v[i][j];
      if(v[i][j] !== '' && v[i][j] !== null && v[i][j] !== undefined) empty = false;
    }
    if(!empty) out.push(o);   // 洗い替え後の空行はスキップ
  }
  return out;
}
/** シートが無ければ作成しヘッダを書く。既存の列削除・並替えはしない（末尾追加のみ）。 */
function accEnsureSheet_(ss, sheetName, columns){
  let sh = ss.getSheetByName(sheetName);
  if(!sh){
    sh = ss.insertSheet(sheetName);
    sh.getRange(1, 1, 1, columns.length).setValues([columns]);
    sh.setFrozenRows(1);
    return { createdSheet: true, addedColumns: columns };
  }
  const lastCol = sh.getLastColumn();
  const head = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  const missing = columns.filter(function(c){ return head.indexOf(c) < 0; });
  if(missing.length) sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]);
  return { createdSheet: false, addedColumns: missing };
}
/** オブジェクト配列を末尾へ一括追記（chunk単位のsetValues）。 */
function appendRowsBulk_(ss, sheetName, objects, chunkSize){
  if(!objects || !objects.length) return 0;
  const sh = ss.getSheetByName(sheetName);
  if(!sh) throw new Error('DATA_NOT_FOUND: シートがありません: ' + sheetName);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const chunk = Math.max(1, chunkSize || 500);
  let written = 0;
  while(written < objects.length){
    const part = objects.slice(written, written + chunk);
    const grid = part.map(function(o){ return head.map(function(k){ return (o[k] !== undefined && o[k] !== null) ? o[k] : ''; }); });
    sh.getRange(sh.getLastRow() + 1, 1, grid.length, head.length).setValues(grid);
    written += part.length;
  }
  return written;
}
/** ヘッダ以外を全置換（洗い替え）。 */
function replaceRowsBulk_(ss, sheetName, objects){
  const sh = ss.getSheetByName(sheetName);
  if(!sh) throw new Error('DATA_NOT_FOUND: シートがありません: ' + sheetName);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const last = sh.getLastRow();
  if(last > 1) sh.getRange(2, 1, last - 1, head.length).setValues(
    Array.from({length: last - 1}, function(){ return head.map(function(){ return ''; }); }));
  return appendRowsBulk_(ss, sheetName, objects || []);
}
/** rows を keyFn の値でMap化（重複キーは後勝ちにしない：初出優先）。 */
function buildIndex_(rows, keyFn){
  const idx = {};
  (rows || []).forEach(function(r){ const k = String(keyFn(r)); if(!(k in idx)) idx[k] = r; });
  return idx;
}
/** keyColumn一致で一括更新、無ければ末尾追加。1回の読取り＋範囲書込みで行う。 */
function upsertRowsBulk_(ss, sheetName, keyColumn, objects){
  if(!objects || !objects.length) return { updated: 0, inserted: 0 };
  const sh = ss.getSheetByName(sheetName);
  if(!sh) throw new Error('DATA_NOT_FOUND: シートがありません: ' + sheetName);
  const v = sh.getDataRange().getValues();
  const head = v[0].map(String);
  const keyIdx = head.indexOf(keyColumn);
  if(keyIdx < 0) throw new Error('DATA_NOT_FOUND: キー列がありません: ' + keyColumn);
  const rowByKey = {};
  for(let i = 1; i < v.length; i++) rowByKey[String(v[i][keyIdx])] = i;   // 0-based data index
  const inserts = [];
  let updated = 0;
  objects.forEach(function(o){
    const k = String(o[keyColumn]);
    if(k in rowByKey){
      const i = rowByKey[k];
      head.forEach(function(col, j){ if(o[col] !== undefined) v[i][j] = o[col]; });
      updated++;
    } else inserts.push(o);
  });
  if(updated) sh.getRange(1, 1, v.length, head.length).setValues(v);
  const inserted = appendRowsBulk_(ss, sheetName, inserts);
  return { updated: updated, inserted: inserted };
}

// ============================================================
// セットアップ・移行（§17 Phase M1）
// ============================================================
/** 経理基盤の初期作成（冪等）。マスタ／現年度ブック／Driveフォルダ／初期値。 */
function setup_accountingBootstrap(){
  if(readRows_(ssOps_(), 'Admin_Users').length > 0) requireRole_(['SYSTEM_ADMIN']);
  const sp = PropertiesService.getScriptProperties();
  const out = { created: {}, reused: {} };
  // 1) マスタ
  let masterId = sp.getProperty('SS_ACCOUNTING_MASTER');
  if(masterId){ out.reused.SS_ACCOUNTING_MASTER = masterId; }
  else {
    masterId = SpreadsheetApp.create('SPLL 経理マスタ (SS_ACCOUNTING_MASTER)').getId();
    sp.setProperty('SS_ACCOUNTING_MASTER', masterId);
    out.created.SS_ACCOUNTING_MASTER = masterId;
  }
  // 2) 現年度ブック
  const year = accCurrentYear_();
  let yearId = sp.getProperty('SS_ACCOUNTING_CURRENT');
  if(yearId){ out.reused.SS_ACCOUNTING_CURRENT = yearId; }
  else {
    yearId = SpreadsheetApp.create('SPLL 経理台帳 ' + year + ' (SS_ACCOUNTING_' + year + ')').getId();
    sp.setProperty('SS_ACCOUNTING_CURRENT', yearId);
    sp.setProperty('ACC_CURRENT_YEAR', year);
    out.created.SS_ACCOUNTING_CURRENT = yearId;
  }
  // 3) スキーマ＋初期値＋台帳登録
  migrateAccountingSchema_();
  seedAccountingMaster_(year, yearId);
  // 4) Driveフォルダ（§15）
  accFolder_([year, '01_Original_Files', 'BOOTH']);
  accFolder_([year, '01_Original_Files', 'TALTO']);
  accFolder_([year, '01_Original_Files', 'DLSITE']);
  accFolder_([year, '01_Original_Files', 'BANK']);
  accFolder_([year, '02_Accounting_Exports']);
  accFolder_([year, '03_Partner_Statements']);
  accFolder_([year, '04_Zip']);
  accFolder_([year, '05_Audit_Snapshots']);
  accFolder_(['Templates']);
  logEvent_('accounting', 'bootstrap', actor_(), null, out);
  return out;
}
/** 経理スキーマ移行（冪等・既存列は末尾追加のみ）。productionでも実行可。 */
function migrateAccountingSchema_(){
  const master = ssAccMaster_();
  Object.keys(ACC_SCHEMA_MASTER).forEach(function(name){ accEnsureSheet_(master, name, ACC_SCHEMA_MASTER[name]); });
  const yearSs = SpreadsheetApp.openById(prop_('SS_ACCOUNTING_CURRENT'));
  Object.keys(ACC_SCHEMA_YEAR).forEach(function(name){ accEnsureSheet_(yearSs, name, ACC_SCHEMA_YEAR[name]); });
  return { master: Object.keys(ACC_SCHEMA_MASTER).length, year: Object.keys(ACC_SCHEMA_YEAR).length };
}
function setup_accountingMigrate(){
  if(readRows_(ssOps_(), 'Admin_Users').length > 0) requireRole_(['SYSTEM_ADMIN']);
  return migrateAccountingSchema_();
}
/** 初期マスタ値（§6.1）。既存行があれば追加しない。 */
function seedAccountingMaster_(year, yearId){
  const master = ssAccMaster_();
  const now = new Date().toISOString();
  const books = readTableBulk_(master, 'Accounting_Books');
  if(!books.some(function(b){ return String(b.year) === String(year); }))
    appendRowsBulk_(master, 'Accounting_Books', [{ year: year, spreadsheet_id: yearId, status: 'OPEN', opened_at: now }]);
  const chans = readTableBulk_(master, 'Sales_Channels');
  const seedCh = [
    { channel_id:'BOOTH',       channel_name:'BOOTH（ピクシブ）',   parser_type:'BOOTH',  default_encoding:'Shift_JIS', payer_aliases_json:'["ピクシブ","ピクシブ株式会社","ﾋﾟｸｼﾌﾞ"]', statement_basis:'PLATFORM' },
    { channel_id:'TALTO',       channel_name:'TALTO（ココフォリア）', parser_type:'TALTO',  default_encoding:'UTF-8',     payer_aliases_json:'["ココフォリア","ｺｺﾌｫﾘｱ"]', statement_basis:'PLATFORM' },
    { channel_id:'DLSITE',      channel_name:'DLsite（エイシス）',  parser_type:'DLSITE', default_encoding:'Shift_JIS', payer_aliases_json:'["エイシス","株式会社エイシス","ｴｲｼｽ"]', statement_basis:'PLATFORM' },
    { channel_id:'BANK_DIRECT', channel_name:'直接振込',           parser_type:'',       default_encoding:'Shift_JIS', payer_aliases_json:'[]', statement_basis:'DIRECT' },
    { channel_id:'AMBASS',      channel_name:'アンバサダー',        parser_type:'',       default_encoding:'UTF-8',     payer_aliases_json:'[]', statement_basis:'DIRECT' },
    { channel_id:'PAPER',       channel_name:'紙申請ほか',          parser_type:'',       default_encoding:'UTF-8',     payer_aliases_json:'[]', statement_basis:'DIRECT' },
  ].filter(function(c){ return !chans.some(function(x){ return x.channel_id === c.channel_id; }); })
   .map(function(c){ c.active = 'true'; c.updated_by = 'setup'; c.updated_at = now; return c; });
  appendRowsBulk_(master, 'Sales_Channels', seedCh);
  const profs = readTableBulk_(master, 'Accounting_Export_Profiles');
  const seedPr = ['LEGACY_V3_07','CONSOLIDATED_V1','PARTNER_MONTHLY_V1','PARTNER_QUARTERLY_V1']
    .filter(function(p){ return !profs.some(function(x){ return x.export_profile_id === p; }); })
    .map(function(p){ return { export_profile_id: p, export_type: p.indexOf('PARTNER_') === 0 ? 'PARTNER' : 'ACCOUNTING',
      profile_name: p, template_drive_file_id: '', version: 1, status: 'ACTIVE', config_json: '{}', updated_by: 'setup', updated_at: now }; });
  appendRowsBulk_(master, 'Accounting_Export_Profiles', seedPr);
  return true;
}

/** 販売チャネル一覧（管理画面用）。 */
function admin_accountingListChannels(){ requireRole_([]);
  return readTableBulk_(ssAccMaster_(), 'Sales_Channels')
    .filter(function(c){ return String(c.active) !== 'false'; })
    .map(function(c){ return { channel_id: c.channel_id, channel_name: c.channel_name,
      parser_type: c.parser_type, default_encoding: c.default_encoding, statement_basis: c.statement_basis }; });
}

// ============================================================
// Drive原票保存（§7.5/§15/§16）
// ============================================================
/** DRIVE_ROOT/Accounting/ 配下のフォルダを解決（無ければ作成）。 */
function accFolder_(pathParts){
  let folder = DriveApp.getFolderById(cfg_('DRIVE_ROOT'));
  ['Accounting'].concat(pathParts || []).forEach(function(name){
    const it = folder.getFoldersByName(String(name));
    folder = it.hasNext() ? it.next() : folder.createFolder(String(name));
  });
  return folder;
}
/** 原票をDriveへ保存しSHA-256を返す。原票は削除・上書きしない（§15）。 */
function accSaveOriginalFile_(subfolder, blob, year){
  const y = year || accCurrentYear_();
  const folder = accFolder_([y, '01_Original_Files', subfolder]);
  const bytes = blob.getBytes();
  const hash = sha256Bytes_(bytes);
  const file = folder.createFile(blob);
  return { drive_file_id: file.getId(), file_hash: hash, size: bytes.length };
}
/** 同一ハッシュの取込済みバッチを返す（二重取込防止・§7.5）。 */
function accFindBatchByHash_(sheetName, hash){
  return readTableBulk_(ssAccYear_(), sheetName).find(function(b){
    return b.file_hash === hash && b.status !== 'SUPERSEDED' && b.status !== 'ERROR' && b.status !== 'VOID';
  }) || null;
}
