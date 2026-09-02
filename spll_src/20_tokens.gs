/** SPLL 20_tokens ― 用途別アクセストークン（修正設計書 SEC-06/§9.1） */

// ---- 用途別アクセストークン（修正設計書 SEC-06/§9.1）----
//   purpose: SUBMISSION（提出）/ GUIDE（締結後の手続き案内）/ BADGE_DOWNLOAD（バッジ取得）
//   平文は発行時のみ返し、台帳にはハッシュのみ保存。期限・回数をサーバー側で検証。
function issueToken_(contractId, purpose, days, maxUses, referenceId){
  const token = Utilities.getUuid() + randCode_(8);
  // license_id を正本として併記する（contract_id は移行期間の互換列・RP-002 §7）
  appendRow_(ssOps_(),'Access_Tokens',{ token_id:Utilities.getUuid(), contract_id:contractId,
    license_id: licenseIdOfContract_(contractId), reference_id: referenceId || '',
    purpose:purpose, token_hash:hash_(token), status:'OPEN', expires_at:addDaysIso_(days||30),
    // maxUses=0 は「回数無制限」（案内ページのように何度でも開くもの）。未指定は10回。
    max_uses:(maxUses === 0 ? 0 : (maxUses || 10)),
    used_count:0, last_used_at:'', issued_at:new Date().toISOString(), revoked_at:'' });
  return token;
}
/** トークン検証：用途一致・OPEN・期限内・回数内。期限切れは EXPIRED に更新して拒否。 */
function resolveToken_(token, purpose){
  if(!token) return null;
  const tok = readRows_(ssOps_(),'Access_Tokens').find(function(x){
    return x.token_hash === hash_(token) && x.purpose === purpose && x.status === 'OPEN'; });
  if(!tok) return null;
  if(tok.expires_at && new Date(tok.expires_at) < new Date()){
    updateRow_(ssOps_(),'Access_Tokens','token_id',tok.token_id,{ status:'EXPIRED' });
    return null;
  }
  if(num_(tok.max_uses) > 0 && num_(tok.used_count) >= num_(tok.max_uses)) return null;
  return tok;
}
/** トークン消費（提出・報告の実行時のみ）。上限到達で USED。 */
function consumeToken_(tok){
  const used = num_(tok.used_count) + 1;
  const patch = { used_count:used, last_used_at:new Date().toISOString() };
  if(num_(tok.max_uses) > 0 && used >= num_(tok.max_uses)) patch.status = 'USED';
  updateRow_(ssOps_(),'Access_Tokens','token_id',tok.token_id,patch);
}
/** 同一契約・同一用途の旧トークンを失効（再発行時） */
function revokeTokens_(contractId, purpose){
  readRows_(ssOps_(),'Access_Tokens')
    .filter(function(x){ return x.contract_id === contractId && x.purpose === purpose && x.status === 'OPEN'; })
    .forEach(function(x){ updateRow_(ssOps_(),'Access_Tokens','token_id',x.token_id,{ status:'REVOKED', revoked_at:new Date().toISOString() }); });
}
/** 作品提出トークンを用意（メール送信はしない） */
function prepareSubmissionToken_(contractId){ return issueToken_(contractId, 'SUBMISSION', 30, 10); }
