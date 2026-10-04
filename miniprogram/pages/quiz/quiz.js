/**
 * 抽查页 —— 交卷制
 *
 * 与"练习"的本质区别：过程中不告诉对错，全部答完才判分。
 * 如果边答边判分，用户会立刻回头改答案并把它当练习，压力消失，抽查的督促价值也就没了。
 *
 * 数据来源：
 *   - 题目：云端 quiz.generate（**不含答案**）优先，未部署时用本地词库兜底
 *   - 判分：本地用 shared/quiz.js 判（与云端同一份规则）；云端已配置时以云端结果为准
 *   - 错词：一律走 srs.nextState(prev,'forgot') 重置档位，与学习页共用同一套规则
 */

var api = require('../../utils/cloud').api;
var srs = require('../../utils/srs');
var quizLib = require('../../utils/quiz');
var time = require('../../utils/time');
var WORDS = require('../../data/words');

var STORAGE_KEY = 'word_state_mirror';
var ACTIVITY_KEY = 'activity_log';
var QUESTION_COUNT = 10;
var MAX_REPLAY = 3;

Page({
  data: {
    state: 'intro',          // intro | run | result
    questions: [],
    index: 0,
    answers: [],
    cur: null,
    typeLabel: '',
    progressPct: 0,
    isLast: false,
    answeredCount: 0,
    played: 0,
    playHint: '',
    // 结果
    correct: 0,
    total: 0,
    emoji: '📋',
    comment: '',
    details: [],
    parentLine: ''
  },

  /** @type {Object} 本地 SRS 状态镜像，与学习页共用同一个 key */
  mirror: {},

  onLoad: function () {
    this.mirror = wx.getStorageSync(STORAGE_KEY) || {};
  },

  onShow: function () {
    this.mirror = wx.getStorageSync(STORAGE_KEY) || {};
  },

  /* ---------------- 开始 ---------------- */

  onStart: function () {
    var self = this;
    wx.showLoading({ title: '出题中', mask: true });

    api.generateQuiz({ count: QUESTION_COUNT }).then(function (data) {
      wx.hideLoading();
      var qs = (data && data.questions) || [];
      if (!qs.length) throw new Error('EMPTY');
      self.beginQuiz(qs, false);
    }).catch(function () {
      wx.hideLoading();
      // 云端未部署：用本地词库出题，判分规则与云端一致
      self.beginQuiz(self.localQuestions(QUESTION_COUNT), true);
    });
  },

  localQuestions: function (count) {
    var plan = quizLib.planTypes(count);
    var pool = WORDS;
    var picked = this.pickWords(pool, count);

    return plan.map(function (type, i) {
      var w = picked[i % picked.length];
      var q = quizLib.buildQuestion(type, w, pool);
      q.wordId = w.word;
      return q;
    });
  },

  /**
   * 选题：优先拿错词（抽查的价值就在于查没记住的），其次到期词，最后已学词/全部词。
   */
  pickWords: function (pool, count) {
    var now = Date.now();
    var mirror = this.mirror;
    var wrong = [], due = [], learned = [], rest = [];

    pool.forEach(function (w) {
      var st = mirror[w.word];
      if (!st) { rest.push(w); return; }
      learned.push(w);
      if (st.next_review_at && st.next_review_at <= now) due.push(w);
      else if (st.wrong_count > 0 && st.last_feedback !== 'known') wrong.push(w);
    });

    var ordered = wrong.concat(due).concat(learned).concat(rest);
    // 去重后按需截取
    var seen = {};
    var out = [];
    ordered.forEach(function (w) {
      if (out.length >= count) return;
      if (seen[w.word]) return;
      seen[w.word] = 1;
      out.push(w);
    });
    return out.length ? out : pool.slice(0, count);
  },

  beginQuiz: function (questions, isLocal) {
    var answers = [];
    for (var i = 0; i < questions.length; i++) answers.push(questions[i].type === 'meaning' ? '' : []);

    this.isLocal = !!isLocal;
    this.questionStartAt = Date.now();
    this.playedCount = {};

    this.setData({
      state: 'run',
      questions: questions,
      answers: answers,
      index: 0,
      correct: 0,
      details: []
    });
    this.renderQuestion();
  },

  /* ---------------- 渲染当前题 ---------------- */

  renderQuestion: function () {
    var i = this.data.index;
    var q = this.data.questions[i];
    if (!q) return;

    var cur = {
      type: q.type,
      stem: q.stem || '',
      phonetic: q.phonetic || '',
      pos: q.pos || '',
      options: q.options || [],
      length: Number(q.length) || String(q.wordId || '').length,
      slots: [],
      wordId: q.wordId
    };

    if (cur.type === 'spell' || cur.type === 'listen') {
      var val = this.data.answers[i] || [];
      cur.slots = this.buildSlots(cur.wordId, cur.length, Array.isArray(val) ? val.join('') : '');
    }

    this.setData({
      cur: cur,
      typeLabel: this.typeLabelOf(cur.type),
      progressPct: Math.round(i / this.data.questions.length * 100),
      isLast: i === this.data.questions.length - 1,
      answeredCount: this.countAnswered(),
      played: this.playedCount[cur.wordId] || 0,
      playHint: cur.type === 'listen' ? this.playHintFor(cur.wordId) : ''
    });
  },

  buildSlots: function (word, len, typed) {
    var slots = [];
    for (var i = 0; i < len; i++) {
      var ch = typed.charAt(i);
      slots.push({
        i: i,
        show: !!ch,
        dot: !!ch && String(word).charAt(i).toLowerCase() !== ch.toLowerCase(),
        ch: ch
      });
    }
    return slots;
  },

  typeLabelOf: function (type) {
    if (type === 'meaning') return '选义（英译中）';
    if (type === 'spell') return '拼写（中译英）';
    return '听写（听音写词）';
  },

  playHintFor: function (wordId) {
    var n = this.playedCount[wordId] || 0;
    if (!n) return '最多可重放 3 次';
    return '已播放 ' + n + ' / ' + MAX_REPLAY + ' 次';
  },

  countAnswered: function () {
    var self = this;
    return this.data.answers.filter(function (a) {
      return self.isAnswered(a);
    }).length;
  },

  isAnswered: function (a) {
    if (a === undefined || a === null) return false;
    if (Array.isArray(a)) return a.length > 0;
    return String(a).length > 0;
  },

  /* ---------------- 作答 ---------------- */

  onPickOption: function (e) {
    var opt = e.currentTarget.dataset.opt;
    var answers = this.data.answers.slice();
    answers[this.data.index] = opt;
    this.setData({ answers: answers });
    this.renderQuestion();
  },

  onKeyInput: function (e) {
    var value = e.detail.value || [];
    var answers = this.data.answers.slice();
    answers[this.data.index] = value;
    this.setData({ answers: answers });
    this.renderQuestion();
  },

  onKeyConfirm: function () {
    this.goNext();
  },

  onPrev: function () {
    if (this.data.index === 0) return;
    this.setData({ index: this.data.index - 1 });
    this.renderQuestion();
  },

  onNext: function () {
    this.goNext();
  },

  goNext: function () {
    if (this.data.isLast) { this.submitQuiz(); return; }
    this.setData({ index: this.data.index + 1 });
    this.renderQuestion();
  },

  onPlay: function () {
    var q = this.data.cur;
    if (!q) return;
    var n = this.playedCount[q.wordId] || 0;
    if (n >= MAX_REPLAY) return;
    this.playedCount[q.wordId] = n + 1;

    if (!this.speakWord(q.wordId)) {
      wx.showToast({ title: '发音源未配置', icon: 'none' });
    }
    this.renderQuestion();
  },

  /**
   * 发音
   *
   * ⚠️ 这里刻意不写死任何第三方 TTS 地址：小程序对 request 域名有白名单要求，
   *    外部链接随时可能失效，写死会在真机上表现为"点了没声音"。
   *    正式做法（二选一）：
   *      ① 预生成音频放云存储/CDN，用 fileID 播放（推荐：音质稳定、可缓存）
   *      ② 使用微信同声传译插件（需在小程序后台申请）
   *    配置好之后，把 audioUrlFor 的返回值改成你自己的地址即可。
   */
  speakWord: function (word) {
    var url = this.audioUrlFor(word);
    if (!url) return false;
    var ctx = wx.createInnerAudioContext();
    ctx.src = url;
    ctx.onError(function () { wx.showToast({ title: '读音加载失败', icon: 'none' }); });
    ctx.play();
    return true;
  },

  audioUrlFor: function (word) {
    return '';
  },

  /* ---------------- 交卷判分 ---------------- */

  submitQuiz: function () {
    var self = this;
    var questions = this.data.questions;
    var answers = this.data.answers;

    var details = [];
    var correctCount = 0;
    var wrongWordIds = [];

    questions.forEach(function (q, i) {
      var ans = answers[i];
      var word = self.wordById(q.wordId);
      var ok = false;
      var correctText = '';
      var userText = '';

      if (q.type === 'meaning') {
        correctText = word ? word.def_cn : '';
        userText = self.isAnswered(ans) ? String(ans) : '';
        ok = quizLib.isMeaningCorrect(userText, correctText);
      } else {
        correctText = q.wordId;
        var typed = Array.isArray(ans) ? ans.join('') : String(ans || '');
        userText = typed;
        ok = quizLib.isSpellingCorrect(typed, q.wordId, word ? word.variant : '');
      }

      if (ok) correctCount++;
      else wrongWordIds.push(q.wordId);

      details.push({
        wordId: q.wordId,
        type: q.type,
        typeLabel: self.typeLabelOf(q.type),
        ok: ok,
        userText: userText,
        correctText: correctText
      });
    });

    // 错词一律重置档位：与学习页"没想起来"同一条规则（只有一份实现）
    var now = Date.now();
    var mirror = this.mirror;
    wrongWordIds.forEach(function (wordId) {
      mirror[wordId] = srs.nextState(mirror[wordId] || null, 'forgot', now);
    });
    wx.setStorageSync(STORAGE_KEY, mirror);
    this.mirror = mirror;

    // 计入今日活跃
    var log = wx.getStorageSync(ACTIVITY_KEY) || {};
    var today = time.getLocalDate();
    log[today] = (log[today] || 0) + questions.length;
    wx.setStorageSync(ACTIVITY_KEY, log);

    // 同步云端（幂等 ID；未部署时静默失败）
    api.submitQuiz({
      answers: questions.map(function (q, i) {
        var a = answers[i];
        return { wordId: q.wordId, type: q.type, answer: Array.isArray(a) ? a.join('') : a };
      }),
      clientReqId: 'quiz-' + srs.newReqId()
    }).catch(function () {});

    var total = questions.length;
    var rate = total ? correctCount / total : 0;
    var wrongNames = details.filter(function (d) { return !d.ok; }).map(function (d) { return d.wordId; });

    this.setData({
      state: 'result',
      correct: correctCount,
      total: total,
      emoji: rate === 1 ? '🏆' : (rate >= 0.7 ? '👍' : '💪'),
      comment: rate === 1 ? '全对，这次抽查可以给家长看了'
        : (rate >= 0.7 ? '基本过关，但错词必须再过一遍' : '错得有点多，建议先回学习页巩固错词'),
      details: details,
      parentLine: '本次抽查 ' + total + ' 题，答对 ' + correctCount + ' 题。'
        + (wrongNames.length ? ('需要重点复习：' + wrongNames.join('、') + '。') : '')
        + ' 这些词已在 10 分钟后重新进入复习队列。'
    });

    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  wordById: function (word) {
    for (var i = 0; i < WORDS.length; i++) {
      if (WORDS[i].word === word) return WORDS[i];
    }
    return null;
  },

  onHome: function () {
    wx.redirectTo({ url: '/pages/index/index' });
  }
});
