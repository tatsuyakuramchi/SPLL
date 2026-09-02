/** SPLL 37_ai ― Vertex AI Gemini 一次審査（複数原作対応） */


/**
 * 版(Submission_Versions)単位でAI審査ジョブを起票。
 * B経路固定：審査対象は提出済みの版。application 経由の起票は行わない。
 */
function enqueueAiReview_(submissionId, versionId){
  const aiId = newId_('AIR');
  appendRow_(ssOps_(),'AI_Review_Jobs',{ ai_review_id:aiId, submission_id:submissionId||'', version_id:versionId||'',
    model:cfg_('GEMINI_MODEL'), prompt_version:aiPromptVersion_(), status:'QUEUED', retry_count:0 });
  logEvent_('ai_review', aiId, 'system', null, {status:'QUEUED', version_id:versionId||''});
  // 即時実行を試行（失敗時はQUEUEDのまま batch_runAiReviews_ が再試行）
  try{ runAiReview_(aiId); }catch(e){ /* バッチ再試行に委ねる */ }
  return aiId;
}
/** Vertex AI Gemini 一次審査（response schema 指定・構造化出力） */
function geminiReview_(fileBlob, rules){
  const region=cfg_('GCP_REGION'), project=cfg_('GCP_PROJECT'), model=cfg_('GEMINI_MODEL');
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:generateContent`;
  const payload = {
    contents:[{ role:'user', parts:[
      { text: buildReviewPrompt_(rules) },
      { inlineData:{ mimeType:fileBlob.getContentType(), data:Utilities.base64Encode(fileBlob.getBytes()) } }
    ]}],
    generationConfig:{ responseMimeType:'application/json', responseSchema: REVIEW_SCHEMA }
  };
  const res = UrlFetchApp.fetch(url, { method:'post', contentType:'application/json',
    headers:{ Authorization:'Bearer '+ScriptApp.getOAuthToken() },
    payload: JSON.stringify(payload), muteHttpExceptions:true });
  const code = res.getResponseCode();
  if(code < 200 || code >= 300) throw new Error('Gemini HTTP '+code+': '+res.getContentText());
  return JSON.parse(res.getContentText());
}
const REVIEW_SCHEMA = { type:'object', properties:{
  overall_result:{ type:'string', enum:['PASS_CANDIDATE','REVIEW_REQUIRED','HIGH_RISK','UNREADABLE'] },
  risk_score:{ type:'integer' }, human_review_required:{ type:'boolean' },
  findings:{ type:'array', items:{ type:'object', properties:{
    work_id:{type:'string'}, rule_id:{type:'string'}, severity:{type:'string'}, result:{type:'string'},
    page:{type:'integer'}, evidence:{type:'string'}, recommended_action:{type:'string'}, confidence:{type:'number'}
  }}}
}};
/**
 * 一次審査プロンプトの既定文。管理コンソール「設定→AI審査」で差し替えできる。
 * {{rules}} に原作別ルール・契約条件のJSONが差し込まれる（省略しても末尾へ自動付与する）。
 * 出力形式は responseSchema（REVIEW_SCHEMA）で拘束しているため、文面の変更で壊れない。
 */
const AI_REVIEW_PROMPT_DEFAULT = [
  'あなたは審査者ではなく一次スクリーナーです。根拠箇所を示し、不明は不明としてください。',
  '本提出作品は、複数の原作を同時に利用している可能性があります。',
  '各指摘(finding)には、どの原作(work_id)のルールに関するものかを必ず付与してください。',
  '次の原作別ルールと契約条件に対する適合候補・要確認・高リスク候補を抽出してください。',
  '{{rules}}'
].join('\n');

/** 現在有効なプロンプト（Config優先・未設定は既定文） */
function aiReviewPrompt_(){
  const v = String(getConfig_('AI_REVIEW_PROMPT','') || '').trim();
  return v || AI_REVIEW_PROMPT_DEFAULT;
}
/**
 * ジョブに記録する版。ラベル（Config）＋プロンプト本文のハッシュ先頭8桁。
 * 文面を変えると版が変わるため、過去の審査結果がどの文面で出たかを後から追える。
 */
function aiPromptVersion_(){
  const label = String(getConfig_('AI_PROMPT_VERSION','') || AI_PROMPT_VERSION);
  return label + ':' + String(hash_(aiReviewPrompt_())).slice(0,8);
}
function buildReviewPrompt_(rules){
  const tpl = aiReviewPrompt_();
  const rulesJson = JSON.stringify(rules);
  // {{rules}} を消してしまってもルールは必ず渡す（審査条件の欠落を防ぐ）
  return tpl.indexOf('{{rules}}') >= 0 ? tpl.split('{{rules}}').join(rulesJson) : (tpl + '\n' + rulesJson);
}

// ---- 4.1 AI審査ジョブ実行（runAiReview_） ----
const AI_PROMPT_VERSION = 'v1';
const AI_MAX_RETRY = 3;

/** QUEUEDのAI審査ジョブをまとめて実行（時間主導トリガー想定） */
function batch_runAiReviews_(){
  const jobs = readRows_(ssOps_(),'AI_Review_Jobs')
    .filter(j => j.status==='QUEUED' && (parseInt(j.retry_count||'0',10)||0) < AI_MAX_RETRY);
  let completed = 0;
  jobs.forEach(j => { try{ runAiReview_(j.ai_review_id); completed++; }catch(e){ /* 失敗はジョブ内で記録 */ } });
  return { processed: jobs.length, completed: completed };
}

/** 1件のAI審査を実行：ファイル取得→Gemini（複数原作ルール）→Findings記録→人手審査へ */
function runAiReview_(aiReviewId){
  // ジョブ排他（V2-016）：ロック内で取得・SCANNING遷移し、二重実行を防止
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  let job;
  try{
    job = readRows_(ssOps_(),'AI_Review_Jobs').find(j => j.ai_review_id===aiReviewId);
    if(!job) throw new Error('AI review job not found: '+aiReviewId);
    if(job.status==='COMPLETED') return 'COMPLETED';          // 冪等
    if(job.status==='SCANNING' && job.started_at && (new Date() - new Date(job.started_at)) < 10*60*1000)
      return 'RUNNING';                                       // 他実行が処理中（10分以内）
    updateRow_(ssOps_(),'AI_Review_Jobs','ai_review_id',aiReviewId,{status:'SCANNING', started_at:new Date().toISOString()});
  }finally{ lock.releaseLock(); }
  markVersionStatus_(job.version_id, 'AI_SCREENING');
  try{
    const blob = resolveSubmissionBlob_(job);
    if(!blob) throw new Error('提出ファイルが見つかりません');
    const works = resolveJobWorks_(job);                            // 契約対象原作（複数）
    const rules = buildRulesMulti_(works);
    const raw = geminiReview_(blob, rules);                         // 個人情報は送らず作品＋条件のみ
    // 生レスポンスを改変せずDriveへ保存（§9.3・審査証跡）。失敗してもジョブは継続。
    let responseFileId = '';
    try{ responseFileId = saveAiRawResponse_(job, aiReviewId, raw); }
    catch(e){ logError_('PROCESSING_ERROR','saveAiRawResponse', e, { ai_review_id:aiReviewId }); }
    const parsed = parseGeminiResult_(raw);
    writeFindings_(aiReviewId, parsed.findings);
    const overall = parsed.overall_result
      || (parsed.findings.length ? worstResult_(parsed.findings.map(f => ({severity:f.severity, result:f.result}))) : 'REVIEW_REQUIRED');
    updateRow_(ssOps_(),'AI_Review_Jobs','ai_review_id',aiReviewId,{ status:'COMPLETED',
      overall_result:overall, risk_score:(parsed.risk_score!=null?parsed.risk_score:''),
      human_review_required:'true', response_file_id:responseFileId, completed_at:new Date().toISOString(), last_error:'' });
    logEvent_('ai_review', aiReviewId, 'gemini', null, {overall_result:overall, findings:parsed.findings.length});
    postReviewRouting_(job, overall);
    return overall;
  }catch(err){
    const retry  = (parseInt(job.retry_count||'0',10)||0) + 1;
    const status = retry >= AI_MAX_RETRY ? 'ERROR' : 'QUEUED';
    updateRow_(ssOps_(),'AI_Review_Jobs','ai_review_id',aiReviewId,{status:status, retry_count:retry, last_error:String(err && err.message || err).slice(0,300)});
    if(status === 'ERROR'){
      // AI利用不能でも提出を消失させない（V2-016）：版=AI_UNAVAILABLE・人手審査へ回送
      markVersionStatus_(job.version_id, 'AI_UNAVAILABLE');
      if(job.submission_id){
        updateRow_(ssOps_(),'Submissions','submission_id',job.submission_id,{ status:'HUMAN_REVIEW_PENDING' });
        const sub = readRows_(ssOps_(),'Submissions').find(function(x){ return x.submission_id === job.submission_id; }) || {};
        enqueueNotification_(sub.contract_id||'', 'REVIEW_SLA_OVERDUE', 'AIERR:'+job.version_id,
          { submission_id:job.submission_id, note:'AI審査が失敗しました。人手審査で対応してください（MANUAL_REVIEW_REQUIRED）' });
      }
    }
    logEvent_('ai_review', aiReviewId, 'system', null, {error:String(err), retry_count:retry, status:status});
    throw err;
  }
}

/**
 * ジョブの提出ファイルをBlobで取得。作品ファイルのみで個人情報は含めない。
 * 大容量提出（DRIVE_FOLDER）では動画・立体データ等が混在するため、先頭ではなく
 * AIが読める形式・サイズ（PDF/PNG/JPEG かつ UPLOAD_MAX_BYTES 以内）の最小ファイルを選ぶ。
 * 巨大ファイルへ getBlob() するとメモリ超過で審査ごと落ちるため、必ず候補を絞ってから取得する。
 */
function resolveSubmissionBlob_(job){
  const vid = job.version_id;
  if(!vid) return null;
  const files = readRows_(ssOps_(),'Submission_Files').filter(function(x){ return String(x.version_id) === String(vid); });
  if(!files.length) return null;
  const screenable = files.filter(function(f){
    const okType = /^(application\/pdf|image\/png|image\/jpeg)$/.test(String(f.mime_type||'')) ||
      /\.(pdf|png|jpe?g)$/i.test(String(f.original_filename||''));
    const size = num_(f.size);
    return f.drive_file_id && okType && (!size || size <= UPLOAD_MAX_BYTES);
  }).sort(function(a,b){ return num_(a.size) - num_(b.size); });
  const f = screenable[0];
  if(!f) return null;                                   // 読める形式が無ければAI審査対象外（人手審査へ）
  return DriveApp.getFileById(f.drive_file_id).getBlob();
}

/** ジョブ対象の契約対象原作（Works_Master行の配列）を解決：提出→契約→Contract_Works */
function resolveJobWorks_(job){
  const sub = readRows_(ssOps_(),'Submissions').find(x => x.submission_id===job.submission_id);
  const contractId = sub && sub.contract_id;
  if(!contractId) return [];
  const workIds = readRows_(ssOps_(),'Contract_Works')
    .filter(x => x.contract_id===contractId).map(x => x.work_id);
  const byId = {}; readRows_(ssMaster_(),'Works_Master').forEach(w => { byId[w.work_id] = w; });
  return workIds.map(id => byId[id] || { work_id:id });
}

/** 複数原作の作品別ルール＋契約条件を構造化（個人情報は含めない） */
function buildRulesMulti_(works){
  const allRules = readRows_(ssMaster_(),'Review_Rules');
  return {
    works: (works||[]).map(function(work){
      const rules = allRules
        .filter(r => r.work_id===work.work_id && ruleActive_(r))
        .map(r => ({ rule_id:r.rule_id, category:r.category, text:r.rule_text, severity:r.severity }));
      return {
        work_id: work.work_id || '',
        work_name: work.work_name || '',
        allowed_elements: csv_(work.ok_elements),
        prohibited_elements: csv_(work.no_elements),
        required_credit: work.credit_text || '',
        allowed_media: csv_(work.media),
        rules: rules
      };
    })
  };
}

/** Vertex生レスポンスから構造化結果(JSON)を取り出す */
function parseGeminiResult_(raw){
  let obj = raw;
  try{
    if(raw && raw.candidates && raw.candidates[0]){
      const parts = raw.candidates[0].content && raw.candidates[0].content.parts;
      const text  = parts && parts[0] && parts[0].text;
      if(text) obj = JSON.parse(text);
    }
  }catch(e){ /* 解析失敗時は空扱い → REVIEW_REQUIRED に倒す */ }
  if(!obj || typeof obj !== 'object') obj = {};
  if(!Array.isArray(obj.findings)) obj.findings = [];
  return obj;
}

/** Findings を AI_Findings へ記録（原作ごとに work_id を保持） */
function writeFindings_(aiReviewId, findings){
  // AI出力の全文字列を無害化して保存（V2-016：数式インジェクション対策）＋recommended_action保存
  (findings||[]).forEach(f => appendRow_(ssOps_(),'AI_Findings',{
    finding_id: newId_('FND'), ai_review_id: aiReviewId, work_id: sanitizeCell_(String(f.work_id||'')),
    rule_id: sanitizeCell_(String(f.rule_id||'')), severity: sanitizeCell_(String(f.severity||'')),
    result: sanitizeCell_(String(f.result||'')), page: f.page||'',
    evidence: sanitizeCell_(String(f.evidence||'').slice(0,1000)),
    recommended_action: sanitizeCell_(String(f.recommended_action||'').slice(0,500)),
    confidence: f.confidence||''
  }));
}

/**
 * AI審査結果のルーティング（B経路固定）。AIは一次スクリーナーであり、
 * 判定だけで自動不採用にはしない。必ず人手審査を必須とする。
 *   PASS_CANDIDATE → 版=AI_SCREENED・人手簡易確認
 *   REVIEW_REQUIRED → 版=AI_SCREENED・通常審査
 *   HIGH_RISK/UNREADABLE → 版=AI_SCREENED・法務上申＋コンプラ・アラート
 */
function postReviewRouting_(job, overall){
  const high = (overall==='HIGH_RISK' || overall==='UNREADABLE');
  markVersionStatus_(job.version_id, 'AI_SCREENED');
  // 提出(Submission)を人手審査待ちへ
  if(job.submission_id) updateRow_(ssOps_(),'Submissions','submission_id',job.submission_id,{ status:'HUMAN_REVIEW_PENDING' });
  logEvent_('submission', job.submission_id||'', 'system', null, {overall_result:overall, status:'HUMAN_REVIEW_PENDING'});
  if(high) createComplianceAlert_(job.submission_id, overall);   // 既発生のパートナー配分は当然には消滅させない
}

/** コンプライアンス・アラート起票（settlement_block空＝清算は止めない） */
function createComplianceAlert_(submissionId, overall){
  const sub = readRows_(ssOps_(),'Submissions').find(s => s.submission_id===submissionId) || {};
  appendRow_(ssOps_(),'Compliance_Alerts',{ alert_id:newId_('ALR'),
    contract_id: sub.contract_id||'', submission_id: submissionId||'',
    license_id: sub.license_id || licenseIdOfContract_(sub.contract_id),
    severity:'HIGH', status:'OPEN', settlement_block:'' });
  logEvent_('compliance_alert', submissionId, 'system', null, {severity:'HIGH', overall_result:overall});
}

/** AI生レスポンスを契約フォルダ/03_AI_Reviews へJSON保存（§9.3）。file_id を返す。 */
function saveAiRawResponse_(job, aiReviewId, raw){
  const sub = readRows_(ssOps_(),'Submissions').find(function(x){ return x.submission_id === job.submission_id; });
  const c = sub ? readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === sub.contract_id; }) : null;
  if(!c) return '';
  const folder = contractSubFolder_(c, '03_AI_Reviews');
  const f = folder.createFile(Utilities.newBlob(JSON.stringify(raw), 'application/json', 'ai_' + aiReviewId + '.json'));
  return f.getId();
}
