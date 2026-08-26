/**
 * クリエーター向けページのHTMLを組み立てる。
 *
 * 正本は spll_src/*.html（GASが配信しているものと同じ）。GAS側と同じ結合・差込を行い、
 * 画面の実装を二重に持たない。Cloud Run 側の差分は「google.script.run のかわりに
 * HTTPでRPCする shim を先に読み込ませる」ことだけ。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'spll_src');

/**
 * 画面から呼び出してよい関数と、その転送先。
 *   portal   … GAS①（申込。スプレッドシートのみ触れる狭い権限）
 *   workflow … GAS②（提出・案内・検証・バッジ。トークンで守られる）
 * サーバー側の許可リストと同じ並び。ここに無い関数はshimに生えないし、サーバーも通さない。
 */
const RPC_TARGETS = {
  api_listWorks:               'portal',
  api_getUsageOptions:         'portal',
  api_previewFeeTerms:         'portal',
  api_getLegalTexts:           'portal',
  api_getLegalTextsV4:         'portal',
  api_getApplyConfig:          'portal',
  web_createApplicationV4:     'portal',
  web_getSubmitContext:        'workflow',
  web_submitWork:              'workflow',
  web_openDriveSubmission:     'workflow',
  web_finalizeDriveSubmission: 'workflow',
  web_getGuideContext:         'workflow',
  web_getSubmitLinkFromGuide:  'workflow',
  web_verifyCertificate:       'workflow',
  web_getBadgeContext:         'workflow',
  web_getBadgeImage:           'workflow'
};
const RPC_FUNCTIONS = Object.keys(RPC_TARGETS);

/**
 * google.script.run 互換のクライアント。
 * withSuccessHandler / withFailureHandler の連鎖と、関数名での呼び出しを再現する。
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
  window.api_getViewerRole = null;
})();
</script>
`;
}

function withShim(html){
  return html.indexOf('</head>') >= 0 ? html.replace('</head>', shimScript() + '</head>') : shimScript() + html;
}
function read(name){ return fs.readFileSync(path.join(SRC, name), 'utf8'); }

/** 申込窓口。GAS① の doGet と同じ結合順で1枚のHTMLにする。 */
function buildPortalPage(){
  const base = withShim(read('index.html'));
  const patch = read('portal_contract_v4_patch.html');
  return base.indexOf('</body>') >= 0 ? base.replace('</body>', patch + '\n</body>') : (base + patch);
}

/**
 * 提出・案内ページ。GASでは HtmlService のテンプレートとして `<?= token ?>` を差し込んでいる。
 * 差込はこの1箇所だけなので、同じ値を同じ場所へ入れる。
 */
function buildTokenPage(file, token){
  const safe = String(token || '').replace(/[^A-Za-z0-9._~%-]/g, '');   // URLトークン以外の文字は落とす
  return withShim(read(file)).split('<?= token ?>').join(safe);
}

module.exports = { RPC_TARGETS, RPC_FUNCTIONS, buildPortalPage, buildTokenPage, shimScript };
