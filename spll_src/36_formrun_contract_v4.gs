/** SPLL 36_formrun_contract_v4 ― CloudSign FORM v4の改変検知ガード */

/**
 * v4申込のFormRun受信を検証する（設定設計 §10）。
 *
 *   1. application_ref を照合
 *   2. license_id を照合
 *   3. terms_snapshot_hash を照合
 *   4. SPLL側の正本スナップショットを再生成し、申込時ハッシュと一致することを確認
 *   5. FORMへ転送した表示項目だけを正本と比較
 *
 * 転送項目を最小限にしたため、受信payloadから全条件を再ハッシュする方式は使えない。
 * 改ざんの検出力は「申込時ハッシュ（SPLL保持）」＋「転送項目の突合」で担保する。
 * handoff_token（HMAC）の検証は後段の processFormrunEvent_ が行う。
 */
/**
 * 受信payloadから申込を特定し、その経路のフォーム項目IDマップで正規化し直す。
 * 経路（定額／売上連動）は申込が分からないと決まらないため、共通マップで一度読んでから引き当てる。
 * ガードと本処理が別々に正規化して結果がずれないよう、両方からこの1関数を通す。
 */
function formrunResolveV4_(body){
  const first = formrunCanonV4_(body);
  const ref = first.application_ref || refFromText_(JSON.stringify(body));
  if(!ref) return { canon:first, ref:'', app:null };
  const app = readRows_(ssOps_(),'Applications').find(function(a){ return String(a.application_ref) === String(ref); }) || null;
  const route = app ? String(app.template_route || '') : '';
  return { canon: route ? formrunCanonV4_(body, route) : first, ref:ref, app:app };
}

function verifyFormrunContractV4_(body){
  const found = formrunResolveV4_(body);
  if(!found.ref) return { ok:true, legacy:true }; // 既存処理がno-refを記録する
  const app = found.app, canon = found.canon;
  if(!app || !/^v4:/.test(String(app.terms_hash || ''))) return { ok:true, legacy:true };
  const route = String(app.template_route || '');

  if(String(canon.license_id || '') !== String(app.license_id || ''))
    return { ok:false, reason:'license_id不一致' };
  if(String(canon.application_ref || '') !== String(app.application_ref || ''))
    return { ok:false, reason:'application_ref不一致' };
  if(String(canon.terms_snapshot_hash || '') !== String(app.terms_hash || ''))
    return { ok:false, reason:'terms_snapshot_hash不一致' };

  // 正本スナップショット（SPLL側）。申込後に原作マスタ等が変わっていれば、ここで検出する。
  const canonical = contractFormFieldsFromApplicationV4_(app);
  if(('v4:' + contractFormHashV4_(canonical)) !== String(app.terms_hash || ''))
    return { ok:false, reason:'申込時の契約条件を再現できません（原作マスタ・料金表が変更された可能性）' };

  // 転送した項目のみ突合。転送していない項目は契約書テンプレートの固定文言のため比較対象にしない。
  const diff = [];
  CONTRACT_FORM_V4_TRANSFER_KEYS.forEach(function(k){
    if(canon[k] === undefined || canon[k] === null) return;
    const expected = canonical[k] === undefined || canonical[k] === null ? '' : String(canonical[k]);
    if(String(canon[k]) !== expected) diff.push(k);
  });
  if(diff.length)
    return { ok:false, reason:'契約個別条件がSPLL申込時スナップショットと一致しません（' + diff.join('、') + '）' };

  return { ok:true, v4:true, route:route, compared:CONTRACT_FORM_V4_TRANSFER_KEYS.filter(function(k){
    return canon[k] !== undefined && canon[k] !== null; }).length };
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
