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

// ---- 利用報告の管理（FUN-01/§11.1：SUBMITTED→RETURNED/APPROVED→LOCKED）----
function admin_listReports(){
  requireRole_([]);
  const ctrWorks = contractWorksMap_();
  return readRows_(ssOps_(),'Usage_Reports').map(function(r){ return {
    report_id:r.report_id, contract_id:r.contract_id, work:contractWorkLabel_(ctrWorks, r.contract_id),
    period:String(r.period||''), channel:String(r.channel||''), qty:String(r.qty||''),
    gross:String(r.gross_sales||''), net:String(r.net_sales||''), url:String(r.sales_url||''),
    status:r.status||'', submitted_at:String(r.submitted_at||'') }; });
}
function reportTransition_(reportId, from, patch, actorEmail){
  const r = readRows_(ssOps_(),'Usage_Reports').find(function(x){ return x.report_id === reportId; });
  if(!r) throw new Error('DATA_NOT_FOUND: 報告が見つかりません: ' + reportId);
  if(from.indexOf(r.status) < 0) throw new Error('DATA_CONFLICT: 現在の状態（' + r.status + '）からは実行できません');
  updateRow_(ssOps_(),'Usage_Reports','report_id',reportId,patch);
  logEvent_('usage_report', reportId, actorEmail, {status:r.status}, patch);
  return true;
}
/** 承認（SUBMITTED→APPROVED）。RATE契約はここから請求起票が可能になる。 */
function admin_approveReport(reportId){
  const actor = requireRole_(['ACCOUNTING']);
  return reportTransition_(reportId, ['SUBMITTED'], { status:'APPROVED', approved_by:actor.email, approved_at:new Date().toISOString() }, actor.email);
}
/** 差戻し（SUBMITTED→RETURNED）。理由必須。利用者は同期間を再提出できる。 */
function admin_returnReport(reportId, reason){
  const actor = requireRole_(['ACCOUNTING']);
  if(!reason) throw new Error('VALIDATION_ERROR: 差戻し理由は必須です');
  return reportTransition_(reportId, ['SUBMITTED'], { status:'RETURNED', returned_reason:sanitizeCell_(String(reason)) }, actor.email);
}
/** ロック（APPROVED→LOCKED）。清算・請求の対象として確定。 */
function admin_lockReport(reportId){
  const actor = requireRole_(['ACCOUNTING']);
  return reportTransition_(reportId, ['APPROVED'], { status:'LOCKED', locked_at:new Date().toISOString() }, actor.email);
}
/** RATE契約：承認済み報告から請求を起票（net×契約スナップショット率）。冪等（報告単位）。 */
function admin_generateInvoicesFromReports(period){
  const actor = requireRole_(['ACCOUNTING']);
  period = period || currentPeriod_();
  const contracts = {}; readRows_(ssOps_(),'Contracts').forEach(function(c){ contracts[c.contract_id] = c; });
  const invoiced = {}; readRows_(ssOps_(),'Invoices').forEach(function(v){ if(v.source_type==='REPORT') invoiced[v.source_id] = true; });
  const targets = readRows_(ssOps_(),'Usage_Reports').filter(function(r){
    return String(r.period) === String(period) && (r.status === 'APPROVED' || r.status === 'LOCKED') && !invoiced[r.report_id]; });
  const out = [];
  targets.forEach(function(r){
    const c = contracts[r.contract_id]; if(!c) return;
    let t = {}; try{ t = JSON.parse(c.terms_snapshot||'{}'); }catch(e){}
    if(String(t.fee_model).toUpperCase() !== 'RATE' || t.rate == null) return;
    const amount = Math.round(num_(r.net_sales) * num_(t.rate));
    if(amount <= 0) return;
    const invId = createInvoice_(r.contract_id, period, 'REPORT', r.report_id, t.fee_amount_or_rate||'', amount, actor.email);
    out.push({ invoice_id:invId, contract_id:r.contract_id, amount:amount });
  });
  return { period:period, generated:out.length, invoices:out };
}
/** 報告リンクの発行（当社からメール送信はしない） */
function admin_sendReportLink(contractId){
  requireRole_(['OPERATIONS','ACCOUNTING']);
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; });
  if(!c) throw new Error('契約が見つかりません: ' + contractId);
  const token = issueToken_(contractId, 'REPORT', 400, 24);
  let base = ''; try{ base = ScriptApp.getService().getUrl() || ''; }catch(e){}
  return { url:(base||'') + '?page=report&token=' + token, token:token };
}

/** ダッシュボード：6KPI＋直近の要対応（作品名を結合） */
function admin_dashboard(){ requireRole_([]);
  const jobs      = readRows_(ssOps_(),'AI_Review_Jobs');
  const findings  = readRows_(ssOps_(),'AI_Findings');
  const contracts = readRows_(ssOps_(),'Contracts');
  const apps      = readRows_(ssOps_(),'Applications');
  const invoices  = readRows_(ssOps_(),'Invoices');
  const reports   = readRows_(ssOps_(),'Usage_Reports');
  const alerts    = readRows_(ssOps_(),'Compliance_Alerts');
  const human     = readRows_(ssOps_(),'Human_Reviews');
  const ctrWorks  = contractWorksMap_();
  const cleared   = {}; human.filter(h=>h.result==='CLEARED').forEach(h => { cleared[String(h.submission_id)] = true; });

  const kpis = {
    reviewPending: jobs.filter(j => j.status==='COMPLETED' && !cleared[String(j.submission_id)]).length,
    highRisk:      findings.filter(isHighRisk_).length,
    unscreened:    jobs.filter(j => j.status==='QUEUED' || j.status==='SCANNING').length,
    signing:       apps.filter(a => a.status && a.status!=='SIGNED' && a.status!=='CANCELLED').length,
    unpaid:        invoices.filter(v => ['PAID','VOID','OVERPAID'].indexOf(String(v.status)) < 0).length,
    reporting:     reports.filter(r => r.status && r.status!=='SUBMITTED' && r.status!=='APPROVED' && r.status!=='LOCKED').length
  };

  const subCtr = {}; readRows_(ssOps_(),'Submissions').forEach(s => { subCtr[s.submission_id] = s.contract_id; });
  const rows = [];
  alerts.filter(a => a.status!=='CLOSED').forEach(a => rows.push({
    kind:'審査', target:a.submission_id||a.contract_id||'', work:contractWorkLabel_(ctrWorks, a.contract_id||subCtr[a.submission_id]),
    status:String(a.severity||'ALERT'), cls:isHighRisk_(a)?'fail':'review', at:String(a.occurred_at||'')
  }));
  invoices.filter(v => ['ISSUED','UNPAID','PARTIALLY_PAID'].indexOf(String(v.status)) >= 0).forEach(v => rows.push({
    kind:'入金', target:v.contract_id, work:contractWorkLabel_(ctrWorks, v.contract_id),
    status:(v.status==='PARTIALLY_PAID' ? '一部入金' : '入金待ち'), cls:'unpaid', at:String(v.issued_at||'')
  }));
  rows.sort((a,b) => String(b.at).localeCompare(String(a.at)));
  return { kpis: kpis, alerts: rows.slice(0,8) };
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
  // 通知キュー（§10）：是正要求／審査結果を利用者へ伝えるべきことを記録（メール非保持のため人手対応）
  const ntype = result === 'CORRECTION_REQUIRED' ? 'CORRECTION_REQUEST' : 'REVIEW_RESULT';
  enqueueNotification_(sub.contract_id, ntype, targetVersion, { submission_id:submissionId, result:result, comment:String(comment||'').slice(0,300) });
  logEvent_('human_review', submissionId, actor.email, {status:sub.status}, {result:result, version_id:targetVersion});
  return true;
}

/** 契約一覧：締結済(Contracts)＋締結待ち(Applications)を結合、契約者名はマスク、対象原作は複数表示 */
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
function admin_sendUploadLink(contractId){ requireRole_(['OPERATIONS']);
  const c = readRows_(ssOps_(),'Contracts').find(x => x.contract_id===contractId);
  if(!c) throw new Error('契約が見つかりません: '+contractId);
  revokeTokens_(contractId, 'SUBMISSION');            // 再発行時は旧トークンを失効（§9.1）
  const token = prepareSubmissionToken_(contractId);
  let base = ''; try{ base = ScriptApp.getService().getUrl() || ''; }catch(e){}
  const url = base ? (base + '?page=upload&t=' + token) : ('?page=upload&t=' + token);
  logEvent_('contract', contractId, actor_(), null, {upload_link_issued:true});
  return { url:url, token:token };
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
 * 未紐付け締結を申込へ手動紐付け。対象原作を固定し、認証・バッジ・提出トークンを発行（冪等）。
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
    { application_id: applicationId, application_ref: app.application_ref || '', link_status: 'LINKED' });
  snapshotContractWorks_(contractId, applicationId);
  snapshotContractTerms_(contractId, app);
  updateRow_(ssOps_(),'Applications','application_id',applicationId,{ status:'SIGNED' });
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

/** 入金管理：請求(Invoices)に入金(Payments)状況・作品名を結合 */
function admin_listPayments(){ requireRole_([]);
  const invoices  = readRows_(ssOps_(),'Invoices');
  const payments  = readRows_(ssOps_(),'Payments');
  const ctrWorks  = contractWorksMap_();
  return invoices.map(v => {
    const pays = payments.filter(p => String(p.invoice_id)===String(v.invoice_id) && p.status !== 'VOID');
    const total = num_(v.total_amount) || num_(v.amount);
    const lastPay = pays.slice().sort((a,b)=>String(b.paid_at||'').localeCompare(String(a.paid_at||'')))[0];
    return {
      invoice_id:v.invoice_id, contract_id:v.contract_id, work:contractWorkLabel_(ctrWorks, v.contract_id),
      amount:String(total || v.amount_rule || ''), due_date:String(v.due_date||''),
      status:v.status || 'ISSUED', paid_amount:num_(v.paid_amount), balance:num_(v.balance_amount),
      paid_at: lastPay ? String(lastPay.paid_at||'') : '',
      diff: -num_(v.balance_amount)
    };
  });
}

/** 入金記録（結果入力）。recordedBy/paidAt は未指定なら補完。 */
function admin_recordPayment(contractId, invoiceId, amount, paidAt, paymentReference){
  const actor = requireRole_(['ACCOUNTING']);
  // V2-010：請求存在→契約照合→VOID拒否→参照重複→累計→状態決定（一部入金・過入金対応）
  if(!invoiceId) throw new Error('VALIDATION_ERROR: 請求IDは必須です');
  const inv = readRows_(ssOps_(),'Invoices').find(function(v){ return String(v.invoice_id)===String(invoiceId); });
  if(!inv) throw new Error('DATA_NOT_FOUND: 請求が見つかりません: ' + invoiceId);
  if(contractId && String(inv.contract_id) !== String(contractId))
    throw new Error('DATA_CONFLICT: 請求の契約と入金対象の契約が一致しません');
  if(inv.status === 'VOID') throw new Error('DATA_CONFLICT: 取消済み（VOID）の請求には入金できません');
  const amt = requireNonNegativeNumber_(amount, '入金額');
  if(amt <= 0) throw new Error('VALIDATION_ERROR: 入金額は正の数値で入力してください');
  paidAt = String(paidAt || new Date().toISOString().slice(0,10));
  if(!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) throw new Error('VALIDATION_ERROR: 入金日は YYYY-MM-DD 形式で入力してください');
  const ref = String(paymentReference||'').slice(0,64);
  if(ref && readRows_(ssOps_(),'Payments').some(function(p){ return p.payment_reference === ref && p.status !== 'VOID'; }))
    throw new Error('DATA_CONFLICT: 同一の入金参照番号が登録済みです: ' + ref);
  appendRow_(ssOps_(),'Payments',{ payment_id:newId_('PAY'), invoice_id:invoiceId, contract_id:inv.contract_id,
    amount:amt, paid_at:paidAt, payment_reference:sanitizeCell_(ref), status:'RECORDED', recorded_by:actor.email });
  const st = recalcInvoiceStatus_(invoiceId);
  logEvent_('payment', inv.contract_id, actor.email, null, {invoice_id:invoiceId, amount:amt, paid_at:paidAt, status:st.status, balance:st.balance});
  return { recorded:true, status:st.status, paid_amount:st.paid, balance:st.balance, diff:-st.balance };
}
/** 請求の累計入金・残額・状態を再計算（V2-010）。UNPAID/PARTIALLY_PAID/PAID/OVERPAID。 */
function recalcInvoiceStatus_(invoiceId){
  const inv = readRows_(ssOps_(),'Invoices').find(function(v){ return String(v.invoice_id)===String(invoiceId); });
  if(!inv) return { status:'', paid:0, balance:0 };
  const total = num_(inv.total_amount) || num_(inv.amount);
  const paid = readRows_(ssOps_(),'Payments')
    .filter(function(p){ return String(p.invoice_id)===String(invoiceId) && p.status !== 'VOID'; })
    .reduce(function(s,p){ return s + num_(p.amount); }, 0);
  const balance = total - paid;
  const status = inv.status === 'VOID' ? 'VOID'
    : paid === 0 ? 'UNPAID' : (balance > 0 ? 'PARTIALLY_PAID' : (balance === 0 ? 'PAID' : 'OVERPAID'));
  updateRow_(ssOps_(),'Invoices','invoice_id',invoiceId,
    { paid_amount:paid, balance_amount:balance, status:status, payment_status_updated_at:new Date().toISOString() });
  return { status:status, paid:paid, balance:balance };
}

/** 入金の取消（請求は入金待ちへ戻す） */
function admin_voidPayment(invoiceId, reason){
  const actor = requireRole_(['ACCOUNTING']);
  if(!String(reason||'').trim()) throw new Error('VALIDATION_ERROR: 取消理由は必須です');
  const now = new Date().toISOString();
  const pays = readRows_(ssOps_(),'Payments').filter(p => String(p.invoice_id)===String(invoiceId) && p.status !== 'VOID');
  if(!pays.length) throw new Error('DATA_NOT_FOUND: 取消対象の入金がありません');
  pays.forEach(p => updateRow_(ssOps_(),'Payments','payment_id',p.payment_id,
    { status:'VOID', void_reason:sanitizeCell_(String(reason)), voided_at:now, voided_by:actor.email }));
  const st = recalcInvoiceStatus_(invoiceId);   // 残額・状態を再計算（V2-010-9）
  logEvent_('payment', invoiceId, actor.email, {status:'RECORDED'}, {status:'VOID', reason:String(reason), invoice_status:st.status});
  return true;
}

/** 半期清算：計算書(Settlement_Statements)に配分額・パートナー名を結合 */
function admin_listSettlements(){ requireRole_([]);
  const stmts       = readRows_(ssOps_(),'Settlement_Statements');
  const settlements = readRows_(ssOps_(),'Settlements');
  const partners    = readRows_(ssOps_(),'Partners');
  const pName = {}; partners.forEach(p => { pName[p.partner_id] = p.name; });
  const sAmt  = {}; settlements.forEach(s => { sAmt[s.settlement_id] = s.amount; });
  return stmts.map(s => ({
    statement_id:s.statement_id, period:String(s.period||''), partner:pName[s.partner_id]||String(s.partner_id||''),
    amount:String(sAmt[s.settlement_id]||''), status:s.status||'', objection_due:String(s.objection_due||'')
  }));
}

/** 計算書の承認（DRAFT→APPROVED）。送信は admin_sendApprovedStatements で実施。 */
function admin_approveStatement(statementId){
  const actor = requireRole_(['ACCOUNTING']);
  updateRow_(ssOps_(),'Settlement_Statements','statement_id',statementId,
    {status:'APPROVED', approved_by:actor.email, approved_at:new Date().toISOString()});
  logEvent_('settlement_statement', statementId, actor.email, null, {status:'APPROVED'});
  return true;
}

// ---- バッチ手動起動（管理コンソールから・時間主導トリガーと共用） ----
/** QUEUEDのAI審査ジョブを実行 */
function admin_runAiReviews(){ requireRole_(['OPERATIONS']); const r = batch_runAiReviews_(); logEvent_('batch','ai_reviews',actor_(),null,r); return r; }
/** 当期（または指定期）の計算書をDRAFT生成 */
function admin_generateStatements(period){ requireRole_(['ACCOUNTING']); const r = generateStatements_(period||currentPeriod_()); logEvent_('batch','generate_statements',actor_(),null,r); return r; }
/** 承認済の計算書をCloudSign送信（みなし合意・発効日＋1ヶ月） */
function admin_sendApprovedStatements(){ requireRole_(['ACCOUNTING']); const r = batch_sendApprovedStatements_(); logEvent_('batch','send_statements',actor_(),null,r); return r; }
/** 異議申立の記録（管理コンソール） */
function admin_recordObjection(statementId, note){ requireRole_(['ACCOUNTING','LEGAL_ADMIN']);
  updateRow_(ssOps_(),'Settlement_Statements','statement_id',statementId,{ status:'OBJECTION_RECEIVED' });
  logEvent_('settlement_statement', statementId, actor_(), null, { status:'OBJECTION_RECEIVED', note:note||'' });
  return true;
}
/** 支払確定（管理コンソール）：NO_OBJECTION_RECORDED → FINALIZED */
function admin_finalizeStatement(statementId){ requireRole_(['ACCOUNTING']);
  updateRow_(ssOps_(),'Settlement_Statements','statement_id',statementId,{ status:'FINALIZED', finalized_at:new Date().toISOString() });
  logEvent_('settlement_statement', statementId, actor_(), null, { status:'FINALIZED' });
  return true;
}

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
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  if(!cert) throw new Error('認証が見つかりません: ' + contractId);
  const code = randCode_(12);
  updateRow_(ssOps_(),'Certificates','cert_id',cert.cert_id,{ check_code_hash:hash_(code) });
  logEvent_('certificate', cert.cert_id, actor.email, null, { code_rotated:true });
  const url = verifyUrl_(cert.cert_id, code);
  // 旧QRを含むバッジを差し替え（V2-015）
  readRows_(ssOps_(),'Badges').filter(function(b){ return b.contract_id === contractId && b.status === 'ISSUED'; })
    .forEach(function(b){ updateRow_(ssOps_(),'Badges','badge_id',b.badge_id,{ status:'SUPERSEDED' }); });
  enqueueBadgeJob_(contractId, url);
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
/** 状態変更の実適用（内部）。承認済み申請または非重要状態からのみ呼ばれる。 */
function applyCertStatus_(contractId, status, reasonCode, reasonText, legalCaseId, actorEmail){
  if(CERT_STATES.indexOf(status) < 0) throw new Error('不正な状態: ' + status);
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  if(!cert) throw new Error('認証が見つかりません: ' + contractId);
  const before = cert.status;
  updateRow_(ssOps_(),'Certificates','cert_id',cert.cert_id,{
    status:status, reason_code:reasonCode||'', reason_text:reasonText||'',
    requested_by:actorEmail, approved_by:actorEmail, legal_case_id:legalCaseId||'',
    effective_at:new Date().toISOString() });
  logEvent_('certificate', cert.cert_id, actorEmail, {status:before}, {status:status, reason_code:reasonCode||''});
  return true;
}

// ---- 認証状態変更の申請・承認（V2-018）----
/** 申請（LEGAL_ADMIN / OPERATIONS）。REQUESTED で登録し、別担当者の承認を待つ。 */
function admin_requestCertChange(contractId, requestedStatus, reasonCode, reasonText, legalCaseId){
  const actor = requireRole_(['LEGAL_ADMIN','OPERATIONS']);
  if(CERT_STATES.indexOf(requestedStatus) < 0) throw new Error('不正な状態: ' + requestedStatus);
  if(!String(reasonText||'').trim()) throw new Error('VALIDATION_ERROR: 理由は必須です');
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  if(!cert) throw new Error('認証が見つかりません: ' + contractId);
  const reqId = Utilities.getUuid();
  appendRow_(ssOps_(),'Certificate_Change_Requests',{ request_id:reqId, cert_id:cert.cert_id, contract_id:contractId,
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
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  return cert ? { cert_id:cert.cert_id, status:cert.status, reason_code:cert.reason_code, issued_at:cert.issued_at } : { status:'NONE' };
}

// ---- 通知キュー管理（§10）----
function admin_listNotifications(){ requireRole_([]);
  const ctrWorks = contractWorksMap_();
  return readRows_(ssOps_(),'Notification_Queue')
    .filter(function(n){ return n.status === 'MANUAL_REQUIRED'; })
    .map(function(n){ return { notification_id:n.notification_id, contract_id:n.contract_id,
      work:contractWorkLabel_(ctrWorks, n.contract_id), type:n.type,
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
  if(['PRIVACY','TERMS'].indexOf(documentType) < 0) throw new Error('VALIDATION_ERROR: 文書種別は PRIVACY / TERMS');
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

/** 送信失敗した計算書を手動で再送可能に戻す（CloudSign側の書類有無を確認してから実行すること） */
function admin_retryStatementSend(statementId){
  const actor = requireRole_(['ACCOUNTING']);
  const st = readRows_(ssOps_(),'Settlement_Statements').find(function(x){ return x.statement_id === statementId; });
  if(!st) throw new Error('DATA_NOT_FOUND: 計算書が見つかりません');
  if(st.status !== 'SEND_FAILED') throw new Error('DATA_CONFLICT: SEND_FAILED のみ再送に戻せます（現在: ' + st.status + '）');
  updateRow_(ssOps_(),'Settlement_Statements','statement_id',statementId,{ status:'APPROVED', send_error:'' });
  logEvent_('settlement_statement', statementId, actor.email, {status:'SEND_FAILED'}, {status:'APPROVED', retry:true});
  return true;
}

// ============================================================
// CloudSign例外対応（経理設計書 §10.5/§10.8〜10.11/§12.6）
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
/** 条件不一致の手動確認（LEGAL_ADMIN）。確認後に認証・バッジ・請求を実行（§10.8）。 */
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
  appendRow_(ssOps_(),'Applications',{ application_id:newId, application_ref:newRef,
    usage_category:old.usage_category, privacy_hash:old.privacy_hash, terms_hash:old.terms_hash,
    handoff_expires_at:handoffExpires, status:'FORM_PENDING', created_at:new Date().toISOString(),
    cloudsign_send_status:'MANUAL_SEND_REQUIRED',
    manual_review_reason:sanitizeCell_('再申込（訂正）: ' + reason),
    supersedes_application_id: old.application_id });
  works.forEach(function(w){ appendRow_(ssOps_(),'Application_Works',{
    application_work_id:newId_('AW'), application_id:newId, work_id:w.work_id }); });
  updateRow_(ssOps_(),'Applications','application_id',old.application_id,
    { status:'SUPERSEDED', superseded_by_application_id:newId, cloudsign_send_status:'CANCELLED' });
  // 旧申込に送信済みCloudSign書類があれば取消扱いを記録（§10.10）
  const oldContract = readRows_(ssOps_(),'Contracts').find(function(c){ return c.application_id === old.application_id; });
  if(oldContract) logEvent_('contract', oldContract.contract_id, actor.email, null,
    { note:'再申込により旧契約書類の取消/失効を要手続き', superseded_by_application:newId });
  const workIds = works.map(function(w){ return w.work_id; });
  const handoff = makeHandoffToken_(newId, newRef, workIds, old.usage_category, old.terms_hash, handoffExpires);
  logEvent_('application', newId, actor.email, null,
    { replacement_of: old.application_id, reason:String(reason), application_ref:newRef });
  return { application_id:newId, application_ref:newRef, handoff_token:handoff,
    form_url: routeFormUrl_(decideContractRoute_({ usageCategory: old.usage_category, workIds: workIds }).route) };
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
