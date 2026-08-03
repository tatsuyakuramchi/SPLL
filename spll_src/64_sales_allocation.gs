/**
 * SPLL 64_sales_allocation ― 原作按分・権利者配分（経理設計書 SPLL-SYS-AD-001 §6.3/§11.5/§12.3）
 *   ・複数原作の按分は最大剰余法（合計＝原票許諾料を厳守）
 *   ・配分プロファイル：RATE（四捨五入）→ RESIDUAL（残額）。端数調整はrounding_adjustmentへ記録
 *   ・整合性：原票合計＝原作按分合計＝権利者配分合計。差額0でない配分は承認不可
 *   ・作成者と承認者の職務分離（緊急時はEMERGENCY_OVERRIDEを記録）
 */

// ============================================================
// 最大剰余法（§6.3）：整数円をweightsで配分し合計を維持する
// ============================================================
function accLargestRemainder_(amount, weights){
  const total = weights.reduce(function(s, w){ return s + w; }, 0);
  if(!(total > 0)) throw new Error('VALIDATION_ERROR: 配分比率の合計が0です');
  const exact = weights.map(function(w){ return amount * w / total; });
  const base = exact.map(function(x){ return Math.floor(x); });
  let rest = amount - base.reduce(function(s, x){ return s + x; }, 0);
  const order = exact.map(function(x, i){ return { i: i, frac: x - Math.floor(x) }; })
    .sort(function(a, b){ return b.frac - a.frac || a.i - b.i; });   // 同率は先頭優先（25円→13円/12円）
  for(let k = 0; rest > 0; k = (k + 1) % order.length){ base[order[k].i]++; rest--; }
  return base;
}

// ============================================================
// 配分プロファイル（§6.1）
// ============================================================
function admin_accountingSaveDistributionProfile(profile){
  const actor = requireRole_(['ACCOUNTING','LEGAL_ADMIN']);
  profile = profile || {};
  if(!profile.work_id) throw new Error('VALIDATION_ERROR: 原作を指定してください');
  const lines = profile.lines || [];
  if(!lines.length) throw new Error('VALIDATION_ERROR: 配分行を1件以上指定してください');
  const residuals = lines.filter(function(l){ return String(l.calculation_type) === 'RESIDUAL'; });
  if(residuals.length > 1) throw new Error('VALIDATION_ERROR: RESIDUAL行は1行までです');
  let rateSum = 0;
  lines.forEach(function(l){
    if(['RATE','RESIDUAL'].indexOf(String(l.calculation_type)) < 0) throw new Error('VALIDATION_ERROR: 不正なcalculation_type: ' + l.calculation_type);
    if(!l.partner_id) throw new Error('VALIDATION_ERROR: 配分行に権利者IDが必要です');
    if(String(l.calculation_type) === 'RATE'){
      const r = Number(l.rate);
      if(!(r > 0)) throw new Error('VALIDATION_ERROR: RATE行のrateは正の数で指定してください（例 0.05）');
      rateSum += r;
    }
  });
  if(rateSum > 1 + 1e-9) throw new Error('VALIDATION_ERROR: RATE合計が100%を超えています');
  if(!residuals.length && Math.abs(rateSum - 1) > 1e-9)
    throw new Error('VALIDATION_ERROR: RESIDUAL行が無い場合はRATE合計を100%にしてください');
  const master = ssAccMaster_();
  const now = new Date().toISOString();
  // 既存ACTIVE版はRETIREDにして新版を作成（承認済みデータを直接編集しない・§16）
  const olds = readTableBulk_(master, 'Distribution_Profiles')
    .filter(function(p){ return p.work_id === profile.work_id && p.status === 'ACTIVE'; });
  upsertRowsBulk_(master, 'Distribution_Profiles', 'distribution_profile_id',
    olds.map(function(p){ return { distribution_profile_id: p.distribution_profile_id, status: 'RETIRED', effective_to: now.slice(0,10) }; }));
  const version = olds.reduce(function(m, p){ return Math.max(m, num_(p.version) || 0); }, 0) + 1;
  const profileId = newId_('DPR');
  appendRowsBulk_(master, 'Distribution_Profiles', [{
    distribution_profile_id: profileId, work_id: profile.work_id,
    profile_name: sanitizeCell_(String(profile.profile_name || profile.work_id + ' 配分')), version: version,
    rounding_method: 'ROUND_RATE_RESIDUAL', status: 'ACTIVE',
    effective_from: now.slice(0,10), effective_to: '',
    approved_by: actor.email, approved_at: now, created_at: now,
  }]);
  appendRowsBulk_(master, 'Distribution_Profile_Lines', lines.map(function(l, i){ return {
    profile_line_id: profileId + ':' + (i + 1), distribution_profile_id: profileId,
    partner_id: l.partner_id, role_code: sanitizeCell_(String(l.role_code || '')),
    calculation_type: l.calculation_type, rate: String(l.calculation_type) === 'RATE' ? Number(l.rate) : '',
    tax_treatment: sanitizeCell_(String(l.tax_treatment || 'TAX_INCLUDED')),
    account_code: sanitizeCell_(String(l.account_code || '')), sort_order: i + 1, active: 'true',
  }; }));
  logEvent_('distribution_profile', profileId, actor.email, null, { work_id: profile.work_id, version: version, lines: lines.length });
  return { distribution_profile_id: profileId, version: version };
}

function admin_accountingListDistributionProfiles(){ requireRole_([]);
  const master = ssAccMaster_();
  const lines = {};
  readTableBulk_(master, 'Distribution_Profile_Lines').forEach(function(l){
    (lines[l.distribution_profile_id] = lines[l.distribution_profile_id] || []).push(l);
  });
  return readTableBulk_(master, 'Distribution_Profiles')
    .filter(function(p){ return p.status === 'ACTIVE'; })
    .map(function(p){ return { distribution_profile_id: p.distribution_profile_id, work_id: p.work_id,
      profile_name: p.profile_name, version: p.version,
      lines: (lines[p.distribution_profile_id] || []).map(function(l){ return {
        partner_id: l.partner_id, calculation_type: l.calculation_type, rate: l.rate, tax_treatment: l.tax_treatment }; }) }; });
}
/** 原作→ACTIVEプロファイル（行つき）のインデックス。 */
function accActiveProfiles_(){
  const master = ssAccMaster_();
  const byId = {};
  readTableBulk_(master, 'Distribution_Profile_Lines').forEach(function(l){
    if(String(l.active) === 'false') return;
    (byId[l.distribution_profile_id] = byId[l.distribution_profile_id] || []).push(l);
  });
  const byWork = {};
  readTableBulk_(master, 'Distribution_Profiles').forEach(function(p){
    if(p.status !== 'ACTIVE') return;
    const cur = byWork[p.work_id];
    if(!cur || num_(p.version) > num_(cur.version)) byWork[p.work_id] = p;
  });
  Object.keys(byWork).forEach(function(w){
    byWork[w] = { profile: byWork[w], lines: (byId[byWork[w].distribution_profile_id] || [])
      .sort(function(a, b){ return num_(a.sort_order) - num_(b.sort_order); }) };
  });
  return byWork;
}

// ============================================================
// 配分run（§6.3/§12.3）
// ============================================================
function admin_accountingCreateAllocationRun(period, importBatchIds){
  const actor = requireRole_(['ACCOUNTING']);
  if(!/^\d{4}-\d{2}$/.test(String(period||''))) throw new Error('VALIDATION_ERROR: 対象月はYYYY-MM形式で指定してください');
  const ids = (importBatchIds || []).slice();
  if(!ids.length) throw new Error('VALIDATION_ERROR: 対象バッチを指定してください');
  const yearSs = ssAccYear_();
  const batches = readTableBulk_(yearSs, 'Sales_Import_Batches');
  ids.forEach(function(id){
    const b = batches.find(function(x){ return x.import_batch_id === id; });
    if(!b) throw new Error('DATA_NOT_FOUND: 取込バッチがありません: ' + id);
    if(b.status !== 'READY') throw new Error('DATA_CONFLICT: 未解決明細が残っています（' + id + '／' + b.status + '）。未解決データを解消してください');
  });
  const runId = newId_('ALR');
  appendRowsBulk_(yearSs, 'Allocation_Runs', [{
    allocation_run_id: runId, sales_period: period, import_batch_ids_json: JSON.stringify(ids),
    rule_snapshot_hash: '', status: 'DRAFT', source_total_amount: '', allocated_total_amount: '',
    difference_amount: '', exception_count: '', prepared_by: actor.email, prepared_at: new Date().toISOString(),
    approved_by: '', approved_at: '', posted_at: '', error_summary: '',
  }]);
  logEvent_('allocation_run', runId, actor.email, null, { period: period, batches: ids });
  return { allocation_run_id: runId };
}

function admin_accountingCalculateAllocation(runId){
  const actor = requireRole_(['ACCOUNTING']);
  const run = accAllocationRun_(runId);
  if(['DRAFT','REVIEW_REQUIRED','READY_FOR_APPROVAL'].indexOf(run.status) < 0)
    throw new Error('DATA_CONFLICT: このrunは計算できません（' + run.status + '）');
  upsertRowsBulk_(ssAccYear_(), 'Allocation_Runs', 'allocation_run_id', [{ allocation_run_id: runId, status: 'CALCULATING' }]);
  const jobId = enqueueAccountingJob_('ALLOCATION_CALCULATE', runId, {});
  logEvent_('allocation_run', runId, actor.email, { status: run.status }, { status: 'CALCULATING', job_id: jobId });
  return { job_id: jobId };
}

/** 配分計算ジョブ本体。カーソル＝処理済み販売行数。再計算時は旧明細を洗い替え。 */
function accJobAllocationCalculate_(job){
  const yearSs = ssAccYear_();
  const run = accAllocationRun_(job.target_id);
  if(run.status === 'VOID') return { done: true, cursor: 0, processed: 0 };
  const batchIds = JSON.parse(run.import_batch_ids_json || '[]');
  const inBatch = {}; batchIds.forEach(function(id){ inBatch[id] = true; });
  const ledger = readTableBulk_(yearSs, 'Sales_Ledger')
    .filter(function(r){ return inBatch[r.import_batch_id] && r.match_status === 'MATCHED'; });
  const matches = {};
  readTableBulk_(yearSs, 'Sales_Match_Results').forEach(function(m){
    if(m.status !== 'SUPERSEDED') (matches[m.sales_row_id] = matches[m.sales_row_id] || []).push(m);
  });
  const profiles = accActiveProfiles_();
  const mappingIdx = buildIndex_(readTableBulk_(ssAccMaster_(), 'Sales_Work_Mappings'), function(m){ return m.mapping_id; });
  let cursor = num_(job.cursor) || 0;
  if(cursor === 0){
    // 再計算：このrunの旧明細を削除して洗い替え（未承認runのみ再計算可能）
    const keep = readTableBulk_(yearSs, 'Allocation_Details')
      .filter(function(d){ return d.allocation_run_id !== run.allocation_run_id; });
    replaceRowsBulk_(yearSs, 'Allocation_Details', keep);
    upsertRowsBulk_(yearSs, 'Allocation_Runs', 'allocation_run_id', [{
      allocation_run_id: run.allocation_run_id, rule_snapshot_hash: sha256Bytes_(Utilities.newBlob(JSON.stringify(profiles)).getBytes()) }]);
  }
  // 途中再開の冪等（§8.3）：既存明細IDはスキップ
  const existingDet = {};
  readTableBulk_(yearSs, 'Allocation_Details').forEach(function(d){
    if(d.allocation_run_id === run.allocation_run_id) existingDet[d.allocation_detail_id] = true; });
  const nowIso = new Date().toISOString();
  let exceptions = 0;   // 例外は最後に明細から集計する
  while(cursor < ledger.length){
    if(Date.now() > job.deadlineMs - 30 * 1000) return { done: false, cursor: cursor, processed: 0, total: ledger.length };
    const part = ledger.slice(cursor, cursor + Math.min(job.chunk, 200));
    const details = [];
    part.forEach(function(row){
      const fee = Math.round(num_(row.license_fee_amount) || 0);
      const hits = (matches[row.sales_row_id] || []).filter(function(m){ return m.status === 'CONFIRMED'; });
      if(!hits.length) return;   // 突合結果なし（後段で未配分として例外集計）
      // 1) 原作按分（最大剰余法・§6.3）
      const weights = hits.map(function(h){ return num_(accMatchWeight_(h, mappingIdx)) || 1; });
      const workAmounts = accLargestRemainder_(fee, weights);
      hits.forEach(function(h, wi){
        const workAmount = workAmounts[wi];
        const prof = profiles[h.work_id];
        if(!prof){
          details.push(accAllocationDetail_(run, row, h, '', workAmount, workAmount, 0, 0, '', 'EXCEPTION:プロファイル未設定', nowIso, weights[wi]));
          return;
        }
        // 2) RATE行を四捨五入 → 3) 残額をRESIDUALへ
        let rateSum = 0;
        const lineAmounts = prof.lines.map(function(l){
          if(l.calculation_type !== 'RATE') return null;
          const a = Math.round(workAmount * Number(l.rate));
          rateSum += a; return a;
        });
        const residualIdx = prof.lines.findIndex(function(l){ return l.calculation_type === 'RESIDUAL'; });
        let residual = workAmount - rateSum;
        let adjustments = prof.lines.map(function(){ return 0; });
        if(residualIdx >= 0){ lineAmounts[residualIdx] = residual; }
        else if(residual !== 0){
          // RESIDUAL無し：最大のRATE行へ端数を寄せ、rounding_adjustmentに記録（合計厳守）
          let maxI = 0; lineAmounts.forEach(function(a, i){ if(a !== null && a > lineAmounts[maxI]) maxI = i; });
          lineAmounts[maxI] += residual; adjustments[maxI] = residual;
        }
        prof.lines.forEach(function(l, li){
          details.push(accAllocationDetail_(run, row, h, l.partner_id, workAmount, lineAmounts[li],
            l.calculation_type === 'RATE' ? Number(l.rate) : '', adjustments[li],
            prof.profile.distribution_profile_id + ':' + prof.profile.version, l.tax_treatment, nowIso, weights[wi]));
        });
      });
    });
    appendRowsBulk_(yearSs, 'Allocation_Details', details.filter(function(d){ return !existingDet[d.allocation_detail_id]; }));
    details.forEach(function(d){ existingDet[d.allocation_detail_id] = true; });
    upsertRowsBulk_(yearSs, 'Sales_Ledger', 'sales_row_id',
      part.map(function(r){ return { sales_row_id: r.sales_row_id, allocation_status: 'ALLOCATED' }; }));
    cursor += part.length;
  }
  // 集計・整合性（§6.3）：原票合計＝按分合計＝配分合計。例外＝プロファイル未設定明細＋未配分行
  const details = readTableBulk_(yearSs, 'Allocation_Details')
    .filter(function(d){ return d.allocation_run_id === run.allocation_run_id && d.status === 'CALCULATED'; });
  const allocatedRows = {};
  details.forEach(function(d){ allocatedRows[d.sales_row_id] = true; });
  exceptions = details.filter(function(d){ return !d.partner_id; }).length +
    ledger.filter(function(r){ return !allocatedRows[r.sales_row_id]; }).length;
  const sourceTotal = ledger.reduce(function(s, r){ return s + (num_(r.license_fee_amount) || 0); }, 0);
  const allocatedTotal = details.reduce(function(s, d){ return s + (num_(d.allocated_amount) || 0); }, 0);
  const diff = sourceTotal - allocatedTotal;
  const status = (exceptions > 0 || diff !== 0) ? 'REVIEW_REQUIRED' : 'READY_FOR_APPROVAL';
  upsertRowsBulk_(yearSs, 'Allocation_Runs', 'allocation_run_id', [{
    allocation_run_id: run.allocation_run_id, status: status,
    source_total_amount: sourceTotal, allocated_total_amount: allocatedTotal,
    difference_amount: diff, exception_count: exceptions }]);
  logEvent_('allocation_run', run.allocation_run_id, 'system', null,
    { status: status, source: sourceTotal, allocated: allocatedTotal, diff: diff, exceptions: exceptions });
  return { done: true, cursor: cursor, processed: ledger.length, total: ledger.length };
}
function accMatchWeight_(m, mappingIdx){
  // マッピング由来の比率はmapping参照から復元（無指定は1）
  if(!m.mapping_id) return 1;
  const map = mappingIdx[m.mapping_id];
  if(!map) return 1;
  if(String(map.work_id).charAt(0) === '['){
    try{ const arr = JSON.parse(map.work_id); const hit = arr.find(function(w){ return w.work_id === m.work_id; });
      return hit ? (num_(hit.weight) || 1) : 1; }catch(e){ return 1; }
  }
  return num_(map.allocation_weight) || 1;
}
function accAllocationDetail_(run, row, hit, partnerId, workAmount, amount, rate, adjustment, profileSnap, taxTreatment, nowIso, weight){
  return {
    allocation_detail_id: run.allocation_run_id + ':' + row.sales_row_id + ':' + hit.work_id + ':' + (partnerId || '-'),
    allocation_run_id: run.allocation_run_id, sales_row_id: row.sales_row_id,
    contract_id: hit.contract_id || '', work_id: hit.work_id, partner_id: partnerId || '',
    work_allocation_weight: weight, partner_rate: rate,
    base_license_fee_amount: num_(row.license_fee_amount) || 0, work_allocated_amount: workAmount,
    allocated_amount: amount, payable_amount: amount, rounding_adjustment: adjustment || 0,
    tax_treatment_snapshot: taxTreatment || '', profile_id_snapshot: String(profileSnap).split(':')[0] || '',
    profile_version_snapshot: String(profileSnap).split(':')[1] || '',
    calculation_json: JSON.stringify({ fee: num_(row.license_fee_amount) || 0, work_amount: workAmount, rate: rate, adjustment: adjustment || 0 }),
    status: 'CALCULATED', created_at: nowIso,
  };
}

// ============================================================
// 集計・一覧・承認（§11.5/§12.3/§13）
// ============================================================
function accAllocationRun_(runId){
  const r = readTableBulk_(ssAccYear_(), 'Allocation_Runs').find(function(x){ return x.allocation_run_id === String(runId||''); });
  if(!r) throw new Error('DATA_NOT_FOUND: 配分runがありません: ' + runId);
  return r;
}
function admin_accountingListAllocationRuns(){ requireRole_([]);
  return readTableBulk_(ssAccYear_(), 'Allocation_Runs').slice(-50).reverse()
    .map(function(r){ return { allocation_run_id: r.allocation_run_id, sales_period: r.sales_period,
      status: r.status, source_total_amount: r.source_total_amount, allocated_total_amount: r.allocated_total_amount,
      difference_amount: r.difference_amount, exception_count: r.exception_count,
      prepared_by: r.prepared_by, approved_by: r.approved_by }; });
}
function admin_accountingGetAllocationSummary(runId){ requireRole_([]);
  const run = accAllocationRun_(runId);
  const details = readTableBulk_(ssAccYear_(), 'Allocation_Details')
    .filter(function(d){ return d.allocation_run_id === run.allocation_run_id && d.status === 'CALCULATED'; });
  const byPartner = {}, byWork = {};
  details.forEach(function(d){
    const p = byPartner[d.partner_id] = byPartner[d.partner_id] || { partner_id: d.partner_id, amount: 0, payable: 0, count: 0 };
    p.amount += num_(d.allocated_amount) || 0; p.payable += num_(d.payable_amount) || 0; p.count++;
    const w = byWork[d.work_id] = byWork[d.work_id] || { work_id: d.work_id, amount: 0, count: 0 };
    w.amount += num_(d.work_allocated_amount) || 0; w.count++;
  });
  return {
    run: { allocation_run_id: run.allocation_run_id, sales_period: run.sales_period, status: run.status,
      source_total_amount: run.source_total_amount, allocated_total_amount: run.allocated_total_amount,
      difference_amount: run.difference_amount, exception_count: run.exception_count,
      prepared_by: run.prepared_by, approved_by: run.approved_by },
    partners: Object.keys(byPartner).map(function(k){ return byPartner[k]; }).sort(function(a,b){ return b.amount - a.amount; }),
    works: Object.keys(byWork).map(function(k){ return byWork[k]; }).sort(function(a,b){ return b.amount - a.amount; }),
  };
}
function admin_accountingListAllocationDetails(runId, filters, page){ requireRole_([]);
  const f = filters || {};
  const all = readTableBulk_(ssAccYear_(), 'Allocation_Details')
    .filter(function(d){ return d.allocation_run_id === String(runId) && d.status === 'CALCULATED' &&
      (!f.partnerId || d.partner_id === f.partnerId) && (!f.workId || d.work_id === f.workId); });
  const p = Math.max(1, num_(page) || 1), size = 100;   // §18.4：1ページ100件以下
  return { total: all.length, page: p,
    rows: all.slice((p - 1) * size, p * size).map(function(d){ return {
      allocation_detail_id: d.allocation_detail_id, sales_row_id: d.sales_row_id, work_id: d.work_id,
      partner_id: d.partner_id, allocated_amount: d.allocated_amount, payable_amount: d.payable_amount,
      partner_rate: d.partner_rate, rounding_adjustment: d.rounding_adjustment }; }) };
}
/**
 * 配分承認（§11.5）。承認可能条件：例外0・差額0円。作成者と承認者は別人
 * （緊急時のみemergencyReason必須でEMERGENCY_OVERRIDEをEventsへ記録・§6.3）。
 */
function admin_accountingApproveAllocation(runId, emergencyReason){
  const actor = requireRole_(['ACCOUNTING']);
  const run = accAllocationRun_(runId);
  if(run.status !== 'READY_FOR_APPROVAL')
    throw new Error('DATA_CONFLICT: 承認できる状態ではありません（' + run.status + '）');
  if(num_(run.difference_amount) !== 0)
    throw new Error('VALIDATION_ERROR: 配分差額が0円ではありません（' + run.difference_amount + '円）');
  if(num_(run.exception_count) !== 0)
    throw new Error('VALIDATION_ERROR: 未解決の例外が残っています（' + run.exception_count + '件）');
  let override = '';
  if(String(run.prepared_by).toLowerCase() === String(actor.email).toLowerCase()){
    if(!String(emergencyReason || '').trim())
      throw new Error('AUTHORIZATION_ERROR: 作成者本人は承認できません（緊急時はemergencyReasonを指定＝EMERGENCY_OVERRIDEとして記録されます）');
    override = 'EMERGENCY_OVERRIDE: ' + String(emergencyReason);
  }
  upsertRowsBulk_(ssAccYear_(), 'Allocation_Runs', 'allocation_run_id', [{
    allocation_run_id: runId, status: 'APPROVED', approved_by: actor.email, approved_at: new Date().toISOString() }]);
  logEvent_('allocation_run', runId, actor.email, { status: 'READY_FOR_APPROVAL' },
    { status: 'APPROVED', emergency: override ? sanitizeCell_(override) : false });
  return true;
}
/** 配分取消。POSTED（清算連携済み）は取消不可。明細をVOIDし販売行を未配分へ戻す。 */
function admin_accountingVoidAllocation(runId, reason){
  const actor = requireRole_(['ACCOUNTING']);
  if(!String(reason || '').trim()) throw new Error('VALIDATION_ERROR: 取消理由は必須です');
  const run = accAllocationRun_(runId);
  if(run.status === 'POSTED' || run.status === 'EXPORTED')
    throw new Error('DATA_CONFLICT: 清算連携済み・出力済みのrunは取消できません（訂正は新しいrunで行ってください）');
  const yearSs = ssAccYear_();
  const details = readTableBulk_(yearSs, 'Allocation_Details')
    .filter(function(d){ return d.allocation_run_id === run.allocation_run_id && d.status === 'CALCULATED'; });
  upsertRowsBulk_(yearSs, 'Allocation_Details', 'allocation_detail_id',
    details.map(function(d){ return { allocation_detail_id: d.allocation_detail_id, status: 'VOID' }; }));
  const rowIds = {};
  details.forEach(function(d){ rowIds[d.sales_row_id] = true; });
  upsertRowsBulk_(yearSs, 'Sales_Ledger', 'sales_row_id',
    Object.keys(rowIds).map(function(id){ return { sales_row_id: id, allocation_status: 'PENDING' }; }));
  upsertRowsBulk_(yearSs, 'Allocation_Runs', 'allocation_run_id', [{
    allocation_run_id: runId, status: 'VOID', error_summary: sanitizeCell_('取消: ' + reason) }]);
  logEvent_('allocation_run', runId, actor.email, { status: run.status }, { status: 'VOID', reason: String(reason) });
  return true;
}
