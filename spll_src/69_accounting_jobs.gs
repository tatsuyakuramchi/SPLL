/**
 * SPLL 69_accounting_jobs ― 経理ジョブ基盤（経理設計書 SPLL-SYS-AD-001 §8.2/§8.3）
 *   ・長時間処理をカーソル分割し、1実行を時間予算内で終える
 *   ・排他（ScriptLock）・冪等・停滞RUNNINGの回復・指数バックオフ再試行
 *   ・ジョブ本体（SALES_PARSE等）は各機能ファイルが実装し、ここから呼び出す
 */

const ACC_JOB_TYPES = ['SALES_PARSE','SALES_MATCH','ALLOCATION_CALCULATE','BANK_MATCH','ACCOUNTING_EXPORT','PARTNER_EXPORT','SETTLEMENT_POST'];
const ACC_JOB_MAX_RETRY = 5;
const ACC_JOB_TIME_BUDGET_MS = 4 * 60 * 1000;      // 5分制限の前に終了（§8.2）
const ACC_JOB_STALE_MS = 15 * 60 * 1000;           // RUNNINGのまま15分で回復対象（§8.3）
const ACC_JOB_CHUNK = 500;                          // 1実行あたり500〜1,000行目安（§8.2）

/** ジョブ登録。即時に1回だけ実行を試み、残りは時間主導トリガーが継続する。 */
function enqueueAccountingJob_(jobType, targetId, detail){
  if(ACC_JOB_TYPES.indexOf(jobType) < 0) throw new Error('VALIDATION_ERROR: 不正なジョブ種別: ' + jobType);
  const jobId = Utilities.getUuid();
  appendRowsBulk_(ssAccMaster_(), 'Accounting_Jobs', [{
    job_id: jobId, job_type: jobType, target_id: targetId || '', status: 'QUEUED',
    cursor: 0, total_count: '', processed_count: 0, retry_count: 0, next_retry_at: '',
    started_at: '', finished_at: '', owner: '', last_error: '',
    detail_json: JSON.stringify(detail || {}),
  }]);
  logEvent_('accounting_job', jobId, 'system', null, { job_type: jobType, target_id: targetId || '' });
  try{ runAccountingJobs_(); }catch(e){ /* トリガー再実行に委ねる */ }
  return jobId;
}

/** ジョブ種別→実装関数。未実装フェーズはnull（実行時にERRORへ）。 */
function accJobHandler_(jobType){
  const map = {
    SALES_PARSE:          (typeof accJobSalesParse_          === 'function') ? accJobSalesParse_          : null,
    SALES_MATCH:          (typeof accJobSalesMatch_          === 'function') ? accJobSalesMatch_          : null,
    ALLOCATION_CALCULATE: (typeof accJobAllocationCalculate_ === 'function') ? accJobAllocationCalculate_ : null,
    BANK_MATCH:           (typeof accJobBankMatch_           === 'function') ? accJobBankMatch_           : null,
    ACCOUNTING_EXPORT:    (typeof accJobAccountingExport_    === 'function') ? accJobAccountingExport_    : null,
    PARTNER_EXPORT:       (typeof accJobPartnerExport_       === 'function') ? accJobPartnerExport_       : null,
    SETTLEMENT_POST:      (typeof accJobSettlementPost_      === 'function') ? accJobSettlementPost_      : null,
  };
  return map[jobType] || null;
}

/**
 * 実行対象（QUEUED／期限到来のRETRY_WAIT／停滞RUNNING）を順に処理する。
 * 時間予算を超える前にカーソルを保存して終了し、次回トリガーで継続する。
 */
function runAccountingJobs_(){
  const lock = LockService.getScriptLock();
  try{ lock.waitLock(5000); }catch(e){ return { processed: 0, skipped: 'locked' }; }
  const startedAt = Date.now();
  let processedJobs = 0, continued = 0;
  try{
    const master = ssAccMaster_();
    const now = new Date();
    const jobs = readTableBulk_(master, 'Accounting_Jobs').filter(function(j){
      if(j.status === 'QUEUED') return true;
      if(j.status === 'RETRY_WAIT') return !j.next_retry_at || new Date(j.next_retry_at) <= now;
      if(j.status === 'RUNNING')    return j.started_at && (now - new Date(j.started_at)) > ACC_JOB_STALE_MS;   // 停滞回復
      return false;
    });
    for(let i = 0; i < jobs.length; i++){
      if(Date.now() - startedAt > ACC_JOB_TIME_BUDGET_MS){ continued++; break; }
      const st = runAccountingJobStep_(jobs[i], startedAt);
      processedJobs++;
      if(st === 'CONTINUED') continued++;
    }
  } finally { lock.releaseLock(); }
  return { processed: processedJobs, continued: continued };
}

/** 1ジョブを1ステップ（時間予算内）実行する。戻り値: DONE/CONTINUED/RETRY_WAIT/ERROR */
function runAccountingJobStep_(job, budgetStartMs){
  const master = ssAccMaster_();
  const handler = accJobHandler_(job.job_type);
  const nowIso = new Date().toISOString();
  upsertRowsBulk_(master, 'Accounting_Jobs', 'job_id', [{
    job_id: job.job_id, status: 'RUNNING', started_at: nowIso, owner: 'trigger' }]);
  if(!handler){
    upsertRowsBulk_(master, 'Accounting_Jobs', 'job_id', [{
      job_id: job.job_id, status: 'ERROR', finished_at: new Date().toISOString(),
      last_error: 'ハンドラ未実装: ' + job.job_type }]);
    logError_('PROCESSING_ERROR', 'accountingJob', new Error('handler missing: ' + job.job_type), { job_id: job.job_id });
    return 'ERROR';
  }
  try{
    // ハンドラ規約：{ done:boolean, cursor:number, processed:number, total?:number }
    const res = handler({
      job_id: job.job_id, job_type: job.job_type, target_id: job.target_id,
      cursor: num_(job.cursor) || 0,
      detail: (function(){ try{ return JSON.parse(job.detail_json || '{}'); }catch(e){ return {}; } })(),
      deadlineMs: (budgetStartMs || Date.now()) + ACC_JOB_TIME_BUDGET_MS,
      chunk: ACC_JOB_CHUNK,
    }) || { done: true, cursor: 0, processed: 0 };
    const processed = (num_(job.processed_count) || 0) + (num_(res.processed) || 0);
    if(res.done){
      upsertRowsBulk_(master, 'Accounting_Jobs', 'job_id', [{
        job_id: job.job_id, status: 'DONE', cursor: res.cursor || 0, processed_count: processed,
        total_count: (res.total !== undefined ? res.total : job.total_count), finished_at: new Date().toISOString(), last_error: '' }]);
      logEvent_('accounting_job', job.job_id, 'system', { status: 'RUNNING' }, { status: 'DONE', processed: processed });
      return 'DONE';
    }
    // 時間切れ等の途中終了：カーソルを保存してQUEUEDへ戻す（次回継続・§18.2-15）
    upsertRowsBulk_(master, 'Accounting_Jobs', 'job_id', [{
      job_id: job.job_id, status: 'QUEUED', cursor: res.cursor || 0, processed_count: processed,
      total_count: (res.total !== undefined ? res.total : job.total_count), started_at: '' }]);
    return 'CONTINUED';
  }catch(err){
    const retry = (num_(job.retry_count) || 0) + 1;
    const status = retry >= ACC_JOB_MAX_RETRY ? 'ERROR' : 'RETRY_WAIT';
    const next = new Date(Date.now() + Math.pow(2, retry) * 60 * 1000);   // 2^n分バックオフ
    upsertRowsBulk_(master, 'Accounting_Jobs', 'job_id', [{
      job_id: job.job_id, status: status, retry_count: retry,
      next_retry_at: status === 'RETRY_WAIT' ? next.toISOString() : '',
      finished_at: status === 'ERROR' ? new Date().toISOString() : '',
      last_error: String(err && err.message || err).slice(0, 300) }]);
    logError_('PROCESSING_ERROR', 'accountingJob:' + job.job_type, err, { job_id: job.job_id, retry: retry, status: status });
    return status;
  }
}

/** 時間主導トリガー本体（Accounting GAS④で1〜5分毎）。 */
function trigger_accountingJobs(){
  const out = runAccountingJobs_();
  if(out.processed) logEvent_('accounting_job', 'trigger', 'system', null, out);
  return out;
}
/** トリガーの冪等セットアップ（Accounting GAS④のエディタから1回実行）。 */
function setup_accountingTriggers(){
  const existing = {};
  ScriptApp.getProjectTriggers().forEach(function(t){ existing[t.getHandlerFunction()] = true; });
  const made = [];
  if(!existing.trigger_accountingJobs){
    ScriptApp.newTrigger('trigger_accountingJobs').timeBased().everyMinutes(5).create();
    made.push('trigger_accountingJobs');
  }
  logEvent_('accounting_job', 'setup_accountingTriggers', 'setup', null, { created: made });
  return { created: made, skipped: Object.keys(existing) };
}

/** ジョブ一覧（管理画面用）。 */
function admin_accountingListJobs(filters){ requireRole_([]);
  const f = filters || {};
  return readTableBulk_(ssAccMaster_(), 'Accounting_Jobs')
    .filter(function(j){ return !f.status || j.status === f.status; })
    .slice(-100)
    .map(function(j){ return { job_id: j.job_id, job_type: j.job_type, target_id: j.target_id, status: j.status,
      processed_count: j.processed_count, total_count: j.total_count, retry_count: j.retry_count,
      last_error: j.last_error, started_at: j.started_at, finished_at: j.finished_at }; })
    .reverse();
}
