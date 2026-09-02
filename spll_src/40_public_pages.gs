/** SPLL 40_public_pages ― GAS② クリエーター向けページ：提出・バッジDL・検証ポータル */


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
  const reviews  = readRows_(ssOps_(),'Human_Reviews');
  const subs = readRows_(ssOps_(),'Submissions').filter(s => s.contract_id===contractId).map(function(s){
    const vs = versions.filter(v => v.submission_id===s.submission_id)
      .sort(function(a,b){ return num_(a.version_no)-num_(b.version_no); })
      .map(function(v){ return { version_no:v.version_no, status:v.status, submitted_at:String(v.submitted_at||''),
        method:v.submission_method || 'UPLOAD', folder_status:v.folder_status || '',
        version_id:(v.folder_status === 'OPEN' ? v.version_id : ''),   // 未確定の版だけ操作対象として返す
        folder_url:(v.folder_status === 'OPEN' ? ('https://drive.google.com/drive/folders/' + v.drive_folder_id) : '') }; });
    // 是正要求の内容をクリエーターへ提示（修正設計書 §17.2）。最新の人手審査が是正/上申の場合のみ。
    const latestReview = reviews.filter(function(h){ return h.submission_id === s.submission_id; })
      .sort(function(a,b){ return String(b.reviewed_at||'').localeCompare(String(a.reviewed_at||'')); })[0];
    let correction = null;
    if(latestReview && (s.status === 'CORRECTION_REQUIRED' || s.status === 'ESCALATED') &&
       (latestReview.result === 'CORRECTION_REQUIRED' || latestReview.result === 'ESCALATED')){
      correction = { comment:String(latestReview.comments||''), requested_at:String(latestReview.reviewed_at||'').slice(0,10) };
    }
    return { submission_id:s.submission_id, title:s.title, status:s.status, versions:vs, correction:correction,
      method:s.submission_method || 'UPLOAD' };
  });
  // バッジ取得導線（V2-014-7）：提出トークンのままバッジページを開ける（表示毎の再発行はしない）
  const badge = readRows_(ssOps_(),'Badges').find(function(b){ return b.contract_id === contractId && String(b.status) === 'ISSUED'; });
  // 配信元は WORKFLOW_URL（Cloud Run）を正とする。ScriptApp.getService().getUrl() は
  // 実行中のGASプロジェクトのURLを返すため、画面を外へ出したあとは行き先が食い違う。
  const badgeUrl = badge ? userPageUrl_('badge','token',token) : '';
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  const remaining = Math.max(0, num_(tok.max_uses) - num_(tok.used_count));
  const lim = submitFolderLimits_();
  return { contract_id:contractId, works:contractWorkNames_(contractId), submissions:subs,
    badge_url:badgeUrl, cert_status:(cert ? cert.status : 'NONE'),
    expires_at:String(tok.expires_at||'').slice(0,10), remaining_uploads:remaining,
    // 大容量提出（専用Driveフォルダ）の案内値
    upload_max_mb: Math.round(UPLOAD_MAX_BYTES/1024/1024),
    folder_max_files: lim.maxFiles, folder_max_gb: Math.round(lim.maxBytes/(1024*1024*1024)),
    folder_open_days: lim.openDays };
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
  if(!rateLimit_('submit:' + tok.token_id, 10, 3600)) throw new Error('提出の試行回数が上限に達しました。時間をおいて再度お試しください。');
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

  // 台帳の現在地を審査中へ（AI起票の前に。AIが同期で完走しても順序が崩れないように）
  const licenseId = licenseIdOfContract_(contractId);
  if(licenseId) transitionLicenseCase_(licenseId, 'SUBMISSION_CREATED', { actor:'licensee', reason: submissionId + ' v' + versionNo });

  // AI一次審査を起票（→人手審査必須）
  const aiId = enqueueAiReview_(submissionId, versionId);
  logEvent_('submission', submissionId, 'licensee', null, {version_no:versionNo, ai_review_id:aiId});
  return { submission_id:submissionId, version_no:versionNo, ai_review_id:aiId };
}

/**
 * バッジDLページ（V2-014-3/4/7）：BADGE_DOWNLOAD または SUBMISSION トークンで認証し、
 * GASがDriveから読み出した画像を data URI で配信する（Drive共有リンクは使わない）。
 */
function serveBadge_(e){
  const token = (e.parameter && e.parameter.token) || '';
  let tok = resolveToken_(token, 'BADGE_DOWNLOAD');
  if(tok){ consumeToken_(tok); }
  else { tok = resolveToken_(token, 'SUBMISSION') || resolveToken_(token, 'GUIDE'); }   // 提出・案内トークンのまま閲覧可（再発行不要）
  const b = tok ? readRows_(ssOps_(),'Badges').find(function(x){ return x.contract_id === tok.contract_id && String(x.status) === 'ISSUED'; }) : null;
  if(!b) return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">リンクが無効か、有効期限が切れています。</p>').setTitle('SPLL 認証バッジ');
  const workNames = contractWorkNames_(b.contract_id).join('、');   // 契約単位（複数原作）
  const rows = [['大 (L)', b.png_l], ['中 (M)', b.png_m], ['小 (S)', b.png_s]].map(function(p){
    let dataUri = '';
    try{
      const blob = DriveApp.getFileById(p[1]).getBlob();
      dataUri = 'data:image/png;base64,' + Utilities.base64Encode(blob.getBytes());
    }catch(err){ return '<div style="margin:18px 0;color:#A6342F">' + p[0] + '：画像を取得できませんでした</div>'; }
    return '<div style="margin:18px 0"><div style="font-weight:600;margin-bottom:6px">' + p[0] + '</div>' +
      '<img src="' + dataUri + '" style="max-width:100%;border:1px solid #ccc;border-radius:8px"><br>' +
      '<a href="' + dataUri + '" download="SPLL_badge_' + esc_(b.badge_id) + '_' + p[0].slice(-3,-1) + '.png" style="display:inline-block;margin-top:6px">PNGをダウンロード</a></div>';
  }).join('');
  const html = '<div style="font-family:sans-serif;max-width:720px;margin:0 auto;padding:24px">' +
    '<h2>SPLL 認証バッジ</h2><p>' + esc_(workNames) + ' ／ ライセンスID: ' + b.contract_id +
    ' ／ 発行日: ' + b.issued_at + '</p>' + rows +
    '<p style="font-size:12px;color:#666">クレジット表記としてご利用ください。表示位置・改変の可否は利用規約に従います。</p></div>';
  return HtmlService.createHtmlOutput(html).setTitle('SPLL 認証バッジ');
}

/**
 * 認証の照会（画面・APIの共通処理）。
 * 総当たり対策のレート制限と照会ログはここで行うので、どの入口から来ても同じ扱いになる。
 * 無効の理由（未入金による停止など）は返さない。掲載者以外に事情を推測させないため。
 */
function verifyCertificate_(certId, code){
  const id = String(certId || '');
  if(!id) return { state:'INPUT' };
  if(!rateLimit_('verify:' + id, 30, 3600))
    return { state:'LIMITED', title:'確認できません',
      message:'照会回数が上限に達しました。時間をおいて再度お試しください。' };
  const cert = readRows_(ssOps_(),'Certificates').find(function(x){ return x.cert_id === id; });
  const codeOk = cert && cert.check_code_hash && String(cert.check_code_hash) === hash_(String(code || ''));
  if(!cert || !codeOk){
    logEvent_('certificate', id, 'public', null, { verify:'MISMATCH' });   // 照会ログ（総当たり検知用）
    return { state:'MISMATCH', title:'確認できません',
      message:'正規に発行された認証ではないか、照合コードが一致しません。' };
  }
  const active = String(cert.status) === 'ACTIVE';
  return {
    state: active ? 'ACTIVE' : 'INACTIVE',
    title: active ? '正規ライセンス 確認済み' : '無効',
    message: active ? 'このライセンスは有効です。' : 'このライセンスは現在有効ではありません（' + cert.status + '）。',
    work_names: contractWorkNames_(cert.contract_id),
    credit_texts: contractCreditTexts_(cert.contract_id),   // 契約書は「別途指定」。実際の文言はここで示す
    license_id: cert.contract_id, issued_at: cert.issued_at, status: cert.status
  };
}
/** 公開Web（Cloud Run）から呼ぶ照会API。表示はCloud Run側で組む。 */
function web_verifyCertificate(certId, code){ return verifyCertificate_(certId, code); }

/** 検証ポータル（?page=verify）。id+照合コード（ハッシュ照合・§13.2）で認証状態を表示。 */
function serveVerify_(e){
  const p = e.parameter || {};
  const v = verifyCertificate_(p.id, p.c);
  if(v.state === 'INPUT') return verifyInputHtml_();
  if(v.state === 'LIMITED' || v.state === 'MISMATCH') return verifyHtml_('gray', v.title, v.message, '');
  const meta = '対象原作：' + (v.work_names.length ? esc_(v.work_names.join('、')) : '—') +
    '<br>ライセンスID：' + esc_(v.license_id) + '<br>発行日：' + esc_(v.issued_at) +
    '<br>状態：' + esc_(v.status) +
    ((v.credit_texts && v.credit_texts.length)
      ? '<br>指定のクレジット表記：' + esc_(v.credit_texts.join(' ／ ')) : '');
  return verifyHtml_(v.state === 'ACTIVE' ? 'ok' : 'ng', v.title, v.message, meta);
}

/**
 * 認証バッジの取得（公開Web用）。画像はDrive上にあり匿名では読めないため、
 * メタ情報と画像を分けて返す。画像は1枚ずつ渡し、1回の応答を重くしない。
 */
function web_getBadgeContext(token){
  const b = badgeForToken_(token, true);
  if(!b) return null;
  return { license_id:b.contract_id, badge_id:b.badge_id, issued_at:b.issued_at,
    work_names: contractWorkNames_(b.contract_id).join('、'),
    sizes: [{ key:'l', label:'大 (L)' }, { key:'m', label:'中 (M)' }, { key:'s', label:'小 (S)' }] };
}
function web_getBadgeImage(token, size){
  const b = badgeForToken_(token, false);      // 画像取得では回数を消費しない（3枚で3回減らさない）
  if(!b) return null;
  const fileId = { l:b.png_l, m:b.png_m, s:b.png_s }[String(size || 'l')];
  if(!fileId) return null;
  try{
    return { base64: Utilities.base64Encode(DriveApp.getFileById(fileId).getBlob().getBytes()) };
  }catch(err){ return null; }
}
/** バッジ用トークンの解決。提出・案内のトークンでも閲覧できる（再発行を不要にするため）。 */
function badgeForToken_(token, consume){
  let tok = resolveToken_(token, 'BADGE_DOWNLOAD');
  if(tok){ if(consume) consumeToken_(tok); }
  else { tok = resolveToken_(token, 'SUBMISSION') || resolveToken_(token, 'GUIDE'); }
  if(!tok) return null;
  return readRows_(ssOps_(),'Badges').find(function(x){ return x.contract_id === tok.contract_id && String(x.status) === 'ISSUED'; }) || null;
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
