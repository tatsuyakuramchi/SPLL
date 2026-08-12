/** SPLL 45_settlement ― 半期清算・仕入明細書（みなし合意）・配分スキーム */


// ============================================================
// 7. 半期清算・計算書（仕入明細書方式・みなし合意）
// ============================================================
/**
 * 半期バッチ：確定済(APPROVED/LOCKED)の利用報告を集計し、パートナー別の
 * 計算書（仕入明細書方式・DRAFT）を生成する。
 * 計算チェーン（per Usage_Report）:
 *   net_sales → ×royalty_rate = license_fee → ×(1 - handling_fee_rate) = partner_share
 *   （rate は作品の royalty_rate 列、無ければ Config の既定値。スナップショットを保存）
 * 既に当期の有効な計算書がある場合は二重生成を避けてスキップする。
 */
function generateStatements_(period){
  period = period || currentPeriod_();
  // 冪等（V2-011）：清算済み report_id を除外し、後から承認された報告だけを追加清算できる
  const settled = {}; readRows_(ssOps_(),'Settlement_Details').forEach(function(d){ if(d.report_id) settled[d.report_id] = true; });
  const reports = readRows_(ssOps_(),'Usage_Reports')
    .filter(r => String(r.period)===String(period) && (r.status==='APPROVED' || r.status==='LOCKED') && !settled[r.report_id]);
  if(!reports.length) return { period:period, reports:0, generated:0, statements:[], skipped:'新規の清算対象報告なし' };
  // 契約→対象原作スナップショット（V2-011：Works_Master再解決を原則禁止。旧データのみフォールバック）
  const ctrWorks = {}; readRows_(ssOps_(),'Contract_Works').forEach(x => { (ctrWorks[x.contract_id] = ctrWorks[x.contract_id] || []).push(x); });
  const workById = {}; readRows_(ssMaster_(),'Works_Master').forEach(w => { workById[w.work_id] = w; });
  const partners = readRows_(ssOps_(),'Partners');
  /** 配分単位の権利者情報：スナップショット優先（無い旧契約のみマスタ解決し警告） */
  function partnerOf_(cw){
    if(cw && cw.partner_id_snapshot){
      return { partner_id:cw.partner_id_snapshot, name:cw.partner_name_snapshot || cw.partner_id_snapshot,
        invoice_reg_number:cw.invoice_reg_number_snapshot || '' };
    }
    logEvent_('settlement','snapshot-fallback','system',null,{ contract_work_id:cw && cw.contract_work_id, warn:'契約時スナップショット無し・マスタ解決' });
    return resolveWorkPartner_(workById[cw && cw.work_id] || { work_id:(cw&&cw.work_id)||'', publisher:'' }, partners);
  }

  const defaultRate  = num_(getConfig_('DEFAULT_ROYALTY_RATE', '0.10'));   // 既定ロイヤリティ率（フォールバック）
  const handlingRate = num_(getConfig_('HANDLING_FEE_RATE',   '0.30'));    // 事務手数料率
  // 契約ごとの売上連動率（締結時の別紙2スナップショット）。RATE以外・未設定は既定率にフォールバック。
  const ctrRate = {};
  readRows_(ssOps_(),'Contracts').forEach(function(c){
    let rate = null;
    if(c.terms_snapshot){ try{ const t = JSON.parse(c.terms_snapshot);
      if(t && String(t.fee_model).toUpperCase()==='RATE' && t.rate!=null && t.rate!=='') rate = num_(t.rate); }catch(e){} }
    ctrRate[c.contract_id] = rate;
  });

  // 配分スキーム（修正設計書 FLOW-04/§12.1）：暗黙のパートナー数均等を廃止し、方式を明示。
  //   BY_WORK_EQUAL（既定）＝対象原作数で均等配分（同一権利者の複数原作分は合算）
  //   BY_PARTNER_EQUAL     ＝重複除外した権利者数で均等配分
  const scheme = String(getConfig_('DEFAULT_ALLOCATION_SCHEME', 'BY_WORK_EQUAL')).toUpperCase();

  const byPartner = {};  // partner_id -> { partner, details:[], total }
  reports.forEach(r => {
    const net = num_(r.net_sales);
    const royaltyRate  = (ctrRate[r.contract_id] != null) ? ctrRate[r.contract_id] : defaultRate;
    const licenseFee   = Math.round(net * royaltyRate);
    const partnerShare = Math.round(licenseFee * (1 - handlingRate));
    const cwList = ctrWorks[r.contract_id] || [];
    // 契約ごとの配分方式：契約時スナップショット優先（V2-011）
    const ctrScheme = (cwList[0] && String(cwList[0].allocation_scheme_snapshot||'').toUpperCase()) || scheme;
    // 配分単位のリストを作る：{ work_id, partner, ratio }
    let units = [];
    if(ctrScheme === 'BY_PARTNER_EQUAL'){
      const pmap = {};
      cwList.forEach(function(cw){ const p = partnerOf_(cw); pmap[p.partner_id] = p; });
      const plist = Object.keys(pmap).map(function(k){ return pmap[k]; });
      units = (plist.length ? plist : [{ partner_id:'UNKNOWN', name:'(未割当)', invoice_reg_number:'' }])
        .map(function(p){ return { work_id:'', partner:p, ratio: 1 / Math.max(1, plist.length || 1) }; });
    } else {  // BY_WORK_EQUAL（既定）
      const list = cwList.length ? cwList : [null];
      units = list.map(function(cw){
        return { work_id:(cw ? cw.work_id : ''), partner:(cw ? partnerOf_(cw) : { partner_id:'UNKNOWN', name:'(未割当)', invoice_reg_number:'' }), ratio: 1 / list.length };
      });
    }
    let allocated = 0;
    units.forEach(function(u, idx){
      const amt = (idx === units.length - 1) ? (partnerShare - allocated) : Math.floor(partnerShare * u.ratio);  // 端数は末尾へ
      allocated += amt;
      const key = u.partner.partner_id;
      if(!byPartner[key]) byPartner[key] = { partner:u.partner, details:[], total:0 };
      byPartner[key].details.push({
        contract_id: r.contract_id, report_id: r.report_id, work_id: u.work_id, partner_id: u.partner.partner_id,
        allocation_scheme: ctrScheme, allocation_ratio: Math.round(u.ratio * 10000) / 10000,
        rate_snapshot: JSON.stringify({ royalty_rate:royaltyRate, handling_fee_rate:handlingRate,
          net_sales:net, license_fee:licenseFee, scheme:scheme, ratio:u.ratio, report_id:r.report_id }),
        amount: amt
      });
      byPartner[key].total += amt;
    });
  });

  const out = [];
  Object.keys(byPartner).forEach(pid => {
    const grp = byPartner[pid];
    const settlementId = newId_('STL');
    appendRow_(ssOps_(),'Settlements',{ settlement_id:settlementId, partner_id:pid,
      period:period, amount:grp.total, status:'DRAFT', hold_reason:'' });
    grp.details.forEach(d => appendRow_(ssOps_(),'Settlement_Details',{
      settlement_detail_id:newId_('STD'), settlement_id:settlementId,
      contract_id:d.contract_id, report_id:d.report_id||'', work_id:d.work_id||'', partner_id:d.partner_id||'',
      allocation_scheme:d.allocation_scheme||'', allocation_ratio:d.allocation_ratio||'',
      rate_snapshot:d.rate_snapshot, amount:d.amount }));
    const statementId = newId_('STM');
    appendRow_(ssOps_(),'Settlement_Statements',{ statement_id:statementId,
      settlement_id:settlementId, partner_id:pid, period:period, type:'PARTNER',
      reg_number_snapshot: grp.partner.invoice_reg_number || '',   // 登録番号(T番号)スナップショット
      status:'DRAFT', effective_date:'', objection_due:'', pdf_file_id:'', sheet_id:'',
      version:1, sent_at:'', finalized_at:'' });
    logEvent_('settlement_statement', statementId, 'system', null,
      {status:'DRAFT', period:period, partner_id:pid, amount:grp.total, details:grp.details.length});
    out.push({ statement_id:statementId, partner:grp.partner.name, amount:grp.total, details:grp.details.length });
  });
  return { period:period, reports:reports.length, generated:out.length, statements:out };
}

/** 作品→パートナーの解決（partner_id列 → 出版社名突合 → 疑似パートナー） */
function resolveWorkPartner_(work, partners){
  if(work.partner_id){
    const p = partners.find(x => x.partner_id===work.partner_id);
    if(p) return p;
  }
  const pub = String(work.publisher||'');
  if(pub){
    const p = partners.find(x => x.name && (pub.indexOf(x.name)>=0 || String(x.name).indexOf(pub)>=0));
    if(p) return p;
  }
  return { partner_id: pub ? ('PUB:'+pub) : 'UNKNOWN', name: pub || '(未割当)', invoice_reg_number:'' };
}

/**
 * 承認済(APPROVED)の計算書を CloudSign 送信（みなし合意）：
 * 発効日=本日、異議期限=発効日+1ヶ月（OBJECTION_DAYS_RULE）に設定し SENT へ。
 */
function batch_sendApprovedStatements_(){
  const today = new Date();
  const eff = today.toISOString().slice(0,10);
  const due = addMonthsIso_(today, 1).slice(0,10);
  const list = readRows_(ssOps_(),'Settlement_Statements').filter(s => s.status==='APPROVED');
  let sent = 0, failed = 0;
  list.forEach(s => {
    // 冪等（V2-012）：既に外部書類IDがある・送信済みはスキップ（二重送信防止）
    if(s.cloudsign_document_id || s.send_status === 'SENT'){ return; }
    const attemptId = Utilities.getUuid();
    updateRow_(ssOps_(),'Settlement_Statements','statement_id',s.statement_id,
      { status:'SENDING', send_attempt_id:attemptId });
    try{
      const docId = cloudSignSendStatement_(s);
      updateRow_(ssOps_(),'Settlement_Statements','statement_id',s.statement_id,
        { status:'OBJECTION_PERIOD', effective_date:eff, objection_due:due, sent_at:today.toISOString(),
          cloudsign_document_id:docId||'', send_status:'SENT', send_error:'' });
      updateRow_(ssOps_(),'Settlements','settlement_id',s.settlement_id,{ status:'SENT' });
      logEvent_('settlement_statement', s.statement_id, 'system', {status:'APPROVED'},
        {status:'OBJECTION_PERIOD', effective_date:eff, objection_due:due, cloudsign_document_id:docId||''});
      sent++;
    }catch(err){
      // 外部送信の成否不明を含む失敗：SEND_FAILED として手動確認へ（自動再送しない）
      updateRow_(ssOps_(),'Settlement_Statements','statement_id',s.statement_id,
        { status:'SEND_FAILED', send_status:'FAILED', send_error:String(err && err.message || err).slice(0,300) });
      logError_('EXTERNAL_API_ERROR','sendStatement', err, { statement_id:s.statement_id, attempt:attemptId });
      failed++;
    }
  });
  return { sent:sent, failed:failed };
}

/** 計算書（仕入明細書）をPDF化→Drive保存→CloudSign送信（みなし合意付き） */
function cloudSignSendStatement_(statement){
  const partner = readRows_(ssOps_(),'Partners').find(p => p.partner_id===statement.partner_id) || {};
  const pdf  = buildStatementPdf_(statement, partner);
  const file = DriveApp.getFolderById(cfg_('DRIVE_ROOT'))
    .createFile(pdf.setName('statement_' + statement.period + '_' + statement.partner_id + '.pdf'));
  updateRow_(ssOps_(),'Settlement_Statements','statement_id',statement.statement_id,{ pdf_file_id: file.getId() });

  const title = 'SPLL 仕入明細書 ' + statement.period + '（' + (partner.name || statement.partner_id) + '）';
  const note  = 'みなし合意：発効日から1ヶ月以内にご異議のない場合、本仕入明細書の内容にご同意いただいたものとみなします。';
  const doc   = cs_createDocument_(title, note);
  cs_attachFile_(doc.id, file.getBlob(), file.getName());
  if(partner.contact) cs_addParticipant_(doc.id, partner.contact, partner.name || '');
  cs_sendDocument_(doc.id);
  logEvent_('settlement_statement', statement.statement_id, 'cloudsign', null,
    { cloudsign_document_id: doc.id, pdf_file_id: file.getId(), sandbox: cs_isSandbox_() });
  return doc.id;
}

/** 仕入明細書PDFを生成（明細＝Settlement_Details、登録番号スナップショット付き） */
function buildStatementPdf_(statement, partner){
  const details = readRows_(ssOps_(),'Settlement_Details')
    .filter(d => d.settlement_id===statement.settlement_id);
  const rows = details.map(d => {
    let snap = {}; try{ snap = JSON.parse(d.rate_snapshot || '{}'); }catch(e){}
    return '<tr><td>' + (d.contract_id||'') + '</td><td style="text-align:right">' + (snap.net_sales!=null?snap.net_sales:'') +
      '</td><td style="text-align:right">' + (snap.royalty_rate!=null?snap.royalty_rate:'') +
      '</td><td style="text-align:right">' + (snap.handling_fee_rate!=null?snap.handling_fee_rate:'') +
      '</td><td style="text-align:right">' + (d.amount||0) + '</td></tr>';
  }).join('');
  const total = details.reduce((s,d)=> s + num_(d.amount), 0);
  const html = '<html><head><meta charset="utf-8"><style>body{font-family:sans-serif;}'
    + 'table{border-collapse:collapse;width:100%;}th,td{border:1px solid #999;padding:6px;font-size:12px;}'
    + 'th{background:#eee;}</style></head><body>'
    + '<h1>仕入明細書</h1>'
    + '<p>対象期：' + (statement.period||'') + '　／　パートナー：' + (partner.name || statement.partner_id || '') + '</p>'
    + '<p>登録番号：' + (statement.reg_number_snapshot || partner.invoice_reg_number || '（未登録）') + '</p>'
    + '<table><thead><tr><th>契約ID</th><th>純売上</th><th>ロイヤリティ率</th><th>事務手数料率</th><th>配分額</th></tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '<tfoot><tr><th colspan="4" style="text-align:right">合計</th><th style="text-align:right">' + total + '</th></tr></tfoot></table>'
    + '<p style="font-size:11px;color:#555;margin-top:14px;">本明細は仕入明細書方式により作成しています。発効日から1ヶ月以内にご異議のない場合、内容にご同意いただいたものとみなします。</p>'
    + '</body></html>';
  return Utilities.newBlob(html, 'text/html', 'statement.html').getAs('application/pdf');
}

/**
 * 日次：異議期間（発効日＋1ヶ月）到来かつ無申出を NO_OBJECTION_RECORDED → FINALIZED へ。
 * ※ 相手方の積極的確認と誤認されうる CONFIRMED は使用しない。
 */
function confirmDeemed_(){
  const now = new Date();
  readRows_(ssOps_(),'Settlement_Statements')
    .filter(s=> s.status==='OBJECTION_PERIOD' && s.objection_due && new Date(s.objection_due) <= now)
    .forEach(s=> {
      updateRow_(ssOps_(),'Settlement_Statements','statement_id',s.statement_id,
        {status:'NO_OBJECTION_RECORDED', finalized_at: now.toISOString()});
      if(s.settlement_id) updateRow_(ssOps_(),'Settlements','settlement_id',s.settlement_id,{status:'NO_OBJECTION_RECORDED'});
      logEvent_('settlement_statement', s.statement_id, 'system', {status:'OBJECTION_PERIOD'}, {status:'NO_OBJECTION_RECORDED'});
    });
}

// ============================================================
// Finance引渡の取込（RP-001 §10.3）。Finance側バッチとして動作し、
// READYの引渡を受領（ACCEPTED）して債権（FLAT/PER_WORK請求）を生成する。
// 冪等：license_id+handoff_version はREADY→ACCEPTEDの一方向のみ。請求は契約単位の既存重複チェックで防止。
// ============================================================
function financeAcceptHandoffs_(){
  const ops = ssOps_();
  const handoffs = readRows_(ops, 'Finance_Handoffs').filter(function(h){ return h.status === 'READY'; });
  let accepted = 0, errors = 0;
  handoffs.forEach(function(h){
    try{
      const contract = readRows_(ops, 'Contracts').find(function(c){
        return c.license_id === h.license_id && c.status === 'SIGNED'; });
      if(contract) createInvoiceOnSigning_(contract.contract_id);   // FLAT/PER_WORKの債権生成（重複は内部で防止）
      updateRow_(ops, 'Finance_Handoffs', 'handoff_id', h.handoff_id,
        { status: 'ACCEPTED', accepted_at: new Date().toISOString() });
      updateLicenseCase_(h.license_id, { finance_handoff_status: 'ACCEPTED' });
      logEvent_('finance_handoff', h.handoff_id, 'finance', { status:'READY' },
        { status:'ACCEPTED', license_id: h.license_id, version: h.handoff_version });
      accepted++;
    }catch(err){
      updateRow_(ops, 'Finance_Handoffs', 'handoff_id', h.handoff_id, { status: 'ERROR' });
      updateLicenseCase_(h.license_id, { finance_handoff_status: 'ERROR' });
      logError_('PROCESSING_ERROR', 'financeAcceptHandoff', err, { handoff_id: h.handoff_id, license_id: h.license_id });
      errors++;
    }
  });
  return { processed: handoffs.length, accepted: accepted, errors: errors };
}
