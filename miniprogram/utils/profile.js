/**
 * 用户资料（昵称 / 头像）—— 只用于榜单与荣誉展示
 *
 * 为什么不用 wx.getUserProfile：
 *   2022 年起微信已废弃该接口，现在调用只会拿到灰色默认头像和「微信用户」，
 *   而且新提交的小程序用这种方式会被审核拒。官方现在的合规路径是
 *   「头像昵称填写能力」：
 *     头像 → <button open-type="chooseAvatar" bindchooseavatar="...">
 *     昵称 → <input type="nickname">
 *   两者都必须由用户主动操作，开发者拿不到"静默授权"的信息。
 *   个人主体的小程序同样可以使用这套能力（它不是企业专属）。
 *
 * 头像存哪：本地只留临时路径会失效，必须传到云存储换一个长期 fileID。
 * 上传失败就退化成"只存昵称"，榜单照常显示，不打断用户。
 */

var api = require('./cloud').api;

var KEY = 'wc_profile';

function get() {
  var p = null;
  try { p = wx.getStorageSync(KEY); } catch (e) { p = null; }
  return p || { nickname: '', avatar: '' };
}

function save(patch) {
  var cur = get();
  var next = {
    nickname: patch.nickname !== undefined ? patch.nickname : cur.nickname,
    avatar: patch.avatar !== undefined ? patch.avatar : cur.avatar
  };
  try { wx.setStorageSync(KEY, next); } catch (e) { /* 存储不可用不影响主流程 */ }
  return next;
}

function setNickname(v) {
  v = String(v || '').trim().slice(0, 16);
  var next = save({ nickname: v });
  push(next);
  return next;
}

/**
 * 保存头像：本地临时路径 → 云存储 fileID → 落库
 * @param {string} tmpPath chooseAvatar 给的临时文件路径
 * @param {function} cb 收到最终可用的头像地址（可能是 fileID，也可能失败后退回临时路径）
 */
function setAvatar(tmpPath, cb) {
  if (!tmpPath) return;
  var next = save({ avatar: tmpPath });      // 先本地可用，上传失败也不至于空白
  if (typeof cb === 'function') cb(tmpPath);

  upload(tmpPath, function (fileID) {
    if (!fileID) return;                     // 上传失败：本地已经能显示了，不再折腾
    next = save({ avatar: fileID });
    if (typeof cb === 'function') cb(fileID);
    push(next);
  });
}

/** 上传到云存储。环境没初始化或上传失败都静默返回 null */
function upload(filePath, cb) {
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.uploadFile) { cb(null); return; }
  try {
    wx.cloud.uploadFile({
      cloudPath: 'avatar/' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.png',
      filePath: filePath,
      success: function (res) { cb(res && res.fileID ? res.fileID : null); },
      fail: function () { cb(null); }
    });
  } catch (e) {
    cb(null);
  }
}

/** 同步到云端（失败不影响本地展示；昵称/头像被内容安全拦下时要让孩子知道） */
function push(p) {
  if (!p.nickname && !p.avatar) return;
  api.saveProfile({ nickname: p.nickname, avatar: p.avatar })
    .catch(function (err) {
      // 2026-11-16 提审整改：服务端接了 msgSecCheck，违规昵称/头像会被挡回。
      // 本地已经改成新值，但云端留着旧值 —— 不提示的话，孩子看到的就是
      // 「自己这边改好了，同学那边还是旧名字」，还以为坏了。
      if (err && err.code === 'SEC_BLOCK' && typeof wx !== 'undefined' && wx.showToast) {
        wx.showToast({ title: (err.message || '内容不合规') + '，云端还是原来的', icon: 'none', duration: 3000 });
      }
      console.warn('[profile] 资料同步云端失败（本地仍可用）：',
        (err && (err.errMsg || err.message)) || err);
    });
}

module.exports = {
  get: get,
  setNickname: setNickname,
  setAvatar: setAvatar
};
