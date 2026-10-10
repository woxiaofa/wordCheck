/**
 * 答题音效（2026-10-10 #36，用户反馈"答对给明显的庆祝动画和音效，答错也可以有"）
 *
 * 两个合成短音（scripts/gen_sfx.py 生成，各 ~3KB，随主包走）：
 *   correct.mp3 —— 答对：E5→A5 上行"叮！"，庆祝感
 *   wrong.mp3   —— 答错：180Hz 低沉短音，提醒但不刺耳
 *
 * 与 tts.js 同样的防叠音套路：每个音效复用一个 InnerAudioContext，
 * 播放前先 stop —— 连答对两题不会叠出回声。
 * 播不出来（老基础库/静音环境）静默降级，绝不影响答题流程。
 */

var pool = {};

function play(name) {
  if (typeof wx === 'undefined' || !wx.createInnerAudioContext) return;
  try {
    var a = pool[name];
    if (!a) {
      a = wx.createInnerAudioContext();
      a.src = '/assets/sfx/' + name + '.mp3';
      pool[name] = a;
    }
    a.stop();
    a.play();
  } catch (e) { /* 音效是锦上添花，失败不挡流程 */ }
}

function playCorrect() { play('correct'); }
function playWrong() { play('wrong'); }

/** 测试用：清空复用的音频实例 */
function _reset() { pool = {}; }

module.exports = {
  playCorrect: playCorrect,
  playWrong: playWrong,
  _reset: _reset
};
