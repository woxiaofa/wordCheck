/**
 * 拼写键盘的按键规划（纯函数，便于 node 直接跑测试）
 *
 * 布局决策（2026-10-09 用户拍板）：
 *   学习 + 抽查一律**全键盘，键位与电脑 QWERTY 键盘完全一致**。
 *   之前的 easy/medium 减键位设计被推翻 —— 现在的小孩普遍学过电脑、家里有电脑，
 *   他们对 QWERTY 键位已经有肌肉记忆；按 a~z 排列或减少键位反而是"第二套键位"，
 *   每次拼写都要重新找字母。跟电脑一致 = 零学习成本 + 顺带练打字。
 *
 * 兼容说明：planKeys/levelLabel 的旧签名保留（老调用不报错），但任何
 * level / word 传入都返回同一份全键盘 —— 键位不再有"难度"概念。
 */

var ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * QWERTY 三行（与电脑键盘一致）。行 2、行 3 的阶梯偏移由 WXSS 的行 padding 实现，
 * 这里只管字母归属 —— 布局与数据分离，改样式不用动数据。
 */
var QWERTY_ROWS = [
  'qwertyuiop'.split(''),
  'asdfghjkl'.split(''),
  'zxcvbnm'.split('')
];

/** 归一化：只留 a-z（旧接口保留，wrong.js 之外的少量调用仍在用） */
function normalize(word) {
  var w = String(word || '').toLowerCase();
  var out = '';
  for (var i = 0; i < w.length; i++) {
    var ch = w.charAt(i);
    if (ch >= 'a' && ch <= 'z') out += ch;
  }
  return out;
}

/** 只保留 a-z 并去重（旧接口保留） */
function uniqueLetters(word) {
  var w = normalize(word);
  var seen = {};
  var out = [];
  for (var i = 0; i < w.length; i++) {
    var ch = w.charAt(i);
    if (seen[ch]) continue;
    seen[ch] = 1;
    out.push(ch);
  }
  return out;
}

/**
 * 确定性洗牌（旧接口保留，历史调用不再依赖其结果）。
 * 必须确定 —— 若每次 setData 都重排，用户刚记住 m 在哪，下一秒键位变了。
 */
function shuffleStable(arr, seed) {
  var a = arr.slice();
  var s = String(seed || '');
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
  for (var j = a.length - 1; j > 0; j--) {
    h = (h * 1103515245 + 12345) % 2147483648;
    var k = h % (j + 1);
    var t = a[j]; a[j] = a[k]; a[k] = t;
  }
  return a;
}

/** 键盘三行（组件直接渲染） */
function planRows() {
  return QWERTY_ROWS.map(function (r) { return r.slice(); });
}

/**
 * 第四行：连字符 + 空格长条（2026-10-10 收录短语后加）。
 *
 * 背景：新版外研四上词表带短语（to-do list / ice cream / give up / all year round），
 * 用户拍板收录。判分侧 normalizeSpelling 本来就忽略空格/连字符 —— 加这两个键不是
 * 判分需要，是教学需要：孩子照着课本上的 ice cream 抄，就该能敲出一模一样的空格，
 * "打出来和书上长得一样"本身就是拼写记忆的一部分。
 *
 * 为什么用 id 而不直接放字符：WXML 的 data-* 属性传空格会被框架裁掉，
 * data-letter=" " 拿到的是 ''。组件里按 id 映射回字符，测试里断言 id→char 的映射。
 */
var EXTRA_ROW = [
  { id: 'hyphen', char: '-', label: '-' },
  { id: 'space', char: ' ', label: '' }
];

/** 第四行键位（组件渲染；返回副本，防外部改坏常量） */
function planExtraRow() {
  return EXTRA_ROW.map(function (k) {
    return { id: k.id, char: k.char, label: k.label };
  });
}

/** id → 字符（组件 onChar 用；未知 id 返回 ''，按键无效但不报错） */
function charOfKey(id) {
  for (var i = 0; i < EXTRA_ROW.length; i++) {
    if (EXTRA_ROW[i].id === id) return EXTRA_ROW[i].char;
  }
  return '';
}

/** 是否大写英文字母 */
function isUpperChar(ch) {
  return typeof ch === 'string' && ch.length === 1 && ch >= 'A' && ch <= 'Z';
}

/**
 * 自动 ⇧（2026-10-10 用户反馈"Mr 应该区分大小写"）：
 * 目标词在 pos 处是大写字母时，键盘应处于大写态 ——
 * 孩子拼 Mr 时光标在 0，键盘自动亮起 ⇧、字母显示大写，
 * 敲完 M 光标到 1（小写 r），⇧ 自动回落，和输入法单击 shift 的节奏一致。
 *
 * 判分侧 normalizeSpelling 本来就忽略大小写，所以 ⇧ 不是判分需要，
 * 是"打出来和课本长得一样"的教学需要（与空格/连字符键同一动机）。
 */
function shiftFor(word, pos) {
  var w = String(word || '');
  var p = Number(pos);
  if (isNaN(p) || p < 0 || p >= w.length) return false;
  return isUpperChar(w.charAt(p));
}

/**
 * 旧接口：任何 level/word 都返回全键盘（QWERTY 行序扁平化）。
 * 保留签名是为了兼容尚未清理的老调用 —— 行为统一后无需分支。
 */
function planKeys(level, word) {
  return QWERTY_ROWS.reduce(function (out, row) {
    return out.concat(row);
  }, []).map(function (c) { return c; });
}

/** 旧接口：难度文案恒为全键盘（界面上不再区分难度） */
function levelLabel(level) {
  return '全键盘';
}

module.exports = {
  ALPHABET: ALPHABET,
  QWERTY_ROWS: QWERTY_ROWS,
  EXTRA_ROW: EXTRA_ROW,
  normalize: normalize,
  uniqueLetters: uniqueLetters,
  shuffleStable: shuffleStable,
  planRows: planRows,
  planExtraRow: planExtraRow,
  charOfKey: charOfKey,
  isUpperChar: isUpperChar,
  shiftFor: shiftFor,
  planKeys: planKeys,
  levelLabel: levelLabel
};
