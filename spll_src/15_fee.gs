/** SPLL 15_fee ― 利用料条件（別紙2）：料金表の解決・計算（GAS①プレビュー／GAS②スナップショット／GAS③編集） */

function formMaxWorks_(){ return parseInt(prop_('FORM_MAX_WORKS') || '5', 10) || 5; }

// ============================================================
// 利用料条件（別紙2）：利用目的ごとの一律ルールを事前設定し、申込時に自動計算・反映
// ============================================================
/** 料金表（有効行のみ） */
function feeRows_(){ return readRows_(ssMaster_(),'Fee_Schedule').filter(function(r){ return String(r.active) !== 'false' && r.usage_category; }); }
/** 利用目的に対応する料金ルール（無ければ null） */
function feeRuleFor_(usageCategory){
  return feeRows_().find(function(r){ return String(r.usage_category) === String(usageCategory); }) || null;
}
/** 公開：利用目的の選択肢（申込フォーム用） */
function api_getUsageOptions(){
  return feeRows_().map(function(r){ return { category:r.usage_category, fee_model:r.fee_model, fee_label:r.fee_label || '' }; });
}
/**
 * 利用目的（と原作数）から別紙2の各条件を計算して返す。反映はこの結果を用いる。
 *  RATE=売上連動（率のみ・金額は後日利用報告で確定）／FLAT=定額（契約単位）／PER_WORK=原作数比例。
 */
function computeFeeTerms_(usageCategory, workCount){
  const n = Math.max(1, parseInt(workCount || 1, 10) || 1);
  const r = feeRuleFor_(usageCategory);
  if(!r){
    return { usage_category:usageCategory||'', fee_model:'', rate:null, amount:null,
      fee_amount_or_rate:'（利用目的が未設定です）', licensed_uses:'', payment_due:'', reporting_requirement:'',
      report_due:'', threshold_or_cap:'', reprint_rule:'', special_terms:'', found:false };
  }
  const model = String(r.fee_model || 'RATE').toUpperCase();
  const val = num_(r.fee_value);
  let rate = null, amount = null, feeText = r.fee_label || '';
  if(model === 'RATE'){
    rate = val;
    if(!feeText) feeText = '売上の' + Math.round(val * 1000) / 10 + '％';
  }else if(model === 'PER_WORK'){
    amount = Math.round(val) * n;
    feeText = (r.fee_label || (yen_(val) + '／原作')) + ' × ' + n + '件 ＝ ' + yen_(amount);
  }else{ // FLAT
    amount = Math.round(val);
    if(!feeText) feeText = yen_(amount);
  }
  return {
    usage_category: r.usage_category, fee_model: model, rate: rate, amount: amount,
    fee_amount_or_rate: feeText, licensed_uses: r.licensed_uses || '', payment_due: r.payment_due || '',
    reporting_requirement: r.reporting_requirement || '', report_due: r.report_due || '',
    threshold_or_cap: r.threshold_or_cap || '', reprint_rule: r.reprint_rule || '', special_terms: r.special_terms || '',
    requires_usage_report: String(r.requires_usage_report) === 'true' || model === 'RATE',   // 構造化（V2-017）
    report_frequency: r.report_frequency || '', report_due_days: num_(r.report_due_days) || 0,
    report_due_base: r.report_due_base || 'PERIOD_END',
    found: true
  };
}
/** 公開：別紙2プレビュー（申込フォームで利用目的選択時に表示） */
function api_previewFeeTerms(usageCategory, workCount){ return computeFeeTerms_(usageCategory, workCount); }
