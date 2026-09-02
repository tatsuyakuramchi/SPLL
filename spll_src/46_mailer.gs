/**
 * SPLL 46_mailer ― 締結後の案内メール自動送信
 *
 * 送るのは「今後のお手続き」案内ページのURLだけ。振込先・口座情報は本文へ書かない。
 *   ・口座変更が過去のメールと食い違わない（案内ページは常に最新）
 *   ・当社を騙る振込先メールとの区別がつく（正規の導線がページ1つに定まる）
 *
 * 送信は5分バッチ（Notification_Queue の GUIDE_READY）で行う。締結Webhookの中で送らないのは、
 * メール障害・送信上限で締結処理そのものを失敗させないため。失敗は再試行し、上限で人手対応へ戻す。
 */

const GUIDE_EMAIL_DEFAULT_SUBJECT = '【SPLL】ご契約ありがとうございます／今後のお手続きのご案内（{{license_id}}）';
const GUIDE_EMAIL_DEFAULT_BODY = [
  '{{party_name}} 様',
  '',
  'このたびはSPLL利用許諾契約をご締結いただき、ありがとうございます。',
  'お客様のSPLL番号と、今後のお手続き（利用許諾料のお支払い・作品のご提出・審査完了後の認証バッジの受け取り）を',
  '下記のご案内ページにまとめております。ブックマークのうえご利用ください。',
  '',
  '　SPLL番号：{{license_id}}',
  '　ご案内ページ：{{guide_url}}',
  '',
  '※ お振込先はご案内ページに掲載しています。当事務局がメール本文で口座情報をお知らせすることはありません。',
  '　 口座情報が書かれたメールを受け取られた場合は、内容を実行せず事務局までご連絡ください。',
  '',
  '{{office_contact}}'
].join('\n');

const GUIDE_EMAIL_MAX_ATTEMPTS = 3;

/** 自動送信が有効か（既定は有効。停止したい場合はConfigで false） */
function guideEmailEnabled_(){
  return String(getConfig_('GUIDE_EMAIL_AUTO_SEND','true')).toLowerCase() !== 'false';
}

/** 差込：{{license_id}} {{party_name}} {{guide_url}} {{office_contact}} {{usage_category}} {{works}} */
function renderTemplate_(tpl, vars){
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, function(_, k){
    return vars[k] === undefined || vars[k] === null ? '' : String(vars[k]);
  });
}

/** 通知1件から差込値を組み立てる（送信先・本文の材料） */
function guideMailVars_(notif){
  const payload = parseJson_(notif.payload_json, {});
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === notif.contract_id; }) || {};
  const kase = c.license_id
    ? (readRows_(ssOps_(),'License_Cases').find(function(k){ return k.license_id === c.license_id; }) || {}) : {};
  return {
    to: normalizeEmail_(c.contact_email || kase.contact_email || ''),
    license_id: c.license_id || '',
    party_name: kase.party_display_name || 'ご契約者',
    usage_category: c.usage_category || '',
    works: contractWorkNames_(notif.contract_id).join('、'),
    guide_url: String(payload.guide_url || ''),
    office_contact: getConfig_('OFFICE_CONTACT','')
  };
}

/**
 * 案内メールの自動送信（5分バッチ）。
 * 対象：GUIDE_READY かつ MANUAL_REQUIRED かつ 宛先・案内URLが揃っているもの。
 * 宛先が無いもの・送信上限・再試行上限のものは MANUAL_REQUIRED のまま残し、管理画面の要対応に出す。
 */
function batch_sendGuideEmails_(){
  if(!guideEmailEnabled_()) return { processed:0, skipped:'自動送信が無効（GUIDE_EMAIL_AUTO_SEND=false）' };
  const targets = readRows_(ssOps_(),'Notification_Queue')
    .filter(function(n){ return n.type === 'GUIDE_READY' && n.status === 'MANUAL_REQUIRED' &&
      num_(n.attempts) < GUIDE_EMAIL_MAX_ATTEMPTS; });
  if(!targets.length) return { processed:0, errors:0 };

  let quota = 100;
  try{ quota = num_(MailApp.getRemainingDailyQuota()); }catch(e){}
  let sent = 0, errors = 0, skipped = 0;
  targets.forEach(function(n){
    if(sent >= quota){ skipped++; return; }               // 送信上限に達したら次回バッチへ持ち越す
    const v = guideMailVars_(n);
    if(!v.to || !v.guide_url){ skipped++; return; }        // 宛先未取得は人手対応（要対応一覧に残る）
    try{
      sendGuideEmail_(v);
      updateRow_(ssOps_(),'Notification_Queue','notification_id',n.notification_id,
        { status:'SENT', sent_at:new Date().toISOString(), handled_by:'auto-mailer',
          attempts:num_(n.attempts)+1, last_error:'', sent_to_domain:(v.to.split('@')[1] || '') });
      logEvent_('notification', n.notification_id, 'system', { status:'MANUAL_REQUIRED' },
        { status:'SENT', channel:'EMAIL', to_domain:(v.to.split('@')[1] || '') });   // 宛先はドメインのみ記録
      sent++;
    }catch(err){
      const attempts = num_(n.attempts) + 1;
      const failed = attempts >= GUIDE_EMAIL_MAX_ATTEMPTS;
      updateRow_(ssOps_(),'Notification_Queue','notification_id',n.notification_id,
        { attempts:attempts, last_error:String(err && err.message || err).slice(0,300),
          status: failed ? 'SEND_FAILED' : 'MANUAL_REQUIRED' });
      logError_('EXTERNAL_API_ERROR','guideMail', err, { notification_id:n.notification_id, attempts:attempts });
      errors++;
    }
  });
  return { processed:sent, errors:errors, skipped:skipped };
}

/** 実送信（テンプレートはConfigで編集可能）。本文には口座情報を含めない。 */
function sendGuideEmail_(v){
  const subject = renderTemplate_(getConfig_('GUIDE_EMAIL_SUBJECT', GUIDE_EMAIL_DEFAULT_SUBJECT), v);
  const body    = renderTemplate_(getConfig_('GUIDE_EMAIL_BODY',    GUIDE_EMAIL_DEFAULT_BODY), v);
  const opts = { to:v.to, subject:subject, body:body, name: getConfig_('MAIL_FROM_NAME','TRPGライツ事務局') };
  const reply = normalizeEmail_(getConfig_('MAIL_REPLY_TO',''));
  if(reply) opts.replyTo = reply;
  MailApp.sendEmail(opts);
  return true;
}
