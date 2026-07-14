/** GAS① 公開ポータル エントリ（SEC-01：管理機能・Webhook・トークン処理を含まない） */
function doGet(e){
  return HtmlService.createHtmlOutputFromFile('index').setTitle('SPLL 利用申込窓口');
}
