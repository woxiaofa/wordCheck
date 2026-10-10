/**
 * 拼写键盘的按键规划测试（node tests/keyboard.test.js）
 *
 * 2026-10-09 用户拍板：学习 + 抽查一律**全键盘，键位与电脑 QWERTY 一致**。
 * 本文件钉死这条产品意图：
 *   1) 任何 level / word 传入都返回同一份 QWERTY 全键盘 —— 不再有"减键位"的难度档；
 *   2) 三行结构 10/9/7、26 个字母不重不漏、行内顺序与电脑键盘逐键一致；
 *   3) planRows 返回的是副本（调用方改了不会污染常量）。
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

console.log('QWERTY 全键盘布局');

/* ---------------- 三行结构与内容 ---------------- */

var rows = keysLib.planRows();
eq('三行：10 / 9 / 7 键', rows.map(function (r) { return r.length; }), [10, 9, 7]);
eq('第一行 q~p', rows[0], 'qwertyuiop'.split(''));
eq('第二行 a~l', rows[1], 'asdfghjkl'.split(''));
eq('第三行 z~m', rows[2], 'zxcvbnm'.split(''));

var flat = [].concat.apply([], rows);
eq('26 个字母不重不漏', flat.slice().sort(), 'abcdefghijklmnopqrstuvwxyz'.split(''));
ok('QWERTY_ROWS 常量与 planRows 内容一致',
  JSON.stringify(keysLib.QWERTY_ROWS) === JSON.stringify(rows));

/* ---------------- planKeys 恒全键盘（兼容老调用的行为统一） ---------------- */

eq('planKeys(hard) 返回 QWERTY 行序的 26 键', keysLib.planKeys('hard', 'letter'), flat);
eq('planKeys(easy) 也返回全键盘（难度档已下线）', keysLib.planKeys('easy', 'letter'), flat);
eq('planKeys(medium) 同样全键盘', keysLib.planKeys('medium', 'banana'), flat);
eq('planKeys(空 level) 同样全键盘', keysLib.planKeys('', 'letter'), flat);
eq('不同词返回完全相同的键（不再按词减键）',
  JSON.stringify(keysLib.planKeys('easy', 'letter')),
  JSON.stringify(keysLib.planKeys('easy', 'school')));
eq('难度文案恒为"全键盘"', keysLib.levelLabel('easy'), '全键盘');
eq('难度文案（hard 档）恒为"全键盘"', keysLib.levelLabel('hard'), '全键盘');

/* ---------------- 副本语义：调用方改行不会污染常量 ---------------- */

var mutated = keysLib.planRows();
mutated[0][0] = 'X';
ok('planRows 返回副本（改副本不污染常量）', keysLib.QWERTY_ROWS[0][0] === 'q');

/* ---------------- 第四行：连字符 + 空格（短语收录，2026-10-10） ---------------- */

var extra = keysLib.planExtraRow();
eq('第四行两键：连字符 + 空格', extra.map(function (k) { return k.id; }), ['hyphen', 'space']);
eq('id → 字符映射：hyphen=-、space=空格',
  [keysLib.charOfKey('hyphen'), keysLib.charOfKey('space')], ['-', ' ']);
eq('未知 id 返回空串（按键无效但不报错）', keysLib.charOfKey('nope'), '');
ok('空格键无字（真键盘长条的样子，孩子不用学）', extra[1].label === '');
ok('连字符键显示 -', extra[0].label === '-');
var mutatedExtra = keysLib.planExtraRow();
mutatedExtra[0].char = 'X';
ok('planExtraRow 返回副本（改副本不污染常量）', keysLib.EXTRA_ROW[0].char === '-');

/* ---------------- 自动 ⇧ 大小写（2026-10-10，"Mr 应该区分大小写"） ---------------- */

ok('isUpperChar 认大写字母', keysLib.isUpperChar('M') === true);
ok('isUpperChar 不认小写/非字母', keysLib.isUpperChar('m') === false && keysLib.isUpperChar('-') === false);
eq('shiftFor：Mr 第 0 位应大写', keysLib.shiftFor('Mr', 0), true);
eq('shiftFor：Mr 第 1 位回落小写', keysLib.shiftFor('Mr', 1), false);
eq('shiftFor：全小写词恒 false', [keysLib.shiftFor('apple', 0), keysLib.shiftFor('apple', 3)], [false, false]);
eq('shiftFor：越界/空词/负数恒 false',
  [keysLib.shiftFor('Mr', 2), keysLib.shiftFor('', 0), keysLib.shiftFor('Mr', -1), keysLib.shiftFor(null, 0)],
  [false, false, false, false]);
eq('shiftFor：非字母位（空格/连字符）false',
  [keysLib.shiftFor('ice cream', 3), keysLib.shiftFor('to-do', 2)], [false, false]);

/* ---------------- normalize / uniqueLetters 旧接口保留 ---------------- */

eq('normalize 只留 a-z 并转小写', keysLib.normalize('Ab-cd!'), 'abcd');
eq('uniqueLetters 去重保序', keysLib.uniqueLetters('banana'), ['b', 'a', 'n']);

console.log('\n' + (fail ? '有失败：' + fail + ' 项' : '全部通过：' + pass + ' 项 ✓'));
process.exit(fail ? 1 : 0);
