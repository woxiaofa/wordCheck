/**
 * 全站样式变量化迁移（1.2.0 第一步）
 *
 * 作用：把各 wxss 里分散硬编码的结构色换成 var(--token)，换肤才有可能。
 * 原则：1:1 精确映射 —— 每个颜色值只换成取值完全相等的 token，视觉零变化。
 *       没有 token 的颜色（多是一次性的语义浅色底、功能色）一律原样保留。
 *
 * 用法：node scripts/theme-vars.js         执行替换
 *       node scripts/theme-vars.js --check 只体检，不改文件（体检报告供回归用）
 *
 * 体检项：
 *   ① 每个 token 对应的原始色值，是否还有残留在业务 wxss 里
 *   ② 每个页面根目录的 js 是否已经 theme.cls()，wxml 根节点是否挂了 {{skin}}
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', 'miniprogram');

/**
 * 原色值 → token，取值**严格相等**：每个色值都必须能在夜色皮肤里找到同值的 token。
 * 这是「换肤前视觉零变化」的根据 —— 有差都得扔进 NEAR，别混在这里充数。
 */
var EXACT = {
  '#0f1620': 'bg',
  '#101a24': 'bg2',
  '#18222e': 'surface',
  '#1e2a38': 'surface2',
  '#243040': 'surface3',
  '#16202c': 'fill',
  '#16222f': 'fill2',
  '#141d28': 'fill3',
  '#2b3949': 'line',
  '#223044': 'line2',
  '#22303f': 'line3',
  '#26313f': 'line4',
  '#2c4157': 'line5',
  '#223042': 'line6',
  '#e8eef5': 'text',
  '#e8f0f8': 'text2',
  '#cfe0f0': 'text3',
  '#8fa3b7': 'muted',
  '#8b9bad': 'muted2',
  '#8fa8c0': 'muted3',
  '#7f93a8': 'muted4',
  '#6b7a8c': 'muted5',
  '#3ea6ff': 'accent',
  '#3a4a5e': 'active',
  '#131c27': 'panel',
  '#173626': 'ok-bg',
  '#7fd6a0': 'ok-soft',
  '#24563a': 'ok-line',
  '#3a1f2a': 'bad-bg',
  '#ffb0b0': 'bad-soft',
  '#ff8a9b': 'bad-soft2',
  '#3a3117': 'gold-bg',
  '#2e2416': 'gold-bg2',
  '#7a6320': 'gold-line',
  '#5a4520': 'gold-line2',
  '#ffd88a': 'gold-soft',
  '#ffd166': 'gold-text',
  '#3a2f10': 'honor-a',
  '#2a2a1c': 'honor-b',
  '#c9b98a': 'honor-soft',
  '#2b2438': 'purple-bg',
  '#cdbcff': 'purple-soft',
  '#17324a': 'accent-bg',
  '#dce8f4': 'accent-soft',
  '#24344a': 'press'
};

/**
 * 一次性近似色归族：这些是历史上各页面手写出来的「差不多一样」的色值，
 * 逐个建 token 会把 token 表撑成一堆没人记得住的近似兄弟，故就近归到最贴近的那个。
 * 与 token 原值有极小色差（肉眼难辨），属有意合并 ——
 * 所以它们**不参与** ①b/①c 的「原值 == token 值」校验，但仍然参与 ② 的残留检查。
 */
var NEAR = {
  // —— 第三轮 ——
  '#16301f': 'ok-bg', '#3a2028': 'bad-bg', '#ff8a9c': 'bad-soft2',
  '#1a2432': 'panel', '#1b2735': 'panel', '#1b2836': 'panel',
  '#1c2733': 'panel', '#1e2a37': 'panel',
  '#1f304a': 'surface2', '#24313f': 'surface2', '#24374a': 'surface2', '#2a3a52': 'line',
  '#3f4d5d': 'muted5', '#4a5a6b': 'muted5', '#4d6175': 'muted5', '#55677c': 'muted5',
  '#5b6b7d': 'muted5', '#5b7387': 'muted4', '#66788c': 'muted4', '#6b8095': 'muted4',
  '#8a97a5': 'muted3', '#c8d4e0': 'text3',
  '#ff8a8a': 'bad-soft2', '#ff9a9a': 'bad-soft2', '#ff7b7b': 'bad-soft2',
  '#ffb4bf': 'bad-soft', '#ff8a95': 'bad-soft2', '#ffb0c0': 'bad-soft',
  '#7cc4ff': 'accent-soft', '#7fc0ff': 'accent-soft', '#9fd3ff': 'accent-soft',
  '#9fc3e8': 'accent-soft', '#409eff': 'accent',
  '#b9a8ff': 'purple-soft',
  // 注意：这里不许出现 'ok' / 'bad' / 'warn' —— token 表里没这个 key，
  // 曾经误把它们写进来，结果生成了 var(--ok) 这种悬空引用（渐变直接失效）。
  '#34a86a': 'ok-soft', '#1fa860': 'ok-soft', '#4cd08a': 'ok-soft',
  '#e8a33d': 'gold-soft', '#ffc861': 'gold-soft', '#574a1e': 'gold-bg',
  '#14261c': 'ok-bg', '#16281d': 'ok-bg', '#241f14': 'gold-bg2',
  '#2b2416': 'gold-bg2', '#3a1f24': 'bad-bg'
};

/** 实际执行替换用的是两张表的并集（近似表同样要被替换掉，只是不参与「取值相等」校验） */
var MAP = {};
[EXACT, NEAR].forEach(function (t) {
  Object.keys(t).forEach(function (k) { MAP[k] = t[k]; });
});

var PAGES = [
  ['pages/index', 'pages/index/index'],
  ['pages/settings', 'pages/settings/settings'],
  ['pages/stats', 'pages/stats/stats'],
  ['pages/class', 'pages/class/class'],
  ['pages/report', 'pages/report/report'],
  ['pkg-media/pages/drill', 'pkg-media/pages/drill/drill'],
  ['pkg-media/pages/study', 'pkg-media/pages/study/study'],
  ['pkg-media/pages/quiz', 'pkg-media/pages/quiz/quiz'],
  ['pkg-media/pages/import', 'pkg-media/pages/import/import'],
  ['pkg-media/pages/organize', 'pkg-media/pages/organize/organize']
];

function walk(dir, ext, out) {
  fs.readdirSync(dir).forEach(function (name) {
    var p = path.join(dir, name);
    var st = fs.statSync(p);
    if (st.isDirectory()) walk(p, ext, out);
    else if (p.slice(-ext.length) === ext) out.push(p);
  });
  return out;
}

function replaceColors(src) {
  var hit = 0;
  var out = src.replace(/#([0-9a-fA-F]{6})\b/g, function (m, hex) {
    var key = '#' + hex.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MAP, key)) {
      hit++;
      return 'var(--' + MAP[key] + ')';
    }
    return m;
  });
  return { text: out, hit: hit };
}

/** 页面接入：js 注入 require + skin 数据，wxml 根节点挂 {{skin}} */
function inject() {
  console.log('== 注入模式 ==');
  PAGES.forEach(function (row) {
    var base = path.join(ROOT, row[1]);
    var jsP = base + '.js';
    var wxmlP = base + '.wxml';
    var depth = row[1].split('/').length - 1;          // pages/index/index → 3 段 → ../../
    var rel = new Array(depth).join('../') + '../utils/theme';
    var j = fs.readFileSync(jsP, 'utf8');
    var w = fs.readFileSync(wxmlP, 'utf8');

    if (!/utils\/theme/.test(j)) {
      // require 插到第一个非注释行之前，别插进文件头注释块里
      var lines = j.split('\n');
      var at = 0;
      while (at < lines.length) {
        var t = lines[at].trim();
        if (t === '' || t.slice(0, 2) === '/*' || t.charAt(0) === '*' ||
            t === '*/' || t.slice(0, 2) === '//') { at++; continue; }
        break;
      }
      lines.splice(at, 0, "var theme = require('" + rel + "');");
      j = lines.join('\n');
    }
    if (!/skin:\s*theme\.cls\(\)/.test(j)) {
      var m = j.match(/data:\s*\{/);
      if (!m) throw new Error('找不到 data 块：' + jsP);
      var pos = m.index + m[0].length;
      j = j.slice(0, pos) + "\n    skin: theme.cls()," + j.slice(pos);
    }
    fs.writeFileSync(jsP, j);

    if (!/\{\{skin\}\}/.test(w)) {
      // 根节点：形如 <view class="page ..."> 的第一个
      var re = /(<view\s+class="page)([^"]*)(")/;
      if (!re.test(w)) throw new Error('找不到 .page 根节点：' + wxmlP);
      w = w.replace(re, function (all, a, b, c) {
        return a + (b.indexOf('skin') >= 0 ? b : b + ' {{skin}}') + c;
      });
      fs.writeFileSync(wxmlP, w);
    }
    console.log('  已接入 ' + row[1]);
  });
}

var MODE = process.argv.indexOf('--inject') >= 0 ? 'inject'
  : (process.argv.indexOf('--check') >= 0 ? 'check' : 'run');
var check = MODE === 'check';
var cssFiles = walk(ROOT, '.wxss', []).filter(function (f) {
  return path.basename(f) !== 'theme.wxss';
});

if (MODE === 'inject') {
  inject();
} else {
  console.log(check ? '== 体检模式（不改文件）==' : '== 执行替换 ==');
var total = 0;
cssFiles.forEach(function (f) {
  var src = fs.readFileSync(f, 'utf8');
  var r = replaceColors(src);
  if (!check && r.hit) fs.writeFileSync(f, r.text);
  total += r.hit;
  if (r.hit) console.log('  ' + r.hit + ' 处  ' + path.relative(ROOT, f));
});
console.log('小计：' + total + ' 处颜色替换为 token');

// 体检 ①：token 原值是否还有残留
var leftovers = {};
cssFiles.forEach(function (f) {
  var src = fs.readFileSync(f, 'utf8');
  Object.keys(MAP).forEach(function (hex) {
    var re = new RegExp(hex, 'gi');
    var n = (src.match(re) || []).length;
    if (n) leftovers[hex] = (leftovers[hex] || 0) + n;
  });
});
console.log('\n[体检①] token 原值残留：' +
  (Object.keys(leftovers).length ? JSON.stringify(leftovers) : '无，全部变量化'));

// 体检 ②：页面是否已接入皮肤类
var bad = [];
PAGES.forEach(function (row) {
  var dir = path.join(ROOT, row[0]);
  var base = path.join(ROOT, row[1]);
  var js = base + '.js';
  var wxml = base + '.wxml';
  var j = fs.existsSync(js) ? fs.readFileSync(js, 'utf8') : '';
  var w = fs.existsSync(wxml) ? fs.readFileSync(wxml, 'utf8') : '';
  if (!/skin:\s*theme\.cls\(\)/.test(j)) bad.push('缺 skin 数据  ' + row[1] + '.js');
  if (!/\{\{skin\}\}/.test(w)) bad.push('根节点未挂 {{skin}}  ' + row[1] + '.wxml');
  void dir;
});
console.log('[体检②] 页面接入：' + (bad.length ? '\n  ' + bad.join('\n  ') : '全部已接入'));
}
