/** SPLL 52_admin_partnership ― パートナーシップ契約に基づく事務局運営（会議・議案・報告・清算記録） */

const PARTNERSHIP_TABLES_ = {
  Secretariat_Members: ['member_id','partner_id','partner_name_snapshot','partner_type','representative_name','representative_email','voting_right','chair_eligible','status','appointed_at','retired_at','created_by','created_at','updated_at'],
  Secretariat_Meetings: ['meeting_id','title','meeting_type','starts_at','ends_at','location','online_url','convened_by','chair_member_id','status','notice_sent_at','minutes_status','minutes_url','notes','created_by','created_at','updated_at'],
  Secretariat_Attendance: ['attendance_id','meeting_id','member_id','attendance_status','recorded_by','recorded_at'],
  Secretariat_Agendas: ['agenda_id','meeting_id','agenda_no','title','agenda_type','resolution_rule','proposer_member_id','proposer_partner_id','summary','proposal_text','contract_clause','conflict_note','status','deadline','computed_result','final_result','resolution_text','decided_at','chair_override','created_by','created_at','updated_at'],
  Secretariat_Votes: ['vote_id','agenda_id','member_id','partner_id','partner_type','vote','comment','cast_by','cast_at'],
  Secretariat_Reports: ['report_id','report_type','source_contract_id','partner_id','partner_name_snapshot','period_start','period_end','due_date','subject','license_summary','license_fee','usage_detail','status','submitted_at','evidence_url','material_request_status','material_request_note','reviewed_by','reviewed_at','notes','created_by','created_at','updated_at'],
  Secretariat_Settlements: ['settlement_id','settlement_type','period_label','period_start','period_end','partner_id','partner_name_snapshot','revenue_total','allocation_basis','distribution_amount','expense_share','net_amount','due_date','status','reported_at','approved_at','paid_at','evidence_url','resolution_agenda_id','notes','created_by','created_at','updated_at']
};

function ensurePartnershipSheets_(){
  const ss = ssOps_();
  Object.keys(PARTNERSHIP_TABLES_).forEach(function(name){ ensureSheetColumns_(ss,name,PARTNERSHIP_TABLES_[name]); });
}
function admin_setupPartnershipGovernance(){
  requireRole_(['SYSTEM_ADMIN']); ensurePartnershipSheets_();
  logEvent_('partnership','setup',actor_(),null,{tables:Object.keys(PARTNERSHIP_TABLES_)}); return true;
}
function boolCell_(v){ return v === true || String(v).toLowerCase() === 'true' || String(v) === '1'; }
function isoDate_(v){ return String(v||'').slice(0,10); }
function nextMonthEnd_(dateLike){
  const s=String(dateLike||'').slice(0,10); const d=s?new Date(s+'T00:00:00'):new Date();
  return new Date(d.getFullYear(),d.getMonth()+2,0).toISOString().slice(0,10);
}
function partnerName_(partnerId){
  const p=readRows_(ssOps_(),'Partners').find(function(x){return String(x.partner_id)===String(partnerId||'');});
  return p?String(p.name||partnerId):String(partnerId||'');
}
function resolutionRuleForAgendaType_(type){
  switch(String(type||'')){
    case 'LICENSE_FEE_CHANGE':
    case 'REVENUE_DISTRIBUTION_CHANGE':
    case 'PARTNER_TYPE_CHANGE': return 'SPECIAL';
    case 'DISSOLUTION': return 'UNANIMOUS';
    case 'REPORT_ONLY': return 'REPORT_ONLY';
    default: return 'ORDINARY';
  }
}
function agendaTypeLabel_(type){
  const m={LICENSE_TERMS:'利用許諾条件',GUIDELINE:'ガイドライン',LICENSE_FEE_CHANGE:'ライセンス料改定',REVENUE_DISTRIBUTION_CHANGE:'収益分配変更',PARTNER_TYPE_CHANGE:'パートナー種別変更',PARTNER_ADMISSION:'パートナー参加条件',PARTNER_EXPULSION:'脱退・除名',RECOMMENDED_VENDOR:'推奨業者選定・評価',EXPENSE_ALLOCATION:'費用負担',DISSOLUTION:'解散',REPORT_ONLY:'報告事項',OTHER:'その他'};
  return m[String(type)]||String(type||'');
}

function admin_listSecretariatMembers(){ requireRole_([]); ensurePartnershipSheets_();
  return readRows_(ssOps_(),'Secretariat_Members').sort(function(a,b){return String(a.partner_name_snapshot||'').localeCompare(String(b.partner_name_snapshot||''));});
}
function admin_saveSecretariatMember(data){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_(); data=data||{};
  const pt=String(data.partner_type||''); if(['CORE','CONTENT'].indexOf(pt)<0) throw new Error('VALIDATION_ERROR: パートナー種別はCORE/CONTENTを指定してください');
  if(!String(data.representative_name||'').trim()) throw new Error('VALIDATION_ERROR: 構成員名は必須です');
  const now=new Date().toISOString(), id=String(data.member_id||newId_('MEM'));
  const row={partner_id:sanitizeCell_(String(data.partner_id||'')),partner_name_snapshot:sanitizeCell_(String(data.partner_name_snapshot||partnerName_(data.partner_id)||'')),partner_type:pt,
    representative_name:sanitizeCell_(String(data.representative_name||'')),representative_email:sanitizeCell_(String(data.representative_email||'')),voting_right:data.voting_right===false?'false':'true',
    chair_eligible:(data.chair_eligible===true||pt==='CORE')?'true':'false',status:String(data.status||'ACTIVE'),appointed_at:String(data.appointed_at||now.slice(0,10)),retired_at:String(data.retired_at||''),
    updated_at:now};
  const existing=readRows_(ssOps_(),'Secretariat_Members').find(function(x){return String(x.member_id)===id;});
  if(existing) updateRow_(ssOps_(),'Secretariat_Members','member_id',id,row); else appendRow_(ssOps_(),'Secretariat_Members',Object.assign({member_id:id,created_by:actor.email,created_at:now},row));
  logEvent_('secretariat_member',id,actor.email,existing||null,row); return {member_id:id};
}

function calendarTemplateUrl_(m){
  function z(s){return encodeURIComponent(String(s||''));}
  function dt(s){return String(s||'').replace(/[-:]/g,'').replace('.000','').replace(/Z$/,'Z');}
  const dates=dt(m.starts_at)+'/'+dt(m.ends_at||m.starts_at);
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text='+z(m.title)+'&dates='+z(dates)+'&details='+z(m.notes||'')+'&location='+z(m.location||m.online_url||'');
}
function admin_saveSecretariatMeeting(data){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_(); data=data||{};
  if(!String(data.title||'').trim()) throw new Error('VALIDATION_ERROR: 会議名は必須です');
  if(!String(data.starts_at||'').trim()) throw new Error('VALIDATION_ERROR: 開始日時は必須です');
  const now=new Date().toISOString(), id=String(data.meeting_id||newId_('MTG'));
  const row={title:sanitizeCell_(String(data.title)),meeting_type:String(data.meeting_type||'REGULAR'),starts_at:String(data.starts_at),ends_at:String(data.ends_at||data.starts_at),location:sanitizeCell_(String(data.location||'')),online_url:String(data.online_url||''),
    convened_by:sanitizeCell_(String(data.convened_by||actor.email)),chair_member_id:String(data.chair_member_id||''),status:String(data.status||'SCHEDULED'),notice_sent_at:String(data.notice_sent_at||''),minutes_status:String(data.minutes_status||'NOT_STARTED'),minutes_url:String(data.minutes_url||''),notes:sanitizeCell_(String(data.notes||'')),updated_at:now};
  const existing=readRows_(ssOps_(),'Secretariat_Meetings').find(function(x){return String(x.meeting_id)===id;});
  if(existing) updateRow_(ssOps_(),'Secretariat_Meetings','meeting_id',id,row); else appendRow_(ssOps_(),'Secretariat_Meetings',Object.assign({meeting_id:id,created_by:actor.email,created_at:now},row));
  logEvent_('secretariat_meeting',id,actor.email,existing||null,row); return {meeting_id:id,calendar_url:calendarTemplateUrl_(Object.assign({meeting_id:id},row))};
}
function admin_listSecretariatMeetings(){ requireRole_([]); ensurePartnershipSheets_();
  return readRows_(ssOps_(),'Secretariat_Meetings').map(function(m){return Object.assign({},m,{calendar_url:calendarTemplateUrl_(m)});}).sort(function(a,b){return String(a.starts_at).localeCompare(String(b.starts_at));});
}
function admin_recordSecretariatAttendance(meetingId, memberId, status){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_();
  if(['ATTENDED','ABSENT','ONLINE','OBSERVER'].indexOf(String(status))<0) throw new Error('VALIDATION_ERROR: 出欠状態が不正です');
  const rows=readRows_(ssOps_(),'Secretariat_Attendance'); const ex=rows.find(function(x){return String(x.meeting_id)===String(meetingId)&&String(x.member_id)===String(memberId);});
  const patch={meeting_id:String(meetingId),member_id:String(memberId),attendance_status:String(status),recorded_by:actor.email,recorded_at:new Date().toISOString()};
  if(ex) updateRow_(ssOps_(),'Secretariat_Attendance','attendance_id',ex.attendance_id,patch); else appendRow_(ssOps_(),'Secretariat_Attendance',Object.assign({attendance_id:newId_('ATT')},patch));
  return true;
}

function admin_saveSecretariatAgenda(data){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_(); data=data||{};
  if(!String(data.meeting_id||'').trim()) throw new Error('VALIDATION_ERROR: 会議を指定してください'); if(!String(data.title||'').trim()) throw new Error('VALIDATION_ERROR: 議案名は必須です');
  const type=String(data.agenda_type||'OTHER'), rule=String(data.resolution_rule||resolutionRuleForAgendaType_(type));
  const now=new Date().toISOString(), id=String(data.agenda_id||newId_('AGD'));
  const row={meeting_id:String(data.meeting_id),agenda_no:String(data.agenda_no||''),title:sanitizeCell_(String(data.title)),agenda_type:type,resolution_rule:rule,proposer_member_id:String(data.proposer_member_id||''),proposer_partner_id:String(data.proposer_partner_id||''),summary:sanitizeCell_(String(data.summary||'')),proposal_text:sanitizeCell_(String(data.proposal_text||'')),contract_clause:sanitizeCell_(String(data.contract_clause||'')),conflict_note:sanitizeCell_(String(data.conflict_note||'')),status:String(data.status||'DRAFT'),deadline:String(data.deadline||''),updated_at:now};
  const existing=readRows_(ssOps_(),'Secretariat_Agendas').find(function(x){return String(x.agenda_id)===id;});
  if(existing) updateRow_(ssOps_(),'Secretariat_Agendas','agenda_id',id,row); else appendRow_(ssOps_(),'Secretariat_Agendas',Object.assign({agenda_id:id,computed_result:'',final_result:'',resolution_text:'',decided_at:'',chair_override:'false',created_by:actor.email,created_at:now},row));
  logEvent_('secretariat_agenda',id,actor.email,existing||null,row); return {agenda_id:id,resolution_rule:rule};
}
function activeVotingMembers_(){ return readRows_(ssOps_(),'Secretariat_Members').filter(function(m){return String(m.status)==='ACTIVE'&&boolCell_(m.voting_right);}); }
function evaluateAgendaResolution_(agendaId){
  const agenda=readRows_(ssOps_(),'Secretariat_Agendas').find(function(a){return String(a.agenda_id)===String(agendaId);}); if(!agenda) throw new Error('DATA_NOT_FOUND: 議案が見つかりません');
  const members=activeVotingMembers_(); const votes=readRows_(ssOps_(),'Secretariat_Votes').filter(function(v){return String(v.agenda_id)===String(agendaId);});
  const vm={}; votes.forEach(function(v){vm[String(v.member_id)]=v;}); let yes=0,no=0,abstain=0,cast=0,coreYes=0;
  members.forEach(function(m){const v=vm[String(m.member_id)]; if(!v)return; cast++; if(v.vote==='FOR'){yes++; if(String(m.partner_type)==='CORE')coreYes++;} else if(v.vote==='AGAINST')no++; else abstain++;});
  const total=members.length, rule=String(agenda.resolution_rule||resolutionRuleForAgendaType_(agenda.agenda_type)); let passed=false;
  if(rule==='ORDINARY') passed=total>0&&yes*2>total;
  else if(rule==='SPECIAL') passed=total>0&&yes*3>=total*2&&coreYes>=1;
  else if(rule==='UNANIMOUS') passed=total>0&&yes===total;
  const pending=rule!=='REPORT_ONLY'&&cast<total&&!passed;
  return {agenda_id:agenda.agenda_id,agenda_type:agenda.agenda_type,rule:rule,total_members:total,votes_cast:cast,yes:yes,no:no,abstain:abstain,core_yes:coreYes,passed:passed,status:rule==='REPORT_ONLY'?'REPORT_ONLY':(passed?'PASSED':(pending?'PENDING':'NOT_PASSED'))};
}
function admin_castSecretariatVote(agendaId, memberId, vote, comment){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_();
  vote=String(vote||''); if(['FOR','AGAINST','ABSTAIN','ABSENT'].indexOf(vote)<0) throw new Error('VALIDATION_ERROR: 投票値が不正です');
  const m=readRows_(ssOps_(),'Secretariat_Members').find(function(x){return String(x.member_id)===String(memberId)&&String(x.status)==='ACTIVE';}); if(!m) throw new Error('DATA_NOT_FOUND: 有効な構成員が見つかりません');
  const ex=readRows_(ssOps_(),'Secretariat_Votes').find(function(x){return String(x.agenda_id)===String(agendaId)&&String(x.member_id)===String(memberId);});
  const row={agenda_id:String(agendaId),member_id:String(memberId),partner_id:String(m.partner_id||''),partner_type:String(m.partner_type||''),vote:vote,comment:sanitizeCell_(String(comment||'')),cast_by:actor.email,cast_at:new Date().toISOString()};
  if(ex) updateRow_(ssOps_(),'Secretariat_Votes','vote_id',ex.vote_id,row); else appendRow_(ssOps_(),'Secretariat_Votes',Object.assign({vote_id:newId_('VOT')},row));
  const ev=evaluateAgendaResolution_(agendaId); updateRow_(ssOps_(),'Secretariat_Agendas','agenda_id',agendaId,{computed_result:ev.status,status:ev.passed?'RESOLVED':'VOTING',updated_at:new Date().toISOString()}); logEvent_('secretariat_vote',agendaId,actor.email,null,row); return ev;
}
function admin_finalizeSecretariatAgenda(agendaId, finalResult, resolutionText, chairOverride){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_();
  const a=readRows_(ssOps_(),'Secretariat_Agendas').find(function(x){return String(x.agenda_id)===String(agendaId);}); if(!a) throw new Error('DATA_NOT_FOUND: 議案が見つかりません');
  const ev=evaluateAgendaResolution_(agendaId); finalResult=String(finalResult||''); if(['PASSED','REJECTED','DEFERRED','REPORT_RECEIVED'].indexOf(finalResult)<0) throw new Error('VALIDATION_ERROR: 最終結果が不正です');
  const override=chairOverride===true||String(chairOverride)==='true';
  if(finalResult==='PASSED'&&!ev.passed){
    if(!override) throw new Error('DATA_CONFLICT: 契約上の成立要件を満たしていません');
    if(String(a.agenda_type)==='PARTNER_TYPE_CHANGE'||String(a.agenda_type)==='DISSOLUTION') throw new Error('DATA_CONFLICT: パートナー種別変更・解散は議長裁量で成立させられません');
  }
  const patch={computed_result:ev.status,final_result:finalResult,resolution_text:sanitizeCell_(String(resolutionText||'')),decided_at:new Date().toISOString(),chair_override:override?'true':'false',status:'RESOLVED',updated_at:new Date().toISOString()};
  updateRow_(ssOps_(),'Secretariat_Agendas','agenda_id',agendaId,patch); logEvent_('secretariat_resolution',agendaId,actor.email,null,Object.assign({evaluation:ev},patch)); return Object.assign({},ev,patch);
}
function admin_listSecretariatAgendas(meetingId){ requireRole_([]); ensurePartnershipSheets_();
  return readRows_(ssOps_(),'Secretariat_Agendas').filter(function(a){return !meetingId||String(a.meeting_id)===String(meetingId);}).map(function(a){let ev;try{ev=evaluateAgendaResolution_(a.agenda_id);}catch(e){ev=null;}return Object.assign({},a,{agenda_type_label:agendaTypeLabel_(a.agenda_type),evaluation:ev});}).sort(function(a,b){return String(a.meeting_id+a.agenda_no).localeCompare(String(b.meeting_id+b.agenda_no));});
}

function admin_saveSecretariatReport(data){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_(); data=data||{};
  const now=new Date().toISOString(), id=String(data.report_id||newId_('RPT')), partnerId=String(data.partner_id||''); let due=String(data.due_date||'');
  if(!due&&String(data.report_type)==='LICENSE_AGREEMENT'&&data.signed_at) due=nextMonthEnd_(data.signed_at);
  const row={report_type:String(data.report_type||'OTHER'),source_contract_id:String(data.source_contract_id||''),partner_id:partnerId,partner_name_snapshot:sanitizeCell_(String(data.partner_name_snapshot||partnerName_(partnerId)||'')),period_start:String(data.period_start||''),period_end:String(data.period_end||''),due_date:due,subject:sanitizeCell_(String(data.subject||'')),license_summary:sanitizeCell_(String(data.license_summary||'')),license_fee:String(data.license_fee||''),usage_detail:sanitizeCell_(String(data.usage_detail||'')),status:String(data.status||'DRAFT'),submitted_at:String(data.submitted_at||''),evidence_url:String(data.evidence_url||''),material_request_status:String(data.material_request_status||'NONE'),material_request_note:sanitizeCell_(String(data.material_request_note||'')),reviewed_by:String(data.reviewed_by||''),reviewed_at:String(data.reviewed_at||''),notes:sanitizeCell_(String(data.notes||'')),updated_at:now};
  const ex=readRows_(ssOps_(),'Secretariat_Reports').find(function(x){return String(x.report_id)===id;}); if(ex)updateRow_(ssOps_(),'Secretariat_Reports','report_id',id,row);else appendRow_(ssOps_(),'Secretariat_Reports',Object.assign({report_id:id,created_by:actor.email,created_at:now},row));
  logEvent_('secretariat_report',id,actor.email,ex||null,row); return {report_id:id,due_date:due};
}
function admin_createLicenseReportFromContract(contractId, partnerId){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_();
  const c=readRows_(ssOps_(),'Contracts').find(function(x){return String(x.contract_id)===String(contractId);}); if(!c) throw new Error('DATA_NOT_FOUND: 契約が見つかりません');
  const works=readRows_(ssOps_(),'Contract_Works').filter(function(w){return String(w.contract_id)===String(contractId);});
  const terms=parseJson_(c.terms_snapshot,{}); return admin_saveSecretariatReport({report_type:'LICENSE_AGREEMENT',source_contract_id:c.contract_id,partner_id:partnerId,signed_at:c.signed_at,due_date:nextMonthEnd_(c.signed_at),subject:'SPLL利用許諾契約の報告 '+String(c.application_ref||c.contract_id),license_summary:works.map(function(w){return w.work_name_snapshot||w.work_id;}).join('、'),license_fee:terms.fee_amount_or_rate||terms.fee_label||'',usage_detail:c.usage_category||'',status:'DRAFT'});
}
function admin_listSecretariatReports(){ requireRole_([]); ensurePartnershipSheets_(); return readRows_(ssOps_(),'Secretariat_Reports').sort(function(a,b){return String(a.due_date||'9999').localeCompare(String(b.due_date||'9999'));}); }

function admin_saveSecretariatSettlement(data){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_(); data=data||{};
  const now=new Date().toISOString(),id=String(data.settlement_id||newId_('SET')),partnerId=String(data.partner_id||''); const dist=Number(data.distribution_amount||0),exp=Number(data.expense_share||0);
  const row={settlement_type:String(data.settlement_type||'QUARTERLY'),period_label:sanitizeCell_(String(data.period_label||'')),period_start:String(data.period_start||''),period_end:String(data.period_end||''),partner_id:partnerId,partner_name_snapshot:sanitizeCell_(String(data.partner_name_snapshot||partnerName_(partnerId)||'')),revenue_total:String(data.revenue_total||''),allocation_basis:sanitizeCell_(String(data.allocation_basis||'')),distribution_amount:String(data.distribution_amount||''),expense_share:String(data.expense_share||''),net_amount:String(data.net_amount!==undefined&&data.net_amount!==''?data.net_amount:(dist-exp)),due_date:String(data.due_date||''),status:String(data.status||'DRAFT'),reported_at:String(data.reported_at||''),approved_at:String(data.approved_at||''),paid_at:String(data.paid_at||''),evidence_url:String(data.evidence_url||''),resolution_agenda_id:String(data.resolution_agenda_id||''),notes:sanitizeCell_(String(data.notes||'')),updated_at:now};
  const ex=readRows_(ssOps_(),'Secretariat_Settlements').find(function(x){return String(x.settlement_id)===id;}); if(ex)updateRow_(ssOps_(),'Secretariat_Settlements','settlement_id',id,row);else appendRow_(ssOps_(),'Secretariat_Settlements',Object.assign({settlement_id:id,created_by:actor.email,created_at:now},row));
  logEvent_('secretariat_settlement',id,actor.email,ex||null,row); return {settlement_id:id};
}
function admin_listSecretariatSettlements(){ requireRole_([]); ensurePartnershipSheets_(); return readRows_(ssOps_(),'Secretariat_Settlements').sort(function(a,b){return String(b.period_end||'').localeCompare(String(a.period_end||''));}); }

function admin_partnershipOverview(year,month){ requireRole_([]); ensurePartnershipSheets_(); const y=Number(year)||new Date().getFullYear(), m=Number(month)||new Date().getMonth()+1; const prefix=y+'-'+String(m).padStart(2,'0');
  const meetings=admin_listSecretariatMeetings(); const agendas=admin_listSecretariatAgendas(); const reports=admin_listSecretariatReports(); const settlements=admin_listSecretariatSettlements(); const members=admin_listSecretariatMembers();
  const events=[]; meetings.forEach(function(x){if(String(x.starts_at).slice(0,7)===prefix)events.push({date:isoDate_(x.starts_at),kind:'MEETING',title:x.title,id:x.meeting_id,status:x.status});}); reports.forEach(function(x){if(String(x.due_date).slice(0,7)===prefix)events.push({date:isoDate_(x.due_date),kind:'REPORT_DUE',title:'報告期限：'+(x.subject||x.report_type),id:x.report_id,status:x.status});}); settlements.forEach(function(x){if(String(x.due_date).slice(0,7)===prefix)events.push({date:isoDate_(x.due_date),kind:'SETTLEMENT_DUE',title:'清算期限：'+(x.partner_name_snapshot||x.period_label),id:x.settlement_id,status:x.status});});
  return {year:y,month:m,kpis:{active_members:members.filter(function(x){return String(x.status)==='ACTIVE';}).length,upcoming_meetings:meetings.filter(function(x){return String(x.starts_at)>=new Date().toISOString()&&String(x.status)!=='CANCELLED';}).length,open_agendas:agendas.filter(function(x){return String(x.status)!=='RESOLVED';}).length,overdue_reports:reports.filter(function(x){return x.due_date&&String(x.due_date)<new Date().toISOString().slice(0,10)&&['SUBMITTED','REVIEWED','CLOSED'].indexOf(String(x.status))<0;}).length,pending_settlements:settlements.filter(function(x){return ['PAID','CLOSED'].indexOf(String(x.status))<0;}).length},events:events,meetings:meetings,agendas:agendas,reports:reports,settlements:settlements,members:members};
}
