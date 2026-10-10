/**
 * 错拼诊断（字母级）—— 共享模块 · 唯一真相来源
 *
 * ⚠️ 两份副本由 scripts/sync-shared.js 生成，内容必须逐字节一致，勿手改副本：
 *   - miniprogram/utils/wrong.js  （小程序侧：错题本"错在哪"用）
 *   - cloud/shared/wrong.js       （云函数侧：班级错因统计用）
 *
 * 为什么值得单开一个模块：
 *   同样一份"孩子把 cat 拼成 kat"的数据，老师想知道的事情有三层——
 *     ① 哪个词错得最多（词级，拍照批改也能做，不是壁垒）
 *     ② 错在第几个字母（这个是单词ogy层面的规律：很多孩子是**同一个位置**出错）
 *     ③ 错成了什么（单个字母写错 / 少字母 / 相邻颠倒 —— 直接决定怎么讲）
 *   判定规则必须前后端一致，否则"错题本说单个字母写错、班级报表说多个字母写错"
 *   又是一次数据自相矛盾。所以跟判分一样，只留一份真相。
 *
 * 边界取舍：**宁可粗判，不可瞎判**。凡是判定不出确定形态的一律归到'其它'，
 * 绝不给一个看起来很聪明、实际是猜的结论 —— 老师会照着它去讲错的东西。
 */

/**
 * 归一化：与判分口径保持一致（忽略大小写、空格、连字符、撇号）。
 * 注意这里刻意**不做** 1→l / 0→o 的混淆纠正：
 * 纠正后"把 o 写成 0"这种典型错误会被判成"拼对了"，而它恰恰是小学拼写的高频错法。
 */
function normalizeTyped(s) {
  return String(s === undefined || s === null ? '' : s)
    .trim().toLowerCase()
    .replace(/[\s\-_.'’]/g, '');
}

/**
 * 第一个出错的字母位置（0 起）。
 * @returns {number} -1 表示两个字面完全一致（已拼对）；否则返回首个差异的位置
 */
function firstDiffSpot(answer, typed) {
  var a = normalizeTyped(answer);
  var t = normalizeTyped(typed);
  var n = Math.min(a.length, t.length);
  for (var i = 0; i < n; i++) {
    if (a[i] !== t[i]) return i;
  }
  // 前缀都一样：长度不同就是在这里掉的/多的字母
  return a.length === t.length ? -1 : n;
}

/** 不同字符的个数（按位置比较，长度不同时按较短的算，多出来的算差异） */
function countDiff(answer, typed) {
  var a = normalizeTyped(answer);
  var t = normalizeTyped(typed);
  var d = Math.abs(a.length - t.length);   // 长度差先记一笔：多的/少的都算差异
  var m = Math.min(a.length, t.length);
  for (var i = 0; i < m; i++) if (a[i] !== t[i]) d++;
  return d;
}

/** t 是否是 a 的子序列（顺序一致但允许缺字） */
function isSubsequence(t, a) {
  var i = 0;
  for (var j = 0; j < a.length && i < t.length; j++) {
    if (a[j] === t[i]) i++;
  }
  return i === t.length;
}

/** 是否只是相邻两个字母调换（cat → cta / act 这类） */
function isAdjacentSwap(a, t) {
  if (a.length !== t.length) return false;
  var diffs = [];
  for (var i = 0; i < a.length; i++) if (a[i] !== t[i]) diffs.push(i);
  if (diffs.length !== 2) return false;
  var i1 = diffs[0], i2 = diffs[1];
  if (i2 !== i1 + 1) return false;
  return a[i1] === t[i2] && a[i2] === t[i1];
}

/**
 * 错因归类。
 * @returns {string} 归类标签：'相同' | '少字母' | '多字母' | '相邻字母颠倒' |
 *                   '单个字母写错' | '多个字母写错' | '顺序错乱' | '其它'
 */
function mistakeKind(answer, typed) {
  var a = normalizeTyped(answer);
  var t = normalizeTyped(typed);
  if (!a || !t) return '其它';
  if (a === t) return '相同';

  if (t.length < a.length && isSubsequence(t, a)) return '少字母';
  if (t.length > a.length && isSubsequence(a, t)) return '多字母';
  if (t.length === a.length) {
    if (isAdjacentSwap(a, t)) return '相邻字母颠倒';
    var d = countDiff(a, t);
    if (d === 1) return '单个字母写错';
    if (d === 2) return '两个字母写错';
    return '多个字母写错';
  }
  // 长度不同又不是单纯的增删：顺序对被打散了
  return '顺序错乱';
}

/**
 * 单个字母写错时，给出"正确→写成"的字母对（如 'o→u'）。
 * 只有确实是单字母错误时才返回（其它形态返回空串）——
 * 这是全产品最细的一条诊断，宁缺毋滥。
 */
function singleLetterPair(answer, typed) {
  var a = normalizeTyped(answer);
  var t = normalizeTyped(typed);
  if (a.length !== t.length || !a) return '';
  if (countDiff(a, t) !== 1) return '';
  var i = firstDiffSpot(a, t);
  if (i < 0) return '';
  return a[i] + '→' + t[i];
}

/** 出错位置的中文说法（1 起）："第3个字母"；已拼对时返回 '' */
function spotLabel(answer, typed) {
  var i = firstDiffSpot(answer, typed);
  if (i < 0) return '';
  return '第' + (i + 1) + '个字母';
}

/**
 * 把一堆错误记录聚合成"词 → 次数"，按次数降序。
 * @param {Array<{word:string}>} rows
 * @param {number} topN
 */
function topWords(rows, topN) {
  var map = {};
  (rows || []).forEach(function (r) {
    var w = r && r.word;
    if (!w) return;
    map[w] = (map[w] || 0) + 1;
  });
  return Object.keys(map).map(function (w) {
    return { word: w, cnt: map[w] };
  }).sort(function (a, b) {
    return b.cnt - a.cnt || (a.word < b.word ? -1 : 1);
  }).slice(0, topN || 5);
}

/** 同一类计数聚合：[{key, cnt}] → 按 cnt 降序取前 N */
function topBy(list, topN) {
  var map = {};
  (list || []).forEach(function (k) {
    if (!k) return;
    map[k] = (map[k] || 0) + 1;
  });
  return Object.keys(map).map(function (k) {
    return { key: k, cnt: map[k] };
  }).sort(function (a, b) {
    return b.cnt - a.cnt || (a.key < b.key ? -1 : 1);
  }).slice(0, topN || 3);
}

module.exports = {
  normalizeTyped: normalizeTyped,
  firstDiffSpot: firstDiffSpot,
  countDiff: countDiff,
  isSubsequence: isSubsequence,
  isAdjacentSwap: isAdjacentSwap,
  mistakeKind: mistakeKind,
  singleLetterPair: singleLetterPair,
  spotLabel: spotLabel,
  topWords: topWords,
  topBy: topBy
};
