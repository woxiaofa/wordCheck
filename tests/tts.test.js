/**
 * 发音模块测试（Node 环境跑，重点验证降级行为）
 *
 * 微信同声传译插件只在真机/开发者工具里存在，Node 里 requirePlugin 必然拿不到。
 * 恰好要测的就是"拿不到插件时不能崩、必须明确回调 false"——
 * 真机上插件没添加时的表现与此一致。
 */

var assert = require('assert');

var calls = [];
global.wx = {
  createInnerAudioContext: function () {
    var ctx = { src: '', played: 0, stopped: 0 };
    ctx.play = function () { ctx.played++; calls.push('play:' + ctx.src); };
    ctx.stop = function () { ctx.stopped++; };
    ctx.onError = function () {};
    return ctx;
  }
};

var tts = require('../miniprogram/utils/tts');

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('发音模块测试：');

ok('Node 环境下 isAvailable() 为 false，且不抛异常', function () {
  assert.strictEqual(tts.isAvailable(), false);
});

ok('无插件时 speak() 同步回调 false，不抛异常', function () {
  var result = null;
  tts.speak('apple', function (okFlag) { result = okFlag; });
  assert.strictEqual(result, false);
});

ok('不传回调也不崩（老代码可能直接 tts.speak(w)）', function () {
  tts.speak('apple');
});

ok('空词同样回调 false', function () {
  var result = null;
  tts.speak('', function (okFlag) { result = okFlag; });
  assert.strictEqual(result, false);
});

ok('_reset() 可重复调用不崩', function () {
  tts._reset();
  tts._reset();
});

console.log('\n全部通过：' + pass + ' 项 ✓');
