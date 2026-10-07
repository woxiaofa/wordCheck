/**
 * 快刷页 —— 背单词主流程（背词 + 抽查合并，2026-10-07 二次改版）
 *
 * 一个任务（如 10 个词）连着走两步，中间不回首页：
 *
 *   第 1 步「认」：读音 + 单词 + 音标 → 两个中文释义二选一
 *       · ≤5 秒选对 = known（想得很快），直接下一词
 *       · 5~10 秒选对 = vague（想了很久），也过，但记进错题本待巩固
 *       · 选错 / 点【不会】/ >10 秒没选 = forgot，进词详情
 *   第 2 步「写」：读音 + 音标 + 中文 → 自绘键盘拼英文
 *       · 难度由「简单 → 复杂」递进：easy（只给本词字母）
 *         → medium（加形近易混字母）→ hard（全键盘）
 *       · 起始档按这个词的掌握度定；拼错一次就降回 easy，先保证能拼出来
 *   第 3 步「巩固」：两轮里没拿下的词，换成现有抽查方式（选义/拼写/听写）
 *       反复测到全对，最多 MAX_ROUNDS 轮，不把孩子锁死
 *
 * 整个过程（答题中、答错看答案后）都可以无限点喇叭听读音；
 * 答错的详情页会引导"跟着念几遍"——只看不念记不住。
 *
 * 为什么两个按钮里要有【不会】：只给两个中文选项时，不会的孩子只能瞎蒙，
 * 蒙对了系统就当他学会了。给一个诚实的出口，数据才可信。
 *
 * 计时口径（与用户约定）：
 *   5 秒 = "想了很久"的分界线；10 秒 = "不会"（认）
 *   拼写本来就要花时间，写这一步放宽到 10 秒提示 / 25 秒判不会
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
var profile = require('../../utils/profile');

var STORAGE_KEY = 'word_state_mirror';
var CACHE_PREFIX = 'word_cache_v1:';

/** 选择题（认）的判定档位 */
var SLOW_MS = 5000;
var TIMEOUT_MS = 10000;
/** 拼写/听写（写）的判定档位：写字本来就慢，给更宽的时间 */
var WRITE_SLOW_MS = 10000;
var WRITE_TIMEOUT_MS = 25000;
/** 巩固轮次上限：超过就结束，把还没拿下的词摆在结果页，不把孩子锁死在循环里 */
var MAX_ROUNDS = 5;
/** 默认任务词数（没人布置作业时） */
var DEFAULT_WORDS = 10;

/** 这几种题型属于"写"：给更宽的超时，且题面要给音标 */
var WRITE_TYPES = { dictation: 1, spell: 1, listen: 1 };

var PHASE_TEXT = { recog: '认', spell: '写', loop: '巩固' };

Page({
  behaviors: [layout.behavior()],

  data: {
    state: 'loading',        // loading | run | detail | done | empty
    phase: 'recog',          // recog（认）| spell（写）| loop（巩固）
    round: 1,
    words: [],               // 本轮词单（词对象）
    idx: 0,
    q: null,                 // 当前题
    pickedIdx: -1,           // 已选答案下标（选择题）
    kbValue: [],             // 键盘输入（拼写/听写题）
    kbText: '',              // 已输入字母的拼接串（WXML 表达式不支持 .join()，必须算好再给）
    kbLevel: 'easy',         // 拼写键盘难度（简单 → 复杂）
    kbLevelLabel: '',
    slowHint: false,         // 是否已超过提示时间
    detail: null,            // 详情态数据
    wrongBook: [],           // 全程曾错的词（去重，结果页展示）
    roundWrong: [],          // 本轮待巩固的词
    assignName: '',          // 班级作业名（空 = 默认任务）
    progressPct: 0,
    stepText: '',            // "第 1 步 认 · 3/10"
    elapsedText: '',         // 结果页时长
    result: null,            // 完成态数据
    typeLabel: '',
    honor: null,             // 完成后的荣誉/排名（云端返回）
    me: { nickname: '', avatar: '' }   // 榜单展示用的昵称/头像（用户自愿填）
  },

  /** @type {Object} 本地 SRS 镜像，与学习页/抽查页共用同一个 key */
  mirror: {},

  onLoad: function (options) {
    this.mirror = wx.getStorageSync(STORAGE_KEY) || {};
    this.startedAt = 0;
    this._spellTries = {};       // 每个词本轮拼错的次数（决定键盘难度）
    this._honest = false;        // 本次作答是不是点了【不会】

    // 班级作业：URL 带 ids 时，这一轮只练作业里的词
    if (options && options.ids) {
      this._assign = {
        ids: assignParam.parseIdsParam(options.ids),
        name: options.name ? decodeURIComponent(options.name) : '班级作业'
      };
      this.setData({ assignName: this._assign.name });
    }
    this.setData({ me: profile.get() });
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
      this.startRound(this.assignmentWords(this._assign.ids), 'recog');
      return;
    }

    api.todayTask(time.getLocalDate()).then(function (data) {
      var list = (data && (data.words || data.queue)) || [];
      var texts = list.map(function (w) {
        return typeof w === 'string' ? w : (w.word || w.word_id || w._id);
      }).filter(Boolean);
      if (!texts.length) throw new Error('EMPTY');
      self.startRound(self.byTexts(texts), 'recog');
    }).catch(function (err) {
      console.warn('[drill] 云端任务取不到，用本地默认任务：',
        (err && (err.errMsg || err.message)) || err);
      self.startRound(self.localWords(DEFAULT_WORDS), 'recog');
    });
  },

  /** 作业词单：没学过的排前面，已掌握的排后面（作业是"把这些词学会"） */
  assignmentWords: function (ids) {
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
    var qs = words.map(function (w, i) { return self.buildQuestion(w, pool, phase, i, words.length); });

    var isLoop = phase === 'loop';
    this.setData({
      state: 'run',
      phase: phase,
      words: words,
      idx: 0,
      round: isLoop ? (this.data.round + 1) : this.data.round,
      progressPct: 0
    });
    this._qs = qs;
    this.showQuestion();
  },

  /**
   * 出一道题
   * @param {object} w 词条
   * @param {array} pool 同词库词表（干扰项用）
   * @param {string} phase recog（认：二选一）/ spell（写：听音拼写）/ loop（巩固：随机现有题型）
   * @param {number} i 在本轮词单里的位置（难度递进用）
   * @param {number} total 本轮词数
   */
  buildQuestion: function (w, pool, phase, i, total) {
    if (phase === 'recog') {
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

    if (phase === 'spell') {
      // 第 2 步「写」：读音 + 音标 + 中文释义 → 拼出英文。
      // 题面绝不显示单词本身（否则答案就在题面上），但这一档允许读音 ——
      // 它就是一道带提示的听写，念的是"这个词怎么读"，不是"选项哪个对"。
      return {
        type: 'dictation',
        wordId: w.word,
        word: w,
        stem: w.def_cn,
        length: String(w.word || '').length,
        level: this.spellLevel(w, i || 0, total || 0),
        answerText: w.word
      };
    }

    // 巩固轮：随机用现有抽查方式（选义 / 拼写 / 听写）
    var types = quizLib.QUESTION_TYPES;
    var type = types[Math.floor(Math.random() * types.length)];
    // 听写题必须出声 —— 没有本地发音的词（如外研四上新增词）出听写就是哑巴题，
    // 孩子听不到只能瞎拼。降级为"看中文拼写"，答案仍然是这个词
    if (type === 'listen' && !tts.hasAudio(w.word)) type = 'spell';
    var q = quizLib.buildQuestion(type, w, pool);
    q.word = w;
    q.answerText = w.def_cn;
    // quiz.buildQuestion 按"服务端判分"设计刻意不下发答案，但 drill 是本地判定，
    // 与首轮 binary 的 answerIdx 同一口径 —— 不补上这行，巩固轮选义题永远判错
    // （2026-10-07 用户实锤：选了正确释义却被记 forgot，详情里"你选的=正确的"）
    if (q.options) q.answerIdx = q.options.indexOf(w.def_cn);
    return q;
  },

  /**
   * 拼写键盘的难度：简单 → 复杂
   *   easy   只给这个词用到的字母（考顺序）
   *   medium 加形近易混字母（考辨认）
   *   hard   26 键全给（考完整拼写能力）
   * 起始档按掌握度定：没学过/刚学 → easy，学过几次 → medium，已掌握 → hard。
   * 拼错过就降回 easy —— 目的是让他拼出来，不是把他难住。
   * 另外一轮之内后 1/3 的词至少提到 medium，让这一轮本身也是由简到难。
   */
  spellLevel: function (w, i, total) {
    if ((this._spellTries && this._spellTries[w.word]) > 0) return 'easy';
    var st = this.mirror[w.word];
    var lv = 'easy';
    if (st && srs.isMastered(st)) lv = 'hard';
    else if (st && ((st.stage || 0) >= 2 || (st.correct_count || 0) >= 2)) lv = 'medium';
    if (lv === 'easy' && total >= 6 && i >= Math.ceil(total * 2 / 3)) lv = 'medium';
    return lv;
  },

  showQuestion: function () {
    var i = this.data.idx;
    var q = this._qs[i];
    if (!q) { this.endRound(); return; }

    var self = this;
    var labels = {
      binary: '选意思', meaning: '选意思',
      spell: '看中文拼写', listen: '听写', dictation: '听音拼写'
    };
    var kbLevel = q.level || 'easy';
    this.setData({
      state: 'run',
      q: q,
      pickedIdx: -1,
      kbValue: [],
      kbText: '',
      kbLevel: kbLevel,
      kbLevelLabel: levelLabel(kbLevel),
      slowHint: false,
      detail: null,
      typeLabel: labels[q.type] || '',
      stepText: this.stepText(i),
      progressPct: this.progressFor(i)
    });

    // 自动读音：单词一出现就念。
    // 例外：巩固轮的 spell（看中文拼写）题面只有中文，一念就是把答案读出来。
    if (q.type !== 'spell') this.speak();
    this.startTimer();
  },

  /** "第 1 步 认 · 3/10" 这类进度文案 */
  stepText: function (i) {
    var n = (this._qs && this._qs.length) || this.data.words.length || 0;
    var ph = this.data.phase;
    if (ph === 'loop') return '巩固 第 ' + this.data.round + ' 轮 · ' + (i + 1) + '/' + n;
    return '第 ' + (ph === 'recog' ? 1 : 2) + ' 步 ' + PHASE_TEXT[ph] + ' · ' + (i + 1) + '/' + n;
  },

  /** 总进度：认占一半、写占一半；巩固轮按本轮内进度 */
  progressFor: function (i) {
    var n = (this._qs && this._qs.length) || 1;
    var inPhase = (i + 1) / n;
    if (this.data.phase === 'recog') return Math.round(inPhase * 50);
    if (this.data.phase === 'spell') return Math.round(50 + inPhase * 50);
    return Math.round(inPhase * 100);
  },

  /** 提示 + 自动判不会（写字给更宽的时间） */
  startTimer: function () {
    var self = this;
    this.clearTimers();
    this.qStartAt = Date.now();
    var q = this.data.q;
    var isWrite = !!(q && WRITE_TYPES[q.type]);
    var slow = isWrite ? WRITE_SLOW_MS : SLOW_MS;
    var out = isWrite ? WRITE_TIMEOUT_MS : TIMEOUT_MS;
    this._t5 = setTimeout(function () {
      if (self.data.state !== 'run') return;
      self.setData({ slowHint: true });
    }, slow);
    this._t10 = setTimeout(function () {
      if (self.data.state !== 'run') return;
      self.onTimeout();
    }, out);
  },

  /** 超过时间没答：按"不会"处理，进详情 */
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

  /** 【不会】诚实按钮：不会就直说，别瞎蒙 —— 蒙对了系统会真当他学会了 */
  onDontKnow: function () {
    if (this.data.state !== 'run') return;
    var elapsed = Date.now() - (this.qStartAt || Date.now());
    this.clearTimers();
    this.judge(false, elapsed, false, true);
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
   * @param {boolean} honest 是否是点了【不会】
   */
  judge: function (ok, elapsed, timeout, honest) {
    var q = this.data.q;
    if (!q) return;
    var word = q.word || this.findWord(q.wordId);
    var slowAt = WRITE_TYPES[q.type] ? WRITE_SLOW_MS : SLOW_MS;

    // 反馈档位：不会/答错/超时 = 不会；答对但想了很久 = 想了很久
    var fb = 'known';
    if (!ok || timeout || honest) fb = 'forgot';
    else if (elapsed > slowAt) fb = 'vague';

    // 拼错过就记一笔，下次拼这个词降回最简单的键盘
    if (!ok || timeout || honest) {
      if (q.type === 'dictation' || q.type === 'spell' || q.type === 'listen') {
        if (word) this._spellTries[word.word] = (this._spellTries[word.word] || 0) + 1;
      }
    }

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
    // 只有答错/不会/超时才看详情 —— "看详情"是给不会的词准备的，不是给慢的词准备的
    if (!ok || timeout || honest) {
      var yourPick = '';
      if (honest) yourPick = '';
      else if (timeout) yourPick = '';
      else if (q.options) yourPick = q.options[this.data.pickedIdx] || '';
      else yourPick = this.data.kbValue.join('');

      this.setData({
        state: 'detail',
        detail: {
          word: word,
          ok: false,
          timeout: !!timeout,
          honest: !!honest,
          yourPick: yourPick,
          answer: q.answerText || (word ? word.def_cn : ''),
          fbLabel: honest ? '你点了「不会」' : (timeout ? '超时没答，按不会记' : '答错了'),
          speakCount: 0,
          guide: '先听一遍，跟着念出来（点上面的大喇叭）'
        }
      });
      return;
    }

    var self = this;
    // 答对：极短的确认反馈（让"换词"看得见，又不拖慢节奏）
    this.setData({ judgedOk: true });
    setTimeout(function () { self.setData({ judgedOk: false }); self.next(); }, 180);
  },

  /** 详情页「跟着念完了，继续」 */
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

  /**
   * 一步走完接下一步：认 → 写 → 巩固 → 完成。
   * 错题（roundWrong）在「认+写」两步里累积，到巩固轮统一收拾。
   */
  endRound: function () {
    this.clearTimers();
    var left = this.data.roundWrong || [];

    if (this.data.phase === 'recog') {
      // 第 1 步认完 → 立刻进入第 2 步写，同一批词，不清错题
      this.startRound(this.data.words, 'spell');
      return;
    }

    if (left.length && this.data.round < MAX_ROUNDS) {
      var self = this;
      this.setData({ phase: 'loop', round: this.data.round + 1 });
      var pool = books.getWords(books.getKey());
      this._qs = left.map(function (w, i) {
        return self.buildQuestion(w, pool, 'loop', i, left.length);
      });
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
        assignName: this.data.assignName,
        seconds: totalSec
      }
    });
    console.log('[drill] 本轮完成：' + this.data.words.length + ' 词，用时 ' +
      this.data.elapsedText + '，曾错 ' + this.data.wrongBook.length + ' 个');

    this.submitScore(totalSec, left.length);
  },

  /* ---------------- 成绩 / 荣誉 / 分享 ---------------- */

  /**
   * 上报成绩换荣誉与排名。
   * 排名按"同一个词库 / 同一份作业"分组比 —— 拿中考词去比外研四上没有意义。
   * 云端不可用就只显示本地荣誉（全对通关），不打断完成页。
   */
  submitScore: function (seconds, leftCount) {
    var self = this;
    var res = this.data.result || {};
    var key = this._assign ? ('assign:' + this._assign.name) : ('book:' + books.getKey());
    var perfect = leftCount === 0 && (this.data.wrongBook || []).length === 0;

    api.drillScore({
      key: key,
      keyName: this._assign ? this._assign.name : (books.currentName ? books.currentName() : ''),
      count: res.total || 0,
      seconds: seconds,
      perfect: perfect
    }).then(function (data) {
      if (!data) return;
      self.setData({
        honor: {
          rank: data.rank || 0,
          total: data.total || 0,
          beat: data.beat || 0,
          badge: data.badge || (perfect ? '🏅 全对通关' : ''),
          detail: data.detail || ''
        }
      });
    }).catch(function (err) {
      // 榜单挂了不影响练词，只给本地荣誉
      self.setData({ honor: { badge: perfect ? '🏅 全对通关' : '', detail: '' } });
      console.warn('[drill] 成绩上报失败（不影响本轮结果）：',
        (err && (err.errMsg || err.message)) || err);
    });
  },

  onShareAppMessage: function () {
    var r = this.data.result || {};
    var h = this.data.honor || {};
    var title = h.badge
      ? (h.badge + ' · ' + r.total + ' 个词用时 ' + this.data.elapsedText)
      : ('我用 ' + this.data.elapsedText + ' 拿下 ' + r.mastered + '/' + r.total + ' 个单词');
    if (h.beat) title += '，打败了 ' + h.beat + '% 的人';
    return { title: title, path: '/pages/index/index' };
  },

  /* ---------------- 头像 / 昵称（榜单用） ---------------- */

  onChooseAvatar: function (e) {
    var url = e && e.detail && e.detail.avatarUrl;
    if (!url) return;
    var self = this;
    profile.setAvatar(url, function (saved) {
      self.setData({ 'me.avatar': saved || url });
    });
  },

  onNicknameInput: function (e) {
    var v = (e && e.detail && e.detail.value) || '';
    profile.setNickname(v);
    this.setData({ 'me.nickname': v });
  },

  /* ---------------- 结果页动作 ---------------- */

  /** 再把没拿下的词练一轮（结果页「继续学习」） */
  onAgain: function () {
    var left = (this.data.result && this.data.result.left) || [];
    if (left.length) {
      this.setData({ round: 1, wrongBook: [], roundWrong: [] });
      this.startRound(left, 'recog');
      return;
    }
    // 全对了还要点「继续」：重新取一轮默认任务
    this.setData({ round: 1, wrongBook: [], roundWrong: [] });
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

  /**
   * 念当前词。答题中和详情页都能无限点 —— 记单词不看读音等于只记一半。
   * 唯一的例外：巩固轮的 spell（题面只有中文，念出来就是答案）。
   */
  speak: function () {
    var q = this.data.q || (this._qs && this._qs[this.data.idx]);
    if (q && q.type === 'spell') return;
    var w = (q && q.word) || (this.data.detail && this.data.detail.word);
    if (!w) return;
    tts.speak(w.word || w.wordId, function () { /* 没声音也不打断流程 */ });

    // 详情页：数着念了几遍，并给出"再念几遍"的引导
    if (this.data.state === 'detail' && this.data.detail) {
      var n = (this.data.detail.speakCount || 0) + 1;
      var guide = n < 2 ? '再念 ' + (2 - n) + ' 遍，嘴巴动起来才记得住'
        : (n < 4 ? '很好，再跟着念一遍' : '念得不错 —— 这个词等下还会再考你');
      this.setData({ 'detail.speakCount': n, 'detail.guide': guide });
    }
  },

  onSpeak: function () { this.speak(); }
});

/** 键盘难度文案（复用组件里的实现，避免两处各写一套） */
function levelLabel(level) {
  try {
    return require('../../components/letter-keyboard/keys').levelLabel(level);
  } catch (e) {
    return level === 'easy' ? '仅正确字母' : (level === 'medium' ? '含易混字母' : '全键盘');
  }
}
