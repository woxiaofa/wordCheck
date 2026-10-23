/**
 * 学习页
 *
 * 数据来源策略（这是让项目"导入即可跑"的关键）：
 *   1) 词序列：优先用云端（review.due 返回到期词，task.today 返回今日任务）；
 *      云端不可用时回退到本地词库，保证离线也能验证交互。
 *   2) SRS 状态：本地留一份镜像（缓存），保证每一次反馈都有即时可见的结果；
 *      同时带幂等 ID 提交到云端，云端未部署时静默失败、不影响使用。
 *
 * 注意：这是开发阶段的过渡形态。正式版必须由云端的 task 云函数给出队列快照，
 *      本地镜像只作为缓存和离线补传，不能作为真相来源。
 */

var theme = require('../../../utils/theme');
var api = require('../../../utils/cloud').api;
var humanError = require('../../../utils/cloud').humanError;
var srs = require('../../../utils/srs');
var time = require('../../../utils/time');
var WORDS = require('../../../data/words');
var books = require('../../../utils/books');
var tts = require('../../../utils/tts');
var report = require('../../../utils/report');
var assignParam = require('../../../utils/assign');
var learnlog = require('../../../utils/learnlog');
var layout = require('../../../utils/layout');

var STORAGE_KEY = 'word_state_mirror';
var CACHE_PREFIX = 'word_cache_v1:';
/** 新手引导标记：示范卡只出现一次（本地存，换设备重看一遍无害，不值得为它发云请求） */
var ONBOARD_KEY = 'onboard_v1_gesture';
/** 三档反馈的可读文案。放在模块级，避免任何路径上因实例状态缺失而取值失败 */
var FEEDBACK_LABELS = { known: '想得很快', vague: '想起来了，但费劲', forgot: '没想起来' };

Page({
  behaviors: [layout.behavior()],
  data: {
    skin: theme.cls(),
    queue: [],
    index: 0,
    word: null,
    wordState: null,
    isDemo: false,
    /**
     * 本轮三类反馈的计数。
     * ⚠️ 必须放在 data 里而不是实例字段：早先它是实例字段、只在 buildQueue() 里初始化，
     * 于是"没经过 buildQueue 就调到 applyRating"的路径上取 `this.roundStat[fb]` 会直接抛
     * TypeError 并中断整个换词流程 —— 真机上的表现就是"点完按钮卡片卡死、什么都点不动"。
     * 集成测试（tests/study-flow.test.js）抓到了这个崩溃。
     */
    roundStat: { known: 0, vague: 0, forgot: 0 },
    /** 页面实例上的评价计数（与 roundStat 同步，供结算文案使用） */
    ratedCount: 0,
    /** 每一张卡的唯一 key：由"第几张"决定，保证换卡时组件的复位逻辑一定被触发 */
    cardKey: '',
    /** 记完评价后的短暂过渡：显示"已记录"，同时避免用户以为没换词 */
    loading: false,
    loadingText: '',
    stageText: '第 1 个',
    progressPct: 0,
    revealAfter: 8000,
    emptyText: '',
    emptySub: '',
    /** 本轮是否已学完（用于给出"必须去抽查"的引导按钮） */
    roundDone: false,
    /** 当前队列是不是"提前巩固"（本地词库学完后，用户主动把未到期的词提前拿出来） */
    extraRound: false,
    /** 是否展示"提前巩固"按钮：只有确实存在未到期的词时才给 */
    canExtra: false,
    /**
     * 队列是否在装配中（云端 task.today 冷启动 1~2 秒）。
     * 装配期间不渲染"学完了"空状态——否则新号第一次打开会先闪一下"再学一轮"。
     */
    queueLoading: true,

    /** 班级作业模式：作业名 + 词单进度（assignName 为空表示普通学习） */
    assignName: '',
    assignDone: 0,
    assignTotal: 0
  },

  /** @type {Object} 本地 SRS 状态镜像：{ [word]: {stage,last_feedback,next_review_at,correct_count,wrong_count} } */
  mirror: {},

  onLoad: function (options) {
    this.mirror = wx.getStorageSync(STORAGE_KEY) || {};
    this._extraRound = false;
    // 班级作业模式：URL 带 ids（作业词单）时，队列只从这份词单里出，
    // 没学过的优先 —— 这就是"继续学"的断点续学能力
    if (options && options.ids) {
      // class/首页发过来的是 encodeURIComponent 过的词单（逗号 → %2C）。
      // 微信不会自动解码 options —— 不解码的话整串词单会被当成"一个词"，
      // 实锤症状：进度条 0/1、"1 个词不在词库"、一进页面就"学完了"。
      this._assign = {
        ids: assignParam.parseIdsParam(options.ids),
        name: options.name ? decodeURIComponent(options.name) : '班级作业'
      };
    }
    this.buildQueue(false);
  },

  onShow: function () {
    theme.applyNav();
    // 跨天时重建队列：否则用户晚上打开会看到昨天剩下的卡片
    var today = time.getLocalDate();
    if (this.loadedDate && this.loadedDate !== today) {
      this.buildQueue();
    }
    // 补一次自动揭晓启动：组件 attached 时属性可能尚未就绪，导致计时器没起来
    var card = this.selectComponent('#card');
    if (card && card.startAuto) card.startAuto();
  },

  /* ---------------- 队列组装 ---------------- */

  /**
   * 组装队列
   * @param {boolean} force 是否允许"提前巩固"（把还没到期的词提前拿出来）
   *
   * 为什么要这个参数：本地词库每轮只给 10 个新词，全部学完之后
   * SRS 会把它们推到未来（最短也是 2 天后）—— 接下来连续几天打开都是"一个词都没有"，
   * 于是接下来连续几天打开都是"一个词都没有"，真机上看起来就像"没有单词数据"。
   * 不能自动塞词（提前复习会刷新间隔、破坏 SRS），只能由用户主动点"提前巩固"。
   */
  buildQueue: function (force) {
    var self = this;
    this.loadedDate = time.getLocalDate();
    this.setData({
      roundStat: { known: 0, vague: 0, forgot: 0 },
      ratedCount: 0,
      roundDone: false,
      canExtra: false,
      extraRound: false,
      queueLoading: true
    });

    // 作业模式：不查今日任务，队列 = 作业词单（没学过的在前）
    if (this._assign && this._assign.ids.length) {
      this.setQueue(this.assignmentQueue(), false);
      return;
    }

    api.todayTask(this.loadedDate).then(function (data) {
      var words = (data && data.words) || [];
      if (!words.length) throw new Error('EMPTY');
      self.setQueue(words, false);
    }).catch(function () {
      // 云端不可用：回退本地词库，仍然按"到期优先"的规则排序
      var local = self.localQueue(!!force);
      self.setQueue(local, true);
    });
  },

  /**
   * 作业队列：词单里没学过的词按原顺序排前面（这就是"继续学"——
   * 学过的不会再从头来一遍），学过的按到期时间排后面做巩固。
   */
  assignmentQueue: function () {
    var byName = {};
    for (var i = 0; i < WORDS.length; i++) byName[WORDS[i].word] = WORDS[i];
    var fresh = [], seen = [], missing = 0;
    for (var j = 0; j < this._assign.ids.length; j++) {
      var id = this._assign.ids[j];
      var w = byName[id];
      if (!w) { missing++; continue; }          // 词单里有、词库里没有：跳过不渲染
      if (this.mirror[id]) seen.push(w); else fresh.push(w);
    }
    var now = Date.now();
    seen.sort(function (a, b) {
      return ((this.mirror[a.word] || {}).next_review_at || now) -
             ((this.mirror[b.word] || {}).next_review_at || now);
    }.bind(this));
    if (missing) {
      console.warn('[study] 作业词单里有', missing, '个词不在当前词库，已跳过');
    }
    return fresh.concat(seen);
  },

  /** 作业进度条数据：词单里已经学过（有状态记录）的词数 */
  updateAssignProgress: function () {
    if (!this._assign) return;
    var done = 0;
    for (var i = 0; i < this._assign.ids.length; i++) {
      if (this.mirror[this._assign.ids[i]]) done++;
    }
    this.setData({
      assignName: this._assign.name,
      assignDone: done,
      assignTotal: this._assign.ids.length
    });
  },

  /** 本地队列：到期复习词优先，其次错词，最后新词（与文档 6.3 的组装顺序一致） */  localQueue: function (force) {
    var now = Date.now();
    // 只从当前词书取词：用户在首页选了"中考"，学习页就不该冒出四级词
    var pool = books.getWords(books.getKey());
    var due = [], wrong = [], fresh = [], parked = [];
    for (var i = 0; i < pool.length; i++) {
      var w = pool[i];
      var st = this.mirror[w.word];
      if (!st) { fresh.push(w); continue; }
      if (st.next_review_at && st.next_review_at <= now) due.push(w);
      else if (st.wrong_count > 0 && st.last_feedback !== 'known') wrong.push(w);
      else parked.push(w);              // 学过、但还没到复习时间
    }
    var merged = due.concat(wrong).concat(fresh.slice(0, 10));
    this._nextDueAt = 0;
    if (merged.length) return merged;

    // 一个待学的词都没有：算出最早到期时间，交给界面说清楚（而不是留一片空白）
    var minAt = 0;
    for (var j = 0; j < parked.length; j++) {
      var at = (this.mirror[parked[j].word] || {}).next_review_at || 0;
      if (at && (!minAt || at < minAt)) minAt = at;
    }
    this._nextDueAt = minAt;
    if (!force || !parked.length) return [];

    var self = this;
    parked.sort(function (a, b) {
      return ((self.mirror[a.word] || {}).next_review_at || 0) -
             ((self.mirror[b.word] || {}).next_review_at || 0);
    });
    return parked.slice(0, 10);
  },

  /** "还有多久到期"的人话说法 */
  describeWait: function (ts) {
    var hours = Math.max(1, Math.round((ts - Date.now()) / 3600000));
    if (hours < 24) return hours + ' 小时';
    return Math.round(hours / 24) + ' 天';
  },

  setQueue: function (words, isLocal) {
    var queue = words.slice();

    // 首次使用：在最前面插一张示范卡。
    // 为什么必须在动作发生之前：手势是肌肉记忆，用文字说明等于没说明。
    // 用户在这里完成一次上滑，后面每一天的摩擦都少一半。
    if (!wx.getStorageSync(ONBOARD_KEY) && queue.length) {
      var first = Object.assign({}, queue[0]);
      first.isDemo = true;
      queue.unshift(first);
    }

    this.setData({
      queue: queue,
      index: 0,
      isLocal: !!isLocal,
      roundDone: false,
      extraRound: !!this._extraRound,
      queueLoading: false
    });
    this.updateAssignProgress();

    // 队列为空必须明确说明原因。曾经这里直接走进 showCurrent 的 !w 分支，
    // 界面只留一个"这一轮学完了"和一个空白，真机上被当成"程序没数据"。
    if (!queue.length) {
      this.showEmptyState();
      return;
    }
    this.showCurrent();
  },

  /** 没有待学词汇时的解释性空状态（区别于"这一轮学完了"） */
  showEmptyState: function () {
    // 作业模式下空队列 = 词单里的词都学过了，文案必须点明"作业"，
    // 否则显示"共 300 个词已全部学过"会跟首页"作业 3/10"打架（实锤踩过）
    if (this._assign && this._assign.ids.length) {
      this.setData({
        word: null,
        isDemo: false,
        roundDone: false,
        emptyText: '「' + this._assign.name + '」的词都学过了',
        emptySub: '作业词单里没有待学的词了，老师那边能看到你的进度。想再练可以去抽查。',
        canExtra: false
      });
      return;
    }
    var nextAt = this._nextDueAt || 0;
    var sub = nextAt
      ? '「' + books.currentName() + '」共 ' + books.getWords(books.getKey()).length +
        ' 个词，已全部排进复习计划；最早的一批 ' + this.describeWait(nextAt) + '后到期。'
      : '「' + books.currentName() + '」共 ' + books.getWords(books.getKey()).length +
        ' 个词，现在已经全部学过了。';
    this.setData({
      word: null,
      isDemo: false,
      roundDone: false,
      emptyText: '今天没有待复习的词',
      emptySub: sub,
      canExtra: !!nextAt
    });
  },

  showCurrent: function () {
    var i = this.data.index;
    var w = this.data.queue[i];

    // 先让卡片收起答案，再换数据。
    // 为什么不只靠组件的 cardKey observer：真机上观察到它并不能稳定触发，
    // 结果是"点了反馈按钮，下一个词还显示上一个词的释义"。
    // 这里直接调组件方法是同步、确定的；observer 仍保留作为兜底。
    var card = this.selectComponent('#card');
    if (card && card.resetCard) card.resetCard();

    if (!w) {
      var stat = this.data.roundStat || {};
      var rated = this.data.ratedCount || 0;
      this.setData({
        word: null,
        isDemo: false,
        // ⚠️ 这一行曾经缺失，导致"下一关：抽查"这块引导永远不显示（roundDone 恒为 false）。
        // 只在本轮真的评价过词时给，否则"一进来就没词"也会被误当成"学完了"。
        roundDone: rated > 0,
        canExtra: false,
        emptyText: '这一轮学完了',
        emptySub: '本轮 ' + rated + ' 个词：认识 ' + (stat.known || 0) +
          '　想了很久 ' + (stat.vague || 0) + '　不认识 ' + (stat.forgot || 0)
      });
      return;
    }
    var st = w.isDemo ? null : (this.mirror[w.word] || null);
    this.setData({
      word: w,
      wordState: st,
      isDemo: !!w.isDemo,
      // cardKey 用"第几张卡"的序号，不用单词本身。
      // 曾经用 word.word，结果队列里相邻两项是同一个词时（示范卡后面紧跟的就是同一个真词）
      // key 不变 → 组件不复位 → 卡片停在上一次的翻面状态。
      cardKey: 'card-' + i,
      stageText: w.isDemo ? '示范' : this.describeTag(w, st),
      progressPct: this.data.queue.length ? Math.round(i / this.data.queue.length * 100) : 0
    });
  },

  describeTag: function (w, st) {
    var base = st ? (st.next_review_at <= Date.now() ? '到期复习' : '巩固') : '新词';
    if (w.tags && w.tags.length) base += ' · ' + w.tags.join('/');
    return base;
  },

  /* ---------------- 卡片事件 ---------------- */

  onReveal: function () {
    // 看答案本身不改状态：真正的评价来自三个反馈按钮
  },

  onFeedback: function (e) {
    var fb = e.detail && e.detail.feedback;
    if (!fb) return;
    this.applyRating(fb);
  },

  /** 上滑 = 想得很快：不翻面，直接结算。示范卡也是走这条路径。 */
  onKnown: function () {
    this.applyRating('known');
  },

  applyRating: function (fb) {
    var w = this.data.word;
    if (!w) return;

    // 记下本次评价，供过渡层显示"已记录：xxx"。
    // 用模块级常量而不是实例字段：实例字段在"页面被重建/方法被重新绑定"的场景下可能不存在，
    // 而那会直接抛 TypeError 把整个流程打断（集成测试抓到过）。
    this._lastFeedbackLabel = FEEDBACK_LABELS[fb] || '';

    // 示范卡：只负责教会手势，不写入 SRS 状态，也不计入今日完成量。
    // 它插的就是队列第一个词，所以标上 onboard 标记后紧接着的那个真词会正常出现。
    if (w.isDemo) {
      wx.setStorageSync(ONBOARD_KEY, 1);
      this.setData({ index: this.data.index + 1 });
      this.showCurrent();
      return;
    }

    var prev = this.mirror[w.word] || null;
    // 学习阶段的档位有上限（srs.LEARN_STAGE_CAP）：点"认识"最多到 7 天，
    // 想进入 15 天以上的长间隔必须通过抽查。这是"自评不能自己发通行证"的落点。
    var next = srs.nextState(prev, fb, Date.now());

    // 1) 本地镜像立即生效：界面马上给出正确反馈，不等网络
    var localSt = {
      stage: next.stage,
      last_feedback: next.lastFeedback,
      next_review_at: next.nextReviewAt,
      correct_count: (prev && prev.correct_count ? prev.correct_count : 0) + (fb === 'known' ? 1 : 0),
      wrong_count: (prev && prev.wrong_count ? prev.wrong_count : 0) + (fb === 'forgot' ? 1 : 0),
      last_wrong_type: fb === 'forgot' ? 'learn' : (prev ? prev.last_wrong_type : null)
    };
    this.mirror[w.word] = localSt;
    wx.setStorageSync(STORAGE_KEY, this.mirror);
    if (this._assign) this.updateAssignProgress();   // 作业进度实时 +1

    // 2) 本轮统计 + 今日活跃计数（首页的打卡进度读这个）
    //    统计放在 data 里（不是实例字段）：实例字段在"未经过 buildQueue"的路径上不存在，
    //    取它就会抛 TypeError 并中断换词 —— 真机表现是"点完按钮就卡死"。
    var stat = this.data.roundStat || { known: 0, vague: 0, forgot: 0 };
    stat[fb] = (stat[fb] || 0) + 1;
    this.setData({ roundStat: stat });
    var log = wx.getStorageSync('activity_log') || {};
    var today = time.getLocalDate();
    log[today] = (log[today] || 0) + 1;
    wx.setStorageSync('activity_log', log);

    // 日报/周报/月报的本地明细：先落本地再上云，云上出问题报告也不会空白
    report.record(w.word, fb);

    // 3) 异步提交云端（幂等 ID 保证重试安全）
    //    流水：先开一笔"本地已记 / 云端待确认"，云端回来再回填状态。
    //    这样"我到底学了没有"不再靠猜 —— 首页的流水卡可以逐条对质。
    var isAssign = !!(this._assign && this._assign.ids.length);
    var reqId = CACHE_PREFIX + srs.newReqId();
    var logId = learnlog.push({
      word: w.word,
      mode: isAssign ? 'assign' : 'task',
      assign: isAssign ? this._assign.name : '',
      feedback: fb,
      reqId: reqId
    });
    api.submitReview({
      wordId: w.word,
      feedback: fb,
      mode: 'learn',
      clientReqId: reqId
    }).then(function (res) {
      var errCode = (res && res.ok === false) ? (res.code || 'CLOUD_FAIL') : '';
      learnlog.patch(logId, errCode ? 'fail' : 'ok', errCode);
      console.log('[learn] ' + w.word + ' · ' + fb +
        ' · ' + (isAssign ? '作业' : '任务') +
        ' → 云端' + (errCode ? '失败 ' + errCode : '已确认'));
    }).catch(function (err) {
      // 不静默：学习记录没上云时，教练端进度会永远是 0，必须留下线索。
      // submitReview 内部已把这条请求压进补传队列，启动/回前台会自动重放。
      var msg = (err && (err.errMsg || err.message)) || String(err);
      learnlog.patch(logId, 'fail', msg);
      console.warn('[cloud] submitReview 失败（已进补传队列，稍后自动重试）：', msg);
    });

    // 4) 下一个词
    // 这里刻意不立即换词，而是先进入一个短暂的"已记录"状态（约 260ms）：
    //   ① 视觉上：让"收起答案 + 换词"变得可见。否则前后两个词长得很像时，
    //      用户会以为没换（真机上反馈过"太快了，看不出换没换"）；
    //   ② 技术上：真机上出现过"复位的 setData 被随后同 tick 的属性更新覆盖"，
    //      导致下一个词仍显示上一个词的答案。把两步拆到不同 tick，这个竞态就消失了；
    //   ③ 顺带给了一次误触缓冲：这 260ms 内卡片锁定，不会连点连过两个词。
    this.setData({ ratedCount: (this.data.ratedCount || 0) + 1 });   // 只统计真实评价，示范卡不计入
    this.advanceToNext();
  },

  /** 记完评价后推进到下一张卡：先短暂停顿，再真正换数据 */
  advanceToNext: function () {
    var self = this;
    var card = this.selectComponent('#card');
    if (card && card.lock) card.lock();       // 停顿期间禁止一切手势与点击

    this.setData({ loading: true, loadingText: this._lastFeedbackLabel || '' });

    clearTimeout(this._advanceTimer);
    this._advanceTimer = setTimeout(function () {
      self.setData({ loading: false });
      self.setData({ index: self.data.index + 1 });
      self.showCurrent();
    }, 260);
  },

  onUnload: function () {
    clearTimeout(this._advanceTimer);
  },

  onSpeak: function (e) {
    var w = e.detail.word;
    this.speakWord(w);
  },

  /**
   * 单词发音：走 utils/tts.js（本地 mp3 优先，插件兜底），学习卡上的 🔊 按钮就是它。
   * 音频缺失且无插件时给一次性明确提示，而不是沉默失败。
   */
  speakWord: function (w) {
    if (!tts.isAvailable()) {
      wx.showToast({ title: '发音资源未就绪，请重新编译/更新版本', icon: 'none' });
      return;
    }
    tts.speak(w, function (ok) {
      if (!ok) wx.showToast({ title: '朗读失败，请稍后再试', icon: 'none' });
    });
  },

  onRestart: function () {
    this._extraRound = false;
    this.buildQueue(false);
  },

  /**
   * 提前巩固：把还没到期的词提前拿出来学。
   * 只在"今天确实没词可学"时出现。必须在界面上说清代价——
   * 提前复习会刷新这些词的间隔，等于把复习计划整体往前拨。
   */
  onExtra: function () {
    this._extraRound = true;
    this.buildQueue(true);
  },

  /** 学完一轮后引导去抽查：真正决定复习间隔的是抽查结果，不是自评 */
  onGoQuiz: function () {
    wx.redirectTo({ url: '/pkg-media/pages/quiz/quiz' });
  }
});
