/**
 * SPLL 68_accounting_export ― 経理・権利者向けファイル生成と既存清算への連携
 * （経理設計書 SPLL-SYS-AD-001 §6.5/§12.5/§12.3 admin_accountingPostSettlements）
 *   ・出力は上書きしない（再生成はversionを増加）。ハッシュ・生成者・承認者を記録
 *   ・権利者別ファイルは権利者フォルダへ保存し、全権利者分のZIPも生成
 *   ・確定配分は既存Settlements系へ source_type=ACCOUNTING_ALLOCATION として二重計上なく連携
 */

// ============================================================
// 出力データの組み立て（run単位）
// ============================================================
function accExportDataset_(runId){
  const yearSs = ssAccYear_();
  const run = accAllocationRun_(runId);
  const details = readTableBulk_(yearSs, 'Allocation_Details')
    .filter(function(d){ return d.allocation_run_id === run.allocation_run_id && d.status === 'CALCULATED'; });
  const ledgerIdx = buildIndex_(readTableBulk_(yearSs, 'Sales_Ledger'), function(r){ return r.sales_row_id; });
  const workIdx = buildIndex_(readRows_(ssMaster_(), 'Works_Master'), function(w){ return w.work_id; });
  const partnerIdx = buildIndex_(readRows_(ssOps_(), 'Partners'), function(p){ return p.partner_id; });
  function workName(id){ return (workIdx[id] && workIdx[id].work_name) || id; }
  function partnerName(id){ return (partnerIdx[id] && partnerIdx[id].name) || id || '（未設定）'; }
  return { run: run, details: details, ledgerIdx: ledgerIdx, workName: workName, partnerName: partnerName };
}

/** 明細行（出力共通形式・§6.5 権利者向け項目）。 */
function accExportDetailRow_(ds, d){
  const s = ds.ledgerIdx[d.sales_row_id] || {};
  return [s.sales_period || ds.run.sales_period, s.channel_id || '', s.external_license_ref || '',
    s.product_name || '', s.seller_name || '', s.unit_price || '', s.quantity || '', s.boost_amount || '',
    d.base_license_fee_amount, ds.workName(d.work_id), d.work_allocation_weight, d.work_allocated_amount,
    ds.partnerName(d.partner_id), d.partner_rate !== '' ? d.partner_rate : '残額', d.allocated_amount,
    d.tax_treatment_snapshot, d.payable_amount];
}
const ACC_EXPORT_DETAIL_HEADER = ['販売月','販売サイト','SPLL番号','二次創作物名','サークル名','販売単価','販売数','BOOST',
  '許諾料','原作名','按分比率','原作按分額','権利者名','配分率','権利者配分額','税処理','支払予定額'];

/** シート配列をSpreadsheetへ一括書込み。 */
function accWriteSheet_(ss, name, header, rows){
  const sh = ss.insertSheet(name);
  const grid = [header].concat(rows || []);
  if(grid.length && header.length) sh.getRange(1, 1, grid.length, header.length)
    .setValues(grid.map(function(r){ const o = r.slice(0, header.length); while(o.length < header.length) o.push(''); return o; }));
  sh.setFrozenRows(1);
  return sh;
}

// ============================================================
// 経理向け出力（§6.5）：LEGACY_V3_07／CONSOLIDATED_V1
// ============================================================
function accJobAccountingExport_(job){
  const detail = job.detail || {};
  accGenerateAccountingExport_(job.target_id, detail.export_profile_id || 'CONSOLIDATED_V1', detail.export_id);
  return { done: true, cursor: 0, processed: 1 };
}
function accGenerateAccountingExport_(runId, profileId, exportId){
  const ds = accExportDataset_(runId);
  const yearSs = ssAccYear_();
  const title = 'SPLL経理_' + profileId + '_' + ds.run.sales_period + '_' + ds.run.allocation_run_id;
  const out = SpreadsheetApp.create(title);
  const detailRows = ds.details.map(function(d){ return accExportDetailRow_(ds, d); });
  // 支払先別集計
  const byPartner = {};
  ds.details.forEach(function(d){
    const k = ds.partnerName(d.partner_id);
    byPartner[k] = byPartner[k] || { amount: 0, payable: 0, count: 0 };
    byPartner[k].amount += num_(d.allocated_amount) || 0; byPartner[k].payable += num_(d.payable_amount) || 0; byPartner[k].count++;
  });
  const partnerRows = Object.keys(byPartner).map(function(k){ return [k, byPartner[k].count, byPartner[k].amount, byPartner[k].payable]; });
  // チャネル別集計・複数原作明細
  const byChannel = {};
  const multiWork = [];
  const rowWorks = {};
  ds.details.forEach(function(d){ (rowWorks[d.sales_row_id] = rowWorks[d.sales_row_id] || {})[d.work_id] = true; });
  ds.details.forEach(function(d){
    const s = ds.ledgerIdx[d.sales_row_id] || {};
    const ch = s.channel_id || '不明';
    byChannel[ch] = byChannel[ch] || { amount: 0, count: 0 };
    byChannel[ch].amount += num_(d.allocated_amount) || 0; byChannel[ch].count++;
    if(Object.keys(rowWorks[d.sales_row_id] || {}).length > 1) multiWork.push(accExportDetailRow_(ds, d));
  });
  const channelRows = Object.keys(byChannel).map(function(k){ return [k, byChannel[k].count, byChannel[k].amount]; });
  const exceptions = ds.details.filter(function(d){ return !d.partner_id; }).map(function(d){ return accExportDetailRow_(ds, d); });

  if(profileId === 'LEGACY_V3_07'){
    accWriteSheet_(out, '説明文', ['SPLL 支払明細（' + ds.run.sales_period + '）'], [
      ['対象配分run', ds.run.allocation_run_id], ['原票許諾料合計', ds.run.source_total_amount],
      ['配分額合計', ds.run.allocated_total_amount], ['差額', ds.run.difference_amount],
      ['作成者', ds.run.prepared_by], ['承認者', ds.run.approved_by]]);
    accWriteSheet_(out, '各社への支払', ['権利者名','明細数','配分額','支払予定額'], partnerRows);
    accWriteSheet_(out, '明細', ACC_EXPORT_DETAIL_HEADER, detailRows);
    accWriteSheet_(out, '複数原作明細①', ACC_EXPORT_DETAIL_HEADER, multiWork.slice(0, 5000));
    accWriteSheet_(out, '複数原作明細②', ACC_EXPORT_DETAIL_HEADER, multiWork.slice(5000));
    ['BOOTH','TALTO','DLSITE'].forEach(function(ch){
      accWriteSheet_(out, ch === 'DLSITE' ? 'DLsite' : ch, ACC_EXPORT_DETAIL_HEADER,
        detailRows.filter(function(r, i){ return (ds.ledgerIdx[ds.details[i].sales_row_id] || {}).channel_id === ch; }));
    });
    accWriteSheet_(out, '直接振込', ACC_EXPORT_DETAIL_HEADER,
      detailRows.filter(function(r, i){ const c = (ds.ledgerIdx[ds.details[i].sales_row_id] || {}).channel_id; return ['BOOTH','TALTO','DLSITE'].indexOf(c) < 0; }));
    accWriteSheet_(out, '原作マスタ', ['work_id','原作名'], readRows_(ssMaster_(), 'Works_Master').map(function(w){ return [w.work_id, w.work_name]; }));
    accWriteSheet_(out, '更新履歴', ['日時','内容','担当'], [[new Date().toISOString(), '自動生成（' + ds.run.allocation_run_id + '）', 'システム']]);
  } else {   // CONSOLIDATED_V1
    accWriteSheet_(out, 'サマリー', ['項目','値'], [
      ['対象月', ds.run.sales_period], ['配分run', ds.run.allocation_run_id],
      ['原票許諾料合計', ds.run.source_total_amount], ['配分額合計', ds.run.allocated_total_amount],
      ['差額', ds.run.difference_amount], ['例外件数', ds.run.exception_count],
      ['作成者', ds.run.prepared_by], ['承認者', ds.run.approved_by]]);
    const recons = readTableBulk_(yearSs, 'Bank_Reconciliations').filter(function(r){ return r.status === 'CONFIRMED'; })
      .map(function(r){ return [r.target_type, r.target_id, r.expected_amount, r.applied_amount, r.difference_amount, r.confirmed_by]; });
    accWriteSheet_(out, '入金照合', ['対象種別','対象','期待額','充当額','差額','確認者'], recons);
    accWriteSheet_(out, 'チャネル別集計', ['チャネル','明細数','配分額'], channelRows);
    accWriteSheet_(out, '支払先別集計', ['権利者名','明細数','配分額','支払予定額'], partnerRows);
    accWriteSheet_(out, '販売明細', ['販売月','チャネル','SPLL番号','商品名','数量','許諾料','突合状態'],
      Object.keys(rowWorks).map(function(id){ const s = ds.ledgerIdx[id] || {};
        return [s.sales_period, s.channel_id, s.external_license_ref, s.product_name, s.quantity, s.license_fee_amount, s.match_status]; }));
    accWriteSheet_(out, '配分明細', ACC_EXPORT_DETAIL_HEADER, detailRows);
    accWriteSheet_(out, '未解決・警告', ACC_EXPORT_DETAIL_HEADER, exceptions);
    accWriteSheet_(out, '原票・計算条件', ['項目','値'], [
      ['対象バッチ', ds.run.import_batch_ids_json], ['ルールスナップショット', ds.run.rule_snapshot_hash]]);
  }
  const hash = sha256Bytes_(Utilities.newBlob(JSON.stringify([detailRows.length, partnerRows, ds.run.allocation_run_id])).getBytes());
  upsertRowsBulk_(yearSs, 'Accounting_Exports', 'export_id', [{
    export_id: exportId, drive_file_id: out.getId(), file_hash: hash,
    status: 'GENERATED', generated_at: new Date().toISOString() }]);
  return out.getId();
}

function admin_accountingGenerateExport(runId, profileId){
  const actor = requireRole_(['ACCOUNTING']);
  const run = accAllocationRun_(runId);
  if(['APPROVED','POSTED','EXPORTED'].indexOf(run.status) < 0)
    throw new Error('DATA_CONFLICT: 承認済みのrunのみ出力できます（' + run.status + '）');
  const prof = readTableBulk_(ssAccMaster_(), 'Accounting_Export_Profiles')
    .find(function(p){ return p.export_profile_id === String(profileId || '') && p.status === 'ACTIVE'; });
  if(!prof) throw new Error('DATA_NOT_FOUND: 出力プロファイルがありません: ' + profileId);
  const yearSs = ssAccYear_();
  // 上書きしない：同run×プロファイルの既存出力があればversionを増加（§6.5）
  const prior = readTableBulk_(yearSs, 'Accounting_Exports')
    .filter(function(e){ return e.allocation_run_id === run.allocation_run_id && e.export_profile_id === prof.export_profile_id; });
  const exportId = newId_('EXP');
  appendRowsBulk_(yearSs, 'Accounting_Exports', [{
    export_id: exportId, allocation_run_id: run.allocation_run_id, export_type: prof.export_type,
    export_profile_id: prof.export_profile_id, template_version: prof.version,
    version: prior.reduce(function(m, e){ return Math.max(m, num_(e.version) || 0); }, 0) + 1,
    drive_file_id: '', zip_file_id: '', file_hash: '', status: 'QUEUED',
    generated_by: actor.email, generated_at: '', approved_by: '', approved_at: '', delivered_at: '',
  }]);
  const jobId = enqueueAccountingJob_('ACCOUNTING_EXPORT', run.allocation_run_id,
    { export_profile_id: prof.export_profile_id, export_id: exportId });
  logEvent_('accounting_export', exportId, actor.email, null, { run: run.allocation_run_id, profile: prof.export_profile_id });
  return { export_id: exportId, job_id: jobId };
}

// ============================================================
// 権利者向け出力（§6.5）：月次・四半期＋ZIP
// ============================================================
function accJobPartnerExport_(job){
  const detail = job.detail || {};
  accGeneratePartnerExports_(job.target_id, detail.period_type || 'MONTHLY', detail.export_id);
  return { done: true, cursor: 0, processed: 1 };
}
function accGeneratePartnerExports_(runId, periodType, exportId){
  const ds = accExportDataset_(runId);
  const yearSs = ssAccYear_();
  const byPartner = {};
  ds.details.forEach(function(d){
    if(!d.partner_id) return;
    (byPartner[d.partner_id] = byPartner[d.partner_id] || []).push(d);
  });
  const year = accCurrentYear_();
  const blobs = [];
  Object.keys(byPartner).forEach(function(pid){
    const pname = ds.partnerName(pid);
    const rows = byPartner[pid].map(function(d){ return accExportDetailRow_(ds, d); });
    const total = byPartner[pid].reduce(function(s, d){ return s + (num_(d.payable_amount) || 0); }, 0);
    const csv = ['権利者名,' + pname, '対象期間,' + ds.run.sales_period + '（' + (periodType === 'QUARTERLY' ? '四半期' : '月次') + '）',
      '支払予定額合計,' + total, '']
      .concat([ACC_EXPORT_DETAIL_HEADER.join(',')])
      .concat(rows.map(function(r){ return r.map(function(c){ const s = String(c === undefined || c === null ? '' : c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(','); }))
      .join('\n');
    const blob = Utilities.newBlob('﻿' + csv, 'text/csv',
      'SPLL_支払明細_' + ds.run.sales_period + '_' + pname + '.csv');
    const folder = accFolder_([year, '03_Partner_Statements', ds.run.sales_period, pname]);
    folder.createFile(blob);
    blobs.push(blob);
  });
  let zipId = '';
  if(blobs.length){
    const zip = Utilities.zip(blobs, 'SPLL_支払明細_' + ds.run.sales_period + '_全権利者.zip');
    zipId = accFolder_([year, '04_Zip']).createFile(zip).getId();
  }
  const hash = sha256Bytes_(Utilities.newBlob(JSON.stringify([Object.keys(byPartner).sort(), ds.run.allocation_run_id])).getBytes());
  upsertRowsBulk_(yearSs, 'Accounting_Exports', 'export_id', [{
    export_id: exportId, zip_file_id: zipId, file_hash: hash,
    status: 'GENERATED', generated_at: new Date().toISOString() }]);
  return { partners: Object.keys(byPartner).length, zip_file_id: zipId };
}

function admin_accountingGeneratePartnerExports(runId, periodType){
  const actor = requireRole_(['ACCOUNTING']);
  const run = accAllocationRun_(runId);
  if(['APPROVED','POSTED','EXPORTED'].indexOf(run.status) < 0)
    throw new Error('DATA_CONFLICT: 承認済みのrunのみ出力できます（' + run.status + '）');
  const type = periodType === 'QUARTERLY' ? 'PARTNER_QUARTERLY_V1' : 'PARTNER_MONTHLY_V1';
  const yearSs = ssAccYear_();
  const prior = readTableBulk_(yearSs, 'Accounting_Exports')
    .filter(function(e){ return e.allocation_run_id === run.allocation_run_id && e.export_profile_id === type; });
  const exportId = newId_('EXP');
  appendRowsBulk_(yearSs, 'Accounting_Exports', [{
    export_id: exportId, allocation_run_id: run.allocation_run_id, export_type: 'PARTNER',
    export_profile_id: type, template_version: 1,
    version: prior.reduce(function(m, e){ return Math.max(m, num_(e.version) || 0); }, 0) + 1,
    drive_file_id: '', zip_file_id: '', file_hash: '', status: 'QUEUED',
    generated_by: actor.email, generated_at: '', approved_by: '', approved_at: '', delivered_at: '',
  }]);
  const jobId = enqueueAccountingJob_('PARTNER_EXPORT', run.allocation_run_id,
    { period_type: periodType === 'QUARTERLY' ? 'QUARTERLY' : 'MONTHLY', export_id: exportId });
  logEvent_('accounting_export', exportId, actor.email, null, { run: run.allocation_run_id, type: type });
  return { export_id: exportId, job_id: jobId };
}

function admin_accountingListExports(){ requireRole_([]);
  return readTableBulk_(ssAccYear_(), 'Accounting_Exports').slice(-50).reverse()
    .map(function(e){ return { export_id: e.export_id, allocation_run_id: e.allocation_run_id,
      export_profile_id: e.export_profile_id, version: e.version, status: e.status,
      drive_file_id: e.drive_file_id, zip_file_id: e.zip_file_id,
      generated_by: e.generated_by, generated_at: String(e.generated_at || '').slice(0, 16).replace('T', ' '),
      approved_by: e.approved_by }; });
}
function admin_accountingApproveExport(exportId){
  const actor = requireRole_(['ACCOUNTING']);
  const yearSs = ssAccYear_();
  const e = readTableBulk_(yearSs, 'Accounting_Exports').find(function(x){ return x.export_id === String(exportId||''); });
  if(!e) throw new Error('DATA_NOT_FOUND: 出力がありません: ' + exportId);
  if(e.status !== 'GENERATED') throw new Error('DATA_CONFLICT: 承認できる状態ではありません（' + e.status + '）');
  upsertRowsBulk_(yearSs, 'Accounting_Exports', 'export_id', [{
    export_id: e.export_id, status: 'APPROVED', approved_by: actor.email, approved_at: new Date().toISOString() }]);
  const run = accAllocationRun_(e.allocation_run_id);
  if(run.status === 'POSTED' || run.status === 'APPROVED')
    upsertRowsBulk_(yearSs, 'Allocation_Runs', 'allocation_run_id', [{ allocation_run_id: run.allocation_run_id, status: 'EXPORTED' }]);
  logEvent_('accounting_export', e.export_id, actor.email, { status: 'GENERATED' }, { status: 'APPROVED' });
  return true;
}

// ============================================================
// 既存清算への連携（§12.3/§9.4）：権利者別確定額のみ・二重計上防止
// ============================================================
function admin_accountingPostSettlements(runId){
  const actor = requireRole_(['ACCOUNTING']);
  return accPostSettlements_(runId, actor.email);
}
function accJobSettlementPost_(job){
  accPostSettlements_(job.target_id, 'system');
  return { done: true, cursor: 0, processed: 1 };
}
function accPostSettlements_(runId, actorEmail){
  const yearSs = ssAccYear_();
  const run = accAllocationRun_(runId);
  const ops = ssOps_();
  // 二重計上防止（§8.3/§21）：同一runの連携済みがあれば状態に関わらず拒否
  if(readRows_(ops, 'Settlement_Details').some(function(d){ return d.source_type === 'ACCOUNTING_ALLOCATION' && d.source_id === run.allocation_run_id; }))
    throw new Error('DATA_CONFLICT: このrunは清算連携済みです（二重計上防止）');
  if(['APPROVED','EXPORTED'].indexOf(run.status) < 0)
    throw new Error('DATA_CONFLICT: 承認済みのrunのみ清算連携できます（' + run.status + '）');
  const details = readTableBulk_(yearSs, 'Allocation_Details')
    .filter(function(d){ return d.allocation_run_id === run.allocation_run_id && d.status === 'CALCULATED' && d.partner_id; });
  // 権利者×原作で集約して連携（明細粒度は経理台帳が正本）
  const agg = {};
  details.forEach(function(d){
    const k = d.partner_id + '|' + d.work_id;
    agg[k] = agg[k] || { partner_id: d.partner_id, work_id: d.work_id, amount: 0, detail_ids: 0 };
    agg[k].amount += num_(d.payable_amount) || 0; agg[k].detail_ids++;
  });
  const byPartner = {};
  Object.keys(agg).forEach(function(k){
    const a = agg[k];
    (byPartner[a.partner_id] = byPartner[a.partner_id] || []).push(a);
  });
  const nowIso = new Date().toISOString();
  let settlements = 0;
  Object.keys(byPartner).forEach(function(pid){
    const items = byPartner[pid];
    const total = items.reduce(function(s, a){ return s + a.amount; }, 0);
    const settlementId = newId_('STL');
    appendRow_(ops, 'Settlements', { settlement_id: settlementId, partner_id: pid,
      period: run.sales_period, amount: total, status: 'CONFIRMED', hold_reason: '' });
    items.forEach(function(a, i){
      appendRow_(ops, 'Settlement_Details', { settlement_detail_id: settlementId + ':' + (i + 1),
        settlement_id: settlementId, contract_id: '', report_id: '', work_id: a.work_id, partner_id: pid,
        allocation_scheme: 'ACCOUNTING', allocation_ratio: '', rate_snapshot: '', amount: a.amount,
        source_type: 'ACCOUNTING_ALLOCATION', source_id: run.allocation_run_id,
        accounting_allocation_detail_id: a.detail_ids + '件集約' });
    });
    settlements++;
  });
  upsertRowsBulk_(yearSs, 'Allocation_Runs', 'allocation_run_id', [{
    allocation_run_id: run.allocation_run_id, status: 'POSTED', posted_at: nowIso }]);
  // 対象バッチもPOSTEDへ
  let batchIds = []; try{ batchIds = JSON.parse(run.import_batch_ids_json || '[]'); }catch(e){}
  upsertRowsBulk_(yearSs, 'Sales_Import_Batches', 'import_batch_id',
    batchIds.map(function(id){ return { import_batch_id: id, status: 'POSTED' }; }));
  logEvent_('allocation_run', run.allocation_run_id, actorEmail, { status: run.status },
    { status: 'POSTED', settlements: settlements, total: details.reduce(function(s, d){ return s + (num_(d.payable_amount) || 0); }, 0) });
  return { settlements: settlements };
}
