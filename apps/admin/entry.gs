/** GAS③ 管理コンソール エントリ（SEC-01：組織内限定で公開すること） */
function doGet(e){
  const out = serveAdmin_(e);
  const base = out.getContent();
  if(base.indexOf('SPLL 事務局 管理コンソール') < 0) return out;
  const contractPatch = HtmlService.createHtmlOutputFromFile('admin_contract_v4_patch').getContent();
  const partnershipPatch = HtmlService.createHtmlOutputFromFile('admin_partnership_patch').getContent();
  const patch = contractPatch + '\n' + partnershipPatch;
  const html = base.indexOf('</body>') >= 0 ? base.replace('</body>', patch + '\n</body>') : (base + patch);
  return HtmlService.createHtmlOutput(html).setTitle('SPLL 管理コンソール');
}