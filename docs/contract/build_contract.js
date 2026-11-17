/**
 * SPLL 2段契約（基本契約 v5.0 ＋ 個別利用許諾書 v1.0）のレイアウト確認用ビルド。
 *
 *   基本契約（参加契約） … docs/SPLL_基本契約書_参加契約_v5.0.md
 *       CloudSign テンプレートに載せる固定文面。formrun（CloudSign FORM）経由で締結。差込は当事者欄だけ
 *   個別利用許諾書（別紙）… docs/SPLL_個別利用許諾書_v1.0.md
 *       専用ページでの申込みを受けて SPLL が台帳から PDF を作り、メールで送る（送付で個別契約が成立）。
 *       別表1（対象作品）は行数の上限なし。クラウドサインは使わない
 *
 * 本番では別紙の組み立てを GAS 側で行い、PDF を Drive に保存してメールに添付し、専用ページにも掲示する。
 * 基本契約はテンプレートとしてクラウドサインへ1回登録するだけ（ここで出す PDF はその版下）。
 *
 * 使い方:
 *   node docs/contract/build_contract.js           … サンプル HTML を docs/contract/ に出力
 *   node docs/contract/build_contract.js --pdf     … PDF も出力（Playwright が必要）
 *   --variant=A|B  … 基本契約の前文（A：代理／B：再許諾）。既定は両方出す
 * 依存パッケージなし（Markdown は両文書で使う書式だけを読む小さな変換で処理する）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const MA_SRC = path.join(ROOT, 'docs', 'SPLL_基本契約書_参加契約_v5.0.md');
const IL_SRC = path.join(ROOT, 'docs', 'SPLL_個別利用許諾書_v1.0.md');
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
const lineAfter = (md, marker) => { const i = md.indexOf(marker); return i < 0 ? '' : md.slice(i + marker.length).split('\n').find(l => l.trim()).trim(); };
const sentence = (md, head) => { const m = md.match(new RegExp('\\n(' + head + '[^\\n]+)\\n')); return m ? m[1] : ''; };

/** 個別条件のハッシュ（本番は台帳のスナップショットと同じ正規化に揃える） */
function termsHash(t){
  const canon = JSON.stringify([t.license_id, t.participant_id, t.usage_category, t.fee_amount_or_rate, t.fee_schedule_version, t.payment_due,
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
.var{font-size:7.5pt;color:#8a5a00;border:.25mm dashed #c9a24a;padding:.5mm 2mm;display:inline-block;margin-bottom:2mm}
`;
const page = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;

/* ---- 基本契約（参加契約）：CloudSign テンプレートの版下。差込欄は {{...}} のまま、またはサンプル値 ---- */
function buildMaster(p, variant){
  const md = fs.readFileSync(MA_SRC, 'utf8');
  const lead = lineAfter(md, variant === 'A' ? '【案A：代理】' : '【案B：再許諾】');
  const closing = sentence(md, '本契約の成立を証するため');
  const lic = variant === 'A' ? 'SPLL制度に参加する作品の各権利者（代理人 TRPGライツ事務局）' : 'TRPGライツ事務局';
  return page('SPLL基本契約書', `
<h1>SPLL基本契約書</h1>
<div class="var">前文：案${variant}（${variant === 'A' ? '事務局が各権利者の代理人として締結' : '事務局が再許諾権に基づき自ら締結'}）／法務確認前</div>
<p class="lead">${esc(lead)}</p>
<h2>当事者</h2>
<table class="terms">
${row('参加者番号', esc(p.participant_id))}
${row('利用者氏名', esc(p.party_name))}
${row('屋号・サークル名', esc(p.circle_name || '該当なし'))}
${row('住所', esc(p.party_address))}
${row('連絡先メールアドレス', esc(p.email))}
${row('ライセンサー', esc(lic))}
</table>
<p class="note">対象作品、利用区分、利用許諾料その他の個別の条件は、第3条に基づき個別契約ごとに定めます。</p>
<h2>本文</h2>
${articlesHtml(md)}
<p class="closing">${esc(closing)}</p>
<p class="end">以上</p>
<table class="terms parties">
${row('利用者', esc(p.party_name) + '（電子契約システム上で合意）')}
${row('ライセンサー', esc(lic) + '（電子契約システム上で合意）')}
</table>`);
}

/* ---- 個別利用許諾書：SPLL が台帳から生成して API で送る ---- */
function buildIndividual(t, variant){
  const md = fs.readFileSync(IL_SRC, 'utf8');
  const hash = termsHash(t);
  const lic = variant === 'A' ? '別表1に記載の各対象作品の権利者（代理人 TRPGライツ事務局）' : 'TRPGライツ事務局';
  const works = t.works.map((w, i) => `<tr><td class="no">${i + 1}</td><td>${esc(w.work_title)}</td><td>${esc(w.licensor_name)}</td><td>${esc(w.credit_text)}</td></tr>`).join('');
  const checks = md.slice(md.indexOf('## 確認事項'), md.indexOf('## 別表1')).split('\n').filter(l => /^\d+\. /.test(l)).map(l => `<li>${esc(l.replace(/^\d+\. /, ''))}</li>`).join('');
  const lead = sentence(md, 'TRPGライツ事務局は、参加者番号').replace('`{{participant_id}}`', t.participant_id).replace('`{{applied_at}}`', t.applied_at);
  return page('SPLL個別利用許諾書 ' + t.license_id, `
<h1>SPLL個別利用許諾書</h1>
<p class="lead">${esc(lead)}</p>
<h2>個別条件</h2>
<table class="terms">
${row('SPLL番号', esc(t.license_id))}
${row('参加者番号', esc(t.participant_id))}
${row('利用者氏名', esc(t.party_name) + (t.circle_name ? '（' + esc(t.circle_name) + '）' : ''))}
${row('対象作品', `別表1のとおり（全${t.works.length}作品）`)}
${row('ライセンサー', esc(lic))}
${row('利用区分', esc(t.usage_category))}
${row('許諾期間', esc(t.license_term))}
${row('利用地域', esc(t.territory))}
${row('利用許諾料', esc(t.fee_amount_or_rate) + '（料金表 ' + esc(t.fee_schedule_version) + ' により算定）')}
${row('支払期限', esc(t.payment_due) + '（振込先は基本契約第6条のとおり）')}
${row('利用報告', esc(t.reporting_terms))}
${row('権利表記', '別表1のとおり（基本契約第7条第1項）')}
${row('特約', esc(t.special_terms || '該当なし'))}
</table>
<p class="note">個別条件に空欄又は「該当なし」と記載された項目は、当該項目について追加の条件を設定するものではありません。</p>
<h2>確認事項</h2><ol>${checks}</ol>
<h2>別表1　対象作品</h2>
<div class="sum"><span>SPLL番号 ${esc(t.license_id)}</span><span>全${t.works.length}作品</span></div>
<table class="works"><thead><tr><th>No.</th><th>対象作品</th><th>権利者</th><th>権利表記</th></tr></thead><tbody>${works}</tbody></table>
<p class="end" style="margin-top:6mm">発行日：${esc(t.issued_at)}　発行者：TRPGライツ事務局</p>
<p class="end">以上</p>
<p class="note">条件照合コード：${hash}（本書の個別条件及び別表1が、SPLLの台帳に記録した内容と一致することの照合に用います）</p>`);
}

const headFoot = (left, right) => ({
  header: `<div style="font-size:7pt;color:#777;width:100%;padding:0 18mm;display:flex;justify-content:space-between;font-family:IPAGothic,sans-serif"><span>${left}</span><span>${right}</span></div>`,
  footer: (code) => `<div style="font-size:7pt;color:#777;width:100%;padding:0 18mm;display:flex;justify-content:space-between;font-family:IPAGothic,sans-serif"><span>${code}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`
});

/* ---- サンプル（架空の作品・権利者・利用者） ---- */
const PARTY = { participant_id: 'P-2026-00042', party_name: '山田 太郎', circle_name: '星屑工房',
  party_address: '東京都千代田区神田小川町1-2-3 サンプルビル4階', email: 'creator@example.com' };
const LICENSORS = ['株式会社サンプルゲームズ','ギルドワークス合同会社','アルヴァ制作委員会','月影書房','有限会社テーブルトーク企画'];
const TITLES = ['星喰いの迷宮','黄昏ギルド戦記','深淵図書館RPG','蒸気都市アルヴァ','月影の神話TRPG','辺境開拓記','夢見る機械の国','砂海のキャラバン','七つ鐘の聖堂','霧の港町奇譚','銀翼の騎士団','百鬼夜行録','氷原の探索者','星図なき航海','虹色魔法学園','黒鉄の帝国','風読みの谷','時計塔の秘密結社','竜骨山脈紀行','灯火の巡礼者','碧の庭園RPG','双子月の王国','忘れられた神々','路地裏怪異譚','終末の図書館'];
function sampleIndividual(id, n){
  return Object.assign({}, PARTY, {
    license_id: id, usage_category: '商品販売（同人誌・物販）', license_term: '個別契約の成立日から1年間（基本契約の有効期間内に限る）', territory: '日本国内',
    fee_amount_or_rate: '16,500円（税込）。対象作品が複数の場合も同額', fee_schedule_version: '2026-10版',
    applied_at: '2026年11月17日 10時12分', issued_at: '2026年11月17日', payment_due: '2026年12月17日（本書の発行日から30日。後払い）',
    reporting_terms: '定額のため利用報告は不要', special_terms: '',
    works: Array.from({ length: n }, (_, i) => {
      const lic = LICENSORS[i % LICENSORS.length], title = TITLES[i % TITLES.length];
      return { work_id: 'W' + String(i + 1).padStart(3, '0'), work_title: title, licensor_name: lic, credit_text: '©' + lic + '／「' + title + '」' };
    })
  });
}

async function main(){
  const pdf = process.argv.includes('--pdf');
  const vArg = (process.argv.find(a => a.startsWith('--variant=')) || '').split('=')[1];
  const variants = vArg ? [vArg] : ['A', 'B'];
  const jobs = [];
  variants.forEach(v => jobs.push({ name: `SPLL_基本契約書サンプル_v5.0_案${v}`, html: buildMaster(PARTY, v),
    hf: headFoot('SPLL-MA-001 / v5.0', 'SPLL基本契約書'), code: PARTY.participant_id }));
  [['3作品', 3, 'SPLL-2026-0131'], ['25作品', 25, 'SPLL-2026-0129']].forEach(([label, n, id]) => {
    const t = sampleIndividual(id, n);
    jobs.push({ name: `SPLL_個別利用許諾書サンプル_v1.0_${label}`, html: buildIndividual(t, variants[variants.length - 1]),
      hf: headFoot('SPLL-IL-001 / v1.0', 'SPLL個別利用許諾書'), code: `${t.license_id}　参加者番号 ${t.participant_id}　条件照合コード ${termsHash(t)}` });
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
