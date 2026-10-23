/**
 * 添加词库：粘贴 / 表格导入
 *
 * 为什么单独一页：它是一次性的"倒数据"动作，不该挤进首页的每日任务区；
 * 而且需要预览 + 纠错的空间（解析错了要能看见哪几行没进去）。
 */
var theme = require('../../../utils/theme');
var books = require('../../../utils/books');
var importer = require('../../../utils/wordimport');
var drafts = require('../../../utils/drafts');
var privacy = require('../../../utils/privacy');

Page({
  data: {
    skin: theme.cls(),
    text: '',
    name: '',
    parsed: null,        // { words, skipped, total }
    saved: false,
    custom: [],          // 已导入的词库
    draftList: [],       // 没录完的拍照草稿
    toast: ''
  },

  onShow: function () {
    theme.applyNav();
    this.setData({ custom: books.customBooks(), draftList: drafts.list() });
  },

  /* -------------------- 拍照记词：先拍下来，回家对着照片录 -------------------- */

  takePhoto: function () {
    var self = this;
    drafts.pickPhoto().then(function (path) {
      var d = drafts.add(path);
      wx.navigateTo({ url: '/pkg-media/pages/organize/organize?id=' + d.id });
    }).catch(function (err) {
      if (privacy.onDenied(err)) return;                    // 拒绝隐私指引：给一句人话
      if (err && err.message === 'CANCELED') return;        // 自己取消的，别弹提示
      var msg = String((err && err.message) || '');
      if (msg.indexOf('not declared') >= 0 || msg.indexOf('privacy') >= 0) {
        // 隐私指引没声明相机/相册：端上无解，只能在 mp 后台补配置（配置完即时生效，不用发版）
        wx.showModal({
          title: '暂时拍不了',
          content: '拍照功能要等小程序后台的隐私指引补上「摄像头 / 相册」权限才会生效，我们会尽快修好。',
          showCancel: false,
          confirmText: '知道了'
        });
        return;
      }
      if (msg.indexOf('auth deny') >= 0 || msg.indexOf('authorize') >= 0) {
        wx.showModal({
          title: '需要相机 / 相册权限',
          content: '拍课本词表需要用到相机或相册，去设置里打开就能用了。',
          confirmText: '去设置',
          success: function (r) { if (r.confirm) wx.openSetting(); }
        });
        return;
      }
      wx.showToast({ title: '没拿到照片', icon: 'none' });
    });
  },

  goDraft: function (e) {
    wx.navigateTo({ url: '/pkg-media/pages/organize/organize?id=' + e.currentTarget.dataset.id });
  },

  removeDraft: function (e) {
    var id = e.currentTarget.dataset.id;
    var self = this;
    wx.showModal({
      title: '删掉这份草稿？',
      content: '照片和已经录的词一起删，删了就找不回来了。',
      success: function (res) {
        if (!res.confirm) return;
        drafts.remove(id);
        self.setData({ draftList: drafts.list() });
      }
    });
  },

  onInput: function (e) {
    this.setData({ text: e.detail.value, parsed: null, saved: false });
  },
  onName: function (e) {
    this.setData({ name: e.detail.value });
  },

  /** 先解析再存：让用户看见"进去了多少、哪几行没进去"，不要点了按钮才发现白干 */
  doParse: function () {
    var r = importer.parse(this.data.text);
    this.setData({ parsed: r });
    if (!r.words.length) {
      this.setData({ toast: '没解析出单词 —— 一行一个词，格式看下面的示例' });
      return;
    }
    this.setData({ toast: '' });
  },

  fillSample: function () {
    this.setData({ text: importer.SAMPLE, parsed: null, saved: false });
  },

  doSave: function () {
    var r = this.data.parsed;
    if (!r || !r.words.length) return;
    var name = String(this.data.name || '').trim() || ('我的词库 ' + (books.customBooks().length + 1));
    var key = books.addCustomBook(name, r.words);
    if (!key) return;
    books.setKey(key);       // 导入完直接用这一本，省得再切一次
    var self = this;
    wx.showModal({
      title: '已添加 ' + r.words.length + ' 个词',
      content: '已经切到「' + name + '」，现在去背的就是这份词表。',
      confirmText: '去背单词',
      cancelText: '继续添加',
      success: function (res) {
        if (res.confirm) wx.navigateBack();
        else self.setData({ text: '', name: '', parsed: null, saved: true, custom: books.customBooks() });
      }
    });
  },

  removeBook: function (e) {
    var key = e.currentTarget.dataset.key;
    var self = this;
    wx.showModal({
      title: '删掉这个词库？',
      content: '只是删本机这份词表，已经记住的词不受影响。',
      success: function (res) {
        if (!res.confirm) return;
        books.removeCustomBook(key);
        self.setData({ custom: books.customBooks() });
      }
    });
  },

  goBack: function () { wx.navigateBack(); }
});
