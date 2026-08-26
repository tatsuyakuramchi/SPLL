/**
 * テスト一括実行（npmを経由しない）。
 *
 * Windowsでnpmのシムが壊れている環境（Node更新後に「Could not determine Node.js
 * install directory」が出る等）でも、`node scripts/test-all.js` で全テストを流せるようにする。
 * npm test はこのファイルを呼ぶだけなので、実行内容は1か所にまとまる。
 */
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const STEPS = [
  'tests/harness.js',
  'scripts/build.js',
  'tests/sec01.js',
  'tests/form_v4.js',
  'tests/partnership_governance.js',
  'tests/public_web.js'
];

for(const step of STEPS){
  try{
    execFileSync(process.execPath, [path.join(ROOT, step)], { cwd: ROOT, stdio: 'inherit' });
  }catch(e){
    console.error('\n失敗: ' + step);
    process.exit(typeof e.status === 'number' ? e.status : 1);
  }
}
