/**
 * 拼写键盘的按键规划（纯函数，便于 node 直接跑测试）
 *
 * 为什么分难度：
 *   全键盘对刚开始学的孩子不是"难"，是"挫败"——他明明知道这个词怎么拼，
 *   却要在 26 个键里找字母，找的过程就把回忆打断了。
 *   所以难度按"干扰项"递增，而不是按单词难度递增：
 *     easy   只给这个词用到的字母 —— 考的是"顺序"（他得真的会拼）
 *     medium 再加入 b/d、a/e/o、i/l/r/u/v、m/n 这些形近易混字母 —— 考的是"辨认"
 *     hard   26 键全给 —— 考的是完整拼写能力
 *   难度随该词的掌握情况自动递进，答错过的词自动降回 easy。
 *
 * 为什么键不会被"消耗"：每个键可重复点击，所以 easy 只需要提供去重后的字母集合。
 */

var ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * 形近/易混字母。取自手写与印刷体最容易认错、以及键盘上位置相邻的组合：
 * b/d、p/q、a/e/o、i/l、r/v、u/v、m/n、c/e
 */
var CONFUSABLES = 'bdaeoilruvpqmn'.split('');

/** 中等难度额外加入的易混键数量 */
var MEDIUM_EXTRA = 5;

/** 归一化：只留 a-z。既用于取字母集合，也用于洗牌种子，
    这样 'Ab-cd!' 与 'abcd' 得到完全一样的键位（云端下发的大小写/连字符不影响体验） */
function normalize(word) {
  var w = String(word || '').toLowerCase();
  var out = '';
  for (var i = 0; i < w.length; i++) {
    var ch = w.charAt(i);
    if (ch >= 'a' && ch <= 'z') out += ch;
  }
  return out;
}

/** 只保留 a-z，并去重（保持原顺序） */
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
 * 确定性洗牌：同样的词每次得到同一个键位。
 * 必须确定 —— 若每次 setData 都重排，用户刚记住 m 在哪，下一秒键位变了。
 * @param {Array<string>} arr
 * @param {string} seed 一般用目标单词
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

/**
 * 计算某道题应该给出哪些字母键
 * @param {'easy'|'medium'|'hard'} level
 * @param {string} word 目标单词（仅 easy/medium 需要）
 * @returns {Array<string>} 洗好序的字母数组
 */
function planKeys(level, word) {
  var lv = level || 'hard';

  if (lv === 'hard') return ALPHABET.slice();

  var w = normalize(word);
  var uniq = uniqueLetters(w);
  if (!uniq.length) return ALPHABET.slice();   // 拿不到词（云端未下发）就退回全键盘

  if (lv === 'easy') return shuffleStable(uniq, w);

  var extra = [];
  for (var i = 0; i < CONFUSABLES.length && extra.length < MEDIUM_EXTRA; i++) {
    var c = CONFUSABLES[i];
    if (uniq.indexOf(c) < 0) extra.push(c);
  }
  return shuffleStable(uniq.concat(extra), w);
}

/** 难度文案（界面上直接写明这题用的是哪档，家长和老师看得见） */
function levelLabel(level) {
  if (level === 'easy') return '仅正确字母';
  if (level === 'medium') return '含易混字母';
  return '全键盘';
}

module.exports = {
  ALPHABET: ALPHABET,
  CONFUSABLES: CONFUSABLES,
  normalize: normalize,
  uniqueLetters: uniqueLetters,
  shuffleStable: shuffleStable,
  planKeys: planKeys,
  levelLabel: levelLabel
};
