/**
 * 「开口读」旧闸门已删除的回归测试
 *
 *   node tests/oral-gate.test.js
 *
 * 2026-11-12：口语从前置闸门改成贯穿全程的题型，主入口改道 flow。
 * 2026-11-13：用户拍板「开口读那部分入口及内容删除」——
 *   独立跟读页、首页胶囊入口、drill 的 ?oral=1 第 0 步闸门全部清掉。
 *   本文件从「闸门编排测试」改成「旧闸门不许回来 + 跨页交接没断」的守护：
 *   ① 无论带不带 URL 参数，drill 一律直接进原来的「认」（40+ 条 drill-flow 断言的前提）
 *   ② 源码与页面里都不再有 gate / 开口读分支，也不再有独立 oral 页
 *   ③ 首页与底栏仍指向体验主流程 flow
 *   ④ flow → drill?fromFlow=1 → flow?report=1 的交接与合并报告不受影响
 *
 * 各阶段行为由 tests/oral-flow.test.js 用页面桩逐条自证。
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var pass = 0;
var fail = 0;

function ok(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    pass++;
    console.log('  ✓ ' + name);
  }).catch(function (e) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack : e));
  });
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

/* ---------- 极简运行时（照搬 drill-flow.test.js 的桩，保证行为一致） ---------- */

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

function loadPage(file) {
  var full = path.join(ROOT, file);
  delete require.cache[full];
  var captured = null;
  var orig = global.Page;
  global.Page = function (def) { captured = def; };
  try { require(full); } finally { global.Page = orig; delete require.cache[full]; }
  assert.ok(captured, file + ' 没有注册 Page');
  return captured;
}
function makePage(def) {
  var page = {};
  Object.keys(def).forEach(function (k) {
    if (k === 'data' || k === 'behaviors') return;
    page[k] = def[k];
  });
  page.data = Object.assign({}, def.data || {});
  page.setData = function (patch) {
    Object.keys(patch).forEach(function (k) { page.data[k] = patch[k]; });
  };
  return page;
}
function syncResolve(data) {
  var obj = { then: function (res) { res(data); return obj; }, catch: function () { return obj; } };
  return obj;
}

var cloud = require('../miniprogram/utils/cloud');
cloud.api.todayTask = function () {
  return syncResolve({ words: [{ word: 'train' }, { word: 'jump' }] });
};
cloud.api.submitReview = function () { return syncResolve({ ok: true }); };
cloud.api.drillScore = function () { return syncResolve({ rank: 1 }); };

var def = loadPage('miniprogram/pkg-media/pages/drill/drill.js');

function fresh(options) {
  timers.length = 0;
  delete store['word_state_mirror'];
  delete store['activity_log'];
  var p = makePage(def);
  p.onLoad(options || {});
  return p;
}
function tick() { return new Promise(function (r) { setImmediate(r); }); }

/* ---------------------------------------------------------------- */

(async function () {
  console.log('\n「开口读」旧闸门删除后的回归测试');

  await ok('① 不带参数：仍是原来的第 1 步「认」', function () {
    var p = fresh({});
    assert.strictEqual(p.data.state, 'run');
    assert.strictEqual(p.data.phase, 'recog');
    assert.strictEqual(p.data.q.type, 'binary');
  });

  await ok('② 就算带旧的 ?oral=1，也直接进「认」，不再停在开口读闸门', function () {
    var p = fresh({ oral: '1' });
    assert.notStrictEqual(p.data.state, 'oral', '旧闸门已经删了，不该再出现');
    assert.strictEqual(p.data.phase, 'recog');
    assert.strictEqual(p.data.q.type, 'binary');
    assert.strictEqual(p.data.gateWords, undefined, '闸门展示态字段应一并删除');
  });

  await ok('③ 源码：drill 里没有 gate 方法、开关与展示态', function () {
    var js = read('miniprogram/pkg-media/pages/drill/drill.js');
    var w = read('miniprogram/pkg-media/pages/drill/drill.wxml');
    ["options.oral === '1'", 'showOralGate', 'afterOral', 'onGateDone',
      'onGateRecord', '_oralGate', 'gateWords'].forEach(function (k) {
      assert.ok(js.indexOf(k) < 0, 'drill.js 仍留着 ' + k);
    });
    assert.ok(w.indexOf("state === 'oral'") < 0, 'drill.wxml 仍渲染闸门那一屏');
    assert.ok(w.indexOf('先开口读一遍') < 0, '仍留着「开口读」文案');
    assert.ok(js.indexOf("require('../../../utils/oral')") < 0,
      'drill 不该再依赖录音模块');
  });

  await ok('④ 取词分支统一过 begin()，「再来一轮」也不会被踢回口语关', function () {
    var js = read('miniprogram/pkg-media/pages/drill/drill.js');
    assert.ok(/\bbegin: function\b/.test(js), '缺编排入口');
    var begins = (js.match(/\b(?:this|self)\.begin\(/g) || []).length;
    assert.ok(begins >= 4, '4 条取词分支（作业/云端/断网/本机快照）都要过 begin，实际 ' + begins);
    assert.ok(/onAgain[\s\S]{0,300}startRound\(left, 'recog'\)/.test(js));
    var gateBlock = js.slice(js.indexOf('取词完毕的统一入口'), js.indexOf('/* ---------------- 轮次'));
    assert.ok(!/setStorageSync\(\s*['"]activity_log['"]/.test(gateBlock),
      '取词编排不许写 activity_log');
  });

  await ok('⑤ 取词前后都不写打卡：口语不是另一项作业', function () {
    var p = fresh({});
    assert.strictEqual(store['activity_log'], undefined, '还没答题，不该计数');
    assert.strictEqual(p.data.state, 'run');
  });

  await ok('⑥ 源码：主入口与底栏都进体验主流程，旧闸门没有入口指向', function () {
    var idx = read('miniprogram/pages/index/index.js');
    var nav = read('miniprogram/components/footer-nav/index.js');
    assert.ok(/goStudy:[\s\S]{0,500}pkg-oral\/pages\/flow\/flow/.test(idx),
      '首页「开始背单词」没进体验主流程');
    assert.ok(nav.indexOf("path: '/pkg-oral/pages/flow/flow'") >= 0, '底栏「背词」没跟上');
    assert.ok(nav.indexOf("path.split('?')[0]") >= 0,
      'path 带 query 后，onGo 必须剥掉再比 route，否则会无限 redirect');
    assert.ok(idx.indexOf('oral=1') < 0 && nav.indexOf('oral=1') < 0,
      '还有入口在拉旧闸门');
  });

  await ok('⑦ 独立「开口读」页与首页胶囊入口都删干净了', function () {
    var idxW = read('miniprogram/pages/index/index.wxml');
    var idxJ = read('miniprogram/pages/index/index.js');
    assert.ok(idxW.indexOf('goOral') < 0 && idxW.indexOf('开口读') < 0);
    assert.ok(idxJ.indexOf('goOral') < 0);
    var app = JSON.parse(read('miniprogram/app.json'));
    var pkg = (app.subpackages || []).filter(function (s) { return s.root === 'pkg-oral'; })[0];
    assert.ok(pkg && pkg.pages.indexOf('pages/oral/oral') < 0);
    assert.ok(!fs.existsSync(path.join(ROOT, 'miniprogram/pkg-oral/pages/oral/oral.js')));
  });

  await ok('⑧ 从 flow 拉起的书面阶段：交结果、回合并报告，不弹完成页也不上榜', function () {
    var urls = [];
    var scored = 0;
    var origRedirect = global.wx.redirectTo;
    var origScore = cloud.api.drillScore;
    global.wx.redirectTo = function (o) { urls.push(o.url); };
    cloud.api.drillScore = function () { scored++; return syncResolve({ rank: 1 }); };
    delete store['oral_flow_session'];
    try {
      var p = fresh({ fromFlow: '1' });
      p.startedAt = Date.now() - 30000;
      p._totalWords = 5;
      p.data.words = [
        { word: 'clean' }, { word: 'desk' }, { word: 'tidy' },
        { word: 'house' }, { word: 'wash' }
      ];
      p.data.roundWrong = [];
      p.data.wrongBook = [];
      p.finish();
      assert.notStrictEqual(p.data.state, 'done', '书面阶段不该再弹自己的完成页');
      assert.strictEqual(scored, 0, '体验流程的口语段没有计时口径，不该污染成绩榜单');
      assert.deepStrictEqual(urls, ['/pkg-oral/pages/flow/flow?report=1'], '没回合并报告');
      var s = store['oral_flow_session'];
      assert.ok(s && s.drill, '书面结果没写进会话');
      assert.strictEqual(s.drill.total, 5);
      assert.strictEqual(s.drill.mastered, 5);
      assert.strictEqual(s.drill.allDone, true);
    } finally {
      global.wx.redirectTo = origRedirect;
      cloud.api.drillScore = origScore;
    }
  });

  await ok('⑨ 体验主流程页四件套齐、零联网、写明能力边界', function () {
    ['js', 'json', 'wxml', 'wxss'].forEach(function (e) {
      assert.ok(fs.existsSync(path.join(ROOT, 'miniprogram/pkg-oral/pages/flow/flow.' + e)),
        '缺 flow.' + e);
    });
    var j = read('miniprogram/pkg-oral/pages/flow/flow.js');
    ['wx.cloud', 'uploadFile', 'wx.request', 'callFunction'].forEach(function (k) {
      assert.strictEqual(j.indexOf(k), -1, 'flow.js 出现了联网能力 ' + k);
    });
    assert.ok(j.indexOf('不判断发音准不准') >= 0, '没写明本地完成度的能力边界');
    var app = JSON.parse(read('miniprogram/app.json'));
    var oral = (app.subpackages || []).filter(function (x) { return x.root === 'pkg-oral'; })[0];
    assert.ok(oral && oral.pages.indexOf('pages/flow/flow') >= 0, 'flow 页没登记进分包');
  });

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 项 ✓' +
    (fail ? '，' + fail + ' 项 ✗' : ''));
  process.exit(fail ? 1 : 0);
})();
