/**
 * 发音模块测试（Node 环境跑，重点验证降级行为）
 *
 * 优先级：本地 mp3（audio-manifest.js 清单）→ 云端 TTS（tts 云函数）→ WechatSI 插件 → 回调 false。
 * Node 里 requirePlugin 必然拿不到插件，恰好测"无插件不能崩"；
 * 本地音频命中时用 mock 的 wx 验证播放器被正确调用。
 *
 * 两个阶段：
 *   阶段一：mock 里没有 wx.cloud —— 复刻"云端分支不存在"的环境，必须完整退回旧行为
 *   阶段二：mock 里带 wx.cloud —— 验证云端合成、本地缓存、并发合并与失败降级
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

ok('短语命中：词文本带空格，按净化键（空格→连字符）查到本地音频', function () {
  // 2026-10-10 新版词库收录 8 个短语（give up / ice cream / to-do list…），
  // mp3 文件名净化为 ice-cream.mp3 —— tts 查表必须做同一转换，否则短语听写永远"无音频"
  var key = 'ice-cream';
  if (!manifest[key]) return; // 音频未生成时跳过（构建顺序：gen → manifest → 测试）
  assert.strictEqual(tts.hasAudio('ice cream'), true, '短语应能查到音频');
  assert.strictEqual(tts.hasAudio('ICE CREAM'), true, '大小写不敏感');
  calls.length = 0;
  var result = null;
  tts.speak('ice cream', function (okFlag) { result = okFlag; });
  assert.strictEqual(result, true);
  assert.strictEqual(calls[0], 'play:/pkg-media/assets/audio/' + key + '.mp3',
    'src 应指向净化后的文件名，实际: ' + calls[0]);
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

console.log('\n阶段一通过：' + pass + ' 项 ✓');

/* ================ 阶段二：云端 TTS 路径（wx.cloud 可用） ================ */

var storage = {};
var cloudCalls = [];          // 记录 callFunction 入参
var cloudBehavior = { fail: false, result: { ok: true, audio: 'QkFTRTY0' } };
var written = [];

global.wx = {
  createInnerAudioContext: function () {
    var ctx = { src: '', played: 0, stopped: 0 };
    ctx.play = function () { ctx.played++; calls.push('play:' + ctx.src); };
    ctx.stop = function () { ctx.stopped++; };
    ctx.onError = function () {};
    return ctx;
  },
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  env: { USER_DATA_PATH: '/user-data' },
  getFileSystemManager: function () {
    return {
      writeFile: function (o) {
        written.push({ filePath: o.filePath, encoding: o.encoding, data: o.data });
        if (o.success) o.success();
      }
    };
  },
  cloud: {
    callFunction: function (o) {
      cloudCalls.push({ name: o.name, data: o.data });
      if (cloudBehavior.fail) { if (o.fail) o.fail({ errMsg: 'cloud function error' }); return; }
      if (o.success) o.success({ result: cloudBehavior.result });
    }
  }
};

// 重载模块：这次 wx.cloud 存在，cloudOn 应为 true
delete require.cache[require.resolve('../miniprogram/utils/tts')];
var tts2 = require('../miniprogram/utils/tts');
var audioKeyLib = require('../miniprogram/utils/audio-key');

var pass2 = 0;
var chain2 = Promise.resolve();
function okAsync(name, fn) {
  chain2 = chain2.then(function () { return fn(); })
    .then(function () { pass2++; console.log('  ✓ ' + name); })
    .catch(function (e) {
      console.log('  ✗ ' + name + '\n    ' + e.message);
      process.exitCode = 1;
    });
}

console.log('\n阶段二（云端 TTS）：');

okAsync('cloudOn 时：清单外的词 hasAudio 也为 true（自定义词库能出听写题）', function () {
  assert.strictEqual(tts2.hasAudio(missingWord), true);
  return Promise.resolve();
});

okAsync('本地命中的词仍走本地包内音频，不打云端', function () {
  cloudCalls.length = 0;
  var result = null;
  tts2.speak(localWord, function (f) { result = f; });
  assert.strictEqual(result, true);
  assert.strictEqual(cloudCalls.length, 0, '不应发起云端调用');
  return Promise.resolve();
});

okAsync('清单外的词：云端取 base64 → 写本机 → 写缓存索引 → 播放', function () {
  cloudCalls.length = 0; written.length = 0;
  return new Promise(function (resolve) {
    tts2.speak('zzqword', function (f) { resolve(f); });
  }).then(function (f) {
    assert.strictEqual(f, true, '云端成功后回调应为 true');
    assert.strictEqual(cloudCalls.length, 1, '应发起一次 tts 调用');
    assert.strictEqual(cloudCalls[0].name, 'tts');
    assert.strictEqual(cloudCalls[0].data.action, 'synthesize');
    assert.strictEqual(cloudCalls[0].data.word, 'zzqword');
    assert.strictEqual(written.length, 1, '应写一个本地文件');
    assert.strictEqual(written[0].filePath, '/user-data/tts-zzqword.mp3');
    assert.strictEqual(written[0].encoding, 'base64', 'base64 原样写盘');
    assert.strictEqual(written[0].data, 'QkFTRTY0');
    var idx = storage['tts_audio_cache'] || {};
    assert.strictEqual(idx['zzqword'], '/user-data/tts-zzqword.mp3', 'storage 索引应记录映射');
    assert.strictEqual(calls[calls.length - 1], 'play:/user-data/tts-zzqword.mp3');
  });
});

okAsync('第二次播同词：本地缓存命中秒响，不再打云端', function () {
  cloudCalls.length = 0;
  return new Promise(function (resolve) {
    tts2.speak('zzqword', function (f) { resolve(f); });
  }).then(function (f) {
    assert.strictEqual(f, true);
    assert.strictEqual(cloudCalls.length, 0, '缓存命中不应再打云端');
  });
});

okAsync('云端失败：回调 false，不崩也不写缓存', function () {
  cloudBehavior.fail = true;
  return new Promise(function (resolve) {
    tts2.speak('nevercached', function (f) { resolve(f); });
  }).then(function (f) {
    assert.strictEqual(f, false);
    var idx = storage['tts_audio_cache'] || {};
    assert.ok(!idx['nevercached'], '失败不应写缓存索引');
  }).then(function () { cloudBehavior.fail = false; });
});

okAsync('连点同词并发合并：云端只调一次，两个回调都响', function () {
  cloudCalls.length = 0;
  var r1 = null, r2 = null;
  var p = new Promise(function (resolve) {
    tts2.speak('conword', function (f) { r1 = f; });
    tts2.speak('conword', function (f) { r2 = f; resolve(); });
  });
  return p.then(function () {
    assert.strictEqual(cloudCalls.length, 1, '并发应合并成一次云端调用');
    assert.strictEqual(r1, true);
    assert.strictEqual(r2, true);
  });
});

okAsync('audio-key：短语/撇号净化与云端键一致（存了就得找得到）', function () {
  assert.strictEqual(audioKeyLib.key('Ice Cream'), 'ice-cream');
  assert.strictEqual(audioKeyLib.key("don't"), 'dont');
  assert.strictEqual(audioKeyLib.key('  HELLO world '), 'hello-world');
  return Promise.resolve();
});

chain2.then(function () {
  console.log('\n阶段二通过：' + pass2 + ' 项 ✓');
});
