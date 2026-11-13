/**
 * 体验主流程（口语贯穿式）自检 —— node tests/oral-flow.test.js
 *
 * 2026-11-13 真机反馈后逐条用**页面桩真跑**，不做「只看源码字符串」的假自证：
 *   ① 带读：词 → 短句 → 小段，出现即主动发音，按住跟读，三档反馈，
 *      合格播既有正确提示音 + ✓ 庆祝 + 1 秒自动进下一条；
 *      不合格播错误提示音「再读一遍」，读满 3 遍给「可以跳过」出口（不自动放行）。
 *   ② 抬手后留 1.2 秒尾音缓冲：期间 loading、不结束录音，判定前裁掉缓冲静音。
 *   ③ 口语抽查：不给示范音，只考「自己读出来」，**体验页不另造选择题**，
 *      书面「认 / 写」全部交给现有 drill；错的再过一轮。
 *   ④ 报告：口语 + 书面合并，只练没读流畅的。
 *
 * 只 mock「设备能力」（录音 / 播放 / 音效 / 词库 / 隐私弹窗 / 时钟），
 * 评分器、编排逻辑、会话、素材全部用真实模块 —— 这样测的才是真链路。
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var pass = 0;
var fail = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    pass++; console.log('  ✓ ' + name);
  }).catch(function (e) {
    fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack : e));
  });
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function tick() { return new Promise(function (r) { setImmediate(r); }); }

/* ------------------------------ 运行时桩 ------------------------------ */

var store = {};
var toasts = [];
var urls = [];
var demoPlayed = [];
var denied = 0;
var sfxCalls = [];
var stopCalls = 0;
var holdMeta = null;
var holdOut = null;
var pendingRelease = null;

global.wx = {
  getStorageSync: function (k) { return store[k]; },
  setStorageSync: function (k, v) { store[k] = v; },
  removeStorageSync: function (k) { delete store[k]; },
  showToast: function (o) { toasts.push(o); },
  redirectTo: function (o) { urls.push(o.url); },
  setNavigationBarColor: function () {},
  createInnerAudioContext: function () {
    return { src: '', stop: function () {}, play: function () {} };
  }
};

/* 可控时钟：flow 页的「抬手缓冲 1200ms」和「庆祝后自动进条 1000ms」都要能真跑，
   又不能让测试真的等 2 秒。setImmediate 保持原生，Promise 微任务不受影响。 */
var timers = [];
var timerSeq = 0;
global.setTimeout = function (fn, ms) {
  var id = ++timerSeq;
  timers.push({ id: id, fn: fn, ms: ms || 0 });
  return id;
};
global.clearTimeout = function (id) {
  timers = timers.filter(function (t) { return t.id !== id; });
};
function flushTimers(ms) {
  var picked = timers.filter(function (t) { return ms === undefined || t.ms === ms; });
  timers = timers.filter(function (t) { return picked.indexOf(t) < 0; });
  picked.forEach(function (t) { t.fn(); });
  return picked.length;
}

/** 按住跟读：Promise 只在「缓冲到点、oral.stop()」时 resolve，和真机一致 */
var oralState = 'IDLE';
var resetCalls = 0;
var oralMock = {
  MAX_RETRY: 3,
  speak: function (w) { demoPlayed.push({ kind: 'word', word: w }); return true; },
  hasLocal: function () { return true; },
  startHold: function (meta) {
    holdMeta = meta;
    oralState = 'RECORDING';
    return new Promise(function (resolve) { pendingRelease = resolve; });
  },
  stop: function () {
    stopCalls++;
    oralState = 'IDLE';
    var r = pendingRelease;
    pendingRelease = null;
    if (r) r(holdOut || { frames: [], durationMs: 0, refText: '' });
    return Promise.resolve(true);
  },
  reset: function () {
    resetCalls++;
    oralState = 'IDLE';
    pendingRelease = null;
    return true;
  },
  cancelRecord: function () { return Promise.resolve(true); },
  stopPlay: function () {},
  errorText: function () { return '这条没录成，再试一次'; },
  getState: function () { return oralState; }
};
var audioMock = {
  play: function (src) { demoPlayed.push({ kind: 'audio', src: src }); return true; },
  stop: function () {}
};
var sfxMock = {
  playCorrect: function () { sfxCalls.push('correct'); },
  playWrong: function () { sfxCalls.push('wrong'); }
};
var WORDS = require('../miniprogram/data/words.js');
var booksMock = { getWords: function () { return WORDS; }, getKey: function () { return 'waiyan4a'; } };
var privacyMock = {
  onDenied: function () { denied++; },
  ensureRecord: function () { micEnsures++; return micAuth; }
};
var micEnsures = 0;
var micAuth = null;   // Promise；由用例按需设置

var MOD = {
  oral: path.join(ROOT, 'miniprogram/utils/oral.js'),
  audio: path.join(ROOT, 'miniprogram/utils/lesson-audio.js'),
  books: path.join(ROOT, 'miniprogram/utils/books.js'),
  privacy: path.join(ROOT, 'miniprogram/utils/privacy.js'),
  sfx: path.join(ROOT, 'miniprogram/utils/sfx.js')
};
var MOCKS = { oral: oralMock, audio: audioMock, books: booksMock, privacy: privacyMock, sfx: sfxMock };

function loadFlowPage() {
  var saved = {};
  Object.keys(MOD).forEach(function (k) {
    saved[k] = require.cache[MOD[k]];
    require.cache[MOD[k]] = {
      id: MOD[k], filename: MOD[k], loaded: true, exports: MOCKS[k]
    };
  });
  var file = path.join(ROOT, 'miniprogram/pkg-oral/pages/flow/flow.js');
  delete require.cache[file];
  var captured = null;
  var orig = global.Page;
  global.Page = function (def) { captured = def; };
  try { require(file); } finally {
    global.Page = orig;
    delete require.cache[file];
    Object.keys(MOD).forEach(function (k) {
      if (saved[k]) require.cache[MOD[k]] = saved[k];
      else delete require.cache[MOD[k]];
    });
  }
  assert.ok(captured, 'flow.js 没有注册 Page');
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

var def = loadFlowPage();
var lesson = require('../miniprogram/data/oral-lesson.js');
var flowLib = require('../miniprogram/utils/oral-flow.js');
var scorer = require('../miniprogram/utils/oral-score.js');

function fresh(options) {
  // 报告页是从 drill 回来的第二个实例，必须读到上一个实例留下的会话
  if (!options || options.report !== '1') {
    Object.keys(store).forEach(function (k) { delete store[k]; });
  }
  toasts.length = 0; urls.length = 0; demoPlayed.length = 0; sfxCalls.length = 0;
  timers = []; stopCalls = 0; holdOut = null; holdMeta = null;
  denied = 0; pendingRelease = null;
  oralState = 'IDLE'; resetCalls = 0;
  micEnsures = 0; micAuth = Promise.resolve(true);
  var p = makePage(def);
  p.onLoad(options || {});
  return p;
}

/** 造 PCM 帧：voiced 段有能量，tail 段静音 */
function frames(voicedMs, tailMs) {
  var out = [];
  var i;
  for (i = 0; i < voicedMs / 100; i++) out.push({ rms: 0.1, ms: 100 });
  for (i = 0; i < (tailMs || 0) / 100; i++) out.push({ rms: 0, ms: 100 });
  return out;
}
function goodOut(refText) {
  return { frames: frames(900, 0), durationMs: 900, refText: refText || 'clean' };
}
/** 长文本要用更长的发声时长，否则会被「读得太短」正确判成不合格 */
function goodOutFor(refText) {
  var ms = Math.ceil(scorer.expectMs(refText) * 0.8 / 100) * 100;
  return { frames: frames(ms, 0), durationMs: ms, refText: refText };
}
/** 抬手缓冲的真实形态：读完 + 1.2 秒静音尾巴 */
function goodOutWithTail(refText) {
  var ms = Math.ceil(scorer.expectMs(refText) * 0.8 / 100) * 100;
  return { frames: frames(ms, 1200), durationMs: ms + 1200, refText: refText };
}
function badOut(refText) {
  return { frames: frames(0, 400), durationMs: 400, refText: refText || 'clean' };
}

/** 一次完整的「按住 → 抬手 → 缓冲 → 评分」 */
async function holdOnce(p, out, checkMode) {
  holdOut = out;
  var before = stopCalls;
  if (checkMode) p.onQHoldStart(); else p.onHoldStart();
  assert.ok(pendingRelease, '没有起录');
  assert.strictEqual(p.data[checkMode ? 'qHolding' : 'holding'], true);
  if (checkMode) p.onQHoldEnd(); else p.onHoldEnd();
  assert.strictEqual(p.data[checkMode ? 'qSettling' : 'settling'], true, '抬手后要有 loading');
  assert.strictEqual(stopCalls, before, '缓冲期内不许立刻结束录音');
  assert.ok(flushTimers(1200) > 0, '没排 1.2 秒尾部缓冲');
  await tick(); await tick(); await tick();
  assert.strictEqual(p.data[checkMode ? 'qSettling' : 'settling'], false, '判定后 loading 要收掉');
}

/** 走完 9 条带读（每条合格都手动点下一条，自动进条的 timer 会被清掉） */
async function finishLead(p) {
  for (var i = 0; i < 9; i++) {
    await holdOnce(p, goodOutFor(p.data.item.refText));
    p.onNext();
  }
}

/** 抽查阶段答一题：bad=true 故意读砸 */
async function answerQuestion(p, bad) {
  var q = p.data.q;
  if (!q) return;
  await holdOnce(p, bad ? badOut(q.refText) : goodOutFor(q.refText), true);
  p.onQNext();
}

/* ---------------------------------------------------------------- */

(async function () {
  console.log('\n体验主流程（口语贯穿式）自检');

  /* ---------- 素材 ---------- */

  await ok('① 带读顺序是 词 → 短句 → 小段，共 9 条，逐级变长', function () {
    var items = lesson.buildItems();
    assert.strictEqual(items.length, 9);
    var kinds = items.map(function (x) { return x.kind; });
    assert.deepStrictEqual(kinds,
      ['word', 'word', 'word', 'word', 'sentence', 'sentence', 'sentence', 'sentence', 'segment']);
    assert.ok(items[8].lines.length >= 2 && items[8].lines.length <= 3, '小段必须 2~3 句');
    assert.ok(items[8].refText.length > items[4].refText.length, '小段要明显比短句长');
    items.forEach(function (x) {
      assert.ok(x.refText && x.display && x.cn, x.id + ' 缺文本');
    });
  });

  await ok('② 词走 454 个本地词级 mp3，句 / 段示范音全在新分包', function () {
    var items = lesson.buildItems();
    items.filter(function (x) { return x.kind === 'word'; }).forEach(function (x) {
      assert.strictEqual(x.audio, '', '词不该有句段音频');
      assert.ok(oralMock.hasLocal(x.word));
    });
    items.filter(function (x) { return x.kind !== 'word'; }).forEach(function (x) {
      assert.ok(x.audio.indexOf('/pkg-oral/assets/lesson/') === 0, '音频塞错分包：' + x.audio);
      assert.ok(x.audio.indexOf('pkg-media') < 0, 'pkg-media 只剩 22KB，不许再塞');
    });
  });

  /* ---------- 编排纯逻辑 ---------- */

  await ok('③ 抽查只考口语：5 题（4 词 + 1 短句），体验页不另造选择题', function () {
    var qs = flowLib.buildCheck(lesson.buildItems(), WORDS, 7);
    assert.strictEqual(qs.length, 5);
    assert.ok(qs.every(function (q) { return q.type === 'oral'; }), '出现非口语题');
    assert.strictEqual(qs.filter(function (q) { return q.kind === 'word'; }).length, 4);
    assert.strictEqual(qs.filter(function (q) { return q.kind === 'sentence'; }).length, 1);
    qs.forEach(function (q) {
      assert.deepStrictEqual(q.options, [], '不该带选项');
      assert.strictEqual(q.answer, '', '不该带答案');
      assert.ok(q.refText, '口语题要有参考文本');
    });
  });

  await ok('④ 源码与页面都不再有选择题；书面「认 / 写」全交给现有 drill', function () {
    var f = read('miniprogram/utils/oral-flow.js');
    var w = read('miniprogram/pkg-oral/pages/flow/flow.wxml');
    var j = read('miniprogram/pkg-oral/pages/flow/flow.js');
    ['meaningQuestion', "type: 'meaning'", "require('./quiz')"].forEach(function (k) {
      assert.ok(f.indexOf(k) < 0, 'oral-flow.js 仍留着选择题 ' + k);
    });
    ['onQOption', 'qSelected', '选出中文意思', 'q.options'].forEach(function (k) {
      assert.ok(w.indexOf(k) < 0, 'flow.wxml 仍渲染选择题 ' + k);
    });
    assert.ok(j.indexOf('onQOption') < 0, 'flow.js 仍处理选择题');
    assert.ok(j.indexOf("drill/drill?fromFlow=1") >= 0, '书面阶段必须接现有 drill');
  });

  await ok('⑤ 错题只重放一遍，最多两轮，不无限循环', function () {
    var qs = flowLib.buildCheck(lesson.buildItems(), WORDS, 7);
    var wrong = qs.slice(0, 2);
    var retry = flowLib.buildRetry(wrong, 11);
    assert.strictEqual(retry.length, 2);
    assert.notStrictEqual(retry[0].id, wrong[0].id, '重放要换 id，避免 wxml key 撞车');
    assert.strictEqual(flowLib.shouldRetry(wrong, 1), true);
    assert.strictEqual(flowLib.shouldRetry(wrong, 2), false);
    assert.strictEqual(flowLib.shouldRetry([], 1), false);
    assert.strictEqual(flowLib.CHECK_MAX_ROUNDS, 2);
  });

  await ok('⑥ 报告：三档统计、forced 留痕、待练清单只挑没完美的', function () {
    var traces = [
      { refText: 'clean', kind: 'word', grade: 'perfect', retry: 0, forced: false, honest: true, issues: [] },
      { refText: 'desk', kind: 'word', grade: 'ok', retry: 1, forced: false, honest: true, issues: [] },
      { refText: 'house', kind: 'word', grade: 'bad', retry: 3, forced: true, honest: true, issues: ['读得太短了'] },
      { refText: 'house', kind: 'word', grade: 'bad', retry: 3, forced: true, honest: true, issues: [] }
    ];
    var r = flowLib.mergeReport({ traces: traces, check: { total: 5, wrong: 1, rounds: 2 }, drill: null });
    assert.strictEqual(r.oral.total, 4);
    assert.strictEqual(r.oral.perfect, 1);
    assert.strictEqual(r.oral.ok, 1);
    assert.strictEqual(r.oral.bad, 2);
    assert.strictEqual(r.oral.forced, 2);
    assert.strictEqual(r.practice.length, 2, '按 refText 去重，perfect 的不进清单');
    assert.ok(r.practice[1].reason.indexOf('几次') >= 0, 'forced 要说清读了几次还不太顺');
    assert.strictEqual(r.allPerfect, false);
    assert.strictEqual(r.drill, null, '没走完背词也要能出报告');
  });

  await ok('⑦ 全完美口径：口语全流畅 + 抽查无错 + 书面全对才算', function () {
    var s = {
      traces: [{ refText: 'clean', kind: 'word', grade: 'perfect', forced: false, honest: true }],
      check: { total: 5, wrong: 0, rounds: 1 },
      drill: { total: 10, mastered: 10, allDone: true }
    };
    assert.strictEqual(flowLib.mergeReport(s).allPerfect, true);
    s.drill.allDone = false;
    assert.strictEqual(flowLib.mergeReport(s).allPerfect, false);
    s.drill.allDone = true; s.check.wrong = 1;
    assert.strictEqual(flowLib.mergeReport(s).allPerfect, false);
  });

  await ok('⑧ 跨页会话只存文本，setDrillResult 不冲掉口语留痕', function () {
    flowLib.clear();
    flowLib.save({ traces: [{ refText: 'clean', grade: 'ok' }], check: { total: 5, wrong: 0 }, drill: null });
    flowLib.setDrillResult({ total: 10, mastered: 9, seconds: 90, elapsedText: '1 分 30 秒', allDone: false });
    var s = flowLib.load();
    assert.strictEqual(s.traces.length, 1, '书面结果不能把口语留痕冲掉');
    assert.strictEqual(s.drill.mastered, 9);
    assert.strictEqual(store[flowLib.SESSION_KEY], s, '会话要落本机 storage 才能跨页面栈');
    flowLib.clear();
    assert.strictEqual(flowLib.load(), null);
  });

  /* ---------- 页面桩：① 带读 ---------- */

  await ok('⑨ 进页面就停在第一个词，且主动先发一次示范音', function () {
    var p = fresh();
    assert.strictEqual(p.data.stage, 'lead');
    assert.strictEqual(p.data.item.kind, 'word');
    assert.strictEqual(p.data.item.display, 'clean');
    assert.strictEqual(p.data.total, 9);
    assert.strictEqual(demoPlayed.length, 1, '出现即主动发音，不能等用户点');
    assert.strictEqual(demoPlayed[0].kind, 'word');
    assert.strictEqual(p.data.demoPlayed, true);
    assert.strictEqual(p.data.settling, false);
    assert.ok(p.data.honestTip.indexOf('不判断发音准不准') >= 0);
  });

  await ok('⑩ 短句 / 小段出现时自动播离线合成音，不再用词级 mp3', function () {
    var p = fresh();
    for (var i = 0; i < 4; i++) {
      p.onSkipItem();
      p.onNext();
    }
    assert.strictEqual(p.data.item.kind, 'sentence');
    var n = demoPlayed.length;
    assert.strictEqual(demoPlayed[n - 1].kind, 'audio');
    assert.ok(demoPlayed[n - 1].src.indexOf('/pkg-oral/assets/lesson/') === 0);
  });

  await ok('⑪ 不合格播错误音不放行；读满 3 遍提示「可以跳过」，不自动放行', async function () {
    var p = fresh();
    sfxCalls.length = 0;
    for (var i = 0; i < 3; i++) {
      await holdOnce(p, badOut());
      assert.strictEqual(p.data.passed, false, '第 ' + (i + 1) + ' 次不该放行');
      assert.strictEqual(p.data.retry, i + 1);
      assert.strictEqual(p.data.holding, false, '松手后按钮要还回去');
      var idxBefore = p.data.idx;
      p.onNext();
      assert.strictEqual(p.data.idx, idxBefore, '不合格时「下一个」必须在方法层也拦住');
    }
    assert.strictEqual(p.data.passed, false, '3 遍不对不该自动放行');
    assert.strictEqual(p.data.canSkip, true, '要提示可以跳过');
    assert.ok(p.data.feedback.verdict.indexOf('可以跳过') >= 0);
    assert.deepStrictEqual(sfxCalls, ['wrong', 'wrong', 'wrong'], '错误要播既有错误提示音');
    assert.strictEqual(p._traces.length, 0, '没过之前不写留痕');
    p.onSkipItem();
    assert.strictEqual(p.data.passed, true, '跳过也能走，不许卡死');
    assert.strictEqual(p._traces.length, 1);
    assert.strictEqual(p._traces[0].forced, true, '跳过要进报告待练清单');
    assert.strictEqual(p._traces[0].grade, 'bad');
    assert.strictEqual(holdMeta.ref_text, 'clean', '录音层要拿到参考文本');
  });

  await ok('⑫ 合格播既有正确音 + ✓ 庆祝；没到 3 遍停下来问，读够 3 遍才自动跳', async function () {
    var p = fresh();
    sfxCalls.length = 0;
    await holdOnce(p, goodOut());
    assert.notStrictEqual(p.data.feedback.grade, 'bad');
    assert.strictEqual(p.data.passed, true);
    assert.deepStrictEqual(sfxCalls, ['correct'], '合格要播既有正确提示音');
    assert.strictEqual(p.data.celebrate, true);
    assert.ok(flushTimers(1200) > 0, '✓ 层要自己收起');
    assert.strictEqual(p.data.celebrate, false, '全屏遮罩不能一直压着「下一个」按钮');
    assert.strictEqual(p.data.canSkip, false);
    assert.strictEqual(p.data.autoNext, false, '第 1 遍就过，先停一下问一句');
    assert.strictEqual(flushTimers(1000), 0, '没到 3 遍不该自动跳走');
    assert.strictEqual(p.data.idx, 0, '判定完先停一下庆祝，不立刻跳');
    p.onNext();
    assert.strictEqual(p.data.idx, 1);
    assert.strictEqual(p.data.item.display, 'desk');
    assert.strictEqual(p.data.celebrate, false, '切条目后庆祝层要收掉');
    p.onSkipItem();
    assert.strictEqual(p.data.passed, true);
    assert.strictEqual(p._traces[1].forced, true);
    assert.strictEqual(p._traces[1].issues[0], '这次先跳过');

    // 同一个词读到第 3 遍才过：不再多问，1 秒后自己跳
    var q = fresh();
    await holdOnce(q, badOut());
    await holdOnce(q, badOut());
    await holdOnce(q, goodOut());
    assert.strictEqual(q._traces[0].retry, 2, '前两遍没过，第 3 遍才过');
    assert.strictEqual(q.data.autoNext, true, '读够 3 遍不该再让孩子多点一下');
    assert.ok(flushTimers(1000) > 0, '读够 3 遍要自动进下一条');
    assert.strictEqual(q.data.idx, 1);
  });

  await ok('⑬ 麦克风被拒：给明确提示、能立刻跳过，不留死状态', async function () {
    var p = fresh();
    var orig = oralMock.startHold;
    oralMock.startHold = function () { return Promise.reject(new Error('MIC_DENIED')); };
    try {
      p.onHoldStart();
      await tick(); await tick();
      assert.strictEqual(p.data.holding, false);
      assert.strictEqual(p.data.settling, false);
      assert.strictEqual(p.data.canSkip, true, '没麦克风也要给出跳过出口');
      assert.ok(p.data.tip.indexOf('麦克风') >= 0, '要给一句人话提示');
      assert.strictEqual(denied, 1, '要引导去授权设置');
      p.onSkipItem();
      assert.strictEqual(p.data.passed, true);
    } finally { oralMock.startHold = orig; }
  });

  await ok('㉓ 抬手后留 1~2 秒尾音缓冲：loading、不立刻收尾，判定前裁掉缓冲静音', async function () {
    var p = fresh();
    sfxCalls.length = 0;
    holdOut = goodOutWithTail('clean');
    p.onHoldStart();
    assert.ok(pendingRelease, '没有起录');
    p.onHoldEnd();
    assert.strictEqual(p.data.holding, false);
    assert.strictEqual(p.data.settling, true);
    assert.ok(p.data.tip.indexOf('在听你读完') >= 0, 'loading 要给人看得见');
    assert.strictEqual(stopCalls, 0, '缓冲期内不许结束录音');
    assert.ok(read('miniprogram/pkg-oral/pages/flow/flow.wxml').indexOf('在听你读完') >= 0);
    assert.ok(flushTimers(1200) > 0, '没排 1.2 秒缓冲');
    assert.strictEqual(stopCalls, 1, '缓冲到点才收尾');
    await tick(); await tick(); await tick();
    assert.strictEqual(p.data.passed, true, '带 1.2 秒静音尾巴仍应判合格');
    assert.strictEqual(p.data.settling, false);
    assert.deepStrictEqual(sfxCalls, ['correct'], '尾部静音不该把读完的一遍判成错误');
  });

  /* ---------- 页面桩：② 抽查 ---------- */

  await ok('⑭ 带读 9 条走完自动进口语抽查（5 题），抽查不播示范音', async function () {
    var p = fresh();
    await finishLead(p);
    assert.strictEqual(p.data.stage, 'check');
    assert.strictEqual(p.data.qTotal, 5);
    var before = demoPlayed.length;
    p.showQuestion();
    assert.strictEqual(demoPlayed.length, before, '抽查不给示范音，考的是自己能不能读出来');
    assert.strictEqual(p.data.q.type, 'oral');
  });

  await ok('⑮ 抽查口语题走同一评分器，读砸的题进错题再过一遍，然后直接上背词', async function () {
    var p = fresh();
    await finishLead(p);
    var guard = 0;
    while (p.data.stage === 'check' && guard++ < 40) {
      await answerQuestion(p, true);      // 全部故意读砸
    }
    assert.ok(guard < 40, '抽查没收敛，可能无限循环');
    assert.strictEqual(p.data.stage, 'drill', '抽查结束要切到背词过渡态');
    assert.deepStrictEqual(urls, ['/pkg-media/pages/drill/drill?fromFlow=1'],
      '抽查结束要直接上现有背词');
    var s = flowLib.load();
    assert.ok(s && s.traces.length > 9, '抽查的口语题也要留痕进报告');
    assert.ok(s.check.wrong > 0, '错题数要进报告');
  });

  await ok('⑯ 抽查有错题时先「再过一遍」，第二轮才进背词', async function () {
    var p = fresh();
    await finishLead(p);
    var rounds = [];
    var guard = 0;
    while (p.data.stage === 'check' && guard++ < 40) {
      rounds.push(p.data.checkRound);
      await answerQuestion(p, true);
    }
    assert.ok(rounds.indexOf(1) >= 0 && rounds.indexOf(2) >= 0, '应该出现两轮');
    assert.ok(toasts.some(function (t) { return String(t.title).indexOf('再过一遍') >= 0; }));
  });

  await ok('㉔ 抽查判定也用同一套提示音，读砸不卡住、进第二轮再过', async function () {
    var p = fresh();
    await finishLead(p);
    sfxCalls.length = 0;
    await holdOnce(p, badOut(p.data.q.refText), true);
    assert.ok(sfxCalls.indexOf('wrong') >= 0, '读砸要播既有错误提示音');
    assert.strictEqual(p.data.qPassed, true, '抽查一遍过，不让孩子卡在一题');
    assert.strictEqual(p.data.qFeedback.grade, 'bad');
    assert.ok(p._wrong.length > 0, '读砸的题要进错题，最后再过一遍');
    p.onQNext();
    assert.strictEqual(p.data.qIdx, 1);
  });

  /* ---------- 页面桩：④ 报告 ---------- */

  await ok('⑰ ?report=1 出合并报告：口语、抽查、书面三段都在', function () {
    flowLib.clear();
    flowLib.save({
      traces: [
        { refText: 'clean', kind: 'word', grade: 'perfect', forced: false, honest: true, issues: [] },
        { refText: 'desk', kind: 'word', grade: 'bad', forced: true, honest: true, issues: [] }
      ],
      check: { total: 5, wrong: 1, rounds: 2 },
      drill: { total: 10, mastered: 9, seconds: 90, elapsedText: '1 分 30 秒', allDone: false }
    });
    var p = fresh({ report: '1' });
    assert.strictEqual(p.data.stage, 'report');
    assert.strictEqual(p.data.report.oral.total, 2);
    assert.strictEqual(p.data.report.oral.forced, 1);
    assert.strictEqual(p.data.report.drill.mastered, 9);
    assert.strictEqual(p.data.report.check.wrong, 1);
    assert.strictEqual(p.data.report.practice.length, 1);
    assert.strictEqual(p.data.report.allPerfect, false);
  });

  await ok('⑱ 「只练没读流畅的」只重练非完美条目，且不重跑书面背词', function () {
    flowLib.clear();
    flowLib.save({
      traces: [
        { refText: 'clean', kind: 'word', grade: 'perfect', forced: false, honest: true, issues: [] },
        { refText: 'desk', kind: 'word', grade: 'bad', forced: true, honest: true, issues: [] },
        { refText: 'tidy', kind: 'word', grade: 'ok', forced: false, honest: true, issues: [] }
      ],
      check: { total: 5, wrong: 1, rounds: 2 },
      drill: { total: 10, mastered: 9, allDone: false }
    });
    var p = fresh({ report: '1' });
    p.onPractice();
    assert.strictEqual(p.data.stage, 'lead');
    assert.strictEqual(p.data.total, 2, '只挑 desk / tidy');
    assert.strictEqual(p.data.item.display, 'desk');
    assert.strictEqual(p._practiceOnly, true);
    assert.strictEqual(p._traces.length, 1, '已完美的 clean 要留着');
    assert.strictEqual(p._traces[0].grade, 'perfect');
    var s = flowLib.load();
    assert.strictEqual(s.drill.mastered, 9, '重练口语不该抹掉上次的书面成绩');
  });

  await ok('⑲ 会话为空也能出报告，不崩', function () {
    flowLib.clear();
    var p = fresh({ report: '1' });
    assert.strictEqual(p.data.stage, 'report');
    assert.strictEqual(p.data.report.oral.total, 0);
    assert.strictEqual(p.data.report.drill, null);
  });

  /* ---------- 源码红线 ---------- */

  await ok('⑳ 源码红线：零联网、零落盘录音、不碰打卡与 SRS', function () {
    var j = read('miniprogram/pkg-oral/pages/flow/flow.js');
    ['wx.cloud', 'uploadFile', 'wx.request', 'callFunction',
      'activity_log', 'checkin', 'setStorageSync'].forEach(function (k) {
      assert.strictEqual(j.indexOf(k), -1, 'flow.js 出现了 ' + k);
    });
    assert.ok(j.indexOf('oral.startHold') >= 0, '必须走按住跟读专用通道');
    assert.ok(j.indexOf('oral.start(') < 0, '不许写进 12 条录音索引');
    assert.ok(j.indexOf('scorer.score') >= 0, '必须走可插拔评分器');
    var a = read('miniprogram/utils/lesson-audio.js');
    ['wx.cloud', 'wx.request', 'callFunction'].forEach(function (k) {
      assert.strictEqual(a.indexOf(k), -1, 'lesson-audio.js 出现了 ' + k);
    });
  });

  await ok('㉑ 可插拔契约：换成远端引擎后页面判定的代码路径一字不改', function () {
    var injected = scorer.register('test-soe', function () {
      return {
        grade: 'perfect', scores: { accuracy: 92 }, issues: [], engine: 'test-soe',
        verdict: '读得很流畅', honest: false, expectMs: 0
      };
    });
    assert.strictEqual(injected, true);
    assert.strictEqual(scorer.use('test-soe'), true);
    var r = scorer.score({ frames: [], durationMs: 0, refText: 'clean' });
    assert.strictEqual(r.grade, 'perfect');
    assert.strictEqual(r.honest, false, '真评分引擎不能再挂 honest 完成度口径');
    assert.strictEqual(scorer.shouldPass(r, 0), true);
    assert.deepStrictEqual(scorer.normalizeRemote({ PronAccuracy: 71 }).grade, 'ok');
    assert.strictEqual(scorer.use('local'), true);
    assert.strictEqual(scorer.engineName(), 'local');
  });

  await ok('㉒ 句 / 段示范音与素材一一对应，且真在包里（Piper 离线合成）', function () {
    var items = lesson.buildItems().filter(function (x) { return !!x.audio; });
    assert.strictEqual(items.length, 5, '4 个短句 + 1 个小段');
    var bytes = 0;
    items.forEach(function (x) {
      var f = path.join(ROOT, 'miniprogram', x.audio.replace(/^\//, ''));
      assert.ok(fs.existsSync(f), '缺示范音 ' + x.audio + '（跑 scripts/gen_lesson_audio.py）');
      var size = fs.statSync(f).size;
      assert.ok(size > 1000, x.audio + ' 只有 ' + size + ' 字节，可能是空音频');
      bytes += size;
    });
    assert.ok(bytes < 200 * 1024, '体验课音频 ' + Math.round(bytes / 1024) +
      'KB，长篇文章不是本期范围，别往体验包里塞');
  });

  await ok('㉕ 按住用 catch 手势防滚动串扰；UI 复用既有进度条 / 按钮 / 庆祝层', function () {
    var w = read('miniprogram/pkg-oral/pages/flow/flow.wxml');
    var c = read('miniprogram/pkg-oral/pages/flow/flow.wxss');
    var j = read('miniprogram/pkg-oral/pages/flow/flow.js');
    ['catchtouchstart', 'catchtouchend', 'catchtouchcancel', 'catchtouchmove'].forEach(function (k) {
      assert.strictEqual((w.match(new RegExp(k, 'g')) || []).length, 2,
        '两个按住按钮都要用 ' + k + '，少一个就会被页面滚动抢走手势');
    });
    assert.ok(w.indexOf('bindtouchstart') < 0, 'bind 手势会在真机上被滚动打断');
    assert.ok(w.indexOf('onHoldMove') >= 0 && w.indexOf('onQHoldMove') >= 0,
      'catchtouchmove 要有对应方法，按住时页面不许滚');
    ['class="progress', 'class="btn ok mt"', 'class="celebrate"', '{{skin}}'].forEach(function (k) {
      assert.ok(w.indexOf(k) >= 0, 'UI 没跟既有风格对齐：' + k);
    });
    assert.ok(c.indexOf('.qword') >= 0 && c.indexOf('.celebrate-pop') >= 0 && c.indexOf('var(--') >= 0);
    assert.ok(j.indexOf("require('../../../utils/sfx')") >= 0, '没复用既有提示音模块');
    assert.ok(j.indexOf('sfx.playCorrect') >= 0 && j.indexOf('sfx.playWrong') >= 0);
    assert.ok(j.indexOf('TAIL_MS = 1200') >= 0 && j.indexOf('trimTailSilence') >= 0);
    assert.ok(w.indexOf('不落盘') >= 0 && w.indexOf('不上传') >= 0, '隐私说明要留在页面上');
  });

  await ok('㉖ 息屏 / 切后台回来：状态复位，按住还能用（原先 _active 再也不回来）', async function () {
    var p = fresh();
    await holdOnce(p, goodOut());
    p.onNext();
    p.onHide();                       // 手机息屏
    oralState = 'RECORDING';          // 最坏情况：录音状态没等到 onStop
    p.onShow();                       // 点亮屏幕
    assert.strictEqual(p._active, true, 'onShow 必须把 active 还回去，否则所有手势被方法层挡掉');
    assert.strictEqual(p.data.holding, false);
    assert.strictEqual(p.data.settling, false);
    assert.ok(resetCalls >= 1, '残留的 RECORDING 要强制复位，不然每次按住都被 BUSY 拒绝');
    await holdOnce(p, goodOut());
    assert.strictEqual(p.data.passed, true, '回来之后按钮必须还能按');
  });

  await ok('㉗ 抬手缓冲里点跳过也要立刻生效，不许按了没反应', async function () {
    var p = fresh();
    p.onHoldStart();
    p.onHoldEnd();
    assert.strictEqual(p.data.settling, true);
    p.onSkipItem();                       // 旧版在这里被 settling 直接 return，看起来就是死键
    assert.strictEqual(p.data.passed, true);
    assert.strictEqual(p.data.settling, false);
    assert.strictEqual(p._traces.length, 1);
    assert.strictEqual(p._traces[0].forced, true);
    await tick(); await tick();
    assert.strictEqual(p._traces.length, 1, '跳过后迟到的判定不能再记一条');
    assert.strictEqual(p.data.idx, 0, '仍然停在当前条目，等孩子点下一个');
  });

  await ok('㉘ 第一次进小程序先授权、这一下不进入录音，也不会把按钮挂死', async function () {
    var p = fresh();
    p._micReady = false;                 // syncMicReady 查到还没授权
    p.onHoldStart();
    assert.strictEqual(p.data.holding, false, '授权那一下不该进入录音（弹窗会吃掉 touchend）');
    assert.strictEqual(micEnsures, 0, '按住时先不弹窗，等抬手（微信要求 tap 触发隐私弹窗）');
    p.onHoldEnd();                        // 抬手才触发授权
    assert.strictEqual(micEnsures, 1, '要走统一授权入口');
    assert.strictEqual(pendingRelease, null, '没起录，就不会有悬空的 Promise');
    await tick(); await tick();
    assert.strictEqual(p._micReady, true);
    assert.ok(p.data.tip.indexOf('按住按钮读') >= 0, '要告诉孩子现在可以按住读了');
    await holdOnce(p, goodOut());         // 授权后立刻能按住
    assert.strictEqual(p.data.passed, true);
  });

  await ok('㉙ 不再有「点一下开始、再点结束」的假开关', function () {
    var w = read('miniprogram/pkg-oral/pages/flow/flow.wxml');
    var j = read('miniprogram/pkg-oral/pages/flow/flow.js');
    ['点一下开始', '点这里结束', 'onTapHold', 'onQTapHold'].forEach(function (k) {
      assert.ok(w.indexOf(k) < 0 && j.indexOf(k) < 0, '又把这个假开关加回来了：' + k);
    });
  });

  await ok('㉚ 源码：onShow 恢复 active、残留录音强制复位，跳过不被缓冲挡住', function () {
    var j = read('miniprogram/pkg-oral/pages/flow/flow.js');
    assert.ok(/onShow:[\s\S]{0,600}this\._active = true/.test(j), 'onShow 没恢复 active');
    assert.ok(/onShow:[\s\S]{0,900}oral\.reset\(\)/.test(j), 'onShow 没强制复位录音状态');
    assert.ok(j.indexOf("this._micReady === false") >= 0, '起录前没确认麦克风可用');
    assert.ok(j.indexOf('this._holdGen') >= 0, '缺「迟到判定作废」的代际标记');
  });

  await ok('㉛ 切后台打断自动进条的计时器，回来要自己接上，不许卡在「马上到下一个…」', async function () {
    var p = fresh();
    await holdOnce(p, badOut());
    await holdOnce(p, badOut());
    await holdOnce(p, goodOut());
    assert.strictEqual(p.data.autoNext, true);
    p.onHide();                       // 1 秒计时器被 _clearTimers 清掉
    p.onShow();
    assert.ok(flushTimers(1000) > 0, '回来要重新排上自动进条');
    assert.strictEqual(p.data.idx, 1);
  });

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 项 ✓' +
    (fail ? '，' + fail + ' 项 ✗' : ''));
  process.exit(fail ? 1 : 0);
})();
