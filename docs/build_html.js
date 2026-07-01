/**
 * 業務フロー確認資料の Markdown を、ブラウザで開ける「完全オフライン」自己完結HTML
 * （marked と mermaid を内包＝ネット接続不要）に変換する。
 * 使い方: node docs/build_html.js [入力.md] [出力.html]
 *   引数省略時は業務フロー確認資料を生成。docs内の相対名でも絶対パスでも可。
 *   ※ 再生成には marked / mermaid が必要: 一度だけ `npm i -D marked mermaid` を実行。
 * 正本は *.md。HTMLはそこから生成（単一ソース）。
 */
const fs = require('fs');
const path = require('path');
function resolveIn(arg, def){ if(!arg) return path.join(__dirname, def); return path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg); }
const SRC = resolveIn(process.argv[2], 'SPLL_業務フロー確認資料_v0.1.md');
const OUT = process.argv[3] ? (path.isAbsolute(process.argv[3]) ? process.argv[3] : path.join(process.cwd(), process.argv[3]))
                           : SRC.replace(/_v[\d.]+\.md$/, '.html').replace(/\.md$/, '.html');
const md = fs.readFileSync(SRC, 'utf8');

// marked / mermaid の UMD ビルドを読み込んで HTML に内包（オフラインで描画可能に）
const ROOT = path.join(__dirname, '..');
function readLib(rel){
  const p = path.join(ROOT, 'node_modules', rel);
  if(!fs.existsSync(p)) throw new Error('依存が見つかりません: ' + rel + '\n  先に `npm i -D marked mermaid` を実行してください。');
  // 埋め込み時に </script> でタグが閉じないようエスケープ
  return fs.readFileSync(p, 'utf8').replace(/<\/script/gi, '<\\/script');
}
const markedLib  = readLib('marked/lib/marked.umd.js');
const mermaidLib = readLib('mermaid/dist/mermaid.min.js');

const title = (((md.match(/^#\s+(.+)$/m) || [])[1]) || 'SPLL ドキュメント')
  .replace(/[&<>]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]; });

// md は ``` を含むためテンプレートリテラルに入れず、文字列連結で <script> ブロックに埋め込む。
const head = [
'<!DOCTYPE html>',
'<html lang="ja">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
'<title>' + title + '</title>',
'<style>',
'  :root{--ink:#211E2B;--line:#DAD7E2;--brand:#3D2F6B;--soft:#6A6577;--bg:#F7F6FA;}',
'  *{box-sizing:border-box;}',
'  body{margin:0;background:#fff;color:var(--ink);font-family:"Segoe UI","Hiragino Kaku Gothic ProN","Yu Gothic UI",system-ui,sans-serif;line-height:1.7;}',
'  .wrap{max-width:980px;margin:0 auto;padding:32px 28px 80px;}',
'  h1{font-size:26px;border-bottom:3px solid var(--brand);padding-bottom:10px;}',
'  h2{font-size:20px;margin-top:34px;border-left:6px solid var(--brand);padding-left:10px;}',
'  h3{font-size:16px;margin-top:24px;color:var(--brand);}',
'  table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13px;}',
'  th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top;}',
'  th{background:var(--bg);}',
'  code{background:#F0EEF6;padding:1px 5px;border-radius:4px;font-size:90%;}',
'  pre code{display:block;padding:12px;overflow:auto;}',
'  blockquote{border-left:4px solid var(--brand);background:var(--bg);margin:14px 0;padding:10px 14px;color:#332F40;font-size:13.5px;}',
'  .mermaid{background:#FBFAFD;border:1px solid var(--line);border-radius:8px;padding:14px;margin:16px 0;text-align:center;}',
'  hr{border:none;border-top:1px solid var(--line);margin:28px 0;}',
'  a{color:var(--brand);}',
'  @media print{ .mermaid{page-break-inside:avoid;} h2{page-break-after:avoid;} table{page-break-inside:auto;} }',
'</style>',
'</head>',
'<body>',
'<div class="wrap"><article id="doc">読み込み中…（Mermaid/Markdown を描画中）</article></div>',
'<script type="text/plain" id="md">'
].join('\n');

const tail = [
'</script>',
'<script>' + markedLib + '</script>',
'<script>' + mermaidLib + '</script>',
'<script>',
'  (function(){',
'    var src = document.getElementById("md").textContent;',
'    var out = document.getElementById("doc");',
'    out.innerHTML = marked.parse(src);',
'    out.querySelectorAll("code.language-mermaid").forEach(function(c){',
'      var d = document.createElement("div"); d.className = "mermaid"; d.textContent = c.textContent;',
'      var pre = c.closest("pre"); if(pre) pre.replaceWith(d); else c.replaceWith(d);',
'    });',
'    mermaid.initialize({ startOnLoad:false, theme:"neutral", flowchart:{useMaxWidth:true}, sequence:{useMaxWidth:true} });',
'    mermaid.run();',
'  })();',
'</script>',
'</body>',
'</html>'
].join('\n');

fs.writeFileSync(OUT, head + '\n' + md + '\n' + tail, 'utf8');
const n = (md.match(/```mermaid/g) || []).length;
console.log('generated: ' + OUT);
console.log('mermaid diagrams embedded: ' + n);
