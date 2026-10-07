/**
 * 快刷页 —— 背单词的新主流程
 *
 * 流程（2026-10-07 改版）：
 *   1. 首轮「快刷」：显示单词 + 音标，自动读音，下面两个中文释义二选一
 *      - ≤5 秒选对 → known（想得很快），直接下一词
 *      - 5~10 秒选对 → vague（想了很久才想起来），也过，但记进错题本待巩固
 *      - 选错 → forgot，进入词详情（看释义/例句/发音）
 *      - >10 秒没选 → 按"不会"处理，同上进详情
 *   2. 首轮结束后，凡是没被判 known 的词进入「循环轮次」：
 *      用现有的抽查方式（选义 / 拼写 / 听写）反复测，答错再看详情，
 *      直到全部答对为止（最多 MAX_ROUNDS 轮，避免孩子卡死出不来）
 *   3. 全部答对 → 完成态：本轮时长 + 错题本 + "继续学习 / 下一个任务"
 *
 * 为什么不再有"上滑看词"：自评（觉得自己会了）会高估掌握度。
 * 改成"先答、后看"：答得出来才算会，答不出来立刻给详情，不靠孩子自觉。
 *
 * 计时口径（与用户约定）：
 *   5 秒 = "想了很久"的分界线（之前讨论 SRS 时定下的 vague 阈值）
 *   10 秒 = 判定"不会"，自动进详情
 */

var api = require('../../utils/cloud').api;
var srs = require('../../utils/srs');
var quizLib = require('../../utils/quiz');
var time = require('../../utils/time');
var WORDS = require('../../data/words');
var books = require('../../utils/books');
var tts = require('../../utils/tts');
var report = require('../../utils/report');
var learnlog = require('../../utils/learnlog');
var assignParam = require('../../utils/assign');
var layout = require('../../utils/layout');

var STORAGE_KEY = 'word_state_mirror';
var CACHE_PREFIX = 'word_cache_v1:';

/** 超过 5 秒才答对 = "想了很久"（vague）；超过 10 秒没答 = 不会（forgot） */
var SLOW_MS = 5000;
var TIMEOUT_MS = 10000;
/** 循环轮次上限：超过就结束，把还没拿下的词摆在结果页，不把孩子锁死在循环里 */
var MAX_ROUNDS = 5;
/** 默认任务词数（没人布置作业时） */
var DEFAULT_WORDS = 10;

Page({
  behaviors: [layout.behavior()],

  data: {
    state: 'loading',        // loading | run | detail | done | empty
    phase: 'binary',         // binary（首轮快刷）| loop（错词循环）
    round: 1,
    words: [],               // 本轮词单（词对象）
    idx: 0,
    q: null,                 // 当前题
    pickedIdx: -1,           // 已选答案下标（选择题）
    kbValue: [],             // 键盘输入（拼写/听写题）
    kbText: '',              // 已输入字母的拼接串（WXML 表达式不支持 .join()，必须算好再给）
    slowHint: false,         // 是否已超过 5 秒（给"想很久了"的提示）
    detail: null,            // 详情态数据
    wrongBook: [],           // 全程曾错的词（去重，结果页展示）
    roundWrong: [],          // 本轮待巩固的词
    assignName: '',          // 班级作业名（空 = 默认任务）
    progressPct: 0,
    elapsedText: '',         // 结果页时长
    result: null,            // 完成态数据
    typeLabel: ''
  },

  /** @type {Object} 本地 SRS 镜像，与学习页/抽查页共用同一个 key */
  mirror: {},

  onLoad: function (options) {
    this.mirror = wx.getStorageSync(STORAGE_KEY) || {};
    this.startedAt = 0;

    // 班级作业：URL 带 ids 时，这一轮只练作业里的词
    if (options && options.ids) {
      this._assign = {
        ids: assignParam.parseIdsParam(options.ids),
        name: options.name ? decodeURIComponent(options.name) : '班级作业'
      };
      this.setData({ assignName: this._assign.name });
    }
    this.loadWords();
  },

  onUnload: function () { this.clearTimers(); },
  onHide: function () { this.clearTimers(); },

  clearTimers: function () {
    if (this._t5) { clearTimeout(this._t5); this._t5 = null; }
    if (this._t10) { clearTimeout(this._t10); this._t10 = null; }
  },

  /* ---------------- 取词单 ---------------- */

  /**
   * 组装这一轮要练的词：
   *   1) 有班级作业 → 作业词单（未掌握的优先）
   *   2) 否则云端今日任务（到期复习 + 错词 + 新词）
   *   3) 云端不可用 → 本地词库按 SRS 排序取默认数量
   */
  loadWords: function () {
    var self = this;
    if (this._assign && this._assign.ids.length) {
      this.startRound(this.assignmentWords(this._assign.ids));
      return;
    }

    api.todayTask(time.getLocalDate()).then(function (data) {
      var list = (data && (data.words || data.queue)) || [];
      var texts = list.map(function (w) {
        return typeof w === 'string' ? w : (w.word || w.word_id || w._id);
      }).filter(Boolean);
      if (!texts.length) throw new Error('EMPTY');
      self.startRound(self.byTexts(texts));
    }).catch(function (err) {
      console.warn('[drill] 云端任务取不到，用本地默认任务：',
        (err && (err.errMsg || err.message)) || err);
      self.startRound(self.localWords(DEFAULT_WORDS));
    });
  },

  /** 作业词单：没学过的排前面，已掌握的排后面（作业是"把这些词学会"） */
  assignmentWords: function (ids) {
    var now = Date.now();
    var self = this;
    var out = [];
    ids.forEach(function (t) {
      var w = self.findWord(t);
      if (!w) return;
      var st = self.mirror[w.word];
      var mastered = st && srs.isMastered(st);
      var learned = !!st;
      out.push({ w: w, rank: (mastered ? 3 : (learned ? 2 : 1)) + (st && st.wrong_count > 0 ? -0.5 : 0) });
    });
    out.sort(function (a, b) { return a.rank - b.rank; });
    return out.map(function (x) { return x.w; });
  },

  /** 云端任务返回的是词文本，转成本地词条对象 */
  byTexts: function (texts) {
    var self = this;
    var out = [];
    texts.forEach(function (t) {
      var w = self.findWord(t);
      if (w) out.push(w);
    });
    return out;
  },

  /** 本地默认任务：到期复习 > 错词 > 新词（与学习页同一套顺序） */
  localWords: function (n) {
    var now = Date.now();
    var self = this;
    var pool = books.getWords(books.getKey());
    var due = [], wrong = [], fresh = [];
    pool.forEach(function (w) {
      var st = self.mirror[w.word];
      if (!st) { fresh.push(w); return; }
      if (st.next_review_at && st.next_review_at <= now) due.push(w);
      else if (st.wrong_count > 0 && st.last_feedback !== 'known') wrong.push(w);
    });
    var ordered = due.concat(wrong).concat(fresh);
    return ordered.slice(0, n);
  },

  findWord: function (text) {
    var t = String(text || '').toLowerCase();
    for (var i = 0; i < WORDS.length; i++) {
      if (String(WORDS[i].word).toLowerCase() === t) return WORDS[i];
    }
    return null;
  },

  /* ---------------- 轮次 ---------------- */

  startRound: function (words, phase) {
    this.clearTimers();
    words = (words || []).filter(Boolean);
    if (!words.length) {
      this.setData({ state: 'empty' });
      return;
    }
    if (!this.startedAt) this.startedAt = Date.now();

    var self = this;
    var pool = books.getWords(books.getKey());
    var qs = words.map(function (w) { return self.buildQuestion(w, pool, phase || 'binary'); });

    this.setData({
      state: 'run',
      phase: phase || 'binary',
      words: words,
      idx: 0,
      round: phase === 'loop' ? (this.data.round + 1) : 1,
      roundWrong: [],
      progressPct: 0
    });
    this._qs = qs;
    this.showQuestion();
  },

  /**
   * 出一道题
   * @param {object} w 词条
   * @param {array} pool 同词库词表（干扰项用）
   * @param {string} phase binary（首轮二选一）/ loop（循环轮：随机现有题型）
   */
  buildQuestion: function (w, pool, phase) {
    if (phase === 'binary') {
      // 二选一：一个正确释义 + 一个干扰（优先同词性，更迷惑）
      var ds = quizLib.pickDistractors(w, pool, 1);
      var options = quizLib.shuffleWithAnswer(w.def_cn, ds);
      return {
        type: 'binary',
        wordId: w.word,
        word: w,
        options: options,
        answerIdx: options.indexOf(w.def_cn),
        answerText: w.def_cn
      };
    }
    // 循环轮：随机用现有抽查方式（选义 / 拼写 / 听写）
    var types = quizLib.QUESTION_TYPES;
    var type = types[Math.floor(Math.random() * types.length)];
    // 听写题必须出声 —— 没有本地发音的词（如外研四上新增词）出听写就是哑巴题，
    // 孩子听不到只能瞎拼。降级为"看中文拼写"，答案仍然是这个词
    if (type === 'listen' && !tts.hasAudio(w.word)) type = 'spell';
    var q = quizLib.buildQuestion(type, w, pool);
    q.word = w;
    q.answerText = w.def_cn;
    // quiz.buildQuestion 按"服务端判分"设计刻意不下发答案，但 drill 是本地判定，
    // 与首轮 binary 的 answerIdx 同一口径 —— 不补上这行，循环轮选义题永远判错
    // （2026-10-07 用户实锤：选了正确释义却被记 forgot，详情里"你选的=正确的"）
    if (q.options) q.answerIdx = q.options.indexOf(w.def_cn);
    return q;
  },

  showQuestion: function () {
    var i = this.data.idx;
    var q = this._qs[i];
    if (!q) { this.endRound(); return; }

    var labels = { binary: '选意思', meaning: '选意思', spell: '拼写', listen: '听写' };
    this.setData({
      state: 'run',
      q: q,
      pickedIdx: -1,
      kbValue: [],
      kbText: '',
      slowHint: false,
      detail: null,
      typeLabel: labels[q.type] || '',
      progressPct: Math.round(i * 100 / this._qs.length)
    });

    // 自动读音：单词一出现就念。拼写题例外 —— 一念就是把答案读出来；
    // 听写必须念（题面只有喇叭）
    if (q.type !== 'spell') this.speak();
    this.startTimer();
  },

  /** 5 秒提示 + 10 秒自动判不会 */
  startTimer: function () {
    var self = this;
    this.clearTimers();
    this.qStartAt = Date.now();
    this._t5 = setTimeout(function () {
      if (self.data.state !== 'run') return;
      self.setData({ slowHint: true });
    }, SLOW_MS);
    this._t10 = setTimeout(function () {
      if (self.data.state !== 'run') return;
      self.onTimeout();
    }, TIMEOUT_MS);
  },

  /** 超过 10 秒没答：按"不会"处理，进详情 */
  onTimeout: function () {
    if (!this.data.q) return;
    this.clearTimers();
    this.judge(false, TIMEOUT_MS, true);
  },

  /* ---------------- 作答 ---------------- */

  onPick: function (e) {
    if (this.data.state !== 'run') return;
    var idx = Number(e.currentTarget.dataset.idx);
    var q = this.data.q;
    if (!q) return;
    var elapsed = Date.now() - (this.qStartAt || Date.now());
    this.clearTimers();
    this.setData({ pickedIdx: idx });
    this.judge(idx === q.answerIdx, elapsed, false);
  },

  onKeyInput: function (e) {
    var v = e.detail.value || [];
    // kbText：拼好再给视图 —— WXML 的 {{}} 表达式不支持 .join() 这类方法调用，
    // 直接写 {{kbValue.join('')}} 永远渲染不出（2026-10-07"填写无效果"实锤）
    this.setData({ kbValue: v, kbText: v.join('') });
  },

  /** 键盘上的「确定」：拼完了就判 */
  onKeyConfirm: function () {
    var q = this.data.q;
    if (!q) return;
    var input = (this.data.kbValue || []).join('');
    if (!input) { this.next(); return; }
    var elapsed = Date.now() - (this.qStartAt || Date.now());
    this.clearTimers();
    var ok = quizLib.isSpellingCorrect(input, q.wordId, q.word && q.word.variant);
    this.judge(ok, elapsed, false);
  },

  /**
   * 判定一次作答
   * @param {boolean} ok 是否答对
   * @param {number} elapsed 用时（毫秒）
   * @param {boolean} timeout 是否超时未答
   */
  judge: function (ok, elapsed, timeout) {
    var q = this.data.q;
    if (!q) return;
    var word = q.word || this.findWord(q.wordId);

    // 反馈档位：超时/答错 = 不会；答对但超过 5 秒 = 想了很久
    var fb = 'known';
    if (!ok || timeout) fb = 'forgot';
    else if (elapsed > SLOW_MS) fb = 'vague';

    this.record(word, fb, q.type);

    // 错题本：凡是没被判 known 的都要再巩固
    var wrongBook = this.data.wrongBook.slice();
    if (fb !== 'known' && word) {
      var exists = wrongBook.some(function (x) { return x.word === word.word; });
      if (!exists) wrongBook.push(word);
    }
    var roundWrong = this.data.roundWrong.slice();
    if (fb !== 'known' && word) {
      var inRound = roundWrong.some(function (x) { return x.word === word.word; });
      if (!inRound) roundWrong.push(word);
    }

    this.setData({
      wrongBook: wrongBook,
      roundWrong: roundWrong
    });

    // 答对（哪怕想了很久）→ 直接下一词，不打断节奏；
    // 只有答错或超时才看详情 —— "看详情"是给不会的词准备的，不是给慢的词准备的
    if (!ok || timeout) {
      this.setData({
        state: 'detail',
        detail: {
          word: word,
          ok: false,
          timeout: !!timeout,
          yourPick: timeout ? '' : (this.data.pickedIdx >= 0
            ? (q.options ? q.options[this.data.pickedIdx] : this.data.kbValue.join(''))
            : ''),
          answer: q.answerText || (word ? word.def_cn : ''),
          fbLabel: timeout ? '超时没答，按不会记' : '答错了'
        }
      });
      return;
    }

    var self = this;
    // 答对：极短的确认反馈（让"换词"看得见，又不拖慢节奏）
    this.setData({ judgedOk: true });
    setTimeout(function () { self.setData({ judgedOk: false }); self.next(); }, 180);
  },

  /** 详情页「记住了，继续」 */
  onDetailNext: function () {
    this.setData({ detail: null });
    this.next();
  },

  next: function () {
    var i = this.data.idx + 1;
    if (i >= this._qs.length) { this.endRound(); return; }
    this.setData({ idx: i });
    this.showQuestion();
  },

  /* ---------------- 轮次结束 / 完成 ---------------- */

  endRound: function () {
    this.clearTimers();
    var left = this.data.roundWrong || [];
    var canLoop = left.length > 0 && this.data.round < MAX_ROUNDS;

    if (canLoop) {
      var self = this;
      this.setData({
        state: 'run',
        phase: 'loop',
        round: this.data.round + 1,
        roundWrong: []
      });
      var pool = books.getWords(books.getKey());
      this._qs = left.map(function (w) { return self.buildQuestion(w, pool, 'loop'); });
      this.setData({ idx: 0, words: left, progressPct: 0 });
      this.showQuestion();
      return;
    }
    this.finish();
  },

  finish: function () {
    this.clearTimers();
    var ms = Date.now() - (this.startedAt || Date.now());
    var totalSec = Math.round(ms / 1000);
    var mm = Math.floor(totalSec / 60);
    var ss = totalSec % 60;
    var left = this.data.roundWrong || [];

    this.setData({
      state: 'done',
      elapsedText: (mm ? mm + ' 分 ' : '') + ss + ' 秒',
      result: {
        total: this.data.words.length,
        mastered: Math.max(0, this.data.words.length - left.length),
        wrongBook: this.data.wrongBook,
        left: left,
        allDone: left.length === 0,
        assignName: this.data.assignName
      }
    });
    console.log('[drill] 本轮完成：' + this.data.words.length + ' 词，用时 ' +
      this.data.elapsedText + '，曾错 ' + this.data.wrongBook.length + ' 个');
  },

  /** 再把没拿下的词练一轮（结果页「继续学习」） */
  onAgain: function () {
    var left = (this.data.result && this.data.result.left) || [];
    if (left.length) {
      this.setData({ round: 1, wrongBook: [] });
      this.startRound(left, 'loop');
      return;
    }
    // 全对了还要点「继续」：重新取一轮默认任务
    this.setData({ round: 1, wrongBook: [], startedAt: 0 });
    this.startedAt = 0;
    this.loadWords();
  },

  /** 「下一个任务」：回首页，由首页重新取今日任务 */
  onNextTask: function () {
    wx.redirectTo({ url: '/pages/index/index' });
  },

  onHome: function () {
    wx.switchTab ? wx.switchTab({ url: '/pages/index/index' })
      : wx.redirectTo({ url: '/pages/index/index' });
  },

  /** 去错词本（统计页有错词本） */
  onWrongBook: function () {
    wx.navigateTo({ url: '/pages/stats/stats' });
  },

  /* ---------------- 记录与发音 ---------------- */

  /**
   * 记一次反馈：本地镜像 + 日报 + 流水 + 云端（幂等）
   * 与学习页 applyRating 同一套口径，保证三处（学习/抽查/快刷）的状态一致。
   */
  record: function (word, fb, type) {
    if (!word) return;
    var prev = this.mirror[word.word] || null;
    var next = srs.nextState(prev, fb, Date.now());

    this.mirror[word.word] = {
      stage: next.stage,
      last_feedback: next.lastFeedback,
      next_review_at: next.nextReviewAt,
      correct_count: (prev && prev.correct_count ? prev.correct_count : 0) + (fb === 'known' ? 1 : 0),
      wrong_count: (prev && prev.wrong_count ? prev.wrong_count : 0) + (fb === 'forgot' ? 1 : 0),
      last_wrong_type: fb === 'forgot' ? (type || 'drill') : (prev ? prev.last_wrong_type : null)
    };
    wx.setStorageSync(STORAGE_KEY, this.mirror);

    var log = wx.getStorageSync('activity_log') || {};
    var today = time.getLocalDate();
    log[today] = (log[today] || 0) + 1;
    wx.setStorageSync('activity_log', log);

    report.record(word.word, fb);

    var isAssign = !!(this._assign && this._assign.ids && this._assign.ids.length);
    var reqId = CACHE_PREFIX + srs.newReqId();
    var logId = learnlog.push({
      word: word.word,
      mode: isAssign ? 'assign' : 'task',
      assign: isAssign ? this._assign.name : '',
      feedback: fb,
      reqId: reqId
    });
    api.submitReview({
      wordId: word.word,
      feedback: fb,
      mode: 'learn',
      clientReqId: reqId
    }).then(function (res) {
      var errCode = (res && res.ok === false) ? (res.code || 'CLOUD_FAIL') : '';
      learnlog.patch(logId, errCode ? 'fail' : 'ok', errCode);
      console.log('[drill] ' + word.word + ' · ' + fb + ' → 云端' + (errCode ? '失败 ' + errCode : '已确认'));
    }).catch(function (err) {
      var msg = (err && (err.errMsg || err.message)) || String(err);
      learnlog.patch(logId, 'fail', msg);
      console.warn('[drill] submitReview 失败（已进补传队列）：', msg);
    });
  },

  /** 念当前词（拼写题禁止 —— 会把答案念出来） */
  speak: function () {
    var q = this.data.q || (this._qs && this._qs[this.data.idx]);
    if (q && q.type === 'spell') return;
    var w = (q && q.word) || (this.data.detail && this.data.detail.word);
    if (!w) return;
    tts.speak(w.word || w.wordId, function () { /* 没声音也不打断流程 */ });
  },

  onSpeak: function () { this.speak(); }
});
