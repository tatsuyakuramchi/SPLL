/** GAS① 公開ポータル エントリ（SEC-01：管理機能・Webhook・トークン処理を含まない） */
function doGet(e){
  const base = HtmlService.createHtmlOutputFromFile('index').getContent();
  const patch = HtmlService.createHtmlOutputFromFile('portal_contract_v4_patch').getContent();
  const html = base.indexOf('</body>') >= 0 ? base.replace('</body>', patch + '\n</body>') : (base + patch);
  return HtmlService.createHtmlOutput(html).setTitle('SPLL 利用申込窓口');
}
