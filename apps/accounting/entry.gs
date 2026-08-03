/** GAS④ 経理連携 エントリ（SPLL-SYS-AD-001 §4.1：Webhook受信・匿名公開関数を含めない） */
function doGet(e){
  return HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;max-width:640px;margin:40px auto">' +
    '<h2>SPLL 経理連携（GAS④）</h2>' +
    '<p>このプロジェクトは経理ジョブ（原票取込・突合・配分・照合・帳票生成）の実行基盤です。</p>' +
    '<p>操作は管理コンソール（GAS③）の「経理連携」タブから行ってください。</p></div>'
  ).setTitle('SPLL 経理連携');
}
