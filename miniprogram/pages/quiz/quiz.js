/**
 * 抽查页 —— 逐题即时判对错 + 交卷出报告
 *
 * 与"练习"的本质区别仍然保留：答案是**交卷后统一记录进报告**的，逐题反馈只是"当场告诉你对没对"。
 *
 * 为什么改成逐题即时反馈（原为纯交卷制）：
 *   纯交卷制下，学生选错之后一路错到底，错的那 8 秒里他脑子里记住的是"我选的那个"，
 *   而不是正确释义——错误印象反而被巩固了一遍。当场给出正确答案，才是加深学习；
 *   同时流程不打断（看完自动进下一题），报告与错词回流都照旧。
 */

var api = require('../../utils/cloud').api;
var srs = require('../../utils/srs');
var quizLib = require('../../utils/quiz');
var keysLib = require('../../components/letter-keyboard/keys');
var time = require('../../utils/time');
var WORDS = require('../../data/words');
var books = require('../../utils/books');
var tts = require('../../utils/tts');
var report = require('../../utils/report');
var learnlog = require('../../utils/learnlog');
var layout = require('../../utils/layout');

var STORAGE_KEY = 'word_state_mirror';
var ACTIVITY_KEY = 'activity_log';
var QUESTION_COUNT = 10;
var MAX_REPLAY = 3;
/** 逐题反馈停留时长：够看清正确答案，又不打断节奏 */
var FEEDBACK_MS = 1800;

Page({
  behaviors: [layout.behavior],
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
    // 逐题即时反馈
    judged: false,
    feedbackOk: false,
    feedbackCorrect: '',
    feedbackUser: '',
    keyboardLabel: '',
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
    }).catch(function (err) {
      wx.hideLoading();
      // 云端未部署：用本地词库出题，判分规则与云端一致。
      // 留下线索：本地题的成绩提交云端也会失败，教练端看不到进度时先看这条
      console.warn('[cloud] generateQuiz 失败，本轮用本地题（成绩可能无法同步）：',
        (err && (err.errMsg || err.message)) || err);
      self.beginQuiz(self.localQuestions(QUESTION_COUNT), true);
    });
  },

  localQuestions: function (count) {
    var plan = quizLib.planTypes(count);
    // 只考当前词书里的词（与首页/学习页保持一致）
    var pool = books.getWords(books.getKey());
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
      wordId: q.wordId,
      level: this.resolveLevel(q.wordId)
    };

    if (cur.type === 'spell' || cur.type === 'listen') {
      var val = this.data.answers[i] || [];
      cur.slots = this.buildSlots(cur.wordId, cur.length, Array.isArray(val) ? val.join('') : '');
    }

    this.setData({
      cur: cur,
      typeLabel: this.typeLabelOf(cur.type),
      keyboardLabel: keysLib.levelLabel(cur.level),
      judged: false,
      feedbackOk: false,
      feedbackCorrect: '',
      feedbackUser: '',
      progressPct: Math.round(i / this.data.questions.length * 100),
      isLast: i === this.data.questions.length - 1,
      answeredCount: this.countAnswered(),
      played: this.playedCount[cur.wordId] || 0,
      playHint: cur.type === 'listen' ? this.playHintFor(cur.wordId) : ''
    });
  },

  /**
   * 拼写/听写的键盘难度：按这个词的掌握情况递进，答错过的自动降一档。
   *   新词 / 错过的词 → easy（只给正确字母，先保证"顺序"被记住）
   *   档位 ≥ 4        → hard（全键盘）
   *   其余            → medium（正确字母 + 形近易混字母）
   * 内测期可用 wx.setStorageSync('keyboard_level', 'easy'|'medium'|'hard') 强制指定。
   */
  resolveLevel: function (wordId) {
    var forced = wx.getStorageSync('keyboard_level');
    if (forced === 'easy' || forced === 'medium' || forced === 'hard') return forced;

    var st = this.mirror[wordId];
    if (!st) return 'easy';
    if (st.wrong_count >= 1) return 'easy';
    if (typeof st.stage === 'number' && st.stage >= 4) return 'hard';
    return 'medium';
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
    // 选完立刻判：不管选对选错都当场给出正确答案
    this.judgeCurrent();
  },

  /**
   * 当场判这一题并展示正确答案，短暂停顿后自动继续。
   * 注意：报告与错词回流仍在交卷时统一处理，这里只做"即时反馈"。
   */
  judgeCurrent: function () {
    var i = this.data.index;
    var q = this.data.questions[i];
    if (!q) return;

    var ans = this.data.answers[i];
    var word = this.wordById(q.wordId);
    var ok = false;
    var correctText = '';
    var userText = '';

    if (q.type === 'meaning') {
      correctText = word ? word.def_cn : '';
      userText = this.isAnswered(ans) ? String(ans) : '';
      ok = quizLib.isMeaningCorrect(userText, correctText);
    } else {
      correctText = q.wordId;
      var typed = Array.isArray(ans) ? ans.join('') : String(ans || '');
      userText = typed;
      ok = quizLib.isSpellingCorrect(typed, q.wordId, word ? word.variant : '');
    }

    this.setData({
      judged: true,
      feedbackOk: ok,
      feedbackCorrect: correctText,
      feedbackUser: userText
    });

    var self = this;
    clearTimeout(this._fbTimer);
    this._fbTimer = setTimeout(function () {
      if (self.data.isLast) self.submitQuiz();
      else self.goNext();
    }, FEEDBACK_MS);
  },

  onKeyInput: function (e) {
    var value = e.detail.value || [];
    var answers = this.data.answers.slice();
    answers[this.data.index] = value;
    this.setData({ answers: answers });
    this.renderQuestion();
  },

  /** 键盘上的「下一题 / 交卷」 */
  onKeyConfirm: function () {
    if (this.data.judged) { this.goNext(); return; }
    // 还没判过：先看对错，再继续（没作答就当作跳过，不判）
    if (!this.isAnswered(this.data.answers[this.data.index])) { this.goNext(); return; }
    this.judgeCurrent();
  },

  onPrev: function () {
    if (this.data.index === 0) return;
    clearTimeout(this._fbTimer);
    this.setData({ index: this.data.index - 1 });
    this.renderQuestion();
  },

  /** 页面上的「下一题 / 看报告」按钮 */
  onNext: function () {
    if (this.data.judged) { this.goNext(); return; }
    if (!this.isAnswered(this.data.answers[this.data.index])) { this.goNext(); return; }
    this.judgeCurrent();
  },

  goNext: function () {
    clearTimeout(this._fbTimer);
    if (this.data.isLast) { this.submitQuiz(); return; }
    this.setData({
      index: this.data.index + 1,
      judged: false,
      feedbackOk: false,
      feedbackCorrect: '',
      feedbackUser: ''
    });
    this.renderQuestion();
  },

  onPlay: function () {
    var q = this.data.cur;
    if (!q) return;
    var n = this.playedCount[q.wordId] || 0;
    if (n >= MAX_REPLAY) return;
    this.playedCount[q.wordId] = n + 1;

    if (!this.speakWord(q.wordId)) {
      wx.showToast({ title: '发音资源未就绪，请重新编译/更新版本', icon: 'none' });
    }
    this.renderQuestion();
  },

  /**
   * 发音：走 utils/tts.js（微信同声传译插件）。听写题里它就是"考试材料"。
   * 返回值表示发音请求是否成功发起（false 时调用方会提示）。
   */
  speakWord: function (word) {
    if (!tts.isAvailable()) return false;
    tts.speak(word, function (ok) {
      if (!ok) wx.showToast({ title: '朗读失败，请稍后再试', icon: 'none' });
    });
    return true;
  },

  /* ---------------- 交卷判分 ---------------- */

  submitQuiz: function () {
    var self = this;
    clearTimeout(this._fbTimer);
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

    // 日报/周报/月报的本地明细：每题一笔（答错记 forgot），云上出问题报告也不会空白
    details.forEach(function (d) { report.record(d.wordId, d.ok ? 'known' : 'forgot'); });

    // 流水：抽查也逐题记一笔（作业完成度不受抽查影响，但"学过没有"必须有据可查）
    var quizReqId = 'quiz-' + srs.newReqId();
    var quizLogIds = details.map(function (d) {
      return learnlog.push({
        word: d.wordId,
        mode: 'quiz',
        feedback: d.ok ? 'known' : 'forgot',
        reqId: quizReqId
      });
    });

    // 同步云端（幂等 ID；未部署时静默失败）
    api.submitQuiz({
      answers: questions.map(function (q, i) {
        var a = answers[i];
        return { wordId: q.wordId, type: q.type, answer: Array.isArray(a) ? a.join('') : a };
      }),
      clientReqId: quizReqId
    }).then(function (res) {
      var errCode = (res && res.ok === false) ? (res.code || 'CLOUD_FAIL') : '';
      quizLogIds.forEach(function (id) { learnlog.patch(id, errCode ? 'fail' : 'ok', errCode); });
      console.log('[learn] 抽查 ' + details.length + ' 题 → 云端' + (errCode ? '失败 ' + errCode : '已确认'));
    }).catch(function (err) {
      // 不完全静默：抽查成绩没上云时，教练端作业进度会停在 0，必须留下线索
      var msg = (err && (err.errMsg || err.message)) || String(err);
      quizLogIds.forEach(function (id) { learnlog.patch(id, 'fail', msg); });
      console.warn('[cloud] submitQuiz 失败，这次抽查成绩没有同步到云端：', msg);
    });

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
    // 在全库里找（不是当前词书）：题目一定来自当前词书，
    // 但这里只做单词对象查找，用全库兜底更稳，切换词书也不会查不到
    for (var i = 0; i < WORDS.length; i++) {
      if (WORDS[i].word === word) return WORDS[i];
    }
    return null;
  },

  onHome: function () {
    clearTimeout(this._fbTimer);
    wx.redirectTo({ url: '/pages/index/index' });
  },

  onUnload: function () {
    clearTimeout(this._fbTimer);
  }
});
