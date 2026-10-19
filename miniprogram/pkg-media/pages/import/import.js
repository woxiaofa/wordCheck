/**
 * 添加词库：粘贴 / 表格导入
 *
 * 为什么单独一页：它是一次性的"倒数据"动作，不该挤进首页的每日任务区；
 * 而且需要预览 + 纠错的空间（解析错了要能看见哪几行没进去）。
 */
var books = require('../../utils/books');
var importer = require('../../utils/wordimport');

Page({
  data: {
    text: '',
    name: '',
    parsed: null,        // { words, skipped, total }
    saved: false,
    custom: [],          // 已导入的词库
    toast: ''
  },

  onShow: function () {
    this.setData({ custom: books.customBooks() });
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
      content: '已经切到「' + name + '」，现在去背的就是这份词表。拍照导入会在后面加上。',
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
