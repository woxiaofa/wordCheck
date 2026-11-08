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
  'pages/index/index', 'pages/stats/stats', 'pages/settings/settings',
  'pages/class/class', 'pages/report/report',
  'pkg-media/pages/drill/drill', 'pkg-media/pages/study/study',
  'pkg-media/pages/import/import', 'pkg-media/pages/organize/organize',
  'pkg-oral/pages/oral/oral'
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

/*
 * 解析迁移脚本的两张表。
 * 踩过的坑：原来用 /\('(#[0-9a-f]{6})':\s*'([a-z0-9]+)'\) —— 值里带连字符的 token
 * （ok-bg / gold-line2 / accent-soft …）**整条被静默跳过**，于是 ①b/①c/② 实际上只
 * 验了一半映射。这里改成全局匹配 + 允许连字符，并保证 multicolumn 每行也不漏。
 */
function parseMap(name) {
  var b = scriptSrc.match(new RegExp('var ' + name + ' = \\{([\\s\\S]*?)\\n\\};'));
  if (!b) throw new Error('theme-vars.js 里找不到 ' + name);
  var re = /'(#[0-9a-fA-F]{6})':\s*'([a-zA-Z0-9-]+)'/g;
  var out = {};
  var m;
  while ((m = re.exec(b[1])) !== null) out[m[1].toLowerCase()] = m[2];
  return out;
}
var exact = parseMap('EXACT');
var near = parseMap('NEAR');
var map = {};
Object.keys(exact).forEach(function (k) { map[k] = exact[k]; });
Object.keys(near).forEach(function (k) { map[k] = near[k]; });

ok('①a 迁移脚本里解析出 token 映射',
   Object.keys(exact).length >= 20 && Object.keys(near).length >= 10,
   '精确 ' + Object.keys(exact).length + ' 条 / 近似 ' + Object.keys(near).length + ' 条');

var missing = Object.keys(exact).filter(function (hex) {
  return themeWxss.indexOf('--' + exact[hex] + ': ' + hex) < 0;
});
ok('①b theme.wxss 的默认值与脚本「精确」映射逐一对齐', missing.length === 0,
   '缺：' + missing.map(function (h) { return exact[h] + '=' + h; }).join(', '));

// utils/theme.js 里的默认皮肤也得对齐（换肤运行时用的是它）
var jsMissing = Object.keys(exact).filter(function (hex) {
  return themeJs.indexOf("'" + hex + "'") < 0;
});
ok('①c utils/theme.js 的默认皮肤覆盖全部 token', jsMissing.length === 0,
   '缺：' + jsMissing.map(function (h) { return exact[h] + '=' + h; }).join(', '));

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

// 每个在业务 wxss 里被引用的 var(--x)，token 表里都得真有 ——
// 原来出现过 var(--ok) 这种悬空引用（漂移时写了 token 表里没有的名字），
// 结果那条渐变直接失效，而且肉眼很难发现：颜色不对但不报错。
// （贴图变量例外：它们定义在生成的 theme-candy-textures.wxss 里，也算「真有」）
var texWxssPath = path.join(ROOT, 'theme-candy-textures.wxss');
var texWxss = fs.existsSync(texWxssPath) ? fs.readFileSync(texWxssPath, 'utf8') : '';
var dangling = {};
css.forEach(function (f) {
  var re = /var\(\s*--([a-z0-9-]+)/gi;
  var m;
  var src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里举例不算
  while ((m = re.exec(src)) !== null) {
    var defined = themeWxss.indexOf('--' + m[1] + ':') >= 0 ||
                  texWxss.indexOf('--' + m[1] + ':') >= 0;
    if (!defined) {
      (dangling[m[1]] = dangling[m[1]] || []).push(path.basename(f));
    }
  }
});
ok('②f 业务样式没有引用 token 表里不存在的变量', Object.keys(dangling).length === 0,
   Object.keys(dangling).map(function (k) {
     return 'var(--' + k + ') @ ' + dangling[k].join(',');
   }).join('; '));

/* ---------- ②d 不许有不透明的深色当背景 ----------
 * 这是「深色孤岛」的直接判据：底下 rgb 很暗、又几乎不透明，换到浅色皮肤上就是一块补丁。
 * 允许的是真蒙层 —— 照片说明条 rgba(15,22,32,.55) / 庆祝全屏罩 rgba(10,16,24,.45)：
 * 它们本来就该压暗底下的内容，alpha 低到能透出皮肤色。
 * 判据：不透明深色 = 亮度 ≤ 0.08 的实色，或 rgb 三通道都 ≤ 60 且 alpha ≥ 0.85。 */
function relLum(hex) {
  var h = hex.replace('#', '');
  var a = [0, 2, 4].map(function (i) {
    var v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
var solidBad = [];
css.forEach(function (f) {
  blocks(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).forEach(function (b) {
    var m = b.match(/background(?:-color)?:\s*([^;}]+)/);
    if (!m) return;
    var v = m[1];
    if (/var\(--|gradient|url\(|transparent|none|inherit/.test(v)) return;
    var dark = false;
    (v.match(/#[0-9a-fA-F]{6}\b/g) || []).forEach(function (h) {
      if (relLum(h) <= 0.08) dark = true;
    });
    var rg = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?/);
    if (rg) {
      var alpha = rg[4] === undefined ? 1 : parseFloat(rg[4]);
      if (alpha >= 0.85 && +rg[1] <= 60 && +rg[2] <= 60 && +rg[3] <= 60) dark = true;
    }
    if (dark) solidBad.push(path.basename(f) + '  ' + b.replace(/\s+/g, ' ').slice(0, 110));
  });
});
ok('②d 业务样式没有「不透明深色当背景」（浅色皮肤下的深色孤岛）',
   solidBad.length === 0, solidBad.join('\n      '));

ok('②b app.wxss 引入了 theme.wxss（且是第一行 @import）',
   /^@import "theme\.wxss";/m.test(fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')));

/* ---------- ②c 功能色不许当文字色 ----------
 * 这三个是为深色底调的亮色：压在白底上只有 1.9:1，等于看不见。
 * 当「填充」用（按钮渐变、进度条、热力图）是允许的 —— 上面压白字，跨皮肤都成立；
 * 当「文字」用必须走 ok-text / warn-text / bad-text，它们夜色取原值、浅色取加深值。 */
var FUNC_TEXT = ['#2fd07a', '#ffb020', '#ff5c72', '#c0392b', '#b37602', '#a9c8b6'];
var funcBad = [];
css.forEach(function (f) {
  fs.readFileSync(f, 'utf8').split('\n').forEach(function (line, i) {
    if (/^\s*\/\*/.test(line) || /\*\//.test(line)) return;      // 注释里提到色值不算
    FUNC_TEXT.forEach(function (hex) {
      // 命中 "color: #xxx" 但排除 background-color / border-color / border-bottom-color
      var re = new RegExp('(^|[;{\\s])color:\\s*' + hex + '\\b', 'i');
      if (re.test(line.replace(/(background-|border-bottom-|border-|caret-|text-decoration-)color:/g, '@@:'))) {
        funcBad.push(path.basename(f) + ':' + (i + 1) + ' ' + line.trim());
      }
    });
  });
});
ok('②c 功能色不许直接当文字色（要过 ok-text / warn-text / bad-text）',
   funcBad.length === 0, funcBad.join('\n      '));

/* ---------- ②e 白字只能压在深色实底或深色蒙层上 ----------
 * 实测踩过的坑：白字 + rgba(62,166,255,.16) 的淡蓝半透明底，深色下看着还行，
 * 一换浅色皮肤那 16% 的蓝几乎铺不满底色，字直接糊掉 —— 用户看到的就是「有些字颜色不对」。
 * 判据：块里有白字时，背景必须是 token、实色，或足够深的蒙层（rgb 三通道都 ≤ 80）。 */
function blocks(src) {
  return (src.match(/[^{}]+\{[^}]*\}/g) || []).map(function (b) {
    return b.slice(b.indexOf('{'));
  });
}
function isDeepBg(decl) {
  if (!decl) return false;
  if (/var\(--/.test(decl)) return true;                       // 交给 token 管，不在此判
  if (/#[0-9a-fA-F]{3,6}/.test(decl)) return true;             // 实色由 ②c/肉眼把关
  var m = decl.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return false;
  return +m[1] <= 80 && +m[2] <= 80 && +m[3] <= 80;            // 深色蒙层
}
var whiteBad = [];
css.forEach(function (f) {
  blocks(fs.readFileSync(f, 'utf8')).forEach(function (b) {
    if (!/(^|[;{\s])color:\s*(#ffffff|#fff)\b/i.test(b)) return;
    if (/(background-|border-)?color:\s*(#ffffff|#fff)/i.test(b) &&
        /background(-image)?:\s*(var\(--|linear-gradient)/i.test(b)) return;   // 渐变实底 OK
    if (isDeepBg((b.match(/background(?:-color)?:\s*[^;]+/) || [''])[0])) return;
    // 有深色文字投影 = 作者已经声明「这行白字压的是蒙层/照片」，背景由父级提供
    var sh = b.match(/text-shadow:\s*[^;]*rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (sh && +sh[1] <= 80 && +sh[2] <= 80 && +sh[3] <= 80) return;
    whiteBad.push(path.basename(f) + '  ' + b.replace(/\s+/g, ' ').slice(0, 120));
  });
});
ok('②e 白字没有叠在半透明浅底上（浅色皮肤下会糊成一团）',
   whiteBad.length === 0, whiteBad.join('\n      '));

// 皮肤类只能挂在 .page 内层节点上，page 元素本身吃不到 ——
// 所以 .page 必须自己带背景色，否则浅色皮肤下内容不满屏时会露出深色底
var appCss = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8');
// 皮肤类挂不到 page 元素上（只能挂内层 .page），所以 .page 必须自己带这三样：
// 有背景 → 浅色皮肤不露深色底；有文字色 → 浅底不会配深字；min-height → 最后一屏也铺满。
// 按块解析而不匹配整行，免得有人调了下属性的顺序就误报。
var pageRule = (appCss.match(/\.page\s*\{[^}]*\}/) || [''])[0];
ok('③d .page 自带背景色、文字色且铺满整屏',
   /background:\s*var\(--bg\)/.test(pageRule) &&
   /[^-]color:\s*var\(--text\)/.test(pageRule) &&
   /min-height:\s*100vh/.test(pageRule),
   pageRule.replace(/\s+/g, ' ').slice(0, 120));

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

/* ---------- ③e 页面 onShow 重算皮肤 + 导航栏配色 ----------
 * 两件事都得在 onShow 里做，缺一件就出 bug：
 *   ① 导航栏是系统控件，不在 DOM 里，CSS 变量到不了它 —— 只能靠 setNavigationBarColor 逐页设；
 *      漏一个页面，那页在浅色皮肤下就是「内容白了、标题栏还是黑的」（用户实锤反馈）。
 *   ② skin 写在 data 里，只在页面**创建时**算一次；换肤后返回栈里活着的旧页面，
 *      它不会重算 —— 表现是「切回默认就这样了」（2026-10-23 用户实锤）。
 * 统一走 theme.syncPage(this)，两件事一起办，避免以后有人只补一半。 */
function onShowBody(p) {
  var src = fs.readFileSync(path.join(ROOT, p + '.js'), 'utf8');
  var inShow = src.slice(src.indexOf('onShow:'));
  var end = inShow.indexOf('\n  },');
  return end < 0 ? inShow : inShow.slice(0, end + 1);
}
var badNav2 = PAGES.filter(function (p) {
  return onShowBody(p).indexOf('theme.syncPage(this)') < 0;
});
ok('③e 每个页面 onShow 里都重算了皮肤类 + 导航栏配色',
   badNav2.length === 0, badNav2.join(', '));

/* ③g syncPage 必须真的把 skin 写回 data（而不只是刷导航栏） */
var navCalls = 0;
global.wx.setNavigationBarColor = function () { navCalls++; };
global.wx.nextTick = function (fn) { fn(); };
theme.set('sakura');
var fakeVm = { data: { skin: 'skin-night' }, setData: function (o) { this.data.skin = o.skin; } };
navCalls = 0;
theme.syncPage(fakeVm);
var syncOk = fakeVm.data.skin === 'skin-sakura' && navCalls > 0;
/* 换个皮肤再来一次：证明是「每次重算」而不是只算一次 */
theme.set('night');
navCalls = 0;
theme.syncPage(fakeVm);
syncOk = syncOk && fakeVm.data.skin === 'skin-night' && navCalls > 0;
ok('③g syncPage 每次都把皮肤类重算写回 data（换肤后返回旧页面也能换过来）',
   syncOk, 'skin=' + fakeVm.data.skin + ' navCalls=' + navCalls);

theme.set('night');
var nightBar = theme.navBar();
theme.set('sakura');
var lightBar = theme.navBar();
theme.set('night');
ok('③f 深色皮肤是深底白字，浅色皮肤是浅底黑字',
   nightBar.frontColor === '#ffffff' && nightBar.backgroundColor === '#0f1620' &&
   lightBar.frontColor === '#000000' && lightBar.backgroundColor === '#fff7fa',
   JSON.stringify(nightBar) + ' ' + JSON.stringify(lightBar));

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
     return theme.SKINS.length === 6 &&
       u.night.type === 'free' && u.sakura.type === 'free' &&
       u.candy.type === 'free' &&
       u.honey.type === 'tasks' && u.honey.need === 5 &&
       u.mint.type === 'tasks' && u.mint.need === 7 &&
       u.sky.type === 'paid';
   })());
ok('⑤c 浅色皮肤的 id 均为合法类名字符（skin-xxx 能挂上根节点）',
   theme.SKINS.every(function (x) { return /^[a-z][a-z0-9]*$/.test(x.id); }));

/* ⑤d 拟物层：theme-candy.wxss 只许影响 candy 自己，且不许碰配色 */
var candyCheck = (function () {
  var f = path.join(ROOT, 'theme-candy.wxss');
  if (!fs.existsSync(f)) return { ok: false, why: 'theme-candy.wxss 不存在' };
  var src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // 每一条规则的每个选择器都必须以 .skin-candy 开头
  var badSel = src.split('}').map(function (chunk) {
    return chunk.split('{')[0].trim();
  }).filter(function (sel) { return sel && !sel.split(',').every(function (s) {
     return s.trim().indexOf('.skin-candy') === 0; }); });
  if (badSel.length) return { ok: false, why: '选择器越界：' + badSel.join(' | ') };
  // 造型层不许改配色：color / background / background-color 一律不许
  // （border-color 属于描边造型，放行；background-image 就是贴图本身，必须允许）
  var m = src.match(/(^|[^-\w])(color|background|background-color)\s*:/);
  if (m) return { ok: false, why: '造型层出现了 ' + m[2] + ': 声明 —— 配色只能走 token' };
  if (fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
      .indexOf('@import "theme-candy.wxss";') < 0) return { ok: false, why: 'app.wxss 没引入' };
  // 贴图：theme-candy.wxss 只能引用 var(--candy-*)，且每个变量必须在
  // 生成的 theme-candy-textures.wxss 里有合法的 base64 data URI 定义
  // （WXSS 的 url() 不认本地文件——控制台实锤过，所以贴图必须 base64 内嵌）
  var texFile = path.join(ROOT, 'theme-candy-textures.wxss');
  if (!fs.existsSync(texFile)) return { ok: false, why: 'theme-candy-textures.wxss 不存在（跑 scripts/gen-candy-textures.py）' };
  var texSrc = fs.readFileSync(texFile, 'utf8');
  var used = (src.match(/var\(--candy-[a-z-]+\)/g) || []).map(function (v) {
    return v.slice(6, -1);          // 去掉 var(-- 和 )，只留 candy-xxx
  });
  var missing = used.filter(function (name) {
    var re = new RegExp('--' + name + ':\\s*url\\("data:image/png;base64,[A-Za-z0-9+/=]+"\\)');
    return !re.test(texSrc);
  });
  if (!used.length) return { ok: false, why: 'theme-candy.wxss 没引用任何贴图变量' };
  if (missing.length) return { ok: false, why: '贴图变量缺定义或不是合法 data URI：' + missing.join(', ') };
  if (fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
      .indexOf('@import "theme-candy-textures.wxss";') < 0) return { ok: false, why: 'app.wxss 没引入贴图文件' };
  return { ok: true, why: '', textures: used };
})();
ok('⑤d 拟物层合规：选择器全在 .skin-candy 内、不写 color/background、app.wxss 已引入',
   candyCheck.ok === true, candyCheck.why);

/* ⑤e 导航栏换色必须带重试：系统导航栏不是 DOM，页面未 ready/转场中的那枪会被静默丢弃 */
(function () {
  var themeSrc = fs.readFileSync(path.join(ROOT, 'utils', 'theme.js'), 'utf8');
  var fn = themeSrc.slice(themeSrc.indexOf('function applyNav'));
  ok('⑤e applyNav 带失败重试（三次机会：0/80/260ms），且延到下一帧再发',
     /NAV_RETRY_MS\s*=\s*\[\s*0\s*,\s*80\s*,\s*260\s*\]/.test(themeSrc) &&
     /nextTick/.test(fn) && /setTimeout\(shoot/.test(fn),
     '缺失重试会让标题栏"有时换、有时不换"复发');
})();

/* ⑤f 拟物层的贴图必须以 base64 内嵌（WXSS 不认本地图片文件）且有定义 */
ok('⑤f 贴图以 base64 内嵌且变量齐全（WXSS 的 url() 不认本地文件）',
   candyCheck.ok === true &&
   candyCheck.textures && candyCheck.textures.length >= 3,
   candyCheck.textures ? '贴图数 ' + candyCheck.textures.length : candyCheck.why);

/* ---------- ⑥ 设置页与底部导航 ---------- */
// 用桩跑真实的 Page 定义，验证解锁与换肤行为（而不是只看文件里有没有字）
var appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
ok('⑥a app.json 已注册设置页', appJson.pages.indexOf('pages/settings/settings') >= 0);

var navSrc = fs.readFileSync(path.join(ROOT, 'components', 'footer-nav', 'index.js'), 'utf8');
// path 允许带 query（背词 tab 用 ?oral=1 开启第 0 步口语关）。
// 判断「是不是同一个页面」必须剥掉 query，否则带参路径会被误判成另一页；
// 守护本身不放宽：仍要求三个 tab、仍逐个核对 .js 真实存在。
var navPaths = (navSrc.match(/path: '([^']+)'/g) || []).map(function (x) {
  return x.match(/'([^']+)'/)[1];
});
var navBare = navPaths.map(function (p) { return p.split('?')[0]; });
ok('⑥b 底栏缩到三个：今日 / 背词 / 设置',
   navBare.length === 3 && navBare.join(',') ===
   '/pages/index/index,/pkg-media/pages/drill/drill,/pages/settings/settings',
   navBare.join(','));
var badNav = navBare.filter(function (p2) {
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

/* ⑥n 反馈入口必须是「小程序客服」：open-type="contact" 才有客服会话，
   写成普通 button 会静默失效（点了没反应，且没有任何报错） */
var settingsWxml = fs.readFileSync(
  path.join(ROOT, 'pages', 'settings', 'settings.wxml'), 'utf8');
ok('⑥n 设置页有「给开发者留言」的客服入口',
   /<button[\s\S]{0,200}open-type="contact"[\s\S]{0,200}>/.test(settingsWxml) &&
   settingsWxml.indexOf('给开发者留言') >= 0,
   '缺少 open-type="contact" 或按钮文案');

/* ⑥o 换肤后整栈重载（2026-10-23 用户拍板）
 * 为什么 syncPage 之外还要 reLaunch：syncPage 管的是「显示层的 skin 类」，
 * 但页面里还有些「创建时算一次」的运行时状态（抽查页的答案镜像、学习页的当日队列、
 * 各页算好的布局宽屏标记），换肤后它们仍是旧的。reLaunch 把整栈重建，一次清干净。
 * 换肤是低频动作，回首页这点代价换「不再出现残留」，值。 */
var launchStack = [];
var navDelays = [];
global.wx.reLaunch = function (o) { launchStack.push(o.url); };
var realSetTimeout = global.setTimeout;
global.setTimeout = function (fn, ms) { navDelays.push(ms); fn(); return 0; };  // 让延时回调同步落地
store.activity_log = {};                    // 回到「一次任务没完成」，只用必解锁的免费皮肤
page.refresh();
toasts.length = 0; launchStack.length = 0; navDelays.length = 0;
page.pick({ currentTarget: { dataset: { id: 'sakura' } } });
global.setTimeout = realSetTimeout;         // 立刻还原，别污染后续用例
ok('⑥o 换肤后整栈重载回首页（重建创建期状态，杜绝残留）',
   store[theme.KEY] === 'sakura' &&
   launchStack.join('|').indexOf('/pages/index/index') >= 0,
   'skin=' + store[theme.KEY] + ' reLaunch=' + (launchStack.join('|') || '(没跳)'));

/* ⑥p 跳转不能是 0 延迟：toast 至少 1500ms 才看得清，跳太早等于没提示 */
ok('⑥p 整栈重载延后 300ms 以上，先让「已换成…」提示落地',
   navDelays.length > 0 && navDelays[navDelays.length - 1] >= 300,
   'delays: ' + (navDelays.join(',') || '(没有延时)'));

/* ⑥q 首页底部也要有客服入口（与 ⑥n 同类）：
 * 首页是最高频的落地页，用着不顺手时得能立刻反馈，不必先想起去设置页。
 * 同样必须是 open-type="contact"，写成普通 button 会静默失效（点了没反应、不报错）。 */
var indexWxml = fs.readFileSync(path.join(ROOT, 'pages', 'index', 'index.wxml'), 'utf8');
var homeFbBtn = (indexWxml.match(/<button[^>]*home-feedback-btn[\s\S]*?>/) || [''])[0];
ok('⑥q 首页底部也有「给开发者留言」的客服入口',
   /open-type="contact"/.test(homeFbBtn) &&
   indexWxml.indexOf('给开发者留言') >= 0,
   '首页缺少 open-type="contact" 或按钮文案（找到：' +
   (homeFbBtn.replace(/\s+/g, ' ').slice(0, 60) || '没有该按钮') + '）');

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 项 ✓' +
  (fail ? '，' + fail + ' 项 ✗' : ''));
process.exit(fail ? 1 : 0);
