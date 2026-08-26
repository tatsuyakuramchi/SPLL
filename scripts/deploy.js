/**
 * SPLL clasp デプロイスクリプト：push → 既存ウェブアプリデプロイを新バージョンへ更新。
 * GASエディタで「デプロイ→編集→新バージョン」を手動操作しなくても公開URLへ反映される。
 *
 * 使い方:
 *   node scripts/deploy.js <app> [説明]     app = portal | workflow | admin | accounting
 *   （通常は npm run deploy:portal / deploy:all を使う。build は npm スクリプト側で実行済み）
 *
 * 前提（アプリごとに初回1回だけ）:
 *   1. apps/<app>/.clasp.json にスクリプトIDを設定済み（push できる状態）
 *   2. GASで一度だけ手動で「ウェブアプリ」としてデプロイし、そのデプロイIDを
 *      apps/<app>/.deploy.json に保存する:
 *        { "deploymentId": "AKfycb..." }
 *      デプロイIDの確認: apps/<app> で `npx clasp deployments` を実行（@HEAD ではない方）。
 *      どちらのファイルも Git にはコミットしない（.gitignore 済み）。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const APPS = ['portal', 'workflow', 'admin', 'accounting'];
const app = process.argv[2];
if(!APPS.includes(app)){
  console.error('使い方: node scripts/deploy.js <' + APPS.join('|') + '> [説明]');
  process.exit(1);
}
const ROOT = path.join(__dirname, '..');
const appDir = path.join(ROOT, 'apps', app);

function run(cmd){
  console.log('[' + app + '] $ ' + cmd);
  execSync(cmd, { cwd: appDir, stdio: 'inherit', shell: true });
}

/**
 * clasp の起動コマンド。
 * node_modules に入っていればそれを直接使い、無いときだけ npx へ落とす。
 * npx は npm のシムを経由するため、npm 側が壊れている環境（Node更新後など）では
 * 使えなくなることがある。デプロイがそれに巻き込まれないようにする。
 */
function claspCmd(){
  const local = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'clasp.cmd' : 'clasp');
  return fs.existsSync(local) ? JSON.stringify(local) : 'npx clasp';
}

// 前提チェック
if(!fs.existsSync(path.join(appDir, '.clasp.json'))){
  console.error('[' + app + '] apps/' + app + '/.clasp.json がありません。');
  console.error('  .clasp.json.example をコピーしてスクリプトIDを記入してください。');
  process.exit(1);
}
const deployFile = path.join(appDir, '.deploy.json');
if(!fs.existsSync(deployFile)){
  console.error('[' + app + '] apps/' + app + '/.deploy.json がありません（初回のみ作成が必要）。');
  console.error('  1. GASで一度「ウェブアプリ」としてデプロイ（公開範囲は手順書どおり）');
  console.error('  2. 下のコマンドでデプロイID（AKfycb...で始まる・@HEADでない行）を確認:');
  console.error('       cd apps\\' + app + ' && npx clasp deployments');
  console.error('  3. apps/' + app + '/.deploy.json を作成:');
  console.error('       { "deploymentId": "AKfycb..." }');
  try{
    console.error('\n  現在のデプロイ一覧:');
    execSync(claspCmd() + ' deployments', { cwd: appDir, stdio: 'inherit', shell: true });
  }catch(e){ /* clasp未ログイン等はメッセージのみ */ }
  process.exit(1);
}
let deploymentId = '';
try{ deploymentId = JSON.parse(fs.readFileSync(deployFile, 'utf8')).deploymentId || ''; }
catch(e){ console.error('[' + app + '] .deploy.json を読めません: ' + e.message); process.exit(1); }
if(!/^AKfycb/.test(deploymentId)){
  console.error('[' + app + '] deploymentId が不正です（AKfycb... で始まるIDを指定）: ' + deploymentId);
  process.exit(1);
}

// 説明（バージョンメモ）: 引数 > 日時+gitハッシュ
let desc = process.argv[3];
if(!desc){
  let hash = '';
  try{ hash = execSync('git rev-parse --short HEAD', { cwd: ROOT, shell: true }).toString().trim(); }catch(e){}
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  desc = d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + (hash ? ' ' + hash : '');
}

// push → 既存デプロイを新バージョンへ更新（URLは変わらない）
run(claspCmd() + ' push -f');
run(claspCmd() + ' deploy -i ' + deploymentId + ' -d "' + desc.replace(/"/g, '') + '"');
console.log('[' + app + '] デプロイ更新完了（URLは既存のまま・新バージョン反映済み）');
