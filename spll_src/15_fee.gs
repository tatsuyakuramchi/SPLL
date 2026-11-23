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
/**
 * 支払方法（利用許諾契約書 第6条第2項：利用区分ごとに料金表で定める）。PREPAID＝前払い／POSTPAID＝後払い／OFFSET＝相殺。
 * 料金表の payment_timing 列が空の行は、売上連動（RATE）なら後払い（利用報告で金額が決まるため）、
 * それ以外は Config DEFAULT_PAYMENT_TIMING（既定 PREPAID）。
 */
const PAYMENT_TIMINGS = ['PREPAID','POSTPAID','OFFSET'];   // OFFSET＝相殺（電子書籍：配信会社からの入金と相殺して残額を支払う。期限超過の判定はしない）
function paymentTimingOfRule_(r){
  if(!r) return '';
  const v = String(r.payment_timing || '').toUpperCase();
  if(PAYMENT_TIMINGS.indexOf(v) >= 0) return v;
  if(String(r.fee_model || '').toUpperCase() === 'RATE') return 'POSTPAID';
  const d = String(getConfig_('DEFAULT_PAYMENT_TIMING', 'PREPAID') || 'PREPAID').toUpperCase();
  return PAYMENT_TIMINGS.indexOf(d) >= 0 ? d : 'PREPAID';
}
function paymentTimingFor_(usageCategory){ return paymentTimingOfRule_(feeRuleFor_(usageCategory)); }
/** 公開：利用目的の選択肢（申込フォーム用） */
function api_getUsageOptions(){
  return feeRows_().map(function(r){ return { category:r.usage_category, fee_model:r.fee_model, fee_label:r.fee_label || '' }; });
}
/**
 * 利用目的（と原作数）から別紙2の各条件を計算して返す。反映はこの結果を用いる。
 *  RATE=売上連動（率のみ・金額は後日利用報告で確定）／FLAT=定額（二次創作物1つにつき）。
 *  請求も料率も、二次創作物1つにつき1つ。対象原作の数では増えない（利用許諾契約書 第6条第1項）。受け取った額は原作の数で均等に分配する。
 *  PER_WORK（原作数比例）は廃止。旧データに残っていても定額として扱う。
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
    if(n > 1) feeText += '（' + n + '原作でも同率・権利者間で均等に分配）';
  }else{ // FLAT（PER_WORK は廃止し定額として扱う）：二次創作物1つにつき定額。複数原作でも金額は変わらず、権利者間で均等に分配する
    amount = Math.round(val);
    if(!feeText) feeText = yen_(amount) + '／契約';
    if(n > 1) feeText += '（' + n + '原作合計・許諾料は権利者間で分配）';
  }
  return {
    usage_category: r.usage_category, fee_model: model, rate: rate, amount: amount,
    fee_amount_or_rate: feeText, licensed_uses: r.licensed_uses || '', payment_due: r.payment_due || '',
    reporting_requirement: r.reporting_requirement || '', report_due: r.report_due || '',
    threshold_or_cap: r.threshold_or_cap || '', reprint_rule: r.reprint_rule || '', special_terms: r.special_terms || '',
    requires_usage_report: String(r.requires_usage_report) === 'true' || model === 'RATE',   // 構造化（V2-017）
    report_frequency: r.report_frequency || '', report_due_days: num_(r.report_due_days) || 0,
    report_due_base: r.report_due_base || 'PERIOD_END',
    payment_timing: paymentTimingOfRule_(r),
    found: true
  };
}
/** 公開：別紙2プレビュー（申込フォームで利用目的選択時に表示） */
function api_previewFeeTerms(usageCategory, workCount){ return computeFeeTerms_(usageCategory, workCount); }

/**
 * 料金表の版。料金表を保存するたびに、その時点の全行を Fee_Schedule_Versions に固定し、Config FEE_SCHEDULE_VERSION を更新する。
 * 案件（License_Cases.fee_schedule_version）は申込時の版を持ち、別紙の「料金表 ○○版により算定」はこの版名を書く。
 * 版名：YYYY-MM-DD.n（同じ日の n 回目）
 */
function currentFeeScheduleVersion_(){ return String(getConfig_('FEE_SCHEDULE_VERSION', '') || ''); }
function publishFeeScheduleVersion_(actor){
  const rows = readRows_(ssMaster_(), 'Fee_Schedule');
  const json = JSON.stringify(rows);
  const day = Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd');
  const same = readRows_(ssOps_(), 'Fee_Schedule_Versions').filter(function(v){ return String(v.version).indexOf(day + '.') === 0; }).length;
  const version = day + '.' + (same + 1);
  appendRow_(ssOps_(), 'Fee_Schedule_Versions', { version: version, rows_json: sanitizeCell_(json.slice(0, 45000)), rows_hash: hash_(json),
    published_at: new Date().toISOString(), published_by: actor || 'system' });
  setConfig_('FEE_SCHEDULE_VERSION', version);
  return version;
}

