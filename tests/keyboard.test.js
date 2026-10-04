/**
 * 拼写键盘的按键规划测试（node tests/keyboard.test.js）
 *
 * 这些断言保护的是两条产品意图：
 *   1) easy 档**只**给正确字母、且一个不多 —— 否则就不是"降难度"，而是换了个难法；
 *   2) 键位对同一个词是稳定的 —— 若每次重排，学生刚记住 m 在哪，下一秒键位就变了。
 */

var keysLib = require('../miniprogram/components/letter-keyboard/keys');

var pass = 0;
var fail = 0;

function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

function eq(name, a, b) {
  ok(name + '（实际 ' + JSON.stringify(a) + '）', JSON.stringify(a) === JSON.stringify(b));
}

console.log('拼写键盘难度');

/* ---------------- easy：只给这个词用到的字母 ---------------- */

var easy = keysLib.planKeys('easy', 'letter');
eq('easy 只给出该词的去重字母', easy.slice().sort(), ['e', 'l', 'r', 't']);
ok('easy 不包含词外的字母', easy.indexOf('z') < 0 && easy.indexOf('q') < 0);
eq('easy 的键数等于去重字母数', easy.length, 4);

var easyRepeat = keysLib.planKeys('easy', 'banana');
eq('重复字母只给一个键（键可重复点击）', easyRepeat.slice().sort(), ['a', 'b', 'n']);

/* ---------------- medium：正确字母 + 易混字母 ---------------- */

var medium = keysLib.planKeys('medium', 'letter');
ok('medium 包含全部正确字母', ['e', 'l', 'r', 't'].every(function (c) { return medium.indexOf(c) >= 0; }));
ok('medium 额外加入了易混字母', medium.length > easy.length);
ok('medium 的干扰项来自易混表', medium.every(function (c) {
  return keysLib.CONFUSABLES.indexOf(c) >= 0 || 'elrt'.indexOf(c) >= 0;
}));
ok('medium 至少含 3 个形近易混字母（b/d、a/e/o、i/l/r/u/v 之类）',
  medium.filter(function (c) { return 'bdaeoilruv'.indexOf(c) >= 0 && 'elrt'.indexOf(c) < 0; }).length >= 3);

/* ---------------- hard：全键盘 ---------------- */

var hard = keysLib.planKeys('hard', 'letter');
eq('hard 给全 26 键', hard.length, 26);
ok('hard 包含 a-z 全部字母', 'abcdefghijklmnopqrstuvwxyz'.split('').every(function (c) {
  return hard.indexOf(c) >= 0;
}));

/* ---------------- 稳定性与兜底 ---------------- */

eq('同一个词两次规划结果完全一致（键位不乱跳）',
  keysLib.planKeys('medium', 'letter'), keysLib.planKeys('medium', 'letter'));
ok('不同词的键位顺序可以不同',
  JSON.stringify(keysLib.planKeys('easy', 'letter')) !== JSON.stringify(keysLib.planKeys('easy', 'school')));
eq('拿不到单词时退回全键盘（云端未下发的兜底）', keysLib.planKeys('easy', '').length, 26);
eq('未知难度按全键盘处理', keysLib.planKeys('', 'letter').length, 26);
eq('大写与非法字符被忽略', keysLib.planKeys('easy', 'Ab-cd!'), keysLib.planKeys('easy', 'abcd'));

/* ---------------- 文案 ---------------- */

eq('难度文案：easy', keysLib.levelLabel('easy'), '仅正确字母');
eq('难度文案：medium', keysLib.levelLabel('medium'), '含易混字母');
eq('难度文案：hard', keysLib.levelLabel('hard'), '全键盘');

console.log('\n' + (fail ? '有失败：' + fail + ' 项' : '全部通过：' + pass + ' 项 ✓'));
process.exit(fail ? 1 : 0);
