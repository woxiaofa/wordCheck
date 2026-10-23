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

var theme = require('../../utils/theme');
var assignParam = require('../../utils/assign');
var WORDS = require('../../data/words');
var srs = require('../../utils/srs');
var time = require('../../utils/time');
var books = require('../../utils/books');
var cloud = require('../../utils/cloud');
var asgcache = require('../../utils/asgcache');
var learnlog = require('../../utils/learnlog');
var privacy = require('../../utils/privacy');
var links = require('../../utils/links');
var layout = require('../../utils/layout');
var fit = require('../../utils/fit');

var STORAGE_KEY = 'word_state_mirror';
/** 首次引导卡：点"开始学"或关闭后写入，之后永不再现 */
var INTRO_KEY = 'onboard_v1_home';
var TARGET_PER_DAY = 20;      // 每日目标词数（打卡按 80% 判定）
var NEW_LIMIT = 10;           // 每日新词上限
var CHECKIN_RATIO = 0.8;
/** 学习卡均速：约 15 秒/词，用于"大约几分钟"的预估 */
var SECONDS_PER_WORD = 15;

Page({
  behaviors: [layout.behavior()],
  data: {
    skin: theme.cls(),
    landscape: false,        // iPad 横屏提示条（utils/fit）
    totalCount: 0,
    dueCount: 0,
    wrongCount: 0,
    newCount: 0,
    minutes: 5,
    streak: 0,
    mastery: 0,
    /** 掌握率口径说明：学过词但 0% 掌握时显示，避免"已学 5 个却 0% 掌握"像 bug */
    masteryNote: '',
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

    /** 班级作业入口：{name, done, count, ids, finished, offline?, stale?}；非学生或没作业时为 null */
    clsAssign: null,
    /** 同步状态一行字：断网/待上传几句话说清，不让家长对着 0 词猜 */
    syncState: '',
    /** 教练/家长（班级创建者）在首页只给"看学员进度"的入口，不给作业卡 */
    coachCls: null,
    /** 学习流水：最近若干条"我学了什么 → 云端有没有确认"，进度对不上时用它对质 */
    learnLog: [],
    /** "什么算进度"的说明是否展开 */
    ruleOpen: false,
    /** 学习简报：一句话（学了多久/多少个/抽查掌握几个/还要不要循环）+ 荣誉词。
     *  与教练端看学员时是同一句文案（shared/summary 唯一真相），双方都有。 */
    mySummary: null
  },

  onShow: function () {
    theme.applyNav();                  // 系统导航栏吃不到 CSS 变量，只能靠 API 换色
    this.setData({ landscape: fit.isLandscape() });
    this.refresh();
    this.maybeShowIntro();
    this.setData({ syncState: syncStateText() });
    // 学习流水：每次进首页都刷新一次，孩子刚学的那几条立刻可见（含云端是否确认）
    this.setData({ learnLog: learnlog.lines(8) });
    // 作业进度读的是云端学习记录：先补传本地积压的（最多等 1.2 秒），
    // 再拉作业，孩子学完几个词切回首页，进度条立刻跟上
    var self = this;
    var flushed = cloud.flushPending().catch(function () {});
    Promise.race([flushed, new Promise(function (r) { setTimeout(r, 1200); })])
      .then(function () { self.loadClassAssignment(); self.loadMySummary(); });
    this.maybeCleanupTasks();
  },

  /**
   * 每天自动清一次自己的任务脏数据。
   * 存量脏数据是历史版本 add() 写出来的，光改客户端清不掉，
   * 只能靠一次云端扫描；挂在这里是为了"用户自己打开就用上了"，
   * 不用开发者去控制台手动跑。失败静默——它只是打扫，不是主流程。
   */
  maybeCleanupTasks: function () {
    try {
      var flag = 'task_cleanup_at';
      var today = time.getLocalDate();
      if (wx.getStorageSync(flag) === today) return;
      cloud.api.cleanupTasks().then(function () {
        try { wx.setStorageSync(flag, today); } catch (e) { }
      }).catch(function () { });
    } catch (e) { }
  },

  /** 我的学习简报：今天学了多久、几个词、抽查掌握与不会各有几个 */
  loadMySummary: function () {
    var self = this;
    cloud.api.learnSummary().then(function (r) {
      if (!r || !r.text) return;
      self.setData({ mySummary: r });
    }).catch(function (err) {
      // 简报是锦上添花，失败不打扰主流程，但留线索
      console.warn('[index] 学习简报加载失败：', (err && (err.errMsg || err.message)) || err);
    });
  },

  /** 首页的班级作业入口：孩子不用再翻到"班级"页找作业 */
  loadClassAssignment: function () {
    var self = this;
    cloud.api.myAssignments().then(function (r) {
      var role = (r && r.role) || '';
      var list = (r && r.assignments) || [];

      // 云端可用：以云端为准，并顺手把最新作业快照落到本机（断网时的退路）
      asgcache.markOk();
      if (list.length) asgcache.save(list);
      self.setData({ syncState: syncStateText() });

      // 身份闸门：家长/老师是布置作业的人，不是做作业的人。
      // 他们自己背单词就走默认词库 + 今日任务，首页只给一条"去看学员进度"的入口。
      if (role === 'coach') {
        self.setData({
          clsAssign: null,
          coachCls: { name: (r.class && r.class.name) || '我的班级' }
        });
        return;
      }

      if (!list.length) { self.setData({ clsAssign: null, coachCls: null }); return; }
      var a = list[0];                     // 只展示最近一份，多的在班级页看
      var done = a.done || 0;
      var count = a.count || 0;
      // 存编码后的串：跳转时原样带过去，由 utils/assign.js 的契约成对解码
      var ids = assignParam.buildIdsParam(a.word_ids || []);
      self.setData({
        coachCls: null,
        clsAssign: {
          name: a.name || a.note || (a.tag ? a.tag + '作业' : '班级作业'),
          done: done,
          count: count,
          ids: ids,
          finished: count > 0 && done >= count,
          offline: false
        }
      });
    }).catch(function (err) {
      console.warn('[index] 班级作业加载失败：', (err && (err.errMsg || err.message)) || err);
      self.fallbackToCachedAssign();
    });
  },

  /**
   * 断网（或云函数异常）时的退路：用本机留存的作业快照继续让孩子有得练。
   * 为什么不是直接显示"联网才能看作业"：
   *   孩子练单词的场景常常在车上、在老家，网络很差是常态而不是意外。
   *   显示"请联网"等于把这段时间变成彻底没练；而有快照时他照样能完成作业，
   *   进度由已有的补传队列在联网后自动回传 —— 家长那边的数字只会晚到，不会丢。
   */
  fallbackToCachedAssign: function () {
    asgcache.markFail();
    var cached = asgcache.latest();
    if (!cached || !cached.ids.length) {
      this.setData({ clsAssign: null, syncState: syncStateText() });
      return;
    }
    var mirror = wx.getStorageSync(STORAGE_KEY) || {};
    var prog = asgcache.localProgress(cached.ids, mirror);
    this.setData({
      clsAssign: {
        name: cached.name,
        done: prog.done,
        count: prog.count,
        ids: assignParam.buildIdsParam(cached.ids),
        finished: prog.count > 0 && prog.done >= prog.count,
        offline: true,
        stale: !!cached.stale
      },
      syncState: syncStateText()
    });
  },

  /** 手动重试：网络恢复后不用重进小程序 */
  retryCloud: function () {
    var self = this;
    cloud.flushPending().catch(function () {});
    this.loadClassAssignment();
    this.loadMySummary();
    wx.showToast({ title: '正在重新连接…', icon: 'none' });
    setTimeout(function () {
      self.setData({ syncState: syncStateText() });
    }, 1500);
  },

  goClassAssign: function () {
    var a = this.data.clsAssign;
    if (!a || !a.ids) return;
    // 注意：a.ids 已经 buildIdsParam 编码过（含 %2C），这里不能再编码一次，
    // 否则 %2C → %252C 双重编码，学习页解码后逗号回不来，整串又变成"一个词"
    wx.redirectTo({
      url: '/pkg-media/pages/drill/drill?ids=' + a.ids + '&name=' + encodeURIComponent(a.name)
    });
  },

  /** 教练/家长：去班级页看学员进度（不是去做作业） */
  goClass: function () {
    wx.navigateTo({ url: '/pages/class/class' });
  },

  /** "什么算进度"的说明：一句话讲清口径，避免"我到底学没学"的猜疑 */
  toggleRule: function () {
    this.setData({ ruleOpen: !this.data.ruleOpen });
  },

  /** 一键复制学习流水：进度对不上时，家长把这段发出来就能当场判责 */
  copyLearnLog: function () {
    var text = learnlog.toText(30);
    privacy.copy(text, function () { wx.showToast({ title: '流水已复制', icon: 'none' }); });
    console.log('[learnlog]\n' + text);
  },

  /** 复制简报：家长要的就是"能直接发给对方的一句话" */
  copySummary: function () {
    var s = this.data.mySummary;
    if (!s || !s.text) return;
    var text = s.honor
      ? s.text + '\n' + s.honor.badge + ' · ' + s.honor.detail
      : s.text;
    // 末尾带真口令（#小程序:// 短链）：必须用微信「复制链接」签发的带随机码版本，
    // 见 utils/links.js —— 手拼的空路径版本点了永远「链接无效」（2026-10-19 实测）
    text += '\n' + links.openLine('看详情');
    privacy.copy(text, function () { wx.showToast({ title: '简报已复制', icon: 'none' }); });
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

  /** 添加词库：粘贴 / 表格导入（D7 承诺的拍照导入先做这一步） */
  goImport: function () {
    wx.navigateTo({ url: '/pkg-media/pages/import/import' });
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
    // 新流程：主按钮一律进背词（认 → 写 → 巩固一条龙，2026-10-07 合并抽查）。
    // 今天没有待学的词时背词页会自己给出"今天没有要练的词"，不再需要绕去抽查页。
    var mainBtnText;
    if (allDone) mainBtnText = '去复习一轮';
    else if (!total || taskDone) mainBtnText = '再练一轮';
    else if (done > 0) mainBtnText = '继续背 · 还剩 ' + rest + ' 个';
    else mainBtnText = '开始背单词';

    if (allDone) progressNote = '今天的词都记在计划里了，去抽查检验一下真实水平';

    // 云端统计兜底：清缓存/换设备后本地镜像为空，但云端 stats_cache 是真值。
    // 两个都算然后取大——本地新学的还没上云时本地大，清缓存后云端大。
    var cloudStats = wx.getStorageSync('cloud_stats') || {};
    var learnedFinal = Math.max(learned, cloudStats.learned_words || 0);
    var streakFinal = Math.max(this.calcStreak(activity), cloudStats.streak_days || 0);

    // 口径说明：掌握 = SRS 档位 ≥5（复习间隔 15 天+），刚学的词档位低，
    // "已学 5 个、掌握 0%" 数据上没错，但不解释家长只会当成 bug
    var masteryNote = (learnedFinal > 0 && mastered === 0)
      ? '掌握 = 复习间隔拉到 15 天以上的词；刚学的词要多轮巩固才会计入'
      : '';

    this.setData({
      totalCount: total,
      dueCount: due,
      wrongCount: wrong,
      newCount: newToday,
      minutes: Math.max(1, Math.round(total * SECONDS_PER_WORD / 60)),
      streak: streakFinal,
      mastery: learned ? Math.round(mastered / learned * 100) : 0,
      masteryNote: masteryNote,
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
    // 点"开始背单词"即视为看过引导，以后永不再现
    wx.setStorageSync(INTRO_KEY, 1);
    wx.redirectTo({ url: '/pkg-media/pages/drill/drill' });
  },

  goQuiz: function () {
    wx.redirectTo({ url: '/pkg-media/pages/quiz/quiz' });
  },

  /**
   * 分享今天的学习简报。
   * 为什么要有：简报的服务对象是家长，而家长通常不在孩子手机上。
   * 转发卡片是零成本把这句话送到家长微信里的通道（不用申请模板、不用订阅授权）。
   */
  onShareAppMessage: function () {
    var s = this.data.mySummary;
    // 动态标题优先（个性化状态更有点开欲），兜底用固定口号；品牌名必须是注册名「功课抽查」
    var title = (s && s.text) ? String(s.text).slice(0, 28) : '功课抽查 · 一天十个词，两分钟';
    return { title: title, path: '/pages/index/index' };
  },

  /** 朋友圈分享：家长晒到朋友圈的入口（只有 title 生效，落地页固定首页） */
  onShareTimeline: function () {
    return { title: '功课抽查 · 一天十个词，两分钟' };
  }
});

/**
 * 同步状态的一句话。
 * 为什么非要写这一句：家长最常见的误解是"孩子说学了，这里却 0 词 = 数据丢了"。
 * 实际上记录在手机里排队，联网自动补上。与其等家长来问，不如先说清楚。
 */
function syncStateText() {
  var s = asgcache.state();
  if (s.offline && s.pending > 0) {
    return '断网中：还能接着练，' + s.pending + ' 条记录联网后自动补传';
  }
  if (s.offline) return '断网中：还能接着练，记录会在联网后上传';
  if (s.pending > 0) return '有 ' + s.pending + ' 条记录还没传上去（联网自动补）';
  return '';
}
