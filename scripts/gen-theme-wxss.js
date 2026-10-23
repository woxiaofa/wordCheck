/**
 * 由 utils/theme.js 生成 theme.wxss
 *
 * 为什么非要是生成出来的：
 *   皮肤有两份真相 —— 运行时（theme.js 给选择页、给解锁判定用）和
 *   样式层（theme.wxss 给页面用）。手抄两份，第三次加皮肤必然对不上，
 *   而且这种不一致在真机上是「某一块颜色不对」，很难查。现在 theme.js 是唯一真相。
 *
 * 用法：node scripts/gen-theme-wxss.js          写入 miniprogram/theme.wxss
 *       node scripts/gen-theme-wxss.js --check  只比对，不一致就退出码 1
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', 'miniprogram');
global.wx = { getStorageSync: function () { }, setStorageSync: function () { } };
var theme = require(path.join(ROOT, 'utils', 'theme.js'));

var ORDER = ['bg', 'bg2', 'surface', 'surface2', 'surface3', 'fill', 'fill2', 'fill3',
  'line', 'line2', 'line3', 'line4', 'line5', 'line6',
  'text', 'text2', 'text3', 'muted', 'muted2', 'muted3', 'muted4', 'muted5',
  'accent', 'active'];

function block(tokens, indent) {
  return ORDER.map(function (k) {
    return indent + '--' + k + ': ' + tokens[k] + ';';
  }).join('\n');
}

var night = theme.SKINS[0].tokens;

var out = [
  '/**',
  ' * 主题 token 表（1.2.0）',
  ' *',
  ' * 注意：本文件由 scripts/gen-theme-wxss.js 从 utils/theme.js 生成，',
  ' *       **不要手改**。要加新皮肤或调色值，改 utils/theme.js 后重新生成。',
  ' *       tests/theme.test.js 会校验两边一致（改一边不改另一边，测试会红）。',
  ' *',
  ' * token 命名规则：按「用途 + 深浅」分层，不是按色号。',
  ' *   bg       页面底色      bg2       页面底色（略微抬高的那一层）',
  ' *   surface  卡片          surface2  卡内嵌套块   surface3 键盘按键面',
  ' *   fill     输入框、行底   fill2/3   同类块的其他深浅',
  ' *   line     描边主线       line2~6   次级分割线（由深到浅）',
  ' *   text     主文字         text2/3   次级文字',
  ' *   muted    弱化文字       muted2~5  逐级减弱的说明文字',
  ' *   accent   强调色/链接    active    按下的瞬时态',
  ' *',
  ' * 功能色不在此列（对错必须有固定语义）：ok #2fd07a / bad #ff5c72 /',
  ' * warn #ffb020 / gold #ffd166 / purple #7c5cff，仍直接写在业务样式里。',
  ' */',
  '',
  '/* 默认值：任何没挂皮肤类的地方都用夜色，保证老页面不会变白 */',
  'page {',
  block(night, '  '),
  '}',
  ''
];

theme.SKINS.forEach(function (skin) {
  out.push('/* ' + skin.name + '（' + skin.id + '）' + ' · ' + skin.desc + ' */');
  out.push('.skin-' + skin.id + ' {');
  out.push(block(skin.tokens, '  '));
  out.push('}');
  out.push('');
});

var text = out.join('\n');
var target = path.join(ROOT, 'theme.wxss');

if (process.argv.indexOf('--check') >= 0) {
  var cur = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  if (cur === text) {
    console.log('theme.wxss 与 utils/theme.js 一致');
    process.exit(0);
  }
  console.error('theme.wxss 与 utils/theme.js 不一致，请跑 node scripts/gen-theme-wxss.js 重新生成');
  process.exit(1);
}

fs.writeFileSync(target, text.replace(/\n/g, '\r\n'), 'utf8');
console.log('已生成 theme.wxss：' + theme.SKINS.length + ' 套皮肤，' + ORDER.length + ' 个 token');
