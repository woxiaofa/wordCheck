/**
 * 设置页（1.2.0）
 *
 * 为什么要有这一页：底栏原本四个 tab（今日/背词/数据/班级），其中「数据」「班级」
 * 是低频的管理动作，占着一级入口；而新的皮肤功能又需要一个落脚点。
 * 三者收进「设置」，底栏缩到三个：高频动作留在手指够得着的地方，低频的收进来。
 *
 * 不叫「我的」：本应用没有登录态，叫「我的」会让人以为有账号体系，点进去发现什么都没有。
 */

var theme = require('../../utils/theme');
var checkin = require('../../utils/checkin');

Page({
  data: {
    skin: theme.cls(),
    cur: theme.skinId(),
    skins: [],
    doneDays: 0,
    doneNeed: checkin.need()
  },

  onShow: function () {
    this.refresh();
  },

  /** 按当前完成次数重算每套皮肤的解锁态 */
  refresh: function () {
    var activity = wx.getStorageSync('activity_log') || {};
    var done = checkin.doneDays(activity);
    var cur = theme.skinId();
    var list = theme.SKINS.map(function (s) {
      var open = theme.unlocked(s, done);
      var left = s.unlock.type === 'tasks' ? Math.max(0, (s.unlock.need || 0) - done) : 0;
      return {
        id: s.id,
        name: s.name,
        desc: s.desc,
        type: s.unlock.type,
        need: s.unlock.need || 0,
        open: open,
        left: left,
        t: s.tokens
      };
    });
    this.setData({
      skins: list,
      doneDays: done,
      cur: cur,
      skin: theme.cls()
    });
  },

  pick: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    var self = this;
    var item = null;
    this.data.skins.forEach(function (s) { if (s.id === id) item = s; });
    if (!item) return;

    if (!item.open) {
      if (item.type === 'paid') {
        wx.showToast({ title: '付费皮肤暂未开放', icon: 'none', duration: 2000 });
      } else {
        wx.showToast({
          title: '还差 ' + item.left + ' 次完成任务', icon: 'none', duration: 2000
        });
      }
      return;
    }

    if (!theme.set(id)) {
      wx.showToast({ title: '这个皮肤不存在', icon: 'none', duration: 2000 });
      return;
    }
    this.refresh();
    wx.showToast({ title: '已换成「' + item.name + '」', icon: 'none', duration: 1500 });
    void self;
  },

  go: function (e) {
    var path = e.currentTarget.dataset.path;
    if (path) wx.navigateTo({ url: path });
  }
});
