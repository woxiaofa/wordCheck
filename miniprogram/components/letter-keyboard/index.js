/**
 * 自绘字母键盘
 *
 * 为什么必须自研而不用系统输入法：
 *   ① 输入法会联想 —— 打出前三个字母就把整个单词补全了，题目等于没考
 *   ② 输入法会自动纠错 —— 拼错的词会被"修正"，用户永远看不到自己拼错
 *   ③ 会自动首字母大写 —— 归一化能容忍大小写，但容忍不了联想与纠错
 *
 * 布局（v3，2026-10-07）：
 *   - 字母键一律按 a~z 升序排列（keys.planKeys 已保证），找字母有规律可循。
 *   - 支持光标编辑：◀ ▶ 移动插入位置，字母插到光标处，退格删光标前一个 ——
 *     拼错中间一个字母不用清空重打（页面上点已输入的字母也能定位光标）。
 *   - 键位加大（96×104rpx）、间距拉开（14rpx），降低孩子误触邻键的概率；
 *     光标/退格/清空都在键盘下方的操作行，跟字母区隔开，不会挤在一起误按。
 */

var keysLib = require('./keys');

Component({
  properties: {
    /** 目标单词字母数：达到后继续按字母键无效，避免把已输入的字符顶掉 */
    length: { type: Number, value: 0 },
    /** 已输入的字母（单字符数组） */
    value: { type: Array, value: [] },
    /** 难度：easy 只给正确字母 / medium 加易混键 / hard 全键盘 */
    level: { type: String, value: 'hard' },
    /** 目标单词：easy、medium 两档需要它来挑键（hard 不需要） */
    word: { type: String, value: '' },
    /** 主操作键文案："下一题" 或 "交卷" */
    confirmLabel: { type: String, value: '下一题' },
    /** 是否显示"清空"键 */
    showClear: { type: Boolean, value: true },
    /** 插入光标位置（0~value.length）。页面点已输入字母时传入 */
    caret: { type: Number, value: 0, optionalTypes: [null] }
  },

  data: {
    keys: []
  },

  lifetimes: {
    attached: function () {
      this.rebuild();
    }
  },

  observers: {
    'level, word, showClear': function () {
      this.rebuild();
    },
    'value, caret': function () {
      this.fixCaret();
    }
  },

  methods: {
    /** 重新计算键位 */
    rebuild: function () {
      var keys = keysLib.planKeys(this.data.level, this.data.word);
      this.setData({ keys: keys });
    },

    /** 光标越界（外部把 value 改短/清空了）就收回末尾 */
    fixCaret: function () {
      var len = (this.data.value || []).length;
      var c = Number(this.data.caret);
      if (isNaN(c) || c < 0 || c > len) this.setData({ caret: len });
    },

    /** 当前有效的插入位置（0~value.length） */
    caretNow: function () {
      var len = (this.data.value || []).length;
      var c = Number(this.data.caret);
      if (isNaN(c) || c < 0 || c > len) return len;
      return c;
    },

    /** 统一的对外通知：value 和 caret 一起给，页面视图才能同步画光标 */
    emit: function (value, caret) {
      this.triggerEvent('input', { value: value, caret: caret });
    },

    onLetter: function (e) {
      var letter = e.currentTarget.dataset.letter;
      var len = Number(this.data.length) || 0;
      var value = (this.data.value || []).slice();
      if (len && value.length >= len) return;   // 已填满，忽略多余输入
      var caret = this.caretNow();
      value.splice(caret, 0, letter);
      this.setData({ caret: caret + 1 });
      this.emit(value, caret + 1);
    },

    onAction: function (e) {
      var action = e.currentTarget.dataset.action;
      var value = (this.data.value || []).slice();
      var caret = this.caretNow();

      if (action === 'del') {
        if (!value.length || caret === 0) return;
        value.splice(caret - 1, 1);
        if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
        this.setData({ caret: caret - 1 });
        this.emit(value, caret - 1);
      } else if (action === 'left') {
        if (caret <= 0) return;
        this.setData({ caret: caret - 1 });
        this.emit(value, caret - 1);
      } else if (action === 'right') {
        if (caret >= value.length) return;
        this.setData({ caret: caret + 1 });
        this.emit(value, caret + 1);
      } else if (action === 'clear') {
        if (!value.length) return;
        this.setData({ caret: 0 });
        this.emit([], 0);
      } else if (action === 'confirm') {
        this.triggerEvent('confirm', { value: value });
      }
    }
  }
});
