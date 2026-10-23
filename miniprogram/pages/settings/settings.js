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
    theme.syncPage(this);
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
    // 不等下一次 onShow，当场就换：syncPage 一次办两件（skin 类 + 导航栏），
    // 导航栏那一枪自带重试，转场中也补得上。
    theme.syncPage(this);
    this.refresh();
    wx.showToast({ title: '已换成「' + item.name + '」', icon: 'none', duration: 1500 });
    // 整栈重载（2026-10-23 用户拍板）：
    // syncPage 管的是显示层，但页面里还有一批「创建时算一次」的运行时状态
    // （抽查页的答案镜像、学习页的当日队列、布局宽屏标记），换肤后它们仍是旧的，
    // 表现就是「切回默认了，某处还留着粉」。reLaunch 把整栈重建，一处清干净。
    // 换肤是低频动作，回首页这点代价换「不再有残留」，值。
    // 延后 600ms：让「已换成…」的 toast 先落地，跳太早等于没提示。
    setTimeout(function () {
      wx.reLaunch({ url: '/pages/index/index' });
    }, 600);
  },

  go: function (e) {
    var path = e.currentTarget.dataset.path;
    if (path) wx.navigateTo({ url: path });
  }
});
