/**
 * 单词发音 —— 本地 mp3 优先，微信同声传译插件兜底
 *
 * 播放优先级（详见 docs/词库与发音方案.md）：
 *   1. 本地预生成音频：Piper（MIT 协议）离线合成，打包在 /assets/audio/<word>.mp3
 *      —— 零网络、零权限、真机必出声，且音色统一
 *   2. 云端 TTS（2026-10-19 新增）：tts 云函数按词合成英文发音存云存储，客户端下载后
 *      缓存到本机，之后零等待。覆盖自定义词库 —— 个人主体搜不到同声传译插件
 *      （2026-10-05 / 10-19 两次实锤），这一级是自定义词库唯一有声路径
 *   3. WechatSI 插件 textToSpeech：保留兜底（当前插件未授权，实际不生效）
 *   4. 都不可用：回调 false，页面给一次性提示，不崩
 *
 * 为什么本地优先：插件需要后台授权（个人主体搜不到），且按次消耗额度；
 * 本地 mp3 是一次性成本（包体积 ~1.5MB），体验最稳。云端合成一次全端共享，
 * 但首次点击要等 1~2 秒，所以只当本地没有时才走。
 *
 * 实现要点：
 *   1. 全局复用一个 InnerAudioContext，播放前先 stop —— 连点不会叠音
 *   2. 词→音频的清单在 data/audio-manifest.js（构建脚本生成），避免运行时探测文件存在性
 *   3. requirePlugin 放在 try/catch 里：Node 测试环境、未加插件的环境都不崩
 *   4. 没有全局 wx 时（Node 测试）同样只回调 false，不抛异常
 */

var manifest = {};
try { manifest = require('../data/audio-manifest.js'); } catch (e) { manifest = {}; }

// 大小写映射：清单里有首字母大写的词（China / Halloween / Christmas…），
// 而 speak() 统一转小写查询 —— 直接查会把 "China" 查成 "china" 然后判无音频。
// 这里建一份 小写 → 原样 的映射，src 必须用原样文件名（真机文件系统大小写敏感）。
var byLower = {};
(function buildLowerMap() {
  for (var k in manifest) {
    if (Object.prototype.hasOwnProperty.call(manifest, k)) byLower[k.toLowerCase()] = k;
  }
})();

var plugin = null;
try { plugin = requirePlugin('WechatSI'); } catch (e) { plugin = null; }

// 云端发音：tts 云函数 + 云存储缓存。wx.cloud 不在（Node 测试/未初始化）时自动降级，
// 行为与没有云端分支时完全一致 —— 这个文件可以安全跑在任何环境。
var audioKeyLib = require('./audio-key');
var CLOUD_CACHE_KEY = 'tts_audio_cache';   // storage：wordKey -> 本地缓存文件路径
var cloudOn = typeof wx !== 'undefined' && !!wx.cloud && typeof wx.cloud.callFunction === 'function';

/**
 * 词文本 → 清单键：空格转连字符（"ice cream" → ice-cream）。
 * 2026-10-10 新版词库收录短语后，mp3 文件名不带空格（gen_audio_piper.py 同规则净化），
 * 这里查表必须做同一转换，否则短语永远查不到本地音频、听写题被判"无音频"。
 */
function fileKey(word) {
  return String(word || '').toLowerCase().replace(/\s+/g, '-');
}

var audio = null;       // 复用的播放器
var cache = {};         // word -> 临时音频路径（仅插件路径需要）
var pending = {};       // word -> [callback]，合并并发请求（仅插件路径需要）

/** 是否有本地音频清单（有则大多数词都能离线发音） */
function hasLocalAudio() {
  for (var k in manifest) { if (Object.prototype.hasOwnProperty.call(manifest, k)) return true; }
  return false;
}

/** 这个词能不能发声：本地清单有，或云端 TTS 可用（第一次点会现场合成并缓存）。
 * 听写题派发靠它 —— 云端可用后自定义词也能出听写题，不再静默降级成拼写。 */
function hasAudio(word) {
  if (!word) return false;
  if (byLower[fileKey(word)]) return true;
  return cloudOn;
}

/** 本地音频路径（用清单里的原样文件名）；不在清单里返回 '' */
function localSrc(word) {
  var orig = word ? byLower[fileKey(word)] : '';
  return orig ? '/pkg-media/assets/audio/' + orig + '.mp3' : '';
}

/** 发音能力是否可用（本地音频 或 插件，任一即可） */
function isAvailable() {
  return hasLocalAudio() || !!plugin;
}

function ensureAudio() {
  if (audio) return audio;
  if (typeof wx === 'undefined' || !wx.createInnerAudioContext) return null;
  audio = wx.createInnerAudioContext();
  return audio;
}

/** 播放前先停掉上一个：连点时不会两个声音叠在一起 */
function play(src) {
  var ctx = ensureAudio();
  if (!ctx) return false;
  try { ctx.stop(); } catch (e) { /* 从没播过时 stop 可能报错，忽略 */ }
  // 关键：先把 src 清空再赋值。同一个 src 直接重赋值时，
  // 部分真机/工具会认为"没换资源"而不重新加载 —— 表现为"点喇叭突然不读了"。
  ctx.src = '';
  ctx.src = src;
  ctx.play();
  return true;
}

function finish(word, ok) {
  var list = pending[word] || [];
  delete pending[word];
  for (var i = 0; i < list.length; i++) list[i](ok);
}

/** 云端发音：storage 本地缓存命中直接播；未命中 → tts 云函数 → 下载 → 存本机 → 写索引 */
function cloudFetch(word, cb) {
  var key = audioKeyLib.key(word);
  if (!key) { cb(false); return; }

  var cacheMap = wx.getStorageSync(CLOUD_CACHE_KEY) || {};
  if (cacheMap[key]) { cb(play(cacheMap[key])); return; }

  // 并发合并：同一个词同时只发一次云端请求（与插件路径共用 pending 机制）
  if (pending[word]) { pending[word].push(cb); return; }
  pending[word] = [cb];

  wx.cloud.callFunction({
    name: 'tts',
    data: { action: 'synthesize', word: word },
    success: function (res) {
      var r = res && res.result;
      if (!r || !r.ok || !r.fileID) { finish(word, false); return; }
      wx.cloud.downloadFile({
        fileID: r.fileID,
        success: function (d) {
          if (!d || !d.tempFilePath) { finish(word, false); return; }
          var dst = wx.env.USER_DATA_PATH + '/tts-' + key + '.mp3';
          var fsm = wx.getFileSystemManager();
          fsm.saveFile({
            tempFilePath: d.tempFilePath,
            filePath: dst,
            success: function () {
              try {
                var m = wx.getStorageSync(CLOUD_CACHE_KEY) || {};
                m[key] = dst;
                wx.setStorageSync(CLOUD_CACHE_KEY, m);
              } catch (e) { /* 索引写失败只影响下次速度，不影响本次 */ }
              finish(word, play(dst));
            },
            fail: function () { finish(word, play(d.tempFilePath)); } // 存不下来至少这次能响
          });
        },
        fail: function () { finish(word, false); }
      });
    },
    fail: function () { finish(word, false); }
  });
}

/**
 * 朗读一个单词
 * @param {string} word 要读的英文单词
 * @param {function(boolean)=} done 播放请求是否成功发起（异步发音结果不在此列）
 */
function speak(word, done) {
  var cb = typeof done === 'function' ? done : function () {};

  if (!word) { cb(false); return; }
  word = String(word).toLowerCase();

  // 1) 本地音频：包内文件，直接播
  var src = localSrc(word);
  if (src) { cb(play(src)); return; }

  // 2) 云端 TTS：本地文件缓存命中秒响，未命中现场合成（首次 1~2 秒）
  if (cloudOn) { cloudFetch(word, cb); return; }

  // 3) 插件兜底（当前未授权，实际走不到这里）
  if (!plugin) { cb(false); return; }

  // 同一个词的并发请求合并成一次 textToSpeech
  if (pending[word]) { pending[word].push(cb); return; }
  pending[word] = [cb];

  plugin.textToSpeech({
    lang: 'en_US',
    tts: true,
    content: word,
    success: function (res) {
      if (!res || !res.filename) { finish(word, false); return; }
      cache[word] = res.filename;
      var okPlay = play(res.filename);
      finish(word, okPlay);
    },
    fail: function () { finish(word, false); }
  });
}

/** 仅测试用：清空内部状态 */
function _reset() {
  cache = {};
  pending = {};
  if (audio) { try { audio.stop(); } catch (e) { /* 忽略 */ } }
  audio = null;
}

module.exports = {
  isAvailable: isAvailable,
  hasLocalAudio: hasLocalAudio,
  hasAudio: hasAudio,
  speak: speak,
  _reset: _reset
};
