/**
 * 数据看板与错词本
 *
 * 指标口径（必须与方案文档 9.1 一致，不要各页面自己定义）：
 *   连续打卡 = 当日完成量 ≥ 每日目标的 80%；中断一天归零
 *   掌握率   = 档位 ≥5 的词数 / 已学词数（间隔已拉到 15 天以上）
 */

var WORDS = require('../../data/words');
var srs = require('../../utils/srs');
var time = require('../../utils/time');
var report = require('../../utils/report');

var STORAGE_KEY = 'word_state_mirror';
var ACTIVITY_KEY = 'activity_log';
var TARGET_PER_DAY = 20;
var CHECKIN_RATIO = 0.8;
var HEAT_LEVELS = ['#1e2a38', '#1d4f74', '#2b7fb8', '#3ea6ff', '#7c5cff'];

/** 日报 / 周报 / 月报三档；区间长度就是报告口径 */
var RANGES = [
  { key: 'day', name: '日报', days: 1 },
  { key: 'week', name: '周报', days: 7 },
  { key: 'month', name: '月报', days: 30 }
];

Page({
  data: {
    mastery: 0,
    streak: 0,
    learned: 0,
    wrongCount: 0,
    wrongList: [],
    heat: [],
    heatSum: 0,

    /* ---- 日报 / 周报 / 月报 ---- */
    ranges: RANGES,
    range: 'week',
    rpt: null
  },

  onShow: function () {
    this.refresh();
  },

  /** 切换日报/周报/月报 */
  onRange: function (e) {
    var key = e.currentTarget.dataset.key;
    this.setData({ range: key });
    this.buildReport(key);
  },

  buildReport: function (key) {
    var r = null;
    for (var i = 0; i < RANGES.length; i++) if (RANGES[i].key === key) r = RANGES[i];
    if (!r) return;
    this.setData({ rpt: report.build(r.days, this.defOf()) });
  },

  /** 词 → 中文释义（错词榜要显示释义） */
  defOf: function () {
    var map = {};
    for (var i = 0; i < WORDS.length; i++) map[WORDS[i].word] = WORDS[i].def_cn;
    return function (w) { return map[w] || ''; };
  },

  /** 点趋势条：告诉家长这天具体练了多少 */
  onBarTap: function (e) {
    var d = e.currentTarget.dataset.date;
    var t = e.currentTarget.dataset.total;
    wx.showToast({
      title: d + '：' + t + ' 题' + (Number(t) === 0 ? '（这天没练）' : ''),
      icon: 'none'
    });
  },

  refresh: function () {
    var mirror = wx.getStorageSync(STORAGE_KEY) || {};
    var activity = wx.getStorageSync(ACTIVITY_KEY) || {};

    var learned = 0, mastered = 0;
    var wrongList = [];
    for (var i = 0; i < WORDS.length; i++) {
      var w = WORDS[i];
      var st = mirror[w.word];
      if (!st) continue;
      learned++;
      if (srs.isMastered(st)) mastered++;
      if (st.wrong_count > 0 && st.last_feedback !== 'known') {
        wrongList.push({
          word: w.word,
          def_cn: w.def_cn,
          wrong_count: st.wrong_count,
          hot: st.wrong_count >= 3
        });
      }
    }
    wrongList.sort(function (a, b) { return b.wrong_count - a.wrong_count; });

    this.setData({
      mastery: learned ? Math.round(mastered / learned * 100) : 0,
      learned: learned,
      streak: this.calcStreak(activity),
      wrongCount: wrongList.length,
      wrongList: wrongList.slice(0, 30),
      heat: this.buildHeat(activity),
      heatSum: this.sumHeat(activity)
    });

    this.buildReport(this.data.range);
  },

  calcStreak: function (activity) {
    var need = Math.round(TARGET_PER_DAY * CHECKIN_RATIO);
    var streak = 0;
    var d = time.getLocalDate();
    if ((activity[d] || 0) < need) d = time.shiftLocalDate(d, -1);
    for (var i = 0; i < 400; i++) {
      if ((activity[d] || 0) >= need) { streak++; d = time.shiftLocalDate(d, -1); }
      else break;
    }
    return streak;
  },

  /** 近 30 天热力图，格子颜色按当日完成次数分档 */
  buildHeat: function (activity) {
    var today = time.getLocalDate();
    var out = [];
    for (var back = 29; back >= 0; back--) {
      var d = time.shiftLocalDate(today, -back);
      var c = activity[d] || 0;
      var level = c === 0 ? 0 : (c < 15 ? 1 : (c < 25 ? 2 : (c < 40 ? 3 : 4)));
      out.push({ date: d, count: c, color: HEAT_LEVELS[level] });
    }
    return out;
  },

  sumHeat: function (activity) {
    var today = time.getLocalDate();
    var sum = 0;
    for (var back = 0; back < 30; back++) sum += (activity[time.shiftLocalDate(today, -back)] || 0);
    return sum;
  },

  onHeatTap: function (e) {
    var d = e.currentTarget.dataset.date;
    var c = e.currentTarget.dataset.count;
    wx.showToast({
      title: d + '：完成 ' + c + ' 次' + (Number(c) === 0 ? '（空着，这就是要催的信号）' : ''),
      icon: 'none'
    });
  }
});
