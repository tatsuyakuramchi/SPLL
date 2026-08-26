/**
 * 公開ポータルのHTMLを組み立てる。
 *
 * 正本は spll_src/index.html と spll_src/portal_contract_v4_patch.html（GAS①と同じもの）。
 * GAS では HtmlService が両者を結合して配信しているため、ここでも同じ順序で結合し、
 * 画面の実装を二重に持たない。Cloud Run 側の差分は「google.script.run のかわりに
 * HTTPでRPCする shim を先に読み込ませる」ことだけ。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'spll_src');

/** 画面から呼び出してよい関数（サーバー側の許可リストと同じ並び） */
const RPC_FUNCTIONS = [
  'api_listWorks',
  'api_getUsageOptions',
  'api_previewFeeTerms',
  'api_getLegalTexts',
  'api_getLegalTextsV4',
  'api_getApplyConfig',
  'web_createApplicationV4'
];

/**
 * google.script.run 互換のクライアント。
 * withSuccessHandler / withFailureHandler の連鎖と、関数名での呼び出しを再現する。
 * 許可リストにない関数はそもそも生やさないので、画面から管理系を呼ぶ経路が存在しない。
 */
function shimScript(){
  return `<script>
(function(){
  var FNS = ${JSON.stringify(RPC_FUNCTIONS)};
  function Runner(ok, ng){
    this._ok = ok || null;
    this._ng = ng || null;
  }
  Runner.prototype.withSuccessHandler = function(f){ return new Runner(f, this._ng); };
  Runner.prototype.withFailureHandler = function(f){ return new Runner(this._ok, f); };
  // サーバーへ出さずにこちらで答える呼び出し。
  // api_getViewerRole は「Googleログイン中の管理者か」を判定するもので、公開サイトには当てはまらない。
  // 画面側は結果を待って管理コンソールのボタンを出すため、呼び出し自体は成立させて常に非管理者を返す。
  var LOCAL = {
    api_getViewerRole: function(){ return { email:'', identified:false, isAdmin:false, bootstrap:false, adminUrl:'', homeUrl:'' }; }
  };
  Object.keys(LOCAL).forEach(function(fn){
    Runner.prototype[fn] = function(){
      var self = this, value = LOCAL[fn]();
      setTimeout(function(){ if(self._ok) self._ok(value); }, 0);
      return null;
    };
  });
  FNS.forEach(function(fn){
    Runner.prototype[fn] = function(){
      var args = Array.prototype.slice.call(arguments);
      var self = this;
      fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fn: fn, args: args })
      }).then(function(res){
        return res.json().catch(function(){ return { ok:false, error:'応答を解釈できませんでした（HTTP ' + res.status + '）' }; });
      }).then(function(body){
        if(body && body.ok){ if(self._ok) self._ok(body.result); }
        else if(self._ng) self._ng(new Error((body && body.error) || '通信に失敗しました'));
      }).catch(function(err){
        if(self._ng) self._ng(err instanceof Error ? err : new Error(String(err)));
      });
      return null;
    };
  });
  // 画面側の hasGas 判定をそのまま通すため、同じ形の名前空間を用意する
  window.google = window.google || {};
  window.google.script = window.google.script || {};
  Object.defineProperty(window.google.script, 'run', { get: function(){ return new Runner(); } });
  // 管理コンソールへの切替は Google ログイン前提の機能。公開サイトでは常に非表示にする。
  window.api_getViewerRole = null;
})();
</script>
`;
}

/** GAS① の doGet と同じ結合順で1枚のHTMLにする */
function buildPage(){
  const base = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const patch = fs.readFileSync(path.join(SRC, 'portal_contract_v4_patch.html'), 'utf8');
  const withShim = base.indexOf('</head>') >= 0
    ? base.replace('</head>', shimScript() + '</head>')
    : shimScript() + base;
  return withShim.indexOf('</body>') >= 0
    ? withShim.replace('</body>', patch + '\n</body>')
    : (withShim + patch);
}

module.exports = { RPC_FUNCTIONS, buildPage, shimScript };
