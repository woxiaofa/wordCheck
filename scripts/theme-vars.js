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

/** 原色值 → token（取值严格相等，不允许就近合并） */
var MAP = {
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
  '#3a4a5e': 'active'
};

var PAGES = [
  ['pages/index', 'pages/index/index'],
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
