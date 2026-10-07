/**
 * 宽屏适配 —— iPad / 折叠屏（阔折叠、横向展开）/ 双屏（Surface Duo）/ PC 窗口
 *
 * 为什么需要它：
 *   小程序用 rpx 布局，rpx 的换算是"750rpx = 屏幕宽度"。在 iPad（768pt+）、
 *   折叠屏展开态（700pt+）、PC 大窗口（1000pt+）上，同样的 30rpx 会被放大到
 *   1.5~2 倍，卡片撑满整屏、按钮巨大、一行只放得下原来的一半内容 —— 就是
 *   "手机上好看、大屏上像放大版手机"的观感。
 *
 * 处理策略（保守、可回退）：
 *   1. 大屏时把内容区限制在 maxW(px) 并居中：不拉伸、不贴边
 *   2. 给根容器加 .wide，由 app.wxss 把关键字号/高度换成 px：
 *      让 rpx 的放大失效，视觉回到手机上的比例
 *   3. 监听 wx.onWindowResize：折叠/展开、iPad 分屏、PC 拖窗口都实时重算，
 *      不用重启小程序
 *
 * 档位按"短边"判断（横竖屏都对）：
 *   phone   < 600pt              手机、折叠屏外屏、PC 窄窗口
 *   tablet  600 ~ 899pt          iPad / iPad mini、折叠展开、Duo 单屏
 *   desktop >= 900pt             iPad Pro 12.9"、PC 大窗口、外接显示器
 */

/** 档位阈值（单位：pt/px，取窗口短边） */
var BREAK_TABLET = 600;
var BREAK_DESKTOP = 900;

/** 各档位的内容区最大宽度（px）。phone 为 0 = 不限制，照旧撑满 */
var MAX_W = { phone: 0, tablet: 640, desktop: 760 };

/**
 * 取窗口尺寸。wx.getWindowInfo 是新接口（基础库 2.20+），
 * 老库退回 getSystemInfoSync；都没有（Node 测试环境）给手机默认值。
 */
function windowInfo() {
  if (typeof wx === 'undefined') return { windowWidth: 375, windowHeight: 667 };
  try {
    if (wx.getWindowInfo) return wx.getWindowInfo();
    if (wx.getSystemInfoSync) return wx.getSystemInfoSync();
  } catch (e) { /* 取不到就走默认值 */ }
  return { windowWidth: 375, windowHeight: 667 };
}

/**
 * 按窗口宽高算档位
 * @param {number} w 窗口宽
 * @param {number} h 窗口高
 * @returns {{mode:string, wide:boolean, maxW:number, minSide:number, ratio:number}}
 */
function compute(w, h) {
  w = Number(w) || 0;
  h = Number(h) || 0;
  var minSide = Math.min(w, h);
  var maxSide = Math.max(w, h);
  var ratio = minSide > 0 ? maxSide / minSide : 1;

  var mode = 'phone';
  if (minSide >= BREAK_DESKTOP) mode = 'desktop';
  else if (minSide >= BREAK_TABLET) mode = 'tablet';

  var maxW = MAX_W[mode] || 0;
  // 内容区不能超过窗口本身（PC 窄窗口兜底）
  if (maxW > 0 && maxW > w - 16) maxW = Math.max(0, w - 16);

  return {
    mode: mode,
    wide: mode !== 'phone',
    maxW: maxW,
    minSide: minSide,
    ratio: Math.round(ratio * 100) / 100
  };
}

/** 当前档位（每次实时取窗口尺寸） */
function current() {
  var i = windowInfo();
  return compute(i.windowWidth, i.windowHeight);
}

/** 根容器的内联样式：大屏才限制宽度并居中 */
function styleOf(layout) {
  if (!layout || !layout.maxW) return '';
  return 'max-width:' + layout.maxW + 'px;margin-left:auto;margin-right:auto';
}

/** 把档位写进页面 data（供 wxml 用 {{layoutWide}} / {{layoutStyle}}） */
function apply(self, w, h) {
  var l = compute(w, h);
  self.setData({
    layoutMode: l.mode,
    layoutWide: l.wide,
    layoutMaxW: l.maxW,
    layoutStyle: styleOf(l)
  });
  return l;
}

/**
 * Page behavior：页面只需 `behaviors: [layout.behavior]`，
 * 根节点写成 <view class="page {{layoutWide ? 'wide' : ''}}" style="{{layoutStyle}}">
 */
function behavior() {
  return Behavior({
    data: {
      layoutMode: 'phone',
      layoutWide: false,
      layoutMaxW: 0,
      layoutStyle: ''
    },
    onLoad: function () {
      var i = windowInfo();
      apply(this, i.windowWidth, i.windowHeight);
      this._bindLayoutResize();
    },
    onShow: function () {
      // 从别的页面返回：窗口可能已经变过（iPad 分屏、PC 拖窗口）
      var i = windowInfo();
      apply(this, i.windowWidth, i.windowHeight);
    },
    onUnload: function () { this._unbindLayoutResize(); },
    onHide: function () { this._unbindLayoutResize(); },

    _bindLayoutResize: function () {
      if (typeof wx === 'undefined' || !wx.onWindowResize) return;
      if (this.__layoutHandler) return;              // 不重复注册
      var self = this;
      this.__layoutHandler = function (res) {
        var size = (res && res.size) || res || {};
        apply(self, size.windowWidth, size.windowHeight);
      };
      try { wx.onWindowResize(this.__layoutHandler); } catch (e) { /* 老基础库忽略 */ }
    },

    _unbindLayoutResize: function () {
      if (!this.__layoutHandler) return;
      if (typeof wx !== 'undefined' && wx.offWindowResize) {
        try { wx.offWindowResize(this.__layoutHandler); } catch (e) { /* 忽略 */ }
      }
      this.__layoutHandler = null;
    }
  });
}

module.exports = {
  BREAK_TABLET: BREAK_TABLET,
  BREAK_DESKTOP: BREAK_DESKTOP,
  MAX_W: MAX_W,
  compute: compute,
  current: current,
  styleOf: styleOf,
  behavior: behavior
};
