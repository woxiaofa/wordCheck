/**
 * 拍照记词草稿箱（D7 承诺的"拍照上传"落地版：拍照存底 → 对照速录）
 *
 * 为什么不是真 OCR：
 *   小程序端做印刷体识别必须挂 OCR 插件或第三方密钥，插件要申请、密钥要付费额度，
 *   通过时间不可控（2026-10-19 用户拍板）。而"拍照 → 回家对照照片录入"这条路人已经走通了：
 *   书店/学校顺手拍一张，回家坐着录，不用抄一遍单词表。所以先把它做到能日常用。
 *
 * 设计要点：
 *   1) 照片只存本机（FileSystemManager.saveFile），不上传云存储 —— 页面上也是这么写的，
 *      承诺了"不上传"就不能偷偷传。
 *   2) 每加一个词立刻落盘 —— "离线整理"的关键就是随时能停下、随时能接着录，
 *      中途退出、被电话打断、杀掉小程序都不该丢已经录的。
 *   3) 选图是隐私接口，只有本文件的 pickPhoto 能调 wx.chooseMedia，别处一律不许裸调
 *      （漏一处就是线上静默失败，上线断言 ⑫ 会拦）。
 */
var privacy = require('./privacy');
var importer = require('./wordimport');

var STORAGE_KEY = 'word_drafts';
var MAX_DRAFTS = 12;      // 草稿上限：超了淘汰最老的（并删照片），别让本机文件无限涨
var MAX_WORDS = importer.MAX_WORDS;

/* ----------------------------- 存储 ----------------------------- */

function list() {
  try {
    var arr = wx.getStorageSync(STORAGE_KEY);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function save(arr) {
  try { wx.setStorageSync(STORAGE_KEY, arr); } catch (e) { /* 测试环境忽略 */ }
}

function get(id) {
  var arr = list();
  for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
  return null;
}

/**
 * id 必须唯一 —— 踩过一次：纯用 Date.now()，同一毫秒内建两份草稿会撞号，
 * 后建的把先建的覆盖掉（淘汰老草稿后新草稿还会"继承"被淘汰那个的号）。
 * 时间戳 + 递增序号，同毫秒、同一次会话内都不会重。
 */
var seq = 0;
function newId() {
  seq += 1;
  return 'd' + Date.now() + '_' + seq;
}

/** 新草稿：拍照后立刻建，哪怕一个词都没录也先占个位（这样"先拍后录"才成立） */
function add(path) {
  var arr = list();
  arr.sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
  while (arr.length >= MAX_DRAFTS) {
    var old = arr.pop();              // 最老的
    unlink(old && old.path);
  }
  var d = { id: newId(), path: path || '', name: '', created_at: Date.now(), words: [] };
  arr.unshift(d);
  save(arr);
  return d;
}

/** 改词表（增量保存的落点）：加一个词、删一个词都走它 */
function setWords(id, words) {
  var arr = list();
  var hit = false;
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].id !== id) continue;
    arr[i].words = (words || []).slice(0, MAX_WORDS);
    hit = true;
    break;
  }
  if (!hit) return false;
  save(arr);
  return true;
}

function setName(id, name) {
  var arr = list();
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].id === id) { arr[i].name = String(name || '').slice(0, 12); save(arr); return true; }
  }
  return false;
}

function setPath(id, path) {
  var arr = list();
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].id === id) { unlink(arr[i].path); arr[i].path = path || ''; save(arr); return true; }
  }
  return false;
}

function remove(id) {
  var arr = list();
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].id === id) { unlink(arr[i].path); continue; }
    out.push(arr[i]);
  }
  save(out);
  return true;
}

/** 删本地照片文件。删不掉就算了 —— 不能因为清不掉一张图就把用户卡住 */
function unlink(path) {
  try {
    if (!path || path.indexOf('http') === 0 || path.indexOf('cloud://') === 0) return;
    var fs = wx.getFileSystemManager && wx.getFileSystemManager();
    if (!fs || !fs.unlink) return;
    fs.unlink({ filePath: path, fail: function () {} });
  } catch (e) { /* 忽略 */ }
}

/* --------------------------- 拍照 / 选图 --------------------------- */

function choose() {
  return new Promise(function (resolve, reject) {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      success: function (res) {
        var f = res && res.tempFiles && res.tempFiles[0];
        if (!f || !f.tempFilePath) { reject(new Error('NO_FILE')); return; }
        resolve(f.tempFilePath);
      },
      fail: function (res) {
        // 2026-10-20 实锤：这里曾经把所有 fail 一律吞成 CANCELED —— 用户拒绝授权、
        // 隐私指引没声明相机/相册，全都"点击无反应"。必须把真原因透传出去：
        //   cancel            → 用户自己取消（静默）
        //   auth deny         → 引导去设置
        //   not declared/隐私 → 提示去后台配置隐私指引
        var msg = String((res && res.errMsg) || '');
        if (msg.indexOf('cancel') >= 0) { reject(new Error('CANCELED')); return; }
        reject(new Error(msg || 'CHOOSE_FAIL'));
      }
    });
  });
}

/**
 * 临时路径当晚会失效，必须另存为本地持久文件。
 * 存不下就退回临时路径：页面上有 binderror 兜底提示重拍，总比直接拒绝拍照好。
 */
function persist(tmp) {
  return new Promise(function (resolve) {
    try {
      var fs = wx.getFileSystemManager && wx.getFileSystemManager();
      if (!fs || !fs.saveFile) { resolve(tmp); return; }
      fs.saveFile({
        tempFilePath: tmp,
        success: function (r) { resolve((r && r.savedFilePath) || tmp); },
        fail: function () { resolve(tmp); }
      });
    } catch (e) { resolve(tmp); }
  });
}

/**
 * 唯一取图入口：隐私授权 → 选图 → 另存持久路径。
 * @returns {Promise<string>} 持久文件路径
 */
function pickPhoto() {
  return privacy.ensure().then(choose).then(persist);
}

module.exports = {
  STORAGE_KEY: STORAGE_KEY,
  MAX_DRAFTS: MAX_DRAFTS,
  MAX_WORDS: MAX_WORDS,
  list: list,
  get: get,
  add: add,
  setWords: setWords,
  setName: setName,
  setPath: setPath,
  remove: remove,
  pickPhoto: pickPhoto
};
