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
  const sigValid = verifyWebhookKey_(provider, key);
  const phash = hash_(raw || 'empty');
  if(!sigValid && isProd_()){
    appendRow_(ssOps_(),'Webhook_Receipts',{ receipt_id:Utilities.getUuid(), provider:provider,
      external_event_id:'', payload_hash:phash, payload_json:'', signature_valid:'false',
      received_at:new Date().toISOString(), status:'REJECTED', retry_count:0, last_error:'共有秘密の不一致または未設定', processed_at:'' });
    logError_('AUTHENTICATION_ERROR','webhook:'+provider,'署名検証に失敗（production・受信拒否）');
    return ContentService.createTextOutput('rejected');
  }
  const body = parseWebhookBody_(raw, e);
  const extId = provider === 'CLOUDSIGN'
    ? String(body.documentID || body.document_id || body.id || '')
    : String(body.sequence_number || body.id || '');
  // 冪等：同一payloadの再送は処理しない（同一docの別イベントは通す→業務処理側で冪等化）
  const dup = readRows_(ssOps_(),'Webhook_Receipts').find(function(r){ return r.payload_hash === phash && r.status === 'PROCESSED'; });
  if(dup) return ContentService.createTextOutput('dup');
  const receiptId = Utilities.getUuid();
  appendRow_(ssOps_(),'Webhook_Receipts',{ receipt_id:receiptId, provider:provider,
    external_event_id:extId, payload_hash:phash, payload_json:sanitizeCell_(String(raw).slice(0,45000)),
    signature_valid:String(sigValid), received_at:new Date().toISOString(), status:'RECEIVED', retry_count:0, last_error:'', processed_at:'' });
  // 同期で業務処理を試行。失敗しても受信は記録済み → processWebhookReceipts_ が再試行。
  try{
    const ack = processWebhookEvent_(provider, body, e);
    updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',receiptId,{ status:'PROCESSED', processed_at:new Date().toISOString() });
    return ContentService.createTextOutput(ack || 'ok');
  }catch(err){
    updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',receiptId,{ status:'ERROR', last_error:String(err && err.message || err).slice(0,300) });
    logError_('PROCESSING_ERROR','webhook:'+provider, err, { external_event_id:extId });
    return ContentService.createTextOutput('accepted');   // 受信自体は成功（再試行で回復）
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
/** 未処理・エラーのWebhookを再処理（時間主導トリガー） */
function processWebhookReceipts_(){
  const rows = readRows_(ssOps_(),'Webhook_Receipts')
    .filter(function(r){ return (r.status==='RECEIVED' || r.status==='ERROR') && num_(r.retry_count) < 5; });
  let done = 0;
  rows.forEach(function(r){
    try{
      const body = parseWebhookBody_(String(r.payload_json||'').replace(/^'/,''), null);
      processWebhookEvent_(r.provider, body, null);
      updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',r.receipt_id,{ status:'PROCESSED', processed_at:new Date().toISOString() });
      done++;
    }catch(err){
      updateRow_(ssOps_(),'Webhook_Receipts','receipt_id',r.receipt_id,
        { status:'ERROR', retry_count:num_(r.retry_count)+1, last_error:String(err && err.message || err).slice(0,300) });
    }
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
  // 突合不能：締結は記録するが、認証・バッジ・提出トークンは手動紐付けまで保留（§5.3-7）
  logEvent_('contract', contractId, 'cloudsign', null,
    { status:'SIGNED', link_status:'UNLINKED', reason:(ref ? 'app-not-found' : 'no-ref'), application_ref:ref||'' });
  return 'ok-unlinked';
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
  // 逆行禁止：FORM_PENDING/APPLICATION_CREATED からのみ前進
  if(app.status === 'APPLICATION_CREATED' || app.status === 'FORM_PENDING'){
    updateRow_(ssOps_(),'Applications','application_id',app.application_id,{ status:'CONTRACT_PENDING' });
    logEvent_('application', app.application_id, 'formrun', {status:app.status}, { status:'CONTRACT_PENDING', application_ref:ref });
  }
  return 'ok';
}
