/**
 * SPLL 公開ポータル（Cloud Run）
 *
 * 画面はコンテナから配信し、データ取得だけをGAS①へRPCで委譲する。
 * 業務の正本はスプレッドシートのままなので、ここにデータを持たない。
 *
 *   ブラウザ ──HTML──> Cloud Run（このプロセス）
 *           ──/api/rpc──> Cloud Run ──署名付きPOST──> GAS① doPost（許可リスト）
 *
 * 読み取り系は短時間キャッシュするため、一覧の表示ごとにスプレッドシートを読まない。
 * 申込作成（web_createApplicationV4）はキャッシュせず、IPごとに回数を制限する。
 *
 * 依存パッケージなし（Node 22 の http と fetch のみ）。
 */

const http = require('http');
const { RPC_FUNCTIONS, buildPage } = require('./page.js');

const PORT = Number(process.env.PORT || 8080);
const GAS_PORTAL_URL = String(process.env.GAS_PORTAL_URL || '').trim();
const RPC_KEY = String(process.env.PUBLIC_WEB_KEY || '').trim();
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 60) * 1000;
const APPLY_LIMIT = Number(process.env.APPLY_RATE_LIMIT || 5);        // 申込作成／IP／時間
const MAX_BODY_BYTES = 64 * 1024;

/** キャッシュしてよい＝副作用のない読み取り関数 */
const CACHEABLE = new Set([
  'api_listWorks', 'api_getUsageOptions', 'api_previewFeeTerms',
  'api_getLegalTexts', 'api_getLegalTextsV4', 'api_getApplyConfig'
]);
const ALLOWED = new Set(RPC_FUNCTIONS);

const cache = new Map();      // key -> { at, value }
const applyHits = new Map();  // ip  -> number[]（時刻）

function cacheGet(key){
  const hit = cache.get(key);
  if(!hit) return undefined;
  if(Date.now() - hit.at > CACHE_TTL_MS){ cache.delete(key); return undefined; }
  return hit.value;
}
function cacheSet(key, value){
  // 上限を設けて、引数違いの呼び出しで無限に太らないようにする
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

/** GAS① の doPost を叩く。応答は {ok, result} または {ok:false, error}。 */
async function callGas(fn, args, fetchImpl){
  if(!GAS_PORTAL_URL) throw new Error('GAS_PORTAL_URL が未設定です');
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(GAS_PORTAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: RPC_KEY, fn, args }),
    redirect: 'follow'
  });
  const text = await res.text();
  let body;
  try{ body = JSON.parse(text); }
  catch(e){ throw new Error('GASの応答を解釈できませんでした（HTTP ' + res.status + '）'); }
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
    // 申込作成の失敗理由（法人お断り・原作の非公開など）は利用者への案内なのでそのまま返す
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
  let page = null;   // 起動時に1回組み立てて使い回す
  const getPage = () => (page === null ? (page = buildPage()) : page);

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;

    if(pathname === '/healthz'){
      const ready = Boolean(GAS_PORTAL_URL && RPC_KEY);
      return send(response, ready ? 200 : 503, 'application/json; charset=utf-8',
        JSON.stringify({ ok: ready, service: 'spll-public-web', gas: Boolean(GAS_PORTAL_URL), key: Boolean(RPC_KEY) }));
    }

    if(pathname === '/api/rpc'){
      if(request.method !== 'POST')
        return send(response, 405, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: 'POSTのみ受け付けます' }), { Allow: 'POST' });
      let payload;
      try{ payload = JSON.parse(await readBody(request) || '{}'); }
      catch(e){ return send(response, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: 'リクエストを解釈できませんでした' })); }
      const out = await handleRpc(payload, { ip: clientIp(request), fetchImpl: options.fetchImpl });
      return send(response, out.status, 'application/json; charset=utf-8', JSON.stringify(out.body), { 'Cache-Control': 'no-store' });
    }

    if(request.method !== 'GET' && request.method !== 'HEAD')
      return send(response, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { Allow: 'GET, HEAD, POST' });

    // 画面は1枚。未知のパスもポータルを返す（申込導線を袋小路にしない）
    const html = getPage();
    return send(response, 200, 'text/html; charset=utf-8', request.method === 'HEAD' ? '' : html,
      { 'Cache-Control': 'public, max-age=60' });
  });
}

if(require.main === module){
  createServer().listen(PORT, () => {
    console.log('SPLL public web listening on :' + PORT);
    if(!GAS_PORTAL_URL) console.warn('GAS_PORTAL_URL が未設定です（/healthz は 503 を返します）');
    if(!RPC_KEY) console.warn('PUBLIC_WEB_KEY が未設定です（/healthz は 503 を返します）');
  });
}

module.exports = { createServer, handleRpc, callGas, ALLOWED, CACHEABLE };
