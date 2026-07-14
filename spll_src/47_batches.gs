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
function trigger_every5min(){                     // Webhook再処理＋AI審査キュー
  batchRun_('processWebhookReceipts', processWebhookReceipts_);
  batchRun_('runAiReviews', batch_runAiReviews_);
}
function trigger_daily(){                         // 期限処理・みなし確認・データ削除
  batchRun_('expireAccessTokens', expireAccessTokens_);
  batchRun_('closeObjectionPeriods', function(){ confirmDeemed_(); return {}; });
  batchRun_('purgeExpiredData', purgeExpiredData_);
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
