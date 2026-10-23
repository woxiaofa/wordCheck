/**
 * 皮肤配色可访问性校验（1.2.0）
 *
 * 为什么要有这个：
 *   浅色皮肤最容易翻车的地方不是「好不好看」，而是**看不清** ——
 *   弱化文字在浅底上过淡、强调色当链接文字时对比不足、分割细到看不见。
 *   这些在真机阳光下才会暴露，返工成本极高，所以必须上线前用脚本算过。
 *
 * 判据（WCAG 2.1）：
 *   正文/强调文字 ≥ 4.5:1     弱化说明文字 ≥ 3:1（它不承担关键信息）
 *   分割线/描边 vs 底色 ≥ 1.5:1（纯装饰性，只保证「看得见有一条线」）
 *
 *   例外：skin-night 不参与「描边」两项验收 —— 深色界面的描边本来就刻意压得很弱，
 *   改深它会破坏「变量化改造视觉零变化」这条底线。新增皮肤一律按门槛验。
 *
 * 用法：node scripts/check-contrast.js        列出每张皮肤每项的对比度与判定
 *       node scripts/check-contrast.js --json  只输出结果，给测试用
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', 'miniprogram');
global.wx = { getStorageSync: function () { }, setStorageSync: function () { } };
var theme = require(path.join(ROOT, 'utils', 'theme.js'));

function hex2rgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function lum(rgb) {
  var a = rgb.map(function (v) {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function contrast(a, b) {
  var la = lum(hex2rgb(a));
  var lb = lum(hex2rgb(b));
  var hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 每一项：名字、前景 token、背景 token、门槛 */
var RULES = [
  ['主文字 / 页面底', 'text', 'bg', 4.5],
  ['主文字 / 卡片', 'text', 'surface', 4.5],
  ['次级文字 / 卡片', 'text2', 'surface', 4.5],
  ['三级文字 / 卡片', 'text3', 'surface', 4.5],
  ['弱化文字 / 页面底', 'muted', 'bg', 3.0],
  ['弱化文字 / 卡片', 'muted', 'surface', 3.0],
  ['最弱文字 / 卡片', 'muted5', 'surface', 3.0],
  ['强调色当文字 / 页面底', 'accent', 'bg', 4.5],
  ['强调色 / 卡片', 'accent', 'surface', 4.5],
  ['主文字 / 输入框', 'text', 'fill', 4.5],
  ['主文字 / 键盘面', 'text', 'surface3', 4.5],
  ['描边主线 vs 卡片', 'line', 'surface', 1.5, 'light'],
  ['次级分割线 vs 卡片', 'line4', 'surface', 1.5, 'light']
];

var results = [];
theme.SKINS.forEach(function (skin) {
  var t = skin.tokens;
  var night = theme.SKINS[0].tokens;
  RULES.forEach(function (r) {
    var name = r[0], fg = r[1], bg = r[2], min = r[3], scope = r[4];
    if (scope === 'light' && skin.id === 'night') return;
    var a = t[fg] || night[fg];
    var b = t[bg] || night[bg];
    if (!a || !b) return;
    var c = contrast(a, b);
    results.push({
      skin: skin.id, name: name, fg: fg, bg: bg, ratio: Math.round(c * 100) / 100,
      min: min, pass: c >= min
    });
  });
});

if (process.argv.indexOf('--json') >= 0) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.every(function (r) { return r.pass; }) ? 0 : 1);
}

var byskin = {};
results.forEach(function (r) { (byskin[r.skin] = byskin[r.skin] || []).push(r); });
Object.keys(byskin).forEach(function (id) {
  var list = byskin[id];
  var bad = list.filter(function (r) { return !r.pass; });
  console.log('\n' + id + '  ' + (bad.length ? '✗ ' + bad.length + ' 项不达标' : '✓ 全部达标'));
  list.forEach(function (r) {
    console.log('  ' + (r.pass ? '✓' : '✗') + ' ' + r.name + '  ' +
      r.ratio + ':1  (需 ≥ ' + r.min + ')');
  });
});
process.exit(results.every(function (r) { return r.pass; }) ? 0 : 1);
