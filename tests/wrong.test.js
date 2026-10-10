/**
 * 错拼诊断测试（字母级）
 *
 * 这里钉死的是"老师照着它去讲"的那句话。判定错了不是显示错误，
 * 而是**老师照着错误的归因去讲一个不存在的问题** —— 所以每一类都要有正例与反例。
 * 特别守两条：
 *   ① 0 与 o 必须当成不同的字母（自绘键盘下极少，但粘贴/改装输入法会出现，
 *      而在小学拼写里"把 o 写成 0"恰恰是最典型的错误之一）；
 *   ② 判不准就归'其它'，绝不给一个看着聪明、实际是猜的归类。
 */

var assert = require('assert');
var wrong = require('../miniprogram/utils/wrong');

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('错拼诊断测试：');

ok('归一化：忽略大小写与空白连字符，但保留 0/o 的区别', function () {
  assert.strictEqual(wrong.normalizeTyped('Ice-Cream'), 'icecream');
  assert.strictEqual(wrong.normalizeTyped(' CAT '), 'cat');
  assert.strictEqual(wrong.normalizeTyped('b00k'), 'b00k',
    '0 不能被纠正成 o —— 否则"把 o 写成 0"这个典型错误会被判成拼对');
  assert.strictEqual(wrong.normalizeTyped(''), '');
  assert.strictEqual(wrong.normalizeTyped(null), '');
});

ok('第一个出错位置（0 起），拼对时返回 -1', function () {
  assert.strictEqual(wrong.firstDiffSpot('cat', 'cat'), -1);
  assert.strictEqual(wrong.firstDiffSpot('cat', 'kat'), 0);
  assert.strictEqual(wrong.firstDiffSpot('cat', 'cot'), 1);
  assert.strictEqual(wrong.firstDiffSpot('cat', 'ca'), 2, '少了一个尾巴 → 差异在第 2 位');
  assert.strictEqual(wrong.spotLabel('cat', 'cot'), '第2个字母');
  assert.strictEqual(wrong.spotLabel('cat', 'cat'), '');
});

ok('少字母：typed 是答案的子序列且更短', function () {
  assert.strictEqual(wrong.mistakeKind('fish', 'fsh'), '少字母');
  assert.strictEqual(wrong.mistakeKind('apple', 'aple'), '少字母');
  assert.strictEqual(wrong.mistakeKind('book', 'bok'), '少字母');
  // 反例：短但顺序不对，不能算"少字母"
  assert.notStrictEqual(wrong.mistakeKind('listen', 'tens'), '少字母');
});

ok('多字母：答案反过来是 typed 的子序列', function () {
  assert.strictEqual(wrong.mistakeKind('book', 'boook'), '多字母');
  assert.strictEqual(wrong.mistakeKind('cat', 'caat'), '多字母');
  assert.strictEqual(wrong.mistakeKind('apple', 'appple'), '多字母');
});

ok('相邻字母颠倒：cat↔cta、bird↔brid、from↔form', function () {
  assert.strictEqual(wrong.mistakeKind('cat', 'cta'), '相邻字母颠倒');
  assert.strictEqual(wrong.mistakeKind('bird', 'brid'), '相邻字母颠倒');
  assert.strictEqual(wrong.mistakeKind('from', 'form'), '相邻字母颠倒');
  // 反例：隔位互换不算相邻颠倒（cat 的前两位互换其实就是 act —— 那正是相邻）
  assert.strictEqual(wrong.mistakeKind('teacher', 'taecher'), '相邻字母颠倒',
    'teacher 的 e/a 互换应判相邻颠倒');
  assert.notStrictEqual(wrong.mistakeKind('teacher', 'aeaecht'), '相邻字母颠倒');
});

ok('单个字母写错：只有一处不同，并能给出字母替换对', function () {
  assert.strictEqual(wrong.mistakeKind('cat', 'kat'), '单个字母写错');
  assert.strictEqual(wrong.singleLetterPair('cat', 'kat'), 'c→k');
  assert.strictEqual(wrong.singleLetterPair('cat', 'cot'), 'a→o');
  // 多个字母不同时不再给替换对（宁缺毋滥）
  assert.strictEqual(wrong.singleLetterPair('cat', 'kot'), '');
  assert.strictEqual(wrong.singleLetterPair('cat', 'ct'), '', '长度不同不给替换对');
});

ok('多个字母写错 / 顺序错乱：不硬猜归类', function () {
  assert.strictEqual(wrong.mistakeKind('cat', 'kot'), '两个字母写错');
  // 长度不同且不是单纯增删（顺序被打散）→ 归'顺序错乱'，不硬往"少/多字母"上套
  assert.strictEqual(wrong.mistakeKind('listen', 'tensx'), '顺序错乱');
  assert.strictEqual(wrong.mistakeKind('teacher', 'hcaeetr'), '多个字母写错',
    '长度相同的乱序不给"顺序错乱"，只说多个字母写错');
  assert.strictEqual(wrong.mistakeKind('cat', ''), '其它');
  assert.strictEqual(wrong.mistakeKind('', 'cat'), '其它');
  assert.strictEqual(wrong.mistakeKind(null, undefined), '其它');
});

ok('countDiff / isAdjacentSwap 边界', function () {
  assert.strictEqual(wrong.countDiff('cat', 'cat'), 0);
  // 长度差 + 差异位置一起算：cat→ct 是"少一个"且那个位置还变了，记 2
  assert.strictEqual(wrong.countDiff('cat', 'ct'), 2);
  assert.strictEqual(wrong.countDiff('cat', 'cattt'), 2);
  assert.strictEqual(wrong.isAdjacentSwap('cat', 'cta'), true);
  // cat→act 就是前两位互换，确实是相邻颠倒；tac 才是首尾互换（不相邻）
  assert.strictEqual(wrong.isAdjacentSwap('cat', 'act'), true);
  assert.strictEqual(wrong.isAdjacentSwap('cat', 'tac'), false);
  assert.strictEqual(wrong.isAdjacentSwap('cat', 'ca'), false);
});

ok('聚合：按次数降序取前 N，次数相同时排序稳定（同一份数据每次口径一致）', function () {
  var top = wrong.topWords([{ word: 'a' }, { word: 'b' }, { word: 'a' }, { word: 'c' },
    { word: 'b' }, { word: 'b' }], 5);
  assert.deepStrictEqual(top, [{ word: 'b', cnt: 3 }, { word: 'a', cnt: 2 }, { word: 'c', cnt: 1 }]);
  assert.strictEqual(wrong.topWords([], 5).length, 0);
  var kinds = wrong.topBy(['少字母', '多字母', '少字母', '相邻字母颠倒', '少字母'], 3);
  assert.strictEqual(kinds[0].key, '少字母');
  assert.strictEqual(kinds[0].cnt, 3);
  // 空值不该被统计进去
  assert.deepStrictEqual(wrong.topBy(['', null, undefined], 3), []);
});

console.log('\n全部通过：' + pass + ' 项 ✓');
