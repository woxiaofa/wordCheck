/**
 * 时间与"今天"的判定（共享模块 · 唯一真相来源）
 *
 * ⚠️ 两份副本由 scripts/sync-shared.js 生成，内容必须逐字节一致，勿手改副本：
 *   - miniprogram/utils/time.js  （小程序侧）
 *   - cloud/shared/time.js       （云函数侧）
 *
 * 为什么必须集中处理：云函数运行在 UTC，用户在中国。
 * 若业务代码直接用 new Date() 判断"今天"，晚上 20:00 之后（UTC 已跨日）
 * 任务、打卡、周报都会归到错误的一天，且只在特定时段复现。
 */

var CN_OFFSET_MS = 8 * 60 * 60 * 1000;   // UTC+8

/** 北京时间 Date 对象（用于取字段） */
function toCN(ts) {
  return new Date((ts === undefined ? Date.now() : ts) + CN_OFFSET_MS);
}

/** 北京时间的 YYYY-MM-DD */
function getLocalDate(ts) {
  var d = toCN(ts);
  var y = d.getUTCFullYear();
  var m = String(d.getUTCMonth() + 1).padStart(2, '0');
  var day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** 北京时间当天 00:00 的绝对时间戳 */
function getLocalDayStart(ts) {
  var base = ts === undefined ? Date.now() : ts;
  return Math.floor((base + CN_OFFSET_MS) / 86400000) * 86400000 - CN_OFFSET_MS;
}

/** 北京时间当天 23:59:59.999 的绝对时间戳 */
function getLocalDayEnd(ts) {
  return getLocalDayStart(ts) + 86400000 - 1;
}

/** 日期字符串前后推移 n 天（纯日期算术） */
function shiftLocalDate(dateStr, n) {
  var parts = String(dateStr).split('-');
  var y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
  var base = Date.UTC(y, m - 1, d, 12, 0, 0) + n * 86400000;
  var x = new Date(base);
  return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0') + '-' + String(x.getUTCDate()).padStart(2, '0');
}

/** b - a 的天数（a、b 均为 YYYY-MM-DD） */
function diffDays(a, b) {
  var pa = String(a).split('-'), pb = String(b).split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
}

/** 展示用 'M/D' */
function shortDate(ts) {
  var d = toCN(ts);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
}

/** 两个绝对时间戳相差的自然天数（按北京时间） */
function daysBetweenTs(a, b) {
  return diffDays(getLocalDate(a), getLocalDate(b));
}

module.exports = {
  CN_OFFSET_MS: CN_OFFSET_MS,
  toCN: toCN,
  getLocalDate: getLocalDate,
  getLocalDayStart: getLocalDayStart,
  getLocalDayEnd: getLocalDayEnd,
  shiftLocalDate: shiftLocalDate,
  diffDays: diffDays,
  shortDate: shortDate,
  daysBetweenTs: daysBetweenTs
};
