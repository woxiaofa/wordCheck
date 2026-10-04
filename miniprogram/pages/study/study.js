/**
 * 学习页
 *
 * 数据来源策略（这是让项目"导入即可跑"的关键）：
 *   1) 词序列：优先用云端（review.due 返回到期词，task.today 返回今日任务）；
 *      云端不可用时回退到本地示例词库，保证离线也能验证交互。
 *   2) SRS 状态：本地留一份镜像（缓存），保证每一次反馈都有即时可见的结果；
 *      同时带幂等 ID 提交到云端，云端未部署时静默失败、不影响使用。
 *
 * 注意：这是开发阶段的过渡形态。正式版必须由云端的 task 云函数给出队列快照，
 *      本地镜像只作为缓存和离线补传，不能作为真相来源。
 */

var api = require('../../utils/cloud').api;
var humanError = require('../../utils/cloud').humanError;
var srs = require('../../utils/srs');
var time = require('../../utils/time');
var WORDS = require('../../data/words');

var STORAGE_KEY = 'word_state_mirror';
var CACHE_PREFIX = 'word_cache_v1:';
/** 新手引导标记：示范卡只出现一次（本地存，换设备重看一遍无害，不值得为它发云请求） */
var ONBOARD_KEY = 'onboard_v1_gesture';
/** 三档反馈的可读文案。放在模块级，避免任何路径上因实例状态缺失而取值失败 */
var FEEDBACK_LABELS = { known: '想得很快', vague: '想起来了，但费劲', forgot: '没想起来' };

Page({
  data: {
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
    roundDone: false
  },

  /** @type {Object} 本地 SRS 状态镜像：{ [word]: {stage,last_feedback,next_review_at,correct_count,wrong_count} } */
  mirror: {},

  onLoad: function () {
    this.mirror = wx.getStorageSync(STORAGE_KEY) || {};
    this.buildQueue();
  },

  onShow: function () {
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

  buildQueue: function () {
    var self = this;
    this.loadedDate = time.getLocalDate();
    this.setData({ roundStat: { known: 0, vague: 0, forgot: 0 }, ratedCount: 0 });

    api.todayTask(this.loadedDate).then(function (data) {
      var words = (data && data.words) || [];
      if (!words.length) throw new Error('EMPTY');
      self.setQueue(words, false);
    }).catch(function () {
      // 云端不可用：回退本地词库，仍然按"到期优先"的规则排序
      var local = self.localQueue();
      self.setQueue(local, true);
    });
  },

  /** 本地队列：到期复习词优先，其次错词，最后新词（与文档 6.3 的组装顺序一致） */
  localQueue: function () {
    var now = Date.now();
    var due = [], wrong = [], fresh = [];
    for (var i = 0; i < WORDS.length; i++) {
      var w = WORDS[i];
      var st = this.mirror[w.word];
      if (!st) { fresh.push(w); continue; }
      if (st.next_review_at && st.next_review_at <= now) due.push(w);
      else if (st.wrong_count > 0 && st.last_feedback !== 'known') wrong.push(w);
    }
    var merged = due.concat(wrong);
    var limit = 10;
    return merged.concat(fresh.slice(0, limit));
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
      isLocal: !!isLocal
    });
    this.showCurrent();
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
      this.setData({
        word: null,
        isDemo: false,
        emptyText: '这一轮学完了',
        emptySub: '本轮 ' + (this.data.ratedCount || 0) + ' 个词：认识 ' + (stat.known || 0) +
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

    // 3) 异步提交云端（幂等 ID 保证重试安全）
    api.submitReview({
      wordId: w.word,
      feedback: fb,
      mode: 'learn',
      clientReqId: CACHE_PREFIX + srs.newReqId()
    }).catch(function () {
      // 静默：开发阶段云端可能未部署。正式版要在这里把请求压进补传队列。
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
   * 单词发音
   *
   * ⚠️ 这里刻意不写死任何第三方发音 URL：小程序对 request 域名有白名单要求，
   *    而且外部 TTS 链接随时可能失效或变更，写死会在真机上表现为"点了没声音"。
   *    正式做法有两种，二选一：
   *      ① 预生成音频放云存储/CDN，用 fileID 播放（推荐：音质稳定、无外部依赖、可缓存）
   *      ② 小程序端用微信同声传译插件（需在小程序后台申请插件）
   *    配置好之后，把 audioUrl 换成你自己的地址即可。
   */
  speakWord: function (w) {
    var url = this.audioUrlFor(w);
    if (!url) {
      wx.showToast({ title: '尚未配置发音源', icon: 'none' });
      return;
    }
    var ctx = wx.createInnerAudioContext();
    ctx.src = url;
    ctx.onError(function () { wx.showToast({ title: '读音加载失败', icon: 'none' }); });
    ctx.play();
  },

  /** 发音地址解析：留空表示未配置。接入云存储后改成返回对应的 fileID。 */
  audioUrlFor: function (w) {
    return '';
  },

  onRestart: function () {
    this.buildQueue();
  }
});
