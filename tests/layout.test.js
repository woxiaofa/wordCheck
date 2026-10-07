/**
 * 宽屏档位计算（utils/layout.js）的单元自证
 *
 * 钉死三件事：
 *   1. 手机/折叠屏外屏仍是 phone（不限制宽度，行为和改版前一致）
 *   2. iPad / 折叠展开 / Duo 单屏是 tablet，内容区 640px 居中
 *   3. iPad Pro 12.9" / PC 大窗口是 desktop，760px；且内容区不会超过窗口本身
 */
var assert = require('assert');
var layout = require('../miniprogram/utils/layout');

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('✓ ' + name); }
  catch (e) { console.log('✗ ' + name + '\n   ' + e.message); process.exitCode = 1; }
}

ok('① 手机竖屏/横屏 → phone，不限制宽度（照旧撑满）', function () {
  var a = layout.compute(390, 844);
  assert.strictEqual(a.mode, 'phone');
  assert.strictEqual(a.wide, false);
  assert.strictEqual(a.maxW, 0, '手机上不应限制宽度');
  assert.strictEqual(layout.styleOf(a), '');
  // 横屏：短边 390 < 600，仍是 phone
  assert.strictEqual(layout.compute(844, 390).mode, 'phone');
});

ok('② 折叠屏外屏（窄长条）→ phone，不误判成大屏', function () {
  // 华为 Pura X 外屏 / 三星 Fold 外屏：竖着很窄
  var a = layout.compute(340, 980);
  assert.strictEqual(a.mode, 'phone', '外屏不该按长边算成平板，实际 ' + a.mode);
});

ok('③ iPad 竖屏/横屏 → tablet，640px 居中', function () {
  var v = layout.compute(768, 1024);
  var h = layout.compute(1024, 768);
  assert.strictEqual(v.mode, 'tablet');
  assert.strictEqual(h.mode, 'tablet', '横屏按短边判档，不该变成 desktop');
  assert.strictEqual(v.maxW, 640);
  assert.strictEqual(layout.styleOf(v), 'max-width:640px;margin-left:auto;margin-right:auto');
});

ok('④ 折叠屏展开（Mate X / 阔折叠）→ tablet', function () {
  var a = layout.compute(717, 1024);   // Mate X 展开近似
  var b = layout.compute(760, 1180);   // 阔折叠（16:10 展开）
  assert.strictEqual(a.mode, 'tablet', '实际 ' + a.mode);
  assert.strictEqual(b.mode, 'tablet', '实际 ' + b.mode);
});

ok('⑤ 双屏 Duo：单屏 phone/tablet 都对，跨屏超宽比不算窄屏', function () {
  var single = layout.compute(720, 843);   // Duo 单屏
  var span = layout.compute(1350, 843);    // Duo 跨屏（比例 1.6）
  assert.ok(span.minSide >= layout.BREAK_TABLET, '跨屏短边 843 应进 tablet 档');
  assert.strictEqual(span.mode, 'tablet');
  assert.ok(span.ratio >= 1.5, '应识别出超宽比 ' + span.ratio);
  assert.strictEqual(single.mode, 'tablet');
  // 跨屏时内容区居中：左右各留 (1350-640)/2 = 355px，不会顶到屏幕两端
  assert.ok(layout.styleOf(span).indexOf('max-width:640px') === 0);
});

ok('⑥ iPad Pro 12.9" / PC 大窗口 → desktop，760px', function () {
  var a = layout.compute(1024, 1366);
  var b = layout.compute(1440, 900);
  assert.strictEqual(a.mode, 'desktop');
  assert.strictEqual(b.mode, 'desktop');
  assert.strictEqual(a.maxW, 760);
});

ok('⑦ PC 窄窗口不至于把内容区压没了（兜底）', function () {
  var a = layout.compute(620, 800);   // 刚过 tablet 线，但 640 > 620-16
  assert.ok(a.maxW > 0 && a.maxW <= 620 - 16, '内容区应收敛到窗口内，实际 ' + a.maxW);
});

ok('⑧ 尺寸为 0 / 缺失时不崩（某些机型首帧拿不到尺寸）', function () {
  var a = layout.compute(0, 0);
  assert.strictEqual(a.mode, 'phone');
  var b = layout.compute(undefined, undefined);
  assert.strictEqual(b.mode, 'phone');
});

ok('⑨ Node 无 wx 环境下 current() 有默认值，不抛异常', function () {
  assert.strictEqual(typeof wx, 'undefined', '测试前提：本文件在 Node 里跑');
  var a = layout.current();
  assert.strictEqual(a.mode, 'phone');
});

console.log('\n通过：' + pass + ' 项 ✓');
