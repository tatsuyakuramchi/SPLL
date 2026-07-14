/** SPLL 90_main ― 単一プロジェクト（モノリス）用エントリ。3分割デプロイでは各 apps/<app>/entry.gs を使用（本ファイルは配布対象外） */


// ============================================================
// 1. GAS① 公開入口Webアプリ
// ============================================================
function doGet(e){
  // プロジェクトごとに出し分け（GAS①=index, GAS③=admin, 利用報告=report?token=）
  const page = (e && e.parameter && e.parameter.page) || 'index';
  if(page === 'report') return serveReport_(e);             // 利用報告（トークン）
  if(page === 'upload') return serveUpload_(e);             // 作品提出（トークン）
  if(page === 'badge')  return serveBadge_(e);              // 認証バッジDL（トークン）
  if(page === 'verify') return serveVerify_(e);             // 認証の検証ポータル（ID照会・受付番号）
  if(page === 'admin')  return serveAdmin_(e);              // 管理コンソール（任意で許可リスト制御）
  return HtmlService.createHtmlOutputFromFile('index').setTitle('SPLL 利用申込窓口');
}

// 注：契約書の作成・送信は「クラウドサインフォーム powered by formrun」で完結する。
// GAS からの CloudSign 送信は行わない（申込→締結は FormRun→CloudSign 直結）。
// GAS が CloudSign API を使うのは清算計算書のみ（cloudSignSendStatement_）。

/** Webフック受け口。?hook=formrun は申込連携、既定は CloudSign 締結完了。 */
function doPost(e){
  const hook = (e && e.parameter && e.parameter.hook) || '';
  return receiveWebhook_(hook === 'formrun' ? 'FORMRUN' : 'CLOUDSIGN', e);
}
