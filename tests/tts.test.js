/**
 * 发音模块测试（Node 环境跑，重点验证降级行为）
 *
 * 优先级：本地 mp3（audio-manifest.js 清单）→ WechatSI 插件 → 回调 false。
 * Node 里 requirePlugin 必然拿不到插件，恰好测"无插件不能崩"；
 * 本地音频命中时用 mock 的 wx 验证播放器被正确调用。
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
var manifest = require('../miniprogram/data/audio-manifest.js');

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

// 从清单里取一个真实存在的词；再取一个必然不在清单里的词
var localWord = Object.keys(manifest)[0];
var missingWord = 'zzz-not-in-manifest-zzz';

console.log('发音模块测试：');

ok('清单非空（本地音频已生成）', function () {
  assert.ok(tts.hasLocalAudio(), 'audio-manifest.js 为空 —— 先跑 gen_audio_piper.py + build-audio-manifest.js');
});

ok('本地命中的词：播放器 src 指向 /pkg-media/assets/audio/，回调 true', function () {
  if (!localWord) { throw new Error('清单为空，跳过条件不成立'); }
  calls.length = 0;
  var result = null;
  tts.speak(localWord, function (okFlag) { result = okFlag; });
  assert.strictEqual(result, true);
  assert.strictEqual(calls.length, 1, '应调用一次 play');
  // mock 里记录格式为 "play:<src>"
  var src = calls[0].replace(/^play:/, '');
  assert.ok(src.indexOf('/pkg-media/assets/audio/' + localWord + '.mp3') === 0,
    'src 应为包内音频路径，实际: ' + src);
});

ok('本地命中时不再走插件额度（重复 speak 只重新 play）', function () {
  if (!localWord) { throw new Error('清单为空'); }
  calls.length = 0;
  tts.speak(localWord, function () {});
  tts.speak(localWord, function () {});
  assert.strictEqual(calls.length, 2);
  assert.ok(calls.every(function (c) { return c.replace(/^play:/, '').indexOf('/pkg-media/assets/audio/') === 0; }));
});

ok('大写词（China/Halloween）也能命中发音：查清单大小写不敏感，src 用原样文件名', function () {
  var cap = Object.keys(manifest).filter(function (k) { return k !== k.toLowerCase(); })[0];
  if (!cap) return; // 清单全小写时本用例无对象
  calls.length = 0;
  var result = null;
  assert.strictEqual(tts.hasAudio(cap), true, 'hasAudio 应大小写不敏感');
  tts.speak(cap, function (okFlag) { result = okFlag; });
  assert.strictEqual(result, true, 'speak 回调应为 true');
  assert.ok(calls[0] === 'play:/pkg-media/assets/audio/' + cap + '.mp3',
    'src 应保留原样大小写，实际: ' + calls[0]);
});

ok('清单外 + 无插件：同步回调 false，不抛异常', function () {
  var result = null;
  tts.speak(missingWord, function (okFlag) { result = okFlag; });
  assert.strictEqual(result, false);
});

ok('空词同样回调 false', function () {
  var result = null;
  tts.speak('', function (okFlag) { result = okFlag; });
  assert.strictEqual(result, false);
});

ok('不传回调也不崩（老代码可能直接 tts.speak(w)）', function () {
  if (localWord) tts.speak(localWord); else tts.speak(missingWord);
});

ok('isAvailable()：有本地音频或插件即为 true（Node 下取决于清单）', function () {
  assert.strictEqual(tts.isAvailable(), tts.hasLocalAudio());
});

ok('_reset() 可重复调用不崩', function () {
  tts._reset();
  tts._reset();
});

console.log('\n全部通过：' + pass + ' 项 ✓');
