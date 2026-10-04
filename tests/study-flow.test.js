/**
 * 学习流程集成测试：把真实的「页面 + 组件」接在一起，模拟一轮完整操作
 *
 *   node tests/study-flow.test.js
 *
 * 为什么必须有这个测试：
 *   之前有 90+ 项测试，但都是「单独测组件」或「单独测页面把方法抽出来跑」。
 *   而真机上报的 bug 恰恰出在两者的交互上：
 *     "点击反馈按钮 → 下一个词之后，卡片点不动了"
 *   单元测试看不到，因为没有任何一个测试真正把 setData、属性下发、
 *   组件方法调用、定时器这几件事串起来跑一遍。
 *
 * 这个脚本自己搭一个极简的小程序运行时（wx / Component / Page / setTimeout），
 * 把真实的 word-card 与 study 页面装配起来，然后像用户一样操作并断言结果。
 */

var assert = require('assert');
var path = require('path');

var passed = 0;
var failed = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed.push(name);
    console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack : e));
  }
}

/* ============================================================
   1. 极简小程序运行时
   ============================================================ */

var pendingTimers = [];

global.wx = {
  getStorageSync: function () { return undefined; },
  setStorageSync: function () {},
  showToast: function () {},
  redirectTo: function () {},
  createInnerAudioContext: function () {
    return { play: function () {}, onError: function () {}, src: '' };
  }
};

/** 收集 setTimeout 回调，由测试显式推进，避免依赖真实时间 */
function flushTimers() {
  var list = pendingTimers.slice();
  pendingTimers.length = 0;
  list.forEach(function (fn) { fn(); });
}
var realSetTimeout = global.setTimeout;
global.setTimeout = function (fn, ms) { pendingTimers.push(fn); return pendingTimers.length; };
global.clearTimeout = function () {};

/** 读取某个 .js 文件里注册的对象（Component 或 Page） */
function loadRegistration(file, kind) {
  var full = path.resolve(__dirname, '..', file);
  delete require.cache[full];
  var captured = null;
  var originals = { Component: global.Component, Page: global.Page };
  global.Component = function (def) { captured = def; };
  global.Page = function (def) { captured = def; };
  try {
    require(full);
  } finally {
    global.Component = originals.Component;
    global.Page = originals.Page;
    delete require.cache[full];
  }
  assert.ok(captured, file + ' 没有注册 ' + kind);
  return captured;
}

/* ============================================================
   2. 组件实例（真实方法 + 模拟框架能力）
   ============================================================ */

function makeComponent(def, initialProps) {
  var inst = {
    data: {},
    _events: [],
    _setDataLog: [],
    autoTimer: null,
    autoEndAt: 0,
    /** 模拟事件冒泡：记录 triggerEvent */
    triggerEvent: function (name, detail) { inst._events.push({ name: name, detail: detail }); }
  };

  Object.keys(def.properties || {}).forEach(function (k) {
    var p = def.properties[k];
    inst.data[k] = (p && typeof p === 'object' && 'value' in p) ? p.value : undefined;
  });
  Object.keys(def.data || {}).forEach(function (k) { inst.data[k] = def.data[k]; });
  Object.keys(initialProps || {}).forEach(function (k) { inst.data[k] = initialProps[k]; });

  // setData 之后要跑一遍 observers —— 这是小程序的核心行为，简化版但顺序正确
  inst.setData = function (patch) {
    inst._setDataLog.push(patch);
    Object.keys(patch).forEach(function (k) { inst.data[k] = patch[k]; });
    runObservers(def, inst, Object.keys(patch));
  };

  Object.keys(def.methods || {}).forEach(function (k) { inst[k] = def.methods[k].bind(inst); });

  // 生命周期
  if (def.lifetimes && def.lifetimes.attached) def.lifetimes.attached.call(inst);
  if (def.observers) {
    // 组件初次渲染时，observers 会带当前值跑一次
    Object.keys(def.observers).forEach(function (key) {
      key.split(',').map(function (s) { return s.trim(); }).forEach(function (k) {
        if (inst.data[k] !== undefined) {
          try { def.observers[key].apply(inst, [inst.data[k]]); } catch (e) { /* 单字段 observer 对多字段签名不匹配，忽略 */ }
        }
      });
    });
  }

  return inst;
}

/** 属性变化时触发对应 observer（支持 'a, b' 多字段注册） */
function runObservers(def, inst, changedKeys) {
  if (!def.observers) return;
  Object.keys(def.observers).forEach(function (key) {
    var fields = key.split(',').map(function (s) { return s.trim(); });
    if (!fields.some(function (f) { return changedKeys.indexOf(f) >= 0; })) return;
    var args = fields.map(function (f) { return inst.data[f]; });
    def.observers[key].apply(inst, args);
  });
}

/** 页面给组件下发属性（模拟 wxml 的数据绑定） */
function pushProps(component, props) {
  component.setData(props);
}

/* ============================================================
   3. 页面实例（真实方法 + selectComponent 接线到组件）
   ============================================================ */

function makePage(pageDef, componentDef, queue) {
  var page = {
    data: {},
    _components: {},
    resetCalls: 0,
    /** 页面收到的组件事件，便于断言 */
    events: [],
    setData: function (patch) {
      Object.keys(patch).forEach(function (k) { page.data[k] = patch[k]; });
      // 页面 setData 后要把相关属性"下发"给组件（模拟 wxml 绑定）
      syncToComponent(page);
    },
    selectComponent: function (sel) { return page._components[sel] || null; }
  };

  Object.keys(pageDef.data || {}).forEach(function (k) { page.data[k] = pageDef.data[k]; });
  Object.keys(pageDef).forEach(function (k) {
    if (typeof pageDef[k] === 'function') page[k] = pageDef[k].bind(page);
  });

  // 装配组件（用真实组件定义）
  var card = makeComponent(componentDef, {
    cardKey: page.data.cardKey,
    word: page.data.word,
    state: page.data.wordState,
    demo: page.data.isDemo,
    locked: !!page.data.loading,
    revealAfter: 8000
  });
  // 记录复位调用次数：页面显式调用 resetCard 与 observer 兜底都算
  var originalReset = card.resetCard;
  card.resetCard = function () { page.resetCalls++; return originalReset.apply(card, arguments); };

  // 把组件 triggerEvent 转发给页面的处理函数
  // —— 这就是 wxml 里 bind:feedback="onFeedback" / bind:known="onKnown" 的等价物。
  // 少了这一步，测试里点按钮不会到达页面，反而会掩盖真实问题。
  card.triggerEvent = function (name, detail) {
    page.events.push({ name: name, detail: detail });
    var handler = { feedback: 'onFeedback', known: 'onKnown', reveal: 'onReveal', speak: 'onSpeak' }[name];
    if (handler && typeof page[handler] === 'function') {
      page[handler]({ detail: detail });
    }
  };

  page._components['#card'] = card;
  return page;
}

/** 把页面推给组件的属性同步过去（模拟 wxml 绑定） */
function syncToComponent(page) {
  var card = page._components['#card'];
  if (!card) return;
  var props = {
    cardKey: page.data.cardKey,
    word: page.data.word,
    state: page.data.wordState,
    demo: !!page.data.isDemo,
    locked: !!page.data.loading,
    revealAfter: page.data.isDemo ? 0 : 8000
  };
  pushProps(card, props);
}

/* ============================================================
   4. 真实页面 + 真实组件的装配
   ============================================================ */

var componentDef = loadRegistration('miniprogram/components/word-card/index.js', 'Component');
var pageDef = loadRegistration('miniprogram/pages/study/study.js', 'Page');

/** 造一轮队列并启动页面 */
function startRound(queue) {
  var page = makePage(pageDef, componentDef, queue);

  // 覆盖网络与本地存储依赖：直接用给定队列
  page.mirror = {};
  page.setData({ queue: queue, index: 0 });
  page.showCurrent();
  return page;
}

/** 模拟用户点击卡片（触发组件的 onCardTap） */
function tapCard(page) {
  var card = page._components['#card'];
  card.onCardTap();
}

/** 模拟用户上滑 */
function swipeUp(page) {
  var card = page._components['#card'];
  card.onTouchStart({ touches: [{ clientX: 100, clientY: 300 }] });
  card.onTouchMove({ touches: [{ clientX: 100, clientY: 200 }] });
  card.onTouchEnd({ changedTouches: [{ clientX: 100, clientY: 200 }] });
}

/** 模拟用户点反馈按钮 */
function tapFeedback(page, fb) {
  var card = page._components['#card'];
  card.onFeedback({ currentTarget: { dataset: { fb: fb } } });
}

var QUEUE = [
  { word: 'abandon', phonetic: '/əˈbændən/', pos: 'v.', def_cn: '放弃；抛弃', example_en: 'He had to abandon the plan.', example_cn: '他不得不放弃这个计划。' },
  { word: 'achieve', phonetic: '/əˈtʃiːv/', pos: 'v.', def_cn: '实现；达到', example_en: 'She worked hard.', example_cn: '她努力工作。' },
  { word: 'attitude', phonetic: '/ˈætɪtuːd/', pos: 'n.', def_cn: '态度', example_en: 'His attitude changed.', example_cn: '他的态度改变了。' }
];

/* ============================================================
   5. 用例
   ============================================================ */

console.log('学习流程集成测试（页面 + 组件一起跑）');

test('初始状态：只显示单词，未揭晓答案', function () {
  var page = startRound(QUEUE);
  var card = page._components['#card'];
  assert.strictEqual(page.data.word.word, 'abandon');
  assert.strictEqual(card.data.revealed, false, '初始不应显示答案');
  assert.strictEqual(card.data.cardKey, 'card-0');
});

test('点击卡片 → 显示答案与三个反馈按钮', function () {
  var page = startRound(QUEUE);
  var card = page._components['#card'];
  tapCard(page);
  assert.strictEqual(card.data.revealed, true);
  assert.strictEqual(card.data.showKnownBtn, true, '点击揭晓应保留"想得很快"');
});

test('超时揭晓 → 显示答案但不给“想得很快”', function () {
  var page = startRound(QUEUE);
  var card = page._components['#card'];
  card.reveal(true);
  assert.strictEqual(card.data.revealed, true);
  assert.strictEqual(card.data.showKnownBtn, false);
});

test('点反馈按钮 → 进入“已记录”过渡，且过渡期间卡片被锁定', function () {
  var page = startRound(QUEUE);
  var card = page._components['#card'];
  tapCard(page);
  tapFeedback(page, 'known');

  assert.strictEqual(page.data.loading, true, '应显示过渡提示');
  assert.strictEqual(page.data.loadingText, '想得很快');
  assert.strictEqual(page.data.index, 0, '过渡期间不应立刻换词');
});

test('★ 回归：过渡结束后换到下一个词，卡片必须恢复可交互', function () {
  var page = startRound(QUEUE);
  var card = page._components['#card'];
  card.startAuto();

  tapCard(page);
  tapFeedback(page, 'known');
  flushTimers();                       // 推进 260ms 过渡

  assert.strictEqual(page.data.index, 1, '应换到第 2 个词');
  assert.strictEqual(page.data.word.word, 'achieve');
  assert.strictEqual(page.data.loading, false, '过渡应结束');
  assert.strictEqual(!!card.data.locked, false, '组件不应仍处于锁定态');
  assert.strictEqual(card.data.revealed, false, '新词应只显示单词（答案已收起）');

  // 关键：新词必须还能操作
  card._events = [];
  var lockState = 'this._locked=' + card._locked + ', data.locked=' + card.data.locked;
  tapCard(page);
  assert.strictEqual(card.data.revealed, true,
    '★ 新词点击后应显示答案 —— 若为 false，说明卡片被永久锁死（真机 bug）[' + lockState + ']');
});

test('★ 回归：连续走三个词，每一步都能点开答案', function () {
  var page = startRound(QUEUE);
  var card = page._components['#card'];

  for (var i = 0; i < QUEUE.length; i++) {
    card.startAuto();
    tapCard(page);
    assert.strictEqual(card.data.revealed, true, '第 ' + (i + 1) + ' 个词：应能点开答案');
    tapFeedback(page, 'vague');
    flushTimers();
    if (i < QUEUE.length - 1) {
      assert.strictEqual(page.data.index, i + 1, '应推进到第 ' + (i + 2) + ' 个词');
      assert.strictEqual(card.data.revealed, false, '新词应只显示单词');
    }
  }
});

test('★ 回归：上滑也应该能连续使用（不被上一次的锁定影响）', function () {
  var page = startRound(QUEUE);
  var card = page._components['#card'];

  card.startAuto();
  swipeUp(page);                       // 第 1 个词上滑过关
  flushTimers();
  assert.strictEqual(page.data.index, 1, '上滑应换到第 2 个词');

  card._events = [];
  card.startAuto();
  swipeUp(page);                       // 第 2 个词再上滑
  flushTimers();
  assert.strictEqual(page.data.index, 2, '★ 第 2 次上滑仍应生效（若失败说明卡片被锁死）');
});

test('过渡期间连点按钮不会一次过掉两个词', function () {
  var page = startRound(QUEUE);
  var card = page._components['#card'];
  tapCard(page);
  tapFeedback(page, 'known');
  tapFeedback(page, 'known');          // 过渡期间再点一次
  tapFeedback(page, 'known');          // 再来一次
  flushTimers();
  assert.strictEqual(page.data.index, 1, '只应推进一个词');
});

test('过渡期间点击卡片不会误触揭晓下一个词', function () {
  var page = startRound(QUEUE);
  var card = page._components['#card'];
  tapCard(page);
  tapFeedback(page, 'known');
  card.onCardTap();                    // 过渡期间误点
  flushTimers();

  assert.strictEqual(page.data.index, 1);
  assert.strictEqual(card.data.revealed, false,
    '过渡期间的误点不应把下一个词的答案翻开');
});

test('上滑过关后，下一个词仍可点开答案（两种操作交替）', function () {
  var page = startRound(QUEUE);
  var card = page._components['#card'];

  card.startAuto();
  swipeUp(page);                       // 上滑过掉第 1 个
  flushTimers();
  assert.strictEqual(page.data.index, 1);

  card.startAuto();
  tapCard(page);                       // 第 2 个点开答案
  assert.strictEqual(card.data.revealed, true, '上滑之后点击仍应有效');
  tapFeedback(page, 'forgot');
  flushTimers();

  card.startAuto();
  tapCard(page);                       // 第 3 个再点开
  assert.strictEqual(card.data.revealed, true, '点按钮之后点击仍应有效');
});

test('走完整轮：结算文案正确，且中途不出现“卡死”', function () {
  var page = startRound(QUEUE);
  var card = page._components['#card'];
  var interactions = 0;

  for (var i = 0; i < QUEUE.length; i++) {
    card.startAuto();
    if (i % 2 === 0) {
      tapCard(page);
      assert.strictEqual(card.data.revealed, true, '第 ' + (i + 1) + ' 个词应能揭晓');
      interactions++;
      tapFeedback(page, 'known');
    } else {
      var before = page.data.index;
      swipeUp(page);
      assert.strictEqual(page.data.index, before, '上滑时索引暂不变（等过渡结束）');
      interactions++;
    }
    flushTimers();
  }

  assert.strictEqual(interactions, 3, '三个词都应完成一次操作');
  assert.ok(page.data.emptyText, '走完后应给出结束文案');
});

/* ============================================================ */

global.setTimeout = realSetTimeout;

console.log('');
if (failed.length) {
  console.log('失败 ' + failed.length + ' 项，通过 ' + passed + ' 项');
  process.exit(1);
} else {
  console.log('全部通过：' + passed + ' 项 ✓');
}
