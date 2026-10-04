/**
 * 学习卡组件 —— 自动揭晓计时的逻辑测试
 *
 *   node tests/word-card.test.js
 *
 * 为什么给一个"UI 组件"的计时逻辑写测试：
 * 这段逻辑出过两次真 bug，而且都只在真机上表现为"8 秒自动揭晓不生效"，
 * 静态检查完全看不出来：
 *   ① 早期写法 `if (!duration) return`：组件 attached 时 properties 尚未就绪，
 *      duration 为 undefined，计时器永不启动；
 *   ② 用 this.autoTimer 做幂等守卫：翻面后 stopAuto 会清空 autoTimer，
 *      于是换到下一个词时被误判为"无需启动"，自动揭晓彻底消失。
 *
 * 本测试用一个极简的组件替身模拟小程序运行环境（setData、properties、生命周期），
 * 不依赖任何第三方库，也不需要在开发者工具里跑。
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

/**
 * 加载组件定义并把它包成一个可实例化的替身
 * 说明：组件源码里 require 了 ../../utils/srs，路径是相对组件的，直接 require 没问题。
 */
function loadComponentDef() {
  var file = path.resolve(__dirname, '../miniprogram/components/word-card/index.js');
  delete require.cache[file];
  // 组件文件调用全局 Component() 注册自己，这里拦截一下拿到定义
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

/** 用组件定义造一个实例替身：把 data、properties 默认值、methods 都挂上去 */
function makeInstance(propOverrides) {
  var def = loadComponentDef();
  var inst = {
    data: {},
    _events: [],
    /* 这两项在真机上由组件自身动态创建；替身必须显式初始化，
       否则 stopAuto() 的 `if (this.autoTimer)` 走假分支、不赋 null，
       测试断言严格相等时会得到 undefined 而不是 null（假失败） */
    autoTimer: null,
    autoEndAt: 0
  };

  // properties 默认值
  Object.keys(def.properties || {}).forEach(function (k) {
    var p = def.properties[k];
    inst.data[k] = (p && typeof p === 'object' && 'value' in p) ? p.value : undefined;
  });
  // data 默认值
  Object.keys(def.data || {}).forEach(function (k) { inst.data[k] = def.data[k]; });
  // 属性覆盖
  Object.keys(propOverrides || {}).forEach(function (k) { inst.data[k] = propOverrides[k]; });

  inst.setData = function (patch) {
    Object.keys(patch).forEach(function (k) { inst.data[k] = patch[k]; });
  };
  inst.triggerEvent = function (name, detail) { inst._events.push({ name: name, detail: detail }); };

  // 挂 method
  Object.keys(def.methods || {}).forEach(function (k) { inst[k] = def.methods[k].bind(inst); });

  // 把需要外部引入的辅助方法（observers 走不到，这里不挂）
  return inst;
}

/** 每次测试前清掉实例上的计时器，避免污染后续用例 */
function cleanup(inst) {
  if (inst && inst.stopAuto) inst.stopAuto();
}

/* ---------------- 异步用例支持 ---------------- */

var pending = 0;
var drained = false;

function testAsync(name, fn) {
  pending++;
  fn(function (err) {
    pending--;
    if (err) {
      failed.push(name);
      console.log('  ✗ ' + name + '\n      ' + err.message);
    } else {
      passed++;
      console.log('  ✓ ' + name);
    }
    if (drained && pending === 0) report();
  });
}

function report() {
  console.log('');
  if (failed.length) {
    console.log('失败 ' + failed.length + ' 项，通过 ' + passed + ' 项');
    process.exit(1);
  } else {
    console.log('全部通过：' + passed + ' 项 ✓');
    process.exit(0);
  }
}

console.log('学习卡组件 · 自动揭晓计时');

test('计时器能启动（防回归：attached 时 properties 未就绪曾导致永不启动）', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.startAuto();
  assert.ok(inst.autoTimer, '应创建计时器');
  assert.ok(inst.autoEndAt > Date.now() - 10, '应记录结束时刻');
  assert.strictEqual(inst.data.autoOn, true, '进度条应显示');
  cleanup(inst);
});

test('重复调用 startAuto 不会重置已经走了的计时（幂等）', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.startAuto();
  var firstEnd = inst.autoEndAt;
  inst.startAuto();               // 模拟页面 onShow 再补一次
  assert.strictEqual(inst.autoEndAt, firstEnd, '结束时刻不应被推后');
  cleanup(inst);
});

test('揭晓答案后 startAuto 不再启动计时', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.reveal();
  assert.strictEqual(inst.data.revealed, true);
  inst.startAuto();
  assert.strictEqual(inst.autoTimer, null, '已看答案不应重新计时');
});

test('换到下一个词时计时能重新启动（防回归：用 autoTimer 做守卫会失效）', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.startAuto();               // 第一个词开始计时
  inst.reveal();                  // 揭晓答案 → stopAuto 把 autoTimer 清空
  assert.strictEqual(inst.autoTimer, null);

  // 换词时由 cardKey 触发 resetCard，这里直接验证它能重新起表
  inst.resetCard();
  assert.strictEqual(inst.data.revealed, false, '应回到只显示单词');
  assert.ok(inst.autoTimer, '换词后应重新计时');
  cleanup(inst);
});

test('revealAfter 显式设为 0 表示关闭该功能', function () {
  var inst = makeInstance({ revealAfter: 0 });
  inst.startAuto();
  assert.strictEqual(inst.autoTimer, null, '关闭时不应创建计时器');
});

test('revealAfter 缺失时按默认 8 秒处理，而不是静默失效', function () {
  var inst = makeInstance({});
  inst.data.revealAfter = undefined;   // 模拟属性尚未就绪
  inst.startAuto();
  assert.ok(inst.autoTimer, '属性未就绪也应能启动（使用默认时长）');
  cleanup(inst);
});

/* 说明：暂停/续算的用例已删除 —— v3 去掉了拖动逻辑，
   相应地也不再有 pauseAuto / resumeAuto。计时现在只在
   开始（startAuto）、揭晓（stopAuto）、换词（resetCard → startAuto）三处变化，
   不存在"被手势暂停后忘了恢复"这条路径。 */

testAsync('超时后自动揭晓，但不会自行跳到下一个词（真实等待计时器触发）', function (done) {
  var inst = makeInstance({ revealAfter: 30 });
  inst.startAuto();
  setTimeout(function () {
    try {
      assert.strictEqual(inst.data.revealed, true, '超时应自动揭晓答案');
      var revealed = inst._events.filter(function (e) { return e.name === 'reveal'; });
      assert.strictEqual(revealed.length, 1, '应发出一次 reveal 事件');
      var advanced = inst._events.filter(function (e) {
        return e.name === 'feedback' || e.name === 'known';
      });
      assert.strictEqual(advanced.length, 0, '超时绝不能代替用户做评价');
      cleanup(inst);
      done();
    } catch (e) {
      cleanup(inst);
      done(e);
    }
  }, 120);
});

test('揭晓后再点卡片不会收起答案（v2 去掉了"点回正面"这条路）', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.startAuto();
  inst.onCardTap();                       // 看答案
  assert.strictEqual(inst.data.revealed, true);
  var eventsAfterFirst = inst._events.length;

  inst.onCardTap();                       // 已经显示答案，点击不应产生任何变化
  assert.strictEqual(inst.data.revealed, true, '答案应保持显示');
  assert.strictEqual(inst._events.length, eventsAfterFirst, '不应再发出事件');
  cleanup(inst);
});

test('点击揭晓答案时保留"想得很快"按钮', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.onCardTap();
  assert.strictEqual(inst.data.revealed, true);
  assert.strictEqual(inst.data.autoRevealed, false);
  assert.strictEqual(inst.data.showKnownBtn, true,
    '主动点开答案可能是想确认一下，这时"确实很快"是合理解读');
  cleanup(inst);
});

test('超时揭晓答案时不显示"想得很快"（已经超时了，这个按钮自相矛盾）', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.reveal(true);
  assert.strictEqual(inst.data.revealed, true);
  assert.strictEqual(inst.data.autoRevealed, true);
  assert.strictEqual(inst.data.showKnownBtn, false, '超时后不应再给"想得很快"');
  cleanup(inst);
});

test('换词复位：收起答案、清掉上滑提示、重置按钮与文案', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.reveal(true);
  inst.setData({ showUp: true });
  assert.strictEqual(inst.data.revealed, true);

  inst.resetCard();                       // 等价于换词时页面调用 / cardKey 触发
  assert.strictEqual(inst.data.revealed, false, '必须收起答案');
  assert.strictEqual(inst.data.autoRevealed, false);
  assert.strictEqual(inst.data.showUp, false, '不应残留上滑提示');
  assert.strictEqual(inst.data.showKnownBtn, false, '按钮配置也应重置');
  assert.strictEqual(inst.data.promptText, '刚才回忆得怎么样？');
  assert.ok(inst.autoTimer, '换词后应重新开始计时');
  cleanup(inst);
});

test('复位后自动揭晓计时确实重新开始（否则新词永远不自动揭晓）', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.reveal(false);                     // 揭晓 → stopAuto 清空计时
  assert.strictEqual(inst.autoTimer, null);
  assert.strictEqual(inst.autoEndAt, 0);

  inst.resetCard();
  assert.ok(inst.autoTimer, '复位后必须重新起表');
  assert.ok(inst.autoEndAt > Date.now(), '结束时刻应是将来');
  cleanup(inst);
});

test('锁定期间点击无效（防连点过掉两个词）', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.lock();
  inst.onCardTap();
  assert.strictEqual(inst.data.revealed, false, '锁定期间点击不应揭晓答案');
  assert.strictEqual(inst._events.length, 0);
  cleanup(inst);
});

test('锁定期间点击反馈按钮无效', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.reveal(false);                 // 先显示答案
  inst._events = [];
  inst.lock();
  inst.onFeedback({ currentTarget: { dataset: { fb: 'known' } } });
  assert.strictEqual(inst._events.length, 0, '锁定期间不应再记一次评价');
  cleanup(inst);
});

test('锁定期间触摸不产生任何手势', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.lock();
  inst.onTouchStart({ touches: [{ clientX: 100, clientY: 300 }] });
  inst.onTouchMove({ touches: [{ clientX: 100, clientY: 200 }] });
  inst.onTouchEnd({ changedTouches: [{ clientX: 100, clientY: 200 }] });
  assert.strictEqual(inst.data.showUp, false);
  assert.strictEqual(inst._events.length, 0, '锁定期间上滑不应生效');
  cleanup(inst);
});

test('locked 属性为 true 时同样拒绝输入（页面可通过属性锁定）', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.setData({ locked: true });
  inst.onCardTap();
  assert.strictEqual(inst.data.revealed, false);
  assert.strictEqual(inst._events.length, 0);
  cleanup(inst);
});

test('lock() 会清掉进行中的手势状态', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.onTouchStart({ touches: [{ clientX: 100, clientY: 300 }] });
  inst.onTouchMove({ touches: [{ clientX: 100, clientY: 200 }] });
  assert.strictEqual(inst.data.showUp, true, '前置条件：上滑提示已出现');
  inst.lock();
  assert.strictEqual(inst.data.showUp, false, '锁定时应清掉上滑提示，避免残留');
  cleanup(inst);
});

test('未揭晓答案时点反馈按钮无效（防止手快跳过回忆）', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.onFeedback({ currentTarget: { dataset: { fb: 'known' } } });
  assert.strictEqual(inst._events.length, 0, '不该发出 feedback 事件');
});

test('揭晓答案后点反馈按钮正常发出事件', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.reveal();
  inst.onFeedback({ currentTarget: { dataset: { fb: 'vague' } } });
  var fb = inst._events.filter(function (e) { return e.name === 'feedback'; });
  assert.strictEqual(fb.length, 1);
  assert.strictEqual(fb[0].detail.feedback, 'vague');
  cleanup(inst);
});

test('反馈按钮缺少 data-fb 时静默忽略（防脏数据）', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.reveal();
  var before = inst._events.length;
  inst.onFeedback({ currentTarget: { dataset: {} } });
  inst.onFeedback({});
  assert.strictEqual(inst._events.length, before, '不应产生额外的 feedback 事件');
  cleanup(inst);
});

test('上滑超过阈值 → 记为「想得很快」，且不揭晓答案', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.startAuto();
  inst.onTouchStart({ touches: [{ clientX: 100, clientY: 300 }] });
  inst.onTouchMove({ touches: [{ clientX: 100, clientY: 220 }] });   // 上滑 80px
  inst.onTouchEnd({ changedTouches: [{ clientX: 100, clientY: 220 }] });

  var known = inst._events.filter(function (e) { return e.name === 'known'; });
  var reveal = inst._events.filter(function (e) { return e.name === 'reveal'; });
  assert.strictEqual(known.length, 1, '应记为想得很快');
  assert.strictEqual(reveal.length, 0, '不应同时揭晓答案');
  assert.strictEqual(inst.data.revealed, false, '卡片应保持未揭晓');
  cleanup(inst);
});

test('下滑不影响计时：松手后继续走，不会重新计时', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.startAuto();
  inst.onTouchStart({ touches: [{ clientX: 100, clientY: 200 }] });
  inst.onTouchMove({ touches: [{ clientX: 100, clientY: 260 }] });
  var endBefore = inst.autoEndAt;
  inst.onTouchEnd({ changedTouches: [{ clientX: 100, clientY: 260 }] });

  assert.ok(inst.autoEndAt <= endBefore + 50, '结束时刻不应被推后（否则计时会被无限拖延）');
  cleanup(inst);
});

test('位移不足阈值 → 不揭晓也不评价', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.startAuto();
  inst.onTouchStart({ touches: [{ clientX: 100, clientY: 200 }] });
  inst.onTouchMove({ touches: [{ clientX: 100, clientY: 230 }] });   // 只有 30px
  inst.onTouchEnd({ changedTouches: [{ clientX: 100, clientY: 230 }] });

  assert.strictEqual(inst.data.revealed, false);
  assert.strictEqual(inst._events.length, 0);
  cleanup(inst);
});

test('横向滑动不触发上滑（避免和页面滚动抢手势）', function () {
  var inst = makeInstance({ revealAfter: 8000 });
  inst.startAuto();
  inst.onTouchStart({ touches: [{ clientX: 100, clientY: 200 }] });
  inst.onTouchMove({ touches: [{ clientX: 260, clientY: 210 }] });   // 横向为主
  inst.onTouchEnd({ changedTouches: [{ clientX: 260, clientY: 210 }] });

  assert.strictEqual(inst._events.length, 0, '横向滑动不应产生任何评价');
  assert.strictEqual(inst.data.revealed, false);
  cleanup(inst);
});

/* ---------------- 汇总 ---------------- */

// 同步用例已全部登记完毕；若还有异步用例在跑，等它们结束再判定
drained = true;
if (pending === 0) report();
