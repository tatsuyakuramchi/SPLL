/**
 * clasp を npm/npx を経由せずに起動する。
 *
 * Windowsでnpmのシムが壊れている環境でも、ログインやデプロイIDの確認ができるようにする。
 *   node scripts/clasp.js login
 *   node scripts/clasp.js logout
 *   node scripts/clasp.js portal deployments     ← 第1引数がアプリ名ならそのディレクトリで実行
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const APPS = ['portal', 'workflow', 'admin'];
const local = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'clasp.cmd' : 'clasp');

if(!fs.existsSync(local)){
  console.error('clasp が node_modules にありません。先に依存関係をインストールしてください。');
  console.error('  npm install    （npmが壊れている場合は Node.js を上書きインストールして復旧）');
  process.exit(1);
}

let args = process.argv.slice(2);
let cwd = ROOT;
if(args.length && APPS.indexOf(args[0]) >= 0){
  cwd = path.join(ROOT, 'apps', args[0]);
  args = args.slice(1);
}
if(!args.length){
  console.error('使い方: node scripts/clasp.js <clasp のサブコマンド>');
  console.error('  例: node scripts/clasp.js login');
  console.error('      node scripts/clasp.js portal deployments');
  process.exit(1);
}

const cmd = JSON.stringify(local) + ' ' + args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
console.log('$ ' + cmd);
try{
  execSync(cmd, { cwd: cwd, stdio: 'inherit', shell: true });
}catch(e){
  process.exit(typeof e.status === 'number' ? e.status : 1);
}
