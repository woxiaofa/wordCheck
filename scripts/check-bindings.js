/**
 * 静态检查：JS 语法 + WXML 结构
 *
 *   node scripts/check-bindings.js
 *
 * 为什么要有这个脚本：本项目开发过程中出现过两类"Console 里没有任何报错、
 * 但界面直接废掉"的问题，靠肉眼和截图都没能定位：
 *   ① 组件根节点上有两个 style 属性 —— 重复属性会让其后的子节点渲染异常，
 *      表现是"卡片在、里面全空"；
 *   ② 注释里出现 *\/ 提前闭合了块注释 —— 整个文件语法错误。
 * 这两类都能在几毫秒内被机械检查抓出来，不该再靠人。
 *
 * 不依赖任何第三方包（微信开发者工具自带的 ESLint 也不管 WXML 结构）。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const verify = require('./verify-project');

const ROOT = verify.ROOT;
const problems = [];
const notes = [];

/* ---------------- 1. JS 语法检查 ---------------- */

function collectJs(dir, out) {
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') return;
      collectJs(p, out);
    } else if (ent.name.endsWith('.js')) {
      out.push(p);
    }
  });
  return out;
}

function checkJsSyntax() {
  const files = []
    .concat(collectJs(path.join(ROOT, 'miniprogram'), []))
    .concat(collectJs(path.join(ROOT, 'cloud'), []))
    .concat(collectJs(path.join(ROOT, 'scripts'), []))
    .concat(collectJs(path.join(ROOT, 'tests'), []))
    .concat(collectJs(path.join(ROOT, 'shared'), []));

  files.forEach((f) => {
    // stdio: 'inherit' 是刻意的：受限环境下程序无法通过管道捕获子进程输出
    const r = spawnSync(process.execPath, ['--check', f], { stdio: 'inherit' });
    if (r.status !== 0) {
      problems.push('JS 语法错误：' + path.relative(ROOT, f));
    }
  });
  notes.push('检查了 ' + files.length + ' 个 js 文件的语法');
}

/* ---------------- 2. WXML 结构检查 ---------------- */

function checkWxml() {
  const MP = verify.MP;
  const files = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach((ent) => {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.wxml')) files.push(p);
    });
  })(MP);

  files.forEach((f) => {
    const wxml = fs.readFileSync(f, 'utf8');
    const label = path.relative(MP, f);
    const before = verify.problems.length;

    verify.checkTags(label, wxml);
    verify.checkDuplicateAttrs(label, wxml);

    const js = fs.existsSync(f.replace(/\.wxml$/, '.js'))
      ? fs.readFileSync(f.replace(/\.wxml$/, '.js'), 'utf8') : null;
    if (js) {
      verify.checkHandlers(label, js, wxml);
      // 第 4 个参数必须传：behavior（如 layout.behavior）注入的字段不在页面 data 里，
      // 要靠 js 文件路径去被引入的模块里取出来放行
      verify.checkData(label, js, wxml, f.replace(/\.wxml$/, '.js'));
    }

    // 把 verify 收集到的问题搬过来，保持单一实现
    while (verify.problems.length > before) {
      problems.push(verify.problems.pop());
    }
  });
  notes.push('检查了 ' + files.length + ' 个 wxml 文件的结构与绑定');
}

/* ---------------- 主流程 ---------------- */

checkJsSyntax();
checkWxml();

console.log('绑定与语法检查');
notes.forEach((n) => console.log('  · ' + n));

if (problems.length) {
  console.log('');
  problems.forEach((p) => console.log('  ✗ ' + p));
  console.log('\n共 ' + problems.length + ' 个问题');
  process.exit(1);
}
console.log('\n检查通过 ✓');
