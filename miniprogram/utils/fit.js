/**
 * 横竖屏提示（2026-10-09 用户反馈：iPad 横屏下宽度自适应会把内容放得特别大，
 * 一屏显示不了多少）。儿童学习场景竖屏握持自然，做完整横屏布局成本高收益低，
 * 所以策略是：检测到横屏就给一条温和的提示，建议竖屏使用 —— 不打断、不强制。
 */
function isLandscape() {
  try {
    var info = wx.getSystemInfoSync();
    return info.windowWidth > info.windowHeight;
  } catch (e) {
    return false;
  }
}

/** 页面接三行代码就能用：
 *   data: { landscape: fit.isLandscape() }
 *   onResize: function () { this.setData({ landscape: fit.isLandscape() }); }
 *   onShow 也可以补一次（从后台回来旋转过的情况）
 */
module.exports = { isLandscape: isLandscape };
