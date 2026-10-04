/**
 * 单词发音 —— 微信同声传译插件（WechatSI，官方免费）
 *
 * 为什么选它（详见 docs/词库与发音方案.md 2.2/2.3）：
 *   - 官方插件、免费、个人主体可用，不用申请任何第三方 key
 *   - textToSpeech 返回临时音频路径，直接播，不用自己管域名白名单
 *   - 规模化后（听写题上线）再换 Piper 预生成 + 云存储，本模块的对外接口不变
 *
 * 前置条件（人工一步）：小程序后台添加插件
 *   mp.weixin.qq.com → 设置 → 第三方设置 → 插件管理 → 搜索"同声传译"
 *   （AppID wx069ba97219f66d99，提供商"腾讯"）→ 添加
 *   没添加时 requirePlugin 会抛错，这里兜住并降级为"不可用"，页面只提示、不崩。
 *
 * 实现要点：
 *   1. 全局复用一个 InnerAudioContext，播放前先 stop —— 连点不会叠音
 *   2. 同一个词的音频路径缓存（插件按次计额度，重复点不重复请求）
 *   3. 同一个词的并发请求合并（快速连点只发一次 textToSpeech）
 *   4. requirePlugin 放在 try/catch 里：Node 测试环境、未加插件的环境都不崩
 */

var plugin = null;
try { plugin = requirePlugin('WechatSI'); } catch (e) { plugin = null; }

var audio = null;       // 复用的播放器
var cache = {};         // word -> 临时音频路径
var pending = {};       // word -> [callback]，合并并发请求

/** 插件是否可用（未在小程序后台添加插件时为 false） */
function isAvailable() {
  return !!plugin;
}

function ensureAudio() {
  if (audio) return audio;
  audio = wx.createInnerAudioContext();
  return audio;
}

/** 播放前先停掉上一个：连点时不会两个声音叠在一起 */
function play(src) {
  var ctx = ensureAudio();
  ctx.stop();
  ctx.src = src;
  ctx.play();
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

  if (!plugin || !word) { cb(false); return; }

  // 命中缓存：直接播，不再请求插件（插件按次消耗额度）
  if (cache[word]) { play(cache[word]); cb(true); return; }

  // 同一个词的并发请求合并成一次 textToSpeech
  if (pending[word]) { pending[word].push(cb); return; }
  pending[word] = [cb];

  plugin.textToSpeech({
    lang: 'en_US',
    tts: true,
    content: String(word),
    success: function (res) {
      if (!res || !res.filename) { finish(word, false); return; }
      cache[word] = res.filename;
      play(res.filename);
      finish(word, true);
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
  speak: speak,
  _reset: _reset
};
