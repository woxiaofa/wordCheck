/**
 * 体验主流程（口语贯穿式）自检 —— node tests/oral-flow.test.js
 *
 * 用户 2026-11-12 原话落成的四阶段，逐条用**页面桩真跑**，不做「只看源码字符串」的假自证：
 *   ① 带读：词 → 短句 → 小段，出现即主动发音，按住跟读，三档反馈，
 *      合格才下一条，重读满 3 次强制放行且留痕；
 *   ② 抽查：口语题不给示范音，与「认」题混排；错的再过一轮；
 *   ③ 背词：把书面阶段交给现有 drill（fromFlow=1）；
 *   ④ 报告：口语 + 书面合并，只练没读流畅的。
 *
 * 只 mock「设备能力」（录音 / 播放 / 词库 / 隐私弹窗），
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

/** 按住跟读：Promise 只在「松手」时 resolve，和真机一致 */
var pendingRelease = null;
var holdMeta = null;
var oralMock = {
  MAX_RETRY: 3,
  speak: function (w) { demoPlayed.push({ kind: 'word', word: w }); return true; },
  hasLocal: function () { return true; },
  startHold: function (meta) {
    holdMeta = meta;
    return new Promise(function (resolve) { pendingRelease = resolve; });
  },
  stop: function () { return Promise.resolve(true); },
  cancelRecord: function () { return Promise.resolve(true); },
  stopPlay: function () {},
  errorText: function () { return '这条没录成，再试一次'; },
  getState: function () { return 'IDLE'; }
};
var audioMock = {
  play: function (src) { demoPlayed.push({ kind: 'audio', src: src }); return true; },
  stop: function () {}
};
var WORDS = require('../miniprogram/data/words.js');
var booksMock = { getWords: function () { return WORDS; }, getKey: function () { return 'waiyan4a'; } };
var privacyMock = { onDenied: function () { denied++; } };

var MOD = {
  oral: path.join(ROOT, 'miniprogram/utils/oral.js'),
  audio: path.join(ROOT, 'miniprogram/utils/lesson-audio.js'),
  books: path.join(ROOT, 'miniprogram/utils/books.js'),
  privacy: path.join(ROOT, 'miniprogram/utils/privacy.js')
};
var MOCKS = { oral: oralMock, audio: audioMock, books: booksMock, privacy: privacyMock };

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
  toasts.length = 0; urls.length = 0; demoPlayed.length = 0;
  denied = 0; pendingRelease = null; holdMeta = null;
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
function badOut(refText) {
  return { frames: frames(0, 400), durationMs: 400, refText: refText || 'clean' };
}
function longPauseOut(refText) {
  return { frames: frames(900, 1600), durationMs: 2500, refText: refText || 'clean' };
}

/** 一次完整的「按住 → 松手 → 评分」 */
async function holdOnce(p, out, checkMode) {
  if (checkMode) p.onQHoldStart(); else p.onHoldStart();
  if (checkMode) p.onQHoldEnd(); else p.onHoldEnd();
  assert.ok(pendingRelease, '没有起录');
  var r = pendingRelease;
  pendingRelease = null;
  r(out);
  await tick(); await tick();
}

/** 抽查阶段答一题：bad=true 故意读砸 / 选错 */
async function answerQuestion(p, bad) {
  var q = p.data.q;
  if (!q) return;
  if (q.type === 'oral') {
    await holdOnce(p, bad ? badOut(q.refText) : goodOut(q.refText), true);
  } else {
    var wrong = q.options.filter(function (x) { return x !== q.answer; })[0];
    p.onQOption({ currentTarget: { dataset: { value: bad ? wrong : q.answer } } });
  }
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

  await ok('③ 抽查题是「读」与「认」混排，且两类都出现', function () {
    var qs = flowLib.buildCheck(lesson.buildItems(), WORDS, 7);
    assert.strictEqual(qs.length, 7);
    var oral = qs.filter(function (q) { return q.type === 'oral'; });
    var meaning = qs.filter(function (q) { return q.type === 'meaning'; });
    assert.strictEqual(oral.length, 4, '3 个词 + 1 个短句要自己读');
    assert.strictEqual(meaning.length, 3);
    assert.ok(qs.some(function (q, i) { return i > 0 && q.type !== qs[i - 1].type; }),
      '两类题必须交错，不能先全读完再全认');
  });

  await ok('④ 「认」题三选一，正确答案有且只有一个', function () {
    var qs = flowLib.buildCheck(lesson.buildItems(), WORDS, 7);
    qs.filter(function (q) { return q.type === 'meaning'; }).forEach(function (q) {
      assert.strictEqual(q.options.length, 3);
      assert.strictEqual(q.options.filter(function (o) { return o === q.answer; }).length, 1,
        '出现双正确答案或没答案');
    });
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
    var r = flowLib.mergeReport({ traces: traces, check: { total: 7, wrong: 1, rounds: 2 }, drill: null });
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
      check: { total: 7, wrong: 0, rounds: 1 },
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
    flowLib.save({ traces: [{ refText: 'clean', grade: 'ok' }], check: { total: 7, wrong: 0 }, drill: null });
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

  await ok('⑪ 按住跟读 → 不合格不放行、retry 递增，读满 3 次强制放行并留痕', async function () {
    var p = fresh();
    for (var i = 0; i < 4; i++) {
      await holdOnce(p, badOut());
      if (i < 3) {
        assert.strictEqual(p.data.passed, false, '第 ' + (i + 1) + ' 次不该放行');
        assert.strictEqual(p.data.retry, i + 1);
        assert.strictEqual(p.data.holding, false, '松手后按钮要还回去');
        var idxBefore = p.data.idx;
        p.onNext();
        assert.strictEqual(p.data.idx, idxBefore, '不合格时「下一个」必须在方法层也拦住');
      }
    }
    assert.strictEqual(p.data.passed, true, '重读 3 次后必须放行，绝不卡死孩子');
    assert.strictEqual(p.data.feedback.issues.length > 0, true);
    assert.strictEqual(p._traces.length, 1);
    assert.strictEqual(p._traces[0].forced, true, '强制放行要进报告');
    assert.strictEqual(p._traces[0].grade, 'bad');
    assert.strictEqual(holdMeta.ref_text, 'clean', '录音层要拿到参考文本');
  });

  await ok('⑫ 合格才「下一个」；跳过也会留痕进待练清单', async function () {
    var p = fresh();
    await holdOnce(p, goodOut());
    assert.notStrictEqual(p.data.feedback.grade, 'bad');
    assert.strictEqual(p.data.passed, true);
    p.onNext();
    assert.strictEqual(p.data.idx, 1);
    assert.strictEqual(p.data.item.display, 'desk');
    p.onSkipItem();
    assert.strictEqual(p.data.passed, true, '跳过也能走，不许卡死');
    assert.strictEqual(p._traces[1].forced, true);
    assert.strictEqual(p._traces[1].issues[0], '这次先跳过');
  });

  await ok('⑬ 麦克风被拒：给明确提示、能立刻跳过，不留死状态', async function () {
    var p = fresh();
    // 模拟起录失败：Promise 直接 reject
    var orig = oralMock.startHold;
    oralMock.startHold = function () { return Promise.reject(new Error('MIC_DENIED')); };
    try {
      p.onHoldStart();
      await tick(); await tick();
      assert.strictEqual(p.data.holding, false);
      assert.ok(p.data.tip.indexOf('麦克风') >= 0, '要给一句人话提示');
      assert.strictEqual(denied, 1, '要引导去授权设置');
      p.onSkipItem();
      assert.strictEqual(p.data.passed, true);
    } finally { oralMock.startHold = orig; }
  });

  /* ---------- 页面桩：② 抽查 ---------- */

  await ok('⑭ 带读 9 条走完自动进混排抽查，抽查题不再自动播示范音', async function () {
    var p = fresh();
    for (var i = 0; i < 9; i++) {
      await holdOnce(p, goodOutFor(p.data.item.refText));
      p.onNext();
    }
    assert.strictEqual(p.data.stage, 'check');
    assert.strictEqual(p.data.qTotal, 7);
    var before = demoPlayed.length;
    p.showQuestion();
    assert.strictEqual(demoPlayed.length, before, '抽查不给示范音，考的是自己能不能读出来');
    assert.ok(p.data.q.type === 'oral' || p.data.q.type === 'meaning');
  });

  await ok('⑮ 抽查里口语题也走同一个评分器，读砸的题进错题再过一遍', async function () {
    var p = fresh();
    for (var i = 0; i < 9; i++) {
      await holdOnce(p, goodOutFor(p.data.item.refText));
      p.onNext();
    }
    var guard = 0;
    while (p.data.stage === 'check' && guard++ < 40) {
      await answerQuestion(p, true);      // 全部故意答砸 / 读砸
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
    for (var i = 0; i < 9; i++) {
      await holdOnce(p, goodOutFor(p.data.item.refText));
      p.onNext();
    }
    var rounds = [];
    var guard = 0;
    while (p.data.stage === 'check' && guard++ < 40) {
      rounds.push(p.data.checkRound);
      await answerQuestion(p, true);
    }
    assert.ok(rounds.indexOf(1) >= 0 && rounds.indexOf(2) >= 0, '应该出现两轮');
    assert.ok(toasts.some(function (t) { return String(t.title).indexOf('再过一遍') >= 0; }));
  });

  /* ---------- 页面桩：④ 报告 ---------- */

  await ok('⑰ ?report=1 出合并报告：口语、抽查、书面三段都在', function () {
    flowLib.clear();
    flowLib.save({
      traces: [
        { refText: 'clean', kind: 'word', grade: 'perfect', forced: false, honest: true, issues: [] },
        { refText: 'desk', kind: 'word', grade: 'bad', forced: true, honest: true, issues: [] }
      ],
      check: { total: 7, wrong: 1, rounds: 2 },
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
      check: { total: 7, wrong: 1, rounds: 2 },
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

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 项 ✓' +
    (fail ? '，' + fail + ' 项 ✗' : ''));
  process.exit(fail ? 1 : 0);
})();
