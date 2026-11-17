/**
 * SPLL 利用許諾契約書 v4.2（CloudSign API 送付版）のレイアウト確認用ビルド。
 *
 * 正本 docs/SPLL_利用許諾契約書_CloudSign_API対応_v4.2.md の本文（前文・第1条〜第19条）を読み、
 * 個別条件と別表1（対象作品：行数の上限なし）を差し込んだ A4 の HTML を組み立てる。
 * 本番では同じ組み立てを GAS 側で行い、PDF にして CloudSign API（POST /documents/{id}/files）へ渡す。
 *
 * 使い方:
 *   node docs/contract/build_contract.js          … サンプル（3作品・25作品）の HTML を docs/contract/ に出力
 *   node docs/contract/build_contract.js --pdf    … 同じものを PDF でも出力（Playwright が必要）
 * 依存パッケージなし（Markdown は本書で使う書式だけを読む小さな変換で処理する）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'docs', 'SPLL_利用許諾契約書_CloudSign_API対応_v4.2.md');
const OUT = __dirname;
const VERSION = 'v4.2';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m]));

/** 本文（「## 第1条」〜「以上」）を HTML にする。見出し・番号付き（2段まで）・段落・区切り線だけを扱う */
function articlesHtml(md){
  const start = md.indexOf('## 第1条');
  const end = md.indexOf('\n以上', start);
  const lines = md.slice(start, end).split('\n');
  let html = '', inArticle = false, depth = 0;
  const closeLists = to => { while(depth > to){ html += '</li></ol>'; depth--; } };
  for(const raw of lines){
    if(/^---\s*$/.test(raw) || !raw.trim()){ continue; }
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

function preamble(md){
  const m = md.match(/\n(TRPGライツ事務局が管理する[^\n]+)\n/);
  return m ? m[1] : '';
}

/** 条件スナップショットのハッシュ（本番は spll_src の termsSnapshotHash と同じ正規化に揃える） */
function termsHash(t){
  const canon = JSON.stringify([t.license_id, t.party_name, t.usage_category, t.fee_amount_or_rate,
    t.works.map(w => [w.work_id, w.work_title, w.licensor_name, w.credit_text])]);
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

function build(t){
  const md = fs.readFileSync(SRC, 'utf8');
  const hash = termsHash(t);
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const works = t.works.map((w, i) => `<tr><td class="no">${i + 1}</td><td>${esc(w.work_title)}</td><td>${esc(w.licensor_name)}</td><td>${esc(w.credit_text)}</td></tr>`).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>SPLL利用許諾契約書 ${t.license_id}</title>
<style>
@page{size:A4;margin:20mm 18mm 18mm}
*{box-sizing:border-box}
body{margin:0;color:#1a1f24;font-family:"IPAGothic","Yu Gothic","Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;font-size:9.2pt;line-height:1.65}
h1{text-align:center;font-size:17pt;letter-spacing:.18em;margin:2mm 0 6mm;font-weight:700}
.lead{margin:0 0 5mm;text-indent:1em}
h2{font-size:10.5pt;margin:6mm 0 2mm;padding-bottom:1mm;border-bottom:.4mm solid #333}
table{border-collapse:collapse;width:100%}
th,td{border:.25mm solid #8b949c;padding:1.6mm 2.4mm;vertical-align:top;text-align:left;font-weight:400}
.terms th{width:30%;background:#f1f3f4}
.note{font-size:8.4pt;color:#444;margin:2mm 0 0}
.art{break-inside:auto;margin:0 0 3.2mm}
.art h3{font-size:9.8pt;margin:0 0 1mm;break-after:avoid}
.art p{margin:0 0 1mm}
ol{margin:0;padding-left:5.5mm}
ol.sub{list-style:none;counter-reset:s;padding-left:8mm}
ol.sub>li{counter-increment:s;position:relative}
ol.sub>li::before{content:"(" counter(s) ")";position:absolute;left:-8mm;width:7mm;text-align:right}
li{margin:0 0 .6mm}
.end{text-align:right;margin:4mm 0 0}
.annex{break-before:page}
.works thead th{background:#f1f3f4;font-weight:700;white-space:nowrap}
.works thead{display:table-header-group}
.works tr{break-inside:avoid}
.works td.no{text-align:right;width:10mm;font-variant-numeric:tabular-nums}
.works td:nth-child(2){width:32%} .works td:nth-child(3){width:26%}
.sum{display:flex;justify-content:space-between;margin:0 0 2mm;font-size:8.6pt;color:#333}
.box{border:.25mm solid #8b949c;background:#f7f8f9;padding:2.5mm 3.5mm;font-size:8.4pt;margin-top:5mm}
</style></head><body>
<h1>SPLL利用許諾契約書</h1>
<p class="lead">${esc(preamble(md))}</p>
<h2>個別条件</h2>
<table class="terms">
${row('SPLL番号', esc(t.license_id))}
${row('利用者氏名', esc(t.party_name))}
${row('屋号・サークル名', esc(t.circle_name || '該当なし'))}
${row('住所', esc(t.party_address))}
${row('連絡先メールアドレス', esc(t.email))}
${row('対象作品', `別表1のとおり（全${t.works.length}作品）`)}
${row('ライセンサー', '別表1に記載の各対象作品の権利者')}
${row('利用区分', esc(t.usage_category))}
${row('許諾期間', esc(t.license_term))}
${row('利用地域', esc(t.territory))}
${row('利用許諾料', esc(t.fee_amount_or_rate))}
${row('支払時期・方法', esc(t.payment_terms))}
${row('振込先', esc(t.bank_account))}
${row('利用報告', esc(t.reporting_terms))}
${row('クレジット表示', '別表1に記載の権利表記（第6条第1項）')}
${row('特約', esc(t.special_terms || '該当なし'))}
</table>
<p class="note">個別条件に空欄又は「該当なし」と記載された項目は、当該項目について追加の条件を設定するものではありません。</p>
<h2>本文</h2>
${articlesHtml(md)}
<p class="end">以上</p>
<section class="annex">
<h2>別表1　対象作品</h2>
<div class="sum"><span>SPLL番号 ${esc(t.license_id)}</span><span>全${t.works.length}作品</span></div>
<table class="works"><thead><tr><th>No.</th><th>対象作品</th><th>権利者（ライセンサー）</th><th>権利表記</th></tr></thead><tbody>${works}</tbody></table>
<div class="box">本契約書は、利用者がクラウドサイン上で内容を確認し、所定の同意操作を完了した時点で成立します（第13条）。押印欄・署名欄はありません。<br>条件照合コード：${hash}（本契約書の個別条件及び別表1が、SPLLの台帳に記録した内容と一致することの照合に用います）</div>
</section>
</body></html>`;
}

function footer(t){
  return { header: `<div style="font-size:7pt;color:#777;width:100%;padding:0 18mm;display:flex;justify-content:space-between;font-family:IPAGothic,sans-serif"><span>SPLL-LIC-001 / ${VERSION}</span><span>SPLL利用許諾契約書</span></div>`,
    footer: `<div style="font-size:7pt;color:#777;width:100%;padding:0 18mm;display:flex;justify-content:space-between;font-family:IPAGothic,sans-serif"><span>${t.license_id}　条件照合コード ${termsHash(t)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>` };
}

/* ---- サンプル（架空の作品・権利者） ---- */
const LICENSORS = ['株式会社サンプルゲームズ','ギルドワークス合同会社','アルヴァ制作委員会','月影書房','有限会社テーブルトーク企画'];
const TITLES = ['星喰いの迷宮','黄昏ギルド戦記','深淵図書館RPG','蒸気都市アルヴァ','月影の神話TRPG','辺境開拓記','夢見る機械の国','砂海のキャラバン','七つ鐘の聖堂','霧の港町奇譚','銀翼の騎士団','百鬼夜行録','氷原の探索者','星図なき航海','虹色魔法学園','黒鉄の帝国','風読みの谷','時計塔の秘密結社','竜骨山脈紀行','灯火の巡礼者','碧の庭園RPG','双子月の王国','忘れられた神々','路地裏怪異譚','終末の図書館'];
function sample(id, n){
  return {
    license_id: id, party_name: '山田 太郎', circle_name: '星屑工房', party_address: '東京都千代田区神田小川町1-2-3 サンプルビル4階',
    email: 'creator@example.com', usage_category: '商品販売（同人誌・物販）', license_term: '契約成立日から1年間（自動更新）', territory: '日本国内',
    fee_amount_or_rate: '16,500円（税込）／契約。対象作品が複数の場合も同額', payment_terms: '契約成立後に事務局が発行する請求書の発行日から30日以内に、下記振込先へ銀行振込（振込手数料は利用者負担）',
    bank_account: '〔ひな形の固定文言〕○○銀行 ○○支店 普通預金 0000000 口座名義 ○○○○',
    reporting_terms: '定額のため利用報告は不要', special_terms: '',
    works: Array.from({ length: n }, (_, i) => {
      const lic = LICENSORS[i % LICENSORS.length];
      const title = TITLES[i % TITLES.length] + (i >= TITLES.length ? ' 第' + (Math.floor(i / TITLES.length) + 1) + '版' : '');
      return { work_id: 'W' + String(i + 1).padStart(3, '0'), work_title: title, licensor_name: lic, credit_text: '©' + lic + '／「' + title + '」' };
    })
  };
}

async function main(){
  const pdf = process.argv.includes('--pdf');
  const samples = [['3works', sample('SPLL-2026-0131', 3)], ['25works', sample('SPLL-2026-0129', 25)]];
  for(const [name, t] of samples){
    const htmlPath = path.join(OUT, `SPLL_契約書サンプル_${VERSION}_${name}.html`);
    fs.writeFileSync(htmlPath, build(t));
    console.log('html:', path.relative(ROOT, htmlPath));
    if(pdf){
      const { chromium } = require('playwright');
      const b = await chromium.launch(); const p = await b.newPage();
      await p.goto('file://' + htmlPath);
      const f = footer(t);
      const pdfPath = htmlPath.replace(/\.html$/, '.pdf');
      await p.pdf({ path: pdfPath, format: 'A4', preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: f.header, footerTemplate: f.footer });
      await b.close();
      console.log('pdf :', path.relative(ROOT, pdfPath));
    }
  }
}
if(require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { build, articlesHtml, termsHash };
