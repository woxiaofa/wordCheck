/**
 * 运行环境判断：发布前隐藏调试入口专用。
 *
 * envVersion 三态：develop（工具/开发版）/ trial（体验版）/ release（正式版）。
 * 调试类 UI（云自检、修复历史数据、原始报错文本）只在 develop 与 trial 出现；
 * 正式版一律不渲染 —— 用户看不到、审核员看不到，也不会被当成"功能不完整"扣分。
 *
 * 原则：拿不到环境信息时按 release 处理 —— 宁可少一个调试入口，不能多一个。
 */
function envVersion() {
  try {
    var info = wx.getAccountInfoSync();
    return (info && info.miniProgram && info.miniProgram.envVersion) || 'release';
  } catch (e) {
    return 'release';
  }
}

module.exports = {
  envVersion: envVersion,
  isRelease: function () { return envVersion() === 'release'; },
  /** 开发/体验版才为 true —— 所有调试入口的开关都读它 */
  isDev: function () { return envVersion() !== 'release'; }
};
