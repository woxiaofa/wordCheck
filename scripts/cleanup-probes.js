/**
 * 清理排错期留下的诊断组件
 *
 *   node scripts/cleanup-probes.js
 *
 * 说明：本脚本只删"组件"，**刻意不删页面**。
 * 原因是踩过一次坑：先前版本连 pages/test-card 一起删掉了，
 * 而开发工具的编译缓存仍记着这个页面，于是编译报
 *   ENOENT ... pages/test-card/test-card.wxml
 * 编译失败会让整个小程序构建产物残缺，所有页面都渲染不出来，
 * 表现却是"页面一片空白"——查了很久才在清缓存后看到真实报错。
 *
 * 教训：删除任何被 app.json 引用的页面，务必两步都做且顺序正确：
 *   ① 先从 app.json 的 pages 里移除引用
 *   ② 再删目录，并在开发者工具里"清除全部缓存"后重新编译
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

/* 只删组件目录，不删页面 */
const DIRS = [
  'components/probe',
  'components/card-lite',
  'components/card-mid',
  'components/card-noobs',
  'components/card-nolist'
];

let removed = 0;

DIRS.forEach((rel) => {
  const p = path.join(MP, rel);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log('  ✗ 删除组件 ' + path.relative(ROOT, p));
    removed++;
  }
});

console.log('');
console.log('已删除 ' + removed + ' 个诊断组件');
console.log('');
console.log('如果还需要删页面（例如排错用的 pages/test-card），请手工按这个顺序做：');
console.log('  1. 先从 miniprogram/app.json 的 pages 数组里移除该页面');
console.log('  2. 再删目录');
console.log('  3. 开发者工具里执行"清除全部缓存"，然后重新编译');
console.log('  4. 跑 npm run check，确认没有遗留引用');
