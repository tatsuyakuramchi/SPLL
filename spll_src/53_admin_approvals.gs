/**
 * SPLL 53_admin_approvals ― 承認の操作は2人で行う（申請 → 別の担当者が承認）（GAS③ 管理）
 *
 * 運用の方針：基本の操作は担当者1人。承認にあたる操作は「申請した人」と「承認する人」を別にする（職務分離）。
 * ここでは個別契約（別紙）の承認を扱う。認証の停止・失効・再有効化・契約終了は既存の
 * Certificate_Change_Requests（admin_requestCertChange → admin_approveCertChange）が同じ考え方で動いている。
 *
 *   BESSHI_APPROVE … 申込を承認して別紙（前払いは請求書つき）を作り、CloudSign で送る
 *   BESSHI_REJECT  … 申込を承認しない（理由をクリエーターへ知らせ、申込を取り消す）
 *
 * 承認待ち（APPROVAL_PENDING）の案件に、担当者Aが申請を出す（1件につき未決の申請は1つだけ）。
 * 担当者B（A以外）が承認すると、申請の内容が実行される。却下すると申請だけが閉じ、案件は承認待ちのまま。
 * 申請者本人は承認も却下もできない（取り下げはできる）。
 */
const APPROVAL_KINDS = {
  BESSHI_APPROVE: { label: '申込を承認して別紙を送る', event: 'APPLICATION_APPROVED', from: ['APPROVAL_PENDING','MANUAL_REVIEW'] },
  BESSHI_REJECT:  { label: '申込を承認しない', event: 'APPLICATION_REJECTED', from: ['APPROVAL_PENDING','MANUAL_REVIEW','APPROVED'], needReason: true }
};

function openApprovalOf_(licenseId){
  return readRows_(ssOps_(), 'Approval_Requests').find(function(r){ return r.license_id === String(licenseId) && r.status === 'REQUESTED'; }) || null;
}

/** 申請（担当者A）。note は申請の理由・確認した内容。承認しない申請は理由が必須 */
function requestApproval_(kind, licenseId, note, actorEmail){
  const def = APPROVAL_KINDS[kind];
  if(!def) throw new Error('VALIDATION_ERROR: 承認の種類が正しくありません: ' + kind);
  const why = String(note || '').trim();
  if(def.needReason && !why) throw new Error('VALIDATION_ERROR: 承認しない理由を入力してください');
  return withLicenseLock_(function(){
    const k = readRows_(ssOps_(), 'License_Cases').find(function(x){ return x.license_id === String(licenseId); });
    if(!k) throw new Error('DATA_NOT_FOUND: 案件がありません: ' + licenseId);
    if(def.from.indexOf(normalizeCaseStatus_(k.case_status)) < 0)
      throw new Error('STATE_ERROR: 現在地（' + k.case_status + '）では「' + def.label + '」を申請できません');
    if(openApprovalOf_(licenseId)) throw new Error('DATA_CONFLICT: この案件には未決の申請があります（先に承認・却下・取り下げをしてください）');
    const id = Utilities.getUuid(), now = new Date().toISOString();
    appendRow_(ssOps_(), 'Approval_Requests', { request_id: id, license_id: String(licenseId), kind: kind,
      note: sanitizeCell_(why.slice(0, 1000)), requested_by: String(actorEmail || ''), requested_at: now, status: 'REQUESTED',
      decided_by: '', decided_at: '', decision_note: '' });
    logEvent_('approval_request', id, actorEmail || 'system', null, { license_id: licenseId, kind: kind, status: 'REQUESTED' });
    return { request_id: id };
  });
}

/**
 * 承認・却下（担当者B）。申請者本人はできない。
 * 承認すると申請の内容（状態遷移）を実行する。別紙の作成と CloudSign 送信は、承認済み（APPROVED）になった案件を
 * 送信処理（P4）が拾って行う（送信に失敗しても承認は取り消されず、再送できる）。
 */
function decideApproval_(requestId, approve, note, actorEmail){
  return withLicenseLock_(function(){
    const r = readRows_(ssOps_(), 'Approval_Requests').find(function(x){ return x.request_id === String(requestId); });
    if(!r) throw new Error('DATA_NOT_FOUND: 申請がありません: ' + requestId);
    if(r.status !== 'REQUESTED') throw new Error('DATA_CONFLICT: この申請は処理済みです（' + r.status + '）');
    if(String(r.requested_by).toLowerCase() === String(actorEmail || '').toLowerCase())
      throw new Error('AUTHORIZATION_ERROR: 申請した本人は承認・却下できません。別の担当者が行ってください');
    const def = APPROVAL_KINDS[r.kind];
    const now = new Date().toISOString();
    if(approve){
      transitionLicenseCase_(r.license_id, def.event, { actor: actorEmail, reason: r.note || String(note || '') });
    }
    updateRow_(ssOps_(), 'Approval_Requests', 'request_id', r.request_id, {
      status: approve ? 'APPROVED' : 'REJECTED', decided_by: String(actorEmail || ''), decided_at: now,
      decision_note: sanitizeCell_(String(note || '').slice(0, 1000)) });
    logEvent_('approval_request', r.request_id, actorEmail || 'system', { status: 'REQUESTED' },
      { status: approve ? 'APPROVED' : 'REJECTED', kind: r.kind, license_id: r.license_id });
    return { status: approve ? 'APPROVED' : 'REJECTED', kind: r.kind, license_id: r.license_id };
  });
}

/** 取り下げ（申請者本人だけ） */
function withdrawApproval_(requestId, actorEmail){
  return withLicenseLock_(function(){
    const r = readRows_(ssOps_(), 'Approval_Requests').find(function(x){ return x.request_id === String(requestId); });
    if(!r || r.status !== 'REQUESTED') throw new Error('DATA_CONFLICT: 取り下げられる申請がありません');
    if(String(r.requested_by).toLowerCase() !== String(actorEmail || '').toLowerCase())
      throw new Error('AUTHORIZATION_ERROR: 取り下げは申請した本人だけができます');
    updateRow_(ssOps_(), 'Approval_Requests', 'request_id', r.request_id, { status: 'WITHDRAWN', decided_at: new Date().toISOString() });
    logEvent_('approval_request', r.request_id, actorEmail, { status: 'REQUESTED' }, { status: 'WITHDRAWN' });
    return true;
  });
}
