/**
 * SPLL 46_mailer ― 契約者への自動メール送信
 *
 * 送るのは「今後のお手続き」案内ページのURLだけ。振込先・口座情報は本文へ書かない。
 * 振込先は契約書本文（個別条件）にのみ記載する（RP-002 §9.1）。
 *   ・正規の口座が契約書にだけあるので、当社を騙る振込先メールとの区別がつく
 *   ・案内ページにも載せないため、口座情報がシステム側の設定として漏れる経路がない
 *
 * 送信は5分バッチ（Notification_Queue）で行う。締結Webhookや審査確定の処理の中で送らないのは、
 * メール障害・送信上限で業務処理そのものを失敗させないため。失敗は再試行し、上限で人手対応へ戻す。
 *
 * 自動送信する場面（種類ごとにテンプレートと停止スイッチを持つ）：
 *   GUIDE_READY        締結直後のご案内（作品提出の導線）
 *   REVIEW_RESULT      作品の審査完了（CLEARED のときだけ。上申中は人手対応のまま）
 *   BADGE_READY        認証バッジの発行完了
 *   CORRECTION_REQUEST 是正のお願い（審査コメントを載せるため既定は停止＝人が文面を確認して送る）
 */

const GUIDE_EMAIL_DEFAULT_SUBJECT = '【SPLL】ご契約ありがとうございます／今後のお手続きのご案内（{{license_id}}）';
const GUIDE_EMAIL_DEFAULT_BODY = [
  '{{party_name}} 様',
  '',
  'このたびはSPLL利用許諾契約をご締結いただき、ありがとうございます。',
  'お客様のSPLL番号と、今後のお手続き（作品のご提出・審査完了後の認証バッジの受け取り）を',
  '下記のご案内ページにまとめております。ブックマークのうえご利用ください。',
  '',
  '　SPLL番号：{{license_id}}',
  '　ご案内ページ：{{guide_url}}',
  '',
  '※ 利用許諾料のお振込先は契約書（個別条件）に記載しています。当事務局がメール本文やご案内ページで口座情報をお知らせすることはありません。',
  '　 口座情報が書かれたメールを受け取られた場合は、内容を実行せず事務局までご連絡ください。',
  '',
  '{{office_contact}}'
].join('\n');

const REVIEW_EMAIL_DEFAULT_SUBJECT = '【SPLL】ご提出作品の審査が完了しました（{{license_id}}）';
const REVIEW_EMAIL_DEFAULT_BODY = [
  '{{party_name}} 様',
  '',
  'ご提出いただいた作品の審査が完了しました。',
  '{{badge_note}}',
  '',
  '　SPLL番号：{{license_id}}',
  '　対象原作：{{works}}',
  '　ご案内ページ：{{guide_url}}',
  '',
  '認証バッジの受け取り・今後のお手続きは、上記のご案内ページからご確認いただけます。',
  '',
  '※ 当事務局がメールで口座情報をお知らせすることはありません（お振込先は契約書に記載しています）。',
  '',
  '{{office_contact}}'
].join('\n');

const BADGE_EMAIL_DEFAULT_SUBJECT = '【SPLL】認証バッジを発行しました（{{license_id}}）';
const BADGE_EMAIL_DEFAULT_BODY = [
  '{{party_name}} 様',
  '',
  '認証バッジの発行が完了しました。下記のご案内ページからダウンロードいただけます。',
  '',
  '　SPLL番号：{{license_id}}',
  '　ご案内ページ：{{guide_url}}',
  '',
  'バッジにはSPLL番号と検証用のQRコードが入っています。',
  'QRコードの読み取り先では、この認証が現在も有効であることを誰でも確認できます。',
  '頒布物へ掲載される際は、画像を加工せずそのままご利用ください。',
  '',
  '※ 当事務局がメールで口座情報をお知らせすることはありません（お振込先は契約書に記載しています）。',
  '',
  '{{office_contact}}'
].join('\n');

const CORRECTION_EMAIL_DEFAULT_SUBJECT = '【SPLL】ご提出作品について確認のお願い（{{license_id}}）';
const CORRECTION_EMAIL_DEFAULT_BODY = [
  '{{party_name}} 様',
  '',
  'ご提出いただいた作品について、下記の点をご確認ください。',
  '',
  '　SPLL番号：{{license_id}}',
  '　対象原作：{{works}}',
  '',
  '【確認をお願いする点】',
  '{{review_comment}}',
  '',
  'ご修正のうえ、下記のご案内ページから作品を再度ご提出ください。',
  '　ご案内ページ：{{guide_url}}',
  '',
  'ご不明な点がありましたら、このメールへご返信ください。',
  '',
  '{{office_contact}}'
].join('\n');

/**
 * 自動送信する通知の種類。
 *   config：<PREFIX>_AUTO_SEND / <PREFIX>_SUBJECT / <PREFIX>_BODY（管理コンソールで編集）
 *   auto  ：停止スイッチの既定値。是正のお願いだけは既定OFF（審査コメントをそのまま送るため）
 */
const MAIL_KINDS = [
  { type:'GUIDE_READY', prefix:'GUIDE_EMAIL', label:'締結直後のご案内', auto:'true',
    subject:GUIDE_EMAIL_DEFAULT_SUBJECT, body:GUIDE_EMAIL_DEFAULT_BODY },
  { type:'REVIEW_RESULT', prefix:'REVIEW_EMAIL', label:'作品の審査完了', auto:'true',
    subject:REVIEW_EMAIL_DEFAULT_SUBJECT, body:REVIEW_EMAIL_DEFAULT_BODY },
  { type:'BADGE_READY', prefix:'BADGE_EMAIL', label:'認証バッジの発行完了', auto:'true',
    subject:BADGE_EMAIL_DEFAULT_SUBJECT, body:BADGE_EMAIL_DEFAULT_BODY },
  { type:'CORRECTION_REQUEST', prefix:'CORRECTION_EMAIL', label:'是正のお願い', auto:'false',
    subject:CORRECTION_EMAIL_DEFAULT_SUBJECT, body:CORRECTION_EMAIL_DEFAULT_BODY }
];

const GUIDE_EMAIL_MAX_ATTEMPTS = 3;

/** 種類の定義を引く（未定義の通知タイプは自動送信の対象外） */
function mailKind_(type){
  return MAIL_KINDS.filter(function(k){ return k.type === String(type||''); })[0] || null;
}
/** その種類の自動送信が有効か（Configで停止できる） */
function mailKindEnabled_(type){
  const k = mailKind_(type); if(!k) return false;
  return String(getConfig_(k.prefix + '_AUTO_SEND', k.auto)).toLowerCase() !== 'false';
}
/** 案内メール（締結直後）の自動送信が有効か。旧名の互換。 */
function guideEmailEnabled_(){ return mailKindEnabled_('GUIDE_READY'); }

/**
 * 通知1件がメール送信の対象かどうか。
 * 審査結果は CLEARED のときだけ送る。上申（ESCALATED）は社内判断の途中であり、
 * 契約者へ「審査が完了しました」と伝えてはならないため、人手対応のまま残す。
 */
function mailSendable_(notif){
  if(!mailKindEnabled_(notif.type)) return false;
  if(notif.type === 'REVIEW_RESULT'){
    const p = parseJson_(notif.payload_json, {});
    return String(p.result || '') === 'CLEARED';
  }
  return true;
}

/** 差込：{{license_id}} {{party_name}} {{guide_url}} {{office_contact}} {{usage_category}} {{works}} {{review_comment}} */
function renderTemplate_(tpl, vars){
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, function(_, k){
    return vars[k] === undefined || vars[k] === null ? '' : String(vars[k]);
  });
}

/**
 * 通知1件から差込値を組み立てる（送信先・本文の材料）。
 * 案内ページURLは、締結時に払い出したものを再利用する（契約者が既に持っているリンクと同じものを案内する）。
 * 失効していれば発行し直す。guideUrlFor_ が両方を面倒みる。
 */
function notificationMailVars_(notif){
  const payload = parseJson_(notif.payload_json, {});
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === notif.contract_id; }) || {};
  const licenseId = String(notif.license_id || c.license_id || '');
  const kase = licenseId
    ? (readRows_(ssOps_(),'License_Cases').find(function(k){ return k.license_id === licenseId; }) || {}) : {};
  let guideUrl = String(payload.guide_url || '');
  if(!guideUrl && (licenseId || notif.contract_id)){
    try{ guideUrl = guideUrlFor_(licenseId || notif.contract_id); }catch(e){ guideUrl = ''; }
  }
  // バッジが既に出ているかで、審査完了メールの案内文を変える。
  // 審査CLEAREDの直後に発行できることも、Slides側の一時障害で後追いになることもあるため、
  // 「あらためて連絡します」と書いたまま同時に届く／「発行済みです」と書いたのに未発行、を防ぐ。
  let badgeIssued = false;
  try{ badgeIssued = !!issuedBadgeForLicense_(licenseId, notif.contract_id); }catch(e){}
  return {
    to: normalizeEmail_(c.contact_email || kase.contact_email || ''),
    license_id: licenseId,
    party_name: kase.party_display_name || 'ご契約者',
    usage_category: c.usage_category || '',
    works: contractWorkNames_(notif.contract_id).join('、'),
    guide_url: guideUrl,
    review_comment: String(payload.comment || ''),
    badge_note: badgeIssued
      ? '認証バッジも発行済みです。下記のご案内ページからダウンロードいただけます。'
      : '認証バッジの発行手続きに進みますので、しばらくお待ちください。発行が完了しましたら、あらためてメールでご連絡いたします。',
    office_contact: getConfig_('OFFICE_CONTACT','')
  };
}
/** 旧名（締結直後の案内メール専用だった頃の呼び名）。 */
function guideMailVars_(notif){ return notificationMailVars_(notif); }

/**
 * 契約者への自動メール送信（5分バッチ）。
 * 対象：MAIL_KINDS の種類 かつ MANUAL_REQUIRED かつ 宛先・案内URLが揃っているもの。
 * 宛先が無いもの・送信上限・再試行上限のものは MANUAL_REQUIRED のまま残し、管理画面の要対応に出す。
 */
function batch_sendNotificationEmails_(){
  const types = MAIL_KINDS.map(function(k){ return k.type; });
  if(!types.some(mailKindEnabled_)) return { processed:0, skipped:'自動送信がすべて無効です' };
  const targets = readRows_(ssOps_(),'Notification_Queue')
    .filter(function(n){ return types.indexOf(n.type) >= 0 && n.status === 'MANUAL_REQUIRED' &&
      num_(n.attempts) < GUIDE_EMAIL_MAX_ATTEMPTS && mailSendable_(n); });
  if(!targets.length) return { processed:0, errors:0 };

  let quota = 100;
  try{ quota = num_(MailApp.getRemainingDailyQuota()); }catch(e){}
  let sent = 0, errors = 0, skipped = 0;
  targets.forEach(function(n){
    if(sent >= quota){ skipped++; return; }               // 送信上限に達したら次回バッチへ持ち越す
    const v = notificationMailVars_(n);
    if(!v.to || !v.guide_url){ skipped++; return; }        // 宛先未取得は人手対応（要対応一覧に残る）
    try{
      sendNotificationEmail_(n.type, v);
      updateRow_(ssOps_(),'Notification_Queue','notification_id',n.notification_id,
        { status:'SENT', sent_at:new Date().toISOString(), handled_by:'auto-mailer',
          attempts:num_(n.attempts)+1, last_error:'', sent_to_domain:(v.to.split('@')[1] || '') });
      logEvent_('notification', n.notification_id, 'system', { status:'MANUAL_REQUIRED' },
        { status:'SENT', channel:'EMAIL', mail_type:n.type, to_domain:(v.to.split('@')[1] || '') });   // 宛先はドメインのみ記録
      sent++;
    }catch(err){
      const attempts = num_(n.attempts) + 1;
      const failed = attempts >= GUIDE_EMAIL_MAX_ATTEMPTS;
      updateRow_(ssOps_(),'Notification_Queue','notification_id',n.notification_id,
        { attempts:attempts, last_error:String(err && err.message || err).slice(0,300),
          status: failed ? 'SEND_FAILED' : 'MANUAL_REQUIRED' });
      logError_('EXTERNAL_API_ERROR','guideMail', err, { notification_id:n.notification_id, type:n.type, attempts:attempts });
      errors++;
    }
  });
  return { processed:sent, errors:errors, skipped:skipped };
}
/** 旧名。5分バッチ・テストからの呼び出し互換。 */
function batch_sendGuideEmails_(){ return batch_sendNotificationEmails_(); }

/** 実送信（テンプレートはConfigで編集可能）。本文には口座情報を含めない。 */
function sendNotificationEmail_(type, v){
  const k = mailKind_(type) || mailKind_('GUIDE_READY');
  const subject = renderTemplate_(getConfig_(k.prefix + '_SUBJECT', k.subject), v);
  const body    = renderTemplate_(getConfig_(k.prefix + '_BODY',    k.body), v);
  const opts = { to:v.to, subject:subject, body:body, name: getConfig_('MAIL_FROM_NAME','TRPGライツ事務局') };
  const reply = normalizeEmail_(getConfig_('MAIL_REPLY_TO',''));
  if(reply) opts.replyTo = reply;
  MailApp.sendEmail(opts);
  return true;
}
/** 旧名（締結直後の案内メール）。 */
function sendGuideEmail_(v){ return sendNotificationEmail_('GUIDE_READY', v); }
