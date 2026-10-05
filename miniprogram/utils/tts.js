/**
 * 单词发音 —— 本地 mp3 优先，微信同声传译插件兜底
 *
 * 播放优先级（详见 docs/词库与发音方案.md）：
 *   1. 本地预生成音频：Piper（MIT 协议）离线合成，打包在 /assets/audio/<word>.mp3
 *      —— 零网络、零权限、真机必出声，且音色统一
 *   2. WechatSI 插件 textToSpeech：后台添加插件后自动启用，覆盖词库外的词
 *   3. 都不可用：回调 false，页面给一次性提示，不崩
 *
 * 为什么本地优先：插件需要后台授权（个人主体曾搜不到），且按次消耗额度；
 * 本地 mp3 是一次性成本（包体积 ~1.5MB），体验最稳。
 *
 * 实现要点：
 *   1. 全局复用一个 InnerAudioContext，播放前先 stop —— 连点不会叠音
 *   2. 词→音频的清单在 data/audio-manifest.js（构建脚本生成），避免运行时探测文件存在性
 *   3. requirePlugin 放在 try/catch 里：Node 测试环境、未加插件的环境都不崩
 *   4. 没有全局 wx 时（Node 测试）同样只回调 false，不抛异常
 */

var manifest = {};
try { manifest = require('../data/audio-manifest.js'); } catch (e) { manifest = {}; }

var plugin = null;
try { plugin = requirePlugin('WechatSI'); } catch (e) { plugin = null; }

var audio = null;       // 复用的播放器
var cache = {};         // word -> 临时音频路径（仅插件路径需要）
var pending = {};       // word -> [callback]，合并并发请求（仅插件路径需要）

/** 是否有本地音频清单（有则大多数词都能离线发音） */
function hasLocalAudio() {
  for (var k in manifest) { if (Object.prototype.hasOwnProperty.call(manifest, k)) return true; }
  return false;
}

/** 本地音频路径；不在清单里返回 '' */
function localSrc(word) {
  if (manifest && manifest[word]) return '/assets/audio/' + word + '.mp3';
  return '';
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
  ctx.stop();
  ctx.src = src;
  ctx.play();
  return true;
}

function finish(word, ok) {
  var list = pending[word] || [];
  delete pending[word];
  for (var i = 0; i < list.length; i++) list[i](ok);
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

  // 2) 插件兜底（词库外的词）
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
  speak: speak,
  _reset: _reset
};
