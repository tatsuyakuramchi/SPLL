/**
 * SPLL 利用許諾契約書 v5.0 ＋ 別紙（許諾作品通知書）v1.0 のレイアウト確認用ビルド。
 *
 *   利用許諾契約書       … docs/SPLL_利用許諾契約書_v5.0.md
 *       CloudSign テンプレートに載せる固定文面。formrun（CloudSign FORM）経由で締結。差込は当事者欄だけ
 *   別紙（許諾作品通知書）… docs/SPLL_別紙_許諾作品通知書_v1.0.md
 *       専用ページでの申込みを受けて SPLL が台帳から PDF を作り、CloudSign API で送る（利用者の同意で本契約に追加）。
 *       対象作品の表は行数の上限なし
 *
 * 本番では別紙の組み立てを GAS 側で行い、PDF を Drive に保存して POST /documents/{id}/files へ渡す。
 * 利用許諾契約書はテンプレートとしてクラウドサインへ1回登録するだけ（ここで出す PDF はその版下）。
 *
 * 使い方:
 *   node docs/contract/build_contract.js           … サンプル HTML を docs/contract/ に出力
 *   node docs/contract/build_contract.js --pdf     … PDF も出力（Playwright が必要）
 * 依存パッケージなし（Markdown は両文書で使う書式だけを読む小さな変換で処理する）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const MA_SRC = path.join(ROOT, 'docs', 'SPLL_利用許諾契約書_v5.0.md');
const IL_SRC = path.join(ROOT, 'docs', 'SPLL_別紙_許諾作品通知書_v1.0.md');
const OUT = __dirname;

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m]));

/** 「## 第1条」〜「以上」の前の締結文言まで を HTML にする。見出し・番号付き（2段まで）・段落だけを扱う */
function articlesHtml(md){
  const start = md.indexOf('## 第1条');
  const end = md.indexOf('\n本契約の成立を証するため', start);
  const lines = md.slice(start, end).split('\n');
  let html = '', inArticle = false, depth = 0;
  const closeLists = to => { while(depth > to){ html += '</li></ol>'; depth--; } };
  for(const raw of lines){
    if(/^---\s*$/.test(raw) || !raw.trim()) continue;
    let m;
    if((m = raw.match(/^## (.+)$/))){
      closeLists(0); if(inArticle) html += '</section>';
      html += `<section class="art"><h3>${esc(m[1])}</h3>`; inArticle = true; continue;
    }
    if((m = raw.match(/^(\s*)\d+\. (.+)$/))){
      const level = m[1].length >= 3 ? 2 : 1;
      if(level > depth){ html += level === 2 ? '<ol class="sub">' : '<ol>'; depth = level; }
      else { closeLists(level); html += '</li>'; }
      html += `<li>${esc(m[2])}`; continue;
    }
    closeLists(0);
    html += `<p>${esc(raw.trim())}</p>`;
  }
  closeLists(0); if(inArticle) html += '</section>';
  return html;
}
const sentence = (md, head) => { const m = md.match(new RegExp('\\n(' + head + '[^\\n]+)\\n')); return m ? m[1] : ''; };

/** 別紙の条件のハッシュ（本番は台帳のスナップショットと同じ正規化に揃える） */
function termsHash(t){
  const canon = JSON.stringify([t.license_id, t.agreement_no, t.usage_category, t.fee_amount_or_rate, t.fee_schedule_version, t.payment_timing, t.payment_due,
    t.works.map(w => [w.work_id, w.work_title, w.licensor_name, w.credit_text])]);
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

const CSS = `
@page{size:A4;margin:20mm 18mm 18mm}
*{box-sizing:border-box}
body{margin:0;color:#1a1f24;font-family:"IPAGothic","Yu Gothic","Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;font-size:9.2pt;line-height:1.65}
h1{text-align:center;font-size:17pt;letter-spacing:.18em;margin:2mm 0 6mm;font-weight:700}
.lead{margin:0 0 5mm;text-indent:1em}
h2{font-size:10.5pt;margin:6mm 0 2mm;padding-bottom:1mm;border-bottom:.4mm solid #333}
table{border-collapse:collapse;width:100%}
th,td{border:.25mm solid #8b949c;padding:1.6mm 2.4mm;vertical-align:top;text-align:left;font-weight:400}
.terms th{width:28%;background:#f1f3f4}
.note{font-size:8.4pt;color:#444;margin:2mm 0 0}
.art{margin:0 0 3.2mm}
.art h3{font-size:9.8pt;margin:0 0 1mm;break-after:avoid}
.art p{margin:0 0 1mm}
ol{margin:0;padding-left:5.5mm}
ol.sub{list-style:none;counter-reset:s;padding-left:8mm}
ol.sub>li{counter-increment:s;position:relative}
ol.sub>li::before{content:"(" counter(s) ")";position:absolute;left:-8mm;width:7mm;text-align:right}
li{margin:0 0 .6mm}
.closing{margin:5mm 0 0;text-indent:1em}
.end{text-align:right;margin:3mm 0 0}
.parties{margin-top:6mm;break-inside:avoid}
.parties td{height:12mm;vertical-align:middle}
.parties th{width:28%;background:#f1f3f4;vertical-align:middle}
.works thead th{background:#f1f3f4;font-weight:700;white-space:nowrap}
.works thead{display:table-header-group}
.works tr{break-inside:avoid}
.works td.no{text-align:right;width:10mm;font-variant-numeric:tabular-nums}
.works td:nth-child(2){width:32%} .works td:nth-child(3){width:26%}
.sum{display:flex;justify-content:space-between;margin:0 0 2mm;font-size:8.6pt;color:#333}
`;
const page = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;

/* ---- 利用許諾契約書：CloudSign テンプレートの版下（サンプル値入り） ---- */
function buildMaster(p){
  const md = fs.readFileSync(MA_SRC, 'utf8');
  const lead = sentence(md, 'TRPGライツ事務局（以下「事務局」又は「ライセンサー」');
  const closing = sentence(md, '本契約の成立を証するため');
  const lic = 'TRPGライツ事務局';
  return page('SPLL利用許諾契約書', `
<h1>SPLL利用許諾契約書</h1>

<p class="lead">${esc(lead)}</p>
<h2>当事者</h2>
<table class="terms">
${row('契約番号', esc(p.agreement_no))}
${row('利用者氏名', esc(p.party_name))}
${row('屋号・サークル名', esc(p.circle_name || '該当なし'))}
${row('住所', esc(p.party_address))}
${row('連絡先メールアドレス', esc(p.email))}
${row('ライセンサー', esc(lic))}
</table>
<p class="note">対象作品、利用区分、利用許諾料その他の条件は、第3条に基づき本契約に追加される別紙で定めます。</p>
<h2>本文</h2>
${articlesHtml(md)}
<p class="closing">${esc(closing)}</p>
<p class="end">以上</p>
<table class="terms parties">
${row('利用者', esc(p.party_name) + '（電子契約システム上で合意）')}
${row('ライセンサー', esc(lic) + '（電子契約システム上で合意）')}
</table>`);
}

/* ---- 別紙（許諾作品通知書）：SPLL が台帳から生成して CloudSign API で送る ---- */
function buildIndividual(t){
  const md = fs.readFileSync(IL_SRC, 'utf8');
  const hash = termsHash(t);
  const lic = 'TRPGライツ事務局（対象作品の権利者から再許諾権を得て許諾します）';
  const works = t.works.map((w, i) => `<tr><td class="no">${i + 1}</td><td>${esc(w.work_title)}</td><td>${esc(w.licensor_name)}</td><td>${esc(w.credit_text)}</td></tr>`).join('');
  const checks = md.slice(md.indexOf('## 確認事項'), md.indexOf('## 対象作品')).split('\n').filter(l => /^\d+\. /.test(l)).map(l => `<li>${esc(l.replace(/^\d+\. /, ''))}</li>`).join('');
  const lead = sentence(md, 'TRPGライツ事務局は、契約番号').replace('`{{agreement_no}}`', t.agreement_no).replace('`{{applied_at}}`', t.applied_at);
  return page('SPLL別紙 ' + t.license_id, `
<h1 style="font-size:14pt;letter-spacing:.08em">SPLL利用許諾契約　別紙<br><span style="font-size:11pt">（許諾作品通知書）</span></h1>
<p class="lead">${esc(lead)}</p>
<h2>許諾の条件</h2>
<table class="terms">
${row('SPLL番号', esc(t.license_id))}
${row('契約番号', esc(t.agreement_no))}
${row('利用者氏名', esc(t.party_name) + (t.circle_name ? '（' + esc(t.circle_name) + '）' : ''))}
${row('対象作品', `下表のとおり（全${t.works.length}作品）`)}
${row('ライセンサー', esc(lic))}
${row('利用区分', esc(t.usage_category))}
${row('許諾期間', esc(t.license_term))}
${row('利用地域', esc(t.territory))}
${row('利用許諾料', esc(t.fee_amount_or_rate) + '（料金表 ' + esc(t.fee_schedule_version) + ' により算定）')}
${row('支払方法', esc(t.payment_timing) + '（利用区分により料金表で定める）')}
${row('支払期限', esc(t.payment_due) + '（振込先は本契約書第6条のとおり）')}
${row('利用報告', esc(t.reporting_terms))}
${row('権利表記', '下表のとおり（本契約書第7条第1項）')}
${row('特約', esc(t.special_terms || '該当なし'))}
</table>
<p class="note">空欄又は「該当なし」と記載された項目は、当該項目について追加の条件を設定するものではありません。</p>
<h2>確認事項</h2><ol>${checks}</ol>
<h2>対象作品</h2>
<div class="sum"><span>SPLL番号 ${esc(t.license_id)}</span><span>全${t.works.length}作品</span></div>
<table class="works"><thead><tr><th>No.</th><th>対象作品</th><th>権利者</th><th>権利表記</th></tr></thead><tbody>${works}</tbody></table>
<p class="closing">${esc(sentence(md, '本別紙への同意を証するため'))}</p>
<p class="end" style="margin-top:4mm">作成日：${esc(t.issued_at)}　作成者：TRPGライツ事務局</p>
<p class="end">以上</p>
<p class="note">条件照合コード：${hash}（本別紙の条件及び対象作品が、SPLLの台帳に記録した内容と一致することの照合に用います）</p>`);
}

const headFoot = (left, right) => ({
  header: `<div style="font-size:7pt;color:#777;width:100%;padding:0 18mm;display:flex;justify-content:space-between;font-family:IPAGothic,sans-serif"><span>${left}</span><span>${right}</span></div>`,
  footer: (code) => `<div style="font-size:7pt;color:#777;width:100%;padding:0 18mm;display:flex;justify-content:space-between;font-family:IPAGothic,sans-serif"><span>${code}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`
});

/* ---- サンプル（架空の作品・権利者・利用者） ---- */
const PARTY = { agreement_no: 'C-2026-00042', party_name: '山田 太郎', circle_name: '星屑工房',
  party_address: '東京都千代田区神田小川町1-2-3 サンプルビル4階', email: 'creator@example.com' };
const LICENSORS = ['株式会社サンプルゲームズ','ギルドワークス合同会社','アルヴァ制作委員会','月影書房','有限会社テーブルトーク企画'];
const TITLES = ['星喰いの迷宮','黄昏ギルド戦記','深淵図書館RPG','蒸気都市アルヴァ','月影の神話TRPG','辺境開拓記','夢見る機械の国','砂海のキャラバン','七つ鐘の聖堂','霧の港町奇譚','銀翼の騎士団','百鬼夜行録','氷原の探索者','星図なき航海','虹色魔法学園','黒鉄の帝国','風読みの谷','時計塔の秘密結社','竜骨山脈紀行','灯火の巡礼者','碧の庭園RPG','双子月の王国','忘れられた神々','路地裏怪異譚','終末の図書館'];
/* 3作品＝商品販売（定額・前払い）、25作品＝電子配信（売上連動・後払い）。支払方法は利用区分で決まる */
const USAGE = {
  prepaid:  { usage_category: '商品販売（同人誌・物販）', fee_amount_or_rate: '16,500円（税込）。対象作品が複数の場合も同額', payment_timing: '前払い',
              payment_due: '本別紙が本契約に追加された日から3か月以内（入金確認で許諾が有効）', reporting_terms: '定額のため利用報告は不要' },
  postpaid: { usage_category: '電子配信（ダウンロード販売）', fee_amount_or_rate: '販売額（税抜）の10%', payment_timing: '後払い',
              payment_due: '各四半期の末日から30日以内（利用報告に基づき算定）', reporting_terms: '四半期ごとに販売数・販売額を報告（四半期末から15日以内）' },
};
function sampleIndividual(id, n, mode){
  return Object.assign({}, PARTY, USAGE[mode], {
    license_id: id, license_term: '本別紙が本契約に追加された日から1年間（本契約の有効期間内に限る）', territory: '日本国内',
    fee_schedule_version: '2026-10版', applied_at: '2026年11月17日 10時12分', issued_at: '2026年11月17日', special_terms: '',
    works: Array.from({ length: n }, (_, i) => {
      const lic = LICENSORS[i % LICENSORS.length], title = TITLES[i % TITLES.length];
      return { work_id: 'W' + String(i + 1).padStart(3, '0'), work_title: title, licensor_name: lic, credit_text: '©' + lic + '／「' + title + '」' };
    })
  });
}

async function main(){
  const pdf = process.argv.includes('--pdf');
  const jobs = [];
  jobs.push({ name: 'SPLL_利用許諾契約書サンプル_v5.0', html: buildMaster(PARTY),
    hf: headFoot('SPLL-LIC-001 / v5.0', 'SPLL利用許諾契約書'), code: '契約番号 ' + PARTY.agreement_no });
  [['3作品_前払い', 3, 'SPLL-2026-0131', 'prepaid'], ['25作品_後払い', 25, 'SPLL-2026-0129', 'postpaid']].forEach(([label, n, id, mode]) => {
    const t = sampleIndividual(id, n, mode);
    jobs.push({ name: `SPLL_別紙サンプル_v1.0_${label}`, html: buildIndividual(t),
      hf: headFoot('SPLL-LIC-001-A / v1.0', 'SPLL利用許諾契約 別紙'), code: `${t.license_id}　契約番号 ${t.agreement_no}　条件照合コード ${termsHash(t)}` });
  });
  let browser = null;
  for(const j of jobs){
    const htmlPath = path.join(OUT, j.name + '.html');
    fs.writeFileSync(htmlPath, j.html);
    console.log('html:', path.relative(ROOT, htmlPath));
    if(pdf){
      if(!browser) browser = await require('playwright').chromium.launch();
      const p = await browser.newPage();
      await p.goto('file://' + htmlPath);
      const pdfPath = htmlPath.replace(/\.html$/, '.pdf');
      await p.pdf({ path: pdfPath, format: 'A4', preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: j.hf.header, footerTemplate: j.hf.footer(j.code) });
      await p.close();
      console.log('pdf :', path.relative(ROOT, pdfPath));
    }
  }
  if(browser) await browser.close();
}
if(require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { buildMaster, buildIndividual, articlesHtml, termsHash };
