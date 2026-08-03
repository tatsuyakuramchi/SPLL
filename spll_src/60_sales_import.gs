/**
 * SPLL 60_sales_import ― 販売原票の取込（経理設計書 SPLL-SYS-AD-001 §6.2/§7/§12.1）
 *   ・アップロード（Drive原本保存・SHA-256・二重取込防止）→ プレビュー → 取込ジョブ（SALES_PARSE）
 *   ・チャネル別パーサー（BOOTH／TALTO／DLsite）→ 共通形式へ正規化し Sales_Ledger へ一括追記
 *   ・license_fee_amount（許諾料）を配分対象の正本とする
 */

const ACC_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;   // §12.1：初期実装は1ファイル20MBまで

// ============================================================
// 取込API（§12.1）
// ============================================================
/** 原票アップロード。原本保存とバッチ登録のみ行い、解析はプレビュー／取込ジョブで行う。 */
function admin_accountingUploadSalesFile(meta, base64){
  const actor = requireRole_(['ACCOUNTING','OPERATIONS']);
  meta = meta || {};
  const channel = accChannel_(meta.channelId);
  if(!channel.parser_type) throw new Error('VALIDATION_ERROR: このチャネルはCSV取込対象外です: ' + channel.channel_id);
  if(!/^\d{4}-\d{2}$/.test(String(meta.salesPeriod||''))) throw new Error('VALIDATION_ERROR: 対象月はYYYY-MM形式で指定してください');
  const bytes = Utilities.base64Decode(String(base64||''));
  if(!bytes.length) throw new Error('VALIDATION_ERROR: ファイルが空です');
  if(bytes.length > ACC_UPLOAD_MAX_BYTES) throw new Error('VALIDATION_ERROR: ファイルサイズが上限（20MB）を超えています');
  const fileName = sanitizeCell_(String(meta.fileName || 'sales.csv')).slice(0, 180);
  const blob = Utilities.newBlob(bytes, 'text/csv', fileName);
  const hash = sha256Bytes_(bytes);
  const dup = accFindBatchByHash_('Sales_Import_Batches', hash);
  if(dup) throw new Error('DATA_CONFLICT: 同一内容のファイルが取込済みです（' + dup.import_batch_id + '／' + dup.status + '）。訂正版は取り直しの上、旧バッチを差替えてください。');
  const saved = accSaveOriginalFile_(channel.channel_id, blob);
  const batchId = newId_('IMB');
  appendRowsBulk_(ssAccYear_(), 'Sales_Import_Batches', [{
    import_batch_id: batchId, channel_id: channel.channel_id, sales_period: meta.salesPeriod,
    file_name: fileName, drive_file_id: saved.drive_file_id, file_hash: saved.file_hash,
    parser_version: '', source_row_count: '', source_total_amount: '',
    normalized_row_count: '', normalized_total_amount: '',
    status: 'UPLOADED', supersedes_batch_id: '', imported_by: actor.email,
    imported_at: new Date().toISOString(), started_at: '', finished_at: '', error_summary: '',
  }]);
  logEvent_('sales_import', batchId, actor.email, null, { channel: channel.channel_id, period: meta.salesPeriod, file: fileName });
  return { import_batch_id: batchId, file_hash: saved.file_hash, size: saved.size };
}

/** 取込前プレビュー（書込みなし）：先頭10件・原票行数・原票合計・警告。 */
function admin_accountingPreviewImport(importBatchId){
  requireRole_([]);
  const batch = accImportBatch_(importBatchId);
  const parsed = accParseBatch_(batch);
  return {
    import_batch_id: batch.import_batch_id, channel_id: batch.channel_id, sales_period: batch.sales_period,
    parser_version: parsed.parser_version,
    source_row_count: parsed.source_row_count, source_total_amount: parsed.source_total_amount,
    normalized_row_count: parsed.rows.length,
    normalized_total_amount: parsed.rows.reduce(function(s, r){ return s + r.license_fee_amount; }, 0),
    preview: parsed.rows.slice(0, 10).map(function(r){ return {
      source_row_no: r.source_row_no, product_name: r.product_name, external_license_ref: r.external_license_ref,
      quantity: r.quantity, license_fee_amount: r.license_fee_amount }; }),
    warnings: parsed.warnings,
  };
}

/** 取込開始：バッチをPARSINGへ進め、SALES_PARSEジョブを登録する。 */
function admin_accountingStartImport(importBatchId){
  const actor = requireRole_(['ACCOUNTING','OPERATIONS']);
  const batch = accImportBatch_(importBatchId);
  if(batch.status !== 'UPLOADED') throw new Error('DATA_CONFLICT: このバッチは取込済みです（' + batch.status + '）');
  upsertRowsBulk_(ssAccYear_(), 'Sales_Import_Batches', 'import_batch_id', [{
    import_batch_id: importBatchId, status: 'PARSING', started_at: new Date().toISOString() }]);
  const jobId = enqueueAccountingJob_('SALES_PARSE', importBatchId, {});
  logEvent_('sales_import', importBatchId, actor.email, { status: 'UPLOADED' }, { status: 'PARSING', job_id: jobId });
  return { job_id: jobId };
}

/** 取込バッチ一覧（直近100件）。 */
function admin_accountingListImports(filters){
  requireRole_([]);
  const f = filters || {};
  return readTableBulk_(ssAccYear_(), 'Sales_Import_Batches')
    .filter(function(b){ return (!f.channelId || b.channel_id === f.channelId) && (!f.status || b.status === f.status); })
    .slice(-100).reverse()
    .map(function(b){ return {
      import_batch_id: b.import_batch_id, channel_id: b.channel_id, sales_period: b.sales_period,
      file_name: b.file_name, status: b.status,
      source_row_count: b.source_row_count, source_total_amount: b.source_total_amount,
      normalized_row_count: b.normalized_row_count, normalized_total_amount: b.normalized_total_amount,
      imported_by: b.imported_by, imported_at: String(b.imported_at||'').slice(0,16).replace('T',' '),
      error_summary: b.error_summary }; });
}

/** 旧バッチの差替え（訂正版取込後）。旧バッチと明細をSUPERSEDEDにする。 */
function admin_accountingSupersedeImport(oldBatchId, newBatchId, reason){
  const actor = requireRole_(['ACCOUNTING']);
  if(!String(reason||'').trim()) throw new Error('VALIDATION_ERROR: 差替え理由は必須です');
  const oldB = accImportBatch_(oldBatchId);
  const newB = accImportBatch_(newBatchId);
  if(oldB.status === 'SUPERSEDED') throw new Error('DATA_CONFLICT: 旧バッチは差替え済みです');
  const yearSs = ssAccYear_();
  const rows = readTableBulk_(yearSs, 'Sales_Ledger').filter(function(r){ return r.import_batch_id === oldBatchId; });
  const allocated = rows.some(function(r){ return r.allocation_status === 'ALLOCATED' || r.allocation_status === 'POSTED'; });
  if(allocated) throw new Error('DATA_CONFLICT: 配分済みの明細があります。先に配分runを取消（VOID）してください');
  upsertRowsBulk_(yearSs, 'Sales_Import_Batches', 'import_batch_id', [
    { import_batch_id: oldBatchId, status: 'SUPERSEDED', error_summary: sanitizeCell_('差替え: ' + reason) },
    { import_batch_id: newBatchId, supersedes_batch_id: oldBatchId }]);
  upsertRowsBulk_(yearSs, 'Sales_Ledger', 'sales_row_id',
    rows.map(function(r){ return { sales_row_id: r.sales_row_id, match_status: 'SUPERSEDED', allocation_status: 'SUPERSEDED' }; }));
  logEvent_('sales_import', oldBatchId, actor.email, { status: oldB.status },
    { status: 'SUPERSEDED', superseded_by: newBatchId, reason: String(reason) });
  return true;
}

// ============================================================
// 取込ジョブ本体（SALES_PARSE）。カーソル＝書込み済み正規化行数。
// ============================================================
function accJobSalesParse_(job){
  const yearSs = ssAccYear_();
  const batch = accImportBatch_(job.target_id);
  if(batch.status === 'SUPERSEDED' || batch.status === 'ERROR') return { done: true, cursor: 0, processed: 0 };
  let parsed;
  try{
    parsed = accParseBatch_(batch);
  }catch(err){
    // 形式不正は再試行しても回復しない：バッチをERRORで確定しジョブは完了
    upsertRowsBulk_(yearSs, 'Sales_Import_Batches', 'import_batch_id', [{
      import_batch_id: batch.import_batch_id, status: 'ERROR',
      finished_at: new Date().toISOString(), error_summary: sanitizeCell_(String(err && err.message || err).slice(0, 300)) }]);
    logError_('VALIDATION_ERROR', 'salesParse', err, { import_batch_id: batch.import_batch_id });
    return { done: true, cursor: 0, processed: 0 };
  }
  const total = parsed.rows.length;
  let cursor = num_(job.cursor) || 0;
  const nowIso = new Date().toISOString();
  // 再実行時の重複防止（§8.3）：既存 sales_row_id を1回だけ読込み
  const existing = {};
  readTableBulk_(yearSs, 'Sales_Ledger').forEach(function(x){ if(x.import_batch_id === batch.import_batch_id) existing[x.sales_row_id] = true; });
  while(cursor < total){
    if(Date.now() > job.deadlineMs - 30 * 1000) return { done: false, cursor: cursor, processed: 0, total: total };
    const part = parsed.rows.slice(cursor, cursor + job.chunk).map(function(r){
      return {
        sales_row_id: batch.import_batch_id + ':' + r.source_row_no,   // 冪等キー（再実行で重複しない）
        import_batch_id: batch.import_batch_id, source_row_no: r.source_row_no,
        channel_id: batch.channel_id, sales_period: batch.sales_period,
        source_product_id: sanitizeCell_(String(r.source_product_id||'')), source_project_id: sanitizeCell_(String(r.source_project_id||'')),
        product_name: sanitizeCell_(String(r.product_name||'').slice(0,200)), seller_name: sanitizeCell_(String(r.seller_name||'').slice(0,120)),
        external_license_ref: sanitizeCell_(String(r.external_license_ref||'')),
        unit_price: r.unit_price, quantity: r.quantity, boost_amount: r.boost_amount,
        gross_sales_amount: r.gross_sales_amount, platform_net_sales_amount: r.platform_net_sales_amount,
        license_fee_amount: r.license_fee_amount, currency: 'JPY',
        raw_row_hash: r.raw_row_hash, match_status: 'PENDING', allocation_status: 'PENDING', created_at: nowIso,
      };
    });
    appendRowsBulk_(yearSs, 'Sales_Ledger', part.filter(function(p){ return !(p.sales_row_id in existing); }));
    part.forEach(function(p){ existing[p.sales_row_id] = true; });
    cursor += part.length;
  }
  const normTotal = parsed.rows.reduce(function(s, r){ return s + r.license_fee_amount; }, 0);
  upsertRowsBulk_(yearSs, 'Sales_Import_Batches', 'import_batch_id', [{
    import_batch_id: batch.import_batch_id, status: 'MATCHING', parser_version: parsed.parser_version,
    source_row_count: parsed.source_row_count, source_total_amount: parsed.source_total_amount,
    normalized_row_count: total, normalized_total_amount: normTotal,
    finished_at: new Date().toISOString(),
    error_summary: parsed.warnings.length ? sanitizeCell_(parsed.warnings.slice(0,5).join(' / ').slice(0,300)) : '',
  }]);
  enqueueAccountingJob_('SALES_MATCH', batch.import_batch_id, {});
  return { done: true, cursor: cursor, processed: total, total: total };
}

// ============================================================
// パーサー（§7）。共通IF：{ parser_version, source_row_count, source_total_amount, rows, warnings }
// ============================================================
function accParseBatch_(batch){
  const channel = accChannel_(batch.channel_id);
  const blob = DriveApp.getFileById(batch.drive_file_id).getBlob();
  const text = blob.getDataAsString(channel.default_encoding || 'UTF-8');
  return parseSalesFile_(text, { parser_type: channel.parser_type, channel_id: channel.channel_id, sales_period: batch.sales_period });
}
function parseSalesFile_(text, context){
  const grid = Utilities.parseCsv(String(text||'').replace(/^﻿/, ''));
  if(!grid.length) throw new Error('原票が空です');
  switch(context.parser_type){
    case 'BOOTH':  return accParseBooth_(grid, context);
    case 'TALTO':  return accParseTalto_(grid, context);
    case 'DLSITE': return accParseDlsite_(grid, context);
    default: throw new Error('未対応のパーサー: ' + context.parser_type);
  }
}
/** ヘッダ行から列位置を解決。必須列が無ければ取込停止（§7.5）。 */
function accHeaderIndex_(headerRow, required){
  const idx = {};
  headerRow.forEach(function(h, i){ idx[String(h).trim()] = i; });
  const missing = required.filter(function(c){ return !(c in idx); });
  if(missing.length) throw new Error('CSVヘッダが想定と一致しません（不足: ' + missing.join('、') + '）。チャネル選択とファイルを確認してください。');
  return idx;
}
/** 金額・数量の検証つき変換（空欄・不正文字・負数を拒否・§7.5）。 */
function accAmount_(value, label, rowNo, opts){
  const s = String(value === undefined || value === null ? '' : value).replace(/[¥￥,\s円]/g, '');
  if(s === ''){ if(opts && opts.optional) return 0; throw new Error(rowNo + '行目: ' + label + 'が空欄です'); }
  const n = Number(s);
  if(!isFinite(n)) throw new Error(rowNo + '行目: ' + label + 'が数値ではありません: ' + String(value).slice(0,20));
  if(n < 0) throw new Error(rowNo + '行目: ' + label + 'が負数です: ' + n);
  return n;
}
function accRowHash_(context, rowNo, cells){
  return sha256Bytes_(Utilities.newBlob(context.channel_id + '|' + context.sales_period + '|' + rowNo + '|' + cells.join('')).getBytes());
}

/** BOOTH（ピクシブ）明細（§7.1）。 */
function accParseBooth_(grid, context){
  const idx = accHeaderIndex_(grid[0], ['商品番号','商品名','SPLL申請番号','小売価格','数量','売上（税込）','ライセンス料（税込）']);
  const shopIdx = grid[0].findIndex(function(h){ return String(h).trim() === 'ショップ名'; });
  const boostIdx = grid[0].findIndex(function(h){ return String(h).trim() === 'BOOST計'; });
  const rows = [], warnings = [];
  let totalFee = 0;
  for(let i = 1; i < grid.length; i++){
    const c = grid[i];
    if(!c.length || c.every(function(x){ return String(x).trim() === ''; })) continue;
    const rowNo = i + 1;
    const fee = accAmount_(c[idx['ライセンス料（税込）']], 'ライセンス料（税込）', rowNo);
    totalFee += fee;
    rows.push({
      source_row_no: rowNo,
      seller_name: shopIdx >= 0 ? c[shopIdx] : '',
      source_product_id: c[idx['商品番号']], product_name: c[idx['商品名']],
      external_license_ref: c[idx['SPLL申請番号']],
      unit_price: accAmount_(c[idx['小売価格']], '小売価格', rowNo, {optional:true}),
      quantity: accAmount_(c[idx['数量']], '数量', rowNo),
      boost_amount: boostIdx >= 0 ? accAmount_(c[boostIdx], 'BOOST計', rowNo, {optional:true}) : 0,
      gross_sales_amount: accAmount_(c[idx['売上（税込）']], '売上（税込）', rowNo, {optional:true}),
      platform_net_sales_amount: '',
      license_fee_amount: fee,
      raw_row_hash: accRowHash_(context, rowNo, c),
    });
  }
  return { parser_version: 'BOOTH_v1', source_row_count: rows.length, source_total_amount: totalFee, rows: rows, warnings: warnings };
}

/** TALTO（ココフォリア）明細（§7.2）。先頭に集計期間・総額のプリアンブルがある形式。 */
function accParseTalto_(grid, context){
  let headerRowIdx = -1;
  for(let i = 0; i < Math.min(grid.length, 20); i++){
    if(grid[i].some(function(h){ return String(h).trim() === '許諾番号'; })){ headerRowIdx = i; break; }
  }
  if(headerRowIdx < 0) throw new Error('CSVヘッダが想定と一致しません（「許諾番号」行が見つかりません）。チャネル選択とファイルを確認してください。');
  const header = grid[headerRowIdx];
  const idx = accHeaderIndex_(header, ['許諾番号','作品名','販売数','販売許諾料小計']);
  const projIdx = header.findIndex(function(h){ return String(h).trim() === 'プロジェクトID'; });
  const grossIdx = header.findIndex(function(h){ return String(h).trim() === '販売額計'; });
  const netIdx = header.findIndex(function(h){ return String(h).trim() === '売上計'; });
  // プリアンブルの総額（あれば照合用の警告に使う）
  const warnings = [];
  const rows = [];
  let totalFee = 0;
  for(let i = headerRowIdx + 1; i < grid.length; i++){
    const c = grid[i];
    if(!c.length || c.every(function(x){ return String(x).trim() === ''; })) continue;
    if(String(c[idx['許諾番号']]).trim() === '') continue;   // 集計行等はスキップ
    const rowNo = i + 1;
    const fee = accAmount_(c[idx['販売許諾料小計']], '販売許諾料小計', rowNo);
    totalFee += fee;
    rows.push({
      source_row_no: rowNo,
      seller_name: '',
      source_product_id: '', source_project_id: projIdx >= 0 ? c[projIdx] : '',
      product_name: c[idx['作品名']],
      external_license_ref: c[idx['許諾番号']],
      unit_price: '', quantity: accAmount_(c[idx['販売数']], '販売数', rowNo),
      boost_amount: 0,
      gross_sales_amount: grossIdx >= 0 ? accAmount_(c[grossIdx], '販売額計', rowNo, {optional:true}) : '',
      platform_net_sales_amount: netIdx >= 0 ? accAmount_(c[netIdx], '売上計', rowNo, {optional:true}) : '',
      license_fee_amount: fee,
      raw_row_hash: accRowHash_(context, rowNo, c),
    });
  }
  return { parser_version: 'TALTO_v1', source_row_count: rows.length, source_total_amount: totalFee, rows: rows, warnings: warnings };
}

/** DLsite（エイシス）明細（§7.3）。 */
function accParseDlsite_(grid, context){
  const idx = accHeaderIndex_(grid[0], ['DLsite作品ID','作品名','SPLL申請番号','販売本数','ライセンス料合計']);
  const rows = [], warnings = [];
  let totalFee = 0;
  for(let i = 1; i < grid.length; i++){
    const c = grid[i];
    if(!c.length || c.every(function(x){ return String(x).trim() === ''; })) continue;
    const rowNo = i + 1;
    const fee = accAmount_(c[idx['ライセンス料合計']], 'ライセンス料合計', rowNo);
    totalFee += fee;
    rows.push({
      source_row_no: rowNo,
      seller_name: '',
      source_product_id: c[idx['DLsite作品ID']], product_name: c[idx['作品名']],
      external_license_ref: c[idx['SPLL申請番号']],
      unit_price: '', quantity: accAmount_(c[idx['販売本数']], '販売本数', rowNo),
      boost_amount: 0, gross_sales_amount: '', platform_net_sales_amount: '',
      license_fee_amount: fee,
      raw_row_hash: accRowHash_(context, rowNo, c),
    });
  }
  return { parser_version: 'DLSITE_v1', source_row_count: rows.length, source_total_amount: totalFee, rows: rows, warnings: warnings };
}

// ============================================================
// 内部ヘルパー
// ============================================================
function accChannel_(channelId){
  const ch = readTableBulk_(ssAccMaster_(), 'Sales_Channels').find(function(c){ return c.channel_id === String(channelId||'') && String(c.active) !== 'false'; });
  if(!ch) throw new Error('DATA_NOT_FOUND: 販売チャネルがありません: ' + channelId);
  return ch;
}
function accImportBatch_(importBatchId){
  const b = readTableBulk_(ssAccYear_(), 'Sales_Import_Batches').find(function(x){ return x.import_batch_id === String(importBatchId||''); });
  if(!b) throw new Error('DATA_NOT_FOUND: 取込バッチがありません: ' + importBatchId);
  return b;
}
