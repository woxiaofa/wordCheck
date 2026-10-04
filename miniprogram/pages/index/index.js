/**
 * 今日任务页
 *
 * 设计意图（与方案文档 1.3 / 6.1 一致）：**一眼一个动作**。
 * 首页只回答两件事——"今天要做多少"和"点哪里开始"。
 * 具体的复习/错词/新词拆分只作为副标题交代进度，不要求用户做题量决策。
 */

var WORDS = require('../../data/words');
var srs = require('../../utils/srs');
var time = require('../../utils/time');

var STORAGE_KEY = 'word_state_mirror';
var TARGET_PER_DAY = 20;      // 每日目标词数（打卡按 80% 判定）
var NEW_LIMIT = 10;           // 每日新词上限
var CHECKIN_RATIO = 0.8;

Page({
  data: {
    totalCount: 0,
    breakdown: '',
    streak: 0,
    mastery: 0,
    learned: 0,
    done: 0,
    target: TARGET_PER_DAY,
    progressPct: 0
  },

  onShow: function () {
    this.refresh();
  },

  refresh: function () {
    var mirror = wx.getStorageSync(STORAGE_KEY) || {};
    var now = Date.now();
    var today = time.getLocalDate();

    var due = 0, wrong = 0, fresh = 0, learned = 0, mastered = 0;
    for (var i = 0; i < WORDS.length; i++) {
      var st = mirror[WORDS[i].word];
      if (!st) { fresh++; continue; }
      learned++;
      if (srs.isMastered(st)) mastered++;
      if (st.next_review_at && st.next_review_at <= now) due++;
      else if (st.wrong_count > 0 && st.last_feedback !== 'known') wrong++;
    }

    var newToday = Math.min(fresh, NEW_LIMIT);
    var total = due + wrong + newToday;

    // 今日已完成：用打卡记录里的当天计数（学习页每提交一次反馈累加一次）
    var activity = wx.getStorageSync('activity_log') || {};
    var done = activity[today] || 0;
    var target = Math.max(TARGET_PER_DAY, total);
    var progressPct = target ? Math.min(100, Math.round(done / target * 100)) : 0;

    this.setData({
      totalCount: total,
      breakdown: '到期复习 ' + due + ' · 错词 ' + wrong + ' · 新词 ' + newToday,
      streak: this.calcStreak(activity),
      mastery: learned ? Math.round(mastered / learned * 100) : 0,
      learned: learned,
      done: done,
      target: target,
      progressPct: progressPct
    });
  },

  /** 连续打卡：当天完成量达到目标的 80% 即算，中断一天归零 */
  calcStreak: function (activity) {
    var need = Math.round(TARGET_PER_DAY * CHECKIN_RATIO);
    var streak = 0;
    var d = time.getLocalDate();
    // 今天还没完成不算断：从昨天开始往前数
    if ((activity[d] || 0) < need) d = time.shiftLocalDate(d, -1);
    for (var i = 0; i < 400; i++) {
      if ((activity[d] || 0) >= need) { streak++; d = time.shiftLocalDate(d, -1); }
      else break;
    }
    return streak;
  },

  goStudy: function () {
    wx.redirectTo({ url: '/pages/study/study' });
  },

  goQuiz: function () {
    wx.redirectTo({ url: '/pages/quiz/quiz' });
  }
});
