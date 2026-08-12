/** SPLL 36_formrun_contract_v4 ― CloudSign FORM v4の改変検知ガード */

/** v4申込だけ、FORMへ引き渡した全個別条件のハッシュを再計算して改変を検知。 */
function verifyFormrunContractV4_(body){
  const canon = formrunCanonV4_(body);
  const ref = canon.application_ref || refFromText_(JSON.stringify(body));
  if(!ref) return { ok:true, legacy:true }; // 既存処理がno-refを記録する
  const app = readRows_(ssOps_(),'Applications').find(function(a){ return String(a.application_ref) === String(ref); });
  if(!app || !/^v4:/.test(String(app.terms_hash || ''))) return { ok:true, legacy:true };

  if(String(canon.license_id || '') !== String(app.license_id || ''))
    return { ok:false, reason:'license_id不一致' };
  if(String(canon.application_ref || '') !== String(app.application_ref || ''))
    return { ok:false, reason:'application_ref不一致' };
  if(String(canon.terms_snapshot_hash || '') !== String(app.terms_hash || ''))
    return { ok:false, reason:'terms_snapshot_hash不一致' };

  const received = {};
  CONTRACT_FORM_V4_HASH_KEYS.forEach(function(k){ received[k] = canon[k] === undefined || canon[k] === null ? '' : String(canon[k]); });
  const recalculated = 'v4:' + contractFormHashV4_(received);
  if(recalculated !== String(app.terms_hash || ''))
    return { ok:false, reason:'契約個別条件がSPLL申込時スナップショットと一致しません' };
  return { ok:true, v4:true };
}

/** 35_webhooks.gsのdispatcherをv4ガード付きで上書き。legacy処理本体はそのまま利用する。 */
function processWebhookEvent_(provider, body, e){
  if(provider === 'FORMRUN'){
    const guard = verifyFormrunContractV4_(body);
    if(!guard.ok){
      logError_('VALIDATION_ERROR','formrun:v4-contract',guard.reason,{ application_ref:(formrunCanonV4_(body).application_ref||'') });
      return 'manual-review:' + guard.reason;
    }
    return processFormrunEvent_(body);
  }
  return processCloudSignEvent_(body, e);
}
