/**
 * 句 / 小段示范音播放 —— 只播包内 Piper 离线合成 mp3，零联网、零云端兜底。
 *
 * 和 utils/tts.js 的区别必须说清楚：tts.js 有云端 TTS 兜底（自定义词库要用），
 * 而体验课承诺"录音不上传、材料全在本机"，这里刻意**不接**任何网络路径：
 * 音频文件不存在就明说没有，绝不悄悄发请求，也不装作读过了。
 *
 * 复用一个 InnerAudioContext：连点不会两个声音叠在一起；赋值前先清空 src，
 * 否则部分真机对"同一个 src 重赋值"不重新加载（tts.js 里踩过这个坑）。
 */

var ctx = null;

function ensure() {
  if (ctx) return ctx;
  if (typeof wx === 'undefined' || !wx.createInnerAudioContext) return null;
  ctx = wx.createInnerAudioContext();
  return ctx;
}

/** @returns {boolean} 是否成功发起播放（异步是否真的出声不在此列） */
function play(src) {
  if (!src) return false;
  var c = ensure();
  if (!c) return false;
  try {
    try { c.stop(); } catch (e) { /* 没播过时 stop 可能报错，忽略 */ }
    c.src = '';
    c.src = src;
    c.play();
    return true;
  } catch (e) {
    return false;
  }
}

function stop() {
  if (!ctx) return false;
  try { ctx.stop(); } catch (e) { /* 忽略 */ }
  return true;
}

module.exports = {
  play: play,
  stop: stop
};
