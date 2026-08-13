/** SPLL 33_contract_snapshot_v4 ― CloudSign FORM v4の個別条件を締結時スナップショットへ反映 */

/**
 * v4申込はCloudSign FORMへ渡した個別条件構造でContracts.terms_snapshotを固定する。
 * 旧申込は従来どおりFee_Scheduleから料金条件を計算して保存する。
 */
function snapshotContractTerms_(contractId, app){
  const usage = (app && app.usage_category) || '';
  if(app && /^v4:/.test(String(app.terms_hash || ''))){
    // 正本はFormRun受信証跡（申込時ハッシュで検証済み）。取れない場合のみ現在のマスタから再構成するが、
    // 再構成値は申込時と一致する保証がないため出所とハッシュ一致可否を必ず記録する（verifyContractTerms_が判定）。
    let fields = contractFormFieldsFromReceiptV4_(app), source = 'FORMRUN_RECEIPT';
    if(!fields){ fields = contractFormFieldsFromApplicationV4_(app); source = 'RECOMPUTED'; }
    fields.terms_snapshot_hash = String(app.terms_hash || '');
    fields.terms_snapshot_source = source;
    fields.terms_snapshot_hash_verified =
      ('v4:' + contractFormHashV4_(fields)) === String(app.terms_hash || '') ? 'true' : 'false';
    updateRow_(ssOps_(),'Contracts','contract_id',contractId,
      { usage_category:usage, terms_snapshot:JSON.stringify(fields) });
    return fields;
  }
  const workCount = readRows_(ssOps_(),'Contract_Works').filter(function(x){ return x.contract_id === contractId; }).length || 1;
  const terms = computeFeeTerms_(usage, workCount);
  updateRow_(ssOps_(),'Contracts','contract_id',contractId,
    { usage_category:usage, terms_snapshot:JSON.stringify(terms) });
  return terms;
}
