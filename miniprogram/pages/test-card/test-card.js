/**
 * 开发调试页（内测期保留，正式上线前从 app.json 移除）
 *
 * 存在的唯一理由：本地示例词库只有 40 个词，每轮给 10 个新词，
 * 4 轮就全部学完，之后 SRS 把它们推到未来 —— 接下来连续几天打开都是"没有单词数据"。
 * 内测时想反复体验首日流程，就必须能一键把进度清回全新状态。
 *
 * 真机上要重置：进这个页面点"清空本地进度"，或直接删除小程序再扫码（storage 会一起清掉）。
 */

var WORDS = require('../../data/words');

var STORAGE_KEY = 'word_state_mirror';
var ACTIVITY_KEY = 'activity_log';
var KEYS_TO_CLEAR = [
  STORAGE_KEY,
  ACTIVITY_KEY,
  'onboard_v1_home',
  'onboard_v1_gesture'
];

Page({
  data: {
    learned: 0,
    total: WORDS.length,
    today: 0
  },

  onShow: function () {
    var mirror = wx.getStorageSync(STORAGE_KEY) || {};
    var activity = wx.getStorageSync(ACTIVITY_KEY) || {};
    var time = require('../../utils/time');
    this.setData({
      learned: Object.keys(mirror).length,
      today: activity[time.getLocalDate()] || 0
    });
  },

  goStudy: function () {
    wx.redirectTo({ url: '/pages/study/study' });
  },

  resetProgress: function () {
    var self = this;
    wx.showModal({
      title: '清空本地进度',
      content: '会清掉学习记录、打卡与引导状态，' + WORDS.length +
        ' 个示例词恢复成全新。仅影响本机，不会动云端数据。',
      confirmText: '清空',
      success: function (res) {
        if (!res.confirm) return;
        for (var i = 0; i < KEYS_TO_CLEAR.length; i++) {
          wx.removeStorageSync(KEYS_TO_CLEAR[i]);
        }
        wx.showToast({ title: '已清空，可以重来一遍', icon: 'none' });
        self.onShow();
      }
    });
  }
});
