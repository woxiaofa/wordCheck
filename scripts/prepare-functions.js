/**
 * 云函数打包准备：把 shared/ 模块平铺复制进每个用到的函数目录。
 *
 * 背景：云函数目录无法 require 目录外的代码，review/quiz/task/class 依赖
 *       shared/（time/srs/quiz/state-store）。
 *
 * ⚠️ 为什么是"平铺"而不是"shared/ 子目录"（2026-10-06 实锤）：
 *   通过 CLI/工具部署后，云端运行时报 Cannot find module './shared/time'，
 *   而扁平结构的 user 函数（只有 index.js + package.json）部署即正常。
 *   把模块文件直接放进函数根目录、require('./time')，与 user 结构一致，
 *   彻底绕开子目录在打包/解包环节的坑。
 *
 * 用法：
 *   node scripts/prepare-functions.js            # 复制（内容不同才写）
 *   node scripts/prepare-functions.js --check    # 只校验，不一致时非零退出
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
  // 扫描各函数 index.js 里是否 require('./xxx')（共享模块名），自动覆盖新函数
  const names = listSharedFiles().map(f => f.replace(/\.js$/, ''));
  const out = [];
  for (const name of fs.readdirSync(FUNCTIONS_DIR)) {
    const idx = path.join(FUNCTIONS_DIR, name, 'index.js');
    if (!fs.existsSync(idx)) continue;
    const code = fs.readFileSync(idx, 'utf8');
    const needs = names.some((n) => code.indexOf("require('./" + n + "')") !== -1);
    if (needs) out.push(name);
  }
  return out;
}

function sha(text) { return require('crypto').createHash('sha1').update(text).digest('hex'); }

const files = listSharedFiles();
const targets = functionsNeedingShared();
let drift = 0;

for (const fn of targets) {
  const destDir = path.join(FUNCTIONS_DIR, fn);
  for (const f of files) {
    const src = path.join(SOURCE, f);
    const dest = path.join(destDir, f);
    const srcText = fs.readFileSync(src, 'utf8');
    if (fs.existsSync(dest) && sha(fs.readFileSync(dest, 'utf8')) === sha(srcText)) continue;
    if (checkOnly) {
      console.error('  ✗ ' + fn + '/' + f + ' 缺失或过期（先跑 node scripts/prepare-functions.js）');
      drift++;
      continue;
    }
    fs.writeFileSync(dest, srcText);
    console.log('  ✓ ' + fn + '/' + f);
  }
}

if (checkOnly) {
  if (drift) {
    console.error('functions:check 失败：' + drift + ' 个副本需要更新');
    process.exit(1);
  }
  console.log('functions:check 通过：' + targets.length + ' 个函数 × ' + files.length + ' 个共享模块（平铺）');
} else {
  console.log('prepare-functions 完成：' + targets.length + ' 个函数 × ' + files.length + ' 个共享模块（平铺到函数根目录）');
}
