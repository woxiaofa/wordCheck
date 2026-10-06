/**
 * 今日任务页（首页）
 *
 * 设计意图（与方案文档 1.3 / 6.1 一致）：首页必须一眼回答三个问题——
 *   ① 今天要做多少；② 都是些什么词、为什么要做它们；③ 现在点哪里开始。
 * 复习/错词/新词逐条给出"为什么"，让用户知道任务是什么、怎么构成的。
 *
 * 首次使用：插一张非阻断的引导卡（一句话价值 + 一个动作），关闭后永不再现。
 * 参见 docs/新手引导设计.md 第 1 段。
 */

var assignParam = require('../../utils/assign');
var WORDS = require('../../data/words');
var srs = require('../../utils/srs');
var time = require('../../utils/time');
var books = require('../../utils/books');
var cloud = require('../../utils/cloud');

var STORAGE_KEY = 'word_state_mirror';
/** 首次引导卡：点"开始学"或关闭后写入，之后永不再现 */
var INTRO_KEY = 'onboard_v1_home';
var TARGET_PER_DAY = 20;      // 每日目标词数（打卡按 80% 判定）
var NEW_LIMIT = 10;           // 每日新词上限
var CHECKIN_RATIO = 0.8;
/** 学习卡均速：约 15 秒/词，用于"大约几分钟"的预估 */
var SECONDS_PER_WORD = 15;

Page({
  data: {
    totalCount: 0,
    dueCount: 0,
    wrongCount: 0,
    newCount: 0,
    minutes: 5,
    streak: 0,
    mastery: 0,
    learned: 0,
    done: 0,
    target: TARGET_PER_DAY,
    progressPct: 0,
    progressNote: '',
    taskDone: false,
    mainBtnText: '开始学习',
    /** 今天没有任何待学的词（本地词库学完 / 全部排进未来）：主按钮改为"去做抽查" */
    allDone: false,
    /** 首次使用引导卡是否显示 */
    intro: false,
    /** "这是什么原理"是否展开 */
    howtoOpen: false,
    /** 词书 */
    books: [],
    bookKey: 'all',
    bookName: '全部',
    bookDesc: '',
    bookCount: 0,

    /** 班级作业入口：{name, done, count, ids, finished}；不在班级/没作业时为 null */
    clsAssign: null
  },

  onShow: function () {
    this.refresh();
    this.maybeShowIntro();
    // 作业进度读的是云端学习记录：先补传本地积压的（最多等 1.2 秒），
    // 再拉作业，孩子学完几个词切回首页，进度条立刻跟上
    var self = this;
    var flushed = cloud.flushPending().catch(function () {});
    Promise.race([flushed, new Promise(function (r) { setTimeout(r, 1200); })])
      .then(function () { self.loadClassAssignment(); });
  },

  /** 首页的班级作业入口：孩子不用再翻到"班级"页找作业 */
  loadClassAssignment: function () {
    var self = this;
    cloud.api.myAssignments().then(function (r) {
      var list = (r && r.assignments) || [];
      if (!list.length) { self.setData({ clsAssign: null }); return; }
      var a = list[0];                     // 只展示最近一份，多的在班级页看
      var done = a.done || 0;
      var count = a.count || 0;
      // 存编码后的串：跳转时原样带过去，由 utils/assign.js 的契约成对解码
      var ids = assignParam.buildIdsParam(a.word_ids || []);
      self.setData({
        clsAssign: {
          name: a.note || (a.tag ? a.tag + '作业' : '班级作业'),
          done: done,
          count: count,
          ids: ids,
          finished: count > 0 && done >= count
        }
      });
    }).catch(function (err) {
      // 首页的辅助入口，失败不打扰主流程，但必须留线索
      console.warn('[index] 班级作业加载失败：', (err && (err.errMsg || err.message)) || err);
    });
  },

  goClassAssign: function () {
    var a = this.data.clsAssign;
    if (!a || !a.ids) return;
    // 注意：a.ids 已经 buildIdsParam 编码过（含 %2C），这里不能再编码一次，
    // 否则 %2C → %252C 双重编码，学习页解码后逗号回不来，整串又变成"一个词"
    wx.redirectTo({
      url: '/pages/study/study?ids=' + a.ids + '&name=' + encodeURIComponent(a.name)
    });
  },

  /** 首次打开（本地没有任何学习记录且从未关闭过）约 1 秒后浮出引导卡 */
  maybeShowIntro: function () {
    if (wx.getStorageSync(INTRO_KEY)) return;
    var mirror = wx.getStorageSync(STORAGE_KEY) || {};
    var hasRecord = Object.keys(mirror).length > 0;
    if (hasRecord) return;
    var self = this;
    clearTimeout(this._introTimer);
    this._introTimer = setTimeout(function () {
      self.setData({ intro: true });
    }, 800);
  },

  dismissIntro: function () {
    wx.setStorageSync(INTRO_KEY, 1);
    clearTimeout(this._introTimer);
    this.setData({ intro: false });
  },

  toggleHowto: function () {
    this.setData({ howtoOpen: !this.data.howtoOpen });
  },

  onHide: function () {
    clearTimeout(this._introTimer);
  },

  onSelectBook: function (e) {
    var key = e.currentTarget.dataset.key;
    if (!books.setKey(key)) return;
    this.refresh();
    wx.showToast({ title: '已切换到「' + books.currentName() + '」', icon: 'none' });
  },

  refresh: function () {
    var mirror = wx.getStorageSync(STORAGE_KEY) || {};
    var now = Date.now();
    var today = time.getLocalDate();

    // 只在当前词书里统计：选了"中考"就不该把四级词算进今日任务
    var bookKey = books.getKey();
    var pool = books.getWords(bookKey);
    var bookList = books.list();
    var cur = null;
    for (var b = 0; b < bookList.length; b++) {
      if (bookList[b].key === bookKey) { cur = bookList[b]; break; }
    }

    var due = 0, wrong = 0, fresh = 0, learned = 0, mastered = 0;
    for (var i = 0; i < pool.length; i++) {
      var st = mirror[pool[i].word];
      if (!st) { fresh++; continue; }
      learned++;
      if (srs.isMastered(st)) mastered++;
      if (st.next_review_at && st.next_review_at <= now) due++;
      else if (st.wrong_count > 0 && st.last_feedback !== 'known') wrong++;
    }

    var newToday = Math.min(fresh, NEW_LIMIT);
    var total = due + wrong + newToday;

    // 今日已完成：用打卡记录里的当天计数（学习页每提交一次反馈累加一次）
    var activity = wx.getStorageSync('activity_log') || {};
    var done = activity[today] || 0;
    var target = Math.max(TARGET_PER_DAY, total);
    var progressPct = target ? Math.min(100, Math.round(done / target * 100)) : 0;

    // 打卡口径：完成目标的 80% 即算
    var checkinNeed = Math.round(target * CHECKIN_RATIO);
    // 任务完成 = 做完"今天这份任务"（total），而不是打卡目标（target）——
    // 新号任务只有 10 个新词时，学完 10 个就该显示"任务完成"，
    // 否则会蹦出"继续学习 · 还剩 0 个"这种自相矛盾的按钮
    var taskDone = total > 0 && done >= total;
    var progressNote;
    if (taskDone && done >= checkinNeed) {
      progressNote = '🎉 任务和打卡都完成了，太稳了';
    } else if (taskDone) {
      progressNote = '🎉 今天布置的任务全部完成，再学 ' + (checkinNeed - done) + ' 个打卡就稳了';
    } else if (done >= checkinNeed) {
      progressNote = '今天的打卡已经稳了，多学一个多赚一个';
    } else {
      progressNote = '再学 ' + (checkinNeed - done) + ' 个，今天的打卡就稳了';
    }

    // 主按钮文案：把"还剩多少"直接放进按钮，任务感 > 按钮本身
    var rest = Math.max(total - done, 0);
    // 一个待学的词都没有：本地词库已学完、全部排进未来，
    // 之后 SRS 把它们全推到未来，这时不该显示"0 个词 + 开始学习"（用户会以为坏了）
    var allDone = total === 0 && learned > 0;
    var mainBtnText;
    if (allDone) mainBtnText = '去做抽查';
    else if (!total || taskDone) mainBtnText = '再学一轮';
    else if (done > 0) mainBtnText = '继续学习 · 还剩 ' + rest + ' 个';
    else mainBtnText = '开始学习';

    if (allDone) progressNote = '今天的词都记在计划里了，去抽查检验一下真实水平';

    // 云端统计兜底：清缓存/换设备后本地镜像为空，但云端 stats_cache 是真值。
    // 两个都算然后取大——本地新学的还没上云时本地大，清缓存后云端大。
    var cloudStats = wx.getStorageSync('cloud_stats') || {};
    var learnedFinal = Math.max(learned, cloudStats.learned_words || 0);
    var streakFinal = Math.max(this.calcStreak(activity), cloudStats.streak_days || 0);

    this.setData({
      totalCount: total,
      dueCount: due,
      wrongCount: wrong,
      newCount: newToday,
      minutes: Math.max(1, Math.round(total * SECONDS_PER_WORD / 60)),
      streak: streakFinal,
      mastery: learned ? Math.round(mastered / learned * 100) : 0,
      learned: learnedFinal,
      done: done,
      target: target,
      progressPct: progressPct,
      progressNote: progressNote,
      taskDone: taskDone,
      allDone: allDone,
      mainBtnText: mainBtnText,
      books: bookList,
      bookKey: bookKey,
      bookName: cur ? cur.name : '全部',
      bookDesc: cur ? cur.desc : '',
      bookCount: cur ? cur.count : pool.length
    });
  },

  /** 连续打卡：当天完成量达到目标的 80% 即算，中断一天归零 */
  calcStreak: function (activity) {
    var need = Math.round(TARGET_PER_DAY * CHECKIN_RATIO);
    var streak = 0;
    var d = time.getLocalDate();
    // 今天还没完成不算断：从昨天开始往前数
    if ((activity[d] || 0) < need) d = time.shiftLocalDate(d, -1);
    for (var i = 0; i < 400; i++) {
      if ((activity[d] || 0) >= need) { streak++; d = time.shiftLocalDate(d, -1); }
      else break;
    }
    return streak;
  },

  goStudy: function () {
    // 点"开始学第 1 轮"即视为看过引导，以后永不再现
    wx.setStorageSync(INTRO_KEY, 1);
    // 今天没有待学的词时，"开始学习"会把用户送进一个空白页，直接改去抽查
    if (this.data.allDone) {
      wx.redirectTo({ url: '/pages/quiz/quiz' });
      return;
    }
    wx.redirectTo({ url: '/pages/study/study' });
  },

  goQuiz: function () {
    wx.redirectTo({ url: '/pages/quiz/quiz' });
  }
});
