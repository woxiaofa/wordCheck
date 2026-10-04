/**
 * 自绘字母键盘
 *
 * 为什么必须自研而不用系统输入法：
 *   ① 输入法会联想 —— 打出前三个字母就把整个单词补全了，题目等于没考
 *   ② 输入法会自动纠错 —— 拼错的词会被"修正"，用户永远看不到自己拼错
 *   ③ 会自动首字母大写 —— 归一化能容忍大小写，但容忍不了联想与纠错
 *
 * 布局（v2）：
 *   - 字母键用 flex 自动换行，不再按"每行几个"硬切 —— 难度越高键越少，
 *     硬切行会出现半行空键，退格键也被挤到下一行（用户反馈过"退格换行别扭"）。
 *   - 「下一题 / 交卷」移到键盘下方的整行大按钮上，拇指最容易够到，
 *     同时退格键得以留在字母区里，不再占位换行。
 *   - 键位顺序对同一个词是固定的（keys.js 的 shuffleStable），不会随输入跳动。
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
    showClear: { type: Boolean, value: true }
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
    }
  },

  methods: {
    /** 重新计算键位 */
    rebuild: function () {
      var keys = keysLib.planKeys(this.data.level, this.data.word);
      this.setData({ keys: keys });
    },

    onLetter: function (e) {
      var letter = e.currentTarget.dataset.letter;
      var len = Number(this.data.length) || 0;
      var value = (this.data.value || []).slice();
      if (len && value.length >= len) return;   // 已填满，忽略多余输入
      value.push(letter);
      this.triggerEvent('input', { value: value });
    },

    onAction: function (e) {
      var action = e.currentTarget.dataset.action;
      var value = (this.data.value || []).slice();

      if (action === 'del') {
        if (!value.length) return;
        value.pop();
        if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
        this.triggerEvent('input', { value: value });
      } else if (action === 'clear') {
        if (!value.length) return;
        this.triggerEvent('input', { value: [] });
      } else if (action === 'confirm') {
        this.triggerEvent('confirm', { value: value });
      }
    }
  }
});
