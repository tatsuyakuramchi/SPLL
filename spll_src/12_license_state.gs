/**
 * SPLL 12_license_state ― ライセンス案件（SPLL番号）の状態遷移（RP-002 §4）
 *
 * License_Cases の4つの状態列（case_status / contract_status / review_status / certification_status）は
 * ここを通してだけ変える。業務処理が各列を直接書き換えると、
 *   contract_status = SIGNING なのに certification_status = ACTIVE
 * のような矛盾を作れてしまう。イベント名で意図を書き、遷移表が整合を保つ。
 *
 * 遷移は Events に before / event / after を残す（監査・タイムライン表示）。
 * 許可されていない遷移は例外（データを黙って壊さない）。
 *
 * 状態列以外（契約者名・連絡先・CloudSign書類ID・経理引渡状況など）は
 * updateLicenseCaseInfo_ で更新する。状態列を渡すと拒否する。
 */

/** 案件の現在地（case_status）。旧値（APPLIED 等）は normalizeCaseStatus_ で読み替える。 */
const LICENSE_CASE_STATUSES = [
  'APPLICATION_RECEIVED',   // 申込受付（SPLL番号発行）
  'CONTRACT_PENDING',       // フォーム送信済・契約書送付待ち
  'MANUAL_REVIEW',          // 事務局の個別確認（申込段階／審査上申）
  'SIGNING',                // CloudSign 送付済・同意待ち
  'HOLD',                   // 締結したが条件不一致。法務確認まで自動処理を止める
  'AWAITING_SUBMISSION',    // 契約成立・作品提出待ち
  'REVIEWING',              // 提出済・審査中
  'CORRECTION_REQUIRED',    // 是正要求中
  'CERTIFIED',              // 認証発行済（有効）
  'SUSPENDED',              // 認証停止中（未入金・一時停止）
  'TERMINATED',             // 失効・契約終了
  'CANCELLED'               // 申込取消・再申込で置換
];

/** 旧データの case_status → 現行値。移行前の行が混ざっていても遷移判定できるようにする。 */
const LEGACY_CASE_STATUS_ALIAS = {
  APPLIED: 'APPLICATION_RECEIVED', CONTRACTING: 'CONTRACT_PENDING', SIGNED: 'AWAITING_SUBMISSION',
  CLOSED: 'CANCELLED'
};
function normalizeCaseStatus_(v){
  const s = String(v || '');
  if(LICENSE_CASE_STATUSES.indexOf(s) >= 0) return s;
  return LEGACY_CASE_STATUS_ALIAS[s] || (s ? s : 'APPLICATION_RECEIVED');
}

const LICENSE_STATE_COLUMNS = ['case_status','contract_status','review_status','certification_status'];

/** 認証が「存在して効力の対象になっている」状態か（停止中も含む。失効・終了・未発行は含まない） */
function certLive_(status){ return ['ACTIVE','SUSPENDED','PAYMENT_HOLD','EXPIRED'].indexOf(String(status || '')) >= 0; }
/** 認証の行が存在するか（失効・終了済も含む。未発行だけを除く） */
function certExists_(status){ const s = String(status || ''); return !!s && s !== 'NOT_ISSUED'; }

/**
 * イベント → 遷移。
 *   from  … 遷移できる現在地（case_status）。'*' は任意
 *   to    … 適用する状態列。関数は ctx を受けて計算する
 *   guard … 追加条件（満たさなければ例外）
 */
const LICENSE_TRANSITIONS = {
  APPLICATION_CREATED: {
    from: [],   // 初期化専用（createLicenseCase_ から）
    to: { case_status:'APPLICATION_RECEIVED', contract_status:'NOT_STARTED', review_status:'NOT_STARTED', certification_status:'NOT_ISSUED' }
  },
  FORM_SUBMITTED: {
    from: ['APPLICATION_RECEIVED','MANUAL_REVIEW','CONTRACT_PENDING'],
    to: { case_status:'CONTRACT_PENDING' }
  },
  MANUAL_REVIEW_REQUIRED: {
    from: ['APPLICATION_RECEIVED','CONTRACT_PENDING','MANUAL_REVIEW'],
    to: { case_status:'MANUAL_REVIEW' }
  },
  CLOUDSIGN_SENT: {
    from: ['APPLICATION_RECEIVED','CONTRACT_PENDING','MANUAL_REVIEW','SIGNING'],
    to: { case_status:'SIGNING', contract_status:'SIGNING' }
  },
  // 締結したが台帳スナップショットと条件が合わない。契約は成立しているので contract_status は SIGNED。
  TERMS_MISMATCH: {
    from: ['APPLICATION_RECEIVED','CONTRACT_PENDING','MANUAL_REVIEW','SIGNING','HOLD'],
    to: { case_status:'HOLD', contract_status:'SIGNED' }
  },
  CLOUDSIGN_SIGNED: {
    from: ['APPLICATION_RECEIVED','CONTRACT_PENDING','MANUAL_REVIEW','SIGNING','HOLD','AWAITING_SUBMISSION'],
    to: { case_status:'AWAITING_SUBMISSION', contract_status:'SIGNED', review_status:'AWAITING_SUBMISSION', certification_status:'NOT_ISSUED' }
  },
  // 提出（再提出を含む）。認証済の案件が新しい版を出しても認証は取り消さない（審査で改めて判断する）。
  SUBMISSION_CREATED: {
    from: ['AWAITING_SUBMISSION','REVIEWING','CORRECTION_REQUIRED','MANUAL_REVIEW','CERTIFIED','SUSPENDED'],
    to: function(ctx, cur){ return { case_status:'REVIEWING', review_status:'IN_REVIEW' }; }
  },
  HUMAN_REVIEW_CLEARED: {
    from: ['REVIEWING','CORRECTION_REQUIRED','MANUAL_REVIEW','CERTIFIED','SUSPENDED'],
    to: function(ctx, cur){
      // 認証を持つ案件の再審査が通ったら現在地は認証の状態へ戻す。未発行なら発行待ち（REVIEWING のまま）
      const c = String(cur.certification_status);
      if(c === 'ACTIVE') return { case_status:'CERTIFIED', review_status:'CLEARED' };
      if(['SUSPENDED','PAYMENT_HOLD','EXPIRED'].indexOf(c) >= 0) return { case_status:'SUSPENDED', review_status:'CLEARED' };
      return { case_status:'REVIEWING', review_status:'CLEARED' };
    }
  },
  CORRECTION_REQUIRED: {
    from: ['REVIEWING','CORRECTION_REQUIRED','MANUAL_REVIEW','CERTIFIED','SUSPENDED'],
    to: { case_status:'CORRECTION_REQUIRED', review_status:'CORRECTION_REQUIRED' }
  },
  REVIEW_ESCALATED: {
    from: ['REVIEWING','CORRECTION_REQUIRED','MANUAL_REVIEW','CERTIFIED','SUSPENDED'],
    to: { case_status:'MANUAL_REVIEW', review_status:'ESCALATED' }
  },
  // 認証は審査 CLEARED かつ契約 SIGNED のときだけ発行できる（RP-002 §3）
  CERTIFICATE_ISSUED: {
    from: ['REVIEWING','MANUAL_REVIEW','AWAITING_SUBMISSION','CERTIFIED'],
    guard: function(ctx, cur){
      if(cur.contract_status !== 'SIGNED') return '契約が成立していません（contract_status=' + cur.contract_status + '）';
      if(cur.review_status !== 'CLEARED' && !ctx.allow_unreviewed)
        return '審査が完了していません（review_status=' + cur.review_status + '）';
      return '';
    },
    // allow_unreviewed（移行期間の互換）で発行した場合、審査状態は偽らずそのまま残す
    to: function(ctx, cur){
      return { case_status:'CERTIFIED', certification_status:'ACTIVE',
        review_status: ctx.allow_unreviewed ? cur.review_status : 'CLEARED' };
    }
  },
  // 認証の状態変更は「認証を持っているか」で判定する。認証済の案件に新しい版が提出されて
  // 現在地が REVIEWING になっていても、認証そのものは停止・復帰できる必要がある。
  // 現在地が認証の状態を示しているとき（CERTIFIED / SUSPENDED）だけ現在地も追随させる。
  // ctx.status で SUSPENDED / PAYMENT_HOLD / EXPIRED を区別する
  CERTIFICATE_SUSPENDED: {
    from: '*',
    guard: function(ctx, cur){ return certLive_(cur.certification_status) ? '' : '認証が発行されていません（certification_status=' + cur.certification_status + '）'; },
    to: function(ctx, cur){
      const patch = { certification_status: ctx.status || 'SUSPENDED' };
      if(cur.case_status === 'CERTIFIED' || cur.case_status === 'SUSPENDED') patch.case_status = 'SUSPENDED';
      return patch;
    }
  },
  // 復帰：停止からの再有効化に加え、失効（REVOKED）からの再有効化も申請→別担当者の承認を経て行える（V2-018）
  CERTIFICATE_RESTORED: {
    from: '*',
    guard: function(ctx, cur){ return certExists_(cur.certification_status) ? '' : '認証が発行されていません（certification_status=' + cur.certification_status + '）'; },
    to: function(ctx, cur){
      const patch = { certification_status:'ACTIVE' };
      if(['CERTIFIED','SUSPENDED','TERMINATED'].indexOf(cur.case_status) >= 0) patch.case_status = 'CERTIFIED';
      return patch;
    }
  },
  CERTIFICATE_REVOKED: {
    from: '*',
    guard: function(ctx, cur){ return certLive_(cur.certification_status) ? '' : '認証が発行されていません（certification_status=' + cur.certification_status + '）'; },
    to: { case_status:'TERMINATED', certification_status:'REVOKED' }
  },
  CONTRACT_TERMINATED: {
    from: '*',
    to: function(ctx, cur){
      const certWasLive = ['ACTIVE','SUSPENDED','PAYMENT_HOLD','EXPIRED'].indexOf(String(cur.certification_status)) >= 0;
      return { case_status:'TERMINATED', contract_status:'TERMINATED',
        certification_status: certWasLive ? 'TERMINATED' : cur.certification_status };
    }
  },
  APPLICATION_CANCELLED: {
    from: ['APPLICATION_RECEIVED','CONTRACT_PENDING','MANUAL_REVIEW','SIGNING','HOLD'],
    to: { case_status:'CANCELLED' }
  }
};

/**
 * 状態遷移の実行。
 *   licenseId … SPLL番号
 *   event     … LICENSE_TRANSITIONS のキー
 *   ctx       … { actor, reason, status, ... } 遷移に使う補足。actor は Events の actor 列へ
 * 戻り値：{ before, after, event }。案件が無ければ false（旧データの経路で license_id が無いことがある）。
 */
function transitionLicenseCase_(licenseId, event, ctx){
  if(!licenseId) return false;
  ctx = ctx || {};
  const def = LICENSE_TRANSITIONS[event];
  if(!def) throw new Error('STATE_ERROR: 未定義のイベントです: ' + event);
  const row = readRows_(ssOps_(), 'License_Cases').find(function(k){ return k.license_id === licenseId; });
  if(!row) throw new Error('DATA_NOT_FOUND: ライセンス案件がありません: ' + licenseId);

  const cur = {
    case_status: normalizeCaseStatus_(row.case_status),
    contract_status: String(row.contract_status || 'NOT_STARTED'),
    review_status: String(row.review_status || 'NOT_STARTED'),
    certification_status: String(row.certification_status || 'NOT_ISSUED')
  };
  if(def.from !== '*' && !ctx.force){
    if(def.from.indexOf(cur.case_status) < 0)
      throw new Error('STATE_ERROR: ' + licenseId + ' は ' + cur.case_status + ' から ' + event + ' へ遷移できません');
  }
  if(def.guard && !ctx.force){
    const why = def.guard(ctx, cur);
    if(why) throw new Error('STATE_ERROR: ' + licenseId + ' に ' + event + ' を適用できません：' + why);
  }
  const patch = typeof def.to === 'function' ? def.to(ctx, cur) : Object.assign({}, def.to);
  const after = Object.assign({}, cur, patch);
  // 同じ状態への遷移も記録は残す（誰がいつ何を試みたかは監査上の情報）が、書き込みは差分があるときだけ
  const changed = LICENSE_STATE_COLUMNS.some(function(k){ return after[k] !== cur[k]; });
  if(changed) updateLicenseCaseRaw_(licenseId, patch);
  logEvent_('license_case', licenseId, ctx.actor || 'system',
    Object.assign({ transition_event: event }, cur),
    Object.assign({ transition_event: event, reason: ctx.reason || '' }, after));
  return { before: cur, after: after, event: event, changed: changed };
}

/** 状態列以外の更新。状態列を渡したら拒否（直接更新の抜け道を残さない）。 */
function updateLicenseCaseInfo_(licenseId, patch){
  patch = patch || {};
  const bad = Object.keys(patch).filter(function(k){ return LICENSE_STATE_COLUMNS.indexOf(k) >= 0; });
  if(bad.length) throw new Error('STATE_ERROR: 状態列は transitionLicenseCase_ で変更してください: ' + bad.join(', '));
  return updateLicenseCaseRaw_(licenseId, patch);
}

/** 契約ID → SPLL番号（Contracts.license_id、無ければ Applications.license_id）。旧データは空。 */
function licenseIdOfContract_(contractId){
  if(!contractId) return '';
  const c = readRows_(ssOps_(), 'Contracts').find(function(x){ return x.contract_id === contractId; });
  if(!c) return '';
  if(c.license_id) return String(c.license_id);
  if(c.application_id){
    const a = readRows_(ssOps_(), 'Applications').find(function(x){ return x.application_id === c.application_id; });
    if(a && a.license_id) return String(a.license_id);
  }
  return '';
}

/** 申込ID → SPLL番号（Applications.license_id）。申込段階の通知（送信失敗など）は契約が無いのでこちらで引く。 */
function licenseIdOfApplication_(applicationId){
  if(!applicationId) return '';
  const a = readRows_(ssOps_(), 'Applications').find(function(x){ return x.application_id === String(applicationId); });
  return a && a.license_id ? String(a.license_id) : '';
}

/** 案件の遷移履歴（Events の license_case エントリ）。管理画面のタイムライン用。 */
function licenseTimeline_(licenseId){
  return readRows_(ssOps_(), 'Events')
    .filter(function(e){ return e.entity_type === 'license_case' && e.entity_id === licenseId; })
    .map(function(e){
      const before = parseJson_(e.before, {}) || {}, after = parseJson_(e.after, {}) || {};
      return { occurred_at: String(e.occurred_at || ''), actor: String(e.actor || ''),
        event: String(after.transition_event || before.transition_event || ''),
        reason: String(after.reason || ''),
        before: before, after: after };
    })
    .sort(function(a, b){ return String(a.occurred_at).localeCompare(String(b.occurred_at)); });
}

/** 認証状態（CERT_STATES）から、対応する遷移イベントを選ぶ。applyCertStatus_ から使う。 */
function certificateEventFor_(status, currentCertStatus){
  const s = String(status || '');
  if(s === 'ACTIVE') return certExists_(currentCertStatus) ? 'CERTIFICATE_RESTORED' : 'CERTIFICATE_ISSUED';
  if(s === 'REVOKED') return 'CERTIFICATE_REVOKED';
  if(s === 'TERMINATED') return 'CONTRACT_TERMINATED';
  return 'CERTIFICATE_SUSPENDED';   // SUSPENDED / PAYMENT_HOLD / EXPIRED
}
