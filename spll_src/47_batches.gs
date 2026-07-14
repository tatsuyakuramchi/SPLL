/** SPLL 47_batches ― バッチ・時間主導トリガー（GAS②で setup_triggers を実行） */


// ============================================================
// 8. 定期処理・トリガー・データ削除（修正設計書 §18/§20・OPS-01・FUN-05）
// ============================================================
/** バッチ実行ラッパ：開始・終了・件数・エラーを Batch_Runs に記録する */
function batchRun_(name, fn){
  const runId = Utilities.getUuid();
  appendRow_(ssOps_(),'Batch_Runs',{ batch_run_id:runId, batch_name:name,
    started_at:new Date().toISOString(), finished_at:'', processed:'', errors:'', status:'RUNNING', detail:'' });
  try{
    const r = fn() || {};
    updateRow_(ssOps_(),'Batch_Runs','batch_run_id',runId,{ finished_at:new Date().toISOString(),
      processed:(r.processed!=null?r.processed:''), errors:(r.errors!=null?r.errors:0), status:'DONE', detail:JSON.stringify(r).slice(0,500) });
    return r;
  }catch(err){
    updateRow_(ssOps_(),'Batch_Runs','batch_run_id',runId,{ finished_at:new Date().toISOString(), status:'ERROR', detail:String(err).slice(0,500) });
    logError_('PROCESSING_ERROR','batch:'+name, err);
    throw err;
  }
}
// ---- トリガー・ハンドラ（setup_triggers で作成） ----
function trigger_every5min(){                     // Webhook再処理＋AI審査キュー＋バッジ再試行
  batchRun_('processWebhookReceipts', processWebhookReceipts_);
  batchRun_('runAiReviews', batch_runAiReviews_);
  batchRun_('retryBadgeJobs', retryBadgeJobs_);
}
function trigger_daily(){                         // 期限処理・みなし確認・SLA・データ削除
  batchRun_('expireAccessTokens', expireAccessTokens_);
  batchRun_('closeObjectionPeriods', function(){ confirmDeemed_(); return {}; });
  batchRun_('notifyReviewSla', notifyReviewSla_);
  batchRun_('notifyReportDue', notifyReportDue_);
  batchRun_('purgeExpiredData', purgeExpiredData_);
}

/** 審査SLA監視（§18）：人手審査待ちがSLA日数を超過→通知キューへ（提出単位で1回） */
function notifyReviewSla_(){
  const slaDays = num_(getConfig_('REVIEW_SLA_DAYS','5')) || 5;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - slaDays);
  // SLA起点は最新版の提出日時（V2-017-1/2：再提出で期限を再計算）
  const latestBySub = {};
  readRows_(ssOps_(),'Submission_Versions').forEach(function(v){
    const cur = latestBySub[v.submission_id];
    if(!cur || num_(v.version_no) > num_(cur.version_no)) latestBySub[v.submission_id] = v;
  });
  let n = 0;
  readRows_(ssOps_(),'Submissions')
    .filter(function(s){
      const lv = latestBySub[s.submission_id];
      const base = (lv && lv.submitted_at) || s.submitted_at;
      return s.status === 'HUMAN_REVIEW_PENDING' && base && new Date(base) < cutoff;
    })
    .forEach(function(s){
      const lv = latestBySub[s.submission_id];
      if(enqueueNotification_(s.contract_id, 'REVIEW_SLA_OVERDUE', s.submission_id + ':v' + ((lv&&lv.version_no)||1),
        { submission_id:s.submission_id, title:s.title, version:(lv&&lv.version_no)||1,
          submitted_at:String((lv&&lv.submitted_at)||s.submitted_at||'').slice(0,10), sla_days:slaDays,
          action:'審査キューから人手判断を実施してください' })) n++;
    });
  return { processed:n };
}

/**
 * 報告期限監視（V2-017-3/4）：契約条件（terms_snapshot.requires_usage_report / report_due_days）
 * に基づき、直近終了した期の報告期限窓内で未報告の契約へ REPORT_REQUEST を起票（契約×期で1回）。
 */
function notifyReportDue_(){
  const now = new Date();
  // 直近に終了した期とその終了日
  const y = now.getFullYear();
  let period, periodEnd;
  if(now.getMonth() < 6){ period = (y-1) + 'H2'; periodEnd = new Date(y-1, 11, 31); }
  else { period = y + 'H1'; periodEnd = new Date(y, 5, 30); }
  const reported = {};
  readRows_(ssOps_(),'Usage_Reports').forEach(function(r){
    if(String(r.period) === period && r.status !== 'RETURNED' && r.status !== 'SUPERSEDED') reported[r.contract_id] = true; });
  let n = 0;
  readRows_(ssOps_(),'Contracts')
    .filter(function(c){ return c.status === 'SIGNED' && c.link_status !== 'UNLINKED'; })
    .forEach(function(c){
      let t = {}; try{ t = JSON.parse(c.terms_snapshot||'{}'); }catch(e){}
      const requires = t.requires_usage_report === true || String(t.requires_usage_report) === 'true' ||
        String(t.fee_model).toUpperCase() === 'RATE';
      if(!requires || reported[c.contract_id]) return;
      if(c.signed_at && new Date(c.signed_at) > periodEnd) return;      // 期終了後に締結した契約は対象外
      const dueDays = num_(t.report_due_days) || 30;
      const due = new Date(periodEnd.getTime()); due.setDate(due.getDate() + dueDays);
      const windowEnd = new Date(due.getTime()); windowEnd.setDate(windowEnd.getDate() + 30);   // 期限後30日まで督促
      if(now < periodEnd || now > windowEnd) return;
      if(enqueueNotification_(c.contract_id, 'REPORT_REQUEST', c.contract_id + ':' + period,
        { period:period, due_date:due.toISOString().slice(0,10),
          action:'報告リンクを発行して利用者へ案内してください（報告・入金・清算→報告リンク）' })) n++;
    });
  return { processed:n };
}
/** トリガーの冪等セットアップ（Apps Scriptエディタから1回 Run） */
function setup_triggers(){
  const handlers = { trigger_every5min:'MIN5', trigger_daily:'DAILY' };
  const existing = {};
  ScriptApp.getProjectTriggers().forEach(function(t){ existing[t.getHandlerFunction()] = true; });
  const made = [];
  if(!existing.trigger_every5min){ ScriptApp.newTrigger('trigger_every5min').timeBased().everyMinutes(5).create(); made.push('trigger_every5min'); }
  if(!existing.trigger_daily){ ScriptApp.newTrigger('trigger_daily').timeBased().everyDays(1).atHour(3).create(); made.push('trigger_daily'); }
  logEvent_('batch','setup_triggers','setup',null,{ created:made });
  return { created:made, skipped:Object.keys(existing) };
}
/** 期限切れアクセストークンを EXPIRED へ（§18） */
function expireAccessTokens_(){
  const now = new Date(); let n = 0;
  readRows_(ssOps_(),'Access_Tokens')
    .filter(function(t){ return t.status === 'OPEN' && t.expires_at && new Date(t.expires_at) < now; })
    .forEach(function(t){ updateRow_(ssOps_(),'Access_Tokens','token_id',t.token_id,{ status:'EXPIRED' }); n++; });
  return { processed:n };
}
/**
 * 保有期間に基づく削除・匿名化（FUN-05/§20）。
 * 契約未成立の申込：APPLICATION_RETENTION_DAYS（既定365日）経過で参照情報を匿名化。
 */
function purgeExpiredData_(){
  const days = num_(getConfig_('APPLICATION_RETENTION_DAYS','365')) || 365;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  const contracted = {}; readRows_(ssOps_(),'Contracts').forEach(function(c){ if(c.application_id) contracted[c.application_id] = true; });
  let n = 0;
  readRows_(ssOps_(),'Applications')
    .filter(function(a){ return !contracted[a.application_id] && a.status !== 'SIGNED' && a.status !== 'PURGED' &&
      a.created_at && new Date(a.created_at) < cutoff; })
    .forEach(function(a){
      updateRow_(ssOps_(),'Applications','application_id',a.application_id,{ status:'PURGED', application_ref:'' });
      logEvent_('application', a.application_id, 'system', {status:a.status}, { purged:true, retention_days:days });
      n++;
    });
  return { processed:n };
}
