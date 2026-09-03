/**
 * SPLL クリエーター向けサイト（Cloud Run）
 *
 * 画面はコンテナから配信し、データ取得だけをGASへRPCで委譲する。
 * 業務の正本はスプレッドシートのままなので、ここにデータを持たない。
 *
 *   ブラウザ ──HTML──> Cloud Run（このプロセス）
 *           ──/api/rpc──> Cloud Run ──署名付きPOST──> GAS① / GAS②（許可リスト）
 *
 * 配信するページ（URLの形はGAS②と同じ。WORKFLOW_URL を差し替えるだけで移行できる）
 *   /                       申込窓口
 *   /?page=guide&t=…        締結後のお手続き案内
 *   /?page=upload&t=…       作品提出
 *   /?page=badge&t=…        認証バッジの取得
 *   /?page=verify&id=&c=…   ライセンス認証の確認（QRの遷移先）
 *
 * Webhook の中継（GASの302を追えない送信側のため。中身は見ずGAS②へそのまま渡す）
 *   POST /hooks/formrun     formrun（フォーム送信）
 *   POST /hooks/cloudsign   CloudSign（締結）
 *
 * 読み取り系は短時間キャッシュするため、表示のたびにスプレッドシートを読まない。
 * 依存パッケージなし（Node 22 の http と fetch のみ）。
 */

const http = require('http');
const { RPC_TARGETS, RPC_FUNCTIONS, buildPortalPage, buildTokenPage } = require('./page.js');
const { verifyPage, badgePage } = require('./verify-page.js');

const PORT = Number(process.env.PORT || 8080);
const GAS_PORTAL_URL = String(process.env.GAS_PORTAL_URL || '').trim();
const GAS_WORKFLOW_URL = String(process.env.GAS_WORKFLOW_URL || '').trim();
const RPC_KEY = String(process.env.PUBLIC_WEB_KEY || '').trim();
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 60) * 1000;
const APPLY_LIMIT = Number(process.env.APPLY_RATE_LIMIT || 5);        // 申込作成／IP／時間
/**
 * リクエスト本文の上限。
 * 作品提出（web_submitWork）は最大20MBのファイルを Base64 で載せるため、
 * 20MB × 4/3（Base64の膨張）＋ JSONの分の余裕をとる。ここを小さくすると、
 * 提出だけが「応答を解釈できませんでした」で落ちる（GASまで届かない・届いても壊れる）。
 */
const MAX_BODY_BYTES = 28 * 1024 * 1024;

/** キャッシュしてよい＝副作用のない読み取り。トークンで内容が変わるものは含めない。 */
const CACHEABLE = new Set([
  'api_listWorks', 'api_getUsageOptions', 'api_previewFeeTerms',
  'api_getLegalTexts', 'api_getLegalTextsV4', 'api_getApplyConfig'
]);
const ALLOWED = new Set(RPC_FUNCTIONS);

/**
 * GASは正常に動いていても、まれにHTTP 404を返す（302の転送先が取れないことがある）。
 * 画面はフェイルクローズなので、一度引くだけで「現在申込を受け付けられません」になってしまう。
 * ただし再試行はGAS側の再実行を意味するため、**何度実行しても結果が変わらない読み取りに限る**。
 * 除外するもの：申込・提出（作成する）、認証の照会（回数制限と照会ログを消費する）、バッジ画像（重い）。
 */
const RETRYABLE = new Set([
  'api_listWorks', 'api_getUsageOptions', 'api_previewFeeTerms',
  'api_getLegalTexts', 'api_getLegalTextsV4', 'api_getApplyConfig',
  'web_getSubmitContext', 'web_getGuideContext', 'web_getBadgeContext'
]);
const RETRY_DELAY_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cache = new Map();      // key -> { at, value }
const applyHits = new Map();  // ip  -> number[]（時刻）

function cacheGet(key){
  const hit = cache.get(key);
  if(!hit) return undefined;
  if(Date.now() - hit.at > CACHE_TTL_MS){ cache.delete(key); return undefined; }
  return hit.value;
}
function cacheSet(key, value){
  if(cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), value });
}

/** 申込作成のみ、IPごとに時間あたりの回数を制限する（GAS側にも別途上限がある） */
function allowApply(ip){
  const now = Date.now();
  const hits = (applyHits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  if(hits.length >= APPLY_LIMIT){ applyHits.set(ip, hits); return false; }
  hits.push(now);
  applyHits.set(ip, hits);
  if(applyHits.size > 5000) applyHits.clear();
  return true;
}

function clientIp(request){
  const fwd = String(request.headers['x-forwarded-for'] || '');
  return (fwd.split(',')[0] || request.socket.remoteAddress || '').trim() || 'unknown';
}

function readBody(request){
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if(size > MAX_BODY_BYTES){ reject(new Error('PAYLOAD_TOO_LARGE')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function gasUrlFor(fn){
  return RPC_TARGETS[fn] === 'workflow' ? GAS_WORKFLOW_URL : GAS_PORTAL_URL;
}

/**
 * Webhook の中継口（/hooks/formrun・/hooks/cloudsign）。
 *
 * GAS のウェブアプリは POST に対して必ず script.googleusercontent.com へ 302 を返す。
 * リダイレクトを追わない送信側（formrun のテスト送信など）は、GAS が正しく受け取っていても
 * 「送信失敗」と判定してしまう。ここが代わりにリダイレクトを追い、送信側へは素直な 200 を返す。
 *
 * 中身は見ない・書き換えない。本文はそのまま GAS② へ渡し、検証（共有秘密・改変検知・冪等）も
 * 受信記録も GAS 側の実装がそのまま行う。クエリ（?key= など）も落とさずに引き継ぐ。
 */
const HOOK_PROVIDERS = { '/hooks/formrun': 'formrun', '/hooks/cloudsign': '' };
const HOOK_PASSTHROUGH_PARAMS = ['key', 'sig', 'signature'];
/**
 * 送信側へ応答を返すまでの上限。GASの実行には数秒かかることがあり、送信側の待ち時間が短いと
 * 受信できていても「失敗」と判定される。この時間を過ぎたら 200 を返し、転送は裏で走らせる。
 * GAS は最初の POST の時点で doPost を実行する（302はその結果の受け渡しにすぎない）ので、
 * 応答を読まなくても受信・処理・Webhook_Receipts への記録は成立する。
 */
const HOOK_ACK_MS = Number(process.env.HOOK_ACK_MS || 1500);

function hookTargetUrl(provider, incomingParams){
  const base = GAS_WORKFLOW_URL;
  if(!base) throw new Error('GAS_WORKFLOW_URL が未設定です');
  const url = new URL(base);
  if(provider) url.searchParams.set('hook', provider);
  HOOK_PASSTHROUGH_PARAMS.forEach((k) => {
    const v = incomingParams && incomingParams.get(k);
    if(v) url.searchParams.set(k, v);
  });
  return url.toString();
}

/** 中継1件。GASの応答本文（'ok' / 'dup' / 'accepted-manual-review' など）をそのまま返す。 */
async function forwardHook(provider, rawBody, contentType, incomingParams, fetchImpl){
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(hookTargetUrl(provider, incomingParams), {
    method: 'POST',
    headers: { 'Content-Type': contentType || 'application/json' },
    body: rawBody === undefined || rawBody === null ? '' : String(rawBody),
    redirect: 'follow'
  });
  const text = await res.text();
  return { status: res.status, text: String(text || '') };
}

/** GASへ1往復。応答が読めた場合だけ本文を返し、通信そのものが失敗したら例外を投げる。 */
async function callGasOnce(url, fn, args, doFetch){
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: RPC_KEY, fn, args }),
    redirect: 'follow'
  });
  const text = await res.text();
  try{ return JSON.parse(text); }
  catch(e){
    // GASは実行時例外や認可待ちをHTMLのエラーページ（HTTP 200）で返す。
    // 画面へはそのまま出さず（利用者に読めない上に内部が漏れる）、原因を追えるようログへ残す。
    console.error('[rpc] ' + fn + ' がJSONでない応答を返しました（HTTP ' + res.status + '）: ' +
      String(text).replace(/\s+/g, ' ').slice(0, 400));
    throw new Error('GASの応答を解釈できませんでした（HTTP ' + res.status + '）');
  }
}

/**
 * GAS の doPost を叩く。応答は {ok, result} または {ok:false, error}。
 * 読み取りに限り、通信が失敗したときだけ一度やり直す（RETRYABLE の註を参照）。
 * {ok:false} は業務上の応答（申込の拒否理由など）なので、やり直さずそのまま返す。
 */
async function callGas(fn, args, fetchImpl){
  const base = gasUrlFor(fn);
  if(!base) throw new Error((RPC_TARGETS[fn] === 'workflow' ? 'GAS_WORKFLOW_URL' : 'GAS_PORTAL_URL') + ' が未設定です');
  // GAS②はWebhookと同じURLなので、RPCであることをクエリで明示する
  const url = RPC_TARGETS[fn] === 'workflow' ? (base + (base.indexOf('?') >= 0 ? '&' : '?') + 'rpc=1') : base;
  const doFetch = fetchImpl || fetch;
  const attempts = RETRYABLE.has(fn) ? 2 : 1;

  let body, lastError;
  for(let i = 0; i < attempts; i++){
    if(i > 0) await sleep(RETRY_DELAY_MS);
    try{ body = await callGasOnce(url, fn, args, doFetch); lastError = null; break; }
    catch(error){ lastError = error; }
  }
  if(lastError) throw lastError;
  if(!body || body.ok !== true) throw new Error((body && body.error) || 'GASでエラーが発生しました');
  return body.result;
}

/** RPC1件を処理する。テストから直接呼べるよう、fetchを差し替えられるようにしてある。 */
async function handleRpc(payload, options){
  options = options || {};
  const fn = String((payload && payload.fn) || '');
  const args = Array.isArray(payload && payload.args) ? payload.args : [];

  if(!ALLOWED.has(fn)){
    // 許可リスト外は、存在の有無を問わずすべて同じ扱いにする（内部の関数名を推測させない）
    return { status: 403, body: { ok: false, error: 'この操作は許可されていません' } };
  }
  if(fn === 'web_createApplicationV4' && !allowApply(options.ip || 'unknown')){
    return { status: 429, body: { ok: false, error: '申込の受付が集中しています。時間をおいて再度お試しください。' } };
  }

  const key = fn + ':' + JSON.stringify(args);
  if(CACHEABLE.has(fn)){
    const hit = cacheGet(key);
    if(hit !== undefined) return { status: 200, body: { ok: true, result: hit, cached: true } };
  }

  try{
    const result = await callGas(fn, args, options.fetchImpl);
    if(CACHEABLE.has(fn)) cacheSet(key, result);
    return { status: 200, body: { ok: true, result } };
  }catch(error){
    // 申込の拒否理由・トークンの期限切れなどは利用者への案内なのでそのまま返す
    return { status: 502, body: { ok: false, error: String((error && error.message) || error) } };
  }
}

function send(response, status, type, body, headers){
  response.writeHead(status, Object.assign({
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  }, headers || {}));
  response.end(body);
}

function createServer(options){
  options = options || {};
  const rpc = (fn, args) => callGas(fn, args, options.fetchImpl);
  let portal = null;
  const getPortal = () => (portal === null ? (portal = buildPortalPage()) : portal);

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;
    const q = url.searchParams;

    // 状態確認。/healthz は Google のフロントエンドに横取りされてコンテナまで届かないため、
    // 実運用では /_health を使う（両方受けるのは、手順書や既存のメモが /healthz を指しているため）。
    if(pathname === '/_health' || pathname === '/healthz'){
      const ready = Boolean(GAS_PORTAL_URL && GAS_WORKFLOW_URL && RPC_KEY);
      return send(response, ready ? 200 : 503, 'application/json; charset=utf-8',
        JSON.stringify({ ok: ready, service: 'spll-public-web',
          portal: Boolean(GAS_PORTAL_URL), workflow: Boolean(GAS_WORKFLOW_URL), key: Boolean(RPC_KEY) }));
    }

    if(pathname === '/api/rpc'){
      if(request.method !== 'POST')
        return send(response, 405, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: 'POSTのみ受け付けます' }), { Allow: 'POST' });
      let payload;
      try{ payload = JSON.parse(await readBody(request) || '{}'); }
      catch(e){
        // 大きすぎる提出は「解釈できません」ではなく、上限を超えたことが分かる文言で返す
        const tooLarge = String((e && e.message) || e) === 'PAYLOAD_TOO_LARGE';
        return send(response, tooLarge ? 413 : 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false,
          error: tooLarge ? ('ファイルが大きすぎます（' + Math.floor(MAX_BODY_BYTES / 1024 / 1024 * 3 / 4) + 'MBまで）。大容量ファイルの提出をご利用ください。')
                          : 'リクエストを解釈できませんでした' }));
      }
      const out = await handleRpc(payload, { ip: clientIp(request), fetchImpl: options.fetchImpl });
      return send(response, out.status, 'application/json; charset=utf-8', JSON.stringify(out.body), { 'Cache-Control': 'no-store' });
    }

    // Webhook の中継（formrun / CloudSign）。GAS の 302 をここで吸収し、送信側へは 200 を返す。
    if(Object.prototype.hasOwnProperty.call(HOOK_PROVIDERS, pathname)){
      const provider = HOOK_PROVIDERS[pathname];
      // 疎通確認（送信側の URL 検証・ヘルスチェック）。GAS へは出さない
      if(request.method === 'GET' || request.method === 'HEAD')
        return send(response, 200, 'text/plain; charset=utf-8', request.method === 'HEAD' ? '' : 'ok', { 'Cache-Control': 'no-store' });
      if(request.method !== 'POST')
        return send(response, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { Allow: 'GET, HEAD, POST' });

      let raw;
      try{ raw = await readBody(request); }
      catch(e){ return send(response, 413, 'text/plain; charset=utf-8', 'payload too large', { 'Cache-Control': 'no-store' }); }
      const forwarded = forwardHook(provider, raw, request.headers['content-type'], q, options.fetchImpl)
        .then((out) => ({ ok: true, out }), (error) => ({ ok: false, error }));
      const ackMs = options.hookAckMs === undefined ? HOOK_ACK_MS : options.hookAckMs;
      let timer = null;
      const deadline = new Promise((r) => { timer = setTimeout(() => r(null), ackMs); });
      const first = await Promise.race([forwarded, deadline]);
      if(timer) clearTimeout(timer);

      if(first === null){
        // GAS の応答が遅い。送信側を待たせるとタイムアウトで「失敗」と判定されるため先に 200 を返す。
        // 転送はそのまま続き、結果はログに残す（受信の成否は Webhook_Receipts で確認できる）。
        forwarded.then((r) => {
          if(!r.ok) console.error('[hook] ' + pathname + ' の中継に失敗しました（応答返却後）: ' + String((r.error && r.error.message) || r.error));
        });
        return send(response, 200, 'text/plain; charset=utf-8', 'accepted', { 'Cache-Control': 'no-store' });
      }
      if(first.ok){
        // GAS が受け取れていれば、業務上の判断（manual-review 等）に関わらず送信側へは成功を返す。
        // 再送で直る種類の失敗ではないうえ、受信自体は Webhook_Receipts に記録済みだから。
        return send(response, 200, 'text/plain; charset=utf-8', first.out.text || 'ok', { 'Cache-Control': 'no-store' });
      }
      // 転送そのものに失敗（GAS へ届いていない）。送信側の再送に任せる
      console.error('[hook] ' + pathname + ' の中継に失敗しました: ' + String((first.error && first.error.message) || first.error));
      return send(response, 502, 'text/plain; charset=utf-8', 'upstream unavailable', { 'Cache-Control': 'no-store' });
    }

    if(request.method !== 'GET' && request.method !== 'HEAD')
      return send(response, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { Allow: 'GET, HEAD, POST' });

    // バッジ画像。DriveにあるPNGをGAS②経由で取り、そのまま返す。
    if(pathname === '/badge-image'){
      try{
        const img = await rpc('web_getBadgeImage', [q.get('t') || '', q.get('size') || 'l']);
        if(!img || !img.base64) return send(response, 404, 'text/plain; charset=utf-8', 'not found');
        const headers = { 'Cache-Control': 'private, max-age=300' };
        if(q.get('download')) headers['Content-Disposition'] = 'attachment; filename="SPLL_badge.png"';
        return send(response, 200, 'image/png', Buffer.from(img.base64, 'base64'), headers);
      }catch(e){ return send(response, 502, 'text/plain; charset=utf-8', 'unavailable'); }
    }

    const page = q.get('page') || '';
    const token = q.get('t') || q.get('token') || '';
    const noStore = { 'Cache-Control': 'no-store' };   // トークン付きページはキャッシュさせない

    if(page === 'guide' || page === 'upload'){
      const file = page === 'guide' ? 'guide.html' : 'upload.html';
      return send(response, 200, 'text/html; charset=utf-8',
        request.method === 'HEAD' ? '' : buildTokenPage(file, token), noStore);
    }

    if(page === 'verify'){
      let result = { state: 'INPUT' };
      if(q.get('id')){
        try{ result = await rpc('web_verifyCertificate', [q.get('id'), q.get('c') || '']); }
        catch(e){ result = { state:'LIMITED', title:'確認できません', message:'ただいま確認できません。時間をおいて再度お試しください。' }; }
      }
      return send(response, 200, 'text/html; charset=utf-8',
        request.method === 'HEAD' ? '' : verifyPage(result), noStore);
    }

    if(page === 'badge'){
      let context = null;
      try{ context = await rpc('web_getBadgeContext', [token]); }catch(e){ context = null; }
      return send(response, context ? 200 : 404, 'text/html; charset=utf-8',
        request.method === 'HEAD' ? '' : badgePage(context, token), noStore);
    }

    // 既定は申込窓口。未知のパスもここへ返す（申込導線を袋小路にしない）
    return send(response, 200, 'text/html; charset=utf-8', request.method === 'HEAD' ? '' : getPortal(),
      { 'Cache-Control': 'public, max-age=60' });
  });
}

if(require.main === module){
  createServer().listen(PORT, () => {
    console.log('SPLL public web listening on :' + PORT);
    ['GAS_PORTAL_URL', 'GAS_WORKFLOW_URL', 'PUBLIC_WEB_KEY'].forEach((k) => {
      if(!process.env[k]) console.warn(k + ' が未設定です（/_health は 503 を返します）');
    });
  });
}

module.exports = { createServer, handleRpc, callGas, gasUrlFor, ALLOWED, CACHEABLE, RETRYABLE,
  MAX_BODY_BYTES, HOOK_PROVIDERS, HOOK_ACK_MS, hookTargetUrl, forwardHook };
