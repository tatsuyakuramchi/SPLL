/**
 * SPLL 62_sales_match ― SPLL番号・契約・原作の突合（経理設計書 SPLL-SYS-AD-001 §6.2/§12.2）
 *   優先順位：マッピング（LICENSE_PRODUCT_ID＞LICENSE_PRODUCT＞LICENSE_ONLY）
 *           ＞ 契約スナップショット（License_Identifiers→Contract_Works単一原作）
 *           ＞ 旧原作コード（Legacy_Work_Codes）＞ 手動 ＞ UNMATCHED
 *   商品名の曖昧一致は候補提示にのみ使用し、自動確定しない。
 */

// ---- 正規化 ----
/** SPLL番号の正規化：全角→半角・大文字化・空白除去。 */
function accNormalizeLicenseRef_(v){
  return String(v || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(ch){ return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
    .replace(/[‐－―ー−]/g, '-')
    .replace(/\s+/g, '')
    .toUpperCase();
}
/** 商品名キーの正規化：空白・記号ゆらぎを吸収した比較キー。 */
function accNormalizeProductKey_(v){
  return String(v || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(ch){ return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
    .replace(/[\s　【】\[\]（）()「」『』・,、。．.\-〜～!！?？:：;；]/g, '')
    .toUpperCase();
}
/** 旧SPLL番号から原作コードを抽出（例：SPLL:E107009／E107009 → 107・§6.1）。 */
function accExtractLegacyCode_(ref){
  const m = accNormalizeLicenseRef_(ref).replace(/^SPLL[:：\-]?/, '').match(/^[A-Z](\d{3})\d{2,}$/);
  return m ? m[1] : '';
}

// ---- 突合ルールのロード（1回読み） ----
function accMatchRules_(){
  const master = ssAccMaster_();
  const now = new Date().toISOString().slice(0, 10);
  function activeWindow(r){
    return String(r.status||'ACTIVE') !== 'RETIRED' && String(r.status||'') !== 'DISABLED' &&
      (!r.effective_from || String(r.effective_from) <= now) && (!r.effective_to || String(r.effective_to) >= now);
  }
  const identifiers = {};
  readTableBulk_(master, 'License_Identifiers').filter(activeWindow).forEach(function(r){
    const k = r.identifier_normalized || accNormalizeLicenseRef_(r.identifier_value);
    if(k && !(k in identifiers)) identifiers[k] = r;
  });
  const mappings = readTableBulk_(master, 'Sales_Work_Mappings').filter(activeWindow)
    .sort(function(a, b){ return (num_(a.priority)||100) - (num_(b.priority)||100); });
  const legacy = {};
  readTableBulk_(master, 'Legacy_Work_Codes').filter(activeWindow).forEach(function(r){
    const k = String(r.legacy_code); if(!(k in legacy)) legacy[k] = r;
  });
  const contractWorks = {};
  readRows_(ssOps_(), 'Contract_Works').forEach(function(cw){
    (contractWorks[cw.contract_id] = contractWorks[cw.contract_id] || []).push(cw);
  });
  return { identifiers: identifiers, mappings: mappings, legacy: legacy, contractWorks: contractWorks };
}

/** 1明細行を突合し、確定結果（複数原作なら複数行）を返す。確定できなければ空配列。 */
function accMatchRow_(row, rules){
  const ref = accNormalizeLicenseRef_(row.external_license_ref);
  const productKey = accNormalizeProductKey_(row.product_name);
  const ident = ref ? rules.identifiers[ref] : null;
  const contractId = ident ? String(ident.contract_id || '') : '';

  function fromMapping(m){
    let weights = null;   // work_id列にJSON配列 [{work_id,weight}] を許容（複数原作マッピング）
    if(String(m.work_id).charAt(0) === '['){ try{ weights = JSON.parse(m.work_id); }catch(e){ weights = null; } }
    if(weights && weights.length)
      return weights.map(function(w){ return { work_id: w.work_id, weight: num_(w.weight) || 1, mapping_id: m.mapping_id }; });
    return [{ work_id: m.work_id, weight: num_(m.allocation_weight) || 1, mapping_id: m.mapping_id }];
  }
  // 1) LICENSE_PRODUCT_ID → 2) LICENSE_PRODUCT → 3) LICENSE_ONLY（priority順）
  const scopes = [
    { scope: 'LICENSE_PRODUCT_ID', ok: function(m){ return ref && accNormalizeLicenseRef_(m.external_license_ref) === ref &&
        (!m.channel_id || m.channel_id === row.channel_id) && String(m.source_product_id) === String(row.source_product_id) && m.source_product_id !== ''; } },
    { scope: 'LICENSE_PRODUCT',    ok: function(m){ return ref && accNormalizeLicenseRef_(m.external_license_ref) === ref &&
        (!m.channel_id || m.channel_id === row.channel_id) && m.product_name_key && accNormalizeProductKey_(m.product_name_key) === productKey; } },
    { scope: 'LICENSE_ONLY',       ok: function(m){ return ref && accNormalizeLicenseRef_(m.external_license_ref) === ref &&
        !m.source_product_id && !m.product_name_key; } },
  ];
  for(let s = 0; s < scopes.length; s++){
    const m = rules.mappings.find(function(x){ return x.match_scope === scopes[s].scope && scopes[s].ok(x); });
    if(m) return fromMapping(m).map(function(w){ return {
      contract_id: contractId || '', work_id: w.work_id, weight: w.weight,
      match_method: scopes[s].scope, confidence: 1, mapping_id: w.mapping_id }; });
  }
  // 4) 契約スナップショット：単一原作契約は自動確定。複数原作は商品別マッピングが必要
  if(contractId){
    const works = rules.contractWorks[contractId] || [];
    if(works.length === 1)
      return [{ contract_id: contractId, work_id: works[0].work_id, weight: 1, match_method: 'CONTRACT_SNAPSHOT', confidence: 1, mapping_id: '' }];
    return [];   // 複数原作：REVIEW（比率はマッピングで決める）
  }
  // 5) 旧原作コード
  const code = accExtractLegacyCode_(row.external_license_ref);
  if(code && rules.legacy[code])
    return [{ contract_id: '', work_id: rules.legacy[code].work_id, weight: 1, match_method: 'LEGACY_CODE', confidence: 0.9, mapping_id: '' }];
  return [];
}

// ---- 突合ジョブ本体（SALES_MATCH）。カーソル＝処理済み行数。 ----
function accJobSalesMatch_(job){
  const yearSs = ssAccYear_();
  const batch = accImportBatch_(job.target_id);
  if(batch.status === 'SUPERSEDED') return { done: true, cursor: 0, processed: 0 };
  const rules = accMatchRules_();
  const all = readTableBulk_(yearSs, 'Sales_Ledger').filter(function(r){ return r.import_batch_id === batch.import_batch_id; });
  const doneResults = {};
  readTableBulk_(yearSs, 'Sales_Match_Results').forEach(function(r){
    if(r.status !== 'SUPERSEDED') doneResults[r.sales_row_id] = true;
  });
  let cursor = num_(job.cursor) || 0;
  const nowIso = new Date().toISOString();
  while(cursor < all.length){
    if(Date.now() > job.deadlineMs - 30 * 1000) return { done: false, cursor: cursor, processed: 0, total: all.length };
    const part = all.slice(cursor, cursor + job.chunk);
    const results = [], ledgerUpdates = [];
    part.forEach(function(row){
      if(doneResults[row.sales_row_id] && row.match_status === 'MATCHED') return;   // 冪等
      const hits = accMatchRow_(row, rules);
      if(hits.length){
        hits.forEach(function(h, i){
          results.push({ match_result_id: row.sales_row_id + ':' + i, sales_row_id: row.sales_row_id,
            contract_id: h.contract_id || '', work_id: h.work_id, match_method: h.match_method,
            confidence: h.confidence, mapping_id: h.mapping_id || '', status: 'CONFIRMED',
            reviewed_by: '', reviewed_at: nowIso, note: '' });
        });
        ledgerUpdates.push({ sales_row_id: row.sales_row_id, match_status: 'MATCHED' });
      } else {
        const reason = accNormalizeLicenseRef_(row.external_license_ref) ? 'REVIEW_REQUIRED' : 'UNMATCHED';
        ledgerUpdates.push({ sales_row_id: row.sales_row_id, match_status: reason });
      }
    });
    appendRowsBulk_(yearSs, 'Sales_Match_Results', results);
    upsertRowsBulk_(yearSs, 'Sales_Ledger', 'sales_row_id', ledgerUpdates);
    cursor += part.length;
  }
  const unresolved = readTableBulk_(yearSs, 'Sales_Ledger')
    .filter(function(r){ return r.import_batch_id === batch.import_batch_id && r.match_status !== 'MATCHED' && r.match_status !== 'SUPERSEDED'; }).length;
  upsertRowsBulk_(yearSs, 'Sales_Import_Batches', 'import_batch_id', [{
    import_batch_id: batch.import_batch_id, status: unresolved ? 'REVIEW_REQUIRED' : 'READY' }]);
  logEvent_('sales_match', batch.import_batch_id, 'system', null, { rows: all.length, unresolved: unresolved });
  return { done: true, cursor: cursor, processed: all.length, total: all.length };
}

// ============================================================
// 未解決データAPI（§11.4/§12.2）
// ============================================================
/** 未解決明細をSPLL番号×商品×チャネルで集約して返す。 */
function admin_accountingListUnmatched(filters){
  requireRole_([]);
  const f = filters || {};
  const groups = {};
  readTableBulk_(ssAccYear_(), 'Sales_Ledger')
    .filter(function(r){ return (r.match_status === 'REVIEW_REQUIRED' || r.match_status === 'UNMATCHED') &&
      (!f.channelId || r.channel_id === f.channelId) && (!f.importBatchId || r.import_batch_id === f.importBatchId); })
    .forEach(function(r){
      const key = accNormalizeLicenseRef_(r.external_license_ref) + '|' + r.channel_id + '|' + String(r.source_product_id||'');
      const g = groups[key] = groups[key] || { external_license_ref: r.external_license_ref, channel_id: r.channel_id,
        source_product_id: r.source_product_id, product_name: r.product_name, match_status: r.match_status,
        row_count: 0, total_amount: 0, sales_row_ids: [] };
      g.row_count++; g.total_amount += num_(r.license_fee_amount) || 0;
      if(g.sales_row_ids.length < 500) g.sales_row_ids.push(r.sales_row_id);
    });
  return Object.keys(groups).map(function(k){ return groups[k]; })
    .sort(function(a, b){ return b.total_amount - a.total_amount; }).slice(0, 100);
}

/** 原作候補（曖昧一致は提示のみ・自動確定しない）。 */
function admin_accountingSuggestWorks(productName){
  requireRole_([]);
  const key = accNormalizeProductKey_(productName);
  return readRows_(ssMaster_(), 'Works_Master').filter(function(w){
    const wk = accNormalizeProductKey_(w.work_name);
    return key && wk && (key.indexOf(wk) >= 0 || wk.indexOf(key) >= 0);
  }).slice(0, 10).map(function(w){ return { work_id: w.work_id, work_name: w.work_name }; });
}

/** マッピング保存（§6.1）。work配列指定時はJSONで複数原作＋比率を保持。 */
function admin_accountingSaveMapping(mapping){
  const actor = requireRole_(['ACCOUNTING','OPERATIONS','LEGAL_ADMIN']);
  mapping = mapping || {};
  const scope = String(mapping.match_scope || '');
  if(['LICENSE_PRODUCT_ID','LICENSE_PRODUCT','LICENSE_ONLY','CONTRACT'].indexOf(scope) < 0)
    throw new Error('VALIDATION_ERROR: 不正なmatch_scope: ' + scope);
  if(!String(mapping.external_license_ref || '').trim()) throw new Error('VALIDATION_ERROR: SPLL番号は必須です');
  let works = mapping.works;
  if(!works || !works.length){
    if(!mapping.work_id) throw new Error('VALIDATION_ERROR: 原作を指定してください');
    works = [{ work_id: mapping.work_id, weight: 1 }];
  }
  const workRows = readRows_(ssMaster_(), 'Works_Master');
  works.forEach(function(w){
    if(!workRows.some(function(x){ return x.work_id === w.work_id; })) throw new Error('DATA_NOT_FOUND: 原作がありません: ' + w.work_id);
    if(!(num_(w.weight) > 0)) throw new Error('VALIDATION_ERROR: 配分比率は正の数で指定してください');
  });
  const mappingId = newId_('MAP');
  appendRowsBulk_(ssAccMaster_(), 'Sales_Work_Mappings', [{
    mapping_id: mappingId, external_license_ref: sanitizeCell_(accNormalizeLicenseRef_(mapping.external_license_ref)),
    channel_id: mapping.channel_id || '', source_product_id: sanitizeCell_(String(mapping.source_product_id || '')),
    product_name_key: sanitizeCell_(String(mapping.product_name_key || '')),
    match_scope: scope,
    work_id: works.length === 1 ? works[0].work_id : JSON.stringify(works.map(function(w){ return { work_id: w.work_id, weight: num_(w.weight) }; })),
    allocation_weight: works.length === 1 ? (num_(works[0].weight) || 1) : '',
    priority: num_(mapping.priority) || 100, status: 'ACTIVE',
    effective_from: mapping.effective_from || '', effective_to: mapping.effective_to || '',
    approved_by: actor.email, approved_at: new Date().toISOString(),
  }]);
  logEvent_('sales_mapping', mappingId, actor.email, null, { ref: mapping.external_license_ref, scope: scope, works: works.length });
  return { mapping_id: mappingId };
}

/** 旧SPLL番号と現行契約の対応を登録（未解決画面の「現行契約に紐付ける」）。 */
function admin_accountingLinkLicenseRef(externalRef, contractId){
  const actor = requireRole_(['ACCOUNTING','OPERATIONS','LEGAL_ADMIN']);
  const norm = accNormalizeLicenseRef_(externalRef);
  if(!norm) throw new Error('VALIDATION_ERROR: SPLL番号は必須です');
  if(contractId && !readRows_(ssOps_(), 'Contracts').some(function(c){ return c.contract_id === contractId; }))
    throw new Error('DATA_NOT_FOUND: 契約がありません: ' + contractId);
  const master = ssAccMaster_();
  const exist = readTableBulk_(master, 'License_Identifiers').find(function(r){
    return (r.identifier_normalized || accNormalizeLicenseRef_(r.identifier_value)) === norm && r.status !== 'RETIRED'; });
  if(exist){
    upsertRowsBulk_(master, 'License_Identifiers', 'license_identifier_id',
      [{ license_identifier_id: exist.license_identifier_id, contract_id: contractId || '' }]);
    return { license_identifier_id: exist.license_identifier_id, updated: true };
  }
  const id = newId_('LID');
  appendRowsBulk_(master, 'License_Identifiers', [{
    license_identifier_id: id, contract_id: contractId || '', identifier_type: 'SPLL_REF',
    identifier_value: sanitizeCell_(String(externalRef)), identifier_normalized: norm,
    status: 'ACTIVE', effective_from: '', effective_to: '', source: 'MANUAL',
    created_by: actor.email, created_at: new Date().toISOString(),
  }]);
  logEvent_('license_identifier', id, actor.email, null, { ref: norm, contract_id: contractId || '' });
  return { license_identifier_id: id, updated: false };
}

/** 行単位の手動突合（番号なし明細等・match_method=MANUAL）。works=[{work_id,weight}] */
function admin_accountingManualMatch(salesRowIds, works, contractId){
  const actor = requireRole_(['ACCOUNTING','OPERATIONS']);
  const ids = (salesRowIds || []).slice();
  if(!ids.length) throw new Error('VALIDATION_ERROR: 対象明細を指定してください');
  if(!works || !works.length) throw new Error('VALIDATION_ERROR: 原作を指定してください');
  const workRows = readRows_(ssMaster_(), 'Works_Master');
  works.forEach(function(w){
    if(!workRows.some(function(x){ return x.work_id === w.work_id; })) throw new Error('DATA_NOT_FOUND: 原作がありません: ' + w.work_id);
  });
  const yearSs = ssAccYear_();
  const inSet = {}; ids.forEach(function(id){ inSet[id] = true; });
  const olds = readTableBulk_(yearSs, 'Sales_Match_Results')
    .filter(function(r){ return inSet[r.sales_row_id] && r.status !== 'SUPERSEDED'; })
    .map(function(r){ return { match_result_id: r.match_result_id, status: 'SUPERSEDED' }; });
  upsertRowsBulk_(yearSs, 'Sales_Match_Results', 'match_result_id', olds);
  const nowIso = new Date().toISOString();
  const results = [];
  ids.forEach(function(rowId){
    works.forEach(function(w, i){
      results.push({ match_result_id: Utilities.getUuid(), sales_row_id: rowId,
        contract_id: contractId || '', work_id: w.work_id, match_method: 'MANUAL',
        confidence: 1, mapping_id: '', status: 'CONFIRMED', reviewed_by: actor.email, reviewed_at: nowIso, note: '' });
    });
  });
  appendRowsBulk_(yearSs, 'Sales_Match_Results', results);
  upsertRowsBulk_(yearSs, 'Sales_Ledger', 'sales_row_id',
    ids.map(function(id){ return { sales_row_id: id, match_status: 'MATCHED' }; }));
  // バッチ状態の再評価
  const batchIds = {};
  readTableBulk_(yearSs, 'Sales_Ledger').forEach(function(r){ if(inSet[r.sales_row_id]) batchIds[r.import_batch_id] = true; });
  Object.keys(batchIds).forEach(function(bid){
    const unresolved = readTableBulk_(yearSs, 'Sales_Ledger')
      .filter(function(r){ return r.import_batch_id === bid && ['MATCHED','SUPERSEDED'].indexOf(r.match_status) < 0; }).length;
    upsertRowsBulk_(yearSs, 'Sales_Import_Batches', 'import_batch_id', [{ import_batch_id: bid, status: unresolved ? 'REVIEW_REQUIRED' : 'READY' }]);
  });
  logEvent_('sales_match', ids.join(',').slice(0, 100), actor.email, null, { manual: true, rows: ids.length, works: works.length });
  return { updated: ids.length };
}

/** 再突合：既存結果をSUPERSEDEDにしてSALES_MATCHを再実行。 */
function admin_accountingRematch(importBatchId){
  const actor = requireRole_(['ACCOUNTING','OPERATIONS']);
  const yearSs = ssAccYear_();
  const batch = accImportBatch_(importBatchId);
  if(['MATCHING','REVIEW_REQUIRED','READY'].indexOf(batch.status) < 0)
    throw new Error('DATA_CONFLICT: このバッチは再突合できません（' + batch.status + '）');
  const rowIds = {};
  readTableBulk_(yearSs, 'Sales_Ledger').forEach(function(r){ if(r.import_batch_id === importBatchId) rowIds[r.sales_row_id] = true; });
  const olds = readTableBulk_(yearSs, 'Sales_Match_Results')
    .filter(function(r){ return rowIds[r.sales_row_id] && r.status !== 'SUPERSEDED'; })
    .map(function(r){ return { match_result_id: r.match_result_id, status: 'SUPERSEDED' }; });
  upsertRowsBulk_(yearSs, 'Sales_Match_Results', 'match_result_id', olds);
  upsertRowsBulk_(yearSs, 'Sales_Ledger', 'sales_row_id',
    Object.keys(rowIds).map(function(id){ return { sales_row_id: id, match_status: 'PENDING' }; }));
  upsertRowsBulk_(yearSs, 'Sales_Import_Batches', 'import_batch_id', [{ import_batch_id: importBatchId, status: 'MATCHING' }]);
  const jobId = enqueueAccountingJob_('SALES_MATCH', importBatchId, {});
  logEvent_('sales_match', importBatchId, actor.email, null, { rematch: true, superseded: olds.length });
  return { job_id: jobId };
}
