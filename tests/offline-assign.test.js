/**
 * 离线可练测试
 *
 * 背景：加"布置作业"之前，整个练习流程都在本机（词在本地、进度在本地），断网照练；
 * 加了之后作业词单只在云端，于是断网时孩子打开就"没有作业"，练的还是另一批词，
 * 联网后家长端显示"作业 0/10"，家长只会怀疑数据坏了。
 *
 * 这里守住两件事：
 *   ① 本机快照能救场：断网时练的仍然是老师布置的那批词（不是默认词库）；
 *   ② 有网时必须以云端为准：绝不能因为"本机有一份"就把进度钉死在旧数字上。
 * 第②条尤其重要 —— 为了离线可用性牺牲在线正确性，等于用新问题换老问题。
 */

var assert = require('assert');
var path = require('path');
var fs = require('fs');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) {
    console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  }
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
global.setTimeout = function (fn, ms) { timers.push({ id: ++tid, fn: fn, ms: ms || 0 }); return tid; };
global.clearTimeout = function (id) { timers = timers.filter(function (t) { return t.id !== id; }); };

var asgcache = require('../miniprogram/utils/asgcache');
var cloud = require('../miniprogram/utils/cloud');

console.log('离线可练测试：');

/* ---------------- 一、快照缓存本身 ---------------- */

test('① 保存后能取回最新一份作业（只存练得上用的字段）', function () {
  store = {};
  // 云端 myAssignments 按 created_at 倒序下发，所以第 0 份就是最新的 —— 这里照抄真实顺序
  var n = asgcache.save([
    { id: 'A2', name: '周四作业', word_ids: ['w3'], count: 1, deadline: '2026-10-10', unit_label: 'Unit 3' },
    { id: 'A1', name: '周三作业', word_ids: ['w1', 'w2'], count: 2, deadline: '', unit_label: '' }
  ]);
  assert.strictEqual(n, 2);
  var a = asgcache.latest();
  assert.strictEqual(a.name, '周四作业', '应取最近的一份');
  assert.deepStrictEqual(a.ids, ['w3']);
  assert.strictEqual(a.unit_label, 'Unit 3');
  // 快照里不该出现整份云端结构（避免老字段把本机拖垮）
  var raw = store[asgcache.KEY_SNAP].list[0];
  assert.deepStrictEqual(Object.keys(raw).sort(),
    ['count', 'deadline', 'id', 'ids', 'name', 'personalized', 'unit_label']);
});

test('② 空列表 / 没有词单的作业不写快照（脏快照比没快照更糟）', function () {
  store = {};
  assert.strictEqual(asgcache.save([]), 0);
  assert.strictEqual(asgcache.latest(), null);
  assert.strictEqual(asgcache.save([{ id: 'x', name: '空作业', word_ids: [] }]), 0);
  assert.strictEqual(asgcache.latest(), null);
});

test('③ 本地算进度：按 word_state_mirror「学过即算」（与云端同口径）', function () {
  store = {};
  var prog = asgcache.localProgress(['w1', 'w2', 'w3'], { w1: { stage: 1 }, w3: { stage: 0 } });
  assert.strictEqual(prog.done, 2, '学过两个词应算 2');
  assert.strictEqual(prog.count, 3);
  // 没有镜像时是 0/3，而不是报错
  assert.deepStrictEqual(asgcache.localProgress(['w1'], null), { done: 0, count: 1 });
  assert.deepStrictEqual(asgcache.localProgress([], {}), { done: 0, count: 0 });
});

test('④ 同步状态：成功/失败各自留痕，pending 取的是补传队列长度', function () {
  store = {};
  asgcache.markOk();
  assert.strictEqual(asgcache.state().offline, false);
  assert.ok(asgcache.state().lastOkAt > 0);
  store['cloud_pending_review'] = [{ a: 1 }, { a: 2 }];
  assert.strictEqual(asgcache.state().pending, 2, '应读出补传队列里的 2 条');

  asgcache.markFail(new Error('网络异常'));
  var s = asgcache.state();
  assert.strictEqual(s.offline, true, '失败后应标记为离线');
  assert.ok(s.lastFailAt > 0);
  assert.ok(s.lastMsg.indexOf('网络异常') >= 0, '应留下原因：' + s.lastMsg);

  asgcache.markOk();
  assert.strictEqual(asgcache.state().offline, false, '重新成功后必须立刻不再是离线');
});

test('⑤ 退出班级要清干净（别人的作业不能留在本机）', function () {
  store = {};
  asgcache.save([{ id: 'A1', name: '作业', word_ids: ['w1'] }]);
  assert.ok(asgcache.latest());
  asgcache.clear();
  assert.strictEqual(asgcache.latest(), null);
});

test('⑥ 超过 30 天的快照标记为 stale（还能练，但要提示）', function () {
  store = {};
  asgcache.save([{ id: 'A1', name: '作业', word_ids: ['w1'] }]);
  var snap = store[asgcache.KEY_SNAP];
  snap.at = Date.now() - (asgcache.SNAP_TTL_MS + 1000);
  store[asgcache.KEY_SNAP] = snap;
  var a = asgcache.latest();
  assert.ok(a, '过期了也不能返回 null —— 有得练比没得练强');
  assert.strictEqual(a.stale, true);
});

/* ---------------- 二、练习页的离线回退（真页面代码） ---------------- */

function loadPage(file) {
  var full = path.resolve(__dirname, '..', file);
  delete require.cache[full];
  var captured = null;
  var orig = global.Page;
  global.Page = function (def) { captured = def; };
  try { require(full); } finally { global.Page = orig; delete require.cache[full]; }
  return captured;
}

function makePage(def, data) {
  var page = {};
  Object.keys(def).forEach(function (k) {
    if (k === 'data' || k === 'behaviors') return;
    page[k] = def[k];
  });
  page.data = Object.assign({}, def.data || {}, data || {});
  page.setData = function (patch) {
    Object.keys(patch).forEach(function (k) {
      if (k.indexOf('.') < 0) { page.data[k] = patch[k]; return; }
      var parts = k.split('.');
      var cur = page.data;
      for (var i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = patch[k];
    });
  };
  return page;
}

function syncResolve(data) {
  var obj = { then: function (res) { res(data); return obj; }, catch: function () { return obj; } };
  return obj;
}
function syncReject(err) {
  var obj = {
    then: function (res, rej) { if (rej) rej(err); return obj; },
    catch: function (fn) { fn(err); return obj; }
  };
  return obj;
}

cloud.api.submitReview = function () { return syncResolve({ ok: true }); };
cloud.api.drillScore = function () { return syncResolve({ rank: 1, badge: '', detail: '' }); };

var def = loadPage('miniprogram/pkg-media/pages/drill/drill.js');
var POOL = require('../miniprogram/data/words');
var ASSIGN_WORDS = [POOL[0].word, POOL[1].word, POOL[2].word];

function freshPage() {
  timers.length = 0;
  store = {};
  return makePage(def);
}

test('⑦ ★ 断网时：练习页退回本机留存的作业词单（不是默认词库）', function () {
  var p = freshPage();
  cloud.api.todayTask = function () { return syncReject(new Error('网络异常')); };
  store[asgcache.KEY_SNAP] = {
    at: Date.now(),
    list: [{ id: 'A1', name: 'Unit 3 作业', ids: ASSIGN_WORDS, count: ASSIGN_WORDS.length,
             deadline: '', unit_label: 'Unit 3', personalized: false }]
  };

  p.onLoad({});
  assert.strictEqual(p.data.assignName, 'Unit 3 作业', '应带上作业名');
  assert.strictEqual(p.data.offline, true, '应标记离线');
  var got = (p.data.words || []).map(function (w) { return w.word; });
  assert.deepStrictEqual(got.slice().sort(), ASSIGN_WORDS.slice().sort(),
    '练的必须是老师布置的那批词，实际：' + got.join(','));
});

test('⑧ ★ 有网时：一律以云端为准（缓存不得抢先）', function () {
  var p = freshPage();
  var cloudWords = [POOL[5].word, POOL[6].word];
  cloud.api.todayTask = function () {
    return syncResolve({ words: cloudWords.map(function (w) { return { word: w }; }) });
  };
  store[asgcache.KEY_SNAP] = {
    at: Date.now(),
    list: [{ id: 'A1', name: '缓存作业', ids: ASSIGN_WORDS, count: 3, deadline: '', unit_label: '' }]
  };

  p.onLoad({});
  assert.strictEqual(p.data.offline, false, '联网时不该显示离线');
  assert.strictEqual(p.data.assignName, '', '走着云端任务，不该顶着缓存的作业名');
  var got = (p.data.words || []).map(function (w) { return w.word; });
  assert.deepStrictEqual(got, cloudWords, '应以云端的今日任务为准');
});

test('⑨ 断网且没有快照：退回本地默认任务（保证永远有得练）', function () {
  var p = freshPage();
  cloud.api.todayTask = function () { return syncReject(new Error('网络异常')); };
  p.onLoad({});
  assert.strictEqual(p.data.offline, false);
  assert.ok(p.data.words.length > 0, '任何情况下都得有词可练');
  assert.strictEqual(p.data.words.length, 10, '默认取 10 个词');
});

test('⑩ 快照里的词本地词库没有时不崩（只练匹配得上的那部分）', function () {
  var p = freshPage();
  cloud.api.todayTask = function () { return syncReject(new Error('网络异常')); };
  store[asgcache.KEY_SNAP] = {
    at: Date.now(),
    list: [{ id: 'A1', name: '幽灵作业', ids: ['zzz-not-exist', 'qqq-nope'], count: 2, deadline: '' }]
  };
  p.onLoad({});
  assert.ok(p.data.words.length > 0, '应退回本地默认任务而不是空白页');
  assert.strictEqual(p.data.assignName, '', '匹配不上就别顶着作业名');
});

test('⑪ 前端必须有离线说明（否则家长看到延迟就以为数据丢了）', function () {
  var drillWxml = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pkg-media/pages/drill/drill.wxml'), 'utf8');
  assert.ok(drillWxml.indexOf('offline') >= 0, '练习页应有离线提示');
  var idxJs = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/index/index.js'), 'utf8');
  assert.ok(/myAssignments[\s\S]*?catch[\s\S]*?fallbackToCachedAssign/.test(idxJs),
    '首页作业加载失败必须走缓存回退');
  assert.ok(idxJs.indexOf('asgcache.save') >= 0, '云端成功时要把最新作业存下来当退路');
  var idxWxml = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/index/index.wxml'), 'utf8');
  assert.ok(idxWxml.indexOf('offline-tip') >= 0, '首页应显示"离线练习"说明');
  assert.ok(idxWxml.indexOf('syncState') >= 0, '应有同步状态提示');
});

console.log('\n全部通过：' + passed + ' 项 ✓');
