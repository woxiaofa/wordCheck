/**
 * 日报 / 周报 / 月报 测试
 *
 * 为什么要测它：报告是家长唯一会看的东西。它一旦算错（区间错位、环比拿错窗口、
 * 没数据就崩），家长看到的就是"看着挺专业其实是错的"——比没有更糟。
 * 这里把口径钉死：题数、答对率、活跃天数、环比、错词榜、空数据文案。
 */

var assert = require('assert');

var storage = {};
global.wx = {
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; }
};

var report = require('../miniprogram/utils/report');
var time = require('../miniprogram/utils/time');

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

function reset() { storage = {}; }
function day(date, total, known, vague, forgot) {
  return {
    total: total, known: known, vague: vague || 0, forgot: forgot || (total - known),
    words: {}
  };
}
function seed(map) { storage[report.KEY] = map; }
function defOf() { return function () { return '释义'; }; }

console.log('日报 / 周报 / 月报测试：');

ok('① 记一笔：日报立刻能算出题数与答对率', function () {
  reset();
  report.record('apple', 'known');
  report.record('apple', 'forgot');
  report.record('banana', 'known');
  var r = report.build(1, defOf());
  assert.strictEqual(r.total, 3, '共 3 题');
  assert.strictEqual(r.known, 2, 'apple 答对 1 次 + banana 答对 1 次');
  assert.strictEqual(r.forgot, 1);
  assert.strictEqual(r.rate, 67, '2/3 → 67%');
  assert.strictEqual(r.activeDays, 1);
  assert.strictEqual(r.days, 1);
});

ok('② 错词榜：只收真的答错过的词，按次数倒序', function () {
  reset();
  report.record('apple', 'forgot');
  report.record('apple', 'vague');
  report.record('apple', 'forgot');
  report.record('banana', 'forgot');
  report.record('pear', 'known');
  var r = report.build(1, defOf());
  assert.strictEqual(r.topWrong.length, 2, 'pear 没错，不该进榜');
  assert.strictEqual(r.topWrong[0].word, 'apple');
  assert.strictEqual(r.topWrong[0].wrong, 3);
  assert.strictEqual(r.topWrong[1].word, 'banana');
});

ok('③ 周报窗口 = 今天往前 7 天，活跃天数只算有练习的日子', function () {
  reset();
  var today = time.getLocalDate();
  var m = {};
  m[today] = day(today, 10, 8);
  m[time.shiftLocalDate(today, -1)] = day('d', 5, 3);
  m[time.shiftLocalDate(today, -3)] = day('d', 4, 4);
  m[time.shiftLocalDate(today, -9)] = day('d', 100, 100);   // 窗口外，不该被算进来
  seed(m);
  var r = report.build(7, defOf());
  assert.strictEqual(r.total, 19, '10+5+4（窗口外的 100 题不计入）');
  assert.strictEqual(r.known, 15);
  assert.strictEqual(r.activeDays, 3);
  assert.strictEqual(r.series.length, 7, '趋势条 7 根');
  assert.strictEqual(r.bestDay.total, 10, '最多的一天是今天');
});

ok('④ 环比：拿上一个等长窗口做对比，方向要标出来', function () {
  reset();
  var today = time.getLocalDate();
  var m = {};
  m[today] = day(today, 10, 8);                              // 本周 80%
  m[time.shiftLocalDate(today, -7)] = day('d', 10, 5);       // 上周 50%
  seed(m);
  var r = report.build(7, defOf());
  assert.strictEqual(r.rate, 80);
  assert.strictEqual(r.prevRate, 50);
  assert.strictEqual(r.delta, 30);
  assert.strictEqual(r.deltaUp, true);

  m[today] = day(today, 10, 4);                              // 反过来：本周退步
  seed(m);
  var r2 = report.build(7, defOf());
  assert.strictEqual(r2.delta, -10);
  assert.strictEqual(r2.deltaUp, false);
  assert.ok(r2.deltaText.indexOf('10') >= 0, '下降文案要带数字：' + r2.deltaText);
});

ok('⑤ 没有对比数据时：delta 为 null，不伪造涨跌', function () {
  reset();
  var today = time.getLocalDate();
  var m = {};
  m[today] = day(today, 6, 5);
  seed(m);
  var r = report.build(7, defOf());
  assert.strictEqual(r.delta, null);
  assert.strictEqual(r.deltaText, '暂无对比');
});

ok('⑥ 完全没有记录：不崩，且给出"该做什么"的文案', function () {
  reset();
  [1, 7, 30].forEach(function (d) {
    var r = report.build(d, defOf());
    assert.strictEqual(r.total, 0);
    assert.strictEqual(r.rate, 0);
    assert.ok(r.headline.indexOf('没有') >= 0, '区间 ' + d + ' 天应有空态文案：' + r.headline);
    assert.ok(r.parentLine.length > 0);
  });
});

ok('⑦ 趋势条高度：最高的那天顶满，有练习但很少的日子也看得见', function () {
  reset();
  var today = time.getLocalDate();
  var m = {};
  m[today] = day(today, 20, 18);
  m[time.shiftLocalDate(today, -1)] = day('d', 1, 1);
  seed(m);
  var r = report.build(7, defOf());
  var max = 0;
  r.series.forEach(function (s) { if (s.total > max) max = s.total; });
  var top = r.series.filter(function (s) { return s.total === max; })[0];
  var tiny = r.series.filter(function (s) { return s.total === 1; })[0];
  assert.strictEqual(top.height, 100, '最高的一天顶满');
  assert.ok(tiny.height >= 12, '只练 1 题的日子也要看得见：' + tiny.height);
  assert.strictEqual(r.series.filter(function (s) { return s.total === 0; })[0].height, 0);
});

ok('⑧ 老明细会被丢弃，storage 不会无限膨胀', function () {
  reset();
  var today = time.getLocalDate();
  var m = {};
  m[time.shiftLocalDate(today, -200)] = day('d', 5, 5);
  m[today] = day(today, 2, 2);
  seed(m);
  report.record('apple', 'known');           // 触发一次 trim
  var raw = report.readRaw();
  assert.ok(!raw[time.shiftLocalDate(today, -200)], '200 天前的明细应被清掉');
  assert.ok(raw[today], '今天的明细必须还在');
});

ok('⑨ 月报：30 根趋势条，区间文案带起止日期', function () {
  reset();
  var today = time.getLocalDate();
  var m = {};
  m[today] = day(today, 12, 9);
  seed(m);
  var r = report.build(30, defOf());
  assert.strictEqual(r.series.length, 30);
  assert.strictEqual(r.days, 30);
  assert.ok(r.rangeLabel.indexOf('月报') === 0, '区间文案应以月报开头：' + r.rangeLabel);
  assert.ok(r.rangeLabel.indexOf('–') > 0, '月报应给出起止日期：' + r.rangeLabel);
});

console.log('\n全部通过：' + pass + ' 项 ✓');
