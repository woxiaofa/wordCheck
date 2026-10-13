/**
 * 广告（流量主）封装 —— 只为"覆盖云费"，不为赚钱。
 *
 * 设计原则（2026-10-13 定，写死别改）：
 *   1. 默认关闭。AD_UNITS 里全是空串，提审版不带任何广告，
 *      等小程序上线、累计 UV 达标、后台开通流量主并拿到 adUnitId 后才填。
 *   2. 广告永远不阻断功能。没配置 / 没填充 / 用户看一半退出 / 报错，
 *      都当作"没看"，直接放行 —— 奖励是额外的，不能变成拦路收费。
 *   3. 只放"用户主动想要某个额外好处"的位置（导出长图、额外复习、解锁词库），
 *      绝不放在做题、提交、看报告这些必经路径上。
 *   4. 孩子做题流程（test-card / drill / quiz / study）禁止引用本文件。
 */

var AD_UNITS = {
  // 拿到 adUnitId 后填这里；留空 = 全站无广告（提审/未开通时的状态）
  reward: '',
  interstitial: '',
  banner: ''
};

var ad = null;

function unitId(kind) {
  return (AD_UNITS[kind] || '').trim();
}

/** 该广告位是否已配置（配置了才可能出现广告） */
function enabled(kind) {
  return !!unitId(kind);
}

/**
 * 激励视频。无论结果如何都回调一次，回调参数是"是否完整看完"。
 * 调用方必须把 false 也当通过处理（看广告换的是额外奖励，不是通行权）。
 *
 * @param {Function} onDone  (rewarded:boolean) => void
 */
function showReward(onDone) {
  var done = onDone || function () {};
  if (!enabled('reward')) { done(false); return; }

  try {
    if (!wx.createRewardedVideoAd) { done(false); return; }
    if (!ad) {
      ad = wx.createRewardedVideoAd({ adUnitId: unitId('reward') });
      ad.onError(function () { done(false); });
    }
    ad.onClose(function (res) {
      // res.isEnded 为真表示完整看完；部分机型字段缺失，一律按"没看完"安全处理
      done(!!(res && res.isEnded));
    });
    ad.load().then(function () { return ad.show(); })
      .catch(function () {
        // 没库存（fill rate 为 0 是常态）也直接放行，不能卡住用户
        ad.show().catch(function () { done(false); });
      });
  } catch (e) {
    done(false);
  }
}

module.exports = {
  enabled: enabled,
  showReward: showReward,
  /** 供测试读取当前配置，判断是不是"提审纯净版" */
  units: AD_UNITS
};
