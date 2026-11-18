/**
 * SPLL 54_admin_agreement ― 利用許諾契約の終了と、別紙への波及（GAS③ 管理。改修計画 P1-4）
 *
 * 利用許諾契約が終了すると、その契約に追加されたすべての別紙に基づく許諾も終わる（利用許諾契約書 第12条第3項）。
 * 各別紙（SPLL番号）は状態遷移表を通して終わらせる：
 *   認証の行がある → applyCertStatus_（認証の行と台帳を一緒に TERMINATED。バッジも差し替え）
 *   別紙が本契約に追加済み（contract_status=SIGNED）→ CONTRACT_TERMINATED
 *   追加前（申込受付・個別確認・同意待ちなど）→ APPLICATION_CANCELLED
 * 同意待ちの別紙は CloudSign の書類も取り消す必要があるため、書類IDを戻り値で返す（取消は P4 の処理が行う）。
 * 承認の流れ（申請→別担当者の承認）は管理画面のスイッチ S10 で付ける（P6）。
 */
function terminateAgreement_(no, reason, actorEmail){
  const actor = actorEmail || 'system';
  const why = String(reason || '').trim();
  if(!why) throw new Error('VALIDATION_ERROR: 終了の理由を入力してください');
  withLicenseLock_(function(){
    const a = agreementByNo_(no);
    if(!a) throw new Error('DATA_NOT_FOUND: 利用許諾契約がありません: ' + no);
    if(a.status !== 'ACTIVE') throw new Error('STATE_ERROR: 有効な利用許諾契約ではありません（status=' + a.status + '）');
    const now = new Date().toISOString();
    updateRow_(ssOps_(), 'Agreements', 'agreement_no', a.agreement_no,
      { status: 'TERMINATED', terminated_at: now, terminated_reason: sanitizeCell_(why.slice(0, 500)), updated_at: now });
    logEvent_('agreement', a.agreement_no, actor, { status: 'ACTIVE' }, { status: 'TERMINATED', reason: why });
  });
  const out = { agreement_no: String(no), terminated: [], cancelled: [], skipped: [], signing_documents: [] };
  agreementCases_(no).forEach(function(k){
    const status = normalizeCaseStatus_(k.case_status);
    if(status === 'TERMINATED' || status === 'CANCELLED'){ out.skipped.push(k.license_id); return; }
    const ctx = { actor: actor, reason: '利用許諾契約の終了: ' + why };
    if(certForRef_(k.license_id)){
      applyCertStatus_(k.license_id, 'TERMINATED', 'AGREEMENT_TERMINATED', why, '', actor);
      out.terminated.push(k.license_id);
    }else if(String(k.contract_status) === 'SIGNED'){
      withLicenseLock_(function(){ transitionLicenseCase_(k.license_id, 'CONTRACT_TERMINATED', ctx); });
      out.terminated.push(k.license_id);
    }else{
      if(status === 'SIGNING' && k.besshi_document_id) out.signing_documents.push(k.besshi_document_id);
      withLicenseLock_(function(){ transitionLicenseCase_(k.license_id, 'APPLICATION_CANCELLED', ctx); });
      out.cancelled.push(k.license_id);
    }
  });
  return out;
}
