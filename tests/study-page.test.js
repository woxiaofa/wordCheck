/**
 * 学习页 · 队列与卡片 key 测试
 *
 *   node tests/study-page.test.js
 *
 * 为什么单独测这个：真机上出现过"点击反馈按钮后，下一个词仍是翻面状态"的 bug。
 * 根因不在组件，而在页面传给组件的 cardKey：
 *   当时用的是 word.word，而队列里相邻两项可能是**同一个词**
 *   （首次使用的示范卡，后面紧跟的就是同一个真词），
 *   key 没变化 → 组件的复位逻辑不触发 → 卡片停在上一次的翻面状态。
 *
 * 所以这里断言的是"key 与位置一一对应"，而不是 key 与单词对应。
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
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

/** 造一个页面实例替身：只挂 setData、data、以及从真实源码抽出的方法 */
function makePage() {
  var inst = {
    data: {
      queue: [],
      index: 0,
      word: null,
      wordState: null,
      isDemo: false,
      cardKey: '',
      stageText: '',
      progressPct: 0,
      emptyText: '',
      emptySub: ''
    },
    mirror: {},
    setData: function (patch) {
      Object.keys(patch).forEach(function (k) { inst.data[k] = patch[k]; });
    },
    /** 记录 selectComponent 的调用，便于断言"换词时必须让卡片复位" */
    resetCalls: 0,
    selectComponent: function (sel) {
      var self = this;
      return {
        resetCard: function () { self.resetCalls++; }
      };
    }
  };
  Object.keys(methods).forEach(function (k) { inst[k] = methods[k]; });
  return inst;
}

/** 从学习页源码里把 showCurrent 抽出来单独跑（避免加载整个页面依赖） */
function loadShowCurrent() {
  var src = require('fs').readFileSync(
    path.resolve(__dirname, '../miniprogram/pkg-media/pages/study/study.js'), 'utf8');

  // 取 showCurrent 与 describeTag 两个函数体
  function extract(name) {
    var start = src.indexOf(name + ': function');
    assert.ok(start >= 0, '页面里找不到 ' + name);
    var braceStart = src.indexOf('{', start);
    var depth = 0;
    for (var i = braceStart; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    throw new Error('括号不匹配：' + name);
  }

  var code = extract('describeTag') + ',\n' + extract('showCurrent');
  // eslint-disable-next-line no-new-func
  return new Function('return ({ ' + code + ' })')();
}

var methods = loadShowCurrent();

console.log('学习页 · 队列与卡片 key');

test('换词时页面必须显式调用组件的 resetCard（防回归：点了按钮后答案不收起来）', function () {
  var page = makePage();
  page.data.queue = [{ word: 'abandon' }, { word: 'achieve' }];

  page.data.index = 0;
  methods.showCurrent.call(page);
  var afterFirst = page.resetCalls;
  assert.ok(afterFirst >= 1, '每次显示一张卡都应让卡片复位');

  page.data.index = 1;
  methods.showCurrent.call(page);
  assert.ok(page.resetCalls > afterFirst, '推进到下一张卡时必须再次调用 resetCard');
});

test('相邻两项是同一个词时，cardKey 仍然不同（防回归：换词后卡片仍翻面）', function () {
  var page = makePage();
  // 模拟首次使用的队列：示范卡 + 紧跟的同名真词
  page.data.queue = [
    { word: 'abandon', def_cn: '放弃', isDemo: true },
    { word: 'abandon', def_cn: '放弃' },
    { word: 'achieve', def_cn: '实现' }
  ];

  var keys = [];
  for (var i = 0; i < page.data.queue.length; i++) {
    page.data.index = i;
    methods.showCurrent.call(page);
    keys.push(page.data.cardKey);
  }

  assert.strictEqual(keys.length, 3);
  assert.strictEqual(new Set(keys).size, 3,
    '三个位置的 cardKey 必须互不相同，实际：' + JSON.stringify(keys));
});

test('cardKey 与位置绑定：同一个位置重复渲染得到同一个 key', function () {
  var page = makePage();
  page.data.queue = [{ word: 'abandon' }, { word: 'achieve' }];

  page.data.index = 1;
  methods.showCurrent.call(page);
  var first = page.data.cardKey;
  methods.showCurrent.call(page);
  assert.strictEqual(page.data.cardKey, first, '同一位置重复 setData 不应换 key（否则会无谓复位）');
});

test('示范卡显示"示范"标签，且不读取 SRS 状态', function () {
  var page = makePage();
  page.mirror = { abandon: { stage: 5, next_review_at: Date.now() + 1000 } };
  page.data.queue = [{ word: 'abandon', isDemo: true }];
  page.data.index = 0;
  methods.showCurrent.call(page);

  assert.strictEqual(page.data.stageText, '示范');
  assert.strictEqual(page.data.isDemo, true);
  assert.strictEqual(page.data.wordState, null, '示范卡不应挂 SRS 状态，否则会显示虚假档位');
});

test('队列空时清空 word 并给出结束文案', function () {
  var page = makePage();
  page.data.queue = [];
  page.data.index = 0;
  methods.showCurrent.call(page);

  assert.strictEqual(page.data.word, null);
  assert.strictEqual(page.data.isDemo, false);
  assert.ok(page.data.emptyText, '应给出结束文案');
});

test('正常词会带上 SRS 状态与标签描述', function () {
  var page = makePage();
  var now = Date.now();
  page.mirror = { abandon: { stage: 3, next_review_at: now - 1000, wrong_count: 2 } };
  page.data.queue = [{ word: 'abandon', tags: ['高考'] }];
  page.data.index = 0;
  methods.showCurrent.call(page);

  assert.strictEqual(page.data.isDemo, false);
  assert.ok(page.data.wordState, '应挂上 SRS 状态');
  assert.ok(page.data.stageText.indexOf('到期复习') >= 0, '已逾期应显示到期复习：' + page.data.stageText);
  assert.ok(page.data.stageText.indexOf('高考') >= 0, '应带上标签：' + page.data.stageText);
});

console.log('');
if (failed.length) {
  console.log('失败 ' + failed.length + ' 项，通过 ' + passed + ' 项');
  process.exit(1);
} else {
  console.log('全部通过：' + passed + ' 项 ✓');
}
