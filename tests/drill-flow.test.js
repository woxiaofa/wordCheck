/**
 * 快刷流程集成测试：用真实的 drill 页面代码跑一遍合并后的流程
 *
 *   node tests/drill-flow.test.js
 *
 * 钉死用户定的规则（2026-10-07 二次改版：背词 + 抽查合并）：
 *   ① 第 1 步「认」：读音 + 单词 + 音标 → 两个中文选项二选一
 *   ② ≤5 秒选对 → known，直接下一词（不进详情）
 *   ③ 5~10 秒选对 → vague（想了很久），但仍算过、进错题本
 *   ④ 选错 → forgot + 进词详情
 *   ⑤ >10 秒没选 → 按不会处理，同样进详情
 *   ⑥ 【不会】诚实按钮 → forgot + 进详情，并标明是主动点的
 *   ⑦ 第 1 步走完自动进第 2 步「写」：题面只给音标 + 中文，不出单词，自动读音
 *   ⑧ 第 2 步拼对 → known；拼错 → 进详情，且下次拼这个词键盘降回最简单
 *   ⑨ 键盘难度由简单到复杂：没学过 easy、学过几次 medium、已掌握 hard
 *   ⑩ 两轮结束后没拿下的词进巩固轮（换现有抽查方式反复测）
 *   ⑪ 全部答对 → 完成态：时长 + 错题本
 *   ⑫ 一直答错不会锁死：最多 MAX_ROUNDS 轮后结束
 *   ⑬ 每次判定都提交云端（幂等 reqId）
 *   ⑭ 巩固轮选义题答对必须判对（回归：buildQuestion 不带 answerIdx）
 *   ⑮ 键盘输入实时可见（kbText）
 *   ⑯ 没有本地发音的词不出听写题
 *   ⑰ 巩固轮 spell 不泄题：不自动读音、题面不出单词
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
/** clearTimeout 必须真的取消：否则上一题的定时器会在后面冒出来乱判 */
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
  // 支持 'detail.speakCount' 这类路径写法 —— 真实 setData 支持，
  // 若这里只做浅合并，详情里的跟读计数永远断言不到
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

/* ---------- 云 API 打桩：不让测试真的发网络请求 ---------- */

var cloud = require('../miniprogram/utils/cloud');
var submitted = [];
var scores = [];
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
cloud.api.drillScore = function (p) {
  scores.push(p);
  return syncResolve({ rank: 1, total: 1, beat: 100, badge: '🏅 全对通关', detail: '' });
};

var def = loadPage('miniprogram/pages/drill/drill.js');
var POOL = require('../miniprogram/data/words');

/** 每道题的用时：用改 qStartAt 的方式模拟（不动真实时间） */
function elapsed(p, ms) { p.qStartAt = Date.now() - ms; }

/**
 * 造一个已经进入第 1 题的页面
 *
 * 必须做两件隔离，否则用例之间会互相污染（踩过两次）：
 *   1) 清掉全局定时器队列：上一个用例没走完的 10 秒超时定时器会在本用例的
 *      flushTimers() 里冒出来，把刚答对的词再判一次"不会"
 *   2) 清掉学习状态镜像：所有页面实例共享 store 里的同一个对象，
 *      上一用例留下的 stage/wrong_count 会让"没学过的词"变成学过的
 */
function startedPage() {
  timers.length = 0;
  delete store['word_state_mirror'];
  var p = makePage(def);
  p.onLoad({});
  return p;
}

/** 答对当前题（选择题点正确项 / 拼写题逐键输入后确定） */
function answerRight(p, ms) {
  var q = p.data.q;
  elapsed(p, ms === undefined ? 1000 : ms);
  if (q.options) {
    p.onPick({ currentTarget: { dataset: { idx: q.answerIdx } } });
  } else {
    var v = [];
    String(q.wordId).split('').forEach(function (ch) {
      v.push(ch);
      p.onKeyInput({ detail: { value: v.slice() } });
    });
    p.onKeyConfirm();
  }
  flushTimers();
}

function answerWrong(p) {
  var q = p.data.q;
  elapsed(p, 1000);
  if (q.options) {
    p.onPick({ currentTarget: { dataset: { idx: q.answerIdx === 0 ? 1 : 0 } } });
  } else {
    p.onKeyInput({ detail: { value: ['x'] } });
    p.onKeyConfirm();
  }
}

/** 一直答题直到进入目标 phase（防止死循环） */
function runTo(p, phase, guard) {
  var n = guard || 40;
  while (p.data.phase !== phase && n-- > 0) {
    if (p.data.state === 'detail') { p.onDetailNext(); continue; }
    if (!p.data.q) break;
    answerWrong(p);
  }
  return p.data.phase === phase;
}

console.log('\n快刷流程（背词 + 抽查合并）：');

test('① 第 1 步是「认」：单词+音标+两个中文选项，且含正确答案', function () {
  var p = startedPage();
  assert.strictEqual(p.data.state, 'run');
  assert.strictEqual(p.data.phase, 'recog');
  assert.strictEqual(p.data.q.type, 'binary');
  assert.strictEqual(p.data.q.options.length, 2, '选项必须是 2 个，实际 ' + p.data.q.options.length);
  assert.ok(p.data.q.options.indexOf(p.data.q.word.def_cn) >= 0, '选项里必须有正确释义');
  assert.strictEqual(p.data.q.options[p.data.q.answerIdx], p.data.q.word.def_cn);
  assert.ok(p.data.q.word.phonetic, '要显示音标');
});

test('② ≤5 秒选对 → known，直接下一词（不弹详情）', function () {
  var p = startedPage();
  var w = p.data.q.word.word;
  elapsed(p, 1200);
  p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx } } });
  flushTimers();
  assert.strictEqual(p.mirror[w].last_feedback, 'known', '应为 known');
  assert.strictEqual(p.data.state, 'run', '答对不该进详情');
  assert.strictEqual(p.data.detail, null);
  assert.strictEqual(p.data.idx, 1, '应该已经到下一个词');
});

test('③ 5~10 秒才选对 → vague（想了很久），但仍算通过、进错题本待巩固', function () {
  var p = startedPage();
  var w = p.data.q.word.word;
  elapsed(p, 7000);
  p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx } } });
  flushTimers();
  assert.strictEqual(p.mirror[w].last_feedback, 'vague', '应为 vague，实际 ' + p.mirror[w].last_feedback);
  assert.strictEqual(p.data.state, 'run', 'vague 也过，不进详情');
  assert.ok(p.data.wrongBook.length === 1, 'vague 要进错题本再巩固一次');
});

test('④ 选错 → forgot + 进入词详情（含释义/你选的 vs 正确的）', function () {
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

test('⑥ 【不会】诚实按钮 → forgot + 进详情，并标明是主动点的（不是瞎蒙）', function () {
  var p = startedPage();
  var w = p.data.q.word.word;
  p.onDontKnow();
  assert.strictEqual(p.data.state, 'detail', '点不会要看答案');
  assert.strictEqual(p.data.detail.honest, true, '要标明是主动点不会');
  assert.strictEqual(p.mirror[w].last_feedback, 'forgot');
  assert.ok(/不会/.test(p.data.detail.fbLabel), '详情标题要写明是"不会"，实际：' + p.data.detail.fbLabel);
});

test('⑦ 第 1 步认完 → 自动进第 2 步「写」：题面只给音标+中文，不出单词，自动读音', function () {
  var tts = require('../miniprogram/utils/tts');
  var spoken = [];
  var origSpeak = tts.speak;
  tts.speak = function (t) { spoken.push(t); };
  try {
    var p = startedPage();
    assert.ok(runTo(p, 'spell'), '第 1 步走完应自动进入「写」，实际 ' + p.data.phase);
    var q = p.data.q;
    assert.strictEqual(q.type, 'dictation');
    assert.strictEqual(q.stem, q.word.def_cn, '题面给的是中文释义');
    assert.strictEqual(q.answerText, q.word.word, '答案是单词本身');
    // 题面不能出现单词：wxml 里 dictation 走的是"✏️ 拼写"分支
    var wxml = require('fs').readFileSync(
      path.resolve(__dirname, '../miniprogram/pages/drill/drill.wxml'), 'utf8');
    assert.ok(/q\.type === 'dictation' \? '✏️ 拼写'/.test(wxml), '「写」的题面必须隐藏单词');
    // 这一档要自动读音（它就是一道带提示的听写）
    spoken.length = 0;
    p.showQuestion();
    assert.ok(spoken.indexOf(q.word.word) >= 0, '「写」必须自动读音，实际念了 ' + spoken.join(','));
  } finally {
    tts.speak = origSpeak;
  }
});

test('⑧ 第 2 步拼对 → known；拼错 → 进详情且下次该词键盘降回最简单', function () {
  var p = startedPage();
  assert.ok(runTo(p, 'spell'), '先走到「写」');
  var q = p.data.q;
  var w = q.word.word;
  // 先拼错一次
  elapsed(p, 1000);
  p.onKeyInput({ detail: { value: ['x'] } });
  p.onKeyConfirm();
  assert.strictEqual(p.data.state, 'detail', '拼错必须进详情');
  assert.strictEqual(p.mirror[w].last_feedback, 'forgot');
  assert.ok(p._spellTries[w] >= 1, '要记下拼错过');
  assert.strictEqual(p.spellLevel(q.word, 0, 10), 'easy', '拼错后键盘必须降回最简单');
  // 再来一个新页面：同一个词拼对 → known
  var p2 = startedPage();
  assert.ok(runTo(p2, 'spell'));
  var q2 = p2.data.q;
  elapsed(p2, 3000);
  var v = [];
  String(q2.wordId).split('').forEach(function (ch) { v.push(ch); p2.onKeyInput({ detail: { value: v.slice() } }); });
  p2.onKeyConfirm();
  flushTimers();
  assert.strictEqual(p2.mirror[q2.wordId].last_feedback, 'known', '拼对必须记 known');
});

test('⑨ 键盘难度由简单到复杂：没学过 easy、学过几次 medium、已掌握 hard', function () {
  var p = startedPage();
  var w = p.data.words[0];
  assert.strictEqual(p.spellLevel(w, 0, 10), 'easy', '没学过的词给最简单的键盘');
  p.mirror[w.word] = { stage: 2, last_feedback: 'known', correct_count: 2, next_review_at: Date.now() + 1e8 };
  assert.strictEqual(p.spellLevel(w, 0, 10), 'medium', '学过几次 → 加易混字母');
  p.mirror[w.word] = { stage: 6, last_feedback: 'known', correct_count: 6, next_review_at: Date.now() + 1e8 };
  assert.strictEqual(p.spellLevel(w, 0, 10), 'hard', '已掌握 → 全键盘');
  // 一轮之内后 1/3 的词至少提到 medium（这一轮本身也是由简到难）
  var fresh = { word: 'zzz-fresh', def_cn: 'x' };
  assert.strictEqual(p.spellLevel(fresh, 0, 10), 'easy');
  assert.strictEqual(p.spellLevel(fresh, 8, 10), 'medium', '一轮末尾至少要 medium');
});

test('⑩ 两步都走完还有没拿下的词 → 自动进巩固轮（换现有抽查方式）', function () {
  var p = startedPage();
  // 「认」全错
  while (p.data.phase === 'recog') {
    if (p.data.state === 'detail') { p.onDetailNext(); continue; }
    answerWrong(p);
  }
  assert.strictEqual(p.data.phase, 'spell', '先进入「写」');
  // 「写」也全错
  var guard = 0;
  while (p.data.phase === 'spell' && guard++ < 40) {
    if (p.data.state === 'detail') { p.onDetailNext(); continue; }
    answerWrong(p);
  }
  assert.strictEqual(p.data.phase, 'loop', '两步都错应进巩固轮，实际 ' + p.data.phase);
  assert.strictEqual(p.data.round, 2);
  assert.strictEqual(p.data.words.length, 2, '巩固轮只练没拿下的词');
  assert.ok(['meaning', 'spell', 'listen'].indexOf(p.data.q.type) >= 0,
    '巩固轮应换用现有抽查方式，实际 ' + p.data.q.type);
});

test('⑪ 全部答对 → 完成态：时长 + 错题本 + 全对标记 + 上报成绩', function () {
  scores.length = 0;
  var p = startedPage();
  var guard = 0;
  while (p.data.state !== 'done' && guard++ < 60) {
    answerRight(p, 1000);
    if (p.data.state === 'detail') p.onDetailNext();
  }
  assert.strictEqual(p.data.state, 'done', '全对应结束，实际 ' + p.data.state);
  assert.strictEqual(p.data.result.allDone, true);
  assert.strictEqual(p.data.result.wrongBook.length, 0, '全对不该有错题本');
  assert.ok(/秒/.test(p.data.elapsedText), '完成页要给出时长，实际 ' + p.data.elapsedText);
  assert.strictEqual(scores.length, 1, '完成要上报成绩换荣誉，实际 ' + scores.length);
  assert.ok(scores[0].key, '成绩要带分组 key（同词库/同作业才可比）');
  assert.strictEqual(scores[0].perfect, true);
});

test('⑫ 一直答错不会把孩子锁死：最多 5 轮后结束，剩下的词摆出来', function () {
  var p = startedPage();
  var guard = 0;
  while (p.data.state !== 'done' && guard < 300) {
    guard++;
    if (p.data.state === 'detail') { p.onDetailNext(); continue; }
    if (!p.data.q) break;
    answerWrong(p);
  }
  assert.strictEqual(p.data.state, 'done', '必须在有限轮次内结束');
  assert.ok(p.data.round <= 5, '轮次不得超过上限，实际 ' + p.data.round);
  assert.strictEqual(p.data.result.allDone, false);
  assert.ok(p.data.result.left.length > 0, '没拿下的词要摆在结果页');
  assert.ok(p.data.result.wrongBook.length > 0, '错题本要有内容');
});

test('⑬ 每次判定都提交云端（幂等 reqId），教练端进度才跟得上', function () {
  submitted.length = 0;
  var p = startedPage();
  elapsed(p, 1000);
  p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx } } });
  flushTimers();
  assert.strictEqual(submitted.length, 1, '应提交 1 次反馈，实际 ' + submitted.length);
  assert.ok(submitted[0].clientReqId, '必须带幂等 ID，否则补传会重复计数');
});

test('⑭ 巩固轮选义题答对必须判对（回归：buildQuestion 不带 answerIdx 导致选对判错）', function () {
  var p = startedPage();
  assert.ok(runTo(p, 'loop', 60), '先进入巩固轮');
  var q = null, guard = 0;
  while (guard++ < 50) {
    q = p.buildQuestion(p.data.words[0], POOL, 'loop', 0, 2);
    if (q.type === 'meaning') break;
  }
  assert.strictEqual(q.type, 'meaning', '应造出选义题');
  assert.ok(q.answerIdx !== undefined && q.answerIdx >= 0,
    '巩固轮选义题必须有 answerIdx（此前缺失导致永远判错）');
  assert.strictEqual(q.options[q.answerIdx], q.word.def_cn, 'answerIdx 必须指向正确释义');

  p._qs[p.data.idx] = q;
  p.showQuestion();
  elapsed(p, 1000);
  p.onPick({ currentTarget: { dataset: { idx: q.answerIdx } } });
  flushTimers();
  assert.strictEqual(p.mirror[q.word.word].last_feedback, 'known',
    '巩固轮选对必须记 known，实际 ' + p.mirror[q.word.word].last_feedback);
  assert.notStrictEqual(p.data.state, 'detail', '选对不得进详情');
});

test('⑮ 键盘输入实时可见（kbText），判定不受影响', function () {
  var p = startedPage();
  var q = p.buildQuestion(p.data.words[0], POOL, 'spell', 0, 2);
  assert.strictEqual(q.type, 'dictation');
  p._qs[p.data.idx] = q;
  p.showQuestion();
  var v = [];
  String(q.wordId).split('').forEach(function (ch) {
    v.push(ch);
    p.onKeyInput({ detail: { value: v.slice() } });
  });
  assert.strictEqual(p.data.kbText, q.wordId,
    '已输入字母必须实时拼接可见（2026-10-07"填写无效果"实锤：显示恒为 …）');
  elapsed(p, 1000);
  p.onKeyConfirm();
  flushTimers();
  assert.strictEqual(p.mirror[q.wordId].last_feedback, 'known');
});

test('⑯ 没有本地发音的词不出听写题（外研四上 100 词无 mp3，哑巴题只能瞎拼）', function () {
  var p = startedPage();
  var tts = require('../miniprogram/utils/tts');
  var w = { word: 'zzz-no-audio', def_cn: '测试词', pos: 'n.', phonetic: '/test/', freq: 9999 };
  assert.strictEqual(tts.hasAudio(w.word), false, '前置：该词应无音频');
  var sawListen = 0, sawType = {};
  for (var i = 0; i < 60; i++) {
    var q = p.buildQuestion(w, POOL, 'loop', i, 60);
    sawType[q.type] = (sawType[q.type] || 0) + 1;
    if (q.type === 'listen') sawListen++;
  }
  assert.ok(sawType.meaning > 0 && sawType.spell > 0, '其余题型照常出现：' + JSON.stringify(sawType));
  assert.strictEqual(sawListen, 0, '无音频的词绝不能出听写，实际出现 ' + sawListen + ' 次');
  var withAudio = Object.keys(require('../miniprogram/data/audio-manifest.js'))[0];
  var wa = POOL.filter(function (x) { return x.word === withAudio; })[0] ||
           { word: withAudio, def_cn: 'x', pos: 'n.', phonetic: '/x/', freq: 9999 };
  var gotListen = false;
  for (var j = 0; j < 80 && !gotListen; j++) {
    gotListen = p.buildQuestion(wa, POOL, 'loop', j, 80).type === 'listen';
  }
  assert.ok(gotListen, '有音频的词应能出听写题');
});

test('⑰ 巩固轮 spell 不泄题：不自动读音、题面不出单词', function () {
  var tts = require('../miniprogram/utils/tts');
  var spoken = [];
  var origSpeak = tts.speak;
  tts.speak = function (t) { spoken.push(t); };
  try {
    var p = startedPage();
    var q = null, guard = 0;
    while (guard++ < 50) {
      q = p.buildQuestion(p.data.words[0], POOL, 'loop', 0, 2);
      if (q.type === 'spell') break;
    }
    assert.strictEqual(q.type, 'spell', '应造出拼写题');
    spoken.length = 0;
    p._qs[p.data.idx] = q;
    p.showQuestion();
    assert.strictEqual(spoken.length, 0,
      '巩固轮 spell 绝不能自动读音 —— 一念就是把答案读出来，实际念了 ' + spoken.join(','));
    assert.strictEqual(p.speak(), undefined);
    assert.strictEqual(spoken.length, 0, '点喇叭也不能念');
    var wxml = require('fs').readFileSync(
      path.resolve(__dirname, '../miniprogram/pages/drill/drill.wxml'), 'utf8');
    assert.ok(/q\.type === 'spell' \? '✏️ 拼写'/.test(wxml), '拼写题题面必须隐藏单词');
  } finally {
    tts.speak = origSpeak;
  }
});

test('⑱ 详情里点喇叭能无限听，并给出"跟着念"的引导与计数', function () {
  var tts = require('../miniprogram/utils/tts');
  var spoken = [];
  var origSpeak = tts.speak;
  tts.speak = function (t) { spoken.push(t); };
  try {
    var p = startedPage();
    var w = p.data.q.word.word;
    spoken.length = 0;                      // 进页面时"认"已经自动念过一次，不计入
    p.onDontKnow();
    assert.strictEqual(p.data.state, 'detail');
    assert.strictEqual(p.data.detail.speakCount, 0, '刚进详情还没念过');
    for (var i = 0; i < 3; i++) p.onSpeak();
    assert.strictEqual(spoken.length, 3, '详情里点几次喇叭就该念几次（无限听），实际 ' + spoken.length);
    assert.strictEqual(p.data.detail.speakCount, 3, '要数着念了几遍');
    assert.ok(p.data.detail.guide, '要给跟读引导');
    assert.ok(spoken.every(function (t) { return t === w; }), '念的必须是当前这个词');
  } finally {
    tts.speak = origSpeak;
  }
});

test('⑲ 「认」的选项位置真随机（回归：按字符码定位置导致正确答案一直是第二个）', function () {
  var p = startedPage();
  var w = p.data.q.word;
  var pos = { 0: 0, 1: 0 };
  for (var i = 0; i < 200; i++) {
    var q = p.buildQuestion(w, POOL, 'recog', 0, 10);
    pos[q.answerIdx]++;
    assert.strictEqual(q.options.length, 2);
    assert.strictEqual(q.options[q.answerIdx], w.def_cn, 'answerIdx 必须始终指向正确释义');
  }
  assert.ok(pos[0] > 20 && pos[1] > 20,
    '两种位置都必须大量出现才算随机，实际：0→' + pos[0] + ' 次，1→' + pos[1] + ' 次');
});

test('⑳ 巩固轮拼写题的答案是单词本身，不是中文释义（回归：「你拼的是!eastern，正确的是东方的」）', function () {
  var p = startedPage();
  var q = null, guard = 0;
  while (guard++ < 50) {
    q = p.buildQuestion(p.data.words[0], POOL, 'loop', 0, 2);
    if (q.type === 'spell') break;
  }
  assert.strictEqual(q.type, 'spell');
  assert.strictEqual(q.answerText, p.data.words[0].word,
    '拼写题 answerText 必须是单词，实际 ' + q.answerText);
  // 走一遍判定：详情里的 answer 也要是单词
  p._qs[p.data.idx] = q;
  p.showQuestion();
  p.onKeyInput({ detail: { value: ['x'] } });
  p.onKeyConfirm();
  assert.strictEqual(p.data.state, 'detail');
  assert.strictEqual(p.data.detail.answer, q.wordId, '详情要告诉他正确拼写');
  assert.strictEqual(p.data.detail.pickVerb, '拼', '文案要说"你拼的是"');
  assert.strictEqual(p.data.detail.answerVerb, '正确拼写是');
});

test('㉑ 每条学习记录都带时长 durationMs（含看详情的时间）——简报"经过 X 分钟"的数据源', function () {
  submitted.length = 0;
  var p = startedPage();
  // 第 1 题：题面已出现 5 秒后作答
  p._qShownAt = Date.now() - 5000;
  elapsed(p, 1000);
  p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx } } });
  flushTimers();
  assert.ok(submitted.length === 1 && submitted[0].durationMs >= 4000,
    'durationMs 应约等于答题用时，实际 ' + (submitted[0] || {}).durationMs);
  // 第 2 题：先看 4 秒详情再作答。详情停留的时长记在"下一条"记录上（日汇总口径不变）
  p.onDontKnow();
  assert.strictEqual(submitted.length, 2, '点了不会也立即记一条');
  p._detailAt = Date.now() - 4000;
  p.onDetailNext();
  p._qShownAt = Date.now();
  elapsed(p, 1000);
  p.onPick({ currentTarget: { dataset: { idx: p.data.q.answerIdx } } });
  flushTimers();
  assert.ok(submitted.length === 3 && submitted[2].durationMs >= 3000,
    '详情停留时长要计入下一条记录，实际 ' + (submitted[2] || {}).durationMs);
});

test('㉒ 拼写题答错后的详情里喇叭必须出声（回归：spell 守卫误伤详情页）', function () {
  var tts = require('../miniprogram/utils/tts');
  var spoken = [];
  var origSpeak = tts.speak;
  tts.speak = function (t) { spoken.push(t); };
  try {
    var p = startedPage();
    var q = null, guard = 0;
    while (guard++ < 50) {
      q = p.buildQuestion(p.data.words[0], POOL, 'loop', 0, 2);
      if (q.type === 'spell') break;
    }
    p._qs[p.data.idx] = q;
    p.showQuestion();
    p.onKeyInput({ detail: { value: ['x'] } });
    p.onKeyConfirm();
    assert.strictEqual(p.data.state, 'detail', '拼错进详情');
    spoken.length = 0;
    p.onSpeak();
    assert.strictEqual(spoken.length, 1,
      '详情页点喇叭必须念 —— 详情已把单词摆出来，念不泄题，实际没念');
  } finally {
    tts.speak = origSpeak;
  }
});

test('㉓ 「写」阶段：没有本地发音的词降级为看中文拼写，不出哑巴听写', function () {
  var p = startedPage();
  var w = { word: 'zzz-no-audio', def_cn: '测试词', pos: 'n.', phonetic: '/test/', freq: 9999 };
  for (var i = 0; i < 20; i++) {
    var q = p.buildQuestion(w, POOL, 'spell', i, 10);
    assert.strictEqual(q.type, 'spell',
      '无音频的词在「写」阶段必须是看中文拼写，实际 ' + q.type);
    assert.strictEqual(q.answerText, w.word);
  }
});

console.log('\n通过：' + passed + ' 项' + (failed.length ? '，失败 ' + failed.length + ' 项：' + failed.join('、') : ' ✓'));
if (failed.length) process.exitCode = 1;
