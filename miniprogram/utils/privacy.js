/**
 * 隐私授权守卫（上线必需）
 *
 * 背景：微信把「剪贴板写入」等接口列入隐私接口清单。小程序只要在
 * app.json 里声明了 "__usePrivacyCheck__": true，调用这些接口前必须先拿到
 * 用户授权，否则线上调用直接失败（开发者工具里常常不报错，很容易漏）。
 * 提审时如果审核员点「复制文案」没反应，也会被判「功能不完整」驳回。
 *
 * 用法：
 *   var privacy = require('../../utils/privacy');
 *   privacy.ensure().then(function () { wx.setClipboardData({...}); });
 *
 * 弹的是微信官方统一授权弹窗（wx.requirePrivacyAuthorize），
 * 不需要我们自己画 UI，文案由公众平台配置的《用户隐私保护指引》决定。
 */
var lastRejectAt = 0;

function ensure() {
  return new Promise(function (resolve, reject) {
    // 老版本基础库没有隐私接口概念，直接放行
    if (!wx.getPrivacySetting) { resolve(true); return; }
    wx.getPrivacySetting({
      success: function (res) {
        if (!res || !res.needAuthorization) { resolve(true); return; }
        if (!wx.requirePrivacyAuthorize) { resolve(true); return; }
        wx.requirePrivacyAuthorize({
          success: function () { resolve(true); },
          fail: function () {
            lastRejectAt = Date.now();
            var e = new Error('PRIVACY_DENIED');
            reject(e);
          }
        });
      },
      // 查询失败不阻断主流程：宁可照旧复制，也不要把用户卡死
      fail: function () { resolve(true); }
    });
  });
}

/**
 * 统一兜底：用户拒绝授权时给一句人话，而不是静默失败。
 *
 * scene 分三档（clipboard / microphone / album），因为「点复制没反应」和
 * 「点录音没反应」要给完全不同的解释。旧调用只传 err，默认仍按剪贴板处理，
 * 6 处既有调用不必改。
 */
var DENY_TEXT = {
  clipboard: '复制文案要用到剪贴板。点「去设置」→ 隐私 → 打开授权后就能用了。',
  microphone: '跟读录音要用到麦克风，录音只存在这台手机、不会上传。点「去设置」→ 隐私 → 打开授权后就能用了。',
  album: '保存图片要用到相册。点「去设置」→ 隐私 → 打开授权后就能用了。'
};

function onDenied(err, scene) {
  if (!err || err.message !== 'PRIVACY_DENIED') return false;
  wx.showModal({
    title: '需要你先同意隐私指引',
    content: DENY_TEXT[scene] || DENY_TEXT.clipboard,
    confirmText: '知道了',
    showCancel: false
  });
  return true;
}

/**
 * 麦克风授权的唯一入口。
 * 顺序很重要：先过《隐私保护指引》的官方弹窗，再查 scope.record；
 * 曾经拒绝过的情况 wx.authorize 不会再弹，只能引导去设置页，否则就是
 * 「点了录音永远没反应」（拍照记词踩过同款坑）。
 */
function ensureRecord() {
  return ensure().then(function () {
    return new Promise(function (resolve, reject) {
      if (!wx.getSetting) { resolve(true); return; }
      wx.getSetting({
        success: function (res) {
          var auth = res && res.authSetting;
          if (auth && auth['scope.record'] === true) { resolve(true); return; }
          if (auth && auth['scope.record'] === false) {
            if (!wx.openSetting) { reject(new Error('MIC_DENIED')); return; }
            wx.openSetting({
              success: function (r) {
                var a = r && r.authSetting;
                if (a && a['scope.record']) resolve(true);
                else reject(new Error('MIC_DENIED'));
              },
              fail: function () { reject(new Error('MIC_DENIED')); }
            });
            return;
          }
          if (!wx.authorize) { resolve(true); return; }
          wx.authorize({
            scope: 'scope.record',
            success: function () { resolve(true); },
            fail: function () { reject(new Error('MIC_DENIED')); }
          });
        },
        // 查询失败不阻断：交给录音管理器自己报错，总比卡住用户好
        fail: function () { resolve(true); }
      });
    });
  });
}

/** 读剪贴板也是隐私接口：统一收口，别处不许裸调 */
function paste(onText) {
  ensure().then(function () {
    wx.getClipboardData({
      success: function (res) { if (onText) onText(String((res && res.data) || '')); },
      fail: function () { wx.showToast({ title: '没读到剪贴板', icon: 'none' }); }
    });
  }).catch(function (err) {
    if (!onDenied(err, 'clipboard')) wx.showToast({ title: '读取失败', icon: 'none' });
  });
}

/**
 * 复制文本的合规写法：先确认隐私授权，再写剪贴板。
 * 全工程所有"复制文案"入口都走这里，避免漏掉某处导致线上静默失败。
 */
function copy(text, onOk) {
  ensure().then(function () {
    wx.setClipboardData({
      data: text,
      success: function () { if (onOk) onOk(); }
    });
  }).catch(function (err) {
    if (!onDenied(err)) wx.showToast({ title: '复制失败', icon: 'none' });
  });
}

module.exports = {
  ensure: ensure,
  ensureRecord: ensureRecord,
  copy: copy,
  paste: paste,
  onDenied: onDenied,
  lastRejectAt: function () { return lastRejectAt; }
};
