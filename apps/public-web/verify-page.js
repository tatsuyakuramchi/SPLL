/**
 * 検証ページと認証バッジ取得ページのHTML。
 *
 * この2つはGAS側でもサーバー描画（HtmlServiceで組み立て）だったため、
 * Cloud Run でも同じくサーバー側で組む。判定そのものはGAS②の
 * web_verifyCertificate / web_getBadgeContext が行い、ここは表示だけを担う。
 */

function esc(v){
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const STYLE = `
:root{
  --ink:#222;--paper:#fff;--surface2:#F7F7F7;--brand:#00AECE;--brand2:#0092AE;
  --navy:#1B3A6B;--marker:#F9B8D8;--ok:#2E9E6B;--warn:#D8324B;--line:#E3E3E3;--soft:#6E6E6E;
  --sans:"Zen Kaku Gothic New",'Hiragino Sans','Yu Gothic',system-ui,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.8}
header{background:#fff}
header::after{content:"";display:block;height:6px;background:var(--brand)}
.hwrap{max-width:760px;margin:0 auto;padding:14px 22px;display:flex;align-items:center;gap:12px}
.seal{height:40px;padding:0 12px;border-radius:4px;background:var(--navy);color:#fff;display:flex;align-items:center;
  font-weight:900;font-size:15px;font-style:italic;letter-spacing:.06em;box-shadow:0 2px 0 var(--brand)}
.t{font-weight:900;font-size:16px}
main{max-width:760px;margin:0 auto;padding:30px 22px 80px}
h1{font-weight:900;font-size:21px;margin:0 0 6px;letter-spacing:.02em}
.verdict{text-align:center;padding:34px 20px;border:1px solid var(--line);border-radius:8px}
.mark{width:66px;height:66px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;
  font-size:32px;color:#fff;margin-bottom:14px}
.mark.ok{background:var(--ok)} .mark.ng{background:var(--warn)} .mark.gray{background:#8A8A8A}
.msg{color:var(--soft);font-size:13.5px;margin:0}
dl{display:inline-block;text-align:left;border:1px solid var(--line);border-radius:8px;padding:16px 20px;margin-top:20px;background:var(--surface2)}
dt{font-size:11px;color:var(--soft);margin-top:11px;letter-spacing:.04em}
dt:first-child{margin-top:0}
dd{margin:2px 0 0;font-size:14px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.card{border:1px solid var(--line);border-radius:8px;padding:22px 24px;margin-bottom:16px}
.card h2{font-weight:900;font-size:16px;margin:0 0 14px;padding-bottom:9px;border-bottom:3px solid var(--brand)}
img.badge{max-width:100%;border:1px solid var(--line);border-radius:6px;display:block;margin:8px 0}
a.dl{display:inline-block;background:var(--brand);color:#fff;border-radius:4px;padding:10px 18px;
  font-weight:700;font-size:13px;text-decoration:none;box-shadow:0 2px 0 var(--brand2)}
form.check input{border:1px solid var(--line);border-radius:4px;padding:11px 13px;font:inherit;margin-right:8px}
form.check button{background:var(--brand);color:#fff;border:none;border-radius:4px;padding:12px 22px;font-weight:700;cursor:pointer;font-family:inherit}
.note{background:var(--surface2);border:1px solid var(--line);border-radius:6px;padding:12px 14px;font-size:12px;color:var(--soft);margin-top:16px}
`;

function layout(title, body){
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
<header><div class="hwrap"><div class="seal">SPLL</div><div class="t">${esc(title)}</div></div></header>
<main>${body}</main>
</body>
</html>`;
}

/** 照会結果の表示。無効の理由は出さない（掲載者以外に事情を推測させないため）。 */
function verifyPage(result){
  if(!result || result.state === 'INPUT'){
    return layout('SPLL ライセンス認証', `
      <h1>SPLL ライセンス認証</h1>
      <p class="msg">認証バッジのQRから開くと、正規ライセンスかどうかを確認できます。</p>
      <form class="check" method="get" style="margin-top:20px">
        <input type="hidden" name="page" value="verify">
        <input name="id" placeholder="認証ID" aria-label="認証ID">
        <input name="c" placeholder="照合コード" aria-label="照合コード">
        <button type="submit">確認する</button>
      </form>`);
  }
  const kind = result.state === 'ACTIVE' ? 'ok' : (result.state === 'INACTIVE' ? 'ng' : 'gray');
  const icon = kind === 'ok' ? '✓' : (kind === 'ng' ? '!' : '?');
  // 契約書は「甲が別途指定する権利表記」とし、実際の文言はここで示す（設定設計 §11）
  const credit = (result.credit_texts || []).join(' ／ ');
  const meta = (result.state === 'ACTIVE' || result.state === 'INACTIVE') ? `
    <dl>
      <dt>SPLL番号</dt><dd class="mono">${esc(result.license_id)}</dd>
      <dt>対象原作</dt><dd>${esc((result.work_names || []).join('、') || '—')}</dd>
      <dt>発行日</dt><dd class="mono">${esc(result.issued_at)}</dd>
      ${credit ? `<dt>指定のクレジット表記</dt><dd>${esc(credit)}</dd>` : ''}
    </dl>` : '';
  return layout('SPLL ライセンス認証', `
    <div class="verdict">
      <div class="mark ${kind}">${icon}</div>
      <h1>${esc(result.title)}</h1>
      <p class="msg">${esc(result.message)}</p>
      ${meta}
    </div>`);
}

/** バッジ取得ページ。画像は /badge-image から1枚ずつ取る（1回の応答を重くしない）。 */
function badgePage(context, token){
  if(!context){
    return layout('SPLL 認証バッジ', `
      <div class="verdict"><div class="mark gray">?</div>
        <h1>リンクが無効です</h1>
        <p class="msg">有効期限が切れているか、認証バッジがまだ発行されていません。</p></div>`);
  }
  const t = encodeURIComponent(token);
  const images = (context.sizes || []).map((s) => `
    <div style="margin:20px 0">
      <div style="font-weight:700;margin-bottom:6px">${esc(s.label)}</div>
      <img class="badge" src="/badge-image?t=${t}&size=${encodeURIComponent(s.key)}" alt="SPLL認証バッジ ${esc(s.label)}">
      <a class="dl" href="/badge-image?t=${t}&size=${encodeURIComponent(s.key)}&download=1"
         download="SPLL_badge_${esc(context.badge_id)}_${esc(s.key)}.png">PNGをダウンロード</a>
    </div>`).join('');
  return layout('SPLL 認証バッジ', `
    <h1>認証バッジ</h1>
    <p class="msg">${esc(context.work_names || '')} ／ SPLL番号 <span class="mono">${esc(context.license_id)}</span> ／ 発行日 ${esc(context.issued_at)}</p>
    <div class="card"><h2>ダウンロード</h2>${images}</div>
    <div class="note">クレジット表記としてご利用ください。表示位置・改変の可否は利用規約に従います。</div>`);
}

module.exports = { verifyPage, badgePage, layout, esc };
