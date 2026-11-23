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
 *   DISTRIBUTION_FEE_PERCENT … 分配前に差し引く事務局手数料（%。既定 0）
 */
const DISTRIBUTION_BASES = ['EXCL_TAX','INCL_TAX'];
const DISTRIBUTION_REMAINDERS = ['FIRST_WORK','SECRETARIAT'];

function distributionConfig_(){
  const base = String(getConfig_('DISTRIBUTION_BASE', 'EXCL_TAX') || 'EXCL_TAX').toUpperCase();
  const rem = String(getConfig_('DISTRIBUTION_REMAINDER', 'FIRST_WORK') || 'FIRST_WORK').toUpperCase();
  const fee = Number(getConfig_('DISTRIBUTION_FEE_PERCENT', '0')) || 0;
  return { base: DISTRIBUTION_BASES.indexOf(base) >= 0 ? base : 'EXCL_TAX',
    remainder: DISTRIBUTION_REMAINDERS.indexOf(rem) >= 0 ? rem : 'FIRST_WORK',
    feePercent: Math.max(0, Math.min(100, fee)) };
}

/**
 * 分配の計算（純粋関数）。
 *   totalInclTax … 受け取った利用許諾料（税込）
 *   works        … 別紙の対象原作（別紙の並び順）[{ work_id, partner_id, partner_name }]
 *   cfg          … distributionConfig_() と同じ形
 * 戻り値：{ base_kind, base_amount, fee_amount, distributable, unit, remainder, per_work:[...], per_partner:[...] }
 * 合計は必ず distributable と一致する（端数は設定に従って寄せる）。
 */
function computeDistribution_(totalInclTax, works, cfg){
  cfg = cfg || distributionConfig_();
  const list = (works || []).filter(function(w){ return w && w.work_id; });
  if(!list.length) throw new Error('VALIDATION_ERROR: 分配先の対象原作がありません');
  const a = invoiceAmounts_(totalInclTax);
  const base = cfg.base === 'INCL_TAX' ? a.total : a.excl;
  const fee = Math.floor(base * (cfg.feePercent || 0) / 100);
  const distributable = base - fee;
  const n = list.length;
  const unit = Math.floor(distributable / n);
  const remainder = distributable - unit * n;
  const perWork = list.map(function(w, i){
    const adj = (i === 0 && cfg.remainder === 'FIRST_WORK') ? remainder : 0;
    return { work_id: String(w.work_id), partner_id: String(w.partner_id || 'UNKNOWN'), partner_name: String(w.partner_name || ''),
      share_count: 1, share_total: n, amount: unit + adj, rounding_adjust: adj };
  });
  const byPartner = {};
  perWork.forEach(function(r){
    const p = byPartner[r.partner_id] || (byPartner[r.partner_id] = { partner_id: r.partner_id, partner_name: r.partner_name, shares: 0, amount: 0 });
    p.shares += 1; p.amount += r.amount;
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
    .map(function(w){ return { work_id: w.work_id, partner_id: w.partner_id_snapshot || 'UNKNOWN', partner_name: w.partner_name_snapshot || '' }; });
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
