/**
 * 对照照片整理词表（D7"拍照上传"的落地形态：拍照存底 → 回家照着录）
 *
 * 为什么单独一页：对照录入要"照片够大 + 手不用离开键盘"，塞进导入页会两头都变小。
 * 关键体验是**随时能停下**：每加一个词立刻写进草稿，退出、被打断、杀进程都不丢，
 * 下次从草稿箱进来接着录 —— 这才是"离线整理"的意思。
 */
var books = require('../../../utils/books');
var drafts = require('../../../utils/drafts');
var importer = require('../../../utils/wordimport');
var privacy = require('../../../utils/privacy');

Page({
  data: {
    id: '',
    img: '',
    imgBroken: false,
    name: '',
    w: '',
    d: '',
    focusW: false,
    words: [],
    toast: ''
  },

  onLoad: function (q) {
    var id = (q && q.id) || '';
    var d = drafts.get(id);
    if (!d) {
      this.setData({ toast: '这份草稿找不到了，回导入页重新拍一张吧' });
      return;
    }
    this.setData({
      id: id,
      img: d.path || '',
      name: d.name || '',
      words: d.words || [],
      imgBroken: false
    });
  },

  onW: function (e) { this.setData({ w: e.detail.value, toast: '' }); },
  onD: function (e) { this.setData({ d: e.detail.value, toast: '' }); },
  onName: function (e) { this.setData({ name: e.detail.value }); },

  /** 加一个词：清空输入并把光标送回英文框，连续录入不用一直点 */
  addWord: function () {
    var w = String(this.data.w || '').trim();
    var d = String(this.data.d || '').trim();
    if (!w) { this.setData({ toast: '先填英文单词' }); return; }
    if (!importer.isWord(w)) { this.setData({ toast: '「' + w + '」不像英文单词' }); return; }
    var low = w.toLowerCase();
    var dup = false;
    this.data.words.forEach(function (x) {
      if (String(x.word).toLowerCase() === low) dup = true;
    });
    if (dup) { this.setData({ toast: '「' + w + '」已经录过了' }); return; }
    if (this.data.words.length >= drafts.MAX_WORDS) {
      this.setData({ toast: '一本词库最多 ' + drafts.MAX_WORDS + ' 个词' });
      return;
    }
    var words = this.data.words.concat([{ word: w, def_cn: d }]);
    drafts.setWords(this.data.id, words);      // 立刻落盘：中途退出不丢
    var self = this;
    this.setData({ words: words, w: '', d: '', toast: '', focusW: false }, function () {
      self.setData({ focusW: true });          // focus 要变化才会重新聚焦，所以先 false 再 true
    });
  },

  removeWord: function (e) {
    var i = Number(e.currentTarget.dataset.i);
    var words = this.data.words.slice();
    words.splice(i, 1);
    drafts.setWords(this.data.id, words);
    this.setData({ words: words, toast: '' });
  },

  preview: function () {
    if (!this.data.img) return;
    wx.previewImage({ urls: [this.data.img], current: this.data.img });
  },

  retake: function () {
    var self = this;
    drafts.pickPhoto().then(function (path) {
      drafts.setPath(self.data.id, path);
      self.setData({ img: path, imgBroken: false });
    }).catch(function (err) { self.onPickError(err); });
  },

  onPickError: function (err) {
    if (privacy.onDenied(err)) return;          // 用户拒绝隐私指引：给一句人话
    if (err && err.message === 'CANCELED') return;   // 自己取消的，别弹提示
    wx.showToast({ title: '没拿到照片', icon: 'none' });
  },

  onImgError: function () {
    this.setData({ imgBroken: true });
  },

  defaultName: function () {
    var d = new Date();
    return '照片词表 ' + (d.getMonth() + 1) + '-' + d.getDate();
  },

  finish: function () {
    var words = this.data.words;
    if (!words.length) return;
    var name = String(this.data.name || '').trim() || this.defaultName();
    var self = this;
    wx.showModal({
      title: '存成词库？',
      content: '「' + name + '」共 ' + words.length + ' 个词，存好就直接用这本背了。',
      confirmText: '存，开始背',
      cancelText: '再想想',
      success: function (res) {
        if (!res.confirm) return;
        var key = books.addCustomBook(name, words);
        if (!key) { wx.showToast({ title: '没存上，再试一次', icon: 'none' }); return; }
        books.setKey(key);
        drafts.remove(self.data.id);            // 入库了草稿就没用了（照片一并删）
        wx.navigateBack();
      }
    });
  },

  /** "先存着"：草稿本就实时落盘，这里只是告诉用户一句，然后退回去 */
  saveLater: function () {
    if (this.data.name) drafts.setName(this.data.id, this.data.name);
    wx.showToast({ title: '已存 ' + this.data.words.length + ' 个词', icon: 'none' });
    var self = this;
    setTimeout(function () { wx.navigateBack(); }, 900);
  },

  goBack: function () { wx.navigateBack(); }
});
