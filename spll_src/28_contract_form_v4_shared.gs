/** SPLL 28_contract_form_v4_shared ― CloudSign FORM v4 共通：個別条件・ハッシュ・改変検知 */

const CONTRACT_FORM_V4_VERSION = 'v4.0';
const CONTRACT_FORM_V4_HASH_KEYS = [
  'contract_template_version','license_id','application_ref','usage_category','work_count','work_names',
  'work_id_1','work_title_1','work_id_2','work_title_2','work_id_3','work_title_3',
  'work_id_4','work_title_4','work_id_5','work_title_5',
  'licensor_name','license_term','territory','fee_model','fee_value','fee_amount_or_rate',
  'licensed_uses','payment_terms','reporting_terms','credit_text','special_terms'
];

/** 料金・原作条件からCloudSign FORMへ渡す個別条件を生成。ユーザー入力ではなくSPLL側の確定値。 */
function contractFormFieldsV4_(appId, licenseId, ref, usageCategory, workIds){
  const ids = (workIds || []).map(String).filter(Boolean).slice(0, formMaxWorks_());
  const master = readRows_(ssMaster_(),'Works_Master');
  const partners = readRows_(ssOps_(),'Partners');
  const works = ids.map(function(id){
    const w = master.find(function(x){ return String(x.work_id) === id; }) || {};
    let licensor = '';
    if(w.partner_id){
      const p = partners.find(function(x){ return String(x.partner_id) === String(w.partner_id); });
      if(p) licensor = String(p.name || '');
    }
    if(!licensor) licensor = String(w.publisher || '');
    return { id:id, title:String(w.work_name || id), credit:String(w.credit_text || ''), licensor:licensor };
  });
  const terms = computeFeeTerms_(usageCategory, Math.max(1, works.length));
  const licensors = works.map(function(w){ return w.licensor; }).filter(Boolean)
    .filter(function(v,i,a){ return a.indexOf(v) === i; });
  const credits = works.map(function(w){ return w.credit; }).filter(Boolean)
    .filter(function(v,i,a){ return a.indexOf(v) === i; });
  const reportParts = [terms.reporting_requirement, terms.report_due ? ('期限：' + terms.report_due) : ''].filter(Boolean);
  const specialParts = [terms.threshold_or_cap, terms.reprint_rule, terms.special_terms].filter(function(v){ return v && v !== '－'; });
  const feeValue = terms.fee_model === 'RATE' ? terms.rate : terms.amount;
  const out = {
    contract_template_version: CONTRACT_FORM_V4_VERSION,
    license_id: String(licenseId || ''), application_ref: String(ref || ''),
    usage_category: String(usageCategory || ''), work_count: String(works.length),
    work_names: works.map(function(w){ return w.title; }).join('、'),
    licensor_name: licensors.join('、'),
    license_term: getConfig_('LICENSE_TERM_LABEL','契約成立日から1年間（自動更新）'),
    territory: getConfig_('LICENSE_TERRITORY_LABEL','全世界'),
    fee_model: String(terms.fee_model || ''), fee_value: feeValue === null || feeValue === undefined ? '' : String(feeValue),
    fee_amount_or_rate: String(terms.fee_amount_or_rate || ''),
    licensed_uses: String(terms.licensed_uses || ''), payment_terms: String(terms.payment_due || ''),
    reporting_terms: reportParts.join(' ／ '), credit_text: credits.join(' ／ '), special_terms: specialParts.join(' ／ ')
  };
  for(let i=0;i<formMaxWorks_();i++){
    const w = works[i] || {};
    out['work_id_' + (i+1)] = w.id || '';
    out['work_title_' + (i+1)] = w.title || '';
  }
  return out;
}

/** ハッシュ対象を固定順に正規化。terms_snapshot_hash自身は含めない。 */
function contractFormHashV4_(fields){
  fields = fields || {};
  const pairs = CONTRACT_FORM_V4_HASH_KEYS.map(function(k){ return [k, String(fields[k] === undefined || fields[k] === null ? '' : fields[k])]; });
  return hash_(JSON.stringify(pairs));
}

/** Applicationsから同一のFORM個別条件を再構成（管理・締結スナップショット用）。 */
function contractFormFieldsFromApplicationV4_(app){
  if(!app) return {};
  const ids = readRows_(ssOps_(),'Application_Works')
    .filter(function(x){ return String(x.application_id) === String(app.application_id); })
    .map(function(x){ return x.work_id; });
  return contractFormFieldsV4_(app.application_id, app.license_id, app.application_ref, app.usage_category, ids);
}

/** FormRun payloadをcanonical keyへ正規化。FORMRUN_FIELD_MAPは「実フィールド名/ID → canonical key」。 */
function formrunCanonV4_(body){
  body = body || {};
  const map = parseJson_(prop_('FORMRUN_FIELD_MAP'), {});
  const canon = {};
  function put(rawKey, value){
    if(rawKey === undefined || rawKey === null) return;
    const key = map[String(rawKey)] || String(rawKey);
    canon[key] = value;
  }
  (body.columns || []).forEach(function(c){
    put(c.name || c.label || c.id || c.key, c.value);
    if(c.id) put(c.id, c.value);
  });
  Object.keys(body).forEach(function(k){
    if(['columns','data','payload'].indexOf(k) < 0 && typeof body[k] !== 'object') put(k, body[k]);
  });
  if(body.data && typeof body.data === 'object') Object.keys(body.data).forEach(function(k){ put(k, body.data[k]); });
  return canon;
}

/** FormRun受信証跡から、申込時ハッシュと一致する実際の契約個別条件を復元する。 */
function contractFormFieldsFromReceiptV4_(app){
  if(!app || !/^v4:/.test(String(app.terms_hash || ''))) return null;
  const rows = readRows_(ssOps_(),'Webhook_Receipts')
    .filter(function(r){ return r.provider === 'FORMRUN' &&
      (String(r.application_ref || '') === String(app.application_ref || '') || String(r.payload_json || '').indexOf(String(app.application_ref || '')) >= 0); })
    .sort(function(a,b){ return String(b.received_at || '').localeCompare(String(a.received_at || '')); });
  for(let i=0;i<rows.length;i++){
    let raw = String(rows[i].payload_json || '');
    if(raw.charAt(0) === "'" && raw.charAt(1) === '{') raw = raw.slice(1);
    let body = {}; try{ body = JSON.parse(raw); }catch(e){ continue; }
    const canon = formrunCanonV4_(body);
    const fields = {};
    CONTRACT_FORM_V4_HASH_KEYS.forEach(function(k){ fields[k] = canon[k] === undefined || canon[k] === null ? '' : String(canon[k]); });
    if('v4:' + contractFormHashV4_(fields) === String(app.terms_hash || '')) return fields;
  }
  return null;
}

/** v4の自動締結経路。法人・未成年・海外・イベント・その他・特約は個別確認。 */
function decideContractRouteV4_(ctx){
  ctx = ctx || {};
  const reasons = [];
  const rule = ctx.usageCategory ? feeRuleFor_(ctx.usageCategory) : null;
  if(!rule) reasons.push('料金表が未設定');
  if(String(ctx.partyType || '') === 'CORPORATION') reasons.push('法人申込は現行制度の標準契約対象外');
  if(/イベント|EVENT/i.test(String(ctx.usageCategory||''))) reasons.push('イベント利用は制度条件の個別確認が必要');
  if(/その他|OTHER/i.test(String(ctx.usageCategory||''))) reasons.push('利用目的がその他');
  if((ctx.workIds || []).length > formMaxWorks_()) reasons.push('対象原作数が上限超過');
  if(ctx.isMinor) reasons.push('未成年');
  if(ctx.isOverseas) reasons.push('海外居住');
  if(ctx.hasSpecialTerms) reasons.push('特約あり');
  const model = rule ? String(rule.fee_model||'').toUpperCase() : '';
  if(rule && ['RATE','FLAT','PER_WORK'].indexOf(model) < 0) reasons.push('利用目的と料金モデルが不整合');
  if(reasons.length) return { route:'MANUAL_REVIEW', reasons:reasons };
  return { route:model === 'RATE' ? 'STANDARD_RATE' : 'STANDARD_FIXED', reasons:[] };
}
