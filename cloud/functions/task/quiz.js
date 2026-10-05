/**
 * 判分与出题逻辑（共享模块 · 唯一真相来源）
 *
 * ⚠️ 两份副本由 scripts/sync-shared.js 生成，内容必须逐字节一致，勿手改副本：
 *   - miniprogram/utils/quiz.js  （小程序侧）
 *   - cloud/shared/quiz.js       （云函数侧）
 *
 * 这里放两条最容易出错、又必须前后端一致的规则：
 *   ① 拼写/听写的答案归一化 —— 太严会冤枉用户，太松会放过没记住的人
 *   ② 题型与抽查结构 —— 一次 10 题、交卷制、答案绝不下发
 */

/* ---------------- 题型与抽查结构 ---------------- */

var QUESTION_TYPES = ['meaning', 'spell', 'listen'];

var DEFAULT_COUNT = 10;

/**
 * 一次抽查的题型配比：选义 3 / 拼写 5 / 听写 2
 *
 * 为什么不能简单按 `i % 10` 分块：那样会得到"先 3 道选义、再连着 5 道拼写、最后 2 道听写"，
 * 连续 5 道拼写在自绘键盘上很折磨人，用户很可能直接放弃。
 * 这里改成按配额轮转，让题型尽量交错（仍然保持 3/5/2 的总量）。
 */
function planTypes(count) {
  if (!count || count <= 0) count = DEFAULT_COUNT;
  var quota = { meaning: 3, spell: 5, listen: 2 };
  var keys = QUESTION_TYPES.slice();
  var out = [];

  for (var i = 0; i < count; i++) {
    if (i % DEFAULT_COUNT === 0) keys = QUESTION_TYPES.slice();   // 每 10 题重置轮转指针
    for (var step = 0; step < keys.length; step++) {
      var idx = i % keys.length;                                   // 轮转起点随题号推进，避免固定顺序
      var t = keys[(idx + step) % keys.length];
      if (quota[t] > 0) {
        out.push(t);
        quota[t]--;
        break;
      }
    }
  }
  return out;
}

/* ---------------- 答案归一化与判定 ---------------- */

/**
 * 把用户输入与标准答案都归一化到可比较的形式。
 * 规则（对应方案文档 7.2 的容错要求）：
 *   - 忽略空格、连字符、下划线、点号：ice cream = icecream
 *   - 忽略大小写：Abandon = abandon
 *   - 视觉混淆字符纠正：数字 1/0/| 与字母 l/o（自绘键盘下概率低，但粘贴输入会有）
 */
function normalizeSpelling(s) {
  if (s === undefined || s === null) return '';
  var out = String(s).trim().toLowerCase();
  out = out.replace(/[\s\-_.']/g, '');
  out = out.replace(/[1|]/g, 'l').replace(/0/g, 'o');
  return out;
}

/**
 * 词表里预置的英美拼写变体（如 color 的 variant 为 colour）可能不止一个，
 * 用逗号或斜杠分隔。返回归一化后的候选列表（不含标准答案本身）。
 */
function splitVariants(variant) {
  if (!variant || variant === '-') return [];
  return String(variant).split(/[,/|]/).map(function (v) {
    return normalizeSpelling(v);
  }).filter(function (v) { return !!v; });
}

/**
 * 拼写 / 听写判定
 */
function isSpellingCorrect(userInput, answerWord, variant) {
  var u = normalizeSpelling(userInput);
  if (!u) return false;
  if (u === normalizeSpelling(answerWord)) return true;
  var candidates = splitVariants(variant);
  for (var i = 0; i < candidates.length; i++) {
    if (u === candidates[i]) return true;
  }
  return false;
}

/**
 * 选义判定（中文释义）
 *
 * 刻意不做"模糊包含"判断：中文释义之间极易互相包含（例如"放弃"与"放弃；抛弃"），
 * 用包含关系判定会放过真正答错的人。只接受全等（容忍空白与标点差异）。
 */
function normalizeMeaning(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/[\s\u3000]/g, '').replace(/[；;、,，。.（）()]/g, '');
}

function isMeaningCorrect(userChoice, answerText) {
  if (!userChoice || !answerText) return false;
  if (userChoice === answerText) return true;                 // 选项本身就是服务端下发的原文
  return normalizeMeaning(userChoice) === normalizeMeaning(answerText);
}

/**
 * 释义指纹：把释义归一化后按字符排序。
 * 用于判断"两个选项是不是同一个词的释义"——"放弃；抛弃"与"抛弃；放弃"
 * 字符串不同但指纹相同，靠它排除会造成"两个正确答案"的干扰项。
 */
function meaningKey(s) {
  var t = normalizeMeaning(s);
  if (!t) return '';
  if (t.normalize) t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');   // 去声调
  return t.split('').sort().join('');
}

/* ---------------- 干扰项 ---------------- */

/**
 * 为选义题挑选干扰项。
 * 策略：优先同一词性（更迷惑），不足再补其它词性；跳过释义与正确答案相同的词。
 */
function pickDistractors(answerWord, pool, need) {
  if (!need || need <= 0) return [];
  var answerKey = meaningKey(answerWord.def_cn);
  var samePos = [];
  var otherPos = [];
  (pool || []).forEach(function (w) {
    if (!w || w.word === answerWord.word) return;
    if (!w.def_cn) return;
    if (meaningKey(w.def_cn) === answerKey) return;           // 释义重复，会造成双正确答案
    (w.pos === answerWord.pos ? samePos : otherPos).push(w.def_cn);
  });

  var seen = {};
  var out = [];
  samePos.concat(otherPos).forEach(function (def) {
    if (out.length >= need) return;
    var k = normalizeMeaning(def);
    if (!k || seen[k]) return;
    seen[k] = 1;
    out.push(def);
  });
  return out;
}

/* ---------------- 出题 ---------------- */

/** 把正确答案混进干扰项。用确定性位置，便于出现问题时复现同一道题。 */
function shuffleWithAnswer(answer, distractors) {
  var arr = distractors.slice();
  var sum = 0;
  for (var i = 0; i < answer.length; i++) sum += answer.charCodeAt(i);
  arr.splice(sum % (arr.length + 1), 0, answer);
  return arr;
}

/**
 * 组装一道题。
 *
 * ⚠️ 返回值里**绝不能包含答案**。答案只留在服务端用于判分，
 * 客户端拿到题目后提交作答，由 quiz.submit 判定。
 * 这是整个产品的立足点：一旦答案下发，用户抓一次返回包就能全对，"抽查"就不存在了。
 */
function buildQuestion(type, word, pool) {
  var q = {
    wordId: word.word,
    type: type,
    phonetic: word.phonetic || '',
    pos: word.pos || '',
    length: String(word.word).length,      // 拼写题需要显示字母数占位
    stem: ''
  };
  if (type === 'meaning') {
    q.stem = word.word;                                        // 题干给单词，选中文释义
    var distractors = pickDistractors(word, pool, 3);
    q.options = shuffleWithAnswer(word.def_cn, distractors);
  } else if (type === 'spell') {
    q.stem = word.def_cn;                                      // 题干给中文，拼写单词
  } else {
    q.stem = '';                                               // 听写不给文字提示
  }
  return q;
}

module.exports = {
  QUESTION_TYPES: QUESTION_TYPES,
  DEFAULT_COUNT: DEFAULT_COUNT,
  planTypes: planTypes,
  normalizeSpelling: normalizeSpelling,
  splitVariants: splitVariants,
  isSpellingCorrect: isSpellingCorrect,
  normalizeMeaning: normalizeMeaning,
  isMeaningCorrect: isMeaningCorrect,
  meaningKey: meaningKey,
  pickDistractors: pickDistractors,
  shuffleWithAnswer: shuffleWithAnswer,
  buildQuestion: buildQuestion
};
