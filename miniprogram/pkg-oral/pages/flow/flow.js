/**
 * 「开始背单词」体验主流程 —— 口语贯穿式（2026-11-12 用户拍板）
 *
 * 与旧实现的本质区别：口语不是进来先读一遍的「前置闸门」，
 * 而是贯穿全程的一类题型。四阶段：
 *   ① 带读：词 → 短句 → 小段，每条"出现即主动发音"，按住跟读，
 *      三档反馈，合格才下一条；重读满 3 次也放行，但留痕进报告。
 *   ② 抽查：口语题不再给示范音，与「认」题混排过一遍；错的再过一轮。
 *   ③ 背词：直接进现有 drill（认 → 写 → 巩固），一行都不重造。
 *   ④ 报告：口语与书面并到一张纸，列出待练条目，可只重练没读流畅的。
 *
 * 诚实红线（必须一直挂在页面上）：
 *   本期评分器只测「有没有开口、读完没、连不连贯」，**不判断发音准不准**。
 *   真发音评分要出端上云（SOE），接口已用 scorer.register/use 留好，
 *   替换引擎时本页一行都不用改。文案里不许出现「发音正确 / 得分 / 评测」。
 *
 * 隐私红线：按住跟读的 PCM 帧只在内存里算能量，不落盘、不进 12 条录音索引、
 * 不写打卡流水、不碰签到状态、不联网。跨页交接的 session 只含文本与三档。
 */

var theme = require('../../../utils/theme');
var oral = require('../../../utils/oral');
var scorer = require('../../../utils/oral-score');
var flow = require('../../../utils/oral-flow');
var lesson = require('../../../data/oral-lesson');
var lessonAudio = require('../../../utils/lesson-audio');
var books = require('../../../utils/books');
var privacy = require('../../../utils/privacy');

var HONEST_TIP = '本机只看有没有读完、读得连不连贯，不判断发音准不准';

Page({
  data: {
    skin: theme.cls(),
    stage: 'lead',              // lead | check | report
    stepText: '',
    progressPct: 0,
    tip: '',
    honestTip: HONEST_TIP,

    /* ① 带读 */
    item: null,
    idx: 0,
    total: 0,
    retry: 0,
    demoPlayed: false,
    holding: false,
    feedback: null,             // { grade, verdict, issues, retry }
    passed: false,

    /* ② 混排抽查 */
    q: null,
    qIdx: 0,
    qTotal: 0,
    qHolding: false,
    qFeedback: null,
    qSelected: '',
    qPassed: false,
    checkRound: 1,

    /* ④ 报告 */
    report: null
  },

  /* ---------------- 生命周期 ---------------- */

  onLoad: function (options) {
    this._active = true;
    this._traces = [];          // 口语留痕，交给报告
    this._items = [];
    this._qList = [];
    this._wrong = [];
    this._checkTotal = 0;
    this._checkWrongTotal = 0;
    this._practiceOnly = false;
    this._seed = (Date.now() % 100000) + 1;

    // drill 完成后 redirect 回来，只带一个 report=1：会话从本机 storage 读，
    // 不依赖页面栈、不依赖模块内存，系统回收过也能出报告。
    if (options && options.report === '1') {
      this.showReport();
      return;
    }
    this.startLead();
  },

  onShow: function () {
    theme.syncPage(this);
  },

  onHide: function () {
    this._active = false;
    oral.cancelRecord();
    lessonAudio.stop();
  },

  onUnload: function () {
    this._active = false;
    oral.cancelRecord();
    lessonAudio.stop();
  },

  onShareAppMessage: function () {
    var r = this.data.report || {};
    return {
      title: r.allPerfect ? '这一轮全读流畅了，报告看看' : '今天的背单词报告，口语和书面都在里面',
      path: '/pages/index/index'
    };
  },

  /* ---------------- ① 带读 ---------------- */

  /**
   * @param {Array=} items 只重练传入的条目（报告「只练没读流畅的」）
   * @param {Object=} opts practiceOnly=true 时不再重跑书面背词，沿用上次的书面结果
   */
  startLead: function (items, opts) {
    var o = opts || {};
    this._practiceOnly = !!o.practiceOnly;
    var keep = o.keepPerfect ? (this._traces || []).filter(function (t) {
      return t && t.grade === 'perfect';
    }) : [];
    this._traces = keep;
    this._items = (items && items.length ? items : lesson.buildItems()).slice();
    this._checkTotal = 0;
    this._checkWrongTotal = 0;
    this._wrong = [];
    this.setData({ stage: 'lead', idx: 0, total: this._items.length, checkRound: 1 });
    this.saveSession();
    this.showLeadItem();
  },

  showLeadItem: function () {
    var item = this._items[this.data.idx];
    if (!item) { this.startCheck(); return; }
    var played = this.playDemo(item);
    this.setData({
      item: item,
      retry: 0,
      demoPlayed: played,
      holding: false,
      feedback: null,
      passed: false,
      stepText: '第 1 步 带读 · ' + (this.data.idx + 1) + '/' + this._items.length + ' · ' + item.label,
      progressPct: Math.round(this.data.idx / this._items.length * 100),
      tip: played ? '先听一遍，再按住下面的按钮跟着读' : '这条暂时没有示范音，看着读一遍就好'
    });
  },

  /** 出现即主动发音：词走本地词级 mp3，句 / 段走本包离线合成 mp3，都不联网 */
  playDemo: function (item) {
    if (!item) return false;
    if (item.kind === 'word') return !!oral.speak(item.word);
    return !!lessonAudio.play(item.audio);
  },

  onReplayDemo: function () {
    var item = this.data.item;
    if (!item) return;
    if (!this.playDemo(item)) wx.showToast({ title: '这条暂时没有示范音', icon: 'none' });
  },

  onHoldStart: function () {
    var self = this;
    if (!this._active || this.data.holding || this.data.passed) return;
    var item = this.data.item;
    if (!item) return;
    lessonAudio.stop();                 // 别让示范音和录音叠在一起
    this.setData({ holding: true, feedback: null, tip: '正在听你读…松手就好' });
    oral.startHold({
      type: 'custom',
      ref_text: item.refText,
      ref_word: item.word || '',
      code_id: '',
      source: 'local'
    }).then(function (out) {
      if (self._active) self.onLeadScored(out);
    }).catch(function (err) {
      if (!self._active) return;
      self.setData({ holding: false, tip: self.errorText(err) });
      if (err && /DENIED/i.test(err.message || '')) privacy.onDenied(err, 'microphone');
    });
  },

  onHoldEnd: function () {
    if (!this.data.holding) return;
    this.setData({ holding: false, tip: '正在看这一遍…' });
    oral.stop().catch(function () { /* onError 已把状态复位 */ });
  },

  /** 不方便按住时：点一下开始、再点一下结束（模拟器 / 手抖都能用） */
  onTapHold: function () {
    if (this.data.holding) this.onHoldEnd();
    else this.onHoldStart();
  },

  /** 评分器统一入口：这一行将来接 SOE 时不用改，只换 scorer.use('soe') */
  onLeadScored: function (out) {
    var item = this.data.item;
    if (!item) return;
    var retry = this.data.retry;
    var result = scorer.score({
      frames: out.frames,
      durationMs: out.durationMs,
      refText: item.refText,        // 用原始文本，别用录音层截断过的 meta
      retry: retry,
      listened: this.data.demoPlayed
    });
    var pass = scorer.shouldPass(result, retry);
    var forced = pass && result.grade === 'bad';

    if (pass) {
      this._traces.push(scorer.trace({
        refText: item.refText,
        kind: item.kind,
        result: result,
        retry: retry,
        forced: forced
      }));
      this.saveSession();
    }

    this.setData({
      holding: false,
      passed: pass,
      feedback: {
        grade: result.grade,
        verdict: forced ? '先往下走，报告里会记一笔' : result.verdict,
        issues: result.issues || [],
        retry: retry
      },
      tip: pass ? (forced ? '读了几次还不太顺，先过，最后再练' : '这条过了，点「下一个」')
        : '再读一遍（还能读 ' + Math.max(0, scorer.MAX_RETRY - retry) + ' 次）'
    });
    if (!pass) this.setData({ retry: retry + 1 });
  },

  onSkipItem: function () {
    var item = this.data.item;
    if (!item || this.data.passed) return;
    this._traces.push({
      refText: item.refText,
      kind: item.kind,
      grade: 'bad',
      retry: this.data.retry,
      forced: true,
      engine: 'local',
      honest: true,
      issues: ['这次先跳过']
    });
    this.saveSession();
    this.setData({
      holding: false,
      passed: true,
      feedback: { grade: 'bad', verdict: '先跳过，报告里会记下来', issues: [], retry: this.data.retry },
      tip: '跳过也会进待练清单'
    });
  },

  onNext: function () {
    // 门槛在方法层再守一次：wxml 只给已过的人显示按钮，但方法不该假设调用方守规矩
    if (!this.data.passed) return;
    var i = this.data.idx + 1;
    if (i < this._items.length) {
      this.setData({ idx: i });
      this.showLeadItem();
      return;
    }
    this.startCheck();
  },

  /* ---------------- ② 混排抽查 ---------------- */

  startCheck: function () {
    var pool = [];
    try { pool = books.getWords(books.getKey()) || []; } catch (e) { pool = []; }
    this._qList = flow.buildCheck(this._items, pool, this._seed);
    this._checkTotal = this._qList.length;
    this._checkWrongTotal = 0;
    this._wrong = [];
    this.setData({ stage: 'check', qIdx: 0, qTotal: this._qList.length, checkRound: 1 });
    this.showQuestion();
  },

  showQuestion: function () {
    var q = this._qList[this.data.qIdx];
    if (!q) { this.endCheckRound(); return; }
    // 抽查阶段刻意不播示范音：这一轮考的是"自己能不能读出来"
    this.setData({
      q: q,
      qHolding: false,
      qFeedback: null,
      qSelected: '',
      qPassed: false,
      stepText: '第 2 步 抽查 · ' + (this.data.qIdx + 1) + '/' + this._qList.length +
        ' · ' + q.label + (this.data.checkRound > 1 ? '（再过一遍）' : ''),
      progressPct: Math.round(this.data.qIdx / this._qList.length * 100),
      tip: q.type === 'oral' ? '这一遍不给示范音，自己读' : '看单词，选出中文意思'
    });
  },

  onQHoldStart: function () {
    var self = this;
    if (!this._active || this.data.qHolding || this.data.qPassed) return;
    var q = this.data.q;
    if (!q || q.type !== 'oral') return;
    this.setData({ qHolding: true, qFeedback: null, tip: '正在听你读…松手就好' });
    oral.startHold({
      type: 'custom', ref_text: q.refText, ref_word: q.word || '', code_id: '', source: 'local'
    }).then(function (out) {
      if (self._active) self.onQScored(out);
    }).catch(function (err) {
      if (!self._active) return;
      self.setData({ qHolding: false, tip: self.errorText(err) });
      if (err && /DENIED/i.test(err.message || '')) privacy.onDenied(err, 'microphone');
    });
  },

  onQHoldEnd: function () {
    if (!this.data.qHolding) return;
    this.setData({ qHolding: false, tip: '正在看这一遍…' });
    oral.stop().catch(function () { /* 状态已复位 */ });
  },

  onQTapHold: function () {
    if (this.data.qHolding) this.onQHoldEnd();
    else this.onQHoldStart();
  },

  onQScored: function (out) {
    var q = this.data.q;
    if (!q) return;
    // 抽查不给示范音 → listened:false，最多拿到「读完了」，不冒充流畅
    var result = scorer.score({
      frames: out.frames,
      durationMs: out.durationMs,
      refText: q.refText,
      retry: 0,
      listened: false
    });
    var ok = result.grade !== 'bad';
    this._traces.push(scorer.trace({
      refText: q.refText, kind: q.kind, result: result, retry: 0, forced: false
    }));
    if (!ok) this._wrong.push(q);
    this.saveSession();
    this.setData({
      qHolding: false,
      qPassed: true,
      qFeedback: {
        grade: result.grade,
        verdict: ok ? '读出来了' : '再读一遍（报告里会记下来）',
        issues: result.issues || []
      },
      tip: ok ? '这条过了' : '没关系的，最后会再过一遍'
    });
  },

  onQOption: function (e) {
    var q = this.data.q;
    if (!q || q.type !== 'meaning' || this.data.qPassed) return;
    var v = e.currentTarget.dataset.value;
    var ok = v === q.answer;
    if (!ok) this._wrong.push(q);
    this.setData({
      qSelected: v,
      qPassed: true,
      qFeedback: {
        grade: ok ? 'ok' : 'bad',
        verdict: ok ? '答对了' : '再记一下：' + q.answer,
        issues: []
      },
      tip: ok ? '这条过了' : '错词最后会再过一遍'
    });
  },

  onQSkip: function () {
    var q = this.data.q;
    if (!q || this.data.qPassed) return;
    this._wrong.push(q);
    if (q.type === 'oral') {
      this._traces.push({
        refText: q.refText, kind: q.kind, grade: 'bad', retry: 0,
        forced: true, engine: 'local', honest: true, issues: ['这次先跳过']
      });
      this.saveSession();
    }
    this.setData({
      qPassed: true,
      qHolding: false,
      qFeedback: { grade: 'bad', verdict: '先跳过，报告里会记下来', issues: [] },
      tip: '跳过也会进待练清单'
    });
  },

  onQNext: function () {
    if (!this.data.qPassed) return;
    var i = this.data.qIdx + 1;
    if (i < this._qList.length) {
      this.setData({ qIdx: i });
      this.showQuestion();
      return;
    }
    this.endCheckRound();
  },

  endCheckRound: function () {
    var wrong = this._wrong.slice();
    this._checkWrongTotal += wrong.length;
    var round = this.data.checkRound;
    if (flow.shouldRetry(wrong, round)) {
      this._qList = flow.buildRetry(wrong, this._seed + round);
      this._wrong = [];
      this.setData({ qIdx: 0, qTotal: this._qList.length, checkRound: round + 1 });
      this.showQuestion();
      wx.showToast({ title: '刚才没过的再过一遍', icon: 'none' });
      return;
    }
    this.saveSession();
    if (this._practiceOnly) { this.showReport(); return; }
    this.goDrill();
  },

  /** ③ 直接上现有背词：drill 会在 finish 时把书面结果交回本页的报告 */
  goDrill: function () {
    // 先切到过渡态再跳：分包加载有几百毫秒，别让孩子对着上一题的白屏发愣
    this.setData({ stage: 'drill', stepText: '第 3 步 背词', progressPct: 100 });
    wx.redirectTo({ url: '/pkg-media/pages/drill/drill?fromFlow=1' });
  },

  /* ---------------- ④ 报告 ---------------- */

  showReport: function () {
    var s = flow.load() || {};
    this._traces = (s.traces || []).slice();
    this.setData({
      stage: 'report',
      report: flow.mergeReport(s),
      stepText: '完成 · 口语和书面一起看',
      progressPct: 100,
      tip: '想精益求精，就只练下面没读流畅的'
    });
  },

  onPractice: function () {
    var refs = ((this.data.report && this.data.report.practice) || []).map(function (p) {
      return p.refText;
    });
    var all = lesson.buildItems();
    var picked = all.filter(function (x) { return refs.indexOf(x.refText) >= 0; });
    if (!picked.length) {
      wx.showToast({ title: '都读流畅啦', icon: 'none' });
      return;
    }
    this.startLead(picked, { keepPerfect: true, practiceOnly: true });
  },

  onRestartAll: function () {
    flow.clear();
    this.startLead();
  },

  onHome: function () {
    wx.redirectTo({ url: '/pages/index/index' });
  },

  /* ---------------- 内部 ---------------- */

  saveSession: function () {
    var s = flow.load() || {};
    s.traces = this._traces.slice();
    s.check = {
      total: this._checkTotal,
      wrong: this._checkWrongTotal,
      rounds: this.data.checkRound
    };
    // 只重练口语时沿用上次的书面结果；全新一轮必须清掉，别把上轮成绩带过来
    s.drill = this._practiceOnly ? (s.drill || null) : null;
    flow.save(s);
  },

  errorText: function (err) {
    var m = (err && (err.message || err.errMsg)) || '';
    if (/DENIED/i.test(m)) return '没拿到麦克风权限，可以在设置里打开；也能先跳过';
    if (oral.errorText) return oral.errorText(err);
    return '这条没录成，再试一次，或者先跳过';
  }
});
