/** SPLL 33_contract_snapshot_v4 ― CloudSign FORM v4の個別条件を締結時スナップショットへ反映 */

/**
 * v4申込はCloudSign FORMへ渡した個別条件構造でContracts.terms_snapshotを固定する。
 * 旧申込は従来どおりFee_Scheduleから料金条件を計算して保存する。
 */
function snapshotContractTerms_(contractId, app){
  const usage = (app && app.usage_category) || '';
  if(app && /^v4:/.test(String(app.terms_hash || ''))){
    // 正本はSPLL側の内部スナップショット（申込時ハッシュと一致すれば申込時の条件そのもの）。
    // FORMへ転送するのは契約書へ差し込む最小限だけになったため、受信証跡から全条件は復元できない。
    // 一致しない場合（申込後に原作マスタ・料金表が変わった等）は、全項目を転送していた旧フォームの
    // 受信証跡からの復元を試し、それも取れなければ再構成値であることを記録する（verifyContractTerms_が判定）。
    let fields = contractFormFieldsFromApplicationV4_(app), source = 'SPLL_SNAPSHOT';
    if(('v4:' + contractFormHashV4_(fields)) !== String(app.terms_hash || '')){
      const fromReceipt = contractFormFieldsFromReceiptV4_(app);
      if(fromReceipt){ fields = fromReceipt; source = 'FORMRUN_RECEIPT'; }
      else source = 'RECOMPUTED';
    }
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
