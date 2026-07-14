/** SPLL 32_contract ― 契約成立処理：スナップショット・認証・バッジ・締結PDF・請求起票（GAS②/③共用） */


/** 締結済PDFをCloudSign APIから取得し、契約フォルダへハッシュ付きで保存（FUN-04/§8.2） */
function saveSignedPdf_(contractId, docId, doc){
  if(!prop_('CLOUDSIGN_CLIENT_ID')) return null;
  doc = doc || cs_fetch_('GET', '/documents/' + encodeURIComponent(docId), null, {});
  const files = (doc && doc.files) || [];
  if(!files.length) return null;
  const fileId = files[0].id || files[0].file_id;
  const res = UrlFetchApp.fetch(cs_baseUrl_() + '/documents/' + encodeURIComponent(docId) + '/files/' + encodeURIComponent(fileId),
    { method:'get', muteHttpExceptions:true, headers:{ Authorization:'Bearer ' + cloudSignAccessToken_() } });
  if(res.getResponseCode() >= 300) throw new Error('締結PDF取得 HTTP ' + res.getResponseCode());
  const blob = res.getBlob().setName('signed_' + contractId + '.pdf');
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; }) || {};
  const folder = contractSubFolder_(c, '01_Contract');
  const f = folder.createFile(blob);
  const fhash = sha256Bytes_(blob.getBytes());
  updateRow_(ssOps_(),'Contracts','contract_id',contractId,{ contract_file_id:f.getId(), contract_file_hash:fhash });
  logEvent_('contract', contractId, 'system', null, { contract_file_id:f.getId(), contract_file_hash:fhash });
  return f.getId();
}

/** 締結Webフックの text（"COMPLETED : <契約書タイトル> sent by …"）等から書類タイトルを取り出す */
function extractDocTitle_(body){
  if(body && body.title) return String(body.title);
  const m = String((body && body.text) || '').match(/:\s*(.+?)\s+sent by/i);
  return m ? m[1].trim() : String((body && body.text) || '');
}

/**
 * Application_Works → Contract_Works へスナップショット（既にあれば追加しない）。
 * 締結時点の作品名・権利者・クレジット等も固定保存（修正設計書 FLOW-02/§8.3）：
 * 契約後に原作マスタが変更されても、契約時点の条件を復元できる。
 */
function snapshotContractWorks_(contractId, applicationId){
  const already = readRows_(ssOps_(),'Contract_Works').some(function(x){ return x.contract_id === contractId; });
  if(already) return;
  const master = {}; readRows_(ssMaster_(),'Works_Master').forEach(function(w){ master[w.work_id] = w; });
  readRows_(ssOps_(),'Application_Works').filter(function(x){ return x.application_id === applicationId; })
    .forEach(function(x){
      const w = master[x.work_id] || {};
      appendRow_(ssOps_(),'Contract_Works',{ contract_work_id:newId_('CW'), contract_id:contractId, work_id:x.work_id,
        work_name_snapshot:sanitizeCell_(w.work_name||''), publisher_snapshot:sanitizeCell_(w.publisher||''),
        credit_snapshot:sanitizeCell_(w.credit_text||''), partner_id_snapshot:w.partner_id||'' });
    });
}

/** 締結時点の利用目的と別紙2条件を契約へスナップショット（法務証跡）。料金表の後日変更に影響されない。 */
function snapshotContractTerms_(contractId, app){
  const usage = (app && app.usage_category) || '';
  const workCount = readRows_(ssOps_(),'Contract_Works').filter(function(x){ return x.contract_id === contractId; }).length || 1;
  const terms = computeFeeTerms_(usage, workCount);
  updateRow_(ssOps_(),'Contracts','contract_id',contractId,
    { usage_category: usage, terms_snapshot: JSON.stringify(terms) });
  return terms;
}

/** 締結後の発行処理（認証ACTIVE＋バッジ＋提出/報告トークン＋定額系の請求起票）。冪等。紐付け完了時に呼ぶ。 */
function finishContractLinkage_(contractId){
  const cert = issueCert_(contractId);   // 平文コードはここでのみ取得可能（バッジQRへ焼き込む）
  if(prop_('BADGE_AUTO') !== 'false'){ try{ issueBadge_(contractId, cert && cert.verify_url); }catch(e){ logEvent_('badge', contractId, 'system', null, { issue_error:String(e) }); } }
  prepareSubmissionToken_(contractId);
  issueToken_(contractId, 'REPORT', 400, 24);              // 利用報告トークン（約13ヶ月・最大24回）
  try{ createInvoiceOnSigning_(contractId); }              // FLAT / PER_WORK は締結時に請求起票（FUN-02）
  catch(e){ logError_('PROCESSING_ERROR','createInvoiceOnSigning', e, { contract_id:contractId }); }
}

/** FLAT/PER_WORK 契約の請求を締結時に起票（無償・RATEは起票しない）。冪等。 */
function createInvoiceOnSigning_(contractId){
  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; });
  if(!c || !c.terms_snapshot) return null;
  if(readRows_(ssOps_(),'Invoices').some(function(v){ return v.contract_id === contractId && v.source_type === 'CONTRACT'; })) return null;
  let t = {}; try{ t = JSON.parse(c.terms_snapshot); }catch(e){ return null; }
  const model = String(t.fee_model||'').toUpperCase();
  if(model !== 'FLAT' && model !== 'PER_WORK') return null;    // RATE は利用報告承認後に起票
  const amount = num_(t.amount);
  if(amount <= 0){ logEvent_('invoice', contractId, 'system', null, { skipped:'NOT_REQUIRED（無償）' }); return null; }
  const invId = newId_('INV');
  appendRow_(ssOps_(),'Invoices',{ invoice_id:invId, contract_id:contractId, period:currentPeriod_(),
    source_type:'CONTRACT', source_id:contractId, amount_rule:t.fee_amount_or_rate||'', amount:amount,
    status:'入金待ち', issued_at:new Date().toISOString().slice(0,10) });
  logEvent_('invoice', invId, 'system', null, { contract_id:contractId, amount:amount, model:model });
  return invId;
}

/**
 * Webフックから application_ref を取り出す。
 * CloudSign締結Webhookのペイロードは { documentID, status, userID, email, text } のみで、
 * フォーム入力値は含まれない。application_ref は契約書タイトル（text 内 "COMPLETED : <タイトル> sent by …"）
 * に埋め込む運用とし、まず text から抽出。取れなければ書類取得APIでタイトルを引いてフォールバック。
 */
function extractApplicationRef_(body, e){
  var ref = body.application_ref || body.reference || body.external_id ||
    (body.metadata && body.metadata.application_ref) ||
    (e && e.parameter && e.parameter.ref) ||
    refFromText_(body.text) || refFromText_(body.title) || refFromText_(body.subject) || '';
  if(ref) return ref;
  // フォールバック：CloudSign API で書類を取得し、タイトル・入力フィールド・参加者名まで走査して抽出
  var docId = body.documentID || body.document_id || body.id || (e && e.parameter && e.parameter.documentID);
  if(docId && prop_('CLOUDSIGN_CLIENT_ID')){
    try{ var doc = cs_fetch_('GET', '/documents/' + docId, null, {}); ref = refFromText_(JSON.stringify(doc)) || ''; }
    catch(_){ /* 取得不能時は空 → 未紐付けとして記録し手動紐付けに委ねる */ }
  }
  return ref || '';
}

// ============================================================
// 12. 認証バッジ（クレジット表記）：入金確認後にPNG3サイズを発行・配布
//     Google Slidesで1枚を組版→サムネイル(LARGE/MEDIUM/SMALL)をPNG化→Drive保存→トークンDLページ＋メール。
// ============================================================
const BADGE_SIZES = [{ key:'L', size:'LARGE' }, { key:'M', size:'MEDIUM' }, { key:'S', size:'SMALL' }];

// B経路固定：認証・バッジは締結時に発行（課金モデル分岐なし）。

/** バッジ発行（契約単位・冪等）。BADGE_TEMPLATE_IDがあればテンプレ差込、無ければ自動組版。 */
function issueBadge_(contractId, verifyUrl){
  const existing = readRows_(ssOps_(),'Badges').find(function(b){ return b.contract_id === contractId && b.status === 'ISSUED'; });
  if(existing) return { badge_id: existing.badge_id, reused:true };

  const c = readRows_(ssOps_(),'Contracts').find(function(x){ return x.contract_id === contractId; });
  if(!c) throw new Error('契約が見つかりません: ' + contractId);
  // 複数原作：Contract_Works からまとめた表示名を使う（契約単位のバッジ）
  const w = { work_name: contractWorkNames_(contractId).join('、'), credit_text:'', verify_url: verifyUrl || '' };
  const badgeId  = newId_('BDG');
  const issuedAt = new Date().toISOString().slice(0,10);

  const presId = buildBadgeSlide_(badgeId, w, c, issuedAt);
  const folder = badgeFolder_(c);
  const files = BADGE_SIZES.map(function(s){
    const blob = slideThumbnailPng_(presId, s.size).setName('SPLL_badge_' + badgeId + '_' + s.key + '.png');
    const f = folder.createFile(blob);
    try{ f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}
    return { size:s.key, file_id:f.getId() };
  });
  try{ DriveApp.getFileById(presId).setTrashed(true); }catch(e){}   // 一時Slidesは破棄

  appendRow_(ssOps_(),'Badges', { badge_id:badgeId, contract_id:contractId,
    issued_at:issuedAt, png_l:files[0].file_id, png_m:files[1].file_id, png_s:files[2].file_id,
    token_hash:'', status:'ISSUED' });
  distributeBadge_(c, badgeId);
  logEvent_('badge', badgeId, 'system', null, { contract_id:contractId, files:files });
  return { badge_id:badgeId, files:files };
}

/** バッジ1枚をSlidesで組版し presentationId を返す */
function buildBadgeSlide_(badgeId, w, c, issuedAt){
  const templateId = prop_('BADGE_TEMPLATE_ID');
  if(templateId){
    const copy = DriveApp.getFileById(templateId).makeCopy('SPLL_badge_' + badgeId);
    const pres = SlidesApp.openById(copy.getId());
    pres.replaceAllText('{{work_name}}', w.work_name || '');
    pres.replaceAllText('{{license_id}}', c.contract_id || '');
    pres.replaceAllText('{{issued_at}}', issuedAt);
    pres.replaceAllText('{{credit}}', w.credit_text || '');
    pres.replaceAllText('{{verify_url}}', w.verify_url || '');
    pres.saveAndClose();
    return pres.getId();
  }
  // テンプレ未設定：暫定デザインを自動組版（検証URLを記載＝QR相当の照合手段）
  const pres  = SlidesApp.create('SPLL_badge_' + badgeId);
  const slide = pres.getSlides()[0];
  slide.getBackground().setSolidFill('#3D2F6B');
  var t;
  t = slide.insertTextBox('SPLL 正規ライセンス', 36, 40, 648, 60);
  t.getText().getTextStyle().setForegroundColor('#FFFFFF').setBold(true).setFontSize(28);
  t = slide.insertTextBox(w.work_name || '', 36, 120, 648, 70);
  t.getText().getTextStyle().setForegroundColor('#F4EBD8').setBold(true).setFontSize(24);
  t = slide.insertTextBox('ライセンスID: ' + (c.contract_id || '') + '\n発行日: ' + issuedAt, 36, 205, 648, 70);
  t.getText().getTextStyle().setForegroundColor('#D7CFEC').setFontSize(14);
  t = slide.insertTextBox(w.credit_text || '', 36, 285, 648, 40);
  t.getText().getTextStyle().setForegroundColor('#EDEAF4').setFontSize(12);
  if(w.verify_url){
    t = slide.insertTextBox('検証: ' + w.verify_url, 36, 330, 648, 30);
    t.getText().getTextStyle().setForegroundColor('#A99FC4').setFontSize(9);
  }
  pres.saveAndClose();
  return pres.getId();
}

/** Slides REST の getThumbnail でPNG化（size: LARGE/MEDIUM/SMALL） */
function slideThumbnailPng_(presId, size){
  const pageId = SlidesApp.openById(presId).getSlides()[0].getObjectId();
  const url = 'https://slides.googleapis.com/v1/presentations/' + presId + '/pages/' + pageId +
    '/thumbnail?thumbnailProperties.thumbnailSize=' + size + '&thumbnailProperties.mimeType=PNG';
  const meta = UrlFetchApp.fetch(url, { headers:{ Authorization:'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions:true });
  if(meta.getResponseCode() >= 300) throw new Error('Slides thumbnail HTTP ' + meta.getResponseCode() + ': ' + meta.getContentText());
  const contentUrl = JSON.parse(meta.getContentText()).contentUrl;
  return UrlFetchApp.fetch(contentUrl, { muteHttpExceptions:true }).getBlob();
}

/**
 * 当社からメールは送らない。バッジ取得URLは提出ページ（web_getSubmitContext）に表示され、
 * 用途別トークン（BADGE_DOWNLOAD・期限/回数付き）で配布する（修正設計書 §13.4）。
 */
function distributeBadge_(c, badgeId){
  const token = issueToken_(c.contract_id, 'BADGE_DOWNLOAD', 90, 20);
  let base = ''; try{ base = ScriptApp.getService().getUrl() || ''; }catch(e){}
  return (base||'') + '?page=badge&token=' + token;   // 利用時のみ使用（メール送信はしない）
}

// ============================================================
// 13. 認証（証明書）・検証ポータル・失効制御（案③）
//     締結で「有効」→ 台帳連動で後から失効可能。検証は固定ポータル＋ID照会。
//     配布は当社メールを使わず、利用者は「受付番号」でポータルからバッジ取得。
// ============================================================
const CERT_STATES = ['ACTIVE','SUSPENDED','REVOKED','EXPIRED','TERMINATED','PAYMENT_HOLD'];

/**
 * 締結時に認証を発行（ACTIVE）。照合コードは12桁の暗号学的乱数とし、台帳にはハッシュのみ保存
 * （修正設計書 §13.2）。平文コードは戻り値と検証URL（バッジQR用）でのみ扱う。
 */
function issueCert_(contractId){
  const existing = readRows_(ssOps_(),'Certificates').find(function(x){ return x.contract_id === contractId; });
  if(existing) return { cert_id:existing.cert_id, check_code:null, reused:true };
  const certId = newId_('CERT');
  const code = randCode_(12);
  const now = new Date().toISOString();
  appendRow_(ssOps_(),'Certificates',{ cert_id:certId, contract_id:contractId, status:'ACTIVE',
    reason_code:'ISSUED', reason_text:'締結により発行', requested_by:'system', approved_by:'system',
    legal_case_id:'', effective_at:now, check_code_hash:hash_(code), issued_at:now.slice(0,10) });
  logEvent_('certificate', certId, 'system', null, { contract_id:contractId, status:'ACTIVE' });
  return { cert_id:certId, check_code:code, verify_url:verifyUrl_(certId, code) };
}
