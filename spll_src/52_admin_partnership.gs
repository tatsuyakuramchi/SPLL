/**
 * SPLL 52_admin_partnership ― パートナーシップ契約に基づく事務局運営（会議・議案・報告・清算記録）
 *
 * 設計：docs/SPLL_事務局運営機能設計_v1.1.md（SPLL-GOV-001）
 *
 * 決議の記録は「後から動かない」ことが要件。構成員が入退任しても過去の決議の可否判定が
 * 変わらないよう、確定時の集計（分母・賛否・コア賛成）を tally_json にスナップショットし、
 * 確定後の議案は投票・要件変更を受け付けない（訂正は admin_reopenSecretariatAgenda で明示的に行う）。
 */

const PARTNERSHIP_TABLES_ = {
  Secretariat_Members: ['member_id','partner_id','partner_name_snapshot','partner_type','representative_name','representative_email','voting_right','chair_eligible','status','appointed_at','retired_at','created_by','created_at','updated_at'],
  Secretariat_Meetings: ['meeting_id','title','meeting_type','starts_at','ends_at','location','online_url','convened_by','chair_member_id','status','notice_sent_at','minutes_status','minutes_url','notes','created_by','created_at','updated_at'],
  Secretariat_Attendance: ['attendance_id','meeting_id','member_id','attendance_status','recorded_by','recorded_at'],
  Secretariat_Agendas: ['agenda_id','meeting_id','agenda_no','title','agenda_type','resolution_rule','proposer_member_id','proposer_partner_id','summary','proposal_text','contract_clause','conflict_note','status','deadline','computed_result','final_result','resolution_text','decided_at','chair_override','tally_json','reopened_at','reopen_reason','created_by','created_at','updated_at'],
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

// ---- 共通ヘルパ ----
function boolCell_(v){ return v === true || String(v).toLowerCase() === 'true' || String(v) === '1'; }
function isoDate_(v){ return String(v||'').slice(0,10); }
/** 事務局の期限・カレンダーはすべてJST基準。UTCのtoISOStringだと日付が1日ずれる。 */
function todayJst_(){ return Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd'); }
function nowJst_(){ return Utilities.formatDate(new Date(), 'JST', "yyyy-MM-dd'T'HH:mm:ss"); }
/** 契約第9条3項：報告期限は「契約締結月の翌月末」。月末はUTC固定で算出しタイムゾーンずれを避ける。 */
function nextMonthEnd_(dateLike){
  const m = /^(\d{4})-(\d{2})/.exec(String(dateLike||'').slice(0,10)) || /^(\d{4})-(\d{2})/.exec(todayJst_());
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) + 1, 0)).toISOString().slice(0,10);
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
/** 議長裁量でも成立させられない議案（契約第6条2項の除外：第7条・第14条） */
function chairOverrideForbidden_(agendaType){
  return String(agendaType)==='PARTNER_TYPE_CHANGE'||String(agendaType)==='DISSOLUTION';
}

// ---- 構成員（契約第4条・第5条） ----
function admin_listSecretariatMembers(){ requireRole_([]); ensurePartnershipSheets_();
  return readRows_(ssOps_(),'Secretariat_Members').sort(function(a,b){return String(a.partner_name_snapshot||'').localeCompare(String(b.partner_name_snapshot||''));});
}
function admin_saveSecretariatMember(data){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_(); data=data||{};
  const pt=String(data.partner_type||''); if(['CORE','CONTENT'].indexOf(pt)<0) throw new Error('VALIDATION_ERROR: パートナー種別はCORE/CONTENTを指定してください');
  if(!String(data.representative_name||'').trim()) throw new Error('VALIDATION_ERROR: 構成員名は必須です');
  const now=new Date().toISOString(), id=String(data.member_id||newId_('MEM'));
  const row={partner_id:sanitizeCell_(String(data.partner_id||'')),partner_name_snapshot:sanitizeCell_(String(data.partner_name_snapshot||partnerName_(data.partner_id)||'')),partner_type:pt,
    representative_name:sanitizeCell_(String(data.representative_name||'')),representative_email:sanitizeCell_(String(data.representative_email||'')),voting_right:data.voting_right===false?'false':'true',
    // 契約第5条：議長はコアパートナーの構成員から選ぶ。コンテンツパートナーには議長資格を与えない
    chair_eligible:(pt==='CORE'&&data.chair_eligible!==false)?'true':'false',status:String(data.status||'ACTIVE'),appointed_at:String(data.appointed_at||todayJst_()),retired_at:String(data.retired_at||''),
    updated_at:now};
  const existing=readRows_(ssOps_(),'Secretariat_Members').find(function(x){return String(x.member_id)===id;});
  if(existing) updateRow_(ssOps_(),'Secretariat_Members','member_id',id,row); else appendRow_(ssOps_(),'Secretariat_Members',Object.assign({member_id:id,created_by:actor.email,created_at:now},row));
  logEvent_('secretariat_member',id,actor.email,existing||null,row); return {member_id:id};
}

// ---- 会議（契約第4条・第5条） ----
/** datetime-local（'YYYY-MM-DDTHH:MM'）をGoogleカレンダーの dates 形式へ。秒まで必須。 */
function calDateTime_(v, addHours){
  const m=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(v||'')); if(!m) return '';
  const d=new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]||0)+(addHours||0),Number(m[5]||0)));
  return d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'');    // ctz=Asia/Tokyo と併用するためZは付けない
}
function calendarTemplateUrl_(m){
  function z(s){return encodeURIComponent(String(s||''));}
  const start=calDateTime_(m.starts_at,0); if(!start) return '';
  let end=calDateTime_(m.ends_at,0);
  if(!end || end<=start) end=calDateTime_(m.starts_at,1);               // 終了未設定・逆転は1時間として扱う
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text='+z(m.title)
    +'&dates='+start+'%2F'+end+'&ctz=Asia%2FTokyo&details='+z(m.notes||'')+'&location='+z(m.location||m.online_url||'');
}
function admin_saveSecretariatMeeting(data){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_(); data=data||{};
  if(!String(data.title||'').trim()) throw new Error('VALIDATION_ERROR: 会議名は必須です');
  if(!String(data.starts_at||'').trim()) throw new Error('VALIDATION_ERROR: 開始日時は必須です');
  // 契約第5条：議長はコアパートナーに属する構成員（議長資格あり）から選ぶ
  const chairId=String(data.chair_member_id||'');
  if(chairId){
    const chair=readRows_(ssOps_(),'Secretariat_Members').find(function(x){return String(x.member_id)===chairId;});
    if(!chair||String(chair.status)!=='ACTIVE') throw new Error('VALIDATION_ERROR: 議長に指定できるのは有効な構成員のみです');
    if(!boolCell_(chair.chair_eligible)) throw new Error('VALIDATION_ERROR: 議長資格のない構成員は議長に指定できません（契約第5条）');
  }
  const now=new Date().toISOString(), id=String(data.meeting_id||newId_('MTG'));
  const row={title:sanitizeCell_(String(data.title)),meeting_type:String(data.meeting_type||'REGULAR'),starts_at:String(data.starts_at),ends_at:String(data.ends_at||data.starts_at),location:sanitizeCell_(String(data.location||'')),online_url:String(data.online_url||''),
    convened_by:sanitizeCell_(String(data.convened_by||actor.email)),chair_member_id:chairId,status:String(data.status||'SCHEDULED'),notice_sent_at:String(data.notice_sent_at||''),minutes_status:String(data.minutes_status||'NOT_STARTED'),minutes_url:String(data.minutes_url||''),notes:sanitizeCell_(String(data.notes||'')),updated_at:now};
  const existing=readRows_(ssOps_(),'Secretariat_Meetings').find(function(x){return String(x.meeting_id)===id;});
  if(existing) updateRow_(ssOps_(),'Secretariat_Meetings','meeting_id',id,row); else appendRow_(ssOps_(),'Secretariat_Meetings',Object.assign({meeting_id:id,created_by:actor.email,created_at:now},row));
  logEvent_('secretariat_meeting',id,actor.email,existing||null,row); return {meeting_id:id,calendar_url:calendarTemplateUrl_(Object.assign({meeting_id:id},row))};
}
function admin_listSecretariatMeetings(){ requireRole_([]); ensurePartnershipSheets_(); return listMeetings_(); }
/** 会議一覧（出欠の集計を添える）。権限確認済みの内部用。 */
function listMeetings_(attendance){
  const att=attendance||readRows_(ssOps_(),'Secretariat_Attendance');
  return readRows_(ssOps_(),'Secretariat_Meetings').map(function(m){
    const mine=att.filter(function(a){return String(a.meeting_id)===String(m.meeting_id);});
    return Object.assign({},m,{calendar_url:calendarTemplateUrl_(m),
      attendance:{attended:mine.filter(function(a){return ['ATTENDED','ONLINE'].indexOf(String(a.attendance_status))>=0;}).length,
        absent:mine.filter(function(a){return String(a.attendance_status)==='ABSENT';}).length, recorded:mine.length}});
  }).sort(function(a,b){return String(a.starts_at).localeCompare(String(b.starts_at));});
}
function admin_recordSecretariatAttendance(meetingId, memberId, status){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_();
  if(['ATTENDED','ABSENT','ONLINE','OBSERVER'].indexOf(String(status))<0) throw new Error('VALIDATION_ERROR: 出欠状態が不正です');
  const rows=readRows_(ssOps_(),'Secretariat_Attendance'); const ex=rows.find(function(x){return String(x.meeting_id)===String(meetingId)&&String(x.member_id)===String(memberId);});
  const patch={meeting_id:String(meetingId),member_id:String(memberId),attendance_status:String(status),recorded_by:actor.email,recorded_at:new Date().toISOString()};
  if(ex) updateRow_(ssOps_(),'Secretariat_Attendance','attendance_id',ex.attendance_id,patch); else appendRow_(ssOps_(),'Secretariat_Attendance',Object.assign({attendance_id:newId_('ATT')},patch));
  return true;
}
/** 会議の出欠一覧（未記録の構成員も「未記録」として返し、記録漏れが見えるようにする） */
function admin_listSecretariatAttendance(meetingId){ requireRole_([]); ensurePartnershipSheets_();
  const att=readRows_(ssOps_(),'Secretariat_Attendance').filter(function(a){return String(a.meeting_id)===String(meetingId||'');});
  return readRows_(ssOps_(),'Secretariat_Members').filter(function(m){return String(m.status)==='ACTIVE';}).map(function(m){
    const a=att.find(function(x){return String(x.member_id)===String(m.member_id);});
    return {member_id:m.member_id,representative_name:m.representative_name,partner_name_snapshot:m.partner_name_snapshot,
      partner_type:m.partner_type,attendance_status:a?String(a.attendance_status):'',recorded_at:a?a.recorded_at:''};
  });
}

// ---- 議案・決議（契約第6条・第7条・第14条） ----
function admin_saveSecretariatAgenda(data){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_(); data=data||{};
  if(!String(data.meeting_id||'').trim()) throw new Error('VALIDATION_ERROR: 会議を指定してください'); if(!String(data.title||'').trim()) throw new Error('VALIDATION_ERROR: 議案名は必須です');
  const type=String(data.agenda_type||'OTHER'), rule=String(data.resolution_rule||resolutionRuleForAgendaType_(type));
  const now=new Date().toISOString(), id=String(data.agenda_id||newId_('AGD'));
  const existing=readRows_(ssOps_(),'Secretariat_Agendas').find(function(x){return String(x.agenda_id)===id;});
  // 決議確定後に議案の中身や成立要件を書き換えると、記録された決議が別の議案の決議になってしまう
  if(existing&&existing.decided_at) throw new Error('DATA_CONFLICT: 決議確定済みの議案は編集できません。訂正は「決議を再開」から行ってください');
  const row={meeting_id:String(data.meeting_id),agenda_no:String(data.agenda_no||''),title:sanitizeCell_(String(data.title)),agenda_type:type,resolution_rule:rule,proposer_member_id:String(data.proposer_member_id||''),proposer_partner_id:String(data.proposer_partner_id||''),summary:sanitizeCell_(String(data.summary||'')),proposal_text:sanitizeCell_(String(data.proposal_text||'')),contract_clause:sanitizeCell_(String(data.contract_clause||'')),conflict_note:sanitizeCell_(String(data.conflict_note||'')),status:String(data.status||'DRAFT'),deadline:String(data.deadline||''),updated_at:now};
  if(existing) updateRow_(ssOps_(),'Secretariat_Agendas','agenda_id',id,row); else appendRow_(ssOps_(),'Secretariat_Agendas',Object.assign({agenda_id:id,computed_result:'',final_result:'',resolution_text:'',decided_at:'',chair_override:'false',tally_json:'',reopened_at:'',reopen_reason:'',created_by:actor.email,created_at:now},row));
  logEvent_('secretariat_agenda',id,actor.email,existing||null,row); return {agenda_id:id,resolution_rule:rule};
}
function activeVotingMembers_(members){ return (members||readRows_(ssOps_(),'Secretariat_Members')).filter(function(m){return String(m.status)==='ACTIVE'&&boolCell_(m.voting_right);}); }
/** 一覧・集計で使う読み取り結果をまとめて持つ（議案ごとにシートを読み直さないため） */
function partnershipContext_(){
  return { agendas:readRows_(ssOps_(),'Secretariat_Agendas'), members:readRows_(ssOps_(),'Secretariat_Members'),
    votes:readRows_(ssOps_(),'Secretariat_Votes'), attendance:readRows_(ssOps_(),'Secretariat_Attendance') };
}
/**
 * 議案の成立判定（契約第6条）。
 *   通常  ：全有効構成員の過半数
 *   特別  ：全有効構成員の3分の2以上、かつコアパートナー構成員1名以上の賛成
 *   全員同意：全有効構成員の賛成（解散）
 * 分母は「投票した人数」ではなく全有効構成員数。棄権・欠席は賛成に数えない。
 */
function agendaTally_(agenda, ctx){
  const members=activeVotingMembers_(ctx.members);
  const votes=ctx.votes.filter(function(v){return String(v.agenda_id)===String(agenda.agenda_id);});
  const vm={}; votes.forEach(function(v){vm[String(v.member_id)]=v;}); let yes=0,no=0,abstain=0,cast=0,coreYes=0;
  members.forEach(function(m){const v=vm[String(m.member_id)]; if(!v)return; cast++; if(v.vote==='FOR'){yes++; if(String(m.partner_type)==='CORE')coreYes++;} else if(v.vote==='AGAINST')no++; else abstain++;});
  const total=members.length, rule=String(agenda.resolution_rule||resolutionRuleForAgendaType_(agenda.agenda_type)); let passed=false;
  if(rule==='ORDINARY') passed=total>0&&yes*2>total;
  else if(rule==='SPECIAL') passed=total>0&&yes*3>=total*2&&coreYes>=1;
  else if(rule==='UNANIMOUS') passed=total>0&&yes===total;
  const pending=rule!=='REPORT_ONLY'&&cast<total&&!passed;
  return {agenda_id:agenda.agenda_id,agenda_type:agenda.agenda_type,rule:rule,total_members:total,votes_cast:cast,yes:yes,no:no,abstain:abstain,core_yes:coreYes,passed:passed,
    status:rule==='REPORT_ONLY'?'REPORT_ONLY':(passed?'PASSED':(pending?'PENDING':'NOT_PASSED'))};
}
function evaluateAgendaResolution_(agendaId, ctx){
  ctx=ctx||partnershipContext_();
  const agenda=ctx.agendas.find(function(a){return String(a.agenda_id)===String(agendaId);}); if(!agenda) throw new Error('DATA_NOT_FOUND: 議案が見つかりません');
  return agendaTally_(agenda, ctx);
}
/**
 * 表示用の評価。確定済みは確定時のスナップショットを返す。
 * 構成員が入退任しても過去の決議の分母・可否が動かないようにするため。
 */
function agendaEvaluation_(agenda, ctx){
  if(agenda.decided_at&&agenda.tally_json){
    const snap=parseJson_(agenda.tally_json,null);
    if(snap) return Object.assign({},snap,{source:'SNAPSHOT'});
  }
  return Object.assign(agendaTally_(agenda,ctx),{source:'LIVE'});
}
function admin_castSecretariatVote(agendaId, memberId, vote, comment){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_();
  vote=String(vote||''); if(['FOR','AGAINST','ABSTAIN','ABSENT'].indexOf(vote)<0) throw new Error('VALIDATION_ERROR: 投票値が不正です');
  const a=readRows_(ssOps_(),'Secretariat_Agendas').find(function(x){return String(x.agenda_id)===String(agendaId);});
  if(!a) throw new Error('DATA_NOT_FOUND: 議案が見つかりません');
  // 確定後の投票を受け付けると computed_result が上書きされ、記録済みの決議と食い違う
  if(a.decided_at) throw new Error('DATA_CONFLICT: 決議確定済みの議案には投票できません。訂正は「決議を再開」から行ってください');
  const m=readRows_(ssOps_(),'Secretariat_Members').find(function(x){return String(x.member_id)===String(memberId)&&String(x.status)==='ACTIVE';}); if(!m) throw new Error('DATA_NOT_FOUND: 有効な構成員が見つかりません');
  if(!boolCell_(m.voting_right)) throw new Error('VALIDATION_ERROR: 議決権のない構成員は投票できません');
  const ex=readRows_(ssOps_(),'Secretariat_Votes').find(function(x){return String(x.agenda_id)===String(agendaId)&&String(x.member_id)===String(memberId);});
  const row={agenda_id:String(agendaId),member_id:String(memberId),partner_id:String(m.partner_id||''),partner_type:String(m.partner_type||''),vote:vote,comment:sanitizeCell_(String(comment||'')),cast_by:actor.email,cast_at:new Date().toISOString()};
  if(ex) updateRow_(ssOps_(),'Secretariat_Votes','vote_id',ex.vote_id,row); else appendRow_(ssOps_(),'Secretariat_Votes',Object.assign({vote_id:newId_('VOT')},row));
  const ev=evaluateAgendaResolution_(agendaId); updateRow_(ssOps_(),'Secretariat_Agendas','agenda_id',agendaId,{computed_result:ev.status,status:'VOTING',updated_at:new Date().toISOString()}); logEvent_('secretariat_vote',agendaId,actor.email,ex||null,row); return ev;
}
function admin_finalizeSecretariatAgenda(agendaId, finalResult, resolutionText, chairOverride){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_();
  const a=readRows_(ssOps_(),'Secretariat_Agendas').find(function(x){return String(x.agenda_id)===String(agendaId);}); if(!a) throw new Error('DATA_NOT_FOUND: 議案が見つかりません');
  if(a.decided_at) throw new Error('DATA_CONFLICT: この議案はすでに決議確定済みです（訂正は「決議を再開」から）');
  const ev=evaluateAgendaResolution_(agendaId); finalResult=String(finalResult||''); if(['PASSED','REJECTED','DEFERRED','REPORT_RECEIVED'].indexOf(finalResult)<0) throw new Error('VALIDATION_ERROR: 最終結果が不正です');
  const override=chairOverride===true||String(chairOverride)==='true';
  if(finalResult==='PASSED'&&!ev.passed){
    if(!override) throw new Error('DATA_CONFLICT: 契約上の成立要件を満たしていません');
    // PARTNER_TYPE_CHANGE（第7条）とDISSOLUTION（第14条）は議長裁量で成立させられない
    if(chairOverrideForbidden_(a.agenda_type)) throw new Error('DATA_CONFLICT: パートナー種別変更・解散は議長裁量で成立させられません');
  }
  const patch={computed_result:ev.status,final_result:finalResult,resolution_text:sanitizeCell_(String(resolutionText||'')),decided_at:new Date().toISOString(),chair_override:override?'true':'false',
    tally_json:JSON.stringify(ev),status:'RESOLVED',updated_at:new Date().toISOString()};
  updateRow_(ssOps_(),'Secretariat_Agendas','agenda_id',agendaId,patch); logEvent_('secretariat_resolution',agendaId,actor.email,null,Object.assign({evaluation:ev},patch)); return Object.assign({},ev,patch);
}
/**
 * 確定した決議の再開（訂正）。誤記録の是正手段は必要だが、通常の運用で起きてはならないため
 * LEGAL_ADMIN に限定し、理由を必須にして監査ログへ残す。確定前の状態（投票は保持）へ戻す。
 */
function admin_reopenSecretariatAgenda(agendaId, reason){ const actor=requireRole_(['LEGAL_ADMIN']); ensurePartnershipSheets_();
  const a=readRows_(ssOps_(),'Secretariat_Agendas').find(function(x){return String(x.agenda_id)===String(agendaId);}); if(!a) throw new Error('DATA_NOT_FOUND: 議案が見つかりません');
  if(!a.decided_at) throw new Error('DATA_CONFLICT: 確定していない議案です');
  if(!String(reason||'').trim()) throw new Error('VALIDATION_ERROR: 再開の理由は必須です');
  const patch={final_result:'',resolution_text:'',decided_at:'',chair_override:'false',tally_json:'',status:'VOTING',
    reopened_at:new Date().toISOString(),reopen_reason:sanitizeCell_(String(reason)).slice(0,500),updated_at:new Date().toISOString()};
  updateRow_(ssOps_(),'Secretariat_Agendas','agenda_id',agendaId,patch);
  logEvent_('secretariat_resolution',agendaId,actor.email,{final_result:a.final_result,decided_at:a.decided_at,tally_json:a.tally_json},patch);
  return true;
}
function admin_listSecretariatAgendas(meetingId){ requireRole_([]); ensurePartnershipSheets_(); return listAgendas_(partnershipContext_(), meetingId); }
function listAgendas_(ctx, meetingId){
  return ctx.agendas.filter(function(a){return !meetingId||String(a.meeting_id)===String(meetingId);})
    .map(function(a){return Object.assign({},a,{agenda_type_label:agendaTypeLabel_(a.agenda_type),evaluation:agendaEvaluation_(a,ctx),
      chair_override_allowed:!chairOverrideForbidden_(a.agenda_type)});})
    .sort(function(a,b){return String(a.meeting_id+a.agenda_no).localeCompare(String(b.meeting_id+b.agenda_no));});
}

// ---- 報告（契約第9条3項・4項、第10条） ----
function admin_saveSecretariatReport(data){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_(); data=data||{};
  const now=new Date().toISOString(), id=String(data.report_id||newId_('RPT')), partnerId=String(data.partner_id||''); let due=String(data.due_date||'');
  if(!due&&String(data.report_type)==='LICENSE_AGREEMENT'&&data.signed_at) due=nextMonthEnd_(data.signed_at);
  const row={report_type:String(data.report_type||'OTHER'),source_contract_id:String(data.source_contract_id||''),partner_id:partnerId,partner_name_snapshot:sanitizeCell_(String(data.partner_name_snapshot||partnerName_(partnerId)||'')),period_start:String(data.period_start||''),period_end:String(data.period_end||''),due_date:due,subject:sanitizeCell_(String(data.subject||'')),license_summary:sanitizeCell_(String(data.license_summary||'')),license_fee:String(data.license_fee||''),usage_detail:sanitizeCell_(String(data.usage_detail||'')),status:String(data.status||'DRAFT'),submitted_at:String(data.submitted_at||''),evidence_url:String(data.evidence_url||''),material_request_status:String(data.material_request_status||'NONE'),material_request_note:sanitizeCell_(String(data.material_request_note||'')),reviewed_by:String(data.reviewed_by||''),reviewed_at:String(data.reviewed_at||''),notes:sanitizeCell_(String(data.notes||'')),updated_at:now};
  const ex=readRows_(ssOps_(),'Secretariat_Reports').find(function(x){return String(x.report_id)===id;}); if(ex)updateRow_(ssOps_(),'Secretariat_Reports','report_id',id,row);else appendRow_(ssOps_(),'Secretariat_Reports',Object.assign({report_id:id,created_by:actor.email,created_at:now},row));
  logEvent_('secretariat_report',id,actor.email,ex||null,row); return {report_id:id,due_date:due};
}
/** 締結済み契約から利用許諾報告（第9条3項）を起票。同じ契約からの重複起票は行わない。 */
function admin_createLicenseReportFromContract(contractId, partnerId){ requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_();
  const c=readRows_(ssOps_(),'Contracts').find(function(x){return String(x.contract_id)===String(contractId);}); if(!c) throw new Error('DATA_NOT_FOUND: 契約が見つかりません');
  const dup=readRows_(ssOps_(),'Secretariat_Reports').find(function(r){return String(r.source_contract_id)===String(contractId)&&String(r.report_type)==='LICENSE_AGREEMENT';});
  if(dup) return {report_id:dup.report_id,due_date:dup.due_date,duplicate:true};
  const works=readRows_(ssOps_(),'Contract_Works').filter(function(w){return String(w.contract_id)===String(contractId);});
  const terms=parseJson_(c.terms_snapshot,{});
  return admin_saveSecretariatReport({report_type:'LICENSE_AGREEMENT',source_contract_id:c.contract_id,partner_id:partnerId,signed_at:c.signed_at,due_date:nextMonthEnd_(c.signed_at),subject:'SPLL利用許諾契約の報告 '+String(c.license_id||c.application_ref||c.contract_id),license_summary:works.map(function(w){return w.work_name_snapshot||w.work_id;}).join('、'),license_fee:terms.fee_amount_or_rate||terms.fee_label||'',usage_detail:c.usage_category||'',status:'DRAFT'});
}
function admin_listSecretariatReports(){ requireRole_([]); ensurePartnershipSheets_(); return readRows_(ssOps_(),'Secretariat_Reports').sort(function(a,b){return String(a.due_date||'9999').localeCompare(String(b.due_date||'9999'));}); }

// ---- 清算記録（契約第11条・第12条・第14条） ----
function admin_saveSecretariatSettlement(data){ const actor=requireRole_(['LEGAL_ADMIN','OPERATIONS']); ensurePartnershipSheets_(); data=data||{};
  const now=new Date().toISOString(),id=String(data.settlement_id||newId_('SET')),partnerId=String(data.partner_id||''); const dist=Number(data.distribution_amount||0),exp=Number(data.expense_share||0);
  const row={settlement_type:String(data.settlement_type||'QUARTERLY'),period_label:sanitizeCell_(String(data.period_label||'')),period_start:String(data.period_start||''),period_end:String(data.period_end||''),partner_id:partnerId,partner_name_snapshot:sanitizeCell_(String(data.partner_name_snapshot||partnerName_(partnerId)||'')),revenue_total:String(data.revenue_total||''),allocation_basis:sanitizeCell_(String(data.allocation_basis||'')),distribution_amount:String(data.distribution_amount||''),expense_share:String(data.expense_share||''),net_amount:String(data.net_amount!==undefined&&data.net_amount!==''?data.net_amount:(dist-exp)),due_date:String(data.due_date||''),status:String(data.status||'DRAFT'),reported_at:String(data.reported_at||''),approved_at:String(data.approved_at||''),paid_at:String(data.paid_at||''),evidence_url:String(data.evidence_url||''),resolution_agenda_id:String(data.resolution_agenda_id||''),notes:sanitizeCell_(String(data.notes||'')),updated_at:now};
  const ex=readRows_(ssOps_(),'Secretariat_Settlements').find(function(x){return String(x.settlement_id)===id;}); if(ex)updateRow_(ssOps_(),'Secretariat_Settlements','settlement_id',id,row);else appendRow_(ssOps_(),'Secretariat_Settlements',Object.assign({settlement_id:id,created_by:actor.email,created_at:now},row));
  logEvent_('secretariat_settlement',id,actor.email,ex||null,row); return {settlement_id:id};
}
function admin_listSecretariatSettlements(){ requireRole_([]); ensurePartnershipSheets_(); return readRows_(ssOps_(),'Secretariat_Settlements').sort(function(a,b){return String(b.period_end||'').localeCompare(String(a.period_end||''));}); }

// ---- カレンダー・KPI ----
function admin_partnershipOverview(year,month){ requireRole_([]); ensurePartnershipSheets_();
  const todayStr=todayJst_(), nowStr=nowJst_();
  const y=Number(year)||Number(todayStr.slice(0,4)), m=Number(month)||Number(todayStr.slice(5,7)), prefix=y+'-'+String(m).padStart(2,'0');
  const ctx=partnershipContext_();
  const meetings=listMeetings_(ctx.attendance), agendas=listAgendas_(ctx);
  const reports=readRows_(ssOps_(),'Secretariat_Reports').sort(function(a,b){return String(a.due_date||'9999').localeCompare(String(b.due_date||'9999'));});
  const settlements=readRows_(ssOps_(),'Secretariat_Settlements').sort(function(a,b){return String(b.period_end||'').localeCompare(String(a.period_end||''));});
  const members=ctx.members.slice().sort(function(a,b){return String(a.partner_name_snapshot||'').localeCompare(String(b.partner_name_snapshot||''));});
  const reportOpen=function(x){ return ['SUBMITTED','REVIEWED','CLOSED'].indexOf(String(x.status))<0; };
  const settlementOpen=function(x){ return ['PAID','CLOSED'].indexOf(String(x.status))<0; };

  const events=[];
  meetings.forEach(function(x){ if(String(x.starts_at).slice(0,7)===prefix) events.push({date:isoDate_(x.starts_at),kind:'MEETING',title:x.title,id:x.meeting_id,status:x.status,overdue:false}); });
  reports.forEach(function(x){ if(String(x.due_date).slice(0,7)===prefix) events.push({date:isoDate_(x.due_date),kind:'REPORT_DUE',title:'報告期限：'+(x.subject||x.report_type),id:x.report_id,status:x.status,overdue:String(x.due_date)<todayStr&&reportOpen(x)}); });
  settlements.forEach(function(x){ if(String(x.due_date).slice(0,7)===prefix) events.push({date:isoDate_(x.due_date),kind:'SETTLEMENT_DUE',title:'清算期限：'+(x.partner_name_snapshot||x.period_label),id:x.settlement_id,status:x.status,overdue:String(x.due_date)<todayStr&&settlementOpen(x)}); });
  events.sort(function(a,b){return String(a.date).localeCompare(String(b.date));});

  return {year:y,month:m,today:todayStr,
    kpis:{active_members:members.filter(function(x){return String(x.status)==='ACTIVE';}).length,
      upcoming_meetings:meetings.filter(function(x){return String(x.starts_at)>=nowStr&&String(x.status)!=='CANCELLED';}).length,
      open_agendas:agendas.filter(function(x){return String(x.status)!=='RESOLVED';}).length,
      overdue_reports:reports.filter(function(x){return x.due_date&&String(x.due_date)<todayStr&&reportOpen(x);}).length,
      pending_settlements:settlements.filter(settlementOpen).length},
    events:events,meetings:meetings,agendas:agendas,reports:reports,settlements:settlements,members:members};
}
