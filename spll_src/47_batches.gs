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
function trigger_daily(){                         // 期限処理・SLA・データ削除
  batchRun_('expireAccessTokens', expireAccessTokens_);
  batchRun_('notifyReviewSla', notifyReviewSla_);
  batchRun_('closeStaleSubmissionFolders', closeStaleSubmissionFolders_);   // 未確定の投入フォルダを共有解除
  batchRun_('notifyCloudSignSendStale', notifyCloudSignSendStale_);   // 送信停滞の検知（§10.4）
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

/**
 * workflow一括初期設定（workflowのGASエディタから1回実行）。
 * ENVIRONMENT既定値・必須プロパティ検査・時間主導トリガー作成をまとめて行う。
 */
function setup_workflowAll(){
  const sp = PropertiesService.getScriptProperties();
  const report = { steps: [], missing: [], warnings: [] };
  if(!sp.getProperty('ENVIRONMENT')){ sp.setProperty('ENVIRONMENT','development'); report.steps.push('ENVIRONMENT=development を設定'); }
  ['SS_MASTER','SS_OPS','DRIVE_ROOT'].forEach(function(k){ if(!sp.getProperty(k)) report.missing.push(k); });
  ['HANDOFF_SECRET','CLOUDSIGN_WEBHOOK_KEY','FORMRUN_WEBHOOK_SECRET','CLOUDSIGN_CLIENT_ID','GCP_PROJECT'].forEach(function(k){
    if(!sp.getProperty(k)) report.warnings.push(k + '（本番までに設定）'); });
  if(report.missing.length){
    Logger.log('必須プロパティが未設定です: ' + report.missing.join(', ') + '（adminの setup_all のログから転記してください）');
    return report;
  }
  const trg = setup_triggers();
  report.steps.push('トリガー: 作成=' + JSON.stringify(trg.created) + ' 既存=' + JSON.stringify(trg.skipped));
  Logger.log('===== setup_workflowAll 完了 =====');
  report.steps.forEach(function(s){ Logger.log('・' + s); });
  if(report.warnings.length) Logger.log('未設定（本番までに）: ' + report.warnings.join(', '));
  return report;
}
