/**
 * SPLL 42_large_submission ― 大容量作品の提出（専用Driveフォルダ受渡し方式）
 *
 * 直接アップロード（web_submitWork）は google.script.run で実体を運ぶため 20MB が上限で、
 * 印刷入稿PDF・動画・音楽・立体データ・ソフトウェア一式は提出できない。
 * そこで「提出の版ごとに空のDriveフォルダを払い出し、期限つきの編集リンクを渡す」方式を用意する。
 *
 *   1. web_openDriveSubmission(token, {...})   … 版を作成し、フォルダを払い出して投入リンクを返す（OPEN）
 *   2. クリエーターがブラウザからフォルダへ投入（GASを経由しないためサイズ制限を受けない）
 *   3. web_finalizeDriveSubmission(token, versionId) … 中身を検査して確定・共有解除（CLOSED）→審査へ
 *
 * 未確定のまま放置されたフォルダは日次バッチ closeStaleSubmissionFolders_ で共有解除する。
 */

/** 大容量提出の上限（Configで変更可） */
function submitFolderLimits_(){
  return {
    maxFiles: num_(getConfig_('SUBMIT_FOLDER_MAX_FILES','50')) || 50,
    maxBytes: (num_(getConfig_('SUBMIT_FOLDER_MAX_GB','5')) || 5) * 1024 * 1024 * 1024,
    openDays: num_(getConfig_('SUBMIT_FOLDER_OPEN_DAYS','14')) || 14,
  };
}

/**
 * 大容量提出の受け口を開く。新規提出／既存提出の再提出（新しい版）の両方に対応。
 * トークンはここでは消費せず、確定（finalize）時に消費する。
 */
function web_openDriveSubmission(token, data){
  const tok = resolveToken_(token, 'SUBMISSION');
  if(!tok) throw new Error('提出用リンクが無効か、有効期限が切れているか、提出回数の上限に達しています。');
  if(!rateLimit_('openFolder:' + tok.token_id, 10, 3600))
    throw new Error('受け口の作成回数が上限に達しました。時間をおいて再度お試しください。');
  data = data || {};
  const contractId = tok.contract_id;
  const contract = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; }) || {};

  let submissionId = String(data.submission_id || '');
  let sub = submissionId ? readRows_(ssOps_(),'Submissions').find(function(s){ return s.submission_id === submissionId; }) : null;
  if(sub && sub.contract_id !== contractId) throw new Error('この提出は対象の契約に属していません。');
  const now = new Date().toISOString();
  if(!sub){
    if(!String(data.title || '').trim()) throw new Error('VALIDATION_ERROR: 二次創作作品名は必須です。');
    submissionId = newId_('SUB');
    appendRow_(ssOps_(),'Submissions',{ submission_id:submissionId, contract_id:contractId,
      title:sanitizeCell_(String(data.title).slice(0,200)), status:'FOLDER_OPEN', submitted_at:now,
      submission_method:'DRIVE_FOLDER' });
  }else{
    // 同一提出で開きっぱなしの版があれば、二重にフォルダを作らず既存を返す
    const open = readRows_(ssOps_(),'Submission_Versions')
      .filter(function(v){ return v.submission_id === submissionId && v.folder_status === 'OPEN'; })[0];
    if(open) return driveSubmissionInfo_(open, '既に開いている受け口を再表示しました。');
    updateRow_(ssOps_(),'Submissions','submission_id',submissionId,
      { status:'FOLDER_OPEN', submission_method:'DRIVE_FOLDER' });
    if(data.title) updateRow_(ssOps_(),'Submissions','submission_id',submissionId,
      { title:sanitizeCell_(String(data.title).slice(0,200)) });
  }

  const existing = readRows_(ssOps_(),'Submission_Versions').filter(function(v){ return v.submission_id === submissionId; });
  const versionNo = existing.reduce(function(m,v){ return Math.max(m, num_(v.version_no)); }, 0) + 1;
  const versionId = newId_('SV');

  // 契約フォルダ配下に、この版専用の空フォルダを作って編集リンクを払い出す
  const subRoot = getOrCreateChildFolder_(contractSubFolder_(contract,'02_Submissions'), submissionId);
  const folder = subRoot.createFolder('v' + versionNo);
  try{ folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT); }
  catch(e){ logError_('PROCESSING_ERROR','openDriveSubmission:share', e); }

  appendRow_(ssOps_(),'Submission_Versions',{ version_id:versionId, submission_id:submissionId,
    version_no:versionNo, status:'FOLDER_OPEN', submitted_at:'', submission_method:'DRIVE_FOLDER',
    drive_folder_id:folder.getId(), folder_status:'OPEN', folder_opened_at:now, folder_closed_at:'',
    file_count:'', total_bytes:'' });
  logEvent_('submission', submissionId, 'licensee', null,
    { version_no:versionNo, method:'DRIVE_FOLDER', folder_id:folder.getId(), status:'FOLDER_OPEN' });
  const row = readRows_(ssOps_(),'Submission_Versions').find(function(v){ return v.version_id === versionId; });
  return driveSubmissionInfo_(row, '');
}

/** 投入リンク・期限・上限をクリエーター向けに整形 */
function driveSubmissionInfo_(v, note){
  const lim = submitFolderLimits_();
  const opened = v.folder_opened_at ? new Date(v.folder_opened_at) : new Date();
  const due = new Date(opened.getTime()); due.setDate(due.getDate() + lim.openDays);
  return {
    submission_id: v.submission_id, version_id: v.version_id, version_no: num_(v.version_no),
    folder_url: 'https://drive.google.com/drive/folders/' + v.drive_folder_id,
    folder_status: v.folder_status || 'OPEN',
    max_files: lim.maxFiles, max_gb: Math.round(lim.maxBytes / (1024*1024*1024)),
    open_until: due.toISOString().slice(0,10),
    note: note || ''
  };
}

/**
 * 投入完了の確定。フォルダの中身を検査して Submission_Files へ記録し、共有を解除する。
 * 冪等：確定済みの版を再確定しない。
 */
function web_finalizeDriveSubmission(token, versionId){
  const tok = resolveToken_(token, 'SUBMISSION');
  if(!tok) throw new Error('提出用リンクが無効か、有効期限が切れているか、提出回数の上限に達しています。');
  const v = readRows_(ssOps_(),'Submission_Versions').find(function(x){ return x.version_id === String(versionId||''); });
  if(!v) throw new Error('DATA_NOT_FOUND: 提出の版が見つかりません。');
  const sub = readRows_(ssOps_(),'Submissions').find(function(s){ return s.submission_id === v.submission_id; });
  if(!sub || sub.contract_id !== tok.contract_id) throw new Error('この提出は対象の契約に属していません。');
  if(String(v.folder_status) !== 'OPEN') throw new Error('DATA_CONFLICT: この版は既に提出が確定しています。');

  const scan = scanSubmissionFolder_(v.drive_folder_id);
  const lim = submitFolderLimits_();
  if(!scan.files.length) throw new Error('VALIDATION_ERROR: フォルダにファイルがありません。作品ファイルを入れてから「提出を確定」してください。');
  if(scan.files.length > lim.maxFiles)
    throw new Error('VALIDATION_ERROR: ファイル数が上限（' + lim.maxFiles + '件）を超えています: ' + scan.files.length + '件');
  if(scan.totalBytes > lim.maxBytes)
    throw new Error('VALIDATION_ERROR: 合計サイズが上限（' + Math.round(lim.maxBytes/(1024*1024*1024)) + 'GB）を超えています: ' +
      (Math.round(scan.totalBytes/(1024*1024*1024)*10)/10) + 'GB');

  const now = new Date().toISOString();
  scan.files.forEach(function(f){
    appendRow_(ssOps_(),'Submission_Files',{ submission_file_id:newId_('SBF'), version_id:v.version_id,
      drive_file_id:f.id, mime_type:f.mime, size:f.size,
      sha256:'',                                      // 大容量はGASでハッシュ化できないため空（Drive側のID・サイズで同一性を担保）
      original_filename:sanitizeCell_(String(f.name).slice(0,200)), magic_valid:'' });
  });
  closeSubmissionFolder_(v.drive_folder_id);          // 受領後は投入リンクを閉じる
  updateRow_(ssOps_(),'Submission_Versions','version_id',v.version_id,
    { status:'SUBMITTED', submitted_at:now, folder_status:'CLOSED', folder_closed_at:now,
      file_count:scan.files.length, total_bytes:scan.totalBytes });
  updateRow_(ssOps_(),'Submissions','submission_id',v.submission_id,{ status:'SUBMITTED' });
  consumeToken_(tok);

  // AI一次審査：スクリーニング可能なファイル（PDF/PNG/JPEG）があるときだけ起票し、
  // 無ければ人手審査へ回送する（動画・音楽・立体データ等はAIの対象外）
  const aiId = scan.screenable ? enqueueAiReview_(v.submission_id, v.version_id) : null;
  if(!aiId){
    markVersionStatus_(v.version_id, 'AI_NOT_APPLICABLE');
    updateRow_(ssOps_(),'Submissions','submission_id',v.submission_id,{ status:'HUMAN_REVIEW_PENDING' });
    enqueueNotification_(sub.contract_id, 'REVIEW_SLA_OVERDUE', 'LARGE:' + v.version_id,
      { submission_id:v.submission_id, version:num_(v.version_no), file_count:scan.files.length,
        action:'AI審査対象外の形式です。管理コンソールの審査キューから人手で確認してください' });
  }
  logEvent_('submission', v.submission_id, 'licensee', null,
    { version_no:num_(v.version_no), method:'DRIVE_FOLDER', files:scan.files.length,
      total_bytes:scan.totalBytes, ai_review_id:aiId || '', screenable:scan.screenable });
  return { submission_id:v.submission_id, version_no:num_(v.version_no), file_count:scan.files.length,
    total_bytes:scan.totalBytes, ai_review_id:aiId || '', ai_applicable:!!scan.screenable };
}

/** フォルダ直下のファイルを一覧（サブフォルダは対象外＝取り違え防止のためフラット運用） */
function scanSubmissionFolder_(folderId){
  const out = { files: [], totalBytes: 0, screenable: false };
  let folder;
  try{ folder = DriveApp.getFolderById(folderId); }catch(e){ return out; }
  const it = folder.getFiles();
  while(it.hasNext()){
    const f = it.next();
    let size = 0; try{ size = num_(f.getSize()); }catch(e){}
    let mime = ''; try{ mime = String(f.getMimeType ? f.getMimeType() : ''); }catch(e){}
    const name = String(f.getName ? f.getName() : '');
    out.files.push({ id:f.getId(), name:name, size:size, mime:mime });
    out.totalBytes += size;
    if(/^(application\/pdf|image\/png|image\/jpeg)$/.test(mime) || /\.(pdf|png|jpe?g)$/i.test(name)){
      if(size <= UPLOAD_MAX_BYTES) out.screenable = true;   // AIへ渡せる形式・サイズが1つでもあるか
    }
  }
  return out;
}

/** 投入リンクを閉じる（共有解除）。失敗しても台帳更新は妨げない。 */
function closeSubmissionFolder_(folderId){
  try{
    const f = DriveApp.getFolderById(folderId);
    f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    return true;
  }catch(e){ logError_('PROCESSING_ERROR','closeSubmissionFolder', e); return false; }
}

/**
 * 未確定のまま開放期間を過ぎた投入フォルダを閉じる（日次バッチ）。
 * リンクを持つ第三者が書き込み続けられる状態を残さないための後始末。
 */
function closeStaleSubmissionFolders_(){
  const lim = submitFolderLimits_();
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - lim.openDays);
  let n = 0;
  readRows_(ssOps_(),'Submission_Versions')
    .filter(function(v){ return v.folder_status === 'OPEN' && v.folder_opened_at && new Date(v.folder_opened_at) < cutoff; })
    .forEach(function(v){
      closeSubmissionFolder_(v.drive_folder_id);
      updateRow_(ssOps_(),'Submission_Versions','version_id',v.version_id,
        { folder_status:'EXPIRED', folder_closed_at:new Date().toISOString(), status:'FOLDER_EXPIRED' });
      logEvent_('submission', v.submission_id, 'system', { folder_status:'OPEN' },
        { folder_status:'EXPIRED', reason:'開放期間（' + lim.openDays + '日）超過' });
      n++;
    });
  return { processed:n };
}
