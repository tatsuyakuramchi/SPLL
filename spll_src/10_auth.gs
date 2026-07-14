/** SPLL 10_auth ― RBAC（修正設計書 §4）：ロール解決・requireRole_・閲覧者ロールAPI */


// ---- ログインユーザーの役割（管理者判定）：管理画面スイッチ用 ----
/** 管理者メールの許可リスト（ADMIN_EMAILS：カンマ/空白区切り・小文字比較） */
function adminEmails_(){
  return String(prop_('ADMIN_EMAILS') || '').split(/[,\s]+/).map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean);
}
function isAdminEmail_(email){
  email = String(email || '').toLowerCase();
  if(!email) return false;
  return adminEmails_().indexOf(email) >= 0;
}
/** 現在のログインユーザーの役割。identified=false は匿名アクセス（メール取得不可）を意味する。 */
function api_getViewerRole(){
  var email = ''; try{ email = Session.getActiveUser().getEmail() || ''; }catch(e){}
  var listed = adminEmails_().length > 0;
  var adminUrl = '?page=admin'; try{ adminUrl = ScriptApp.getService().getUrl() + '?page=admin'; }catch(e){}
  var homeUrl = ''; try{ homeUrl = ScriptApp.getService().getUrl(); }catch(e){}
  return {
    email: email,
    identified: !!email,                 // 匿名デプロイでは空になる
    isAdmin: isAdminEmail_(email),
    bootstrap: !listed,                   // 管理者未登録（初期セットアップ状態）
    adminUrl: adminUrl,
    homeUrl: homeUrl
  };
}

// ============================================================
// RBAC（修正設計書 SEC-02/§4）：全 admin_ 関数の入口で requireRole_() を実行
//   ロール：SYSTEM_ADMIN / LEGAL_ADMIN / OPERATIONS / ACCOUNTING / AUDITOR
//   SYSTEM_ADMIN は全操作可。AUDITOR ほか登録ロールは読取り関数（allowed=[]）のみ。
// ============================================================
const ADMIN_ROLES = ['SYSTEM_ADMIN','LEGAL_ADMIN','OPERATIONS','ACCOUNTING','AUDITOR'];

/** メール→有効ロール（Admin_Users。後方互換で ADMIN_EMAILS 登録者は SYSTEM_ADMIN 扱い） */
function roleOf_(email){
  email = String(email||'').toLowerCase();
  if(!email) return '';
  const u = readRows_(ssOps_(),'Admin_Users').find(function(x){
    return String(x.email||'').toLowerCase() === email && String(x.status) !== 'DISABLED'; });
  if(u && u.role) return String(u.role);
  return isAdminEmail_(email) ? 'SYSTEM_ADMIN' : '';
}

/**
 * 認可（サーバー側強制）。allowed=[] は「登録済みロールなら誰でも（読取り用）」。
 * production：メール未取得（匿名）は常に拒否。
 * development：管理者が一人も未登録なら開発用に SYSTEM_ADMIN として許可（本番では無効）。
 */
function requireRole_(allowed){
  var email = ''; try{ email = Session.getActiveUser().getEmail() || ''; }catch(e){}
  const registered = readRows_(ssOps_(),'Admin_Users').length > 0 || adminEmails_().length > 0;
  if(!email){
    if(devBootstrapAllowed_() && !registered) return { email:'dev-anonymous', role:'SYSTEM_ADMIN' };  // development＋ALLOW_DEV_BOOTSTRAP=true のみ
    throw new Error('AUTHENTICATION_ERROR: ログインユーザーを確認できません（匿名では管理操作できません）');
  }
  var role = roleOf_(email);
  if(!role){
    if(devBootstrapAllowed_() && !registered) return { email:email, role:'SYSTEM_ADMIN' };
    throw new Error('AUTHORIZATION_ERROR: 管理者として登録されていません: ' + email);
  }
  if(role !== 'SYSTEM_ADMIN' && allowed && allowed.length && allowed.indexOf(role) < 0)
    throw new Error('AUTHORIZATION_ERROR: この操作の権限がありません（必要ロール: ' + allowed.join('/') + '）');
  return { email:email, role:role };
}
