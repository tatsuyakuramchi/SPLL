/** GAS② 契約・提出・Webhook エントリ（SEC-01） */
function doGet(e){
  const page = (e && e.parameter && e.parameter.page) || '';
  if(page === 'upload') return serveUpload_(e);
  if(page === 'guide')  return serveGuide_(e);
  if(page === 'badge')  return serveBadge_(e);
  if(page === 'verify') return serveVerify_(e);
  return htmlPage_('SPLL', '<h2>SPLL 業務システム</h2><p>このURLは提出・報告・検証用の専用リンクからご利用ください。</p>');
}

/**
 * 公開Web（Cloud Run）からのデータ取得口。
 * Webhook受信と同じURLに同居するため、`?rpc=1` が付いたPOSTだけをこちらへ振り分ける。
 * 守り方はGAS①と同じ（許可リスト＋共有鍵＋フェイルクローズ）。
 * 提出・案内・検証はトークン／照合コードで守られており、その検証は各関数の中で行う。
 */
function workflowRpcHandlers_(){
  return {
    web_getSubmitContext:        function(token){ return web_getSubmitContext(token); },
    web_submitWork:              function(token, data){ return web_submitWork(token, data); },
    web_openDriveSubmission:     function(token, data){ return web_openDriveSubmission(token, data); },
    web_finalizeDriveSubmission: function(token, versionId){ return web_finalizeDriveSubmission(token, versionId); },
    web_getGuideContext:         function(token){ return web_getGuideContext(token); },
    web_getSubmitLinkFromGuide:  function(token){ return web_getSubmitLinkFromGuide(token); },
    web_verifyCertificate:       function(certId, code){ return web_verifyCertificate(certId, code); },
    web_getBadgeContext:         function(token){ return web_getBadgeContext(token); },
    web_getBadgeImage:           function(token, size){ return web_getBadgeImage(token, size); }
  };
}

function workflowRpcJson_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function workflowRpcKeyMatches_(given){
  var expected = String(PropertiesService.getScriptProperties().getProperty('PUBLIC_WEB_KEY') || '');
  if(!expected) return false;                       // 未設定は常に拒否
  if(String(given || '').length !== expected.length) return false;
  return hash_(String(given || '')) === hash_(expected);
}
function handleWorkflowRpc_(e){
  var payload = {};
  try{ payload = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch(err){ return workflowRpcJson_({ ok:false, error:'リクエストを解釈できませんでした' }); }

  if(!workflowRpcKeyMatches_(payload.key)){
    recordRejectedAggregate_('workflow-rpc-key', String(payload.fn || ''));
    return workflowRpcJson_({ ok:false, error:'この操作は許可されていません' });
  }
  var handlers = workflowRpcHandlers_();
  var fn = String(payload.fn || '');
  if(!Object.prototype.hasOwnProperty.call(handlers, fn))
    return workflowRpcJson_({ ok:false, error:'この操作は許可されていません' });

  var args = Object.prototype.toString.call(payload.args) === '[object Array]' ? payload.args : [];
  try{
    var result = handlers[fn].apply(null, args);
    return workflowRpcJson_({ ok:true, result: result === undefined ? null : result });
  }catch(err){
    // 期限切れ・上限超過などは利用者への案内なのでそのまま返す
    return workflowRpcJson_({ ok:false, error: String((err && err.message) || err) });
  }
}

function doPost(e){
  const param = (e && e.parameter) || {};
  if(String(param.rpc || '') === '1') return handleWorkflowRpc_(e);
  const hook = param.hook || '';
  return receiveWebhook_(hook === 'formrun' ? 'FORMRUN' : 'CLOUDSIGN', e);
}
