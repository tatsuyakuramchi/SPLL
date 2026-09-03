/**
 * SPLL 41_certificate ― 認証の発行（RP-002 §3）
 *
 * 認証（Certificate）は「この二次創作物は正規ライセンスの下で審査を通った」ことの表示物である。
 * 以前は CloudSign 締結の直後に発行していたため、審査前の作品に ACTIVE の認証とバッジが
 * 存在し得た。業務の順序は
 *   締結 → 作品提出 → AI審査 → 人手審査（CLEARED）→ 認証発行 → バッジ発行
 * なので、発行は人手審査が CLEARED になった時点で行う。
 *
 * 発行の前提（どれか欠けたら発行しない）：
 *   1. 契約が成立している（License_Cases.contract_status = SIGNED、SIGNED の Contracts がある）
 *   2. 対象の提出が最新で、その最新版の人手審査が CLEARED
 *   3. 未解決（OPEN）の重大 Compliance_Alert が無い
 * 発行そのもの（照合コード・QR）は issueCert_ / enqueueBadgeJob_（32_contract）を使い、
 * 台帳の状態は CERTIFICATE_ISSUED で遷移させる。
 */

/** 案件に紐づく SIGNED の契約（互換テーブル Contracts）。CloudSign書類IDやフォルダを知る内部処理だけが使う。 */
function currentSignedContract_(licenseId){
  const cs = readRows_(ssOps_(),'Contracts')
    .filter(function(c){ return String(c.license_id) === String(licenseId) && String(c.status) === 'SIGNED'; })
    .sort(function(a,b){ return String(b.signed_at||'').localeCompare(String(a.signed_at||'')); });
  return cs[0] || null;
}

/** 提出の最新版（version_no 最大）。 */
function latestSubmissionVersion_(submissionId){
  return readRows_(ssOps_(),'Submission_Versions')
    .filter(function(v){ return v.submission_id === submissionId; })
    .sort(function(a,b){ return num_(b.version_no) - num_(a.version_no); })[0] || null;
}

/** 発行できるかを判定し、できない理由を返す（空文字なら発行可）。 */
function certificationBlockers_(licenseId, submissionId){
  const kase = readRows_(ssOps_(),'License_Cases').find(function(k){ return k.license_id === licenseId; });
  if(!kase) return 'ライセンス案件がありません: ' + licenseId;
  if(String(kase.contract_status) !== 'SIGNED') return '契約が成立していません（contract_status=' + kase.contract_status + '）';
  if(!currentSignedContract_(licenseId)) return '締結済の契約が見つかりません';

  const sub = readRows_(ssOps_(),'Submissions').find(function(s){ return s.submission_id === submissionId; });
  if(!sub) return '提出が見つかりません: ' + submissionId;
  const subLicense = sub.license_id || licenseIdOfContract_(sub.contract_id);
  if(String(subLicense) !== String(licenseId)) return '提出が別の案件のものです';
  const latest = latestSubmissionVersion_(submissionId);
  if(!latest) return '提出の版がありません';
  const review = readRows_(ssOps_(),'Human_Reviews')
    .filter(function(h){ return h.submission_id === submissionId && h.version_id === latest.version_id; })
    .sort(function(a,b){ return String(b.reviewed_at||'').localeCompare(String(a.reviewed_at||'')); })[0];
  if(!review || String(review.result) !== 'CLEARED') return '最新版（v' + latest.version_no + '）の人手審査が CLEARED ではありません';

  const openHigh = readRows_(ssOps_(),'Compliance_Alerts').filter(function(a){
    const lid = a.license_id || licenseIdOfContract_(a.contract_id);
    return String(lid) === String(licenseId) && String(a.status) !== 'CLOSED' && /HIGH/i.test(String(a.severity));
  });
  if(openHigh.length) return '未解決の重大アラートがあります（' + openHigh.length + '件）';
  return '';
}

/**
 * 人手審査 CLEARED を受けて認証を発行する。
 * 既に ACTIVE の認証がある案件（再提出の再審査など）は再発行せず、そのまま返す。
 * 停止中（SUSPENDED：利用許諾料未確認など）の認証は審査通過だけでは復帰させない（停止理由の解消は別の判断）。
 *
 * 認証の行と台帳（License_Cases）は一緒に変わるべきものなので、
 *   ロック → 前提の再確認 → 台帳遷移の事前検証 → 認証の行を作成 → 台帳を遷移 → Events
 * の順で行う（P1-2）。事前検証で拒否されれば何も書かない。台帳が後段で失敗して
 * 「認証だけ ACTIVE」になる経路を作らない。バッジ生成はこの外（失敗しても認証には影響しない）。
 */
function completeCertification_(licenseId, submissionId, actor){
  const who = actor || 'system';
  const ctx = { actor: who, reason: '審査CLEARED: ' + submissionId };
  const r = withLicenseLock_(function(){
    const why = certificationBlockers_(licenseId, submissionId);
    if(why){
      logEvent_('certificate', licenseId, who, null, { issued:false, reason: why, submission_id: submissionId });
      return { issued:false, reason: why };
    }
    const contract = currentSignedContract_(licenseId);
    const existing = readRows_(ssOps_(),'Certificates').find(function(c){
      return String(c.license_id || licenseIdOfContract_(c.contract_id)) === String(licenseId); });
    if(existing){
      // 発行済。停止中なら復帰は別途の判断、有効なら何もしない
      return { issued:false, reused:true, cert_id: existing.cert_id, status: existing.status };
    }
    // 台帳が受け付けない状態（現在地が取消等）なら認証の行も作らない
    try{ validateLicenseTransition_(licenseId, 'CERTIFICATE_ISSUED', ctx); }
    catch(e){
      const reason = String(e && e.message || e);
      logEvent_('certificate', licenseId, who, null, { issued:false, reason: reason, submission_id: submissionId });
      return { issued:false, reason: reason };
    }
    const cert = issueCert_(contract.contract_id);   // 平文の照合コードはここでだけ得られる（バッジQRへ焼き込む）
    transitionLicenseCase_(licenseId, 'CERTIFICATE_ISSUED', ctx);
    logEvent_('certificate', cert.cert_id, who, null,
      { issued:true, license_id: licenseId, submission_id: submissionId, contract_id: contract.contract_id });
    return { issued:true, cert_id: cert.cert_id, verify_url: cert.verify_url, contract_id: contract.contract_id };
  });
  if(!r.issued) return r;
  // バッジは認証 ACTIVE・審査 CLEARED が揃った後にだけ作る（issueBadge_ が再検証する）。失敗は5分バッチが再試行
  let badge = null;
  if(prop_('BADGE_AUTO') !== 'false') badge = enqueueBadgeJob_(licenseId, r.cert_id, r.verify_url);
  return { issued:true, cert_id: r.cert_id, verify_url: r.verify_url, badge_job_id: badge ? badge.badge_job_id : '' };
}
