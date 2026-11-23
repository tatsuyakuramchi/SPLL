/**
 * SPLL 49_distribution ― 利用許諾料の分配の計算と記録（GAS③ 管理。改修計画 P5-5）
 *
 * 請求は二次創作物1つ（別紙1通・SPLL番号1つ）につき料金表の額。対象原作がいくつあっても請求額は変わらない。
 * 受け取った利用許諾料は、対象原作の数で等分して、各原作の権利者（パートナー）へ分配する
 * （利用許諾契約書 第6条第10項、SPLLパートナーシップ契約）。
 *   例：原作A・Bを使った二次創作物C → 請求 16,500円（税込）。分配は A・B に 1/2 ずつ。
 *   同じパートナーの原作が2つあれば、そのパートナーには 2/n。
 *   後払い（電子書籍の精算など）も同じ。売上連動の料率も二次創作物ごとに1つで、得た利用許諾料を原作の数で均等に分ける
 *   （例：料率10%・原作2つ → 10%分の利用許諾料を 1/2 ずつ。5%ずつではなく、20%にもならない）。
 *
 * 計算の設定（Config）
 *   DISTRIBUTION_BASE      … EXCL_TAX（既定・税抜額を分ける）／INCL_TAX（税込額を分ける）
 *   DISTRIBUTION_REMAINDER … FIRST_WORK（既定・割り切れない端数は別紙の先頭の原作へ）／SECRETARIAT（事務局に残す）
 *   DISTRIBUTION_FEE_PERCENT … 分配前に差し引く事務局手数料（%。既定 50）。管理画面（設定）から変更できる
 *     （admin_getDistributionConfig / admin_saveDistributionConfig。変更は Events に前後の値を残す）
 */
const DISTRIBUTION_BASES = ['EXCL_TAX','INCL_TAX'];
const DISTRIBUTION_REMAINDERS = ['FIRST_WORK','SECRETARIAT'];
/** 事務局手数料の既定値（%）。分配前に差し引き、残りを原作の数で等分する */
const DISTRIBUTION_FEE_PERCENT_DEFAULT = 50;

function distributionConfig_(){
  const base = String(getConfig_('DISTRIBUTION_BASE', 'EXCL_TAX') || 'EXCL_TAX').toUpperCase();
  const rem = String(getConfig_('DISTRIBUTION_REMAINDER', 'FIRST_WORK') || 'FIRST_WORK').toUpperCase();
  const feeRaw = getConfig_('DISTRIBUTION_FEE_PERCENT', String(DISTRIBUTION_FEE_PERCENT_DEFAULT));
  const fee = (feeRaw === '' || feeRaw === null || isNaN(Number(feeRaw))) ? DISTRIBUTION_FEE_PERCENT_DEFAULT : Number(feeRaw);
  return { base: DISTRIBUTION_BASES.indexOf(base) >= 0 ? base : 'EXCL_TAX',
    remainder: DISTRIBUTION_REMAINDERS.indexOf(rem) >= 0 ? rem : 'FIRST_WORK',
    feePercent: Math.max(0, Math.min(100, fee)) };
}

/**
 * 分配の計算（純粋関数）。
 *   totalInclTax … 受け取った利用許諾料（税込）
 *   works        … 別紙の対象原作（別紙の並び順）。権利者は次のどちらかで渡す
 *                   { work_id, partner_id, partner_name }                         … 権利者が1社
 *                   { work_id, holders:[{ partner_id, name, weight }] }           … 共同権利（持ち分で分ける）
 *                   { work_id, unresolved:true, reason }                          … 権利者が決まっていない → 計算しない
 *   cfg          … distributionConfig_() と同じ形
 * 原作の数で等分し、共同権利の原作はその原作の取り分を持ち分で分ける。端数は設定に従って寄せ、合計は必ず一致する。
 * 戻り値：{ base_kind, base_amount, fee_amount, distributable, unit, remainder, per_work:[{work_id, partner_id, ...}], per_partner:[...] }
 */
function computeDistribution_(totalInclTax, works, cfg){
  cfg = cfg || distributionConfig_();
  const list = (works || []).filter(function(w){ return w && w.work_id; });
  if(!list.length) throw new Error('VALIDATION_ERROR: 分配先の対象原作がありません');
  const bad = list.filter(function(w){ return w.unresolved; });
  if(bad.length) throw new Error('VALIDATION_ERROR: 権利者が決まっていない対象原作があります（' + bad.map(function(w){ return w.work_id + '：' + (w.reason || ''); }).join('、') + '）');
  const a = invoiceAmounts_(totalInclTax);
  const base = cfg.base === 'INCL_TAX' ? a.total : a.excl;
  const fee = Math.floor(base * (cfg.feePercent || 0) / 100);
  const distributable = base - fee;
  const n = list.length;
  const unit = Math.floor(distributable / n);
  const remainder = distributable - unit * n;
  const perWork = [];
  list.forEach(function(w, i){
    const workAmount = unit + ((i === 0 && cfg.remainder === 'FIRST_WORK') ? remainder : 0);
    const holders = (w.holders && w.holders.length) ? w.holders
      : [{ partner_id: String(w.partner_id || 'UNKNOWN'), name: String(w.partner_name || ''), weight: 1 }];
    const wsum = holders.reduce(function(s2, h){ return s2 + (Number(h.weight) || 0); }, 0) || 1;
    let given = 0;
    holders.forEach(function(h, k){
      const amt = k === holders.length - 1 ? workAmount - given : Math.floor(workAmount * (Number(h.weight) || 0) / wsum);
      given += amt;
      perWork.push({ work_id: String(w.work_id), partner_id: String(h.partner_id), partner_name: String(h.name || ''),
        share_count: 1, share_total: n, holder_weight: Number(h.weight) || 0, holder_weight_total: wsum,
        amount: amt, rounding_adjust: (i === 0 && cfg.remainder === 'FIRST_WORK' && k === 0) ? remainder : 0 });
    });
  });
  const byPartner = {};
  perWork.forEach(function(r){
    const p = byPartner[r.partner_id] || (byPartner[r.partner_id] = { partner_id: r.partner_id, partner_name: r.partner_name, shares: 0, amount: 0 });
    p.shares += r.holder_weight / (r.holder_weight_total || 1); p.amount += r.amount;
  });
  return { base_kind: cfg.base, base_amount: base, fee_amount: fee, distributable: distributable, unit: unit,
    remainder: remainder, remainder_to: cfg.remainder,
    secretariat_amount: fee + (cfg.remainder === 'SECRETARIAT' ? remainder : 0),
    per_work: perWork, per_partner: Object.keys(byPartner).map(function(k){ return byPartner[k]; }) };
}

/** 案件（SPLL番号）の対象原作と権利者（別紙のスナップショット。有効なものだけ・登録順） */
function distributionWorksOf_(licenseId){
  return readRows_(ssOps_(), 'License_Works')
    .filter(function(w){ return w.license_id === String(licenseId) && String(w.active) !== 'false'; })
    .map(function(w){
      let r = null;
      try{ r = w.rights_shares_snapshot ? JSON.parse(w.rights_shares_snapshot) : null; }catch(e){ r = null; }
      if(r && r.resolved === false) return { work_id: w.work_id, unresolved: true, reason: r.reason || '' };
      if(r && r.holders && r.holders.length) return { work_id: w.work_id, holders: r.holders };
      if(w.partner_id_snapshot === 'UNRESOLVED') return { work_id: w.work_id, unresolved: true, reason: w.partner_name_snapshot || '' };
      return { work_id: w.work_id, partner_id: w.partner_id_snapshot || 'UNKNOWN', partner_name: w.partner_name_snapshot || '' };
    });
}
/** 案件の対象原作のうち、権利者が決まっていないもの（別紙を作る前に確かめる。あれば個別確認へ） */
function unresolvedWorksOf_(licenseId){
  return distributionWorksOf_(licenseId).filter(function(w){ return w.unresolved; });
}

/**
 * 入金1件の分配を記録する（入金ごとに1回だけ。同じ payment_id は二度作らない）。
 *   source … 'PREPAID'（前払いの入金）／'EBOOK_SETTLEMENT'（電子書籍の精算）など
 *   period … 精算期間のラベル（例 '2026-Q4'）。四半期の精算でパートナーごとに合計する
 */
function recordDistribution_(licenseId, paymentId, totalInclTax, source, period){
  if(!paymentId) throw new Error('VALIDATION_ERROR: 入金IDがありません');
  const existing = readRows_(ssOps_(), 'Distributions').filter(function(d){ return d.payment_id === String(paymentId); });
  if(existing.length) return { created: false, rows: existing.length };
  const r = computeDistribution_(totalInclTax, distributionWorksOf_(licenseId));
  const now = new Date().toISOString();
  // 事務局の取り分（手数料＋事務局に残す端数）も1行で残し、行の合計が分ける前の金額と一致するようにする
  if(r.secretariat_amount > 0){
    appendRow_(ssOps_(), 'Distributions', {
      distribution_id: Utilities.getUuid(), license_id: String(licenseId), payment_id: String(paymentId), source: String(source || ''),
      work_id: '', partner_id: 'SECRETARIAT', partner_name: '事務局（手数料' + distributionConfig_().feePercent + '%' + (r.remainder_to === 'SECRETARIAT' && r.remainder ? '・端数' : '') + '）',
      share_count: 0, share_total: r.per_work.length, base_kind: r.base_kind, base_amount: r.base_amount,
      amount: r.secretariat_amount, rounding_adjust: r.remainder_to === 'SECRETARIAT' ? r.remainder : 0,
      period_label: String(period || ''), status: 'RECORDED', created_at: now });
  }
  r.per_work.forEach(function(w){
    appendRow_(ssOps_(), 'Distributions', {
      distribution_id: Utilities.getUuid(), license_id: String(licenseId), payment_id: String(paymentId), source: String(source || ''),
      work_id: w.work_id, partner_id: w.partner_id, partner_name: sanitizeCell_(w.partner_name),
      share_count: w.share_count, share_total: w.share_total, base_kind: r.base_kind, base_amount: r.base_amount,
      amount: w.amount, rounding_adjust: w.rounding_adjust, period_label: String(period || ''), status: 'RECORDED', created_at: now });
  });
  logEvent_('distribution', String(paymentId), 'system', null,
    { license_id: licenseId, base_amount: r.base_amount, distributable: r.distributable, works: r.per_work.length, period: period || '' });
  return { created: true, rows: r.per_work.length, result: r };
}

/** 期間ごとのパートナー別の合計（四半期の精算 Secretariat_Settlements の distribution_amount に使う） */
function distributionSummary_(period){
  const sum = {};
  readRows_(ssOps_(), 'Distributions').filter(function(d){ return !period || d.period_label === String(period); }).forEach(function(d){
    const k = d.partner_id || 'UNKNOWN';
    const p = sum[k] || (sum[k] = { partner_id: k, partner_name: d.partner_name || '', amount: 0, works: 0 });
    p.amount += Number(d.amount) || 0; p.works += 1;
  });
  return Object.keys(sum).map(function(k){ return sum[k]; }).sort(function(a, b){ return b.amount - a.amount; });
}

/** 【管理画面・設定】分配の設定を読む */
function admin_getDistributionConfig(){ requireRole_([]);
  const c = distributionConfig_();
  return { base: c.base, remainder: c.remainder, fee_percent: c.feePercent,
    bases: DISTRIBUTION_BASES, remainders: DISTRIBUTION_REMAINDERS, fee_default: DISTRIBUTION_FEE_PERCENT_DEFAULT };
}
/**
 * 【管理画面・設定】分配の設定を変える（法務・システム管理のみ）。変更は以後の入金から効く（記録済みの分配は変えない）。
 *   c … { base: 'EXCL_TAX'|'INCL_TAX', remainder: 'FIRST_WORK'|'SECRETARIAT', fee_percent: 0〜100 }
 */
function admin_saveDistributionConfig(c){ const actor = requireRole_(['LEGAL_ADMIN','SYSTEM_ADMIN']);
  c = c || {};
  const before = distributionConfig_();
  if(c.base !== undefined){
    const v = String(c.base).toUpperCase();
    if(DISTRIBUTION_BASES.indexOf(v) < 0) throw new Error('VALIDATION_ERROR: 分ける金額は EXCL_TAX（税抜）か INCL_TAX（税込）です');
    setConfig_('DISTRIBUTION_BASE', v);
  }
  if(c.remainder !== undefined){
    const v = String(c.remainder).toUpperCase();
    if(DISTRIBUTION_REMAINDERS.indexOf(v) < 0) throw new Error('VALIDATION_ERROR: 端数の寄せ先は FIRST_WORK（先頭の原作）か SECRETARIAT（事務局）です');
    setConfig_('DISTRIBUTION_REMAINDER', v);
  }
  if(c.fee_percent !== undefined){
    const n = Number(c.fee_percent);
    if(String(c.fee_percent).trim() === '' || isNaN(n) || n < 0 || n > 100)
      throw new Error('VALIDATION_ERROR: 事務局手数料は 0〜100 の数（%）で指定してください（指定値: ' + c.fee_percent + '）');
    setConfig_('DISTRIBUTION_FEE_PERCENT', String(n));
  }
  const after = distributionConfig_();
  logEvent_('config', 'DISTRIBUTION', (actor && actor.email) || actor_(), before, after);
  return admin_getDistributionConfig();
}

/**
 * 分配の取消（返金・別紙の取消など）。元の入金の分配を打ち消す行（金額をマイナスにした行）を足す。
 * 元の行は消さない（いつ・なぜ取り消したかを残す）。同じ入金の取消は1回だけ。
 */
function reverseDistribution_(paymentId, reason, actor){
  const why = String(reason || '').trim();
  if(!why) throw new Error('VALIDATION_ERROR: 取消の理由を入力してください');
  const rows = readRows_(ssOps_(), 'Distributions').filter(function(d){ return d.payment_id === String(paymentId); });
  if(!rows.length) throw new Error('DATA_NOT_FOUND: この入金の分配がありません: ' + paymentId);
  if(rows.some(function(d){ return d.status === 'REVERSAL'; })) return { created: false, rows: 0 };
  const now = new Date().toISOString();
  rows.filter(function(d){ return d.status === 'RECORDED'; }).forEach(function(d){
    appendRow_(ssOps_(), 'Distributions', Object.assign({}, d, {
      distribution_id: Utilities.getUuid(), amount: -Number(d.amount || 0), rounding_adjust: -Number(d.rounding_adjust || 0),
      status: 'REVERSAL', source: String(d.source || '') + ':取消', created_at: now }));
  });
  logEvent_('distribution', String(paymentId), actor || 'system', { status: 'RECORDED' }, { status: 'REVERSED', reason: why });
  return { created: true, rows: rows.length };
}

