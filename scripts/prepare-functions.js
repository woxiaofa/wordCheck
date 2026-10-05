/**
 * 云函数打包准备：把 shared/ 副本复制进每个用到的函数目录。
 *
 * 背景：云函数目录无法 require 目录外的代码，而 review/quiz/task/class 依赖
 *       shared/（time/srs/quiz）。DevTools 的"上传并部署"打包的是函数目录本身，
 *       所以部署前必须让 cloud/functions/<name>/shared/ 存在且为最新副本。
 *
 * 用法：
 *   node scripts/prepare-functions.js            # 复制（内容不同才写）
 *   node scripts/prepare-functions.js --check    # 只校验，不一致时非零退出
 *
 * 生成的副本已加入 .gitignore（跟 sync-shared.js 同一套"唯一真相来源"思路：
 * 副本永远由脚本生成，杜绝手改漂移）。npm run check 里的 functions:check 会兜底。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'shared');
const FUNCTIONS_DIR = path.join(ROOT, 'cloud', 'functions');

const checkOnly = process.argv.includes('--check');

function listSharedFiles() {
  return fs.readdirSync(SOURCE)
    .filter(f => f.endsWith('.js'));
}

function functionsNeedingShared() {
  // 扫描各函数 index.js 里是否 require('./shared/xxx')，自动覆盖新函数
  const out = [];
  for (const name of fs.readdirSync(FUNCTIONS_DIR)) {
    const idx = path.join(FUNCTIONS_DIR, name, 'index.js');
    if (!fs.existsSync(idx)) continue;
    const code = fs.readFileSync(idx, 'utf8');
    if (/require\(['"]\.\/shared\//.test(code)) out.push(name);
  }
  return out;
}

function sha(text) { return require('crypto').createHash('sha1').update(text).digest('hex'); }

const files = listSharedFiles();
const targets = functionsNeedingShared();
let drift = 0;

for (const fn of targets) {
  const destDir = path.join(FUNCTIONS_DIR, fn, 'shared');
  for (const f of files) {
    const src = path.join(SOURCE, f);
    const dest = path.join(destDir, f);
    const srcText = fs.readFileSync(src, 'utf8');
    if (fs.existsSync(dest) && sha(fs.readFileSync(dest, 'utf8')) === sha(srcText)) continue;
    if (checkOnly) {
      console.error('  ✗ ' + fn + '/shared/' + f + ' 缺失或过期（先跑 node scripts/prepare-functions.js）');
      drift++;
      continue;
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, srcText);
    console.log('  ✓ ' + fn + '/shared/' + f);
  }
}

if (checkOnly) {
  if (drift) {
    console.error('functions:check 失败：' + drift + ' 个副本需要更新');
    process.exit(1);
  }
  console.log('functions:check 通过：' + targets.length + ' 个函数的 shared 副本均为最新 (' + files.length + ' 文件)');
} else {
  console.log('prepare-functions 完成：' + targets.length + ' 个函数 × ' + files.length + ' 个共享文件');
}
