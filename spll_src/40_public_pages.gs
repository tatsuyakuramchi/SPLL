/** SPLL 40_public_pages ― GAS② 利用者向けページ：提出・利用報告・バッジDL・検証ポータル */


// ============================================================
// 5. 利用報告ページ（D-13・トークンアクセス）
// ============================================================
function serveReport_(e){
  const t = HtmlService.createTemplateFromFile('report');
  t.token = (e.parameter && e.parameter.token) || '';
  return t.evaluate().setTitle('SPLL 利用報告');
}
/** クライアントから google.script.run で呼ぶ：契約情報の取得（REPORT用途トークン） */
function report_getContext(token){
  const tok = resolveToken_(token, 'REPORT');
  if(!tok) throw new Error('報告用リンクが無効か、有効期限が切れています。');
  const c = readRows_(ssOps_(),'Contracts').find(x=>x.contract_id===tok.contract_id) || {};
  let fee = ''; try{ fee = JSON.parse(c.terms_snapshot||'{}').fee_amount_or_rate || ''; }catch(e){}
  return { contract_id:c.contract_id||'', work:contractWorkNames_(c.contract_id).join('、'), fee:fee, period:currentPeriod_() };
}
/**
 * 利用報告の登録 → Usage_Reports（修正設計書 §11.1）。
 * サーバー側検証：数値が0以上／控除+返品が総売上以下／URLはhttp(s)／同一契約・期間・チャネルの重複拒否。
 */
function report_submit(token, data){
  const tok = resolveToken_(token, 'REPORT');
  if(!tok) throw new Error('報告用リンクが無効か、有効期限が切れています。');
  data = data || {};
  const gross = num_(data.gross), returns = num_(data.returns), deductions = num_(data.deductions), qty = num_(data.qty);
  if(gross < 0 || returns < 0 || deductions < 0 || qty < 0) throw new Error('VALIDATION_ERROR: 数量・金額は0以上で入力してください。');
  if(returns + deductions > gross) throw new Error('VALIDATION_ERROR: 返品と控除の合計が総売上を超えています。');
  const url = String(data.url||'');
  if(url && !/^https?:\/\//i.test(url)) throw new Error('VALIDATION_ERROR: 証憑URLは http(s):// で始まる必要があります。');
  const period = String(data.period||''), channel = String(data.channel||'');
  const dup = readRows_(ssOps_(),'Usage_Reports').find(function(r){
    return r.contract_id === tok.contract_id && String(r.period) === period && String(r.channel) === channel &&
      r.status !== 'RETURNED' && r.status !== 'SUPERSEDED'; });
  if(dup) throw new Error('VALIDATION_ERROR: 同じ期間・チャネルの報告が既に提出されています（訂正は事務局へ）。');
  const reportId = newId_('RPT');
  const net = Math.max(0, gross - returns - deductions);
  appendRow_(ssOps_(),'Usage_Reports',{ report_id:reportId, contract_id:tok.contract_id,
    period:sanitizeCell_(period), channel:sanitizeCell_(channel), qty:qty, gross_sales:gross,
    returns:returns, deductions:deductions, net_sales:net, sales_url:sanitizeCell_(url),
    status:'SUBMITTED', submitted_at:new Date().toISOString() });
  consumeToken_(tok);
  logEvent_('usage_report', reportId, 'licensee', null, {status:'SUBMITTED'});
  return reportId;
}

// ============================================================
// 5.1 作品提出ページ（?page=upload&t=トークン）
//     受付番号のみのアクセスは不可。Access_Tokens（SUBMISSION用途）のトークンで認証。
//     再提出は新Submissionではなく同一Submission配下の版(Version)として管理。
// ============================================================
function serveUpload_(e){
  const t = HtmlService.createTemplateFromFile('upload');
  t.token = (e.parameter && (e.parameter.t || e.parameter.token)) || '';
  return t.evaluate().setTitle('SPLL 作品提出');
}

/** 提出ページのコンテキスト：契約番号・対象原作・既存提出（版履歴）・認証状態・バッジ取得URL */
function web_getSubmitContext(token){
  const tok = resolveToken_(token, 'SUBMISSION');
  if(!tok) throw new Error('提出用リンクが無効か、有効期限が切れています。');
  const contractId = tok.contract_id;
  const versions = readRows_(ssOps_(),'Submission_Versions');
  const subs = readRows_(ssOps_(),'Submissions').filter(s => s.contract_id===contractId).map(function(s){
    const vs = versions.filter(v => v.submission_id===s.submission_id)
      .sort(function(a,b){ return num_(a.version_no)-num_(b.version_no); })
      .map(function(v){ return { version_no:v.version_no, status:v.status, submitted_at:String(v.submitted_at||'') }; });
    return { submission_id:s.submission_id, title:s.title, status:s.status, versions:vs };
  });
  // バッジ取得導線（FUN-03）：発行済みならBADGE_DOWNLOADトークンを払い出してURLを返す
  let badgeUrl = '';
  const badge = readRows_(ssOps_(),'Badges').find(function(b){ return b.contract_id === contractId && String(b.status) === 'ISSUED'; });
  if(badge){
    revokeTokens_(contractId, 'BADGE_DOWNLOAD');
    const bt = issueToken_(contractId, 'BADGE_DOWNLOAD', 90, 20);
    let base = ''; try{ base = ScriptApp.getService().getUrl() || ''; }catch(e){}
    badgeUrl = (base||'') + '?page=badge&token=' + bt;
  }
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  const remaining = Math.max(0, num_(tok.max_uses) - num_(tok.used_count));
  return { contract_id:contractId, works:contractWorkNames_(contractId), submissions:subs,
    badge_url:badgeUrl, cert_status:(cert ? cert.status : 'NONE'),
    expires_at:String(tok.expires_at||'').slice(0,10), remaining_uploads:remaining };
}

/** アップロードのサーバー側検証（修正設計書 SEC-05/§6.3）：サイズ・拡張子・MIME・マジックバイト */
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const UPLOAD_TYPES = {
  pdf:  { mimes:['application/pdf'], magic:function(b){ return b.length>4 && b[0]===0x25 && b[1]===0x50 && b[2]===0x44 && b[3]===0x46; } },   // %PDF
  png:  { mimes:['image/png'],       magic:function(b){ return b.length>8 && (b[0]&255)===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47; } },
  jpg:  { mimes:['image/jpeg'],      magic:function(b){ return b.length>3 && (b[0]&255)===0xFF && (b[1]&255)===0xD8 && (b[2]&255)===0xFF; } },
  jpeg: { mimes:['image/jpeg'],      magic:function(b){ return b.length>3 && (b[0]&255)===0xFF && (b[1]&255)===0xD8 && (b[2]&255)===0xFF; } }
};
function validateUpload_(data){
  const name = String(data.filename||'file').split(/[\/\\]/).pop().replace(/[\x00-\x1f<>:"|?*]/g,'_').slice(0,120);
  const ext = (name.lastIndexOf('.')>=0 ? name.slice(name.lastIndexOf('.')+1) : '').toLowerCase();
  const rule = UPLOAD_TYPES[ext];
  if(!rule) throw new Error('VALIDATION_ERROR: 許可されていないファイル形式です（PDF・PNG・JPEGのみ）: ' + ext);
  let bytes;
  try{ bytes = Utilities.base64Decode(data.dataBase64); }catch(e){ throw new Error('VALIDATION_ERROR: ファイルデータを読み取れません。'); }
  if(!bytes || !bytes.length) throw new Error('VALIDATION_ERROR: 空のファイルは提出できません。');
  if(bytes.length > UPLOAD_MAX_BYTES) throw new Error('VALIDATION_ERROR: ファイルが20MBを超えています（' + Math.round(bytes.length/1024/1024) + 'MB）。');
  const mime = String(data.mimeType||'').toLowerCase();
  if(mime && rule.mimes.indexOf(mime) < 0) throw new Error('VALIDATION_ERROR: MIMEタイプが拡張子と一致しません: ' + mime);
  const head = []; for(var i=0;i<Math.min(16,bytes.length);i++){ var v=bytes[i]; head.push(v<0 ? v+256 : v); }
  if(!rule.magic(head)) throw new Error('VALIDATION_ERROR: ファイル内容が形式と一致しません（先頭シグネチャ不一致）。');
  return { bytes:bytes, name:name, mime:rule.mimes[0] };
}

/**
 * 作品提出（新規 or 再提出）。data:
 *   { submission_id?（再提出時）, title, filename, mimeType, dataBase64, note }
 * 新規は Submission＋v1、再提出は既存Submission配下に新しい版を追加。
 * 保存先: 契約フォルダ/02_Submissions/SUB-xxx/vN/。AI審査を起票して返す。
 */
function web_submitWork(token, data){
  const tok = resolveToken_(token, 'SUBMISSION');
  if(!tok) throw new Error('提出用リンクが無効か、有効期限が切れているか、提出回数の上限に達しています。');
  data = data || {};
  if(!data.dataBase64) throw new Error('作品ファイルが添付されていません。');
  const checked = validateUpload_(data);                       // サーバー側検証（SEC-05）
  const contractId = tok.contract_id;
  const contract = readRows_(ssOps_(),'Contracts').find(x => x.contract_id===contractId) || {};

  // 提出（新規 or 既存）
  let submissionId = data.submission_id || '';
  let sub = submissionId ? readRows_(ssOps_(),'Submissions').find(s => s.submission_id===submissionId) : null;
  if(sub && sub.contract_id !== contractId) throw new Error('この提出は対象の契約に属していません。');
  const now = new Date().toISOString();
  if(!sub){
    submissionId = newId_('SUB');
    appendRow_(ssOps_(),'Submissions',{ submission_id:submissionId, contract_id:contractId,
      title:data.title||'', status:'SUBMITTED', submitted_at:now });
    logEvent_('submission', submissionId, 'licensee', null, {status:'SUBMITTED', contract_id:contractId});
  }else{
    updateRow_(ssOps_(),'Submissions','submission_id',submissionId,{ status:'SUBMITTED' });
    if(data.title) updateRow_(ssOps_(),'Submissions','submission_id',submissionId,{ title:data.title });
  }

  // 版（version_no = 既存最大+1）
  const existingVers = readRows_(ssOps_(),'Submission_Versions').filter(v => v.submission_id===submissionId);
  const versionNo = existingVers.reduce(function(m,v){ return Math.max(m, num_(v.version_no)); }, 0) + 1;
  const versionId = newId_('SV');
  appendRow_(ssOps_(),'Submission_Versions',{ version_id:versionId, submission_id:submissionId,
    version_no:versionNo, status:'SUBMITTED', submitted_at:now });

  // Driveへ保存（契約フォルダ/02_Submissions/SUB/vN）。検証済みの実体・正規化名・MIMEを使用。
  const blob = Utilities.newBlob(checked.bytes, checked.mime, checked.name);
  const subRoot = getOrCreateChildFolder_(contractSubFolder_(contract,'02_Submissions'), submissionId);
  const verFolder = subRoot.createFolder('v'+versionNo);
  const file = verFolder.createFile(blob);
  appendRow_(ssOps_(),'Submission_Files',{ submission_file_id:newId_('SBF'), version_id:versionId,
    drive_file_id:file.getId(), mime_type:checked.mime, size:checked.bytes.length, sha256:sha256Bytes_(checked.bytes),
    original_filename:sanitizeCell_(String(data.filename||'').slice(0,200)), magic_valid:'true' });
  consumeToken_(tok);                                          // 提出回数を消費（SEC-06）

  // AI一次審査を起票（→人手審査必須）
  const aiId = enqueueAiReview_(submissionId, versionId);
  logEvent_('submission', submissionId, 'licensee', null, {version_no:versionNo, ai_review_id:aiId});
  return { submission_id:submissionId, version_no:versionNo, ai_review_id:aiId };
}

/** バッジDLページ（BADGE_DOWNLOADトークン）：3サイズのプレビューとダウンロードリンク */
function serveBadge_(e){
  const token = (e.parameter && e.parameter.token) || '';
  const tok = resolveToken_(token, 'BADGE_DOWNLOAD');
  const b = tok ? readRows_(ssOps_(),'Badges').find(function(x){ return x.contract_id === tok.contract_id && String(x.status) === 'ISSUED'; }) : null;
  if(!b) return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">リンクが無効か、有効期限が切れています。</p>').setTitle('SPLL 認証バッジ');
  consumeToken_(tok);
  const workNames = contractWorkNames_(b.contract_id).join('、');   // 契約単位（複数原作）
  const rows = [['大 (L)', b.png_l], ['中 (M)', b.png_m], ['小 (S)', b.png_s]].map(function(p){
    const view = 'https://drive.google.com/uc?id=' + p[1];
    const dl   = 'https://drive.google.com/uc?export=download&id=' + p[1];
    return '<div style="margin:18px 0"><div style="font-weight:600;margin-bottom:6px">' + p[0] + '</div>' +
      '<img src="' + view + '" style="max-width:100%;border:1px solid #ccc;border-radius:8px"><br>' +
      '<a href="' + dl + '" style="display:inline-block;margin-top:6px">PNGをダウンロード</a></div>';
  }).join('');
  const html = '<div style="font-family:sans-serif;max-width:720px;margin:0 auto;padding:24px">' +
    '<h2>SPLL 認証バッジ</h2><p>' + esc_(workNames) + ' ／ ライセンスID: ' + b.contract_id +
    ' ／ 発行日: ' + b.issued_at + '</p>' + rows +
    '<p style="font-size:12px;color:#666">クレジット表記としてご利用ください。表示位置・改変の可否は利用規約に従います。</p></div>';
  return HtmlService.createHtmlOutput(html).setTitle('SPLL 認証バッジ');
}

/** 検証ポータル（?page=verify）。id+照合コード（ハッシュ照合・§13.2）で認証状態を表示。 */
function serveVerify_(e){
  const p = e.parameter || {};
  if(!p.id) return verifyInputHtml_();
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.cert_id === p.id; });
  const codeOk = cert && cert.check_code_hash && String(cert.check_code_hash) === hash_(String(p.c||''));
  if(!cert || !codeOk){
    logEvent_('certificate', String(p.id||''), 'public', null, { verify:'MISMATCH' });   // 照会ログ（総当たり検知用）
    return verifyHtml_('gray', '確認できません', '正規に発行された認証ではないか、照合コードが一致しません。', '');
  }
  const works = contractWorkNames_(cert.contract_id);
  const meta = '対象原作：' + (works.length ? esc_(works.join('、')) : '—') +
    '<br>ライセンスID：' + esc_(cert.contract_id) + '<br>発行日：' + esc_(cert.issued_at) +
    '<br>状態：' + esc_(cert.status);
  return cert.status === 'ACTIVE'
    ? verifyHtml_('ok', '正規ライセンス 確認済み', 'このライセンスは有効です。', meta)
    : verifyHtml_('ng', '無効', 'このライセンスは現在有効ではありません（' + esc_(cert.status) + '）。', meta);
}

function verifyInputHtml_(){
  return htmlPage_('SPLL ライセンス認証', '<h2>SPLL ライセンス認証</h2>' +
    '<p>認証バッジのQRから開くと、正規ライセンスかどうかを確認できます。</p>' +
    '<form method="get"><input type="hidden" name="page" value="verify">' +
    '<p>ライセンスID <input name="id" placeholder="CTR-…"> 照合コード <input name="c" placeholder="XXXXXX"></p>' +
    '<button type="submit">確認する</button></form>');
}
function verifyHtml_(kind, title, msg, meta){
  const color = kind==='ok' ? '#2F7D5B' : (kind==='ng' ? '#A6342F' : '#8A8496');
  const icon  = kind==='ok' ? '✓' : (kind==='ng' ? '!' : '?');
  return htmlPage_('SPLL ライセンス認証',
    '<div style="text-align:center;margin:24px 0">' +
    '<div style="width:64px;height:64px;border-radius:50%;background:' + color + ';color:#fff;font-size:32px;display:inline-flex;align-items:center;justify-content:center">' + icon + '</div>' +
    '<h2 style="color:' + color + '">' + esc_(title) + '</h2><p>' + esc_(msg) + '</p>' +
    (meta ? '<div style="border:1px solid #ddd;border-radius:10px;padding:12px;max-width:360px;margin:0 auto;text-align:left;font-size:13px">' + meta + '</div>' : '') +
    '</div>');
}
