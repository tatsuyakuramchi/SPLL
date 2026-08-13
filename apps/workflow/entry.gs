/** GAS② 契約・提出・Webhook エントリ（SEC-01） */
function doGet(e){
  const page = (e && e.parameter && e.parameter.page) || '';
  if(page === 'upload') return serveUpload_(e);
  if(page === 'guide')  return serveGuide_(e);
  if(page === 'badge')  return serveBadge_(e);
  if(page === 'verify') return serveVerify_(e);
  return htmlPage_('SPLL', '<h2>SPLL 業務システム</h2><p>このURLは提出・報告・検証用の専用リンクからご利用ください。</p>');
}
function doPost(e){
  const hook = (e && e.parameter && e.parameter.hook) || '';
  return receiveWebhook_(hook === 'formrun' ? 'FORMRUN' : 'CLOUDSIGN', e);
}
