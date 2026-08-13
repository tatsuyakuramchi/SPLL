/** SPLL 30_cloudsign ― CloudSign APIクライアント（サンドボックス既定） */


// ============================================================
// 2. 申込 → Applications（B経路固定）
//    申込の作成は公開ポータルの web_createApplication（複数原作）で行う。
//    A経路（作品審査後に締結）は廃止したため、申込時の作品提出は存在しない。
// ============================================================
// 3. CloudSign API 送信・締結Webhook（D-11）
// ============================================================
// ---- 3.1 CloudSign クライアント（サンドボックス既定） ----
// ※ エンドポイント/ステータス値は CloudSign 公式 Web API ドキュメントで最新仕様を確認すること。
//   サンドボックス: https://api-sandbox.cloudsign.jp ／ 本番: https://api.cloudsign.jp
function cs_isSandbox_(){ return prop_('CLOUDSIGN_SANDBOX') !== 'false'; }   // 既定はサンドボックス
function cs_baseUrl_(){ return cs_isSandbox_() ? 'https://api-sandbox.cloudsign.jp' : 'https://api.cloudsign.jp'; }

/** アクセストークン取得（短期キャッシュ）。POST /token?client_id= */
function cloudSignAccessToken_(){
  const cache = CacheService.getScriptCache();
  const hit = cache.get('cs_token');
  if(hit) return hit;
  const clientId = prop_('CLOUDSIGN_CLIENT_ID');
  if(!clientId) throw new Error('CloudSign未設定：管理コンソール「設定」でClient IDを登録してください');
  const res = cs_fetch_('POST', '/token?client_id=' + encodeURIComponent(clientId), null, { auth:false });
  const token = res.access_token;
  if(!token) throw new Error('CloudSignトークン取得失敗: ' + JSON.stringify(res));
  const ttl = Math.max(60, Math.min((parseInt(res.expires_in||'3000',10) - 60), 21600)); // CacheServiceは最大6h
  cache.put('cs_token', token, ttl);
  return token;
}

/** CloudSign API 共通呼び出し。JSONを返す。opt.multipart=true でファイル送信。 */
function cs_fetch_(method, path, body, opt){
  opt = opt || {};
  const headers = {};
  if(opt.auth !== false) headers['Authorization'] = 'Bearer ' + cloudSignAccessToken_();
  const params = { method: method, muteHttpExceptions: true, headers: headers };
  if(body && opt.multipart){ params.payload = body; }                     // {field: Blob} → 自動でmultipart
  else if(body){ params.contentType = 'application/json'; params.payload = JSON.stringify(body); }
  const res  = UrlFetchApp.fetch(cs_baseUrl_() + path, params);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if(code < 200 || code >= 300) throw new Error('CloudSign ' + method + ' ' + path + ' → HTTP ' + code + ': ' + text);
  try{ return text ? JSON.parse(text) : {}; }catch(e){ return { raw: text }; }
}

// ---- 3.2 書類ライフサイクル ----
function cs_createDocument_(title, message){ return cs_fetch_('POST', '/documents', { title: title, message: message || '' }); }
function cs_attachFile_(docId, blob, filename){ return cs_fetch_('POST', '/documents/' + docId + '/files', { uploadfile: blob.setName(filename || 'document.pdf') }, { multipart:true }); }
function cs_attachFromTemplate_(docId, templateId){ return cs_fetch_('POST', '/documents/' + docId + '/files', { template_id: templateId }); }
function cs_addParticipant_(docId, email, name){ return cs_fetch_('POST', '/documents/' + docId + '/participants', { email: email, name: name || '', organization: '' }); }
function cs_sendDocument_(docId){ return cs_fetch_('POST', '/documents/' + docId + '/sent', {}); }
/**
 * 書類レスポンスから「CloudSignが実際に契約書を送付した宛先」を取り出す。
 *
 * 締結Webhookの body.email は、イベントを起こしたCloudSignアカウント（＝送信側）を指すため
 * 契約者の連絡先としては使えない。宛先は書類取得API（GET /documents/{id}）の participants に入る。
 * フィールド名・入れ子はプラン／版で揺れる可能性があるため、participants を優先しつつ
 * レスポンス全体からのメール抽出をフォールバックとして持つ。自社ドメインの宛先は除外する。
 */
function cs_recipientEmail_(doc){
  if(!doc) return '';
  const own = String(getConfig_('OFFICE_EMAIL_DOMAIN','') || '').toLowerCase();
  const isOwn = function(m){ return own && String(m).toLowerCase().indexOf('@' + own) >= 0; };
  const valid = function(m){ return /^[^@\s"'<>]+@[^@\s"'<>]+\.[^@\s"'<>]+$/.test(String(m||'')); };

  const parts = doc.participants || doc.Participants || [];
  const fromParts = [];
  (Array.isArray(parts) ? parts : []).forEach(function(p){
    const m = p && (p.email || p.mail || p.email_address || (p.user && p.user.email));
    if(valid(m) && !isOwn(m)) fromParts.push(String(m));
  });
  if(fromParts.length) return fromParts[0];

  // フォールバック：レスポンス全体から最初の妥当なメールを拾う（participants の形が想定と違う場合）
  let hit = '';
  try{
    const all = String(JSON.stringify(doc)).match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || [];
    for(let i=0;i<all.length;i++){ if(!isOwn(all[i])){ hit = all[i]; break; } }
  }catch(e){}
  return hit;
}

/**
 * CloudSignの「締結完了」イベントか。
 * 公式仕様：Webhookの status は 1=先方確認中 / 2=締結完了 / 3=取消・却下。
 * 締結完了は status===2（または text/イベント名の "COMPLETED"）。※ 3は取消なので締結ではない。
 */
function cs_isCompletedEvent_(s){
  s = String(s);
  return s==='2' || s==='COMPLETED' || s==='completed' || s==='signed' || s==='SIGNED';
}
