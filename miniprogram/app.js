/**
 * 小程序入口
 *
 * 云开发初始化必须在小程序启动时完成，且要用 try/catch 包住：
 * 在开发者工具里没开通云环境时，构造 App 期间抛异常会导致整个小程序白屏，
 * 而白屏的报错信息往往只有一句"App 构造失败"，很难定位。
 */

var cloud = require('./utils/cloud');

App({
  globalData: {
    /** 登录后的用户对象（含 _id、member_until 等），未登录为 null */
    user: null,
    /** 云端返回的今日任务快照缓存，避免切页面重复请求 */
    todayTask: null
  },

  onLaunch: function () {
    // 提前拿一次今日日期，供日志与埋点使用（统一走 UTC+8 工具，不要直接 new Date）
    var time = require('./utils/time');
    this.globalData.launchDate = time.getLocalDate();

    var ok = cloud.initCloud();
    if (!ok) {
      // 不抛异常，只记录；页面层会在调用云函数时给出可读提示
      console.warn('[app] 云开发初始化失败：请检查 miniprogram/utils/cloud.js 里的 ENV_ID，' +
        '以及在开发者工具中是否已开通云开发环境。');
      return;
    }
    this.silentLogin();
  },

  /**
   * 静默登录：初始化成功即调 user.login，服务端首次自动建用户。
   * 本地优先设计——失败只打日志，学习流程照走本地兜底，不打扰用户。
   */
  silentLogin: function () {
    var self = this;
    cloud.api.login().then(function (res) {
      self.globalData.user = res.user;
      // 云端统计落一份在本地：清缓存/换设备后，首页"已学词/打卡天数"
      // 不至于归零（云端 stats_cache 是真值，本地镜像只是缓存）
      if (res.user && res.user.stats) {
        wx.setStorageSync('cloud_stats', res.user.stats);
      }
      // 登录成功说明云端可达：趁机把上次失败的学习/抽查记录补传上去
      self.flushPending();
    }).catch(function (err) {
      // ENV_NOT_SET（还没填环境 ID）属预期状态，不刷屏
      if (err && err.code !== 'ENV_NOT_SET') {
        console.warn('[app] 静默登录失败：', err && err.message);
      }
    });
  },

  /**
   * 重放本地补传队列。
   * 只要有一条学习记录没送到云端，家长端就会一直显示"已学 0 词"，
   * 所以这里必须保证最终送达（服务端按 clientReqId 幂等，重放不会重复计数）。
   */
  flushPending: function () {
    if (!cloud.pendingCount()) return;
    cloud.flushPending().then(function (r) {
      if (r.done || r.left) {
        console.log('[app] 补传结果：成功 ' + r.done + ' 条，剩余 ' + r.left + ' 条');
      }
      if (r.done > 0) {
        // 补传改变了云端统计：重拉一次 login 刷新 cloud_stats，
        // 首页"已学词/打卡天数"才能跟上（下次 refresh 直接读）
        cloud.api.login().then(function (res) {
          if (res && res.user && res.user.stats) {
            wx.setStorageSync('cloud_stats', res.user.stats);
          }
        }).catch(function () { /* 刷新失败无所谓，下次登录再更 */ });
      }
    }).catch(function () { /* 补传失败不影响使用，下次再试 */ });
  },

  onShow: function () {
    // 跨天检测：从后台切回时如果已换天，清掉今日任务缓存，强制重新组装
    var time = require('./utils/time');
    var today = time.getLocalDate();
    if (this.globalData.launchDate && this.globalData.launchDate !== today) {
      this.globalData.todayTask = null;
    }
    this.globalData.launchDate = today;

    // 回到前台：再试一次补传（网络可能已经恢复）
    this.flushPending();
  },

  /**
   * 全局错误兜底
   * PC 微信 / iPad 上偶发的"打不开"，往往就是这里能抓到的那一条 ——
   * 微信给的那句"当前网络不稳定"不告诉你是哪一步挂了，这里补上。
   */
  onError: function (msg) {
    console.error('[app] 未捕获错误：', msg);
  },

  /** Promise 里没人接的 reject（云调用链路上最常见） */
  onUnhandledRejection: function (res) {
    console.error('[app] 未处理的 Promise 拒绝：', res && res.reason ? res.reason : res);
  }
});
