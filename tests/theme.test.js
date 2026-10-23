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
var cp = require('child_process');

var pass = 0;
var fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

var ROOT = path.join(__dirname, '..', 'miniprogram');

/* theme.js 提前加载：①e 判定皮肤清单时就要用 */
var theme = require(path.join(ROOT, 'utils', 'theme.js'));
var checkin = require(path.join(ROOT, 'utils', 'checkin.js'));

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

// 样式层必须与运行时完全一致：theme.wxss 由 gen-theme-wxss.js 生成，改一边不改另一边就红
try {
  cp.execFileSync('node', [path.join(__dirname, '..', 'scripts', 'gen-theme-wxss.js'), '--check'],
    { encoding: 'utf8' });
  ok('①d theme.wxss 与 utils/theme.js 两边同步（脚本生成，不许手改）', true);
} catch (e) {
  ok('①d theme.wxss 与 utils/theme.js 两边同步（脚本生成，不许手改）', false,
     '请跑 node scripts/gen-theme-wxss.js 重新生成');
}
// 每套皮肤在样式层都要有对应类
var noCls = theme.SKINS.filter(function (x) {
  return themeWxss.indexOf('.skin-' + x.id + ' {') < 0;
}).map(function (x) { return x.id; });
ok('①e 每套皮肤在 theme.wxss 里都有 skin-xxx 类', noCls.length === 0, noCls.join(', '));

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

// 皮肤类只能挂在 .page 内层节点上，page 元素本身吃不到 ——
// 所以 .page 必须自己带背景色，否则浅色皮肤下内容不满屏时会露出深色底
var appCss = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8');
ok('③d .page 自带背景色（浅色皮肤不露深色底）',
   appCss.indexOf('.page { background: var(--bg);') >= 0 &&
   appCss.indexOf('min-height: 100vh') >= 0);

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
var out = cp.execFileSync('node',
  [path.join(__dirname, '..', 'scripts', 'check-contrast.js'), '--json'],
  { encoding: 'utf8' });
var cr = JSON.parse(out);
var crBad = cr.filter(function (r) { return !r.pass; });
ok('⑤a 全部皮肤都过 WCAG 对比度门槛', crBad.length === 0,
   crBad.map(function (r) { return r.skin + ' ' + r.name + ' ' + r.ratio + '<' + r.min; }).join('; '));
ok('⑤b 皮肤清单与解锁分层与规范一致（蔷薇因与樱粉雷同已移除）',
   (function () {
     var u = {};
     theme.SKINS.forEach(function (x) { u[x.id] = x.unlock; });
     return theme.SKINS.length === 5 &&
       u.night.type === 'free' && u.sakura.type === 'free' &&
       u.honey.type === 'tasks' && u.honey.need === 5 &&
       u.mint.type === 'tasks' && u.mint.need === 7 &&
       u.sky.type === 'paid';
   })());
ok('⑤c 浅色皮肤的 id 均为合法类名字符（skin-xxx 能挂上根节点）',
   theme.SKINS.every(function (x) { return /^[a-z][a-z0-9]*$/.test(x.id); }));

/* ---------- ⑥ 设置页与底部导航 ---------- */
// 用桩跑真实的 Page 定义，验证解锁与换肤行为（而不是只看文件里有没有字）
var appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
ok('⑥a app.json 已注册设置页', appJson.pages.indexOf('pages/settings/settings') >= 0);

var navSrc = fs.readFileSync(path.join(ROOT, 'components', 'footer-nav', 'index.js'), 'utf8');
var navPaths = (navSrc.match(/path: '([^']+)'/g) || []).map(function (x) {
  return x.match(/'([^']+)'/)[1];
});
ok('⑥b 底栏缩到三个：今日 / 背词 / 设置',
   navPaths.length === 3 && navPaths.join(',') ===
   '/pages/index/index,/pkg-media/pages/drill/drill,/pages/settings/settings',
   navPaths.join(','));
var badNav = navPaths.filter(function (p2) {
  return !fs.existsSync(path.join(ROOT, p2.replace(/^\//, '') + '.js'));
});
ok('⑥c 底栏每个 tab 的路径都指向真实页面', badNav.length === 0, badNav.join(', '));

// 桩：Page / wx
var toasts = [];
var navStack = [];
global.wx.showToast = function (o) { toasts.push(o.title); };
global.wx.navigateTo = function (o) { navStack.push(o.url); };
global.wx.redirectTo = function (o) { navStack.push(o.url); };
var page = null;
global.Page = function (o) {
  page = o;
  o.data = o.data || {};
  o.setData = function (patch) {            // 极简 setData：直接合并到 data
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) o.data[k] = patch[k];
    }
  };
};

var settings = require(path.join(ROOT, 'pages', 'settings', 'settings.js'));
ok('⑥d 设置页能定义出来', !!page && typeof page.pick === 'function');

store.activity_log = {};                       // 一次任务都没完成
page.setData({ skins: [], cur: theme.skinId(), skin: theme.cls() });
page.refresh();
var list = page.data.skins;
ok('⑥e 皮肤列表把五套都列出来', list.length === theme.SKINS.length);
ok('⑥f 免费的两套开放，其余锁着',
   (function () {
     var m = {};
     list.forEach(function (x) { m[x.id] = x.open; });
     return m.night && m.sakura && !m.honey && !m.mint && !m.sky;
   })());
ok('⑥g 锁着的会算出还差几次',
   (function () {
     var h = list.filter(function (x) { return x.id === 'honey'; })[0];
     return h.left === 5;
   })());

toasts.length = 0;
page.pick({ currentTarget: { dataset: { id: 'honey' } } });
ok('⑥h 点锁着的皮肤：不换肤，告诉用户还差几次',
   store[theme.KEY] !== 'honey' && toasts.join('|').indexOf('还差 5 次') >= 0,
   toasts.join('|'));

toasts.length = 0;
page.pick({ currentTarget: { dataset: { id: 'sakura' } } });
ok('⑥i 点免费皮肤：立即换肤并给出反馈',
   store[theme.KEY] === 'sakura' && toasts.join('|').indexOf('樱粉') >= 0);

page.pick({ currentTarget: { dataset: { id: 'sky' } } });
ok('⑥j 付费皮肤：不解锁，明确提示未开放而非沉默',
   store[theme.KEY] === 'sakura' && toasts.join('|').indexOf('付费皮肤暂未开放') >= 0);

// 做完 5 次任务后，蜜橘应当开放
store.activity_log = {};
for (var i = 0; i < 5; i++) store.activity_log['2026-10-0' + (i + 1)] = checkin.need();
page.refresh();
ok('⑥k 完成 5 次任务后蜜橘开放、薄荷仍锁着',
   (function () {
     var m = {};
     page.data.skins.forEach(function (x) { m[x.id] = x.open; });
     return m.honey === true && m.mint === false;
   })());

toasts.length = 0;
page.pick({ currentTarget: { dataset: { id: 'honey' } } });
ok('⑥l 解锁后能真的换上', store[theme.KEY] === 'honey');

// 入口行跳的是真实存在的页面
var setWxml = fs.readFileSync(path.join(ROOT, 'pages', 'settings', 'settings.wxml'), 'utf8');
var jump = [];
var re = /data-path="([^"]+)"/g;
var mm;
while ((mm = re.exec(setWxml)) !== null) jump.push(mm[1]);
var badJump = jump.filter(function (p2) {
  return !fs.existsSync(path.join(ROOT, p2.replace(/^\//, '') + '.js'));
});
ok('⑥m 设置页的入口都指向真实页面', jump.length === 2 && badJump.length === 0,
   jump.join(',') + ' 坏：' + badJump.join(','));

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 项 ✓' +
  (fail ? '，' + fail + ' 项 ✗' : ''));
process.exit(fail ? 1 : 0);
