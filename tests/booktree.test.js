/**
 * 教材三级结构测试（版本 → 册 → 单元）
 *
 * 为什么单独一个测试：这套结构是"老师布置 Unit 3"的唯一入口，错一处就有两种后果——
 *   ① 词数对不上：老师说"布置了 Unit 3 共 20 词"，孩子拿到 18 个，第一句话就崩了；
 *   ② 词序乱了：unit_order 一旦错位，孩子练的顺序跟课本不一样，
 *      家长看一眼就知道"这软件没按课本来"，而这种错位在本地验收时最容易漏，
 *      因为它不影响任何"能不能跑"，只影响"对不对"。
 * 所以这里钉死三件事：目录树与词条一致、单元内序号连续、取出来的顺序等于课本顺序。
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var storage = {};
global.wx = {
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; }
};

var books = require('../miniprogram/utils/books');
var WORDS = require('../miniprogram/data/words');
var TREE = require('../miniprogram/data/booktree');
var SOURCE = require('../scripts/data/waiyan4a.js');

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

var VOLUME = 'wy4a';

console.log('教材三级结构测试：');

ok('目录树是三级：books → volumes → units', function () {
  assert.ok(Array.isArray(TREE.books) && TREE.books.length, '应有至少一个版本');
  var b = TREE.books[0];
  assert.ok(b.key && b.name, '版本要有 key/name');
  assert.ok(Array.isArray(b.volumes) && b.volumes.length, '版本下要有册');
  var v = b.volumes[0];
  assert.ok(v.key && v.name && v.tag, '册要有 key/name/tag');
  assert.ok(Array.isArray(v.units) && v.units.length, '册下要有单元');
  v.units.forEach(function (u) {
    assert.ok(u.no > 0, '单元号必须为正');
    assert.ok(u.name, 'Unit ' + u.no + ' 缺单元名');
  });
});

ok('目录树里的单元数 == 源词表的 Module 数', function () {
  var nos = {};
  SOURCE.forEach(function (s) { nos[s.m] = (nos[s.m] || 0) + 1; });
  var units = TREE.books[0].volumes[0].units;
  assert.strictEqual(units.length, Object.keys(nos).length,
    '目录树 Unit 数 ' + units.length + ' vs 源表 Module 数 ' + Object.keys(nos).length);
  units.forEach(function (u) {
    assert.strictEqual(u.count, nos[u.no], 'Unit ' + u.no + ' 词数应等于源表 ' + nos[u.no]);
  });
});

ok('目录树各单元词数之和 == 词库里该册的词数', function () {
  var units = TREE.books[0].volumes[0].units;
  var sum = units.reduce(function (s, u) { return s + u.count; }, 0);
  var actual = WORDS.filter(function (w) { return w.volume === VOLUME; }).length;
  assert.strictEqual(sum, actual, '目录树合计 ' + sum + ' vs 词库实际 ' + actual);
});

ok('取单元词：数量与 unit 归属都对', function () {
  unitsOfAll().forEach(function (u) {
    var list = books.getWordsByUnit(VOLUME, u.no);
    assert.strictEqual(list.length, u.count, 'Unit ' + u.no + ' 应取到 ' + u.count + ' 词');
    list.forEach(function (w) {
      assert.strictEqual(Number(w.unit), u.no, w.word + ' 不属于 Unit ' + u.no);
    });
  });
});

ok('★ 取单元词按课本顺序（unit_order 连续且与源表同序）', function () {
  unitsOfAll().forEach(function (u) {
    var list = books.getWordsByUnit(VOLUME, u.no);
    var srcOrder = SOURCE.filter(function (s) { return Number(s.m) === u.no; })
      .map(function (s) { return s.word; });
    var got = list.map(function (w) { return w.word; });
    assert.strictEqual(got.join(','), srcOrder.join(','),
      'Unit ' + u.no + ' 词序与课本不一致：\n      取的: ' + got.join(',') +
      '\n      课本: ' + srcOrder.join(','));
  });
});

ok('★ unit_order 在单元内是 1..n 的连续序号（错位检测）', function () {
  unitsOfAll().forEach(function (u) {
    var orders = books.getWordsByUnit(VOLUME, u.no)
      .map(function (w) { return Number(w.unit_order) || 0; });
    orders.forEach(function (o, i) {
      assert.strictEqual(o, i + 1, 'Unit ' + u.no + ' 第 ' + (i + 1) + ' 个词的 unit_order 是 ' + o);
    });
  });
});

ok('整册取词（unit=0）也按 unit → unit_order 排', function () {
  var all = books.getWordsByUnit(VOLUME, 0);
  assert.strictEqual(all.length, WORDS.filter(function (w) { return w.volume === VOLUME; }).length);
  for (var i = 1; i < all.length; i++) {
    var a = all[i - 1], b = all[i];
    var ua = Number(a.unit), ub = Number(b.unit);
    assert.ok(ua < ub || (ua === ub && (a.unit_order < b.unit_order)),
      '整册顺序错乱：' + a.word + '(U' + ua + ') 排在 ' + b.word + '(U' + ub + ') 之后');
  }
});

ok('异常输入不炸：不存在的册 / 不存在的单元 → 空数组', function () {
  assert.deepStrictEqual(books.getWordsByUnit('不存在的册', 1), []);
  assert.deepStrictEqual(books.getWordsByUnit(VOLUME, 99), []);
  assert.deepStrictEqual(books.getWordsByUnit('', 1), []);
  assert.deepStrictEqual(books.unitsOf('nope'), []);
  assert.strictEqual(books.findVolume('nope'), null);
});

ok('unitLabel 给出可读的"版本 · 册 · Unit N 名称"', function () {
  var l = books.unitLabel(VOLUME, 3);
  assert.ok(l.indexOf('外研版') >= 0, '应含版本名');
  assert.ok(l.indexOf('四年级上册') >= 0, '应含册名');
  assert.ok(l.indexOf('Unit 3') >= 0, '应含单元号');
  assert.ok(l.indexOf('weather') >= 0, '应含单元标题（新版 Unit 3：What\'s the weather like?）');
  var all = books.unitLabel(VOLUME, 0);
  assert.ok(all.indexOf('Unit') < 0, '整册标签不该出现 Unit');
  assert.strictEqual(books.unitLabel('nope', 1), '');
});

ok('旧路径不回归：按标签切词库的词数与结构改造前一致', function () {
  var wy = books.getWords(VOLUME);
  assert.ok(wy.length > 0, '按标签仍能取到外研词');
  wy.forEach(function (w) { assert.ok((w.tags || []).indexOf('外研四上') >= 0); });
  assert.strictEqual(books.getWords('all').length, WORDS.length);
  assert.strictEqual(books.getWords('').length, WORDS.length);
  assert.strictEqual(books.getWords('zk').length > 0, true);
});

ok('非教材词不带三级字段（字段含义不暧昧）', function () {
  var nonTextbook = WORDS.filter(function (w) { return (w.tags || []).indexOf('外研四上') < 0; });
  assert.ok(nonTextbook.length > 0);
  nonTextbook.forEach(function (w) {
    assert.ok(!w.volume, w.word + ' 不是教材词却带了 volume');
    assert.ok(!w.unit, w.word + ' 不是教材词却带了 unit');
  });
});

ok('每个 Unit 的词数都够布置（≥ 最小词数 3）', function () {
  unitsOfAll().forEach(function (u) {
    assert.ok(u.count >= 3, 'Unit ' + u.no + ' 只有 ' + u.count + ' 词，达不到布置下限 3');
  });
});

ok('booktree.js 体积可控（会进主包）', function () {
  var size = fs.statSync(path.join(ROOT, 'miniprogram', 'data', 'booktree.js')).size;
  assert.ok(size < 20000, '目录树 ' + size + ' 字节，过大应改成按需拉取');
});

function unitsOfAll() {
  return books.unitsOf(VOLUME);
}

console.log('\n全部通过：' + pass + ' 项 ✓');
