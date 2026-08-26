/** GAS① 公開ポータル エントリ（SEC-01：管理機能・Webhook・トークン処理を含まない） */
function doGet(e){
  const base = HtmlService.createHtmlOutputFromFile('index').getContent();
  const patch = HtmlService.createHtmlOutputFromFile('portal_contract_v4_patch').getContent();
  const html = base.indexOf('</body>') >= 0 ? base.replace('</body>', patch + '\n</body>') : (base + patch);
  return HtmlService.createHtmlOutput(html).setTitle('SPLL 利用申込窓口');
}

/**
 * 公開Web（Cloud Run）からのデータ取得口。
 *
 * 画面をGASの外へ出すと google.script.run が使えないため、限られた関数だけをJSONで呼べるようにする。
 * ここは匿名で到達できるURLなので、次の3つで守る。
 *   1. 許可リスト：ここに書いた関数以外は名前が一致しても呼ばない（admin_/setup_/web_以外は届かない）
 *   2. 共有鍵：PUBLIC_WEB_KEY と一致しないリクエストは処理しない（未設定なら常に拒否＝フェイルクローズ）
 *   3. 呼び出し回数：申込作成は元関数側の rateLimit_ でも上限がかかる
 * 応答は必ず {ok:boolean, ...} 形式にし、GASの例外文言をそのまま外へ出さない。
 */
function publicWebRpcHandlers_(){
  // 名前から関数を引く（グローバルからの動的解決はしない）。ここに無い名前は呼べない。
  return {
    api_listWorks:           function(){ return api_listWorks(); },
    api_getUsageOptions:     function(){ return api_getUsageOptions(); },
    api_previewFeeTerms:     function(usageCategory, workCount){ return api_previewFeeTerms(usageCategory, workCount); },
    api_getLegalTexts:       function(){ return api_getLegalTexts(); },
    api_getLegalTextsV4:     function(){ return api_getLegalTextsV4(); },
    api_getApplyConfig:      function(){ return api_getApplyConfig(); },
    web_createApplicationV4: function(params){ return web_createApplicationV4(params); }
  };
}

function rpcJson_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 鍵の比較。長さと内容の両方をハッシュで突き合わせ、前方一致で漏らさない。 */
function rpcKeyMatches_(given){
  var expected = String(PropertiesService.getScriptProperties().getProperty('PUBLIC_WEB_KEY') || '');
  if(!expected) return false;                       // 未設定は常に拒否
  if(String(given || '').length !== expected.length) return false;
  return hash_(String(given || '')) === hash_(expected);
}

function doPost(e){
  var payload = {};
  try{ payload = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch(err){ return rpcJson_({ ok:false, error:'リクエストを解釈できませんでした' }); }

  if(!rpcKeyMatches_(payload.key)){
    recordRejectedAggregate_('portal-rpc-key', String(payload.fn || ''));
    return rpcJson_({ ok:false, error:'この操作は許可されていません' });
  }

  var handlers = publicWebRpcHandlers_();
  var fn = String(payload.fn || '');
  if(!Object.prototype.hasOwnProperty.call(handlers, fn))
    return rpcJson_({ ok:false, error:'この操作は許可されていません' });

  var args = Object.prototype.toString.call(payload.args) === '[object Array]' ? payload.args : [];
  try{
    var result = handlers[fn].apply(null, args);
    return rpcJson_({ ok:true, result: result === undefined ? null : result });
  }catch(err){
    // 申込の拒否理由（法人お断り・原作の非公開・同意の版ずれ）は利用者への案内なので返す
    return rpcJson_({ ok:false, error: String((err && err.message) || err) });
  }
}
