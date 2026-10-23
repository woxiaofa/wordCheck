/**
 * 皮肤系统自检（1.2.0）
 *
 * 锁三条底线：
 *   ① token 一致性：theme.wxss 里的默认值必须与迁移脚本的映射表完全对齐
 *      （不一致意味着换肤后某些块会漏掉颜色）
 *   ② 页面上没有残存硬编码：一旦有人图省事写回 #0f1620，换肤立刻失效 —— 测试要红
 *   ③ 每个页面都挂了皮肤类：漏一个页面，那一页在浅色皮肤下会是深色孤岛
 * 另外覆盖 theme.js 的解锁判定（free / tasks / paid 三层）。
 *
 * 运行：node tests/theme.test.js
 */

var fs = require('fs');
var path = require('path');

var pass = 0;
var fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

var ROOT = path.join(__dirname, '..', 'miniprogram');

/* ---- 桩：theme.js 用到 wx.getStorageSync / setStorageSync ---- */
var store = {};
global.wx = {
  getStorageSync: function (k) { return store[k]; },
  setStorageSync: function (k, v) { store[k] = v; }
};

var PAGES = [
  'pages/index/index', 'pages/stats/stats', 'pages/class/class', 'pages/report/report',
  'pkg-media/pages/drill/drill', 'pkg-media/pages/study/study', 'pkg-media/pages/quiz/quiz',
  'pkg-media/pages/import/import', 'pkg-media/pages/organize/organize'
];

function walk(dir, ext, out) {
  fs.readdirSync(dir).forEach(function (n) {
    var p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.slice(-ext.length) === ext) out.push(p);
  });
  return out;
}

console.log('\n皮肤系统自检');

/* ---------- ① token 一致性 ---------- */
var themeWxss = fs.readFileSync(path.join(ROOT, 'theme.wxss'), 'utf8');
var scriptSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'theme-vars.js'), 'utf8');
var themeJs = fs.readFileSync(path.join(ROOT, 'utils', 'theme.js'), 'utf8');

var mapBlock = scriptSrc.match(/var MAP = \{([\s\S]*?)\n\};/);
var map = {};
mapBlock[1].split('\n').forEach(function (line) {
  var m = line.match(/'(#[0-9a-f]{6})':\s*'([a-z0-9]+)'/);
  if (m) map[m[1]] = m[2];
});
ok('①a 迁移脚本里解析出 token 映射', Object.keys(map).length >= 20,
   '实际 ' + Object.keys(map).length + ' 条');

var missing = Object.keys(map).filter(function (hex) {
  return themeWxss.indexOf('--' + map[hex] + ': ' + hex) < 0;
});
ok('①b theme.wxss 的默认值与脚本映射逐一对齐', missing.length === 0,
   '缺：' + missing.map(function (h) { return map[h] + '=' + h; }).join(', '));

// utils/theme.js 里的默认皮肤也得对齐（换肤运行时用的是它）
var jsMissing = Object.keys(map).filter(function (hex) {
  return themeJs.indexOf("'" + hex + "'") < 0;
});
ok('①c utils/theme.js 的默认皮肤覆盖全部 token', jsMissing.length === 0,
   '缺：' + jsMissing.map(function (h) { return map[h] + '=' + h; }).join(', '));

/* ---------- ② 业务样式里没有残存硬编码 ---------- */
var css = walk(ROOT, '.wxss', []).filter(function (f) {
  return path.basename(f) !== 'theme.wxss';
});
var left = {};
css.forEach(function (f) {
  var src = fs.readFileSync(f, 'utf8');
  Object.keys(map).forEach(function (hex) {
    var n = (src.match(new RegExp(hex, 'gi')) || []).length;
    if (n) left[hex] = (left[hex] || 0) + n;
  });
});
ok('② 业务 wxss 里不再有 token 原色值', Object.keys(left).length === 0,
   JSON.stringify(left));

ok('②b app.wxss 引入了 theme.wxss（且是第一行 @import）',
   /^@import "theme\.wxss";/m.test(fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')));

/* ---------- ③ 每个页面都接入 ---------- */
var badJs = [], badWxml = [], badCls = [];
PAGES.forEach(function (p) {
  var j = fs.readFileSync(path.join(ROOT, p + '.js'), 'utf8');
  var w = fs.readFileSync(path.join(ROOT, p + '.wxml'), 'utf8');
  if (!/skin:\s*theme\.cls\(\)/.test(j)) badJs.push(p + '.js');
  if (!/\{\{skin\}\}/.test(w)) badWxml.push(p + '.wxml');
  // 根节点 class 里必须同时有 page 和 {{skin}}
  if (!/<view\s+class="page[^"]*\{\{skin\}\}"/.test(w)) badCls.push(p + '.wxml');
});
ok('③a 每个页面 data 里都有 skin: theme.cls()', badJs.length === 0, badJs.join(', '));
ok('③b 每个页面根节点都挂了 {{skin}}', badWxml.length === 0, badWxml.join(', '));
ok('③c 皮肤类挂在 .page 根节点上（继承才能到组件）', badCls.length === 0, badCls.join(', '));

/* ---------- ④ 解锁逻辑 ---------- */
var theme = require(path.join(ROOT, 'utils', 'theme.js'));
ok('④a 默认皮肤是夜色', theme.skinId() === 'night' && theme.cls() === 'skin-night');
ok('④b 换肤到已存在的皮肤能落盘', theme.set('night') === true && store[theme.KEY] === 'night');
ok('④c 换肤到不存在的皮肤被拒绝，且不会写脏数据',
   (function () {
     var before = store[theme.KEY];
     var r = theme.set('马卡龙不存在的皮肤');
     return r === false && store[theme.KEY] === before;
   })());
var free = theme.SKINS[0];
ok('④d free 皮肤恒解锁', theme.unlocked(free, 0) === true);
var taskSkin = { id: 'x', unlock: { type: 'tasks', need: 5 } };
ok('④e tasks 皮肤：次数不够锁着，够了开放',
   theme.unlocked(taskSkin, 4) === false && theme.unlocked(taskSkin, 5) === true);
ok('④f paid 皮肤当前一律不可用（个人主体无支付通道）',
   theme.unlocked({ id: 'y', unlock: { type: 'paid', price: 600 } }, 99) === false);

/* ---------- ⑤ 配色对比度（WCAG）与皮肤清单 ---------- */
var cp = require('child_process');
var out = cp.execFileSync('node',
  [path.join(__dirname, '..', 'scripts', 'check-contrast.js'), '--json'],
  { encoding: 'utf8' });
var cr = JSON.parse(out);
var crBad = cr.filter(function (r) { return !r.pass; });
ok('⑤a 六套皮肤全部过 WCAG 对比度门槛', crBad.length === 0,
   crBad.map(function (r) { return r.skin + ' ' + r.name + ' ' + r.ratio + '<' + r.min; }).join('; '));
ok('⑤b 皮肤清单与解锁分层与规范一致',
   (function () {
     var u = {};
     theme.SKINS.forEach(function (x) { u[x.id] = x.unlock; });
     return theme.SKINS.length === 6 &&
       u.night.type === 'free' && u.sakura.type === 'free' &&
       u.rose.type === 'tasks' && u.rose.need === 3 &&
       u.honey.type === 'tasks' && u.honey.need === 5 &&
       u.mint.type === 'tasks' && u.mint.need === 7 &&
       u.sky.type === 'paid';
   })());
ok('⑤c 浅色皮肤的 id 均为合法类名字符（skin-xxx 能挂上根节点）',
   theme.SKINS.every(function (x) { return /^[a-z][a-z0-9]*$/.test(x.id); }));

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 项 ✓' +
  (fail ? '，' + fail + ' 项 ✗' : ''));
process.exit(fail ? 1 : 0);
