/** SPLL 35_webhooks ― GAS② Webhook受信（修正設計書 §5）：検証・受信記録・業務処理 */


// ============================================================
// Webhook受信（修正設計書 §5）：検証→受信記録（Webhook_Receipts）→業務処理→PROCESSED/ERROR
//   GASのdoPostはHTTPヘッダを受け取れないため、署名はURL共有秘密（?key=）方式＋
//   CloudSignはAPI照会（受信payloadだけで契約を作成しない）で真正性を担保する。
//   production：共有秘密未設定・不一致は受信拒否（フェイルクローズ）。
// ============================================================
function receiveWebhook_(provider, e){
  const raw = (e && e.postData && e.postData.contents) || '';
  const key = (e && e.parameter && (e.parameter.key || e.parameter.sig || e.parameter.signature)) || '';
  // 受信レート制限（V2-007-1）
  if(!rateLimit_('wh:' + provider, 120, 300)){
    recordRejectedAggregate_(provider + ':rate', 'レート超過');
    return ContentService.createTextOutput('rejected');
  }
  const sigValid = verifyWebhookKey_(provider, key);
  const phash = hash_(raw || 'empty');
  if(!sigValid && isProd_()){
    // 署名不一致は1件ずつシートへ書かず集約（V2-007-2/§3.6）
    recordRejectedAggregate_(provider + ':sig', 'payload_hash=' + phash.slice(0,12));
    return ContentService.createTextOutput('rejected');
  }
  const body = parseWebhookBody_(raw, e);
  const extId = provider === 'CLOUDSIGN'
    ? String(body.documentID || body.document_id || body.id || '')
    : String(body.sequence_number || body.id || '');
  const idemKey = provider + ':' + (extId || phash);
  // 冪等：処理済み・処理中の同一イベントは受け流す（V2-007）
  const existing = readRows_(ssOps_(),'Webhook_Receipts').find(function(r){
    return r.idempotency_key === idemKey &&
      (r.status === 'PROCESSED' || r.status === 'PROCESSING' || r.status === 'MANUAL_REVIEW') &&
      (r.payload_hash === phash || r.status !== 'PROCESSED'); });
  if(existing) return ContentService.createTextOutput('dup');
  const receiptId = Utilities.getUuid();
  appendRow_(ssOps_(),'Webhook_Receipts',{ receipt_id:receiptId, provider:provider,
    external_event_id:extId, idempotency_key:idemKey, payload_hash:phash,
    payload_json:sanitizeCell_(String(raw).slice(0,45000)),
    signature_valid:String(sigValid), received_at:new Date().toISOString(), status:'RECEIVED',
    retry_count:0, last_error:'', processed_at:'', processing_started_at:'', processing_owner:'',
    manual_review_reason:'', next_retry_at:'',
    // 追跡列（経理設計書 §9.3）
    event_type: sanitizeCell_(String(body.event_type || body.status || body.event || '')),
    document_id: provider === 'CLOUDSIGN' ? extId : '',
    application_ref: sanitizeCell_(String(body.application_ref || refFromText_(String(raw).slice(0, 2000)) || '')),
    response_code: '' });
  // 同期で業務処理を試行（排他確保つき）。失敗しても受信は記録済み → バッチが再試行。
  // §10.6：受信保存に成功した時点で応答はHTTP 200（400番台を業務エラーの再送要求に使わない）
  const ack = processReceiptRow_(receiptId, provider, body);
  updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',receiptId,{ response_code: 200 });
  return ContentService.createTextOutput(ack);
}

/**
 * 受信行を排他確保（PROCESSING）して業務処理し、結果で状態を確定する（V2-007-3〜6）。
 *   'manual-review:理由' → MANUAL_REVIEW（バッチ再試行しない・管理画面で解消）
 *   例外 → RETRY_WAIT（バックオフ）／上限超過で DEAD_LETTER
 */
function processReceiptRow_(receiptId, provider, body){
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try{
    const row = readRows_(ssOps_(),'Webhook_Receipts').find(function(r){ return r.receipt_id === receiptId; });
    if(!row || (row.status !== 'RECEIVED' && row.status !== 'RETRY_WAIT')) return 'busy';
    updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',receiptId,
      { status:'PROCESSING', processing_started_at:new Date().toISOString(), processing_owner:Utilities.getUuid().slice(0,8) });
  }finally{ lock.releaseLock(); }
  try{
    const ack = processWebhookEvent_(provider, body, null) || 'ok';
    if(String(ack).indexOf('manual-review') === 0){
      updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',receiptId,
        { status:'MANUAL_REVIEW', manual_review_reason:String(ack).split(':')[1] || '', processed_at:'' });
      return 'accepted-manual-review';
    }
    updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',receiptId,{ status:'PROCESSED', processed_at:new Date().toISOString() });
    return ack;
  }catch(err){
    const row = readRows_(ssOps_(),'Webhook_Receipts').find(function(r){ return r.receipt_id === receiptId; }) || {};
    const retry = num_(row.retry_count) + 1;
    const dead = retry >= 5;
    const next = new Date(); next.setMinutes(next.getMinutes() + 5 * Math.pow(2, retry));   // バックオフ
    updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',receiptId,
      { status:(dead ? 'DEAD_LETTER' : 'RETRY_WAIT'), retry_count:retry,
        last_error:String(err && err.message || err).slice(0,300), next_retry_at:(dead ? '' : next.toISOString()) });
    logError_('PROCESSING_ERROR','webhook:'+provider, err, { receipt_id:receiptId, retry:retry, dead:dead });
    return 'accepted';
  }
}
/** 共有秘密の検証。未設定時：development=通す／production=拒否（呼び出し側で判断） */
function verifyWebhookKey_(provider, key){
  const secret = prop_(provider === 'FORMRUN' ? 'FORMRUN_WEBHOOK_SECRET' : 'CLOUDSIGN_WEBHOOK_KEY');
  if(!secret) return !isProd_();
  return String(key) === String(secret);
}
function parseWebhookBody_(raw, e){
  try{ return JSON.parse(raw); }catch(_){}
  // application/x-www-form-urlencoded で JSON が payload 値に入るケース
  try{
    const params = {}; String(raw).split('&').forEach(function(kv){ const i=kv.indexOf('='); if(i>=0) params[decodeURIComponent(kv.slice(0,i))]=decodeURIComponent(kv.slice(i+1).replace(/\+/g,' ')); });
    const cand = params.payload || params.body || params.data || (Object.keys(params)[0] && params[Object.keys(params)[0]]);
    return JSON.parse(cand);
  }catch(_){ return (e && e.parameter) || {}; }
}
function processWebhookEvent_(provider, body, e){
  return provider === 'FORMRUN' ? processFormrunEvent_(body) : processCloudSignEvent_(body, e);
}
/** 未処理・再試行待ちのWebhookを再処理（時間主導トリガー）。MANUAL_REVIEW／DEAD_LETTERは対象外。 */
function processWebhookReceipts_(){
  const now = new Date();
  const rows = readRows_(ssOps_(),'Webhook_Receipts').filter(function(r){
    if(r.status === 'RECEIVED') return true;
    if(r.status === 'RETRY_WAIT') return !r.next_retry_at || new Date(r.next_retry_at) <= now;
    return false;
  });
  let done = 0;
  rows.forEach(function(r){
    const body = parseWebhookBody_(String(r.payload_json||'').replace(/^'/,''), null);
    const ack = processReceiptRow_(r.receipt_id, r.provider, body);
    if(ack !== 'accepted' && ack !== 'busy') done++;
  });
  return { processed: rows.length, completed: done };
}

/**
 * CloudSign 締結完了イベントの業務処理（修正設計書 §5.3/§8.1）。
 * production では必ず CloudSign API 照会で締結完了を確認する（受信payloadだけで契約を作成しない）。
 * application_ref で申込に突合 → 契約＋対象原作/条件スナップショット＋締結PDF＋認証＋提出トークン。
 */
function processCloudSignEvent_(body, e){
  body = body || {};
  const docId = body.document_id || body.documentID || body.id || (e && e.parameter && e.parameter.documentID);
  const event = body.event_type || body.status || body.event;
  if(!docId) return 'no-docid';
  // メール不達イベント（経理設計書 §10.9）：契約の配達状態を更新し不達キューへ
  const bounce = csBounceStatus_(event);
  if(bounce){
    const c = readRows_(ssOps_(),'Contracts').find(function(x){ return String(x.cloudsign_document_id) === String(docId); });
    if(c){
      updateRow_(ssOps_(),'Contracts','contract_id',c.contract_id,
        { delivery_status: bounce, last_delivery_event_at: new Date().toISOString() });
      enqueueNotification_(c.contract_id, 'DELIVERY_FAILED', c.contract_id + ':' + bounce,
        { document_id: String(docId), delivery_status: bounce, action: '連絡先を確認し、CloudSignから再送してください（経理連携→CloudSign例外対応）' });
      logEvent_('contract', c.contract_id, 'cloudsign', null, { delivery_status: bounce });
      return 'ok-delivery';
    }
    logEvent_('webhook', String(docId), 'cloudsign', null, { delivery_status: bounce, note: '契約未登録の書類' });
    return 'ok-delivery-nocontract';
  }
  if(!cs_isCompletedEvent_(event)) return 'ignored';
  // 冪等：同一書類の契約が既にあれば処理しない
  if(readRows_(ssOps_(),'Contracts').some(function(c){ return String(c.cloudsign_document_id) === String(docId); })) return 'dup';

  // 真正性：API照会で締結完了を確認（SEC-03）。productionでは必須（照会不能なら例外→受信キューで再試行）。
  let verifiedDoc = null;
  if(prop_('CLOUDSIGN_CLIENT_ID')){
    verifiedDoc = cs_fetch_('GET', '/documents/' + encodeURIComponent(docId), null, {});
    if(!cs_isCompletedEvent_(verifiedDoc && verifiedDoc.status))
      throw new Error('CloudSign照会結果が締結完了ではありません（document=' + docId + ', status=' + (verifiedDoc && verifiedDoc.status) + '）');
  } else if(isProd_()){
    throw new Error('CloudSign資格情報が未設定のため締結を検証できません（production では payload のみでの契約作成を禁止）');
  }

  const ref = extractApplicationRef_(body, e) || refFromText_(JSON.stringify(verifiedDoc || {}));
  const app = ref ? readRows_(ssOps_(),'Applications').find(function(a){ return a.application_ref === ref; }) : null;
  // 契約の一意性（V2-007）：同一申込に有効な契約が既にあれば重複扱い
  if(app && readRows_(ssOps_(),'Contracts').some(function(c){ return c.application_id === app.application_id && c.status === 'SIGNED'; }))
    return 'dup';
  const linked = !!app;
  const contractId = newId_('CTR');
  appendRow_(ssOps_(),'Contracts',{ contract_id:contractId, cloudsign_document_id:docId,
    cloudsign_title: sanitizeCell_((verifiedDoc && (verifiedDoc.title || verifiedDoc.name)) || extractDocTitle_(body)),
    application_id: app ? app.application_id : '', application_ref: ref || '',
    status:'SIGNED', link_status: linked ? 'LINKED' : 'UNLINKED',
    signed_at:new Date().toISOString(), folder_id:createContractFolder_(contractId) });

  // 締結済原本PDFの保存（FUN-04）。失敗しても契約処理は継続（後で再取得可能）。
  try{ saveSignedPdf_(contractId, docId, verifiedDoc); }
  catch(err){ logError_('EXTERNAL_API_ERROR','saveSignedPdf', err, { contract_id:contractId, document_id:docId }); }

  // 契約者の連絡先：CloudSignが実際に契約書を送付した宛先を採用する（案内送付・不達対応の連絡先）。
  // 取れない場合はフォーム入力値（申込時）へフォールバックする。
  captureContactEmail_(contractId, verifiedDoc, app);

  if(linked){
    snapshotContractWorks_(contractId, app.application_id);
    snapshotContractTerms_(contractId, app);
    updateRow_(ssOps_(),'Applications','application_id',app.application_id,{ status:'SIGNED', cloudsign_send_status:'SIGNED' });
    updateRow_(ssOps_(),'Contracts','contract_id',contractId,{
      form_submission_id: app.form_submission_id || '', license_id: app.license_id || '',
      route_type: app.manual_review_reason ? 'MANUAL' : 'AUTO', delivery_status: 'DELIVERED' });
    // 条件照合（経理設計書 §10.8）：認証・バッジ・請求の前に主要条件を検証
    const verify = verifyContractTerms_(contractId, app);
    if(!verify.ok){
      updateRow_(ssOps_(),'Contracts','contract_id',contractId,{
        link_status:'TERMS_MISMATCH', terms_verification_status:'TERMS_MISMATCH',
        terms_verification_detail: sanitizeCell_(verify.detail.slice(0, 300)) });
      syncLicenseOnSigning_(contractId, app.license_id, 'HOLD');
      enqueueNotification_(contractId, 'TERMS_MISMATCH', contractId,
        { application_ref: ref, detail: verify.detail.slice(0, 200), action: '法務・運営が内容確認のうえ「条件確認済み」にしてください（自動有効化は停止中）' });
      logEvent_('contract', contractId, 'cloudsign', null,
        { status:'SIGNED', link_status:'TERMS_MISMATCH', detail: verify.detail.slice(0, 200) });
      return 'manual-review:条件不一致（' + verify.detail.slice(0, 100) + '）';
    }
    updateRow_(ssOps_(),'Contracts','contract_id',contractId,{ terms_verification_status:'VERIFIED' });
    syncLicenseOnSigning_(contractId, app.license_id, 'SIGNED');
    logEvent_('contract', contractId, 'cloudsign', null, { status:'SIGNED', link_status:'LINKED', application_ref:ref });
    finishContractLinkage_(contractId);
    return 'ok';
  }
  // 突合不能（V2-008）：締結は「未紐付け」で記録し、受信は成功扱いにせず手動確認キューへ
  const reason = ref ? 'application_refに対応する申込なし' : 'application_ref欠落';
  logEvent_('contract', contractId, 'cloudsign', null,
    { status:'SIGNED', link_status:'UNLINKED', reason:reason, application_ref:ref||'' });
  return 'manual-review:' + reason;
}

/**
 * FormRun申込イベントの業務処理（修正設計書 §5.4）。
 * application_ref を受け、申込を CONTRACT_PENDING へ前進（申込作成はポータル側）。
 * ステータスの逆行は禁止。ref無し・申込不明はエラー記録（受信キューで追跡可能）。
 */
function processFormrunEvent_(body){
  body = body || {};
  // 正規化はv4ガードと同一ロジックを使う（ガードは通るのに本処理でrefやhandoffを拾えない、を防ぐ）
  let canon;
  if(typeof formrunResolveV4_ === 'function'){
    canon = formrunResolveV4_(body).canon;      // 経路別の項目IDマップまで解決した正規化
  }else if(typeof formrunCanonV4_ === 'function'){
    canon = formrunCanonV4_(body);
  }else{
    const map = parseJson_(prop_('FORMRUN_FIELD_MAP'), {});
    canon = {};
    (body.columns || []).forEach(function(c){ const k = map[c.name || c.label]; if(k) canon[k] = c.value; });
  }
  const ref = canon.application_ref || refFromText_(JSON.stringify(body));
  if(!ref){
    logError_('VALIDATION_ERROR','formrun','application_ref がWebhookに含まれていません', { keys:Object.keys(body) });
    return 'no-ref';
  }
  const app = readRows_(ssOps_(),'Applications').find(function(a){ return a.application_ref === ref; });
  if(!app){
    logError_('DATA_NOT_FOUND','formrun','application_ref に対応する申込がありません: ' + ref);
    return 'app-not-found';
  }
  // 引継ぎ改変検知（handoff_token・フォーム項目設計 §4.1.1）。トークン付きなら検証。
  const handoff = canon.handoff_token || '';
  if(handoff || handoffSecret_()){
    const workIds = readRows_(ssOps_(),'Application_Works')
      .filter(function(x){ return x.application_id === app.application_id; }).map(function(x){ return x.work_id; });
    const v = verifyHandoffToken_(app, workIds, handoff);
    if(!v.ok){
      logError_('VALIDATION_ERROR','formrun:handoff', v.reason, { application_ref:ref });
      return 'manual-review:' + v.reason;
    }
  }
  // フォーム送信の記録（経理設計書 §10.4）：form submission ID・送信日時
  const submissionId = sanitizeCell_(String(body.submission_id || body.id || body.sequence_number || ''));
  const sendPatch = { form_submission_id: submissionId, form_submitted_at: new Date().toISOString() };
  // formrun→CloudSign連携失敗の検知：payload内のエラー通知は自動再送せず手動キューへ
  const csError = canon.cloudsign_error || body.cloudsign_error ||
    (String(body.cloudsign_status || '').toLowerCase() === 'error' ? 'cloudsign_status=error' : '');
  if(csError){
    sendPatch.cloudsign_send_status = 'CLOUDSIGN_SEND_FAILED';
    sendPatch.cloudsign_send_error = sanitizeCell_(String(csError).slice(0, 200));
    updateRow_(ssOps_(),'Applications','application_id',app.application_id, sendPatch);
    enqueueNotification_('', 'CLOUDSIGN_SEND_FAILED', app.application_id,
      { application_ref: ref, error: String(csError).slice(0, 200), action: '管理コンソール「契約管理」タブのCloudSign例外対応から手動送信してください' });
    logEvent_('application', app.application_id, 'formrun', {status: app.status},
      { cloudsign_send_status: 'CLOUDSIGN_SEND_FAILED', error: String(csError).slice(0, 200) });
    return 'ok-send-failed';
  }
  sendPatch.cloudsign_send_status = 'CLOUDSIGN_SENDING';
  // ライセンス台帳へ契約者情報を反映（RP-001 §8：フォームは「誰と契約するか」のみ取得）
  if(app.license_id){
    const partyName = canon.company_name || canon.party_name || canon.name || '';
    const rawType = String(canon.party_type || '');
    const casePatch = { case_status: 'CONTRACTING' };
    if(partyName) casePatch.party_display_name = sanitizeCell_(String(partyName).slice(0, 100));
    // フォームで取得したメールは暫定の連絡先（正は締結時のCloudSign送付先）
    const formMail = normalizeEmail_(canon.contact_email || canon.email || canon.mail || '');
    if(formMail) casePatch.contact_email = formMail;
    if(rawType) casePatch.party_type = /法人/.test(rawType) ? 'CORPORATION'
      : (/個人事業/.test(rawType) ? 'SOLE_PROPRIETOR' : (/個人/.test(rawType) ? 'INDIVIDUAL' : sanitizeCell_(rawType).slice(0, 20)));
    updateLicenseCase_(app.license_id, casePatch);
  }
  // 逆行禁止：FORM_PENDING/APPLICATION_CREATED からのみ前進
  if(app.status === 'APPLICATION_CREATED' || app.status === 'FORM_PENDING'){
    sendPatch.status = 'CONTRACT_PENDING';
    updateRow_(ssOps_(),'Applications','application_id',app.application_id, sendPatch);
    logEvent_('application', app.application_id, 'formrun', {status:app.status}, { status:'CONTRACT_PENDING', application_ref:ref });
  } else {
    updateRow_(ssOps_(),'Applications','application_id',app.application_id, sendPatch);
  }
  return 'ok';
}

// ============================================================
// CloudSign運用拡張ヘルパー（経理設計書 §10.8/§10.9/§10.4）
// ============================================================
/** 不達イベント名 → delivery_status（該当しなければ空文字）。 */
function csBounceStatus_(event){
  const ev = String(event || '').toLowerCase();
  if(!ev) return '';
  if(/signing.*bounce|bounce.*signing/.test(ev)) return 'SIGNING_EMAIL_BOUNCED';
  if(/completion.*bounce|bounce.*completion/.test(ev)) return 'COMPLETION_EMAIL_BOUNCED';
  if(/bounce|undeliver|delivery_failed|not_delivered/.test(ev)) return 'DELIVERY_FAILED';
  return '';
}
/**
 * 締結後の条件照合（§10.8）。認証・バッジ・請求の前に、台帳スナップショットと
 * 締結内容の主要条件（フォーム完了記録・対象原作・利用目的・料金モデル）を検証する。
 */
function verifyContractTerms_(contractId, app){
  const problems = [];
  // フォーム完了の整合：正規の引継ぎ（formrun Webhook通過）が記録されているか
  if(app.status !== 'CONTRACT_PENDING' && app.status !== 'SIGNED')
    problems.push('フォーム完了記録がありません（引継ぎ改変検知または未通過・status=' + app.status + '）');
  // 対象原作：申込とスナップショットの件数一致・1件以上
  const appWorks = readRows_(ssOps_(),'Application_Works').filter(function(x){ return x.application_id === app.application_id; });
  const cws = readRows_(ssOps_(),'Contract_Works').filter(function(x){ return x.contract_id === contractId; });
  if(!cws.length) problems.push('対象原作のスナップショットがありません');
  else if(appWorks.length !== cws.length) problems.push('対象原作の件数が申込と一致しません（申込' + appWorks.length + '/契約' + cws.length + '）');
  // 利用目的・料金モデル
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; }) || {};
  if(String(c.usage_category || '') !== String(app.usage_category || ''))
    problems.push('利用目的が申込と一致しません');
  let t = {}; try{ t = JSON.parse(c.terms_snapshot || '{}'); }catch(e){}
  if(!t.fee_model) problems.push('利用料条件（料金モデル）を確定できません');
  // CloudSign FORM v4：契約書へ差し込んだ個別条件が申込時スナップショットと一致することを確認
  if(/^v4:/.test(String(app.terms_hash || ''))){
    if(String(t.terms_snapshot_hash || '') !== String(app.terms_hash))
      problems.push('個別条件ハッシュが申込と一致しません');
    else if(String(t.terms_snapshot_hash_verified) === 'false')
      problems.push('契約個別条件をFormRun受信証跡から復元できず、再計算値が申込時と一致しません（出所: ' + (t.terms_snapshot_source||'?') + '）');
  }
  return problems.length ? { ok:false, detail:problems.join('／') } : { ok:true, detail:'' };
}
/**
 * CloudSign送信の停滞検知（§10.4/§10.5）：フォーム送信済みのまま既定日数を超えて
 * 締結に進まない申込を手動送信キュー（MANUAL_SEND_REQUIRED）へ。日次バッチから実行。
 */
function notifyCloudSignSendStale_(){
  const staleDays = num_(getConfig_('CS_SEND_STALE_DAYS','2')) || 2;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - staleDays);
  let n = 0;
  readRows_(ssOps_(),'Applications')
    .filter(function(a){ return ['FORM_SUBMITTED','CLOUDSIGN_SENDING'].indexOf(String(a.cloudsign_send_status)) >= 0 &&
      a.form_submitted_at && new Date(a.form_submitted_at) < cutoff &&
      ['SIGNED','CANCELLED','SUPERSEDED'].indexOf(String(a.status)) < 0; })
    .forEach(function(a){
      updateRow_(ssOps_(),'Applications','application_id',a.application_id,{ cloudsign_send_status:'MANUAL_SEND_REQUIRED' });
      if(enqueueNotification_('', 'CLOUDSIGN_SEND_FAILED', a.application_id,
        { application_ref: a.application_ref, error: 'フォーム送信から' + staleDays + '日以上CloudSign締結に進んでいません',
          action: '管理コンソール「契約管理」タブのCloudSign例外対応から状況確認・手動送信してください' })) n++;
    });
  return { processed: n };
}
