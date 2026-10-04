/**
 * 自绘 26 键字母键盘
 *
 * 为什么必须自研而不用系统输入法：
 *   ① 输入法会联想 —— 打出前三个字母就把整个单词补全了，题目等于没考
 *   ② 输入法会自动纠错 —— 拼错的词会被"修正"，用户永远看不到自己拼错
 *   ③ 会自动首字母大写 —— 归一化能容忍大小写，但容忍不了联想与纠错
 *
 * 布局自适应：短词用 9 列（跟手、好按），长词降到 7 列才装得下。
 */

var ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

/** 按列数把 26 个字母切成若干行 */
function planRows(cols) {
  var rows = [];
  for (var i = 0; i < ALPHABET.length; i += cols) {
    rows.push(ALPHABET.slice(i, i + cols));
  }
  return rows;
}

/** 依据"当前单词最长多长"计算列数 */
function colsForLength(length) {
  if (!length || length <= 9) return 9;
  if (length <= 10) return 8;
  return 7;
}

Component({
  properties: {
    /** 目标单词字母数：达到后继续按字母键无效，避免把已输入的字符顶掉 */
    length: { type: Number, value: 0 },
    /** 已输入的字母（单字符数组） */
    value: { type: Array, value: [] },
    /** 主操作键文案："下一题" 或 "交卷" */
    confirmLabel: { type: String, value: '下一题' },
    /** 是否显示"清空"键 */
    showClear: { type: Boolean, value: true }
  },

  data: {
    rows: []
  },

  lifetimes: {
    attached: function () {
      this.rebuild();
    }
  },

  observers: {
    'length, showClear': function () {
      this.rebuild();
    }
  },

  methods: {
    /** 重新计算键盘布局。最后一行需要塞进三个操作键，因此该行少放 3 个字母。 */
    rebuild: function () {
      var cols = colsForLength(this.data.length);
      var raw = planRows(cols);
      var last = raw.length - 1;
      var showClear = this.data.showClear;

      var rows = raw.map(function (letters, idx) {
        var actions = [];
        if (idx === last) {
          letters = letters.slice(0, Math.max(1, cols - 3));
          actions.push({ key: 'del', label: '⌫ 退格', cls: 'del' });
          if (showClear) actions.push({ key: 'clear', label: '清空', cls: 'clear' });
          actions.push({ key: 'confirm', label: '', cls: 'go' });
        }
        return {
          keys: letters.map(function (l) { return { letter: l }; }),
          actions: actions
        };
      });

      this.setData({ rows: rows });
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
