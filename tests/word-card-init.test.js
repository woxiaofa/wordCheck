/**
 * 学习卡组件 · 初始化链路测试
 *
 *   node tests/word-card-init.test.js
 *
 * 为什么要单独测"初始化"：真机上出现过"整张卡片内部全空、Console 无任何报错"的情况。
 * 小程序里组件初始化（attached / observers / setData）抛出的异常经常被框架吞掉，
 * 表现就是"节点在、内容不渲染"，而且不给任何提示。
 * 所以这里把初始化链路完整跑一遍，让异常无处可藏。
 *
 * 覆盖：
 *   - 组件定义是否合法（properties / data / methods / observers 结构）
 *   - attached 生命周期能否跑通
 *   - 三个 observer 在"属性为 undefined / 属性已就绪"两种时序下是否都不抛异常
 *   - 事件派发是否正常
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
    console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n')[0] : e));
  }
}

function loadComponentDef() {
  var file = path.resolve(__dirname, '../miniprogram/components/word-card/index.js');
  delete require.cache[file];
  var captured = null;
  var original = global.Component;
  global.Component = function (def) { captured = def; };
  try {
    require(file);
  } finally {
    global.Component = original;
    delete require.cache[file];
  }
  assert.ok(captured, '组件没有调用 Component() 注册');
  return captured;
}

/** 造一个尽量接近真机的实例替身：包含 setData 触发 observers 的行为 */
function makeInstance(def) {
  var inst = {
    data: {},
    _events: [],
    _setDataCalls: 0,
    autoTimer: null,
    autoEndAt: 0
  };
  Object.keys(def.properties || {}).forEach(function (k) {
    var p = def.properties[k];
    inst.data[k] = (p && typeof p === 'object' && 'value' in p) ? p.value : undefined;
  });
  Object.keys(def.data || {}).forEach(function (k) { inst.data[k] = def.data[k]; });
  inst.setData = function (patch) {
    inst._setDataCalls++;
    Object.keys(patch).forEach(function (k) { inst.data[k] = patch[k]; });
  };
  inst.triggerEvent = function (name, detail) { inst._events.push({ name: name, detail: detail }); };
  Object.keys(def.methods || {}).forEach(function (k) { inst[k] = def.methods[k].bind(inst); });
  return inst;
}

/** 模拟小程序在属性就绪前后各触发一次 observer */
function fireObserver(def, inst, name, args) {
  var fn = def.observers && def.observers[name];
  assert.ok(fn, '缺少 observer: ' + name);
  fn.apply(inst, args);
}

console.log('学习卡组件 · 初始化链路');

test('组件定义结构合法', function () {
  var def = loadComponentDef();
  assert.ok(def.properties, '缺少 properties');
  assert.ok(def.data, '缺少 data');
  assert.ok(def.methods, '缺少 methods');
  assert.ok(def.observers, '缺少 observers');
  assert.strictEqual(typeof def.lifetimes.attached, 'function', '缺少 attached 生命周期');
  ['onTouchStart', 'onTouchMove', 'onTouchEnd', 'onCardTap', 'onFeedback', 'startAuto', 'resetCard']
    .forEach(function (m) {
      assert.strictEqual(typeof def.methods[m], 'function', '缺少方法 ' + m);
    });
});

test('pageLifetimes 必须在顶层，不能嵌在 lifetimes 里（这处错误让卡片整块不渲染）', function () {
  var def = loadComponentDef();
  assert.ok(def.pageLifetimes, 'pageLifetimes 缺失或放错层级');
  assert.strictEqual(typeof def.pageLifetimes.hide, 'function', 'pageLifetimes.hide 缺失');
  assert.strictEqual(typeof def.pageLifetimes.show, 'function', 'pageLifetimes.show 缺失');
  assert.strictEqual(def.lifetimes.pageLifetimes, undefined,
    'pageLifetimes 被嵌进了 lifetimes —— 会导致组件渲染异常（卡片内部全空且无报错）');
});

test('lifetimes 只包含合法的生命周期字段', function () {
  var def = loadComponentDef();
  var allowed = ['created', 'attached', 'ready', 'moved', 'detached', 'error'];
  Object.keys(def.lifetimes).forEach(function (k) {
    assert.ok(allowed.indexOf(k) >= 0,
      'lifetimes 里出现了非生命周期字段：' + k + '（pageLifetimes 应放顶层）');
  });
});

test('cardKey 变化时必须收起答案（防回归：换词后卡片仍显示上一个词的答案）', function () {
  var def = loadComponentDef();
  var inst = makeInstance(def);

  // 第一个词：用户点开看了答案
  fireObserver(def, inst, 'cardKey', ['abandon']);
  assert.strictEqual(inst.data.revealed, false);
  inst.reveal();
  assert.strictEqual(inst.data.revealed, true, '前置条件：答案已显示');

  // 换到第二个词
  fireObserver(def, inst, 'cardKey', ['achieve']);
  assert.strictEqual(inst.data.revealed, false, '换词后必须收起答案');
  assert.strictEqual(inst.data.showUp, false, '换词后不应残留上滑提示');
  assert.strictEqual(inst.data.showUp, false);
  inst.stopAuto();
});

test('cardKey 为空值时不做无意义复位', function () {
  var def = loadComponentDef();
  var inst = makeInstance(def);
  fireObserver(def, inst, 'cardKey', ['']);
  assert.strictEqual(inst.data.revealed, false);
});

test('state 变化时只刷新档位文案，不改变答案显示状态', function () {
  var def = loadComponentDef();
  var inst = makeInstance(def);
  inst.setData({ revealed: true });
  fireObserver(def, inst, 'state', [{ stage: 5, wrong_count: 2 }]);
  assert.strictEqual(inst.data.revealed, true, '只更新文案，不该把答案收起来');
  assert.ok(inst.data.stageText.indexOf('15 天') >= 0, '文案应含间隔：' + inst.data.stageText);
  inst.stopAuto();
});

test('属性尚未就绪时触发 observer 不抛异常（attached 前的时序）', function () {
  var def = loadComponentDef();
  var inst = makeInstance(def);
  inst.data.word = undefined;
  inst.data.state = undefined;
  fireObserver(def, inst, 'state', [undefined]);
  fireObserver(def, inst, 'cardKey', [undefined]);
  assert.ok(inst.data.stageText, '应设置一个默认的 stageText');
});

test('属性为 null 时触发 observer 不抛异常', function () {
  var def = loadComponentDef();
  var inst = makeInstance(def);
  fireObserver(def, inst, 'state', [null]);
  fireObserver(def, inst, 'cardKey', [null]);
});

test('档位文案计算正确', function () {
  var def = loadComponentDef();
  var inst = makeInstance(def);
  fireObserver(def, inst, 'state', [{ stage: 5, wrong_count: 2 }]);
  assert.ok(inst.data.stageText.indexOf('5') >= 0, '文案应包含档位：' + inst.data.stageText);
  assert.ok(inst.data.stageText.indexOf('15 天') >= 0, '文案应包含间隔：' + inst.data.stageText);
});

test('attached 生命周期能跑通（会启动自动揭晓计时）', function () {
  var def = loadComponentDef();
  var inst = makeInstance(def);
  inst.data.revealAfter = 8000;
  def.lifetimes.attached.call(inst);
  assert.ok(inst.autoTimer, 'attached 后应已启动计时器');
  inst.stopAuto();
});

test('attached 时 revealAfter 尚未就绪也不抛异常', function () {
  var def = loadComponentDef();
  var inst = makeInstance(def);
  inst.data.revealAfter = undefined;
  def.lifetimes.attached.call(inst);
  inst.stopAuto();
});

test('完整初始化链路：attached → observers → 渲染数据齐备', function () {
  var def = loadComponentDef();
  var inst = makeInstance(def);

  // 真机顺序通常是 attached 先到，属性随后就绪
  def.lifetimes.attached.call(inst);
  fireObserver(def, inst, 'cardKey', ['abandon']);
  fireObserver(def, inst, 'state', [null]);

  assert.strictEqual(inst.data.revealed, false, '初始应只显示单词');
  assert.strictEqual(inst.data.autoOn, true, '应已开始计时');
  assert.ok(inst.data.stageText, '应有档位文案');
  inst.stopAuto();
});

test('demo 模式初始化不抛异常', function () {
  var def = loadComponentDef();
  var inst = makeInstance(def);
  inst.data.demo = true;
  inst.data.revealAfter = 0;      // 示范卡关闭自动揭晓
  def.lifetimes.attached.call(inst);
  fireObserver(def, inst, 'cardKey', ['abandon']);
  fireObserver(def, inst, 'state', [null]);
  assert.strictEqual(inst.autoTimer, null, '示范卡不应启动计时器');
  assert.strictEqual(inst.data.stageText, '新词（首次学习）');
});

test('派发事件不抛异常：speak / feedback / known', function () {
  var def = loadComponentDef();
  var inst = makeInstance(def);
  inst.onSpeak();
  inst.reveal();                          // 先揭晓答案，反馈才有效
  inst.onFeedback({ currentTarget: { dataset: { fb: 'known' } } });
  assert.ok(inst._events.length >= 2, '应至少派发 reveal 与 feedback');
  inst.stopAuto();
});

console.log('');
if (failed.length) {
  console.log('失败 ' + failed.length + ' 项，通过 ' + passed + ' 项');
  process.exit(1);
} else {
  console.log('全部通过：' + passed + ' 项 ✓');
}
