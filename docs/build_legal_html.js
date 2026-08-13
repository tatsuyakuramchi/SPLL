/**
 * 法務3文書（個人情報取得同意・二次創作ガイドライン・利用規約）の Markdown を
 * 公開用HTMLへ変換する。正本は *.md、HTMLはここから生成する（単一ソース）。
 *
 * 出力は2種類：
 *   docs/legal/<name>.html       … 単体で開ける公開用ページ（スタイル内包・オフライン可）
 *   docs/legal/<name>.body.html  … 本文フラグメント（管理コンソール「同意文・規約」へ貼る用）
 *
 * 使い方:
 *   node docs/build_legal_html.js           … 既定の3文書をまとめて生成
 *   node docs/build_legal_html.js 入力.md   … 個別に生成
 * ※ marked が必要（devDependency）: npm i
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUTDIR = path.join(__dirname, 'legal');

const TARGETS = [
  { md: 'SPLL_個人情報取得同意_v1.0.md',   out: 'spll_privacy',   label: '個人情報の取得に関する同意事項' },
  { md: 'SPLL_二次創作ガイドライン_v4.1.md', out: 'spll_guideline', label: 'SPLL二次創作ガイドライン' },
  { md: 'SPLL_利用規約_v1.0.md',           out: 'spll_terms',     label: 'SPLL利用規約' },
];

function loadMarked(){
  const p = path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js');
  if(!fs.existsSync(p)) throw new Error('marked が見つかりません。先に `npm i` を実行してください。');
  const mod = { exports: {} };
  new Function('module', 'exports', fs.readFileSync(p, 'utf8'))(mod, mod.exports);
  return mod.exports.marked || mod.exports;
}

function esc(s){ return String(s).replace(/[&<>]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]; }); }

/** 先頭のメタ行（**文書番号:** …）を取り出し、本文と分ける */
function split(md){
  const lines = md.split(/\r?\n/);
  const meta = [];
  let i = 0;
  if(/^#\s+/.test(lines[0])) i = 1;
  for(; i < lines.length; i++){
    const l = lines[i].trim();
    if(l === '') continue;
    if(l === '---'){ i++; break; }
    const m = l.match(/^\*\*(.+?):\*\*\s*(.*)$/);
    if(m){ meta.push([m[1], m[2]]); continue; }
    break;
  }
  return { title: (md.match(/^#\s+(.+)$/m) || [])[1] || 'SPLL', meta: meta, body: lines.slice(i).join('\n') };
}

const CSS = [
  ':root{--ink:#211E2B;--line:#DAD7E2;--brand:#3D2F6B;--soft:#6A6577;--bg:#F7F6FA}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--ink);line-height:1.85;',
  '  font-family:"Yu Gothic","Hiragino Kaku Gothic ProN",system-ui,sans-serif;font-size:15px}',
  'main{max-width:820px;margin:0 auto;padding:32px 20px 80px;background:#fff;min-height:100vh;',
  '  box-shadow:0 0 24px rgba(0,0,0,.05)}',
  'h1{font-size:24px;border-bottom:2px solid var(--brand);padding-bottom:10px;margin:0 0 6px}',
  'h2{font-size:18px;margin:34px 0 10px;border-left:4px solid var(--brand);padding-left:10px}',
  'h3{font-size:15px;margin:22px 0 8px;color:var(--brand)}',
  'h4{font-size:14px;margin:18px 0 6px}',
  'ol,ul{padding-left:22px}li{margin:4px 0}',
  'table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px}',
  'th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}',
  'th{background:#F3F1F7}',
  'hr{border:0;border-top:1px solid var(--line);margin:26px 0}',
  'code{background:#F3F1F7;padding:1px 5px;border-radius:4px;font-size:13px}',
  'blockquote{border-left:3px solid var(--line);margin:12px 0;padding:2px 0 2px 14px;color:var(--soft)}',
  '.doc-meta{font-size:12px;color:var(--soft);margin:0 0 22px}',
  '.doc-meta span{margin-right:14px;white-space:nowrap}',
  '@media print{body{background:#fff}main{box-shadow:none;max-width:none}}',
].join('\n');

function build(target){
  const src = path.join(__dirname, target.md);
  if(!fs.existsSync(src)){ console.log('  skip（未作成）: ' + target.md); return null; }
  const parsed = split(fs.readFileSync(src, 'utf8'));
  const bodyHtml = String(MARKED.parse(parsed.body, { async: false }));
  const metaHtml = parsed.meta.length
    ? '<p class="doc-meta">' + parsed.meta.map(function(m){ return '<span>' + esc(m[0]) + '：' + esc(m[1]) + '</span>'; }).join('') + '</p>'
    : '';

  fs.mkdirSync(OUTDIR, { recursive: true });
  // 1) 公開用ページ（単体で開ける）
  const page = ['<!DOCTYPE html>', '<html lang="ja">', '<head>', '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>' + esc(parsed.title) + '</title>', '<style>', CSS, '</style>', '</head>', '<body>', '<main>',
    '<h1>' + esc(parsed.title) + '</h1>', metaHtml, bodyHtml, '</main>', '</body>', '</html>'].join('\n');
  fs.writeFileSync(path.join(OUTDIR, target.out + '.html'), page);
  // 2) 本文フラグメント（管理コンソールの「同意文・規約」へ貼り付ける用）
  fs.writeFileSync(path.join(OUTDIR, target.out + '.body.html'), bodyHtml.trim() + '\n');
  console.log('  ' + target.md + ' → legal/' + target.out + '.html ＋ .body.html');
  return target.out;
}

const MARKED = loadMarked();
const arg = process.argv[2];
console.log('法務文書HTMLを生成します');
if(arg){
  build({ md: path.basename(arg), out: path.basename(arg).replace(/\.md$/, ''), label: '' });
}else{
  TARGETS.forEach(build);
}
console.log('done');
