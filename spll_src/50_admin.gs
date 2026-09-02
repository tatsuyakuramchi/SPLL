/** SPLL 50_admin ― GAS③ 管理コンソール：全 admin_ 関数（requireRole_ によるRBAC必須） */


/**
 * 管理コンソールの配信（修正設計書 SEC-01/§4）。
 * production：ログインユーザーを識別でき、かつ管理者登録済みの場合のみ配信（匿名は拒否）。
 * development：従来どおり（ADMIN_ENFORCE=true なら許可リスト制御）。
 */
function serveAdmin_(e){
  var email = ''; try{ email = Session.getActiveUser().getEmail() || ''; }catch(_){}
  if(isProd_()){
    if(!email) return htmlPage_('SPLL 管理コンソール',
      '<h2>アクセスできません</h2><p>管理コンソールの利用にはGoogleアカウントでのログインが必要です（匿名アクセス不可）。</p>');
    if(!roleOf_(email)) return htmlPage_('SPLL 管理コンソール',
      '<h2>アクセス権限がありません</h2><p>このアカウント（' + esc_(email) + '）は管理者として登録されていません。</p>');
  } else if(prop_('ADMIN_ENFORCE') === 'true' && email && !roleOf_(email) && !isAdminEmail_(email)){
    return htmlPage_('SPLL 管理コンソール',
      '<h2>アクセス権限がありません</h2><p>このアカウント（' + esc_(email) + '）は管理者として登録されていません。</p>' +
      '<p style="font-size:12px;color:#6A6577">管理者アカウントでログインし直すか、事務局にお問い合わせください。</p>');
  }
  return HtmlService.createHtmlOutputFromFile('admin').setTitle('SPLL 管理コンソール');
}
/** 管理者一覧（SYSTEM_ADMIN） */
function admin_listAdminUsers(){
  requireRole_(['SYSTEM_ADMIN']);
  return readRows_(ssOps_(),'Admin_Users').map(function(u){
    return { email:u.email, role:u.role, status:u.status, added_by:u.added_by, added_at:String(u.added_at||'') }; });
}
/** 管理者の追加・更新（SYSTEM_ADMIN）。email一致でupsert。 */
function admin_saveAdminUser(email, role, status){
  const actor = requireRole_(['SYSTEM_ADMIN']);
  email = String(email||'').toLowerCase();
  if(!email) throw new Error('メールアドレスは必須です');
  if(ADMIN_ROLES.indexOf(role) < 0) throw new Error('不正なロール: ' + role);
  const patch = { role:role, status:(status||'ACTIVE'), added_by:actor.email, added_at:new Date().toISOString() };
  if(!updateRow_(ssOps_(),'Admin_Users','email',email,patch)){
    appendRow_(ssOps_(),'Admin_Users', Object.assign({ admin_user_id:Utilities.getUuid(), email:email }, patch));
  }
  logEvent_('admin_user', email, actor.email, null, { role:role, status:status||'ACTIVE' });
  return true;
}

/** 管理者アクセス設定の取得（許可リスト・強制ON/OFF・現在の閲覧者） */
function admin_getAdminAccess(){ requireRole_(['SYSTEM_ADMIN']);
  var viewer = ''; try{ viewer = Session.getActiveUser().getEmail() || ''; }catch(e){}
  return { emails: prop_('ADMIN_EMAILS') || '', enforce: prop_('ADMIN_ENFORCE') === 'true', viewer: viewer };
}
/** 管理者アクセス設定の保存（emails：カンマ/改行区切り、enforce：真偽） */
function admin_saveAdminAccess(c){ requireRole_(['SYSTEM_ADMIN']);
  var sp = PropertiesService.getScriptProperties();
  if(c.emails  !== undefined) sp.setProperty('ADMIN_EMAILS', String(c.emails).replace(/\n/g, ','));
  if(c.enforce !== undefined) sp.setProperty('ADMIN_ENFORCE', c.enforce ? 'true' : 'false');
  logEvent_('config', 'ADMIN_ACCESS', actor_(), null, { saved: true, enforce: !!c.enforce });
  return true;
}

/** 接続テスト（サンドボックス資格情報の確認用）。トークン全体は返さない。 */
function admin_cloudSignTest(){ requireRole_(['SYSTEM_ADMIN']);
  try{
    const t = cloudSignAccessToken_();
    return { ok:true, sandbox:cs_isSandbox_(), base:cs_baseUrl_(), token_prefix:String(t).slice(0,6) + '…' };
  }catch(e){
    return { ok:false, sandbox:cs_isSandbox_(), base:cs_baseUrl_(), error:String(e.message || e) };
  }
}

/** ダッシュボード：KPI＋直近の要対応（作品名を結合） */
/**
 * ダッシュボード（RP-002 §11.1）。案件の現在地は License_Cases.case_status を正本とする。
 * Applications の件数や Contracts 中心の集計は使わない（旧テーブルは技術・証跡用）。
 * 要対応一覧は License_Cases（人の判断が要る現在地）・Notification_Queue・System_Errors・
 * Certificate_Change_Requests を統合し、SPLL番号で詳細へ飛べる形で返す。
 */
function admin_dashboard(){ requireRole_([]);
  const cases = readRows_(ssOps_(),'License_Cases');
  const jobs  = readRows_(ssOps_(),'AI_Review_Jobs');
  const findings = readRows_(ssOps_(),'AI_Findings');
  const byStatus = {};
  cases.forEach(function(k){ const st = normalizeCaseStatus_(k.case_status); byStatus[st] = (byStatus[st] || 0) + 1; });
  const kpis = {
    manual_review:       byStatus.MANUAL_REVIEW || 0,
    signing:             (byStatus.SIGNING || 0) + (byStatus.CONTRACT_PENDING || 0),
    hold:                byStatus.HOLD || 0,
    awaiting_submission: byStatus.AWAITING_SUBMISSION || 0,
    reviewing:           byStatus.REVIEWING || 0,
    correction_required: byStatus.CORRECTION_REQUIRED || 0,
    certified:           byStatus.CERTIFIED || 0,
    suspended:           byStatus.SUSPENDED || 0,
    // 審査タブの指標（AI一次審査の滞留）
    unscreened: jobs.filter(function(j){ return j.status==='QUEUED' || j.status==='SCANNING'; }).length,
    highRisk:   findings.filter(isHighRisk_).length
  };

  const worksBy = licenseWorksMap_();
  const nameOf = function(lid){ const k = cases.find(function(x){ return x.license_id === lid; }); return k ? (k.party_display_name || '') : ''; };
  const actions = [];
  // 1) 人の判断が要る現在地
  const NEEDS = { MANUAL_REVIEW:'個別確認', HOLD:'条件不一致の確認', CORRECTION_REQUIRED:'是正の確認', REVIEWING:'審査' };
  cases.forEach(function(k){
    const st = normalizeCaseStatus_(k.case_status);
    if(!NEEDS[st]) return;
    actions.push({ kind:'案件', license_id:k.license_id, target:k.license_id, work:(worksBy[k.license_id]||[]).join('、'),
      party:k.party_display_name||'', status:st, label:NEEDS[st], cls:(st==='HOLD'||st==='MANUAL_REVIEW')?'fail':'review',
      at:String(k.updated_at||k.created_at||'') });
  });
  // 2) 人手対応が残っている通知
  readRows_(ssOps_(),'Notification_Queue')
    .filter(function(n){ return n.status === 'MANUAL_REQUIRED' || n.status === 'SEND_FAILED'; })
    .forEach(function(n){ actions.push({ kind:'通知', license_id:n.license_id||licenseIdOfContract_(n.contract_id), target:n.license_id||n.contract_id||'',
      work:(worksBy[n.license_id]||[]).join('、'), party:nameOf(n.license_id), status:n.type, label:n.status==='SEND_FAILED'?'送信失敗':'人手対応',
      cls:n.status==='SEND_FAILED'?'fail':'review', at:String(n.created_at||'') }); });
  // 3) 承認待ちの認証状態変更
  readRows_(ssOps_(),'Certificate_Change_Requests')
    .filter(function(r){ return r.status === 'REQUESTED'; })
    .forEach(function(r){ const lid = r.license_id || licenseIdOfContract_(r.contract_id);
      actions.push({ kind:'認証', license_id:lid, target:lid||r.contract_id, work:(worksBy[lid]||[]).join('、'), party:nameOf(lid),
        status:r.requested_status, label:'承認待ち', cls:'review', at:String(r.requested_at||'') }); });
  // 4) 未解決のシステムエラー（業務影響のあるもの）
  readRows_(ssOps_(),'System_Errors')
    .filter(function(e){ return e.status === 'OPEN' && !/RATE|rate/.test(String(e.source)); })
    .slice(-20)
    .forEach(function(e){ actions.push({ kind:'エラー', license_id:'', target:e.source||'', work:'', party:'',
      status:e.error_code, label:String(e.message||'').slice(0,60), cls:'fail', at:String(e.occurred_at||'') }); });
  actions.sort(function(a,b){ return String(b.at).localeCompare(String(a.at)); });
  return { kpis: kpis, actions: actions.slice(0, 30), alerts: [] };
}
/** SPLL番号 → 対象原作名（License_Works のスナップショット。active=false は除く） */
function licenseWorksMap_(){
  const m = {};
  readRows_(ssOps_(),'License_Works').forEach(function(w){
    if(String(w.active) === 'false') return;
    (m[w.license_id] = m[w.license_id] || []).push(w.work_name_snapshot || w.work_id);
  });
  return m;
}

/** 審査キュー：提出版(version)単位に総合結果・主指摘・対象原作(複数)を結合（B経路固定） */
function admin_reviewQueue(){ requireRole_([]);
  const jobs      = readRows_(ssOps_(),'AI_Review_Jobs');
  const findings  = readRows_(ssOps_(),'AI_Findings');
  const subs      = readRows_(ssOps_(),'Submissions');
  const nameMap   = worksNameMap_();
  const ctrWorks  = contractWorksMap_();
  const subById   = {}; subs.forEach(s => { subById[s.submission_id] = s; });

  return jobs.map(j => {
    const fs = findings.filter(f => f.ai_review_id===j.ai_review_id);
    const top = fs.slice().sort((a,b)=>sevRank_(b)-sevRank_(a))[0];
    const sub = subById[j.submission_id] || {};
    const topWork = top && top.work_id ? (nameMap[top.work_id] || top.work_id) : '';
    return {
      id: j.submission_id || j.ai_review_id,
      ai_review_id: j.ai_review_id,
      submission_id: j.submission_id || '',
      version_id: j.version_id || '',
      title: sub.title || '',
      work: contractWorkLabel_(ctrWorks, sub.contract_id),
      job_status: j.status,
      result: j.status==='COMPLETED' ? worstResult_(fs) : (j.status||'QUEUED'),
      finding: top ? (topWork ? '['+topWork+'] ' : '') + String(top.evidence||top.result||'') : ''
    };
  });
}

/** 人手判断の記録（CLEARED / CORRECTION_REQUIRED / ESCALATED）。版・提出状態も更新。 */
function admin_setHumanReview(submissionId, result, comment, reviewer, versionId){
  const actor = requireRole_(['OPERATIONS','LEGAL_ADMIN']);
  // 修正設計書 §9.4：列挙値・最新版・コメント必須をサーバー側で検証
  const ALLOWED = ['CLEARED','CORRECTION_REQUIRED','ESCALATED'];
  if(ALLOWED.indexOf(result) < 0) throw new Error('VALIDATION_ERROR: 不正な審査結果です: ' + result);
  if((result === 'CORRECTION_REQUIRED' || result === 'ESCALATED') && !String(comment||'').trim())
    throw new Error('VALIDATION_ERROR: 是正要求・上申にはコメント（理由）が必須です');
  const sub = readRows_(ssOps_(),'Submissions').find(function(s){ return s.submission_id === submissionId; });
  if(!sub) throw new Error('DATA_NOT_FOUND: 提出が見つかりません: ' + submissionId);
  const latest = latestVersionId_(submissionId);
  if(versionId && String(versionId) !== String(latest))
    throw new Error('DATA_CONFLICT: 指定された版は最新版ではありません（最新: ' + latest + '）。新しい版が提出されています。');
  const targetVersion = versionId || latest;
  // 審査者はクライアント入力ではなく認証済み操作者から取得（§9.4）
  appendRow_(ssOps_(),'Human_Reviews',{ human_review_id:newId_('HRV'), submission_id:submissionId,
    version_id:targetVersion, reviewer:actor.email, result:result,
    comments:sanitizeCell_(String(comment||'')), reviewed_at:new Date().toISOString() });
  updateRow_(ssOps_(),'Submissions','submission_id',submissionId,{ status:result });
  markVersionStatus_(targetVersion, result);
  // 通知キュー（§10）：是正要求／審査結果をクリエーターへ伝えるべきことを記録（メール非保持のため人手対応）
  const ntype = result === 'CORRECTION_REQUIRED' ? 'CORRECTION_REQUEST' : 'REVIEW_RESULT';
  enqueueNotification_(sub.contract_id, ntype, targetVersion, { submission_id:submissionId, result:result, comment:String(comment||'').slice(0,300) });
  logEvent_('human_review', submissionId, actor.email, {status:sub.status}, {result:result, version_id:targetVersion});
  // 台帳の現在地（12_license_state）。判断の種類でイベントを分ける
  const licenseId = sub.license_id || licenseIdOfContract_(sub.contract_id);
  let certification = null;
  if(licenseId){
    const ev = result === 'CLEARED' ? 'HUMAN_REVIEW_CLEARED' : (result === 'CORRECTION_REQUIRED' ? 'CORRECTION_REQUIRED' : 'REVIEW_ESCALATED');
    transitionLicenseCase_(licenseId, ev, { actor: actor.email, reason: submissionId + ' ' + targetVersion });
    // 審査を通った時点で認証を発行する（RP-002 §3）。発行できない理由があれば結果に載せて返す
    if(result === 'CLEARED') certification = completeCertification_(licenseId, submissionId, actor.email);
  }
  return { ok:true, result:result, certification: certification };
}

/**
 * 契約一覧：締結済(Contracts)＋締結待ち(Applications)を結合、契約者名はマスク、対象原作は複数表示
 * @deprecated RP-002 日常UIからは外した。ライセンス一覧（admin_listLicenseCases）と詳細を使う。移行期間の参照用に残す。
 */
function admin_listContracts(){ requireRole_([]);
  const contracts = readRows_(ssOps_(),'Contracts');
  const apps      = readRows_(ssOps_(),'Applications');
  const ctrWorks  = contractWorksMap_();
  const appWorks  = {};   // application_id → 原作名リスト（締結前）
  const nameMap   = worksNameMap_();
  readRows_(ssOps_(),'Application_Works').forEach(function(x){
    (appWorks[x.application_id] = appWorks[x.application_id] || []).push(nameMap[x.work_id] || x.work_id);
  });
  const certs = readRows_(ssOps_(),'Certificates');
  const certByContract = {}; certs.forEach(x => { certByContract[x.contract_id] = x.status; });
  const rows = contracts.map(c => ({
    contract_id:c.contract_id, application_id:c.application_id, application_ref:c.application_ref||'',
    work:contractWorkLabel_(ctrWorks, c.contract_id),
    applicant:'＊＊＊＊（個人）', status:c.status||'', signed_at:String(c.signed_at||''),
    cert_status: certByContract[c.contract_id] || 'NONE'
  }));
  const contracted = {}; contracts.forEach(c => { if(c.application_id) contracted[c.application_id] = true; });
  apps.filter(a => a.status && a.status!=='SIGNED' && !contracted[a.application_id]).forEach(a => rows.push({
    contract_id:'—', application_id:a.application_id, application_ref:a.application_ref||'',
    work:(appWorks[a.application_id]||[]).join('、'),
    applicant:'＊＊＊＊（個人）', status:'締結待ち（'+(a.status||'')+'）', signed_at:'', cert_status:'NONE'
  }));
  return rows;
}

/**
 * B経路：締結済契約の作品提出リンクを発行して返す（当社からメール送信はしない）。
 * 旧トークンを失効し、Access_Tokens（SUBMISSION用途）を新規発行して返す。
 */
/** 提出リンクの発行。SPLL番号（推奨）または契約IDを受ける。締結済の案件だけ。 */
function admin_sendUploadLink(idOrLicense){ requireRole_(['OPERATIONS']);
  const ref = resolveLicenseRef_(idOrLicense);
  if(!ref.licenseId && !ref.contractId) throw new Error('DATA_NOT_FOUND: 案件が見つかりません: ' + idOrLicense);
  if(ref.licenseId){
    const kase = readRows_(ssOps_(),'License_Cases').find(function(k){ return k.license_id === ref.licenseId; });
    if(!kase) throw new Error('DATA_NOT_FOUND: ライセンスがありません: ' + ref.licenseId);
    if(String(kase.contract_status) !== 'SIGNED') throw new Error('DATA_CONFLICT: 締結済みの案件のみ提出リンクを発行できます（現在: ' + kase.contract_status + '）');
  } else if(!readRows_(ssOps_(),'Contracts').some(function(x){ return x.contract_id === ref.contractId; })){
    throw new Error('DATA_NOT_FOUND: 契約が見つかりません: ' + idOrLicense);
  }
  const key = ref.licenseId || ref.contractId;
  revokeTokens_(key, 'SUBMISSION');            // 再発行時は旧トークンを失効（§9.1）
  const token = prepareSubmissionToken_(key);
  const url = userPageUrl_('upload','t',token);   // クリエーター向けページはGAS②（WORKFLOW_URL）で配信
  logEvent_('license_case', key, actor_(), null, {upload_link_issued:true});
  return { url:url, token:token, license_id: ref.licenseId };
}

// ---- 未紐付け締結の手動紐付け（ref突合できない場合のフォールバック） ----
/** 申込に突合できなかった締結（UNLINKED）の一覧。書類タイトルで判別できるようにする。 */
function admin_listUnlinkedContracts(){ requireRole_([]);
  return readRows_(ssOps_(),'Contracts')
    .filter(function(c){ return c.status==='SIGNED' && !c.application_id; })
    .map(function(c){ return {
      contract_id: c.contract_id, cloudsign_document_id: c.cloudsign_document_id||'',
      title: c.cloudsign_title||'', application_ref: c.application_ref||'', signed_at: String(c.signed_at||'')
    }; });
}
/** 手動紐付けの候補となる申込（未締結・未紐付け）。対象原作名つき。 */
function admin_listLinkableApplications(){ requireRole_([]);
  const linked = {}; readRows_(ssOps_(),'Contracts').forEach(function(c){ if(c.application_id) linked[c.application_id] = true; });
  const nameMap = worksNameMap_();
  const appWorks = {}; readRows_(ssOps_(),'Application_Works').forEach(function(x){
    (appWorks[x.application_id] = appWorks[x.application_id] || []).push(nameMap[x.work_id] || x.work_id); });
  return readRows_(ssOps_(),'Applications')
    .filter(function(a){ return a.status !== 'SIGNED' && !linked[a.application_id]; })
    .map(function(a){ return {
      application_id: a.application_id, application_ref: a.application_ref||'', status: a.status||'',
      works: (appWorks[a.application_id]||[]).join('、'), created_at: String(a.created_at||'')
    }; });
}
/**
 * 未紐付け締結を申込へ手動紐付け。対象原作を固定し、提出トークン・案内を発行（冪等）。認証は審査後。
 * ref突合が使えない運用（契約書タイトルにref差込不可等）の最終手段。
 */
function admin_linkContract(contractId, applicationId){ requireRole_(['OPERATIONS','LEGAL_ADMIN']);
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; });
  if(!c) throw new Error('契約が見つかりません: ' + contractId);
  if(c.application_id) throw new Error('この契約は既に申込 ' + c.application_id + ' に紐付いています');
  const app = readRows_(ssOps_(),'Applications').find(function(x){ return x.application_id === applicationId; });
  if(!app) throw new Error('申込が見つかりません: ' + applicationId);
  const dup = readRows_(ssOps_(),'Contracts').find(function(x){ return x.application_id === applicationId; });
  if(dup) throw new Error('この申込は既に契約 ' + dup.contract_id + ' に紐付いています');

  updateRow_(ssOps_(),'Contracts','contract_id',contractId,
    { application_id: applicationId, application_ref: app.application_ref || '', link_status: 'LINKED',
      license_id: app.license_id || '' });
  snapshotContractWorks_(contractId, applicationId);
  snapshotContractTerms_(contractId, app);
  updateRow_(ssOps_(),'Applications','application_id',applicationId,{ status:'SIGNED' });
  // 連絡先メール：手動紐付けでもCloudSign送付先を優先して確定させる（照会できなければフォーム入力値）
  let doc = null;
  if(c.cloudsign_document_id && prop_('CLOUDSIGN_CLIENT_ID')){
    try{ doc = cs_fetch_('GET', '/documents/' + encodeURIComponent(c.cloudsign_document_id), null, {}); }
    catch(e){ logError_('EXTERNAL_API_ERROR','linkContract:fetchDoc', e, { contract_id:contractId }); }
  }
  captureContactEmail_(contractId, doc, app);
  syncLicenseOnSigning_(contractId, app.license_id, 'SIGNED');
  finishContractLinkage_(contractId);
  // 手動確認キューの解消（V2-008）：該当書類の受信を PROCESSED に更新
  readRows_(ssOps_(),'Webhook_Receipts')
    .filter(function(r){ return r.status === 'MANUAL_REVIEW' && String(r.external_event_id) === String(c.cloudsign_document_id); })
    .forEach(function(r){ updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',r.receipt_id,
      { status:'PROCESSED', processed_at:new Date().toISOString() }); });
  logEvent_('contract', contractId, actor_(), { link_status:'UNLINKED' },
    { link_status:'LINKED', application_id:applicationId, application_ref:app.application_ref||'' });
  return true;
}

// ---- バッチ手動起動（管理コンソールから・時間主導トリガーと共用） ----
/** QUEUEDのAI審査ジョブを実行 */
function admin_runAiReviews(){ requireRole_(['OPERATIONS']); const r = batch_runAiReviews_(); logEvent_('batch','ai_reviews',actor_(),null,r); return r; }

function admin_getLegalTexts(){ requireRole_([]); return api_getLegalTexts(); }
function admin_saveLegalTexts(privacy, termsTemplate){ requireRole_(['LEGAL_ADMIN']);
  if(privacy !== undefined)        setConfig_('LEGAL_PRIVACY_TEXT', String(privacy));
  if(termsTemplate !== undefined)  setConfig_('LEGAL_TERMS_TEMPLATE', String(termsTemplate));
  logEvent_('config', 'LEGAL', actor_(), null, { saved: true });
  return true;
}

// ---- 9.2 作品マスタ（スプレッドシート設定） ----
const WORK_FIELDS = ['work_id','work_name','publisher','category','publish_status',
  'review_timing','review_policy','fee_label','media','ok_elements','no_elements',
  'credit_text','allocation_scheme_id','billing_type'];

/** 作品マスタ全件（内部列含む。管理用なのでホワイトリストしない） */
function admin_listWorksMaster(){ requireRole_([]); return readRows_(ssMaster_(), 'Works_Master'); }

/** 作品の追加・更新（work_id一致でupsert）。media/ok/no はCSV文字列で保存。 */
function admin_saveWork(work){ requireRole_(['OPERATIONS']);
  const row = {};
  WORK_FIELDS.forEach(k => { if(work[k] !== undefined) row[k] = work[k]; });
  if(!row.work_id) row.work_id = newId_('WRK');
  if(!row.publish_status) row.publish_status = 'DRAFT';
  if(!updateRow_(ssMaster_(), 'Works_Master', 'work_id', row.work_id, row)){
    appendRow_(ssMaster_(), 'Works_Master', row);
  }
  logEvent_('work', row.work_id, actor_(), null, { saved: true, publish_status: row.publish_status });
  return row.work_id;   // X投稿は保存後にクライアント側で送信許可ポップアップ→admin_postWorkToX
}

// ---- 利用料条件（別紙2）の料金表：事務局が編集 ----
const FEE_FIELDS = ['usage_category','fee_model','fee_value','fee_label','licensed_uses','payment_due','reporting_requirement','report_due','threshold_or_cap','reprint_rule','special_terms','active'];
/** 料金表全件（無効行も含む・管理用） */
function admin_getFeeSchedule(){ requireRole_([]); return readRows_(ssMaster_(),'Fee_Schedule'); }
/** 料金表の1行を追加・更新（usage_category 一致でupsert） */
function admin_saveFeeRow(row){ requireRole_(['ACCOUNTING','LEGAL_ADMIN']);
  const r = {}; FEE_FIELDS.forEach(function(k){ if(row[k] !== undefined) r[k] = row[k]; });
  if(!r.usage_category) throw new Error('利用目的（usage_category）は必須です');
  if(r.active === undefined) r.active = 'true';
  if(!updateRow_(ssMaster_(),'Fee_Schedule','usage_category', r.usage_category, r)){
    appendRow_(ssMaster_(),'Fee_Schedule', r);
  }
  logEvent_('config','FEE_SCHEDULE',actor_(),null,{ usage_category:r.usage_category, fee_model:r.fee_model });
  return true;
}

/** 公開状態の切替（PUBLISHED / DRAFT / UNPUBLISHED 等） */
function admin_setWorkPublish(workId, status){ requireRole_(['OPERATIONS']);
  updateRow_(ssMaster_(), 'Works_Master', 'work_id', workId, { publish_status: status });
  logEvent_('work', workId, actor_(), null, { publish_status: status });
  return true;   // X投稿は送信許可ポップアップ→admin_postWorkToX
}

// ---- 9.3 データソース設定（スプレッドシート/Drive/GCPの接続先） ----
function admin_getDataSourceConfig(){ requireRole_(['SYSTEM_ADMIN']);
  return {
    SS_MASTER:   prop_('SS_MASTER')   || '',
    SS_OPS:      prop_('SS_OPS')      || '',
    DRIVE_ROOT:  prop_('DRIVE_ROOT')  || '',
    GCP_PROJECT: prop_('GCP_PROJECT') || '',
    GCP_REGION:  prop_('GCP_REGION')  || '',
    GEMINI_MODEL:prop_('GEMINI_MODEL')|| '',
    defaults: {  // 未設定時に使われる CFG 既定値（参考表示用）
      SS_MASTER:CFG.SS_MASTER, SS_OPS:CFG.SS_OPS, DRIVE_ROOT:CFG.DRIVE_ROOT,
      GCP_PROJECT:CFG.GCP_PROJECT, GCP_REGION:CFG.GCP_REGION, GEMINI_MODEL:CFG.GEMINI_MODEL
    }
  };
}
function admin_saveDataSourceConfig(c){ requireRole_(['SYSTEM_ADMIN']);
  const sp = PropertiesService.getScriptProperties();
  ['SS_MASTER','SS_OPS','DRIVE_ROOT','GCP_PROJECT','GCP_REGION','GEMINI_MODEL']
    .forEach(k => { if(c[k] !== undefined) sp.setProperty(k, String(c[k])); });
  logEvent_('config', 'DATASOURCE', actor_(), null, { saved: true });
  return true;
}

// ---- 9.4 外部API：CloudSign / FormRun（秘密はScriptProperties・読み出しはマスク） ----
/** 設定の取得。secret等の機微情報は値を返さず「設定済みか」のみ返す。 */
function admin_getIntegrationConfig(){ requireRole_(['SYSTEM_ADMIN']);
  return {
    cloudsign: {
      client_id:    prop_('CLOUDSIGN_CLIENT_ID')   || '',
      secret_set:   !!prop_('CLOUDSIGN_SECRET'),
      template_id:  prop_('CLOUDSIGN_TEMPLATE_ID') || '',
      callback_url: prop_('CLOUDSIGN_CALLBACK_URL')|| '',
      sandbox:      prop_('CLOUDSIGN_SANDBOX') !== 'false'   // 既定はサンドボックスON
    },
    formrun: {
      form_url:           prop_('FORMRUN_FORM_URL')   || '',
      webhook_secret_set: !!prop_('FORMRUN_WEBHOOK_SECRET'),
      field_map:          prop_('FORMRUN_FIELD_MAP')  || '',
      ref_param:          prop_('FORM_REF_PARAM')     || '',   // application_ref を引き継ぐhidden項目キー（例：_field_xxxxxx）
      hidden_map:         prop_('FORM_HIDDEN_MAP')    || '',   // 正規キー→hidden項目キー（JSON。application_ref/work_id_1../work_title_1..）
      max_works:          prop_('FORM_MAX_WORKS')     || '5'   // 契約書テンプレートの対象原作枠数
    }
  };
}
/** CloudSign設定の保存。secretは値が来た時のみ更新（空なら据え置き）。 */
function admin_saveCloudSignConfig(c){ requireRole_(['SYSTEM_ADMIN']);
  const sp = PropertiesService.getScriptProperties();
  if(c.client_id    !== undefined) sp.setProperty('CLOUDSIGN_CLIENT_ID',    String(c.client_id));
  if(c.secret)                     sp.setProperty('CLOUDSIGN_SECRET',       String(c.secret));
  if(c.template_id  !== undefined) sp.setProperty('CLOUDSIGN_TEMPLATE_ID',  String(c.template_id));
  if(c.callback_url !== undefined) sp.setProperty('CLOUDSIGN_CALLBACK_URL', String(c.callback_url));
  if(c.sandbox      !== undefined) sp.setProperty('CLOUDSIGN_SANDBOX',      c.sandbox ? 'true' : 'false');
  logEvent_('config', 'CLOUDSIGN', actor_(), null, { saved: true });
  return true;
}
/** FormRun設定の保存。webhook_secretは値が来た時のみ更新。 */
function admin_saveFormRunConfig(c){ requireRole_(['SYSTEM_ADMIN']);
  const sp = PropertiesService.getScriptProperties();
  if(c.form_url       !== undefined) sp.setProperty('FORMRUN_FORM_URL',  String(c.form_url));
  if(c.webhook_secret)               sp.setProperty('FORMRUN_WEBHOOK_SECRET', String(c.webhook_secret));
  if(c.field_map      !== undefined) sp.setProperty('FORMRUN_FIELD_MAP', String(c.field_map));
  if(c.ref_param      !== undefined) sp.setProperty('FORM_REF_PARAM',    String(c.ref_param));
  if(c.hidden_map     !== undefined) sp.setProperty('FORM_HIDDEN_MAP',   String(c.hidden_map));
  if(c.max_works      !== undefined) sp.setProperty('FORM_MAX_WORKS',    String(parseInt(c.max_works,10) || 5));
  logEvent_('config', 'FORMRUN', actor_(), null, { saved: true });
  return true;
}

// ---- AI一次審査プロンプト（管理コンソールで差し替え）----
/** 現在のプロンプト・版・モデル設定を返す（既定文も併せて返し「既定に戻す」を可能にする） */
function admin_getAiConfig(){ requireRole_([]);
  return {
    prompt: getConfig_('AI_REVIEW_PROMPT','') || AI_REVIEW_PROMPT_DEFAULT,
    is_default: !String(getConfig_('AI_REVIEW_PROMPT','') || '').trim(),
    default_prompt: AI_REVIEW_PROMPT_DEFAULT,
    version_label: getConfig_('AI_PROMPT_VERSION','') || AI_PROMPT_VERSION,
    effective_version: aiPromptVersion_(),
    model: prop_('GEMINI_MODEL') || '', region: prop_('GCP_REGION') || '', project_set: !!prop_('GCP_PROJECT'),
    schema_fields: Object.keys(REVIEW_SCHEMA.properties)
  };
}
/**
 * プロンプトの保存。出力形式は responseSchema で拘束しているため文面変更で壊れないが、
 * ルールの差込（{{rules}}）が消えると審査条件が伝わらなくなるため警告を返す。
 */
function admin_saveAiConfig(c){ const actor = requireRole_(['SYSTEM_ADMIN','OPERATIONS','LEGAL_ADMIN']);
  c = c || {};
  const warnings = [];
  if(c.prompt !== undefined){
    const p = String(c.prompt || '').trim();
    if(!p) throw new Error('VALIDATION_ERROR: プロンプトが空です（既定に戻す場合は「既定文を読み込む」を使ってください）');
    if(p.length > 8000) throw new Error('VALIDATION_ERROR: プロンプトが長すぎます（8000字まで）');
    if(p.indexOf('{{rules}}') < 0) warnings.push('{{rules}} が含まれていないため、原作別ルールは本文の末尾へ自動付与されます');
    setConfig_('AI_REVIEW_PROMPT', p);
  }
  if(c.version_label !== undefined) setConfig_('AI_PROMPT_VERSION', sanitizeCell_(String(c.version_label).trim()).slice(0,40));
  logEvent_('config', 'AI_REVIEW_PROMPT', actor.email, null,
    { effective_version: aiPromptVersion_(), length: aiReviewPrompt_().length });
  return { effective_version: aiPromptVersion_(), warnings: warnings };
}
/** 実際にGeminiへ送る文面のプレビュー（指定契約の対象原作ルールを差し込む） */
function admin_previewAiPrompt(contractId){ requireRole_([]);
  let works = [];
  if(contractId){
    const cws = readRows_(ssOps_(),'Contract_Works').filter(function(w){ return w.contract_id === String(contractId); });
    const master = readRows_(ssMaster_(),'Works_Master');
    works = cws.map(function(w){ return master.find(function(m){ return m.work_id === w.work_id; }); }).filter(Boolean);
  }
  if(!works.length) works = readRows_(ssMaster_(),'Works_Master').slice(0,2);   // 未指定はマスタ先頭でサンプル表示
  const text = buildReviewPrompt_(buildRulesMulti_(works));
  return { text: text, length: text.length, works: works.map(function(w){ return w.work_name || w.work_id; }),
    effective_version: aiPromptVersion_() };
}

// ---- 案内メールの自動送信（管理コンソール操作）----
/** 管理コンソールからのテスト送信（本番の宛先には送らず、指定アドレスへ見本を送る） */
function admin_sendGuideEmailTest(toEmail, contractId){
  const actor = requireRole_(['SYSTEM_ADMIN','OPERATIONS']);
  const to = normalizeEmail_(toEmail);
  if(!to) throw new Error('VALIDATION_ERROR: 送信先メールアドレスの形式が正しくありません');
  let v = { to:to, license_id:'SPLL-000000-0000', party_name:'テスト 太郎', usage_category:'書籍',
    works:'（テスト作品）', guide_url: workflowUrl_() + '?page=guide&t=TEST', office_contact:getConfig_('OFFICE_CONTACT','') };
  if(contractId){
    const n = readRows_(ssOps_(),'Notification_Queue')
      .find(function(x){ return x.type === 'GUIDE_READY' && x.contract_id === String(contractId); });
    if(n){ v = guideMailVars_(n); v.to = to; }             // 実データの見本を、指定した宛先だけへ送る
  }
  sendGuideEmail_(v);
  logEvent_('notification', 'TEST', actor.email, null, { channel:'EMAIL', to_domain:(to.split('@')[1] || '') });
  return { sent:true, to:to };
}

/** 自動送信の状況（管理コンソール表示用） */
function admin_getMailStatus(){ requireRole_([]);
  const rows = readRows_(ssOps_(),'Notification_Queue').filter(function(n){ return n.type === 'GUIDE_READY'; });
  let quota = null; try{ quota = num_(MailApp.getRemainingDailyQuota()); }catch(e){}
  return {
    enabled: guideEmailEnabled_(),
    sent: rows.filter(function(n){ return n.status === 'SENT'; }).length,
    pending: rows.filter(function(n){ return n.status === 'MANUAL_REQUIRED'; }).length,
    failed: rows.filter(function(n){ return n.status === 'SEND_FAILED'; }).length,
    remaining_quota: quota,
    from_name: getConfig_('MAIL_FROM_NAME','TRPGライツ事務局'),
    reply_to: getConfig_('MAIL_REPLY_TO','')
  };
}

// ---- 締結後の手続き案内（振込先・案内ページ）----
const PAYMENT_CONFIG_KEYS = [
  ['bank_name','PAYMENT_BANK_NAME'], ['branch','PAYMENT_BRANCH'], ['account_type','PAYMENT_ACCOUNT_TYPE'],
  ['account_number','PAYMENT_ACCOUNT_NUMBER'], ['account_holder','PAYMENT_ACCOUNT_HOLDER'],
  ['holder_kana','PAYMENT_HOLDER_KANA'], ['note','PAYMENT_NOTE'], ['office_contact','OFFICE_CONTACT'],
  ['workflow_url','WORKFLOW_URL'], ['public_base_url','PUBLIC_BASE_URL'], ['office_email_domain','OFFICE_EMAIL_DOMAIN'],
  ['mail_from_name','MAIL_FROM_NAME'], ['mail_reply_to','MAIL_REPLY_TO'],
  ['guide_email_auto_send','GUIDE_EMAIL_AUTO_SEND'], ['guide_email_subject','GUIDE_EMAIL_SUBJECT'], ['guide_email_body','GUIDE_EMAIL_BODY']
];
/** 振込先・案内ページ設定の取得（振込先は口座情報のため SYSTEM_ADMIN/ACCOUNTING/OPERATIONS のみ） */
function admin_getGuideConfig(){ requireRole_(['SYSTEM_ADMIN','OPERATIONS','LEGAL_ADMIN']);
  const out = {};
  PAYMENT_CONFIG_KEYS.forEach(function(x){ out[x[0]] = getConfig_(x[1],''); });
  out.configured = paymentConfigured_();
  out.workflow_url_effective = workflowUrl_();
  return out;
}
/** 振込先・案内ページ設定の保存。口座情報の変更は監査ログに残す（金額そのものは記録しない）。 */
function admin_saveGuideConfig(c){ const actor = requireRole_(['SYSTEM_ADMIN','OPERATIONS']);
  c = c || {};
  const url = String(c.workflow_url || '').trim();
  if(url && !/^https:\/\//i.test(url))
    throw new Error('VALIDATION_ERROR: クリエーター向けページURLは https:// で始まる必要があります');
  // QR・バッジに焼き込むドメイン。頒布物に印刷されて永続するため、後から直せない前提で検証する
  const pub = String(c.public_base_url || '').trim();
  if(pub && !/^https:\/\/[^\s?#]+$/i.test(pub))
    throw new Error('VALIDATION_ERROR: 公開ドメインは https:// で始まるURLで、クエリ・フラグメントを含めないでください');
  if(pub && /script\.google\.com|\.run\.app|localhost|^\d/i.test(pub.replace(/^https:\/\//i,'')))
    throw new Error('VALIDATION_ERROR: QRには実行基盤のURL・IPアドレスを設定できません（自社管理の独自ドメインを指定してください）');
  const before = {};
  PAYMENT_CONFIG_KEYS.forEach(function(x){ before[x[0]] = getConfig_(x[1],''); });
  PAYMENT_CONFIG_KEYS.forEach(function(x){
    if(c[x[0]] === undefined) return;
    // 本文テンプレートは長文・改行を含むため、サニタイズ短縮の対象外にする
    const raw = String(c[x[0]]);
    setConfig_(x[1], x[0] === 'guide_email_body' ? raw.slice(0,4000) : sanitizeCell_(raw.trim()).slice(0,300));
  });
  const changed = PAYMENT_CONFIG_KEYS.filter(function(x){ return c[x[0]] !== undefined && String(c[x[0]]).trim() !== before[x[0]]; })
    .map(function(x){ return x[0]; });
  logEvent_('config', 'GUIDE_PAYMENT', actor.email, null, { changed: changed });
  return true;
}
/**
 * 「今後のお手続き」案内ページのURLを発行（既存トークンは失効させて作り直す）。
 * 契約者へ渡す唯一の導線であり、振込先・提出・バッジをこの1枚に集約している。
 */
/** 案内リンクの発行。SPLL番号（推奨）または契約IDを受ける。締結済の案件だけ。 */
function admin_issueGuideLink(idOrLicense){ const actor = requireRole_(['OPERATIONS','LEGAL_ADMIN']);
  const ref = resolveLicenseRef_(idOrLicense);
  const c = ref.contractId ? (readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === ref.contractId; }) || null) : null;
  if(!c) throw new Error('DATA_NOT_FOUND: 締結済みの契約が見つかりません: ' + idOrLicense);
  if(String(c.status) !== 'SIGNED') throw new Error('DATA_CONFLICT: 締結済みの契約のみ案内できます（現在: ' + c.status + '）');
  const key = ref.licenseId || c.contract_id;
  revokeTokens_(key, 'GUIDE');
  const token = prepareGuideToken_(key);
  logEvent_('license_case', key, actor.email, null, { guide_link_issued:true });
  const kase = ref.licenseId ? (readRows_(ssOps_(),'License_Cases').find(function(k){ return k.license_id === ref.licenseId; }) || {}) : {};
  return { url: userPageUrl_('guide','t',token), license_id: ref.licenseId || c.license_id || '', payment_configured: paymentConfigured_(),
    contact_email: c.contact_email || kase.contact_email || '', contact_email_source: c.contact_email_source || '' };
}

// ---- 申込窓口の案内先（Config・環境ごとに切替可能） ----
/**
 * 申込窓口の経路別フォームURLと、法人の退避先（個別契約の問い合わせ窓口）。
 * 問い合わせ先はGoogleフォーム・formrun・メールのいずれでも設定できるよう
 * URLとメールアドレスを別々に保持し、両方あればURLを優先して案内する。
 */
function admin_getPortalRoutingConfig(){ requireRole_([]);
  return {
    form_url_standard_fixed: getConfig_('FORM_URL_STANDARD_FIXED',''),
    form_url_standard_rate:  getConfig_('FORM_URL_STANDARD_RATE',''),
    form_url_individual:     getConfig_('FORM_URL_INDIVIDUAL',''),
    form_url_manual_review:  getConfig_('FORM_URL_MANUAL_REVIEW',''),
    corporate_inquiry_url:   getConfig_('CORPORATE_INQUIRY_URL',''),
    corporate_inquiry_email: getConfig_('CORPORATE_INQUIRY_EMAIL',''),
    corporate_inquiry_note:  getConfig_('CORPORATE_INQUIRY_NOTE',''),
    corporate_default_note:  CORPORATE_INQUIRY_DEFAULT_NOTE,
    form_url_max_chars:      String(formUrlMaxChars_())
  };
}
function admin_savePortalRoutingConfig(c){ requireRole_(['SYSTEM_ADMIN','OPERATIONS']);
  c = c || {};
  const url = String(c.corporate_inquiry_url || '').trim();
  if(url && !/^https?:\/\//i.test(url))
    throw new Error('VALIDATION_ERROR: 問い合わせURLは http(s):// で始まる必要があります');
  const mail = String(c.corporate_inquiry_email || '').trim();
  if(mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail))
    throw new Error('VALIDATION_ERROR: 問い合わせメールアドレスの形式が正しくありません');
  [['form_url_standard_fixed','FORM_URL_STANDARD_FIXED'], ['form_url_standard_rate','FORM_URL_STANDARD_RATE'],
   ['form_url_individual','FORM_URL_INDIVIDUAL'], ['form_url_manual_review','FORM_URL_MANUAL_REVIEW'],
   ['corporate_inquiry_url','CORPORATE_INQUIRY_URL'], ['corporate_inquiry_email','CORPORATE_INQUIRY_EMAIL'],
   ['corporate_inquiry_note','CORPORATE_INQUIRY_NOTE']].forEach(function(x){
    if(c[x[0]] !== undefined) setConfig_(x[1], String(c[x[0]]).trim());
  });
  if(c.form_url_max_chars !== undefined){
    const max = num_(c.form_url_max_chars);
    // formrunの初期値つきURLは1000字まで。超える設定は初期値が届かない契約書を生むので受け付けない
    if(!(max >= 200 && max <= 1000))
      throw new Error('VALIDATION_ERROR: FORM引継ぎURLの上限は200〜1000字で指定してください（formrun仕様の上限は1000字）');
    setConfig_('FORM_URL_MAX_CHARS', String(Math.floor(max)));
  }
  logEvent_('config', 'PORTAL_ROUTING', actor_(), null,
    { corporate_inquiry: url || mail || '(未設定)', saved: true });
  return true;
}

// ============================================================
// 11. X（Twitter）連携：作品公開時の告知投稿
//     資格情報は ScriptProperties（X_API_KEY 等）。投稿は X API v2 /2/tweets（OAuth1.0a）。
// ============================================================
const X_DEFAULT_TEMPLATE =
  '【SPLL 対象作品】{name}（{publisher}）\n二次創作の有料頒布ライセンスのお申込みを受付中です。 #SPLL #TRPG\n{url}';

function x_isConfigured_(){
  return !!(prop_('X_API_KEY') && prop_('X_API_SECRET') && prop_('X_ACCESS_TOKEN') && prop_('X_ACCESS_SECRET'));
}
function x_autopost_(){ return prop_('X_AUTOPOST') === 'true'; }

/** 投稿文の組み立て（作品情報を差込） */
function x_buildPostText_(work){
  const tmpl = getConfig_('X_POST_TEMPLATE', X_DEFAULT_TEMPLATE);
  let url = ''; try{ url = ScriptApp.getService().getUrl() || ''; }catch(e){}
  return tmpl
    .replace(/{name}/g, work.work_name || work.name || '')
    .replace(/{publisher}/g, work.publisher || work.pub || '')
    .replace(/{fee}/g, work.fee_label || work.fee || '')
    .replace(/{url}/g, url);
}

/** X API v2 にツイート送信（OAuth1.0a 署名） */
function x_postTweet_(text){
  if(!x_isConfigured_()) throw new Error('X未設定：管理コンソール「設定」でAPIキーを登録してください');
  const url = 'https://api.twitter.com/2/tweets';
  const oauth = {
    oauth_consumer_key: prop_('X_API_KEY'),
    oauth_token:        prop_('X_ACCESS_TOKEN'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:    String(Math.floor(Date.now() / 1000)),
    oauth_nonce:        Utilities.getUuid().replace(/-/g, ''),
    oauth_version:      '1.0'
  };
  // v2のJSONボディは署名対象に含めない（oauth_*パラメータのみ）
  oauth.oauth_signature = x_oauth1Signature_('POST', url, oauth, prop_('X_API_SECRET'), prop_('X_ACCESS_SECRET'));
  const header = 'OAuth ' + Object.keys(oauth).sort().map(function(k){ return x_enc_(k) + '="' + x_enc_(oauth[k]) + '"'; }).join(', ');
  const res = UrlFetchApp.fetch(url, { method:'post', contentType:'application/json',
    headers:{ Authorization: header }, payload: JSON.stringify({ text: text }), muteHttpExceptions:true });
  const code = res.getResponseCode();
  if(code < 200 || code >= 300) throw new Error('X API HTTP ' + code + ': ' + res.getContentText());
  return JSON.parse(res.getContentText());
}
function x_enc_(s){ return encodeURIComponent(String(s)).replace(/[!*'()]/g, function(c){ return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); }
function x_oauth1Signature_(method, url, oauthParams, consumerSecret, tokenSecret){
  const pstr = Object.keys(oauthParams).sort().map(function(k){ return x_enc_(k) + '=' + x_enc_(oauthParams[k]); }).join('&');
  const base = [method.toUpperCase(), x_enc_(url), x_enc_(pstr)].join('&');
  const key  = x_enc_(consumerSecret) + '&' + x_enc_(tokenSecret);
  return Utilities.base64Encode(Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, base, key));
}

/** 作品をXへ投稿（管理コンソール・手動/自動から呼ぶ）。冪等（作品ごと1回）。 */
function admin_postWorkToX(workId){
  const actor = requireRole_(['OPERATIONS']);
  const w = readRows_(ssMaster_(),'Works_Master').find(function(x){ return x.work_id === workId; });
  if(!w) throw new Error('作品が見つかりません: ' + workId);
  if(w.publish_status !== 'PUBLISHED') throw new Error('VALIDATION_ERROR: 公開(PUBLISHED)の作品のみ投稿できます');
  // 重複投稿防止（X_Posts テーブル・修正設計書 §14）
  if(readRows_(ssOps_(),'X_Posts').some(function(p){ return p.work_id === workId; }))
    throw new Error('DATA_CONFLICT: この作品は投稿済みです（再投稿は X_Posts を確認のうえ手動で）');
  const text = x_buildPostText_(w);
  const res  = x_postTweet_(text);
  const tid  = (res && res.data && res.data.id) || '';
  appendRow_(ssOps_(),'X_Posts',{ x_post_id:Utilities.getUuid(), work_id:workId, tweet_id:tid,
    text:sanitizeCell_(text), posted_by:actor.email, posted_at:new Date().toISOString() });
  logEvent_('work', workId, actor.email, null, { x_posted:true, tweet_id:tid });
  return { tweet_id: tid, text: text };
}
/**
 * 送信許可ポップアップ用のプレビュー。作品データ更新時にクライアントが呼び、
 * autopost=ON かつ 設定済み なら text を確認ダイアログに表示 → 承認で admin_postWorkToX。
 * （サイレント自動投稿はしない：送信は必ず人の許可を挟む）
 */
function admin_getXPostPreview(workId){ requireRole_([]);
  const w = readRows_(ssMaster_(),'Works_Master').find(function(x){ return x.work_id === workId; });
  if(!w) return { text:'', configured:false, autopost:false, published:false };
  return {
    text:       x_buildPostText_(w),
    configured: x_isConfigured_(),
    autopost:   x_autopost_(),
    published:  w.publish_status === 'PUBLISHED',
    already_posted: readRows_(ssOps_(),'X_Posts').some(function(p){ return p.work_id === workId; })
  };
}

// ---- 11/12 管理コンソール設定・手動操作 ----
function admin_getXConfig(){ requireRole_(['SYSTEM_ADMIN']);
  return {
    api_key:          prop_('X_API_KEY') || '',
    api_secret_set:   !!prop_('X_API_SECRET'),
    access_token:     prop_('X_ACCESS_TOKEN') || '',
    access_secret_set:!!prop_('X_ACCESS_SECRET'),
    autopost:         prop_('X_AUTOPOST') === 'true',
    template:         getConfig_('X_POST_TEMPLATE', X_DEFAULT_TEMPLATE)
  };
}
function admin_saveXConfig(c){ requireRole_(['SYSTEM_ADMIN']);
  const sp = PropertiesService.getScriptProperties();
  if(c.api_key      !== undefined) sp.setProperty('X_API_KEY', String(c.api_key));
  if(c.api_secret)                 sp.setProperty('X_API_SECRET', String(c.api_secret));
  if(c.access_token !== undefined) sp.setProperty('X_ACCESS_TOKEN', String(c.access_token));
  if(c.access_secret)              sp.setProperty('X_ACCESS_SECRET', String(c.access_secret));
  if(c.autopost     !== undefined) sp.setProperty('X_AUTOPOST', c.autopost ? 'true' : 'false');
  if(c.template     !== undefined) setConfig_('X_POST_TEMPLATE', String(c.template));
  logEvent_('config', 'X', actor_(), null, { saved:true });
  return true;
}
function admin_getBadgeConfig(){ requireRole_([]);
  return { auto: prop_('BADGE_AUTO') !== 'false', template_id: prop_('BADGE_TEMPLATE_ID') || '' };
}
function admin_saveBadgeConfig(c){ requireRole_(['SYSTEM_ADMIN']);
  const sp = PropertiesService.getScriptProperties();
  if(c.auto        !== undefined) sp.setProperty('BADGE_AUTO', c.auto ? 'true' : 'false');
  if(c.template_id !== undefined) sp.setProperty('BADGE_TEMPLATE_ID', String(c.template_id));
  logEvent_('config', 'BADGE', actor_(), null, { saved:true });
  return true;
}
/** バッジ手動発行 */
function admin_issueBadge(contractId){ requireRole_(['OPERATIONS']); const r = issueBadge_(contractId); logEvent_('badge', r.badge_id || contractId, actor_(), null, { manual:true }); return r; }
/** 照合コードの再発行（LEGAL_ADMIN）。旧QRは無効になる。平文は1回だけ返す。 */
function admin_rotateCertCode(contractId){
  const actor = requireRole_(['LEGAL_ADMIN']);
  const cert = certForRef_(contractId);
  if(!cert) throw new Error('認証が見つかりません: ' + contractId);
  const code = randCode_(12);
  updateRow_(ssOps_(),'Certificates','cert_id',cert.cert_id,{ check_code_hash:hash_(code) });
  logEvent_('certificate', cert.cert_id, actor.email, null, { code_rotated:true });
  const url = verifyUrl_(cert.cert_id, code);
  // 旧QRを含むバッジを差し替え（V2-015）。バッジは認証の表示物なので同じ案件の分を全部
  const ref = resolveLicenseRef_(cert.license_id || cert.contract_id);
  readRows_(ssOps_(),'Badges').filter(function(b){ return belongsToLicense_(b, ref) && b.status === 'ISSUED'; })
    .forEach(function(b){ updateRow_(ssOps_(),'Badges','badge_id',b.badge_id,{ status:'SUPERSEDED' }); });
  enqueueBadgeJob_(cert.contract_id, url);
  return { cert_id:cert.cert_id, check_code:code, verify_url:url };
}

/**
 * 認証の状態変更（理由・承認記録付き）。status は CERT_STATES のいずれか。
 * 例：SUSPENDED / REVOKED / PAYMENT_HOLD / ACTIVE(再有効) / TERMINATED / EXPIRED
 */
const CERT_CRITICAL_STATES = ['REVOKED','TERMINATED','PAYMENT_HOLD','ACTIVE'];   // 職務分離の対象（V2-018）

function admin_setCertStatus(contractId, status, reasonCode, reasonText, legalCaseId){ requireRole_(['LEGAL_ADMIN']);
  if(CERT_CRITICAL_STATES.indexOf(status) >= 0)
    throw new Error('AUTHORIZATION_ERROR: この状態変更（' + status + '）は申請・承認の分離が必要です。admin_requestCertChange → 別の担当者が admin_approveCertChange を実行してください。');
  return applyCertStatus_(contractId, status, reasonCode, reasonText, legalCaseId, actor_());
}
/** 認証の行を SPLL番号または契約IDから引く（license_id が正本、旧行は contract_id）。 */
function certForRef_(idOrLicense){
  const ref = resolveLicenseRef_(idOrLicense);
  return readRows_(ssOps_(),'Certificates').find(function(x){ return belongsToLicense_(x, ref); }) || null;
}
/** 状態変更の実適用（内部）。承認済み申請または非重要状態からのみ呼ばれる。 */
function applyCertStatus_(contractId, status, reasonCode, reasonText, legalCaseId, actorEmail){
  if(CERT_STATES.indexOf(status) < 0) throw new Error('不正な状態: ' + status);
  const cert = certForRef_(contractId);
  if(!cert) throw new Error('認証が見つかりません: ' + contractId);
  const before = cert.status;
  updateRow_(ssOps_(),'Certificates','cert_id',cert.cert_id,{
    status:status, reason_code:reasonCode||'', reason_text:reasonText||'',
    requested_by:actorEmail, approved_by:actorEmail, legal_case_id:legalCaseId||'',
    effective_at:new Date().toISOString() });
  logEvent_('certificate', cert.cert_id, actorEmail, {status:before}, {status:status, reason_code:reasonCode||''});
  // ライセンス台帳の認証状態も追随させる（一覧・検証の表示が実体とずれないように）。
  // 状態列は遷移表を通す：認証の状態値から対応するイベントを選ぶ
  const licenseId = cert.license_id || licenseIdOfContract_(cert.contract_id);
  if(licenseId){
    const kase = readRows_(ssOps_(),'License_Cases').find(function(k){ return k.license_id === licenseId; }) || {};
    transitionLicenseCase_(licenseId, certificateEventFor_(status, kase.certification_status),
      { actor: actorEmail, status: status, reason: reasonCode || '' });
  }
  return true;
}

/**
 * 認証の有効／無効スイッチ（未入金対応）。
 * 既定は有効（締結時にACTIVE）。未入金が判明したらオフにして PAYMENT_HOLD にし、
 * 入金確認後にオンへ戻す。ACTIVE ⇄ PAYMENT_HOLD の往復のみを担当者1名で操作できる。
 * 失効（REVOKED）・契約終了（TERMINATED）や、それらからの復帰は従来どおり申請→別担当者の承認が必要。
 */
function admin_setCertEnabled(contractId, enabled, reason){
  const actor = requireRole_(['OPERATIONS','ACCOUNTING','LEGAL_ADMIN']);
  const cert = certForRef_(contractId);
  if(!cert) throw new Error('DATA_NOT_FOUND: 認証が見つかりません: ' + contractId);
  if(['ACTIVE','PAYMENT_HOLD'].indexOf(String(cert.status)) < 0)
    throw new Error('DATA_CONFLICT: このスイッチは有効／入金保留の切替のみです（現在: ' + cert.status +
      '）。失効・再有効化は申請→別担当者の承認で行ってください。');
  const on = enabled === true || String(enabled) === 'true';
  if(!on && !String(reason||'').trim())
    throw new Error('VALIDATION_ERROR: 認証を無効にする理由（未入金の状況など）は必須です');
  if(on && String(cert.status) === 'ACTIVE') return { status:'ACTIVE', changed:false };
  if(!on && String(cert.status) === 'PAYMENT_HOLD') return { status:'PAYMENT_HOLD', changed:false };
  const status = on ? 'ACTIVE' : 'PAYMENT_HOLD';
  applyCertStatus_(contractId, status, on ? 'PAYMENT_CLEARED' : 'PAYMENT_HOLD',
    sanitizeCell_(String(reason || (on ? '入金確認により再有効化' : ''))).slice(0,300), '', actor.email);
  return { status:status, changed:true };
}

// ---- 認証状態変更の申請・承認（V2-018）----
/** 申請（LEGAL_ADMIN / OPERATIONS）。REQUESTED で登録し、別担当者の承認を待つ。 */
function admin_requestCertChange(contractId, requestedStatus, reasonCode, reasonText, legalCaseId){
  const actor = requireRole_(['LEGAL_ADMIN','OPERATIONS']);
  if(CERT_STATES.indexOf(requestedStatus) < 0) throw new Error('不正な状態: ' + requestedStatus);
  if(!String(reasonText||'').trim()) throw new Error('VALIDATION_ERROR: 理由は必須です');
  const cert = certForRef_(contractId);
  if(!cert) throw new Error('認証が見つかりません: ' + contractId);
  const reqId = Utilities.getUuid();
  appendRow_(ssOps_(),'Certificate_Change_Requests',{ request_id:reqId, cert_id:cert.cert_id, contract_id:cert.contract_id,
    license_id: cert.license_id || licenseIdOfContract_(cert.contract_id),
    requested_status:requestedStatus, reason_code:reasonCode||'', reason_text:sanitizeCell_(String(reasonText)),
    legal_case_id:legalCaseId||'', requested_by:actor.email, requested_at:new Date().toISOString(),
    approved_by:'', approved_at:'', status:'REQUESTED', emergency_override:'' });
  logEvent_('cert_change_request', reqId, actor.email, null, { contract_id:contractId, requested_status:requestedStatus });
  return { request_id:reqId };
}
/**
 * 承認・却下（LEGAL_ADMIN）。申請者本人による承認は原則拒否
 * （緊急時のみ emergencyReason を指定して EMERGENCY_OVERRIDE として記録・V2-018）。
 */
function admin_approveCertChange(requestId, approve, emergencyReason){
  const actor = requireRole_(['LEGAL_ADMIN']);
  const req = readRows_(ssOps_(),'Certificate_Change_Requests').find(function(r){ return r.request_id === requestId; });
  if(!req) throw new Error('DATA_NOT_FOUND: 申請が見つかりません');
  if(req.status !== 'REQUESTED') throw new Error('DATA_CONFLICT: この申請は処理済みです（' + req.status + '）');
  const now = new Date().toISOString();
  if(approve === false){
    updateRow_(ssOps_(),'Certificate_Change_Requests','request_id',requestId,
      { status:'REJECTED', approved_by:actor.email, approved_at:now });
    logEvent_('cert_change_request', requestId, actor.email, {status:'REQUESTED'}, { status:'REJECTED' });
    return true;
  }
  let override = '';
  if(String(req.requested_by).toLowerCase() === String(actor.email).toLowerCase()){
    if(!String(emergencyReason||'').trim())
      throw new Error('AUTHORIZATION_ERROR: 申請者本人は承認できません（緊急時は emergencyReason を指定＝EMERGENCY_OVERRIDE として記録されます）');
    override = 'EMERGENCY_OVERRIDE: ' + String(emergencyReason);
  }
  applyCertStatus_(req.contract_id, req.requested_status, req.reason_code, req.reason_text, req.legal_case_id, actor.email);
  updateRow_(ssOps_(),'Certificate_Change_Requests','request_id',requestId,
    { status:'APPLIED', approved_by:actor.email, approved_at:now, emergency_override:sanitizeCell_(override) });
  // 再有効化時は照合コードを再発行（旧QRのバッジ差替え・再生成も rotate 内で実施。V2-015）
  if(req.requested_status === 'ACTIVE'){
    try{ admin_rotateCertCode(req.contract_id); }
    catch(e){ logError_('PROCESSING_ERROR','certReactivateBadge', e, { contract_id:req.contract_id }); }
  }
  logEvent_('cert_change_request', requestId, actor.email, {status:'REQUESTED'},
    { status:'APPLIED', applied_status:req.requested_status, emergency:!!override });
  return true;
}
/** 未処理の状態変更申請一覧 */
function admin_listCertChangeRequests(){ requireRole_([]);
  return readRows_(ssOps_(),'Certificate_Change_Requests')
    .filter(function(r){ return r.status === 'REQUESTED'; })
    .map(function(r){ return { request_id:r.request_id, contract_id:r.contract_id,
      requested_status:r.requested_status, reason_text:r.reason_text, requested_by:r.requested_by,
      requested_at:String(r.requested_at||'').slice(0,10) }; });
}
// UI互換の薄いラッパ
// V2-018：失効・再有効は「申請」を作成（承認は別担当者）
function admin_revokeCert(contractId, reasonText){ return admin_requestCertChange(contractId, 'REVOKED', 'MANUAL_REVOKE', reasonText||'管理コンソールからの失効申請', ''); }
function admin_reactivateCert(contractId){ return admin_requestCertChange(contractId, 'ACTIVE', 'REACTIVATE', '再有効化の申請', ''); }
function admin_getCertStatus(contractId){ requireRole_([]);
  const cert = certForRef_(contractId);
  return cert ? { cert_id:cert.cert_id, status:cert.status, reason_code:cert.reason_code, issued_at:cert.issued_at } : { status:'NONE' };
}

// ---- 通知キュー管理（§10）----
function admin_listNotifications(){ requireRole_([]);
  const ctrWorks = contractWorksMap_();
  return readRows_(ssOps_(),'Notification_Queue')
    .filter(function(n){ return n.status === 'MANUAL_REQUIRED' || n.status === 'SEND_FAILED'; })
    .map(function(n){ return { notification_id:n.notification_id, contract_id:n.contract_id,
      license_id: n.license_id || licenseIdOfContract_(n.contract_id) || '',   // 一覧の表示はSPLL番号
      work:contractWorkLabel_(ctrWorks, n.contract_id), type:n.type, status:n.status,
      attempts:num_(n.attempts), last_error:String(n.last_error||''),
      payload:parseJson_(n.payload_json, {}), created_at:String(n.created_at||'').slice(0,10) }; });
}
/** 通知の対応済み記録（誰がいつ対応したか） */
function admin_markNotificationHandled(notificationId){
  const actor = requireRole_(['OPERATIONS','ACCOUNTING','LEGAL_ADMIN']);
  updateRow_(ssOps_(),'Notification_Queue','notification_id',notificationId,
    { status:'SENT', sent_at:new Date().toISOString(), handled_by:actor.email });
  logEvent_('notification', notificationId, actor.email, null, { handled:true });
  return true;
}
/** 未解決システムエラー件数（ダッシュボード表示用） */
function admin_countOpenErrors(){ requireRole_([]);
  return readRows_(ssOps_(),'System_Errors').filter(function(e){ return e.status === 'OPEN'; }).length;
}

// ---- 規約・同意文の版管理（§7.2）----
function admin_listLegalDocs(){ requireRole_([]);
  return readRows_(ssOps_(),'Legal_Documents').map(function(d){ return {
    legal_document_id:d.legal_document_id, document_type:d.document_type, version:d.version,
    status:d.status, approved_by:d.approved_by||'', approved_at:String(d.approved_at||'').slice(0,10) }; });
}
/** 下書き保存（新しい版のDRAFTを作成）。公開は admin_publishLegalDoc で明示的に行う。 */
function admin_saveLegalDraft(documentType, contentHtml){
  const actor = requireRole_(['LEGAL_ADMIN']);
  if(LEGAL_DOC_TYPES.indexOf(documentType) < 0)
    throw new Error('VALIDATION_ERROR: 文書種別は ' + LEGAL_DOC_TYPES.join(' / '));
  if(!String(contentHtml || '').trim())
    throw new Error('VALIDATION_ERROR: ' + (LEGAL_DOC_LABELS[documentType] || documentType) + ' の本文が空です');
  const rows = readRows_(ssOps_(),'Legal_Documents').filter(function(d){ return d.document_type === documentType; });
  const nextVer = rows.reduce(function(m,d){ return Math.max(m, num_(d.version)); }, 0) + 1;
  const id = Utilities.getUuid();
  appendRow_(ssOps_(),'Legal_Documents',{ legal_document_id:id, document_type:documentType, version:nextVer,
    content_html:String(contentHtml||''), content_hash:hash_(String(contentHtml||'')),
    effective_from:'', effective_to:'', status:'DRAFT', approved_by:'', approved_at:'' });
  logEvent_('legal_document', id, actor.email, null, { document_type:documentType, version:nextVer, status:'DRAFT' });
  return { legal_document_id:id, version:nextVer };
}
/** 公開（DRAFT→PUBLISHED）。既存のPUBLISHEDはRETIREDへ。以後の申込はこの版に同意する。 */
function admin_publishLegalDoc(legalDocumentId){
  const actor = requireRole_(['LEGAL_ADMIN']);
  const doc = readRows_(ssOps_(),'Legal_Documents').find(function(d){ return d.legal_document_id === legalDocumentId; });
  if(!doc) throw new Error('DATA_NOT_FOUND: 文書が見つかりません');
  if(doc.status !== 'DRAFT') throw new Error('DATA_CONFLICT: DRAFT のみ公開できます（現在: ' + doc.status + '）');
  const now = new Date().toISOString();
  readRows_(ssOps_(),'Legal_Documents')
    .filter(function(d){ return d.document_type === doc.document_type && d.status === 'PUBLISHED'; })
    .forEach(function(d){ updateRow_(ssOps_(),'Legal_Documents','legal_document_id',d.legal_document_id,
      { status:'RETIRED', effective_to:now }); });
  updateRow_(ssOps_(),'Legal_Documents','legal_document_id',legalDocumentId,
    { status:'PUBLISHED', effective_from:now, approved_by:actor.email, approved_at:now });
  logEvent_('legal_document', legalDocumentId, actor.email, {status:'DRAFT'}, { status:'PUBLISHED', document_type:doc.document_type, version:doc.version });
  return true;
}

// ============================================================
// CloudSign例外対応（§10.5/§10.8〜10.11/§12.6）
// ============================================================
/** 自動送信失敗・手動送信待ちの申込一覧。 */
function admin_listCloudSignSendFailures(){ requireRole_([]);
  return readRows_(ssOps_(),'Applications')
    .filter(function(a){ return ['CLOUDSIGN_SEND_FAILED','MANUAL_SEND_REQUIRED'].indexOf(String(a.cloudsign_send_status)) >= 0 &&
      ['CANCELLED','SUPERSEDED'].indexOf(String(a.status)) < 0; })
    .map(function(a){ return { application_id:a.application_id, application_ref:a.application_ref,
      usage_category:a.usage_category, form_submission_id:a.form_submission_id,
      form_submitted_at:String(a.form_submitted_at||'').slice(0,16).replace('T',' '),
      cloudsign_send_status:a.cloudsign_send_status, cloudsign_send_error:a.cloudsign_send_error,
      manual_review_reason:a.manual_review_reason }; });
}
/** 手動で作成・送信したCloudSign書類IDの登録（§10.5）。 */
function admin_markManualCloudSignSent(applicationId, documentId, note){
  const actor = requireRole_(['OPERATIONS','LEGAL_ADMIN']);
  if(!String(documentId||'').trim()) throw new Error('VALIDATION_ERROR: CloudSign書類IDは必須です');
  const app = readRows_(ssOps_(),'Applications').find(function(a){ return a.application_id === String(applicationId||''); });
  if(!app) throw new Error('DATA_NOT_FOUND: 申込がありません: ' + applicationId);
  updateRow_(ssOps_(),'Applications','application_id',app.application_id,
    { cloudsign_send_status:'MANUAL_SENT', cloudsign_send_error:'' });
  logEvent_('application', app.application_id, actor.email,
    { cloudsign_send_status: app.cloudsign_send_status },
    { cloudsign_send_status:'MANUAL_SENT', cloudsign_document_id:String(documentId), note:sanitizeCell_(String(note||'')) });
  return true;
}
/** 申込の取消（§10.5）。 */
function admin_cancelApplication(applicationId, reason){
  const actor = requireRole_(['OPERATIONS','LEGAL_ADMIN']);
  if(!String(reason||'').trim()) throw new Error('VALIDATION_ERROR: 取消理由は必須です');
  const app = readRows_(ssOps_(),'Applications').find(function(a){ return a.application_id === String(applicationId||''); });
  if(!app) throw new Error('DATA_NOT_FOUND: 申込がありません: ' + applicationId);
  if(String(app.status) === 'SIGNED') throw new Error('DATA_CONFLICT: 締結済みの申込は取消できません（訂正は再申込で行ってください）');
  updateRow_(ssOps_(),'Applications','application_id',app.application_id,
    { status:'CANCELLED', cloudsign_send_status:'CANCELLED' });
  logEvent_('application', app.application_id, actor.email, { status:app.status }, { status:'CANCELLED', reason:String(reason) });
  if(app.license_id) transitionLicenseCase_(app.license_id, 'APPLICATION_CANCELLED', { actor: actor.email, reason: String(reason) });
  return true;
}
/** 条件不一致（TERMS_MISMATCH）契約の一覧。 */
function admin_listTermsMismatch(){ requireRole_([]);
  return readRows_(ssOps_(),'Contracts')
    .filter(function(c){ return c.terms_verification_status === 'TERMS_MISMATCH'; })
    .map(function(c){ return { contract_id:c.contract_id, application_ref:c.application_ref,
      cloudsign_title:c.cloudsign_title, signed_at:String(c.signed_at||'').slice(0,10),
      detail:c.terms_verification_detail }; });
}
/** 条件不一致の手動確認（LEGAL_ADMIN）。確認後に締結後の導線と経理引渡を実行（§10.8）。認証は審査後。 */
function admin_confirmContractTerms(contractId, note){
  const actor = requireRole_(['LEGAL_ADMIN']);
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === String(contractId||''); });
  if(!c) throw new Error('DATA_NOT_FOUND: 契約がありません: ' + contractId);
  if(c.terms_verification_status !== 'TERMS_MISMATCH') throw new Error('DATA_CONFLICT: 条件不一致の契約ではありません（' + c.terms_verification_status + '）');
  updateRow_(ssOps_(),'Contracts','contract_id',c.contract_id,
    { link_status:'LINKED', terms_verification_status:'MANUAL_CONFIRMED',
      terms_verification_detail: sanitizeCell_(String(c.terms_verification_detail||'') + ' / 確認: ' + String(note||'')) });
  logEvent_('contract', c.contract_id, actor.email, { terms_verification_status:'TERMS_MISMATCH' },
    { terms_verification_status:'MANUAL_CONFIRMED', note:String(note||'') });
  // 条件不一致の保留（HOLD）を解いて、締結として前進させたうえで後続処理へ
  const licenseId = licenseIdOfContract_(c.contract_id);
  if(licenseId) transitionLicenseCase_(licenseId, 'CLOUDSIGN_SIGNED', { actor: actor.email, reason: '条件確認済み: ' + String(note||'') });
  finishContractLinkage_(c.contract_id);
  return true;
}
/** メール不達の契約一覧（§10.9）。 */
function admin_listDeliveryFailures(){ requireRole_([]);
  return readRows_(ssOps_(),'Contracts')
    .filter(function(c){ return ['SIGNING_EMAIL_BOUNCED','COMPLETION_EMAIL_BOUNCED','DELIVERY_FAILED'].indexOf(String(c.delivery_status)) >= 0; })
    .map(function(c){ return { contract_id:c.contract_id, application_ref:c.application_ref,
      cloudsign_title:c.cloudsign_title, delivery_status:c.delivery_status,
      last_delivery_event_at:String(c.last_delivery_event_at||'').slice(0,16).replace('T',' ') }; });
}
function admin_markDeliveryHandled(contractId, note){
  const actor = requireRole_(['OPERATIONS','LEGAL_ADMIN']);
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === String(contractId||''); });
  if(!c) throw new Error('DATA_NOT_FOUND: 契約がありません: ' + contractId);
  updateRow_(ssOps_(),'Contracts','contract_id',c.contract_id,
    { delivery_status:'HANDLED', last_delivery_event_at:new Date().toISOString() });
  logEvent_('contract', c.contract_id, actor.email, { delivery_status:c.delivery_status },
    { delivery_status:'HANDLED', note:sanitizeCell_(String(note||'')) });
  return true;
}
/**
 * 訂正・再申込（§10.10）：既存申込を上書きせず、新しいapplication_refで置換申込を作成。
 * 旧申込は SUPERSEDED。再同意・再送信は新しいフォームリンクで行う。
 */
function admin_createReplacementApplication(applicationId, reason){
  const actor = requireRole_(['OPERATIONS','LEGAL_ADMIN']);
  if(!String(reason||'').trim()) throw new Error('VALIDATION_ERROR: 訂正理由は必須です');
  const old = readRows_(ssOps_(),'Applications').find(function(a){ return a.application_id === String(applicationId||''); });
  if(!old) throw new Error('DATA_NOT_FOUND: 申込がありません: ' + applicationId);
  if(String(old.status) === 'SUPERSEDED') throw new Error('DATA_CONFLICT: この申込は訂正済みです（' + old.superseded_by_application_id + '）');
  const works = readRows_(ssOps_(),'Application_Works').filter(function(x){ return x.application_id === old.application_id; });
  const newId = newId_('APP');
  const newRef = newRef_();
  const handoffExpires = addDaysIso_(14);
  const workIdsNew = works.map(function(w){ return w.work_id; });
  // RP-001：再申込も1案件＝1SPLL番号。旧caseは引き継がず新規採番（旧caseはCLOSEDへ）
  const kaseOld = old.license_id ? readRows_(ssOps_(),'License_Cases').find(function(k){ return k.license_id === old.license_id; }) : null;
  const newLicenseId = createLicenseCase_(newId, newRef, old.usage_category, workIdsNew, (kaseOld && kaseOld.party_type) || '');
  if(old.license_id) transitionLicenseCase_(old.license_id, 'APPLICATION_CANCELLED', { actor: actor.email, reason: '再申込（訂正）で置換: ' + String(reason) });
  // v4申込は個別条件ハッシュに license_id / application_ref を含むため、新番号で再計算する（旧ハッシュの流用は改変検知に必ず落ちる）
  let newTermsHash = old.terms_hash, newFormFields = null;
  if(/^v4:/.test(String(old.terms_hash || '')) && typeof contractFormFieldsV4_ === 'function'){
    newFormFields = contractFormFieldsV4_(newId, newLicenseId, newRef, old.usage_category, workIdsNew);
    newTermsHash = 'v4:' + contractFormHashV4_(newFormFields);
  }
  appendRow_(ssOps_(),'Applications',{ application_id:newId, application_ref:newRef,
    usage_category:old.usage_category, privacy_hash:old.privacy_hash, terms_hash:newTermsHash,
    handoff_expires_at:handoffExpires, status:'FORM_PENDING', created_at:new Date().toISOString(),
    cloudsign_send_status:'MANUAL_SEND_REQUIRED',
    manual_review_reason:sanitizeCell_('再申込（訂正）: ' + reason),
    supersedes_application_id: old.application_id, license_id: newLicenseId });
  works.forEach(function(w){ appendRow_(ssOps_(),'Application_Works',{
    application_work_id:newId_('AW'), application_id:newId, work_id:w.work_id }); });
  updateRow_(ssOps_(),'Applications','application_id',old.application_id,
    { status:'SUPERSEDED', superseded_by_application_id:newId, cloudsign_send_status:'CANCELLED' });
  // 旧申込に送信済みCloudSign書類があれば取消扱いを記録（§10.10）
  const oldContract = readRows_(ssOps_(),'Contracts').find(function(c){ return c.application_id === old.application_id; });
  if(oldContract) logEvent_('contract', oldContract.contract_id, actor.email, null,
    { note:'再申込により旧契約書類の取消/失効を要手続き', superseded_by_application:newId });
  const workIds = workIdsNew;
  const handoff = makeHandoffToken_(newId, newRef, workIds, old.usage_category, newTermsHash, handoffExpires);
  logEvent_('application', newId, actor.email, null,
    { replacement_of: old.application_id, reason:String(reason), application_ref:newRef, license_id:newLicenseId });
  // 経路・フォームURLはv4判定に一本化（旧申込APIは廃止済み。法人・イベント等はMANUAL_REVIEWへ）
  const route = decideContractRouteV4_({ usageCategory: old.usage_category, workIds: workIds,
    partyType:(kaseOld && kaseOld.party_type) || '' }).route;
  return { application_id:newId, application_ref:newRef, license_id:newLicenseId, handoff_token:handoff,
    terms_snapshot_hash: newTermsHash, template_route: route, form_fields: newFormFields || undefined,
    form_url: partyFormUrlV4_((kaseOld && kaseOld.party_type) || '', route) };
}
/** CloudSignテンプレート・フォームURLの版管理（§10.11）。Configで経路別に保持。 */
const CS_TEMPLATE_ROUTES = ['STANDARD_FIXED','STANDARD_RATE','MANUAL_REVIEW'];
function admin_getContractTemplates(){ requireRole_([]);
  const out = {};
  CS_TEMPLATE_ROUTES.forEach(function(r){
    out[r] = { form_url: getConfig_('FORM_URL_' + r, ''), template_id: getConfig_('CS_TEMPLATE_' + r, ''),
      template_version: getConfig_('CS_TEMPLATE_VERSION_' + r, '') };
  });
  return out;
}
function admin_saveContractTemplates(cfg){
  const actor = requireRole_(['SYSTEM_ADMIN','LEGAL_ADMIN']);
  cfg = cfg || {};
  CS_TEMPLATE_ROUTES.forEach(function(r){
    const c = cfg[r]; if(!c) return;
    if(c.form_url !== undefined) setConfig_('FORM_URL_' + r, String(c.form_url));
    if(c.template_id !== undefined) setConfig_('CS_TEMPLATE_' + r, String(c.template_id));
    if(c.template_version !== undefined) setConfig_('CS_TEMPLATE_VERSION_' + r, String(c.template_version));
  });
  logEvent_('config', 'CS_TEMPLATES', actor.email, null, { routes: Object.keys(cfg) });
  return true;
}

// ---- SPLLライセンス台帳（RP-001 §6：管理画面の主台帳）----
/**
 * ライセンス一覧（RP-002 §11.3 / §12.2）。1案件＝1行。SPLL番号で申込〜認証まで追える。
 * filters: { q（SPLL番号・契約者名・原作名・CloudSign書類ID）, case_status, contract_status, review_status,
 *            certification_status, usage_category, work_id, limit }
 * 経理引渡の状況は返すが一覧の主列にはしない（Finance_Handoffs は外部連携のキュー・§17）。
 */
function admin_listLicenseCases(filters){ requireRole_([]);
  filters = filters || {};
  const worksBy = {}, workIdsBy = {}, feeBy = {};
  readRows_(ssOps_(),'License_Works').forEach(function(w){
    if(String(w.active) !== 'false'){
      (worksBy[w.license_id] = worksBy[w.license_id] || []).push(w.work_name_snapshot || w.work_id);
      (workIdsBy[w.license_id] = workIdsBy[w.license_id] || []).push(String(w.work_id));
      if(!feeBy[w.license_id]) feeBy[w.license_id] = licenseFeeLabel_(w);   // 料金は契約単位（原作間で共通）
    }});
  const contractBy = {}, feeSnapBy = {};
  readRows_(ssOps_(),'Contracts').forEach(function(c){
    if(c.license_id && !contractBy[c.license_id]){
      contractBy[c.license_id] = c.contract_id;
      try{ feeSnapBy[c.license_id] = JSON.parse(c.terms_snapshot || '{}').fee_amount_or_rate || ''; }catch(e){}
    }});
  const q = String(filters.q || '').trim().toLowerCase();
  const eq = function(field, v){ return !filters[field] || String(v || '') === String(filters[field]); };
  const limit = num_(filters.limit) || 200;
  return readRows_(ssOps_(),'License_Cases').slice().reverse().filter(function(k){
    const st = normalizeCaseStatus_(k.case_status);
    if(!eq('case_status', st) || !eq('contract_status', k.contract_status) || !eq('review_status', k.review_status) ||
       !eq('certification_status', k.certification_status) || !eq('usage_category', k.usage_category)) return false;
    if(filters.work_id && (workIdsBy[k.license_id] || []).indexOf(String(filters.work_id)) < 0) return false;
    if(q){
      const hay = [k.license_id, k.party_display_name, k.cloudsign_document_id, k.application_ref, (worksBy[k.license_id]||[]).join(' ')]
        .join(' ').toLowerCase();
      if(hay.indexOf(q) < 0) return false;
    }
    return true;
  }).slice(0, limit).map(function(k){
    const st = normalizeCaseStatus_(k.case_status);
    return {
      license_id: k.license_id, application_ref: k.application_ref,
      party_type: k.party_type, party_display_name: k.party_display_name,
      usage_category: k.usage_category, works: (worksBy[k.license_id] || []).join('、'),
      contact_email: k.contact_email || '',
      fee: feeSnapBy[k.license_id] || feeBy[k.license_id] || '',   // 締結済は契約スナップショット、未締結は申込時スナップショット
      case_status: st, next_action: licenseNextAction_(st),
      contract_status: k.contract_status, review_status: k.review_status, certification_status: k.certification_status,
      finance_handoff_status: k.finance_handoff_status,
      cloudsign_document_id: k.cloudsign_document_id || '',
      signed_at: String(k.signed_at || '').slice(0, 10), updated_at: String(k.updated_at || '').slice(0, 10),
      legacy_contract_id: contractBy[k.license_id] || '' }; });
}
/** 現在地から「次に誰が何をするか」の短い案内（一覧・詳細の「次の対応」列） */
function licenseNextAction_(caseStatus){
  return ({
    APPLICATION_RECEIVED: 'クリエーターがフォーム入力', CONTRACT_PENDING: 'CloudSign送付待ち', MANUAL_REVIEW: '事務局が個別確認',
    SIGNING: 'クリエーターがCloudSignで同意', HOLD: '法務が条件不一致を確認', AWAITING_SUBMISSION: 'クリエーターが作品提出',
    REVIEWING: '審査（AI→人手）', CORRECTION_REQUIRED: 'クリエーターが是正・再提出', CERTIFIED: '—（有効）',
    SUSPENDED: '停止理由の解消', TERMINATED: '—', CANCELLED: '—'
  })[String(caseStatus || '')] || '';
}
/** License_Worksのスナップショットから料金表示ラベル（締結前の案件用） */
function licenseFeeLabel_(w){
  const model = String(w.fee_model_snapshot || '').toUpperCase();
  const v = num_(w.fee_value_snapshot);
  if(model === 'RATE') return '売上の' + Math.round(v * 1000) / 10 + '％';
  if(model === 'FLAT') return v > 0 ? yen_(v) + '／契約' : '無償';
  return '';
}
/** ライセンス詳細（契約書履歴・引渡状況つき）。 */
/**
 * ライセンス詳細（RP-002 §11.3）。1案件を SPLL番号で丸ごと返す。
 *   license / works / contractDocuments / submissions（版・最新の人手審査）/ certificate / badge /
 *   changeRequests / pendingNotifications / timeline（状態遷移の履歴）/ legacy（旧契約ID・経理引渡）
 * 画面は契約ID・申込IDを主表示にせず、この応答だけで案件を扱えるようにする。
 */
function admin_getLicenseCase(licenseId){ requireRole_([]);
  const lid = String(licenseId || '');
  const k = readRows_(ssOps_(),'License_Cases').find(function(x){ return x.license_id === lid; });
  if(!k) throw new Error('DATA_NOT_FOUND: ライセンスがありません: ' + licenseId);
  const ref = resolveLicenseRef_(lid);
  const contract = ref.contractId ? (readRows_(ssOps_(),'Contracts').find(function(c){ return c.contract_id === ref.contractId; }) || null) : null;
  const versions = readRows_(ssOps_(),'Submission_Versions');
  const reviews  = readRows_(ssOps_(),'Human_Reviews');
  const submissions = readRows_(ssOps_(),'Submissions').filter(function(x){ return belongsToLicense_(x, ref); }).map(function(sub){
    const vs = versions.filter(function(v){ return v.submission_id === sub.submission_id; })
      .sort(function(a,b){ return num_(a.version_no) - num_(b.version_no); })
      .map(function(v){ return { version_id:v.version_id, version_no:num_(v.version_no), status:v.status,
        submitted_at:String(v.submitted_at||'').slice(0,10), method:v.submission_method||'UPLOAD' }; });
    const latestReview = reviews.filter(function(h){ return h.submission_id === sub.submission_id; })
      .sort(function(a,b){ return String(b.reviewed_at||'').localeCompare(String(a.reviewed_at||'')); })[0] || null;
    return { submission_id:sub.submission_id, title:sub.title, status:sub.status, method:sub.submission_method||'UPLOAD',
      submitted_at:String(sub.submitted_at||'').slice(0,10), versions:vs,
      latest_review: latestReview ? { result:latestReview.result, reviewer:latestReview.reviewer,
        comments:String(latestReview.comments||''), reviewed_at:String(latestReview.reviewed_at||'').slice(0,10) } : null };
  });
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return belongsToLicense_(x, ref); }) || null;
  const badge = readRows_(ssOps_(),'Badges').find(function(b){ return belongsToLicense_(b, ref) && String(b.status) === 'ISSUED'; }) || null;
  let terms = {}; try{ terms = JSON.parse((contract && contract.terms_snapshot) || '{}'); }catch(e){}
  return {
    license: Object.assign({}, k, { case_status: normalizeCaseStatus_(k.case_status), next_action: licenseNextAction_(normalizeCaseStatus_(k.case_status)) }),
    works: readRows_(ssOps_(),'License_Works').filter(function(w){ return w.license_id === lid; }),
    contract: contract ? { contract_id:contract.contract_id, status:contract.status, link_status:contract.link_status,
      terms_verification_status:contract.terms_verification_status||'', delivery_status:contract.delivery_status||'',
      cloudsign_document_id:contract.cloudsign_document_id||'', signed_at:String(contract.signed_at||'').slice(0,10),
      contact_email:contract.contact_email||'', contact_email_source:contract.contact_email_source||'',
      fee_label:String(terms.fee_amount_or_rate||''), payment_terms:String(terms.payment_terms||terms.payment_due||''),
      template_version:String(terms.contract_template_version||'') } : null,
    contractDocuments: readRows_(ssOps_(),'Contract_Documents').filter(function(d){ return d.license_id === lid; })
      .sort(function(a,b){ return String(a.created_at||'').localeCompare(String(b.created_at||'')); }),
    submissions: submissions,
    certificate: cert ? { cert_id:cert.cert_id, status:cert.status, reason_code:cert.reason_code||'', reason_text:cert.reason_text||'',
      issued_at:cert.issued_at||'', effective_at:String(cert.effective_at||'').slice(0,10) } : null,
    badge: badge ? { badge_id:badge.badge_id, issued_at:badge.issued_at, status:badge.status } : null,
    changeRequests: readRows_(ssOps_(),'Certificate_Change_Requests').filter(function(r){ return belongsToLicense_(r, ref); })
      .map(function(r){ return { request_id:r.request_id, requested_status:r.requested_status, reason_text:r.reason_text,
        requested_by:r.requested_by, requested_at:String(r.requested_at||'').slice(0,10), status:r.status }; }),
    pendingNotifications: readRows_(ssOps_(),'Notification_Queue')
      .filter(function(n){ return belongsToLicense_(n, ref) && (n.status === 'MANUAL_REQUIRED' || n.status === 'SEND_FAILED'); })
      .map(function(n){ return { notification_id:n.notification_id, type:n.type, status:n.status, created_at:String(n.created_at||'').slice(0,10),
        payload:parseJson_(n.payload_json, {}) }; }),
    timeline: licenseTimeline_(lid),
    legacy: { contract_id: ref.contractId || '',
      handoffs: readRows_(ssOps_(),'Finance_Handoffs').filter(function(h){ return h.license_id === lid; })
        .map(function(h){ return { handoff_version:h.handoff_version, status:h.status, created_at:String(h.created_at||'').slice(0,10), accepted_at:String(h.accepted_at||'').slice(0,10) }; }) }
  };
}
/** 状態遷移の履歴だけ */
function admin_getLicenseTimeline(licenseId){ requireRole_([]); return licenseTimeline_(String(licenseId||'')); }
/** 契約書履歴だけ */
function admin_getContractDocuments(licenseId){ requireRole_([]);
  return readRows_(ssOps_(),'Contract_Documents').filter(function(d){ return d.license_id === String(licenseId||''); }); }
/** 提出だけ */
function admin_getSubmissionsByLicense(licenseId){ requireRole_([]); return admin_getLicenseCase(licenseId).submissions; }
/** 認証だけ */
function admin_getCertificationByLicense(licenseId){ requireRole_([]);
  const d = admin_getLicenseCase(licenseId); return { certificate:d.certificate, badge:d.badge, changeRequests:d.changeRequests }; }

/**
 * 認証管理タブの一覧（RP-002 §12.4）。Certificate が正本、Badge は表示物。
 * SPLL番号・契約者・原作・認証状態・発行日・停止理由・承認待ちの申請を1行にまとめる。
 */
function admin_listCertifications(){ requireRole_([]);
  const cases = {}; readRows_(ssOps_(),'License_Cases').forEach(function(k){ cases[k.license_id] = k; });
  const worksBy = licenseWorksMap_();
  const badges = readRows_(ssOps_(),'Badges'), reqs = readRows_(ssOps_(),'Certificate_Change_Requests');
  return readRows_(ssOps_(),'Certificates').slice().reverse().map(function(c){
    const lid = c.license_id || licenseIdOfContract_(c.contract_id) || '';
    const k = cases[lid] || {};
    const ref = { licenseId: lid, contractId: c.contract_id };
    const pending = reqs.filter(function(r){ return r.status === 'REQUESTED' && (r.cert_id === c.cert_id || belongsToLicense_(r, ref)); });
    const badge = badges.find(function(b){ return belongsToLicense_(b, ref) && String(b.status) === 'ISSUED'; });
    return { cert_id:c.cert_id, license_id:lid, legacy_contract_id:c.contract_id||'',
      party_display_name:k.party_display_name||'', works:(worksBy[lid]||[]).join('、'),
      status:c.status, reason_code:c.reason_code||'', reason_text:c.reason_text||'', issued_at:c.issued_at||'',
      badge_status: badge ? 'ISSUED' : 'NONE',
      pending_request: pending.length ? { request_id:pending[0].request_id, requested_status:pending[0].requested_status,
        requested_by:pending[0].requested_by } : null };
  });
}
