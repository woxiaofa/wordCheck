/**
 * 自绘字母键盘
 *
 * 为什么必须自研而不用系统输入法：
 *   ① 输入法会联想 —— 打出前三个字母就把整个单词补全了，题目等于没考
 *   ② 输入法会自动纠错 —— 拼错的词会被"修正"，用户永远看不到自己拼错
 *   ③ 会自动首字母大写 —— 归一化能容忍大小写，但容忍不了联想与纠错
 *
 * 布局（v6，2026-10-10）：
 *   - **全键盘，键位与电脑 QWERTY 完全一致**（q~p / a~l / z~m 三行）。
 *     现在的小孩普遍接触电脑，QWERTY 键位已有肌肉记忆，跟电脑一致 = 零学习成本。
 *   - 第三行左端 ⇧ 大小写键（与真键盘同位）：点一下切大写、敲一个字母自动回落，
 *     和输入法单击 shift 的节奏一致；word 属性传入目标词时还会**自动 ⇧** ——
 *     光标落在大写字母位置（如 Mr 的第 0 位）键盘自己亮起，孩子照着课本抄就行。
 *   - 第四行：连字符 + 空格长条（收录短语后必须有 —— to-do list / ice cream）。
 *   - 退格 ⌫ 在第三行末尾（电脑键盘位置）；光标移动 ◀ ▶、清空、确定在下方操作行。
 *   - 贴底弹出式全宽卡片（去左右边距、键加高）—— 用户反馈键太小、
 *     旧卡片边框吃宽度，"像输入法一样从下面弹出来边距就可以大了"。
 *   - 支持光标编辑：字母插到光标处，退格删光标前一个 ——
 *     拼错中间一个字母不用清空重打（页面上点已输入的字母也能定位光标）。
 *   - level 属性保留只为兼容老调用，渲染已不依赖它（恒全键盘）。
 */

var keysLib = require('./keys');

Component({
  properties: {
    /** 目标单词字母数：达到后继续按字母键无效，避免把已输入的字符顶掉 */
    length: { type: Number, value: 0 },
    /** 已输入的字母（单字符数组） */
    value: { type: Array, value: [] },
    /** @deprecated 难度分档已下线（2026-10-09）—— 全键盘，属性仅为兼容保留 */
    level: { type: String, value: 'hard' },
    /** 目标词文本：用于自动 ⇧（光标落在大写字母位时键盘自动切大写，如 Mr）。不传则 ⇧ 全手动 */
    word: { type: String, value: '' },
    /** 主操作键文案："下一题" 或 "交卷" */
    confirmLabel: { type: String, value: '下一题' },
    /** 是否显示"清空"键 */
    showClear: { type: Boolean, value: true },
    /** 插入光标位置（0~value.length）。页面点已输入字母时传入 */
    caret: { type: Number, value: 0, optionalTypes: [null] }
  },

  data: {
    rows: [],        // QWERTY 三行（keys.planRows）
    rowsUpper: [],   // 同结构的大写版：⇧ 亮起时整块换掉（WXML 侧不做大小写转换）
    extraRow: [],    // 第四行：连字符 + 空格（keys.planExtraRow，短语收录后必须有）
    shift: false,    // ⇧ 大写态：字母键显示并插入大写
    shiftManual: false // 刚手动点过 ⇧：下一次插入/删除前不被自动 ⇧ 覆盖
  },

  lifetimes: {
    attached: function () {
      this.setData({
        rows: keysLib.planRows(),
        rowsUpper: keysLib.QWERTY_ROWS_UPPER,
        extraRow: keysLib.planExtraRow()
      });
      this.syncShift();
    }
  },

  observers: {
    'value, caret, word': function () {
      this.fixCaret();
      this.syncShift();
    }
  },

  methods: {
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

    /**
     * 自动 ⇧ 同步：手动点过 ⇧（shiftManual）时不动，等下一次按键后回到自动。
     * 自动规则就是 keys.shiftFor(word, 光标位) —— Mr 的第 0 位自动大写。
     */
    syncShift: function () {
      if (this.data.shiftManual) return;
      var want = keysLib.shiftFor(this.data.word, this.caretNow());
      if (want !== this.data.shift) this.setData({ shift: want });
    },

    /** 任何一次真实按键（字母/空格/删除等）之后：手动态用完，回到自动 ⇧ */
    afterKey: function () {
      if (this.data.shiftManual) this.setData({ shiftManual: false });
      this.syncShift();
    },

    /** 在光标处插入一个字符（字母键与空格/连字符键共用；达到目标长度后忽略） */
    insertChar: function (ch) {
      if (!ch) return;
      var len = Number(this.data.length) || 0;
      var value = (this.data.value || []).slice();
      if (len && value.length >= len) return;   // 已填满，忽略多余输入
      var caret = this.caretNow();
      value.splice(caret, 0, ch);
      this.setData({ caret: caret + 1 });
      this.emit(value, caret + 1);
      this.afterKey();
    },

    onLetter: function (e) {
      var ch = e.currentTarget.dataset.letter;
      if (this.data.shift) ch = String(ch).toUpperCase();
      this.insertChar(ch);
    },

    /** 第四行按键（连字符/空格）：id → 字符由 keys.charOfKey 统一映射 */
    onChar: function (e) {
      this.insertChar(keysLib.charOfKey(e.currentTarget.dataset.char));
    },

    onAction: function (e) {
      var action = e.currentTarget.dataset.action;
      var value = (this.data.value || []).slice();
      var caret = this.caretNow();

      if (action === 'shift') {
        // 手动 ⇧：点一下切大写（亮），再点一下回小写；敲一个键后自动回落到自动态
        this.setData({ shift: !this.data.shift, shiftManual: true });
        if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
      } else if (action === 'del') {
        if (!value.length || caret === 0) return;
        value.splice(caret - 1, 1);
        if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
        this.setData({ caret: caret - 1 });
        this.emit(value, caret - 1);
        this.afterKey();
      } else if (action === 'left') {
        if (caret <= 0) return;
        this.setData({ caret: caret - 1 });
        this.emit(value, caret - 1);
        this.syncShift();
      } else if (action === 'right') {
        if (caret >= value.length) return;
        this.setData({ caret: caret + 1 });
        this.emit(value, caret + 1);
        this.syncShift();
      } else if (action === 'clear') {
        if (!value.length) return;
        this.setData({ caret: 0 });
        this.emit([], 0);
        this.afterKey();
      } else if (action === 'confirm') {
        this.triggerEvent('confirm', { value: value });
      }
    }
  }
});
