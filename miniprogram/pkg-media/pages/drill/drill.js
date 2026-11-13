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

var theme = require('../../../utils/theme');
var api = require('../../../utils/cloud').api;
var srs = require('../../../utils/srs');
var quizLib = require('../../../utils/quiz');
var time = require('../../../utils/time');
var WORDS = require('../../../data/words');
var books = require('../../../utils/books');
var tts = require('../../../utils/tts');
var sfx = require('../../../utils/sfx');
var report = require('../../../utils/report');
var learnlog = require('../../../utils/learnlog');
var assignParam = require('../../../utils/assign');
var layout = require('../../../utils/layout');
var profile = require('../../../utils/profile');
var fit = require('../../../utils/fit');
var asgcache = require('../../../utils/asgcache');
/* 2026-11-13 用户拍板：旧第 0 步前置闸门与独立跟读页一起删除，
   drill 不再需要录音能力；跟读统一在 pkg-oral/pages/flow 里按住完成。 */
/* 2026-11-12：被口语体验主流程（pkg-oral/pages/flow）拉起时，
   本页只负责「书面」阶段，结果交给 flow 出合并报告，不再显示自己的完成页。 */
var oralFlow = require('../../../utils/oral-flow');

var STORAGE_KEY = 'word_state_mirror';
var CACHE_PREFIX = 'word_cache_v1:';

/** 选择题（认）的判定档位 */
var SLOW_MS = 5000;
var TIMEOUT_MS = 10000;
/** 拼写/听写（写）的判定档位：按字母数算，不再一刀切
 *  一刀切 25 秒的毛病：3 个字母的词太宽松（孩子干等着被判超时），
 *  12 个字母的词太紧（还没敲完就被记"不会"）。按每个字母 2.5 秒给，
 *  再夹在 12~45 秒之间（太短来不及敲，太长失去紧迫感）。 */
var PER_LETTER_MS = 2500;
/** 取词（云端 todayTask）超过这个时长还没回来，就把等待文案换成「网络有点慢」。
 *  2026-11-13 真机反馈「口语到背词等得有点久」：转圈解决了"知不知道在跑"，
 *  这条解决"跑到哪了"——真慢的时候得让孩子和家长知道是网络，不是死机。 */
var SLOW_LOAD_MS = 4000;
var WRITE_BASE_MS = 6000;
var WRITE_MIN_MS = 12000;
var WRITE_MAX_MS = 45000;
/** 巩固轮次上限：超过就结束，把还没拿下的词摆在结果页，不把孩子锁死在循环里
 *  （2026-10-07 从 5 改 3：3 轮还拼不出来的词，继续磨的收益不如回详情多念几遍） */
var MAX_ROUNDS = 3;

/** 详情页「抄写」的键盘难度递进：抄得越多，键盘越接近真实（要自己找字母） */
/** 默认任务词数（没人布置作业时） */
var DEFAULT_WORDS = 10;

/** 这几种题型属于"写"：给更宽的超时，且题面要给音标 */
/** 需要动笔写的题型（超时按字母数放宽、拼错降键盘难度）：情景填句也算 */
var WRITE_TYPES = { dictation: 1, spell: 1, listen: 1, cloze: 1 };

var PHASE_TEXT = { recog: '认', spell: '写', loop: '巩固' };

/** 拼写题超时：6 秒起步 + 每个字母 2.5 秒，夹在 12~45 秒 */
function writeTimeoutMs(len) {
  var n = Math.max(1, len || 0);
  var ms = WRITE_BASE_MS + PER_LETTER_MS * n;
  return Math.min(WRITE_MAX_MS, Math.max(WRITE_MIN_MS, ms));
}

/** 提示"想了很久"的时点：超时的 60%（还没到判不会，先催一下） */
function writeSlowMs(len) {
  return Math.round(writeTimeoutMs(len) * 0.6);
}

/** 取出当前题要拼的单词长度（拼写/听写题才有意义） */
function wordLenOf(q) {
  if (!q) return 0;
  if (q.length) return Number(q.length) || 0;
  var w = (q.word && (q.word.word || q.word.word_id)) || q.wordId || '';
  return String(w).length;
}

Page({
  behaviors: [layout.behavior()],

  data: {
    skin: theme.cls(),
    state: 'loading',        // loading | run | detail | done | empty
    phase: 'recog',          // recog（认）| spell（写）| loop（巩固）
    round: 1,
    words: [],               // 本轮词单（词对象）
    idx: 0,
    q: null,                 // 当前题
    pickedIdx: -1,           // 已选答案下标（选择题）
    kbValue: [],             // 键盘输入（拼写/听写题）
    kbText: '',              // 已输入字母的拼接串（WXML 表达式不支持 .join()，必须算好再给）
    kbCaret: 0,              // 插入光标位置（0~kbValue.length），支持从中间插入字母
    slowHint: false,         // 是否已超过提示时间
    detail: null,            // 详情态数据
    wrongBook: [],           // 全程曾错的词（去重，结果页展示）
    roundWrong: [],          // 本轮待巩固的词
    landscape: false,        // iPad 横屏提示条
    assignName: '',          // 班级作业名（空 = 默认任务）
    offline: false,          // 这一轮是不是断网练（词单来自本机快照）
    progressPct: 0,
    stepText: '',            // "第 1 步 认 · 3/10"
    elapsedText: '',         // 结果页时长
    result: null,            // 完成态数据
    typeLabel: '',
    honor: null,             // 完成后的荣誉/排名（云端返回）
    honorPeriods: [],        // 今日/本周/本月最快（云端返回后拼好文案）
    slowLoad: false,         // 取词超过 4 秒还没回来：换成「网络有点慢」的说明
    me: { nickname: '', avatar: '' }   // 榜单展示用的昵称/头像（用户自愿填）
  },

  /** @type {Object} 本地 SRS 镜像，与学习页/抽查页共用同一个 key */
  mirror: {},

  onShow: function () {
    theme.syncPage(this);
  },

  onLoad: function (options) {
    this.mirror = wx.getStorageSync(STORAGE_KEY) || {};
    // iPad 横屏：内容按宽度自适应会放得特别大（2026-10-09 用户反馈），提示竖屏
    this.setData({ landscape: fit.isLandscape() });
    this.startedAt = 0;
    this._spellTries = {};       // 每个词本轮拼错的次数（决定键盘难度）
    this._honest = false;        // 本次作答是不是点了【不会】
    this._carryMs = 0;           // 详情页停留时长，计入学习简报的"学了多久"
    this._detailAt = 0;
    /* 体验主流程的书面阶段：finish 时不显示本页完成页，也不上报成绩榜单，
       把结果写进 oral-flow 会话后直接回 flow 出合并报告。
       2026-11-13 起本页没有任何口语分支：带不带参数都直接进「认」。 */
    this._fromFlow = !!(options && options.fromFlow === '1');

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

  onUnload: function () {
    this.clearTimers();
  },
  onResize: function () { this.setData({ landscape: fit.isLandscape() }); },
  onHide: function () {
    this.clearTimers();
  },

  clearTimers: function () {
    if (this._t5) { clearTimeout(this._t5); this._t5 = null; }
    if (this._t10) { clearTimeout(this._t10); this._t10 = null; }
    if (this._slowTimer) { clearTimeout(this._slowTimer); this._slowTimer = null; }
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
    // 只改等待文案，不改词单来源：取词超过 SLOW_LOAD_MS 才换成「网络有点慢」。
    if (this._slowTimer) clearTimeout(this._slowTimer);
    this._slowTimer = setTimeout(function () {
      self._slowTimer = null;
      if (self.data.state === 'loading') self.setData({ slowLoad: true });
    }, SLOW_LOAD_MS);

    if (this._assign && this._assign.ids.length) {
      this.begin(this.assignmentWords(this._assign.ids));
      return;
    }

    api.todayTask(time.getLocalDate()).then(function (data) {
      var list = (data && (data.words || data.queue)) || [];
      var texts = list.map(function (w) {
        return typeof w === 'string' ? w : (w.word || w.word_id || w._id);
      }).filter(Boolean);
      if (!texts.length) throw new Error('EMPTY');
      self.begin(self.byTexts(texts));
    }).catch(function (err) {
      console.warn('[drill] 云端任务取不到：', (err && (err.errMsg || err.message)) || err);
      // 断网时优先接本机留存的作业词单：孩子该练的是老师布置的那批词，
      // 直接退回默认词库等于"联网时一批、断网时另一批"，进度对不上又要解释一遍。
      // 还是没有才退回本地默认任务 —— 任何情况下都得有得练。
      if (self.startCachedAssignment()) return;
      self.begin(self.localWords(DEFAULT_WORDS));
    });
  },

  /** @returns {boolean} 是否成功启动了本机留存的作业 */
  startCachedAssignment: function () {
    var cached = asgcache.latest();
    if (!cached || !cached.ids.length) return false;
    var words = this.assignmentWords(cached.ids);
    if (!words.length) return false;
    this._assign = { ids: cached.ids, name: cached.name };
    this.setData({ assignName: cached.name, offline: true });
    this.begin(words);
    return true;
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

  /* ---------------- 取词完毕的统一入口 ----------------
   * 2026-11-13 用户拍板：旧第 0 步前置闸门连同独立跟读页一起删除。
   * 无论带不带 URL 参数、无论是不是班级作业，一律直接进原来的「认 → 写 → 巩固」，
   * 40+ 条 drill-flow 断言的前提保持不动；口语只在 pkg-oral/pages/flow 里按住完成。 */

  /** 取词完毕的统一入口：四条取词分支都过这里，统一进第 1 步「认」 */
  begin: function (words) {
    words = (words || []).filter(Boolean);
    this.startRound(words, 'recog');
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
    // 总词数口径（完成页"已拿下 x/y"用）：认写两步是同一批词，只在第一遍计数。
    // 之前用"最后一轮的 words.length"当总数，巩固轮里只剩错词时完成页显示 0/6（实锤）
    if (phase === 'recog' && this.data.round === 1) this._totalWords = words.length;
    this.setData({
      state: 'run',
      phase: phase,
      words: words,
      idx: 0,
      round: isLoop ? (this.data.round + 1) : this.data.round,
      progressPct: 0,
      slowLoad: false
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
      var options = shuffleAny(quizLib.shuffleWithAnswer(w.def_cn, ds));
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
      // 没有本地发音的词不能出"听音拼写"——喇叭按了没声，孩子只能干等（哑巴题），
      // 降级为"看中文拼写"，跟巩固轮同一个口径。
      var hasSound = tts.hasAudio(w.word);
      return {
        type: hasSound ? 'dictation' : 'spell',
        wordId: w.word,
        word: w,
        stem: w.def_cn,
        length: String(w.word || '').length,
        answerText: w.word
      };
    }

    // 巩固轮：随机用现有抽查方式（选义 / 拼写 / 听写）
    var types = quizLib.QUESTION_TYPES;
    var type = types[Math.floor(Math.random() * types.length)];
    // 情景填句：有这个词的例句素材时才插进来（约三成）—— 只换考查方式，
    // 不改变"必须写出来"这件事；没素材的词由 buildQuestion 自动降级成拼写
    if (quizLib.hasSentence(w.word) && Math.random() < 0.3) type = 'cloze';
    // 听写题必须出声 —— 没有本地发音的词（如外研四上新增词）出听写就是哑巴题，
    // 孩子听不到只能瞎拼。降级为"看中文拼写"，答案仍然是这个词
    if (type === 'listen' && !tts.hasAudio(w.word)) type = 'spell';
    var q = quizLib.buildQuestion(type, w, pool);
    q.word = w;
    // 答案文案按题型给：选义题是中文释义，拼写/听写题是单词本身。
    // 之前一刀切给 def_cn，详情里出现过"你拼的是「!eastern」，正确的是「东方的；向东的」"
    // —— 拼写题拿中文当答案，孩子看得一头雾水（2026-10-07 实锤）
    q.answerText = (type === 'meaning') ? w.def_cn : w.word;
    // quiz.buildQuestion 按"服务端判分"设计刻意不下发答案，但 drill 是本地判定，
    // 与首轮 binary 的 answerIdx 同一口径 —— 不补上这行，巩固轮选义题永远判错
    // （2026-10-07 用户实锤：选了正确释义却被记 forgot，详情里"你选的=正确的"）
    if (q.options) {
      // 真随机再洗一次：shuffleWithAnswer 按答案字符码取模定位置（服务端复现用），
      // 二选一时等价于"答案位置由单词拼写决定"——用户实测"对了几次之后正确答案一直是第二个"
      q.options = shuffleAny(q.options);
      q.answerIdx = q.options.indexOf(w.def_cn);
    }
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
  showQuestion: function () {
    var i = this.data.idx;
    var q = this._qs[i];
    if (!q) { this.endRound(); return; }

    var self = this;
    var labels = {
      binary: '选意思', meaning: '选意思',
      spell: '看中文拼写', listen: '听写', dictation: '听音拼写',
      cloze: '情景填句'
    };
    this.setData({
      state: 'run',
      q: q,
      pickedIdx: -1,
      kbValue: [],
      kbText: '',
      kbCaret: 0,
      slowHint: false,
      detail: null,
      typeLabel: labels[q.type] || '',
      stepText: this.stepText(i),
      progressPct: this.progressFor(i)
    });

    // 自动读音：单词一出现就念。
    // 例外：巩固轮的 spell（看中文拼写）题面只有中文，一念就是把答案读出来。
    // cloze 同理：句子里挖掉的那个词正是答案，念出来等于报答案。
    if (q.type !== 'spell' && q.type !== 'cloze') this.speak();
    this.startTimer();
    this._qShownAt = Date.now();     // 学习时长的计时起点（judge 里取用）
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
    var slow = isWrite ? writeSlowMs(wordLenOf(q)) : SLOW_MS;
    var out = isWrite ? writeTimeoutMs(wordLenOf(q)) : TIMEOUT_MS;
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
    var d = e.detail || {};
    var v = d.value || [];
    // kbText：拼好再给视图 —— WXML 的 {{}} 表达式不支持 .join() 这类方法调用，
    // 直接写 {{kbValue.join('')}} 永远渲染不出（2026-10-07"填写无效果"实锤）
    var caret = (d.caret === undefined || d.caret === null) ? v.length : Number(d.caret);
    if (isNaN(caret) || caret < 0 || caret > v.length) caret = v.length;
    this.setData({ kbValue: v, kbText: v.join(''), kbCaret: caret });
  },

  /** 点已输入的某个字母：光标移到它前面 —— 拼错中间一个字母不必清空重打 */
  onTypedTap: function (e) {
    var pos = Number(e.currentTarget.dataset.pos);
    var len = (this.data.kbValue || []).length;
    if (isNaN(pos) || pos < 0) return;
    if (pos > len) pos = len;
    this.setData({ kbCaret: pos });
  },

  /** 点输入区空白处：光标回末尾（继续往后拼） */
  onTypedEndTap: function () {
    this.setData({ kbCaret: (this.data.kbValue || []).length });
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
    var isWrite = !!WRITE_TYPES[q.type];
    var slowAt = isWrite ? writeSlowMs(wordLenOf(q)) : SLOW_MS;

    // 这个词花了多久：从题面出现到判定 + 之前看详情的时长。
    // 学习简报的"经过 X 分钟"就是把这些 durationMs 逐条加起来 ——
    // 之前从不传时长，云端一律记 0，简报永远显示"经过 1 分钟"（2026-10-07 实锤）。
    var raw = Date.now() - (this._qShownAt || Date.now());
    var wordMs = Math.min(600000, Math.max(0, raw)) + (this._carryMs || 0);
    this._carryMs = 0;

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

    // 错拼原文：这是字母级诊断（错在第几个字母 / 少写还是写错）唯一的原料，
    // 也是拍照批改类产品拿不到的东西 —— 云端只有在客户端把它交上去时才有。
    // 只对"没答对"的词记：拼对的词谈"错在哪"没有意义。
    var wrongInput = '';
    if (!ok || timeout || honest) {
      wrongInput = q.options
        ? (q.options[this.data.pickedIdx] || '')
        : (this.data.kbValue || []).join('');
    }

    this.record(word, fb, q.type, wordMs, wrongInput);

    // 错题本：凡是没被判 known 的都要再巩固
    var wrongBook = this.data.wrongBook.slice();
    if (fb !== 'known' && word) {
      var exists = wrongBook.some(function (x) { return x.word === word.word; });
      if (!exists) wrongBook.push(word);
    }
    // 待巩固名单：答错/超时/点不会的进来；答对的（包括想了很久但答对的）出去 ——
    // 会了的词不该一遍遍重复（2026-10-07 用户实锤：巩固第 5 轮还是同样 6 个词，
    // 完成页"已拿下 0/6"。根因就是答对从不出列）
    var roundWrong = this.data.roundWrong.slice();
    if (fb !== 'known' && word) {
      var inRound = roundWrong.some(function (x) { return x.word === word.word; });
      if (!inRound) roundWrong.push(word);
    } else if (word) {
      roundWrong = roundWrong.filter(function (x) { return x.word !== word.word; });
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

      // 是"选"出来的错还是"拼"出来的错：文案不一样，混着说孩子看不懂
      var pickVerb = q.options ? '选' : '拼';

      // 答错反馈：低沉提示音 + 中震（#36）—— 与答对的"叮！"形成对比，
      // 孩子不看屏幕也知道这题没对，接下来要看详情了
      sfx.playWrong();
      if (wx.vibrateShort) wx.vibrateShort({ type: 'medium' });

      this.setData({
        state: 'detail',
        detail: {
          word: word,
          ok: false,
          timeout: !!timeout,
          honest: !!honest,
          pickVerb: pickVerb,
          yourPick: yourPick,
          answer: q.answerText || (word ? word.def_cn : ''),
          answerVerb: q.options ? '正确的是' : '正确拼写是',
          fbLabel: honest ? '你点了「不会」' : (timeout ? '超时没答，按不会记' : '答错了'),
          speakCount: 0,
          guide: '先听一遍，跟着念出来（点上面的大喇叭）',
          // 抄写：光看念不够，动手拼一遍才记得住。点了「✍ 抄写一遍」才展开键盘
          writing: false,
          copyCount: 0,
          copyOk: false,
          copyMsg: '',
          copyLength: String((word && word.word) || '').length
        }
      });
      this._detailAt = Date.now();
      return;
    }

    var self = this;
    // 答对：中央 ✓ 庆祝动画 + 清脆音效 + 轻震，短暂停留后进下一词。
    // 2026-10-10 曾因 180ms 太快被说"一闪而过"放到 1s；2026-10-19 用户反馈
    // 1s 又偏慢、显得散漫，孩子连续答题的劲头会断 —— 折中 550ms，动画同步压短。
    this.setData({ judgedOk: true, celebrate: true });
    sfx.playCorrect();
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
    setTimeout(function () {
      self.setData({ judgedOk: false, celebrate: false });
      self.next();
    }, 550);
  },

  /** 详情页「跟着念完了，继续」：把看详情的时长记进总学习时长（简报口径） */
  onDetailNext: function () {
    if (this._detailAt) {
      this._carryMs += Date.now() - this._detailAt;
      this._detailAt = 0;
    }
    this.setData({ detail: null, kbValue: [], kbText: '', kbCaret: 0 });
    this.next();
  },

  /**
   * 详情页「✍ 抄写一遍」：照着上面的词用键盘拼一遍。
   * 念是耳朵记，抄是手记 —— 两样都做了才算真过一遍。想抄几遍抄几遍。
   * 键盘 2026-10-09 起恒全键盘（与电脑键位一致），抄写不再分难度档。
   */
  onDetailWrite: function () {
    var d = this.data.detail;
    if (!d || !d.word) return;
    this.setData({
      kbValue: [], kbText: '', kbCaret: 0,
      'detail.writing': true,
      'detail.copyOk': false,
      'detail.copyMsg': '照着上面的词，用键盘拼一遍',
      'detail.copyLength': String(d.word.word || '').length,
      // 抄写时单词悬浮置顶（页面再长也不会划走）；可一键遮住自己默写
      'detail.wordHidden': false,
      'detail.maskText': maskOf(d.word.word)
    });
    this.speak();     // 抄之前先念一遍，耳朵带着手走
  },

  /** 抄完这一遍：对了记一遍、可继续抄；错了指出第几个字母不对（不清空，可直接改） */
  onCopyConfirm: function () {
    var d = this.data.detail;
    if (!d || !d.word) return;
    var input = (this.data.kbValue || []).join('');
    if (!input) {
      // 抄对后输入框会清空，此时点「继续抄」什么都没发生会让人以为按坏了
      this.setData({
        'detail.copyMsg': (d.copyCount || 0)
          ? '照着上面的词再拼一遍，拼完点「继续抄」'
          : '先照着上面的词拼一遍'
      });
      return;
    }
    var target = String(d.word.word || '');

    if (quizLib.isSpellingCorrect(input, target, d.word.variant)) {
      var n = (d.copyCount || 0) + 1;
      this.setData({
        kbValue: [], kbText: '', kbCaret: 0,
        'detail.copyCount': n,
        'detail.copyOk': true,
        'detail.copyMsg': n < 3
          ? ('👍 第 ' + n + ' 遍抄对了 —— 再抄一遍更牢，也可以点「下一词」')
          : ('👍 已经抄了 ' + n + ' 遍，这个词稳了')
      });
      return;
    }
    this.setData({ 'detail.copyOk': false, 'detail.copyMsg': copyDiffHint(input, target) });
  },

  /** 收起抄写键盘（抄了几遍就记几遍，不影响判定） */
  onCopyClose: function () {
    this.setData({
      'detail.writing': false,
      kbValue: [], kbText: '', kbCaret: 0
    });
  },

  /**
   * 抄写时切换"看词 / 遮住默写"。
   * 遮住时按字母数摆一排圆点 —— 还是知道有几个字母，只是得自己想，
   * 这才是默写的意义；全遮成一片空白只会让人瞎猜。
   */
  onToggleWord: function () {
    var d = this.data.detail;
    if (!d) return;
    var hide = !d.wordHidden;
    this.setData({
      'detail.wordHidden': hide,
      'detail.copyMsg': hide
        ? '词已经遮住了 —— 凭记忆拼一遍，实在想不起来点「显示」'
        : '照着上面的词，用键盘拼一遍'
    });
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
    var total = this._totalWords || this.data.words.length;
    var elapsedText = (mm ? mm + ' 分 ' : '') + ss + ' 秒';

    /* 体验主流程的书面阶段结束：只交结果，不出自己的完成页、不上报榜单。
       榜单的意义是「同一份任务比谁快」，体验流程的口语段没有计时口径，混进去会失真。 */
    if (this._fromFlow) {
      oralFlow.setDrillResult({
        total: total,
        mastered: Math.max(0, total - left.length),
        seconds: totalSec,
        elapsedText: elapsedText,
        allDone: left.length === 0
      });
      wx.redirectTo({ url: '/pkg-oral/pages/flow/flow?report=1' });
      return;
    }

    this.setData({
      state: 'done',
      elapsedText: (mm ? mm + ' 分 ' : '') + ss + ' 秒',
      result: {
        total: total,
        mastered: Math.max(0, total - left.length),
        wrongBook: this.data.wrongBook,
        left: left,
        allDone: left.length === 0,
        assignName: this.data.assignName,
        seconds: totalSec
      }
    });
    console.log('[drill] 本轮完成：' + total + ' 词，用时 ' +
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
        },
        honorPeriods: self.periodRows(data.periods)
      });
    }).catch(function (err) {
      // 榜单挂了不影响练词，只给本地荣誉
      self.setData({ honor: { badge: perfect ? '🏅 全对通关' : '', detail: '' }, honorPeriods: [] });
      console.warn('[drill] 成绩上报失败（不影响本轮结果）：',
        (err && (err.errMsg || err.message)) || err);
    });
  },

  /**
   * 把云端返回的周期榜（今日/本周/本月最快）拼成完成页的三行文案。
   * 榜首是我：直说"就是你"；不是我：报榜首 + 我的名次（没名次就只报榜首）。
   */
  periodRows: function (periods) {
    if (!periods) return [];
    var labels = { day: '今日最快', week: '本周最快', month: '本月最快' };
    var rows = [];
    ['day', 'week', 'month'].forEach(function (p) {
      var it = periods[p];
      if (!it || !it.total) return;
      var leader = it.leader || {};
      var who = leader.mine ? '就是你' : (leader.nickname || '暂无昵称');
      var text = who + ' · ' + (leader.secondsText || '');
      if (!leader.mine && it.rank) text += '（我第 ' + it.rank + ' 名）';
      rows.push({ label: labels[p], text: text });
    });
    return rows;
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
   * durationMs：这个词花了多久 —— 学习简报"经过 X 分钟"的唯一数据来源。
   */
  record: function (word, fb, type, durationMs, wrongInput) {
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
      durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
      // 服务端只在 fb !== 'known' 时落库；这里无条件带上，少一层分支就少一处漏
      wrongAnswer: String(wrongInput || ''),
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
   * 例外只有"答题中的看中文拼写"：题面只有中文，念出来就是把答案送出去。
   * 详情页必须放行 —— 详情本来就把单词摆出来了，喇叭是跟读引导的核心；
   * 之前一刀切拦掉，拼写题答错后的详情里大喇叭按了没声（2026-10-07 实锤）。
   */
  speak: function () {
    var q = this.data.q || (this._qs && this._qs[this.data.idx]);
    var inRun = this.data.state === 'run';
    if (inRun && q && q.type === 'spell') return;
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

/**
 * 抄写遮住单词时的占位：一个字母一个圆点，中间留空好数
 * @param {string} word
 */
function maskOf(word) {
  return String(word || '').split('').map(function () { return '●'; }).join(' ');
}

/**
 * 抄写打错时的提示：直接说第几个字母不对，别让孩子自己对着找
 * @param {string} input 抄出来的
 * @param {string} target 正确的
 */
function copyDiffHint(input, target) {
  var a = String(input || '').toLowerCase();
  var b = String(target || '').toLowerCase();
  var i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i >= b.length) return '多打了字母，对着上面的词改一下';
  if (i >= a.length) return '还差 ' + (b.length - a.length) + ' 个字母，接着拼';
  // 短语收录后 target 里会有空格/连字符：直接说"第 4 个应该是（空白）"孩子看不懂
  if (b[i] === ' ') {
    return '第 ' + (i + 1) + ' 个位置是空格 —— 点键盘下面那根长条，改一下再确定';
  }
  if (b[i] === '-') {
    return '第 ' + (i + 1) + ' 个位置是连字符 -（键盘左下角），改一下再确定';
  }
  return '第 ' + (i + 1) + ' 个字母应该是 ' + b[i] +
    '，你写的是 ' + a[i] + ' —— 改一下再确定';
}

/**
 * 真随机洗牌（Fisher–Yates）。
 * 只用于 drill 本地出题：quiz.js 里的 shuffleWithAnswer 刻意用确定性位置
 * （服务端判分要能复现同一道题），但那意味着"答案在第几位"由单词拼写算出来，
 * 二选一时就是"一直偏第二位"这种可被孩子看穿的规律。本地判分没必要背着这个包袱。
 */
function shuffleAny(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
