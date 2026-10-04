/**
 * 时间工具测试（重点覆盖 UTC+8 的跨天边界）
 *
 *   node tests/time.test.js
 *
 * 为什么专门测这个：云函数运行在 UTC，用户在中国。
 * 若"今天"用 new Date() 直接判断，晚上 20:00 之后（UTC 已跨日）任务、打卡、周报
 * 全部会归到错误的一天，且只在特定时段复现 —— 属于"上线三个月才发现"的典型 bug。
 */

var assert = require('assert');
var time = require('../shared/time');

var passed = 0;
var failed = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed.push(name);
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

/** 构造一个北京时间的时刻：年-月-日 时:分 */
function bj(y, m, d, hh, mm) {
  return Date.UTC(y, m - 1, d, (hh || 0) - 8, mm || 0, 0);   // 北京时间 = UTC + 8
}

console.log('时间工具测试（UTC+8）');

test('北京时间白天：日期正确', function () {
  assert.strictEqual(time.getLocalDate(bj(2026, 3, 15, 10, 0)), '2026-03-15');
});

test('北京时间 23:59 仍属于当天（这是最容易错的一刻）', function () {
  assert.strictEqual(time.getLocalDate(bj(2026, 3, 15, 23, 59)), '2026-03-15');
});

test('北京时间 00:01 已属于次日', function () {
  assert.strictEqual(time.getLocalDate(bj(2026, 3, 16, 0, 1)), '2026-03-16');
});

test('UTC 已跨日但北京时间未跨日时，仍算北京时间的那一天', function () {
  // 北京时间 3/15 20:00 == UTC 3/15 12:00；北京时间 3/15 23:00 == UTC 3/15 15:00
  // 取一个 UTC 是 3/15 23:30 / 北京 3/16 07:30 的时刻，验证用的是北京时间
  assert.strictEqual(time.getLocalDate(bj(2026, 3, 16, 7, 30)), '2026-03-16');
});

test('当天起点是北京时间 00:00', function () {
  var start = time.getLocalDayStart(bj(2026, 3, 15, 15, 30));
  assert.strictEqual(start, bj(2026, 3, 15, 0, 0));
});

test('当天终点是北京时间 23:59:59.999', function () {
  var end = time.getLocalDayEnd(bj(2026, 3, 15, 1, 0));
  assert.strictEqual(end, bj(2026, 3, 16, 0, 0) - 1);
});

test('跨月推移：3/1 往前一天是 2/28（非闰年）', function () {
  assert.strictEqual(time.shiftLocalDate('2026-03-01', -1), '2026-02-28');
});

test('跨月推移：3/31 往后一天是 4/1', function () {
  assert.strictEqual(time.shiftLocalDate('2026-03-31', 1), '2026-04-01');
});

test('跨年推移：12/31 往后一天是次年 1/1', function () {
  assert.strictEqual(time.shiftLocalDate('2025-12-31', 1), '2026-01-01');
});

test('闰年 2/28 往后一天是 2/29', function () {
  assert.strictEqual(time.shiftLocalDate('2024-02-28', 1), '2024-02-29');
});

test('天数差计算正确（跨月）', function () {
  assert.strictEqual(time.diffDays('2026-02-27', '2026-03-02'), 3);
  assert.strictEqual(time.diffDays('2026-03-02', '2026-02-27'), -3);
});

test('两个时间戳之间按北京时间算自然天数', function () {
  var a = bj(2026, 3, 15, 23, 50);
  var b = bj(2026, 3, 16, 0, 10);   // 相隔 20 分钟，但跨了一个自然日
  assert.strictEqual(time.daysBetweenTs(a, b), 1);
});

test('展示用短日期格式正确', function () {
  assert.strictEqual(time.shortDate(bj(2026, 3, 5, 9, 0)), '3/5');
});

console.log('');
if (failed.length) {
  console.log('失败 ' + failed.length + ' 项，通过 ' + passed + ' 项');
  process.exit(1);
} else {
  console.log('全部通过：' + passed + ' 项 ✓');
}
