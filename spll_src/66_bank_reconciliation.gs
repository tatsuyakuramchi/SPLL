/**
 * SPLL 66_bank_reconciliation ― 銀行明細取込・入金照合（経理設計書 SPLL-SYS-AD-001 §6.4/§7.4/§12.4）
 *   ・三菱UFJ銀行CSV（レコード種別判定・取引行のみ登録）
 *   ・プラットフォーム入金（チャネル×対象月×名義×金額）／直接入金（未入金Invoice×金額）の候補提示
 *   ・自動候補は自動確定しない。確定は担当者操作（1入金→複数対象／複数入金→1対象に対応）
 */

// ============================================================
// 銀行明細の取込（§7.4）
// ============================================================
function admin_accountingUploadBankFile(meta, base64){
  const actor = requireRole_(['ACCOUNTING']);
  meta = meta || {};
  const bytes = Utilities.base64Decode(String(base64 || ''));
  if(!bytes.length) throw new Error('VALIDATION_ERROR: ファイルが空です');
  if(bytes.length > ACC_UPLOAD_MAX_BYTES) throw new Error('VALIDATION_ERROR: ファイルサイズが上限（20MB）を超えています');
  const hash = sha256Bytes_(bytes);
  const dup = accFindBatchByHash_('Bank_Import_Batches', hash);
  if(dup) throw new Error('DATA_CONFLICT: 同一内容の銀行明細が取込済みです（' + dup.bank_import_batch_id + '）');
  const fileName = sanitizeCell_(String(meta.fileName || 'bank.csv')).slice(0, 180);
  const blob = Utilities.newBlob(bytes, 'text/csv', fileName);
  const saved = accSaveOriginalFile_('BANK', blob);
  const text = blob.getDataAsString(meta.encoding || 'Shift_JIS');
  const parsed = accParseMufg_(Utilities.parseCsv(String(text).replace(/^﻿/, '')));
  const batchId = newId_('BKB');
  const yearSs = ssAccYear_();
  appendRowsBulk_(yearSs, 'Bank_Import_Batches', [{
    bank_import_batch_id: batchId, bank_code: meta.bankCode || 'MUFG', account_key: sanitizeCell_(String(meta.accountKey || '')),
    file_name: fileName, drive_file_id: saved.drive_file_id, file_hash: saved.file_hash,
    source_row_count: parsed.rows.length, status: 'IMPORTED',
    imported_by: actor.email, imported_at: new Date().toISOString(), error_summary: parsed.warnings.join(' / ').slice(0, 300),
  }]);
  appendRowsBulk_(yearSs, 'Bank_Transactions', parsed.rows.map(function(r, i){ return {
    bank_transaction_id: batchId + ':' + r.source_row_no, bank_import_batch_id: batchId,
    source_row_no: r.source_row_no, transaction_date: r.transaction_date, transaction_type: sanitizeCell_(r.transaction_type),
    payer_name_raw: sanitizeCell_(r.payer_name_raw), payer_name_normalized: accNormalizePayer_(r.payer_name_raw),
    debit_amount: r.debit_amount, credit_amount: r.credit_amount, balance: r.balance,
    raw_row_hash: r.raw_row_hash, match_status: 'UNMATCHED', created_at: new Date().toISOString(),
  }; }));
  logEvent_('bank_import', batchId, actor.email, null, { rows: parsed.rows.length, file: fileName });
  return { bank_import_batch_id: batchId, rows: parsed.rows.length, warnings: parsed.warnings };
}

/** 三菱UFJ銀行CSV：レコード種別（1=ヘッダ／2=取引／9=合計）を判定し取引行のみ返す。 */
function accParseMufg_(grid){
  const rows = [], warnings = [];
  let sawHeader = false, sawTrailer = false;
  for(let i = 0; i < grid.length; i++){
    const c = grid[i];
    if(!c.length || c.every(function(x){ return String(x).trim() === ''; })) continue;
    const kind = String(c[0]).trim();
    if(kind === '1'){ sawHeader = true; continue; }
    if(kind === '9' || kind === '8'){ sawTrailer = true; continue; }
    if(kind !== '2'){
      // 見出し行（日本語ヘッダ）の可能性：日付らしくなければスキップ
      if(!/^\d/.test(String(c[1] || ''))){ continue; }
      warnings.push((i + 1) + '行目: 不明なレコード種別 ' + kind);
      continue;
    }
    const rowNo = i + 1;
    rows.push({
      source_row_no: rowNo,
      transaction_date: String(c[1] || '').trim(),
      transaction_type: String(c[2] || '').trim(),
      payer_name_raw: String(c[3] || '').trim(),
      debit_amount: accAmount_(c[4], '支払金額', rowNo, { optional: true }),
      credit_amount: accAmount_(c[5], '預り金額', rowNo, { optional: true }),
      balance: accAmount_(c[6], '残高', rowNo, { optional: true }),
      raw_row_hash: sha256Bytes_(Utilities.newBlob('BANK|' + rowNo + '|' + c.join('')).getBytes()),
    });
  }
  if(!rows.length) throw new Error('取引行（レコード種別2）が見つかりません。ファイル形式を確認してください。');
  return { rows: rows, warnings: warnings };
}

/** 振込名義の正規化：全半角・空白・法人格表記のゆらぎを吸収。 */
function accNormalizePayer_(v){
  return String(v || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(ch){ return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
    .replace(/[\s　]/g, '')
    .replace(/株式会社|有限会社|合同会社|（株）|\(株\)|（有）|\(有\)|ｶ\)|ｶ）|カ\)|カ）|（カ|\(ｶ/g, '')
    .toUpperCase();
}

function admin_accountingListBankTransactions(filters, page){ requireRole_([]);
  const f = filters || {};
  const all = readTableBulk_(ssAccYear_(), 'Bank_Transactions')
    .filter(function(t){ return (!f.status || t.match_status === f.status) &&
      (!f.creditOnly || num_(t.credit_amount) > 0); });
  const p = Math.max(1, num_(page) || 1), size = 100;
  return { total: all.length, page: p, rows: all.slice((p - 1) * size, p * size).map(function(t){ return {
    bank_transaction_id: t.bank_transaction_id, transaction_date: t.transaction_date,
    payer_name_raw: t.payer_name_raw, debit_amount: t.debit_amount, credit_amount: t.credit_amount,
    match_status: t.match_status }; }) };
}

// ============================================================
// 照合候補の提示（§6.4）。自動確定しない。
// ============================================================
function admin_accountingSuggestReconciliations(period){ requireRole_([]);
  const yearSs = ssAccYear_();
  const txs = readTableBulk_(yearSs, 'Bank_Transactions')
    .filter(function(t){ return t.match_status === 'UNMATCHED' && num_(t.credit_amount) > 0; });
  const suggestions = [];
  // 1) プラットフォーム入金：チャネル名義×取込バッチ合計
  const channels = readTableBulk_(ssAccMaster_(), 'Sales_Channels').filter(function(c){ return c.statement_basis === 'PLATFORM'; });
  const batches = readTableBulk_(yearSs, 'Sales_Import_Batches')
    .filter(function(b){ return ['READY','ALLOCATED','APPROVED','POSTED','EXPORTED'].indexOf(b.status) >= 0 &&
      (!period || b.sales_period === period); });
  batches.forEach(function(b){
    const ch = channels.find(function(c){ return c.channel_id === b.channel_id; });
    if(!ch) return;
    let aliases = []; try{ aliases = JSON.parse(ch.payer_aliases_json || '[]'); }catch(e){}
    const aliasNorm = aliases.map(accNormalizePayer_).filter(Boolean);
    const expected = num_(b.normalized_total_amount) || 0;
    const candidates = txs.filter(function(t){
      const payerHit = aliasNorm.some(function(a){ return String(t.payer_name_normalized).indexOf(a) >= 0; });
      const amountHit = num_(t.credit_amount) === expected;
      return payerHit || amountHit;
    }).map(function(t){ return accTxSummary_(t, expected); });
    if(candidates.length) suggestions.push({
      target_type: 'PLATFORM_BATCH', target_id: b.import_batch_id,
      label: ch.channel_name + ' ' + b.sales_period, expected_amount: expected, candidates: candidates.slice(0, 5) });
  });
  // 2) 直接入金：未入金Invoice×金額・摘要/名義内の契約参照
  const invoices = readRows_(ssOps_(), 'Invoices')
    .filter(function(v){ return ['ISSUED','UNPAID','PARTIALLY_PAID'].indexOf(String(v.status)) >= 0; });
  invoices.forEach(function(v){
    const balance = num_(v.balance_amount) || num_(v.total_amount) || 0;
    if(!(balance > 0)) return;
    const refKey = accNormalizePayer_(String(v.contract_id || '').replace(/[^A-Za-z0-9]/g, ''));
    const candidates = txs.filter(function(t){
      const amountHit = num_(t.credit_amount) === balance;
      const refHit = refKey && String(t.payer_name_normalized).replace(/[^A-Z0-9]/g, '').indexOf(refKey) >= 0;
      return amountHit || refHit;
    }).map(function(t){ return accTxSummary_(t, balance); });
    if(candidates.length) suggestions.push({
      target_type: 'INVOICE', target_id: v.invoice_id, contract_id: v.contract_id,
      label: '請求 ' + v.invoice_id + '（' + v.contract_id + '）', expected_amount: balance, candidates: candidates.slice(0, 5) });
  });
  return suggestions.slice(0, 50);
}
function accTxSummary_(t, expected){
  return { bank_transaction_id: t.bank_transaction_id, transaction_date: t.transaction_date,
    payer_name_raw: t.payer_name_raw, credit_amount: t.credit_amount,
    exact: num_(t.credit_amount) === expected };
}

// ============================================================
// 照合の確定・取消（§6.4/§12.4）
// ============================================================
function admin_accountingConfirmReconciliation(payload){
  const actor = requireRole_(['ACCOUNTING']);
  payload = payload || {};
  const targetType = String(payload.target_type || '');
  if(['PLATFORM_BATCH','INVOICE','UNIDENTIFIED'].indexOf(targetType) < 0)
    throw new Error('VALIDATION_ERROR: 不正なtarget_type: ' + targetType);
  const lines = payload.lines || [];
  if(!lines.length) throw new Error('VALIDATION_ERROR: 充当する入金明細を指定してください');
  const yearSs = ssAccYear_();
  const txIdx = buildIndex_(readTableBulk_(yearSs, 'Bank_Transactions'), function(t){ return t.bank_transaction_id; });
  let applied = 0;
  lines.forEach(function(l){
    const t = txIdx[l.bank_transaction_id];
    if(!t) throw new Error('DATA_NOT_FOUND: 入金明細がありません: ' + l.bank_transaction_id);
    const a = num_(l.applied_amount);
    if(!(a > 0)) throw new Error('VALIDATION_ERROR: 充当額は正の数で指定してください');
    if(a > num_(t.credit_amount)) throw new Error('VALIDATION_ERROR: 充当額が入金額を超えています: ' + l.bank_transaction_id);
    applied += a;
  });
  const expected = num_(payload.expected_amount) || applied;
  const recId = newId_('RCN');
  const nowIso = new Date().toISOString();
  appendRowsBulk_(yearSs, 'Bank_Reconciliations', [{
    reconciliation_id: recId, target_type: targetType, target_id: payload.target_id || '',
    expected_amount: expected, applied_amount: applied, difference_amount: expected - applied,
    status: 'CONFIRMED', confirmed_by: actor.email, confirmed_at: nowIso,
    note: sanitizeCell_(String(payload.note || '')),
  }]);
  appendRowsBulk_(yearSs, 'Bank_Reconciliation_Lines', lines.map(function(l, i){ return {
    reconciliation_line_id: recId + ':' + (i + 1), reconciliation_id: recId,
    bank_transaction_id: l.bank_transaction_id, applied_amount: num_(l.applied_amount), created_at: nowIso,
  }; }));
  // 取引側の状態：全額充当済みならMATCHED、部分ならPARTIAL（複数対象への配分に対応）
  const lineAll = readTableBulk_(yearSs, 'Bank_Reconciliation_Lines');
  const recAll = buildIndex_(readTableBulk_(yearSs, 'Bank_Reconciliations'), function(r){ return r.reconciliation_id; });
  const updates = {};
  lines.forEach(function(l){
    const t = txIdx[l.bank_transaction_id];
    const sum = lineAll.filter(function(x){ return x.bank_transaction_id === l.bank_transaction_id &&
      recAll[x.reconciliation_id] && recAll[x.reconciliation_id].status === 'CONFIRMED'; })
      .reduce(function(s, x){ return s + (num_(x.applied_amount) || 0); }, 0);
    updates[l.bank_transaction_id] = sum >= num_(t.credit_amount) ? 'MATCHED' : 'PARTIAL';
  });
  upsertRowsBulk_(yearSs, 'Bank_Transactions', 'bank_transaction_id',
    Object.keys(updates).map(function(id){ return { bank_transaction_id: id, match_status: updates[id] }; }));
  // 直接入金：希望時は既存の入金記録へ連携（入金参照番号=入金明細IDで二重記録を防止）
  if(targetType === 'INVOICE' && payload.recordPayment){
    const inv = readRows_(ssOps_(), 'Invoices').find(function(v){ return v.invoice_id === payload.target_id; });
    if(inv) lines.forEach(function(l){
      try{ admin_recordPayment(inv.contract_id, inv.invoice_id, num_(l.applied_amount),
        (txIdx[l.bank_transaction_id].transaction_date || nowIso.slice(0,10)), l.bank_transaction_id); }
      catch(e){ logError_('PROCESSING_ERROR', 'bankReconPayment', e, { invoice_id: inv.invoice_id, tx: l.bank_transaction_id }); }
    });
  }
  logEvent_('bank_reconciliation', recId, actor.email, null,
    { target_type: targetType, target_id: payload.target_id || '', applied: applied, expected: expected });
  return { reconciliation_id: recId, applied_amount: applied, difference_amount: expected - applied };
}

function admin_accountingVoidReconciliation(reconciliationId, reason){
  const actor = requireRole_(['ACCOUNTING']);
  if(!String(reason || '').trim()) throw new Error('VALIDATION_ERROR: 取消理由は必須です');
  const yearSs = ssAccYear_();
  const rec = readTableBulk_(yearSs, 'Bank_Reconciliations').find(function(r){ return r.reconciliation_id === String(reconciliationId||''); });
  if(!rec) throw new Error('DATA_NOT_FOUND: 照合がありません: ' + reconciliationId);
  if(rec.status !== 'CONFIRMED') throw new Error('DATA_CONFLICT: 取消済みです');
  upsertRowsBulk_(yearSs, 'Bank_Reconciliations', 'reconciliation_id', [{
    reconciliation_id: rec.reconciliation_id, status: 'VOID', note: sanitizeCell_(String(rec.note || '') + ' / 取消: ' + reason) }]);
  const lines = readTableBulk_(yearSs, 'Bank_Reconciliation_Lines').filter(function(l){ return l.reconciliation_id === rec.reconciliation_id; });
  const recAll = buildIndex_(readTableBulk_(yearSs, 'Bank_Reconciliations'), function(r){ return r.reconciliation_id; });
  const lineAll = readTableBulk_(yearSs, 'Bank_Reconciliation_Lines');
  const txIdx = buildIndex_(readTableBulk_(yearSs, 'Bank_Transactions'), function(t){ return t.bank_transaction_id; });
  const updates = {};
  lines.forEach(function(l){
    const t = txIdx[l.bank_transaction_id]; if(!t) return;
    const sum = lineAll.filter(function(x){ return x.bank_transaction_id === l.bank_transaction_id &&
      recAll[x.reconciliation_id] && recAll[x.reconciliation_id].status === 'CONFIRMED'; })
      .reduce(function(s, x){ return s + (num_(x.applied_amount) || 0); }, 0);
    updates[l.bank_transaction_id] = sum <= 0 ? 'UNMATCHED' : (sum >= num_(t.credit_amount) ? 'MATCHED' : 'PARTIAL');
  });
  upsertRowsBulk_(yearSs, 'Bank_Transactions', 'bank_transaction_id',
    Object.keys(updates).map(function(id){ return { bank_transaction_id: id, match_status: updates[id] }; }));
  logEvent_('bank_reconciliation', rec.reconciliation_id, actor.email, { status: 'CONFIRMED' }, { status: 'VOID', reason: String(reason) });
  return true;
}
function admin_accountingListReconciliations(){ requireRole_([]);
  return readTableBulk_(ssAccYear_(), 'Bank_Reconciliations').slice(-100).reverse()
    .map(function(r){ return { reconciliation_id: r.reconciliation_id, target_type: r.target_type, target_id: r.target_id,
      expected_amount: r.expected_amount, applied_amount: r.applied_amount, difference_amount: r.difference_amount,
      status: r.status, confirmed_by: r.confirmed_by, note: r.note }; });
}
