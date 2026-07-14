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
    manual_review_reason:'', next_retry_at:'' });
  // 同期で業務処理を試行（排他確保つき）。失敗しても受信は記録済み → バッチが再試行。
  return ContentService.createTextOutput(processReceiptRow_(receiptId, provider, body));
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

  if(linked){
    snapshotContractWorks_(contractId, app.application_id);
    snapshotContractTerms_(contractId, app);
    updateRow_(ssOps_(),'Applications','application_id',app.application_id,{ status:'SIGNED' });
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
  const map  = parseJson_(prop_('FORMRUN_FIELD_MAP'), {});
  const canon = {};
  (body.columns || []).forEach(function(c){ const k = map[c.name || c.label]; if(k) canon[k] = c.value; });
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
  // 逆行禁止：FORM_PENDING/APPLICATION_CREATED からのみ前進
  if(app.status === 'APPLICATION_CREATED' || app.status === 'FORM_PENDING'){
    updateRow_(ssOps_(),'Applications','application_id',app.application_id,{ status:'CONTRACT_PENDING' });
    logEvent_('application', app.application_id, 'formrun', {status:app.status}, { status:'CONTRACT_PENDING', application_ref:ref });
  }
  return 'ok';
}
