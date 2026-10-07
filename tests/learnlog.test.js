/**
 * 学习流水测试
 *
 * 为什么要测它：家长内测时反复问"我到底学没学、是不是我操作不对"——
 * 流水就是用来结束这种猜疑的。它一旦记错（丢条、云端状态回写错对象、
 * 补传成功后状态没翻绿），家长的判断就会被引到错误方向，所以口径必须钉死。
 */

var assert = require('assert');

var storage = {};
global.wx = {
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; }
};

var learnlog = require('../miniprogram/utils/learnlog');

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}
function reset() { storage = {}; }

console.log('学习流水 learnlog');

reset();
ok('① 记一笔：本地已记、云端待确认，字段齐全', function () {
  var id = learnlog.push({ word: 'search', mode: 'assign', assign: 'hhh', feedback: 'known' });
  assert.ok(id, '应返回 id 供后续回填');
  var one = learnlog.recent(1)[0];
  assert.strictEqual(one.word, 'search');
  assert.strictEqual(one.mode, 'assign');
  assert.strictEqual(one.feedback, 'known');
  assert.strictEqual(one.local, true);
  assert.strictEqual(one.cloud, 'pending');
});

reset();
ok('② 最新在前：recent 按时间倒序', function () {
  learnlog.push({ word: 'a', mode: 'task', feedback: 'known' });
  learnlog.push({ word: 'b', mode: 'task', feedback: 'forgot' });
  var list = learnlog.recent(2);
  assert.strictEqual(list[0].word, 'b');
  assert.strictEqual(list[1].word, 'a');
});

reset();
ok('③ 云端结果回填：ok / fail 都要能翻状态，且带上失败原因', function () {
  var id1 = learnlog.push({ word: 'a', mode: 'task', feedback: 'known' });
  var id2 = learnlog.push({ word: 'b', mode: 'task', feedback: 'forgot' });
  learnlog.patch(id1, 'ok');
  learnlog.patch(id2, 'fail', 'STATE_WRITE_FAIL');
  var list = learnlog.recent(2);
  var a = list.filter(function (x) { return x.word === 'a'; })[0];
  var b = list.filter(function (x) { return x.word === 'b'; })[0];
  assert.strictEqual(a.cloud, 'ok');
  assert.strictEqual(b.cloud, 'fail');
  assert.strictEqual(b.err, 'STATE_WRITE_FAIL');
});

reset();
ok('④ 补传重放成功：按云端幂等 reqId 回写（不能靠猜哪一条）', function () {
  learnlog.push({ word: 'a', mode: 'task', feedback: 'known', reqId: 'req-1' });
  learnlog.push({ word: 'b', mode: 'task', feedback: 'known', reqId: 'req-2' });
  assert.strictEqual(learnlog.patchByReq('req-2', 'ok'), true, '应命中 req-2');
  var list = learnlog.recent(2);
  var a = list.filter(function (x) { return x.word === 'a'; })[0];
  var b = list.filter(function (x) { return x.word === 'b'; })[0];
  assert.strictEqual(b.cloud, 'ok', 'req-2 那条应翻绿');
  assert.strictEqual(a.cloud, 'pending', 'req-1 那条不能被误改');
  assert.strictEqual(learnlog.patchByReq('不存在', 'ok'), false);
});

reset();
ok('⑤ 环形上限：只留最近 60 条，不会把 storage 撑爆', function () {
  for (var i = 0; i < 75; i++) {
    learnlog.push({ word: 'w' + i, mode: 'task', feedback: 'known' });
  }
  var all = learnlog.recent(100);
  assert.strictEqual(all.length, 60, '应只保留 60 条，实际 ' + all.length);
  assert.strictEqual(all[0].word, 'w74', '最新的一条在最前');
});

reset();
ok('⑥ 渲染行：状态文案可读（云端✓ / 云端✗带原因 / 云端…）', function () {
  var id1 = learnlog.push({ word: 'a', mode: 'quiz', feedback: 'known' });
  var id2 = learnlog.push({ word: 'b', mode: 'assign', assign: 'hhh', feedback: 'vague' });
  learnlog.patch(id1, 'ok');
  learnlog.patch(id2, 'fail', 'E11000');
  var lines = learnlog.lines(2);
  var a = lines.filter(function (x) { return x.word === 'a'; })[0];
  var b = lines.filter(function (x) { return x.word === 'b'; })[0];
  assert.ok(a.cloudTxt.indexOf('云端✓') === 0, 'a 应为云端✓，实际 ' + a.cloudTxt);
  assert.ok(b.cloudTxt.indexOf('云端✗') === 0 && b.cloudTxt.indexOf('E11000') > 0,
    'b 应带失败原因，实际 ' + b.cloudTxt);
  assert.strictEqual(b.mode, '作业');
  assert.strictEqual(b.feedback, '模糊');
});

reset();
ok('⑦ 复制文本：含口径说明 + 逐条流水，家长可直接发出来排查', function () {
  learnlog.push({ word: 'search', mode: 'assign', assign: 'hhh', feedback: 'known' });
  var text = learnlog.toText(10);
  assert.ok(text.indexOf('进度口径') > 0, '必须写明"学过即算"口径');
  assert.ok(text.indexOf('search') > 0);
  assert.ok(text.indexOf('《hhh》') > 0);
  assert.ok(text.indexOf('本地已记') > 0);
});

reset();
ok('⑧ 清空后不报错（页面不应因空流水崩）', function () {
  learnlog.push({ word: 'a', mode: 'task', feedback: 'known' });
  learnlog.clear();
  assert.deepStrictEqual(learnlog.recent(5), []);
  assert.deepStrictEqual(learnlog.lines(5), []);
});

console.log('\n全部通过：' + pass + ' 项 ✓');
