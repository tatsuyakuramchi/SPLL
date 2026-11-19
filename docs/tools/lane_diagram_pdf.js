// SPLL 業務レーン図の PDF 化（A3横）：node docs/tools/lane_diagram_pdf.js "$PWD/docs/SPLL_業務レーン図_v1.0.html" docs/SPLL_業務レーン図_v1.0.pdf
const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({colorScheme:'light'});
await p.goto('file://'+process.argv[2]);await p.waitForTimeout(800);
await p.addStyleTag({content:`
  .scroll{overflow:visible!important}
  .lane-svg{width:100%!important;height:auto!important}
  figure,section{break-inside:avoid}
  .wrap{max-width:none!important;padding:0!important;gap:18px!important}
  table{min-width:0!important}
  body{background:#fff!important}`});
await p.pdf({path:process.argv[3],format:'A3',landscape:true,printBackground:true,margin:{top:'12mm',bottom:'12mm',left:'12mm',right:'12mm'},
  displayHeaderFooter:true,headerTemplate:'<div></div>',
  footerTemplate:'<div style="font-size:8px;color:#888;width:100%;padding:0 12mm;display:flex;justify-content:space-between"><span>SPLL 業務レーン図 v1.0（2026-11-19）</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'});
await b.close();})();
