/**
 * 第 0 步「开口读」接入背词主流程的编排测试
 *
 *   node tests/oral-gate.test.js
 *
 * 2026-11-12 更新：用户实锤「现在不太行」，口语从前置闸门改成贯穿全程的题型。
 * 主入口（首页 / 底栏）已改道 pkg-oral/pages/flow/flow，本文件现在锁的是：
 *   ① ?oral=1 旧闸门作为**兼容路径**仍在，且不带开关时 drill 一字不变
 *      （40+ 条 drill-flow 断言的前提，也保证班级作业等入口不受影响）
 *   ② 读了 / 跳过 / 录音失败，三条路都必须回到 recog，绝不卡死
 *   ③ 口语关不许写 activity_log / checkin —— 它不是另一项打卡作业
 *   ④ 新链路的入口与跨页交接：flow → drill?fromFlow=1 → flow?report=1
 *
 * 新流程各阶段的行为另见 tests/oral-flow.test.js（页面桩逐条自证）。
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
  // 故意不提供 getRecorderManager / getSetting / getPrivacySetting：
  // 让录音走「不支持录音」的失败分支，专门验证兜底不卡死。
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
  console.log('\n第 0 步「开口读」流程编排测试');

  await ok('① 带 ?oral=1：先停在口语关，还没出认的题', function () {
    var p = fresh({ oral: '1' });
    assert.strictEqual(p.data.state, 'oral', '应该先到第 0 步，实际 ' + p.data.state);
    assert.strictEqual(p.data.q, null, '口语关不该同时出题');
    assert.strictEqual(p.data.gateWords.length, 2, '本轮 2 个词都该列出来');
    assert.ok(p.data.gateRefText.indexOf('train') >= 0 && p.data.gateRefText.indexOf('jump') >= 0,
      '录音参照文本应是本轮词表');
    assert.ok(p.data.stepText.indexOf('第 0 步') >= 0, '进度文案要标明第 0 步');
  });

  await ok('② 不带开关：仍是原来的第 1 步「认」（旧入口与 drill-flow 断言不受影响）', function () {
    var p = fresh({});
    assert.strictEqual(p.data.state, 'run');
    assert.strictEqual(p.data.phase, 'recog');
    assert.strictEqual(p.data.q.type, 'binary');
  });

  await ok('③ 点「读好了」→ 回到原来的第 1 步「认」', function () {
    var p = fresh({ oral: '1' });
    p.onGateDone();
    assert.strictEqual(p.data.state, 'run');
    assert.strictEqual(p.data.phase, 'recog', '口语之后必须接认，不是写');
    assert.strictEqual(p.data.q.type, 'binary', '第 1 题仍是听看二选一');
  });

  await ok('④ 点「这次先不读」→ 同样回到「认」，跳过不卡死', function () {
    var p = fresh({ oral: '1' });
    p.onGateSkip();
    assert.strictEqual(p.data.state, 'run');
    assert.strictEqual(p.data.phase, 'recog');
    assert.strictEqual(p._oralDone, true, '跳过后要记住本轮已过口语关');
  });

  await ok('⑤ 录音失败（不支持录音/拒绝授权）后仍能跳过进「认」', async function () {
    var p = fresh({ oral: '1' });
    p.onGateRecord();
    await tick(); await tick(); await tick();
    assert.strictEqual(p.data.gateRecording, false, '失败后按钮必须还回「录一遍」');
    assert.ok(p.data.gateTip && p.data.gateTip.length > 0, '失败要给人话提示，不能静默');
    p.onGateSkip();
    assert.strictEqual(p.data.phase, 'recog', '授权失败绝不能把孩子卡在口语关');
  });

  await ok('⑥ 口语关不写打卡：activity_log 不被污染', function () {
    var p = fresh({ oral: '1' });
    assert.strictEqual(store['activity_log'], undefined, '只是读一遍，不该算完成了一个词');
    p.onGateDone();
    assert.strictEqual(store['activity_log'], undefined, '进认之后仍未答题，也不该计数');
  });

  await ok('⑦ 源码：主入口已改道体验主流程；?oral=1 只剩兼容开关', function () {
    var idx = read('miniprogram/pages/index/index.js');
    var nav = read('miniprogram/components/footer-nav/index.js');
    var drill = read('miniprogram/pkg-media/pages/drill/drill.js');
    assert.ok(/goStudy:[\s\S]{0,500}pkg-oral\/pages\/flow\/flow/.test(idx),
      '首页「开始背单词」没进体验主流程');
    assert.ok(nav.indexOf("path: '/pkg-oral/pages/flow/flow'") >= 0, '底栏「背词」没跟上');
    assert.ok(nav.indexOf("path.split('?')[0]") >= 0,
      'path 带 query 后，onGo 必须剥掉再比 route，否则会无限 redirect');
    assert.ok(drill.indexOf("options.oral === '1'") >= 0, '旧闸门的兼容开关不该被顺手删掉');
  });

  await ok('⑧ 源码：drill 的取词分支统一走 begin()，onAgain 不重进口语关', function () {
    var js = read('miniprogram/pkg-media/pages/drill/drill.js');
    assert.ok(/\bbegin: function\b/.test(js) && /\bafterOral: function\b/.test(js), '缺编排入口');
    var begins = (js.match(/\b(?:this|self)\.begin\(/g) || []).length;
    assert.ok(begins >= 4, '4 条取词分支（作业/云端/断网/本机快照）都要过 begin，实际 ' + begins);
    assert.ok(js.indexOf("options.oral === '1'") >= 0, '开关必须显式，不能默认全开');
    assert.ok(/onAgain[\s\S]{0,300}startRound\(left, 'recog'\)/.test(js),
      '「再来一轮」不该又把孩子踢回口语关');
    // 只盯真正的写入语句：注释里「不写 activity_log」这句说明不算污染，
    // 但 setStorageSync('activity_log', …) 一旦冒出来就必须红。
    var gateBlock = js.slice(js.indexOf('第 0 步：开口读'), js.indexOf('/* ---------------- 轮次'));
    assert.ok(!/setStorageSync\(\s*['"]activity_log['"]/.test(gateBlock),
      '口语关代码不许写 activity_log');
  });

  await ok('⑨ 页面：口语关有完成与跳过两个出口，且样式全走 token', function () {
    var w = read('miniprogram/pkg-media/pages/drill/drill.wxml');
    var s = read('miniprogram/pkg-media/pages/drill/drill.wxss');
    assert.ok(w.indexOf("state === 'oral'") >= 0, '缺口语关渲染分支');
    assert.ok(w.indexOf('读好了，开始背') >= 0 && w.indexOf('这次先不读，直接开始') >= 0,
      '两个出口缺一，孩子可能被卡死');
    assert.ok(w.indexOf('onGateSpeak') >= 0 && w.indexOf('onGateRecord') >= 0, '缺听标准音 / 录音入口');
    var gateCss = s.slice(s.indexOf('.gate-card'));
    assert.ok(gateCss.indexOf('var(--') >= 0, '样式要走皮肤 token');
    assert.ok(!/#[0-9a-fA-F]{3,6}/.test(gateCss), '口语关样式不许硬编码颜色（换肤会出现深色孤岛）');
  });

  await ok('⑩ 从 flow 拉起的书面阶段：交结果、回合并报告，不弹完成页也不上榜', function () {
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

  await ok('⑪ 体验主流程页四件套齐、零联网、写明能力边界', function () {
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
