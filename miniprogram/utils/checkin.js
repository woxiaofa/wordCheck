/**
 * 打卡与「完成任务次数」的判定（1.2.0）
 *
 * 为什么抽出来：这两个常量原本在 index.js 和 stats.js 里各抄了一份
 * （TARGET_PER_DAY / CHECKIN_RATIO），皮肤解锁要用到同样判定，
 * 第三处再抄一遍必然出现「首页显示已完成、解锁却不算」的分歧。
 * 单一真相放这里，两个入口页面后续也应当改用它。
 *
 * 判定口径：当天完成量达到每日目标的 80% 即算一次「完成任务」。
 */

var TARGET_PER_DAY = 20;      // 每日目标词数
var CHECKIN_RATIO = 0.8;      // 达到目标的这比例就算完成

/** 算「完成任务」的阈值（词数） */
function need() {
  return Math.round(TARGET_PER_DAY * CHECKIN_RATIO);
}

/**
 * 累计完成任务次数（不是连续天数）
 * @param {Object} activity 形如 { '2026-10-23': 18, ... }，来自 storage 的 activity_log
 * @return {number} 达标过的天数
 */
function doneDays(activity) {
  var need = Math.round(TARGET_PER_DAY * CHECKIN_RATIO);
  var n = 0;
  if (!activity) return 0;
  for (var d in activity) {
    if (!Object.prototype.hasOwnProperty.call(activity, d)) continue;
    if ((activity[d] || 0) >= need) n++;
  }
  return n;
}

module.exports = {
  TARGET_PER_DAY: TARGET_PER_DAY,
  CHECKIN_RATIO: CHECKIN_RATIO,
  need: need,
  doneDays: doneDays
};
