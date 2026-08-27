/** SPLL 28_contract_form_v4_shared ― CloudSign FORM v4 共通：個別条件・ハッシュ・改変検知 */

const CONTRACT_FORM_V4_VERSION = 'v4.1';

/**
 * CloudSign FORM（formrun）へ実際に転送する項目。
 *
 * formrunの「初期値つき公開フォームURL」は1000文字までという制約があり、日本語はURLエンコードで
 * 3倍前後に膨らむ。全条件をURLに載せるとクレジット表記や原作名だけで上限に届くため、
 * 契約書へ差し込む最小限だけを転送し、残りはテンプレートの固定文言とする。
 * SPLL側は全条件（CONTRACT_FORM_V4_HASH_KEYS）を内部スナップショットとして保持し続ける。
 */
const CONTRACT_FORM_V4_TRANSFER_KEYS = [
  'license_id','application_ref','usage_category','work_names','licensor_name','fee_amount_or_rate','credit_text'
];
/** URLに載せる転送項目以外のシステム項目（改変検知・経路特定） */
const CONTRACT_FORM_V4_CONTROL_KEYS = ['handoff_token','terms_snapshot_hash','template_route'];

/** terms_snapshot_hash の対象＝契約個別条件の全体。転送しない項目も含む。 */
const CONTRACT_FORM_V4_HASH_KEYS = [
  'contract_template_version','license_id','application_ref','usage_category','work_count','work_names',
  'work_id_1','work_title_1','work_id_2','work_title_2','work_id_3','work_title_3',
  'work_id_4','work_title_4','work_id_5','work_title_5',
  'licensor_name','license_term','territory','fee_model','fee_value','fee_amount_or_rate',
  'licensed_uses','payment_terms','reporting_terms','credit_text','special_terms'
];

/** 料金・原作条件からCloudSign FORMへ渡す個別条件を生成。クリエーターの入力ではなくSPLL側の確定値。 */
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

/** 全条件から、FORMへ転送する項目だけを取り出す（内部スナップショットは全条件のまま保持する）。 */
function contractFormTransferFieldsV4_(fields){
  const out = {};
  CONTRACT_FORM_V4_TRANSFER_KEYS.forEach(function(k){
    out[k] = (fields && fields[k] !== undefined && fields[k] !== null) ? String(fields[k]) : '';
  });
  return out;
}

/**
 * 経路サフィックス。3経路それぞれformrun上で別フォームなので、項目IDのマップも別に持つ。
 * 個別確認にも専用の枠を与える：共通マップは経路別が未設定のときのフォールバック先を兼ねるため、
 * そこに個別確認用の番号を置くと、経路別を入れ忘れた側が黙って誤った項目IDでURLを組んでしまう。
 */
function formRouteSuffix_(route){
  if(route === 'STANDARD_FIXED') return '_FIXED';
  if(route === 'STANDARD_RATE')  return '_RATE';
  if(route === 'MANUAL_REVIEW')  return '_MANUAL';
  return '';
}
/** 経路別の設定（FORM_HIDDEN_MAP_FIXED 等）。未設定なら共通設定へフォールバックする。 */
function formMapByRoute_(baseKey, route){
  const suffix = formRouteSuffix_(route);
  if(suffix){
    const byRoute = parseJson_(prop_(baseKey + suffix), null);
    if(byRoute && typeof byRoute === 'object') return byRoute;
  }
  return parseJson_(prop_(baseKey), {}) || {};
}
/** canonical key → formrunのhidden項目キー（_field_N） */
function formHiddenMapV4_(route){ return formMapByRoute_('FORM_HIDDEN_MAP', route); }
/** formrunの実フィールド名/ID → canonical key */
function formrunFieldMapV4_(route){ return formMapByRoute_('FORMRUN_FIELD_MAP', route); }

/** 初期値つき公開フォームURLの上限（formrun仕様1000字に対し余裕を持たせる） */
function formUrlMaxChars_(){ return num_(getConfig_('FORM_URL_MAX_CHARS','850')) || 850; }
/**
 * 初期値つき公開フォームURLを組み立てる。
 *
 * 定額用と売上連動用はformrun上で別のフォームなので、hidden項目のキー（_field_xxxx）も別になる。
 * 画面側が持っているのは共通の FORM_HIDDEN_MAP だけで経路別マップを引けないため、
 * URLはここで確定させる。画面で組み直すと、定額用の項目IDのまま売上連動用フォームを開き、
 * 初期値が入らないまま条件の無い契約書が送られてしまう。
 */
function contractFormUrlV4_(baseUrl, route, transfer, control){
  const base = String(baseUrl || '');
  if(!base) return '';                                 // URL未設定は別途案内される
  const map = formHiddenMapV4_(route);
  const parts = [];
  const add = function(k, v){
    const actual = map[k] || k; if(!actual) return;
    parts.push(encodeURIComponent(actual) + '=' + encodeURIComponent(v === undefined || v === null ? '' : String(v)));
  };
  CONTRACT_FORM_V4_CONTROL_KEYS.forEach(function(k){ if(control && control[k] !== undefined) add(k, control[k]); });
  CONTRACT_FORM_V4_TRANSFER_KEYS.forEach(function(k){ if(transfer && transfer[k] !== undefined) add(k, transfer[k]); });
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
}

/**
 * 実際にポータルが開く公開フォームURLの長さ。
 * 上限を超えると初期値がフォームへ届かず、条件の入っていない契約書が送られてしまうため、
 * 申込の時点で検出して個別確認（MANUAL_REVIEW）へ退避させる。
 */
function estimateFormUrlLengthV4_(baseUrl, route, transfer, control){
  return contractFormUrlV4_(baseUrl, route, transfer, control).length;
}

/**
 * URLの何が長いのかを、字数の多い順に並べる。
 * 上限超過は「どれかを短くすれば収まる」という運用判断につながるので、
 * 事務局が原因を特定できるように内訳を残す（日本語はURLエンコードで3倍前後になる）。
 */
function formUrlLengthBreakdownV4_(route, transfer, control, top){
  const map = formHiddenMapV4_(route);
  const parts = [];
  const add = function(k, v){
    const actual = map[k] || k; if(!actual) return;
    const len = encodeURIComponent(actual).length + 1 +
      encodeURIComponent(v === undefined || v === null ? '' : String(v)).length;
    parts.push({ key:k, length:len });
  };
  CONTRACT_FORM_V4_CONTROL_KEYS.forEach(function(k){ if(control && control[k] !== undefined) add(k, control[k]); });
  CONTRACT_FORM_V4_TRANSFER_KEYS.forEach(function(k){ if(transfer && transfer[k] !== undefined) add(k, transfer[k]); });
  return parts.sort(function(a, b){ return b.length - a.length; }).slice(0, top || 3);
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

/**
 * FormRun payloadをcanonical keyへ正規化。FORMRUN_FIELD_MAPは「実フィールド名/ID → canonical key」。
 * routeを渡すと経路別マップ（FORMRUN_FIELD_MAP_FIXED / _RATE）を優先する。
 * 経路は申込を特定してから分かるため、呼び出し側は「共通マップで一度正規化 → 申込を特定 → 経路別で再正規化」とする。
 */
function formrunCanonV4_(body, route){
  body = body || {};
  const map = formrunFieldMapV4_(route);
  const canon = {};
  function put(rawKey, value){
    if(rawKey === undefined || rawKey === null) return;
    const key = map[String(rawKey)] || String(rawKey);
    canon[key] = value;
  }
  // formrunの実payloadは fields:[{key:'_field_6', label:'handoff_token', value:'…'}] の形。
  // columns は旧形式・他サービス互換のため残す。ラベル→キーの順に入れ、
  // FORMRUN_FIELD_MAP でキーを明示している場合はそちらが後勝ちで優先される。
  (body.fields || []).forEach(function(c){
    put(c.label || c.name, c.value);
    if(c.key) put(c.key, c.value);
    if(c.id) put(c.id, c.value);
  });
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

/**
 * v4の自動締結経路。未成年・海外・イベント・その他・特約は個別確認（申込は受け付ける）。
 * 法人は本窓口の対象外＝個別契約ルートへ退避させるため、web_createApplicationV4 が申込作成前に拒否する。
 * ここで CORPORATION を MANUAL_REVIEW に落とすのは、旧データの再申込など後段経路での保険。
 */
function decideContractRouteV4_(ctx){
  ctx = ctx || {};
  const reasons = [];
  const rule = ctx.usageCategory ? feeRuleFor_(ctx.usageCategory) : null;
  if(!rule) reasons.push('料金表が未設定');
  if(String(ctx.partyType || '') === 'CORPORATION') reasons.push('法人は本窓口の対象外（個別契約ルート）');
  if(/イベント|EVENT/i.test(String(ctx.usageCategory||''))) reasons.push('イベント利用は制度条件の個別確認が必要');
  if(/その他|OTHER/i.test(String(ctx.usageCategory||''))) reasons.push('利用目的がその他');
  if((ctx.workIds || []).length > formMaxWorks_()) reasons.push('対象原作数が上限超過');
  // クレジット・原作名が契約書テンプレートの差込枠を超える場合（既定400字）
  if(ctx.workIds && ctx.workIds.length){
    const master = readRows_(ssMaster_(),'Works_Master');
    const creditLen = ctx.workIds.map(function(id){
      const w = master.find(function(x){ return String(x.work_id) === String(id); });
      return w ? (String(w.credit_text||'') + String(w.work_name||'')) : ''; }).join('').length;
    if(creditLen > (num_(getConfig_('CS_CREDIT_MAX_CHARS','400')) || 400)) reasons.push('クレジット表記が上限超過');
  }
  if(ctx.isMinor) reasons.push('未成年');
  if(ctx.isOverseas) reasons.push('海外居住');
  if(ctx.hasSpecialTerms) reasons.push('特約あり');
  const model = rule ? String(rule.fee_model||'').toUpperCase() : '';
  if(rule && ['RATE','FLAT','PER_WORK'].indexOf(model) < 0) reasons.push('利用目的と料金モデルが不整合');
  if(reasons.length) return { route:'MANUAL_REVIEW', reasons:reasons };
  return { route:model === 'RATE' ? 'STANDARD_RATE' : 'STANDARD_FIXED', reasons:[] };
}
