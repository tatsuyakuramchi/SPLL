/** SPLL 20_tokens ― 用途別アクセストークン（修正設計書 SEC-06/§9.1） */

// ---- 用途別アクセストークン（修正設計書 SEC-06/§9.1）----
//   purpose: SUBMISSION（提出）/ GUIDE（締結後の手続き案内）/ BADGE_DOWNLOAD（バッジ取得）
//   平文は発行時のみ返し、台帳にはハッシュのみ保存。期限・回数をサーバー側で検証。
/** 用途別トークンの発行。第1引数はSPLL番号（推奨）または契約ID（旧経路）。 */
function issueToken_(idOrLicense, purpose, days, maxUses, referenceId){
  const ref = resolveLicenseRef_(idOrLicense);
  const token = Utilities.getUuid() + randCode_(8);
  // license_id を正本として書く（contract_id は移行期間の互換列・RP-002 §7）
  appendRow_(ssOps_(),'Access_Tokens',{ token_id:Utilities.getUuid(), contract_id:ref.contractId,
    license_id: ref.licenseId, reference_id: referenceId || '',
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
/** 用途別トークンの失効。SPLL番号でも契約IDでも指定できる（license_id か contract_id のどちらかが一致する行を失効）。 */
function revokeTokens_(idOrLicense, purpose){
  const ref = resolveLicenseRef_(idOrLicense);
  readRows_(ssOps_(),'Access_Tokens')
    .filter(function(x){ return x.purpose === purpose && x.status === 'OPEN' &&
      ((ref.licenseId && x.license_id === ref.licenseId) || (ref.contractId && x.contract_id === ref.contractId)); })
    .forEach(function(x){ updateRow_(ssOps_(),'Access_Tokens','token_id',x.token_id,{ status:'REVOKED', revoked_at:new Date().toISOString() }); });
}
/** 作品提出トークンを用意（メール送信はしない）。SPLL番号または契約ID。 */
function prepareSubmissionToken_(idOrLicense){ return issueToken_(idOrLicense, 'SUBMISSION', 30, 10); }
/**
 * トークンから案件を引く。license_id が正本。旧トークン（license_id 空）は contract_id から補う。
 * 戻り値：{ licenseId, contractId, contract } contract は互換テーブルの行（Driveフォルダ・条件スナップショットの参照用）
 */
function tokenLicenseRef_(tok){
  const licenseId = String((tok && tok.license_id) || '') || licenseIdOfContract_(tok && tok.contract_id);
  let contract = null;
  if(tok && tok.contract_id) contract = readRows_(ssOps_(),'Contracts').find(function(c){ return c.contract_id === tok.contract_id; }) || null;
  if(!contract && licenseId && typeof currentSignedContract_ === 'function') contract = currentSignedContract_(licenseId);
  return { licenseId: licenseId, contractId: contract ? contract.contract_id : String((tok && tok.contract_id) || ''), contract: contract || {} };
}
/** 案件（SPLL番号）に属する行か。license_id が入っていればそれで、旧行は contract_id で判定する。 */
function belongsToLicense_(row, ref){
  if(!row) return false;
  if(row.license_id) return String(row.license_id) === String(ref.licenseId);
  return !!ref.contractId && String(row.contract_id) === String(ref.contractId);
}
