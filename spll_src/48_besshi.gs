/**
 * SPLL 48_besshi ― 別紙（許諾作品通知書）の HTML と PDF（改修計画 P0-5 試作 / P4-2）
 *
 * 正本の文面は docs/SPLL_別紙_許諾作品通知書_v1.0.md。ここにある文言は正本と同じでなければならない
 * （tests/harness.js が一致を確かめる）。レイアウトの基準は docs/contract/build_contract.js のサンプルPDF。
 *
 * PDF は GAS の HTML→PDF 変換（Utilities.newBlob(html).getAs('application/pdf')）で作る。
 * この変換はブラウザより CSS の対応が狭いので、表とページ送りは単純な指定に留める。
 * 見た目の確認は setup_testBesshiPdf()（GASエディタから実行）で、作品数 3・25・100 の PDF を Drive に出して行う。
 */
const BESSHI_VERSION = 'v1.0';
const BESSHI_DOC_NO = 'SPLL-LIC-001-A';
/** 当事者表記（固定。利用許諾契約書 前文） */
const SPLL_PARTY_NAME = 'SPLL事業TRPG事務局代表法人株式会社アークライト';
const BESSHI_CHECKS = [
  '本別紙は、利用者が電子契約システム上で同意した時点で本契約に追加されます（本契約書第3条第3項）。送信から3か月以内に同意がない場合、本別紙は効力を失います（同第4項）。',
  '前払いの場合、許諾は事務局が入金を確認した時点で効力を生じます。本別紙の追加から3か月以内に入金が確認できない場合、本別紙は効力を失います（本契約書第6条第5項）。',
  '後払いの場合、許諾は本別紙の追加の時点で効力を生じます。支払期限までにお支払いがない場合、認証が一時停止されることがあります（本契約書第6条第6項）。',
  '利用許諾料は、本契約書第6条に記載の振込先へお支払いください。事務局が本別紙や電子メールで口座情報をお知らせすることはありません。',
  '二次創作物は、許諾の効力が生じた後、事務局の案内に従い提出し、審査を受けてください。認証及び認証バッジは、審査で承認された後に発行されます（本契約書第8条第5項）。',
  '本契約が終了した場合、本別紙に基づく許諾も同時に終了します（本契約書第12条第3項）。'
];
const BESSHI_CLOSING = '本別紙への同意を証するため、本別紙の電磁的記録を作成し、利用者及び事務局が電子契約システム上で合意の措置を講じ、各自その電磁的記録を保管します。';
const PAYMENT_TIMING_LABEL = { PREPAID: '前払い', POSTPAID: '後払い' };

function besshiEsc_(v){
  return String(v == null ? '' : v).replace(/[&<>"]/g, function(m){ return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m]; });
}

/** 別紙の条件照合コード（台帳のスナップショットと同じ並びで正規化して SHA-256 の先頭16桁） */
function besshiHash_(t){
  const canon = JSON.stringify([t.license_id, t.agreement_no, t.usage_category, t.fee_amount_or_rate, t.fee_schedule_version,
    t.payment_timing, t.payment_due, (t.works || []).map(function(w){ return [w.work_id || '', w.work_title, w.licensor_name, w.credit_text]; })]);
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, canon, Utilities.Charset.UTF_8);
  return bytes.map(function(b){ return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('').slice(0, 16);
}

/**
 * 別紙の HTML（1枚のページ。改ページは変換に任せ、表は行ごとに分かれないようにする）。
 *   t … { license_id, agreement_no, party_name, circle_name, usage_category, license_term, territory,
 *         fee_amount_or_rate, fee_schedule_version, payment_timing(PREPAID|POSTPAID), payment_due,
 *         reporting_terms, special_terms, applied_at, issued_at, works:[{ work_id, work_title, licensor_name, credit_text }] }
 */
function besshiHtml_(t){
  const e = besshiEsc_;
  const works = t.works || [];
  const code = besshiHash_(t);
  const row = function(k, v){ return '<tr><th>' + k + '</th><td>' + v + '</td></tr>'; };
  const lead = e(SPLL_PARTY_NAME) + '（以下「事務局」といいます。）は、各ライセンサーを代表して、契約番号 ' + e(t.agreement_no) +
    ' の SPLL利用許諾契約（以下「本契約」といいます。）第3条に基づき、' + e(t.applied_at) +
    ' に受け付けた利用者の申込みについて、次の対象作品及び条件による許諾を本契約に追加することを提案します。' +
    '利用者が電子契約システム上で本別紙に同意した時点で、本別紙は本契約に追加されます。本別紙に定めのない事項は本契約及びガイドラインによります。';
  const css = [
    '@page{size:A4;margin:18mm 16mm 16mm}',
    'body{font-family:"Noto Sans JP","IPAGothic",sans-serif;font-size:9pt;line-height:1.6;color:#1a1f24}',
    '.meta{font-size:7.5pt;color:#666;border-bottom:1px solid #ccc;padding-bottom:2mm;margin-bottom:4mm}',
    'h1{text-align:center;font-size:14pt;margin:2mm 0 1mm}',
    '.sub{text-align:center;font-size:11pt;margin:0 0 5mm}',
    'h2{font-size:10.5pt;margin:5mm 0 2mm;padding-bottom:1mm;border-bottom:1.2px solid #333}',
    'table{border-collapse:collapse;width:100%}',
    'th,td{border:0.8px solid #8b949c;padding:1.4mm 2.2mm;vertical-align:top;text-align:left;font-weight:normal}',
    '.terms th{width:28%;background:#f1f3f4}',
    '.works thead th{background:#f1f3f4;font-weight:bold}',
    '.works thead{display:table-header-group}',
    '.works tr{page-break-inside:avoid}',
    '.no{text-align:right;width:9mm}',
    '.note{font-size:8pt;color:#444;margin:1.5mm 0 0}',
    'ol{margin:0;padding-left:5mm} li{margin:0 0 1mm}',
    '.end{text-align:right;margin:3mm 0 0}',
    '.code{font-size:7.5pt;color:#555;margin-top:3mm}'
  ].join('\n');
  const workRows = works.map(function(w, i){
    return '<tr><td class="no">' + (i + 1) + '</td><td>' + e(w.work_title) + '</td><td>' + e(w.licensor_name) + '</td><td>' + e(w.credit_text) + '</td></tr>';
  }).join('');
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>SPLL別紙 ' + e(t.license_id) + '</title><style>' + css + '</style></head><body>' +
    '<div class="meta">' + BESSHI_DOC_NO + ' / ' + BESSHI_VERSION + '　SPLL番号 ' + e(t.license_id) + '　契約番号 ' + e(t.agreement_no) + '　条件照合コード ' + code + '</div>' +
    '<h1>SPLL利用許諾契約　別紙</h1><div class="sub">（許諾作品通知書）</div>' +
    '<p>' + lead + '</p>' +
    '<h2>許諾の条件</h2><table class="terms">' +
    row('SPLL番号', e(t.license_id)) + row('契約番号', e(t.agreement_no)) +
    row('利用者氏名', e(t.party_name) + (t.circle_name ? '（' + e(t.circle_name) + '）' : '')) +
    row('対象作品', '下表のとおり（全' + works.length + '作品）') +
    row('ライセンサー', '下表に記載の各対象作品の権利者（パートナー）。代表：' + e(SPLL_PARTY_NAME)) +
    row('利用区分', e(t.usage_category)) + row('許諾期間', e(t.license_term)) + row('利用地域', e(t.territory)) +
    row('利用許諾料', e(t.fee_amount_or_rate) + '（料金表 ' + e(t.fee_schedule_version) + ' により算定）') +
    row('支払方法', e(PAYMENT_TIMING_LABEL[t.payment_timing] || t.payment_timing) + '（利用区分により料金表で定める）') +
    row('支払期限', e(t.payment_due) + '（振込先は本契約書第6条のとおり）') +
    row('利用報告', e(t.reporting_terms)) + row('権利表記', '下表のとおり（本契約書第7条第1項）') +
    row('特約', e(t.special_terms || '該当なし')) + '</table>' +
    '<p class="note">空欄又は「該当なし」と記載された項目は、当該項目について追加の条件を設定するものではありません。</p>' +
    '<h2>確認事項</h2><ol>' + BESSHI_CHECKS.map(function(c){ return '<li>' + e(c) + '</li>'; }).join('') + '</ol>' +
    '<h2>対象作品</h2><table class="works"><thead><tr><th class="no">No.</th><th>対象作品</th><th>権利者（ライセンサー）</th><th>権利表記</th></tr></thead><tbody>' +
    workRows + '</tbody></table>' +
    '<p>' + e(BESSHI_CLOSING) + '</p>' +
    '<p class="end">作成日：' + e(t.issued_at) + '　作成者：' + e(SPLL_PARTY_NAME) + '</p><p class="end">以上</p>' +
    '<p class="code">条件照合コード：' + code + '（本別紙の条件及び対象作品が、SPLLの台帳に記録した内容と一致することの照合に用います）</p>' +
    '</body></html>';
}

/** 別紙の PDF（Blob）。ファイル名は SPLL番号 */
function besshiPdfBlob_(t){
  const html = besshiHtml_(t);
  return Utilities.newBlob(html, 'text/html', 'besshi.html').getAs('application/pdf').setName('SPLL別紙_' + t.license_id + '.pdf');
}

/** 試作用のサンプル条件（架空の作品・権利者） */
function besshiSampleTerms_(n, timing){
  const lic = ['株式会社サンプルゲームズ','ギルドワークス合同会社','アルヴァ制作委員会','月影書房','有限会社テーブルトーク企画'];
  const titles = ['星喰いの迷宮','黄昏ギルド戦記','深淵図書館RPG','蒸気都市アルヴァ','月影の神話TRPG','辺境開拓記','夢見る機械の国','砂海のキャラバン','七つ鐘の聖堂','霧の港町奇譚'];
  const works = [];
  for(let i = 0; i < n; i++){
    const l = lic[i % lic.length], ti = titles[i % titles.length] + (i >= titles.length ? ' 第' + (Math.floor(i / titles.length) + 1) + '版' : '');
    works.push({ work_id: 'W' + (i + 1), work_title: ti, licensor_name: l, credit_text: '©' + l + '／「' + ti + '」' });
  }
  const pre = timing !== 'POSTPAID';
  return { license_id: 'SPLL-TEST-' + n, agreement_no: 'C-TEST-0001', party_name: '山田 太郎（サンプル）', circle_name: '星屑工房',
    usage_category: pre ? '商品販売（同人誌・物販）' : '電子配信（ダウンロード販売）',
    license_term: '本別紙が本契約に追加された日から1年間（本契約の有効期間内に限る）', territory: '日本国内',
    fee_amount_or_rate: pre ? '16,500円（税込）。対象作品が複数の場合も同額' : '販売額（税抜）の10%', fee_schedule_version: '2026-10版',
    payment_timing: pre ? 'PREPAID' : 'POSTPAID',
    payment_due: pre ? '本別紙が本契約に追加された日から3か月以内（入金確認で許諾が有効）' : '各四半期の末日から30日以内（利用報告に基づき算定）',
    reporting_terms: pre ? '定額のため利用報告は不要' : '四半期ごとに販売数・販売額を報告（四半期末から15日以内）',
    special_terms: '', applied_at: '2026年11月18日 10時00分', issued_at: '2026年11月18日', works: works };
}

/**
 * 【GASエディタから実行】別紙PDFの見た目の確認（改修計画 P0-5）。
 * 作品数 3（前払い）・25（後払い）・100（前払い）の PDF を Drive の「SPLL_別紙試作」フォルダに出し、URL を返す。
 * 確認すること：表の見出しが各ページに繰り返されるか／行がページの境目で割れないか／日本語の書体／余白。
 */
function setup_testBesshiPdf(){
  const parent = DriveApp.getFolderById(prop_('DRIVE_ROOT'));
  const folder = parent.createFolder('SPLL_別紙試作_' + Utilities.formatDate(new Date(), 'JST', 'yyyyMMdd_HHmm'));
  const out = [[3, 'PREPAID'], [25, 'POSTPAID'], [100, 'PREPAID']].map(function(p){
    const t0 = new Date().getTime();
    const file = folder.createFile(besshiPdfBlob_(besshiSampleTerms_(p[0], p[1])));
    return { works: p[0], timing: p[1], ms: new Date().getTime() - t0, url: file.getUrl() };
  });
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
