/**
 * 快刷流程集成测试：用真实的 drill 页面代码跑一遍新流程
 *
 *   node tests/drill-flow.test.js
 *
 * 钉死用户定的规则（2026-10-07 改版）：
 *   ① 首轮是"单词+音标+两个中文选项"，自动读音
 *   ② ≤5 秒选对 → known，直接下一词（不进详情）
 *   ③ 5~10 秒选对 → vague（想了很久），但仍算过
 *   ④ 选错 → forgot + 进词详情（看释义/例句）
 *   ⑤ >10 秒没选 → 按不会处理，同样进详情
 *   ⑥ 本轮有没拿下的词 → 自动进入下一轮循环（换题型反复测）
 *   ⑦ 全部答对 → 完成态：时长 + 错题本
 *   ⑧ 一直答错不会锁死：最多 MAX_ROUNDS 轮后结束，剩下的词摆在结果页
 */

var assert = require('assert');
var path = require('path');

var passed = 0;
var failed = [];

function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed.push(name); console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack : e)); }
}

/* ---------- 极简小程序运行时 ---------- */

var timers = [];
var tid = 0;
var store = {};

global.wx = {
  getStorageSync: function (k) { return store[k]; },
  setStorageSync: function (k, v) { store[k] = v; },
  showToast: function () {},
  showLoading: function () {},
  hideLoading: function () {},
  redirectTo: function () {},
  navigateTo: function () {},
  createInnerAudioContext: function () {
    return { src: '', stop: function () {}, play: function () {} };
  }
};
var realSetTimeout = setTimeout;
/** clearTimeout 必须真的取消：否则上一题的 10 秒定时器会在后面冒出来乱判 */
global.setTimeout = function (fn, ms) { timers.push({ id: ++tid, fn: fn }); return tid; };
global.clearTimeout = function (id) {
  timers = timers.filter(function (t) { return t.id !== id; });
};
function flushTimers() { var l = timers.slice(); timers.length = 0; l.forEach(function (t) { t.fn(); }); }

/** 读页面定义（Page 注册） */
function loadPage(file) {
  var full = path.resolve(__dirname, '..', file);
  delete require.cache[full];
  var captured = null;
  var orig = global.Page;
  global.Page = function (def) { captured = def; };
  try { require(full); } finally { global.Page = orig; delete require.cache[full]; }
  assert.ok(captured, file + ' 没有注册 Page');
  return captured;
}

/** 造一个页面实例：data + 方法 + setData（同步合并，测试可见） */
function makePage(def, data) {
  var page = {};
  Object.keys(def).forEach(function (k) {
    if (k === 'data' || k === 'behaviors') return;
    page[k] = def[k];
  });
  page.data = Object.assign({}, def.data || {}, data || {});
  page.setData = function (patch) { Object.assign(page.data, patch); };
  return page;
}

/* ---------- 云 API 打桩：不让测试真的发网络请求 ---------- */

var cloud = require('../miniprogram/utils/cloud');
var submitted = [];
/** 同步兑现的 thenable：让测试不用 await 就能拿到"云端已返回"的状态 */
function syncResolve(data) {
  var obj = {
    then: function (res) { res(data); return obj; },
    catch: function () { return obj; }
  };
  return obj;
}

cloud.api.submitReview = function (p) {
  submitted.push(p);
  return syncResolve({ ok: true });
};
cloud.api.todayTask = function () {
  return syncResolve({ words: [{ word: 'train' }, { word: 'street' }] });
};

var def = loadPage('miniprogram/pages/drill/drill.js');

/** 每道题的用时：用改 qStartAt 的方式模拟（不动真实时间） */
function elapsed(p, ms) { p.qStartAt = Date.now() - ms; }

/** 造一个已经进入第 1 题的页面 */
function startedPage() {
  var p = makePage(def);
  p.onLoad({});
  return p;
}

console.log('\n快刷流程（新主流程）：');

test('① 首轮是二选一：单词+音标+两个中文选项，且含正确答案', function () {
  var p = startedPage();
  assert.strictEqual(p.data.state, 'run');
  assert.strictEqual(p.data.phase, 'binary');
  assert.strictEqual(p.data.q.type, 'binary');
  assert.strictEqual(p.data.q.options.length, 2, '选项必须是 2 个，实际 ' + p.data.q.options.length);
  assert.ok(p.data.q.options.indexOf(p.data.q.word.def_cn) >= 0, '选项里必须有正确释义');
  assert.strictEqual(p.data.q.options[p.data.q.answerIdx], p.data.q.word.def_cn);
  assert.ok(p.data.q.word.phonetic, '要显示音标');
});

test('② ≤5 秒选对 → known，直接下一词（不弹详情）', function () {
  var p = startedPage();
  var w = p.data.q.word.word;
  elapsed(p, 1200);                       // 想了 1.2 秒
  p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx } } });
  flushTimers();                          // 推进"答对后换词"的定时器
  assert.strictEqual(p.mirror[w].last_feedback, 'known', '应为 known');
  assert.strictEqual(p.data.state, 'run', '答对不该进详情');
  assert.strictEqual(p.data.detail, null);
  assert.strictEqual(p.data.idx, 1, '应该已经到下一个词');
});

test('③ 5~10 秒才选对 → vague（想了很久），但仍算通过、进错题本待巩固', function () {
  var p = startedPage();
  var w = p.data.q.word.word;
  elapsed(p, 7000);                       // 想了 7 秒
  p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx } } });
  flushTimers();
  assert.strictEqual(p.mirror[w].last_feedback, 'vague', '应为 vague，实际 ' + p.mirror[w].last_feedback);
  assert.strictEqual(p.data.state, 'run', 'vague 也过，不进详情');
  assert.ok(p.data.wrongBook.length === 1, 'vague 要进错题本再巩固一次');
});

test('④ 选错 → forgot + 进入词详情（含释义/例句/你选的 vs 正确的）', function () {
  var p = startedPage();
  var q = p.data.q;
  var wrongIdx = q.answerIdx === 0 ? 1 : 0;
  elapsed(p, 2000);
  p.onPick({ currentTarget: { dataset: { idx: wrongIdx } } });
  assert.strictEqual(p.data.state, 'detail', '答错必须进详情');
  assert.strictEqual(p.data.detail.word.word, q.word.word);
  assert.strictEqual(p.data.detail.answer, q.word.def_cn);
  assert.strictEqual(p.data.detail.yourPick, q.options[wrongIdx], '要告诉他刚才选的是哪个');
  assert.strictEqual(p.mirror[q.word.word].last_feedback, 'forgot');
});

test('⑤ 超过 10 秒没选 → 自动按"不会"处理并进详情', function () {
  var p = startedPage();
  var w = p.data.q.word.word;
  p.onTimeout();
  assert.strictEqual(p.data.state, 'detail', '超时必须进详情');
  assert.strictEqual(p.data.detail.timeout, true, '要标明是超时');
  assert.strictEqual(p.mirror[w].last_feedback, 'forgot', '超时按不会记');
});

test('⑥ 详情里点「记住了，继续」→ 回到答题，词往下走', function () {
  var p = startedPage();
  elapsed(p, 1000);
  p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx === 0 ? 1 : 0 } } });
  assert.strictEqual(p.data.state, 'detail');
  p.onDetailNext();
  assert.strictEqual(p.data.state, 'run');
  assert.strictEqual(p.data.idx, 1);
});

test('⑦ 本轮有没拿下的词 → 自动进下一轮循环（换题型反复测）', function () {
  var p = startedPage();
  // 两个词都答错
  elapsed(p, 1000);
  p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx === 0 ? 1 : 0 } } });
  p.onDetailNext();
  elapsed(p, 1000);
  p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx === 0 ? 1 : 0 } } });
  p.onDetailNext();                        // 第二个词答完 → 收尾
  assert.strictEqual(p.data.round, 2, '应自动进入第 2 轮，实际 ' + p.data.round);
  assert.strictEqual(p.data.phase, 'loop');
  assert.strictEqual(p.data.words.length, 2, '第 2 轮只练上一轮没拿下的词');
  // 循环轮的题型来自现有抽查方式（选义/拼写/听写），不再是二选一
  assert.ok(['meaning', 'spell', 'listen'].indexOf(p.data.q.type) >= 0,
    '循环轮应换用现有抽查方式，实际 ' + p.data.q.type);
});

test('⑧ 全部答对 → 完成态：时长 + 错题本 + 全对标记', function () {
  var p = startedPage();
  // 两个词都快速答对
  for (var i = 0; i < 2; i++) {
    elapsed(p, 1000);
    p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx } } });
    flushTimers();
  }
  assert.strictEqual(p.data.state, 'done', '全对应结束，实际 ' + p.data.state);
  assert.strictEqual(p.data.result.allDone, true);
  assert.strictEqual(p.data.result.mastered, 2);
  assert.strictEqual(p.data.result.wrongBook.length, 0, '全对不该有错题本');
  assert.ok(/秒/.test(p.data.elapsedText), '完成页要给出时长，实际 ' + p.data.elapsedText);
});

test('⑨ 一直答错不会把孩子锁死：最多 5 轮后结束，剩下的词摆出来', function () {
  var p = startedPage();
  var guard = 0;
  while (p.data.state !== 'done' && guard < 200) {
    guard++;
    if (p.data.state === 'detail') { p.onDetailNext(); continue; }
    if (!p.data.q) break;
    elapsed(p, 1000);
    p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx === 0 ? 1 : 0 } } });
  }
  assert.strictEqual(p.data.state, 'done', '必须在有限轮次内结束');
  assert.ok(p.data.round <= 5, '轮次不得超过上限，实际 ' + p.data.round);
  assert.strictEqual(p.data.result.allDone, false);
  assert.ok(p.data.result.left.length > 0, '没拿下的词要摆在结果页');
  assert.ok(p.data.result.wrongBook.length > 0, '错题本要有内容');
});

test('⑩ 每次判定都提交云端（幂等 reqId），教练端进度才跟得上', function () {
  submitted.length = 0;
  var p = startedPage();
  elapsed(p, 1000);
  p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx } } });
  flushTimers();
  assert.strictEqual(submitted.length, 1, '应提交 1 次反馈，实际 ' + submitted.length);
  assert.ok(submitted[0].clientReqId, '必须带幂等 ID，否则补传会重复计数');
});

console.log('\n通过：' + passed + ' 项' + (failed.length ? '，失败 ' + failed.length + ' 项：' + failed.join('、') : ' ✓'));
if (failed.length) process.exitCode = 1;
