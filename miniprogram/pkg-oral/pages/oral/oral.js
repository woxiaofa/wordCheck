/**
 * 跟读练习页（第 1 期 · 零 AI、零后端）
 *
 * 闭环：选词 / 导入口令 → 听词级示范音 → 录音 → 本机回放自听 →
 *       重录 / 标记已读 / 家长确认 → 生成文字汇总由家长转发。
 *
 * 明确不做：打分、评分、识别、上传、老师端汇总。这一版只回答一个产品问题：
 * 孩子会不会真的开口录、家长愿不愿在本机听。见 docs/口语作业方案.md。
 */
var theme = require('../../../utils/theme');
var oral = require('../../../utils/oral');
var code = require('../../../utils/oral-code');
var privacy = require('../../../utils/privacy');

var STATE_TEXT = {
  IDLE: '可以开始',
  RECORDING: '正在录音…',
  SAVING: '正在保存…',
  PLAYING: '正在回放'
};

Page({
  data: {
    skin: theme.cls(),
    mode: 'word',            // word | custom
    wordInput: '',
    customText: '',
    pasteText: '',
    codeText: '',
    codeId: '',
    refText: '',
    refWord: '',
    hasRef: false,
    chips: [],
    records: [],
    state: 'IDLE',
    stateText: '可以开始',
    tip: '',
    summaryText: '',
    maxRecords: oral.MAX_RECORDS
  },

  onLoad: function (options) {
    // 辅路径：从分享卡片带口令进来，免去手动复制粘贴
    var raw = options && options.code;
    if (raw) {
      var text = raw;
      try { text = decodeURIComponent(raw); } catch (e) { /* 原样用 */ }
      this.setData({ pasteText: text });
      this.applyCode(text);
    }
  },

  onShow: function () {
    theme.syncPage(this);
    this.refresh();
  },

  onHide: function () {
    oral.cancelRecord();
  },

  onUnload: function () {
    oral.cancelRecord();
  },

  onShareAppMessage: function () {
    var q = this.data.codeText ? '?code=' + encodeURIComponent(this.data.codeText) : '';
    return { title: '一起做跟读练习', path: '/pkg-oral/pages/oral/oral' + q };
  },

  refresh: function () {
    var rows = oral.list().map(function (r) {
      var d = new Date(r.created_at || Date.now());
      function p(n) { return n < 10 ? '0' + n : '' + n; }
      return {
        id: r.id,
        ref_text: r.ref_text || '(没填内容)',
        when: p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()),
        duration: Math.round((r.duration_ms || 0) / 1000),
        typeName: r.type === 'custom' ? '自定义文本' : '单词',
        listened: !!r.listened,
        marked_read: !!r.marked_read,
        passed: !!r.passed
      };
    });
    var st = oral.getState();
    this.setData({ records: rows, state: st, stateText: STATE_TEXT[st] || '可以开始' });
  },

  /* --------------------------- 材料 --------------------------- */

  switchMode: function (e) {
    var m = e.currentTarget.dataset.mode;
    this.setData({ mode: m === 'custom' ? 'custom' : 'word', tip: '' });
  },

  onWordInput: function (e) { this.setData({ wordInput: e.detail.value }); },
  onCustomInput: function (e) { this.setData({ customText: e.detail.value }); },
  onPasteInput: function (e) { this.setData({ pasteText: e.detail.value }); },

  useWord: function () {
    var w = String(this.data.wordInput || '').trim();
    if (!w) { this.setData({ tip: '先输入一个单词' }); return; }
    this.setData({
      refText: w, refWord: w, hasRef: true, codeId: '',
      chips: oral.chips(w), tip: '亮色的词可以点一下听示范音'
    });
  },

  useCustom: function () {
    var t = String(this.data.customText || '').trim();
    if (!t) { this.setData({ tip: '先填一段要读的英文' }); return; }
    this.setData({
      mode: 'custom', refText: t, refWord: '', hasRef: true, codeId: '',
      chips: oral.chips(t), tip: '亮色的词可以点一下听示范音；灰色的按文本读就行'
    });
  },

  speakChip: function (e) {
    var w = e.currentTarget.dataset.word;
    if (!oral.speak(w)) wx.showToast({ title: '这个词没有内置示范音', icon: 'none' });
  },

  /* --------------------------- 口令 --------------------------- */

  makeCode: function () {
    var r = code.encode({ ref: this.data.customText, t: 'custom' });
    if (!r.ok) { this.setData({ tip: r.reason }); return; }
    this.setData({ codeText: r.code, tip: '口令已生成，复制后发给孩子' });
  },

  copyCode: function () {
    var text = this.data.codeText;
    if (!text) { this.setData({ tip: '先点「生成跟读口令」' }); return; }
    privacy.copy(text, function () { wx.showToast({ title: '已复制', icon: 'none' }); });
  },

  pasteCode: function () {
    var self = this;
    privacy.paste(function (text) {
      self.setData({ pasteText: text });
      self.applyCode(text);
    });
  },

  importCode: function () { this.applyCode(this.data.pasteText); },

  applyCode: function (raw) {
    var r = code.decode(raw);
    if (!r.ok) { this.setData({ tip: r.reason }); return false; }
    this.setData({
      mode: 'custom',
      customText: r.data.ref,
      refText: r.data.ref,
      refWord: '',
      codeId: String(r.data.ts),
      hasRef: true,
      chips: oral.chips(r.data.ref),
      tip: '已导入 ' + r.data.n + ' 个词的跟读内容'
    });
    return true;
  },

  /* --------------------------- 录音 --------------------------- */

  startRecord: function () {
    var self = this;
    if (!this.data.hasRef) {
      this.setData({ tip: '先在上面选好要读的内容，再开始录音' });
      return;
    }
    this.setData({ tip: '正在准备麦克风…' });
    var starting = oral.start({
      type: this.data.mode,
      ref_text: this.data.refText,
      ref_word: this.data.refWord,
      code_id: this.data.codeId,
      source: 'local'
    });
    // start() 同步占住 RECORDING 状态，这里立刻同步一次，按钮才会切成「录好了，停」
    this.refresh();
    starting.then(function () {
      self.refresh();
      self.setData({ tip: '录好了，点「回放」听一遍' });
      wx.showToast({ title: '已存到本机', icon: 'none' });
    }).catch(function (err) {
      if (err && err.message === 'PRIVACY_DENIED') privacy.onDenied(err, 'microphone');
      self.refresh();
      self.setData({ tip: oral.errorText(err) });
    });
  },

  stopRecord: function () {
    var self = this;
    oral.stop().catch(function (err) {
      self.refresh();
      self.setData({ tip: oral.errorText(err) });
    });
  },

  playRecord: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!oral.play(id)) wx.showToast({ title: oral.errorText(new Error('NO_FILE')), icon: 'none' });
    this.refresh();
  },

  markRead: function (e) {
    oral.update(e.currentTarget.dataset.id, { marked_read: true });
    this.refresh();
  },

  markPassed: function (e) {
    oral.update(e.currentTarget.dataset.id, { passed: true, marked_read: true });
    this.refresh();
  },

  removeRecord: function (e) {
    oral.remove(e.currentTarget.dataset.id);
    this.refresh();
  },

  clearAll: function () {
    var self = this;
    wx.showModal({
      title: '清空本机录音',
      content: '只删这台手机上的录音，不会动别的数据。',
      confirmText: '清空',
      cancelText: '再想想',
      success: function (r) {
        if (!r.confirm) return;
        oral.clear();
        self.refresh();
        self.setData({ tip: '已清空' });
      }
    });
  },

  /* --------------------------- 汇总 --------------------------- */

  makeSummary: function () {
    this.setData({ summaryText: oral.summary() });
  },

  copySummary: function () {
    var text = this.data.summaryText;
    if (!text) { this.setData({ tip: '先点「生成汇总」' }); return; }
    privacy.copy(text, function () { wx.showToast({ title: '已复制', icon: 'none' }); });
  }
});
