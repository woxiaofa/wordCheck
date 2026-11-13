/**
 * 「开始背单词」体验主流程 —— 口语贯穿式（2026-11-12 用户拍板）
 *
 * 四阶段：
 *   ① 带读：词 → 短句 → 小段，每条"出现即主动发音"，按住跟读，
 *      三档反馈，合格才下一条；读满 3 次仍不合格给「可以跳过」出口。
 *   ② 口语抽查：不给示范音，自己读一遍，错的再过一轮。
 *      2026-11-13 用户拍板：**不在这里另造选择题**，书面「认 / 写」全交给现有 drill。
 *   ③ 背词：直接进现有 drill（认 → 写 → 巩固），一行都不重造。
 *   ④ 报告：口语与书面并到一张纸，列出待练条目，可只重练没读流畅的。
 *
 * 真机反馈修复（2026-11-13 第一轮）：
 *   · 按住按钮改 catch 系列手势 + 禁止按住时页面滚动，不再「按一下就闪一下」；
 *   · 抬手后留 TAIL_MS 尾音缓冲，期间显示「在听你读完…」，评分前裁掉缓冲静音；
 *   · 判定用 utils/sfx.js 的既有正确 / 错误提示音，与 drill 完全一致。
 *
 * 真机反馈修复（2026-11-13 第二轮，本文件当前状态）：
 *   · 删掉那条「不方便按住？点两下」的次级入口（用户：没这个功能，不要这个提示）；
 *   · 首次授权把按钮卡死：页面 onHide 后 `_active` 永远回不来，且授权弹窗会吃掉
 *     touchend 让 holding 挂在 true —— 现在 onShow 恢复 active + 清悬空态，
 *     并且**先确认麦克风可用才起录**，第一次按只做授权、不进入录音；
 *   · 息屏 / 切后台回来「按了没反应」：录音状态机可能停在 RECORDING，
 *     onShow 调 oral.reset() 强制回 IDLE；
 *   · 跳过按不动：抬手缓冲期间原来会被方法层直接 return，现在是「取消缓冲并跳过」；
 *   · 下一词位置下移；读够 3 遍才直接进下一条，没到 3 遍先给按钮问一句。
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
var sfx = require('../../../utils/sfx');
var flow = require('../../../utils/oral-flow');
var lesson = require('../../../data/oral-lesson');
var lessonAudio = require('../../../utils/lesson-audio');
var books = require('../../../utils/books');
var privacy = require('../../../utils/privacy');

var HONEST_TIP = '本机只看有没有读完、读得连不连贯，不判断发音准不准';
var TAIL_MS = 1200;        // 抬手后多录的尾音缓冲：孩子常话没落音就松手
var ADVANCE_MS = 1000;     // 与 drill 答对庆祝层一致的停留时长
var CELEBRATE_MS = 1200;   // ✓ 层自动收起：它盖满全屏，不能一直压着「下一个」按钮

Page({
  data: {
    skin: theme.cls(),
    stage: 'lead',              // lead | check | drill | report
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
    settling: false,            // 抬手后的「在听你读完…」loading
    celebrate: false,           // 与 drill 一致的 ✓ 庆祝层
    autoNext: false,            // 读够 3 遍才自动进下一条，否则等孩子点
    canSkip: false,             // 读满 3 次 / 麦克风不可用才允许跳过
    feedback: null,             // { grade, verdict, issues, retry }
    passed: false,

    /* ② 口语抽查（不再有选择题） */
    q: null,
    qIdx: 0,
    qTotal: 0,
    qHolding: false,
    qSettling: false,
    qCelebrate: false,
    qFeedback: null,
    qPassed: false,
    checkRound: 1,

    /* ④ 报告 */
    report: null
  },

  /* ---------------- 生命周期 ---------------- */

  onLoad: function (options) {
    this._active = true;
    this._pressing = false;
    this._needAuth = false;
    this._micReady = null;      // null = 还不知道；false = 首次按下先走授权
    this._authing = false;
    this._holdGen = 0;          // 每次起录 +1，迟到的判定不许覆盖新的一轮
    this._qGen = 0;
    this._traces = [];
    this._items = [];
    this._qList = [];
    this._wrong = [];
    this._checkTotal = 0;
    this._checkWrongTotal = 0;
    this._practiceOnly = false;
    this._seed = (Date.now() % 100000) + 1;
    this._clearTimers();

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
    // 2026-11-13 真机：手机息屏再点亮、或从授权设置页回来，按住按钮彻底没反应。
    // 两个根因都在这里收口：
    //   ① `_active` 只在 onLoad 置 true，onHide 之后永远回不来 → 所有手势被方法层挡掉；
    //   ② 录音状态机可能停在 RECORDING（onStop 不再回调）→ 之后每次按住都被 BUSY 拒绝。
    this._active = true;
    this._pressing = false;
    this._needAuth = false;
    this._clearTimers();
    if (oral.getState && oral.getState() !== 'IDLE') oral.reset();
    this.syncMicReady();
    if (this.data.holding || this.data.settling) {
      this.setData({ holding: false, settling: false, tip: '刚才被打断了，再按住读一遍' });
    }
    if (this.data.qHolding || this.data.qSettling) {
      this.setData({ qHolding: false, qSettling: false, tip: '刚才被打断了，再按住读一遍' });
    }
  },

  onHide: function () {
    // 只把 active 关掉、把麦克风收掉；不要在这里改 UI 状态，
    // 统一交给 onShow 复位，避免「隐藏时清一半、显示时接不上」。
    this._active = false;
    this._pressing = false;
    this._clearTimers();
    oral.cancelRecord();
    lessonAudio.stop();
  },

  onUnload: function () {
    this._active = false;
    this._pressing = false;
    this._clearTimers();
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

  /* ---------------- 麦克风授权 ---------------- */

  /**
   * 只查不改：不弹窗、不需要用户手势。
   * scope.record 已授权且隐私指引不需要再确认时，才认为「可以直接按住读」。
   * 查不到就保持 null（按旧逻辑直接起录，交给录音管理器自己报错）。
   */
  syncMicReady: function () {
    var self = this;
    if (typeof wx === 'undefined' || !wx.getSetting) return;
    function checkPrivacy(done) {
      if (!wx.getPrivacySetting) { done(true); return; }
      wx.getPrivacySetting({
        success: function (p) { done(!(p && p.needAuthorization)); },
        fail: function () { done(true); }
      });
    }
    checkPrivacy(function (privacyOk) {
      wx.getSetting({
        success: function (res) {
          var auth = res && res.authSetting;
          self._micReady = !!(privacyOk && auth && auth['scope.record'] === true);
        },
        fail: function () { self._micReady = null; }
      });
    });
  },

  /**
   * 第一次按住：先拿授权，**这一下不进入录音**。
   *
   * 旧做法是「按住即起录、授权在后台跑」，可隐私弹窗一出现，手指抬起时
   * touchend 会被弹窗吃掉，holding 永远挂在 true —— 用户看到的就是
   * 「按钮失效，必须下一个词或退出重进」。现在把授权拆成独立一步，
   * 拿到权限后提示一句「按住按钮读」，下一次按下才真正录音。
   */
  ensureMic: function () {
    var self = this;
    if (this._authing) return;
    this._authing = true;
    this._pressing = false;
    this.setData({ tip: '先允许用麦克风，再按住按钮读' });
    privacy.ensureRecord().then(function () {
      self._authing = false;
      self._micReady = true;
      if (!self._active) return;
      self.setData({ tip: '麦克风已允许，按住按钮读一遍' });
    }).catch(function (err) {
      self._authing = false;
      if (!self._active) return;
      var msg = (err && err.message) || '';
      if (msg === 'MIC_DENIED') {
        self.setData({ canSkip: true, tip: '没拿到麦克风权限，点「去设置」打开后就能读了' });
        self.openMicSetting();
        return;
      }
      self.setData({ canSkip: true, tip: '要先同意隐私指引，再按住读一遍' });
      privacy.onDenied(err, 'microphone');
    });
  },

  openMicSetting: function () {
    if (typeof wx === 'undefined' || !wx.showModal || !wx.openSetting) return;
    wx.showModal({
      title: '需要麦克风权限',
      content: '跟读要用到麦克风。录音只存在这台手机、不会上传。',
      confirmText: '去设置',
      success: function (r) {
        if (r && r.confirm) wx.openSetting({ success: function () {} });
      }
    });
  },

  /* ---------------- ① 带读 ---------------- */

  /**
   * @param {Array=} items 只重练传入的条目（报告「只练没读流畅的」）
   * @param {Object=} opts practiceOnly=true 时不再重跑书面背词，沿用上次的书面结果
   */
  startLead: function (items, opts) {
    var o = opts || {};
    this._clearTimers();
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
    this._clearTimers();
    var item = this._items[this.data.idx];
    if (!item) { this.startCheck(); return; }
    var played = this.playDemo(item);
    this.setData({
      item: item,
      retry: 0,
      demoPlayed: played,
      holding: false,
      settling: false,
      celebrate: false,
      autoNext: false,
      canSkip: false,
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
    if (!this._active || this.data.holding || this.data.settling ||
        this.data.passed || this.data.celebrate) return;
    var item = this.data.item;
    if (!item) return;
    this._pressing = true;
    // 已知没授权：按住这一下只做授权，不进入录音。
    // 微信要求隐私弹窗必须由用户点击触发，所以把真正调用放到抬手（touchend）时。
    if (this._micReady === false) {
      this._needAuth = true;
      this.setData({ tip: '松开手指，先允许用麦克风' });
      return;
    }
    this.beginHold(item);
  },

  /** 真正起录。gen 保证「上一轮迟到的判定」不会覆盖这一轮。 */
  beginHold: function (item) {
    var self = this;
    var gen = (this._holdGen = (this._holdGen || 0) + 1);
    lessonAudio.stop();                 // 别让示范音和录音叠在一起
    this.setData({ holding: true, settling: false, feedback: null,
      canSkip: false, autoNext: false, tip: '按住别松手，读完再抬手' });
    oral.startHold({
      type: 'custom',
      ref_text: item.refText,
      ref_word: item.word || '',
      code_id: '',
      source: 'local'
    }).then(function (out) {
      if (!self._active || gen !== self._holdGen) return;
      if (self._tailTimer) { clearTimeout(self._tailTimer); self._tailTimer = null; }
      self.onLeadScored(out);
    }).catch(function (err) {
      if (!self._active || gen !== self._holdGen) return;
      if (self._tailTimer) { clearTimeout(self._tailTimer); self._tailTimer = null; }
      if (err && /CANCELED/.test(err.message || '')) {
        self.setData({ holding: false, settling: false, tip: '刚才被打断了，再按住读一遍' });
        return;
      }
      self.setData({ holding: false, settling: false, canSkip: true, tip: self.errorText(err) });
      if (err && /DENIED/i.test(err.message || '')) privacy.onDenied(err, 'microphone');
    });
  },

  /** catchtouchmove 用：按住期间不让页面滚动把手势抢走 */
  onHoldMove: function () {},

  /**
   * 抬手不立刻收尾：孩子常常话没落音就松手，尾音会被切掉。
   * 多录 TAIL_MS 并显示 loading，评分时再裁掉这段静音（scorer.trimTailSilence）。
   */
  onHoldEnd: function () {
    this._pressing = false;
    if (this._needAuth) {          // 授权那一下：抬手才弹隐私弹窗
      this._needAuth = false;
      this.ensureMic();
      return;
    }
    if (!this.data.holding || this.data.settling) return;
    var self = this;
    this.setData({ holding: false, settling: true, tip: '在听你读完…稍等一下' });
    if (this._tailTimer) clearTimeout(this._tailTimer);
    this._tailTimer = setTimeout(function () {
      self._tailTimer = null;
      oral.stop().catch(function () { /* onError 已把状态复位 */ });
    }, TAIL_MS);
  },

  /** 评分器统一入口：这一行将来接 SOE 时不用改，只换 scorer.use('soe') */
  onLeadScored: function (out) {
    var item = this.data.item;
    if (!item) return;
    var retry = this.data.retry;
    var attempts = retry + 1;                  // 这一条已经读了几遍（含这一次）
    var trimmed = scorer.trimTailSilence(out.frames, TAIL_MS);
    var result = scorer.score({
      frames: trimmed.frames,
      durationMs: Math.max(0, (out.durationMs || 0) - trimmed.removedMs),
      refText: item.refText,        // 用原始文本，别用录音层截断过的 meta
      retry: retry,
      listened: this.data.demoPlayed
    });
    var passed = result.grade !== 'bad';
    // 「3 遍不对提示可以跳过」：第 3 次判完给出口，但不自动放行，
    // 孩子可以自己决定跳过，也可以继续读到过。
    var canSkip = !passed && attempts >= scorer.MAX_RETRY;

    if (passed) {
      sfx.playCorrect();
      this._traces.push(scorer.trace({
        refText: item.refText, kind: item.kind, result: result, retry: retry, forced: false
      }));
      this.saveSession();
      // 2026-11-13 用户拍板：读够 3 遍才「直接下一个」；
      // 没到 3 遍先给按钮问一句，免得孩子手还停在按钮附近就被跳走。
      var autoNext = attempts >= scorer.MAX_RETRY;
      this.setData({
        holding: false,
        settling: false,
        passed: true,
        canSkip: false,
        celebrate: true,
        autoNext: autoNext,
        feedback: {
          grade: result.grade,
          verdict: result.verdict,
          issues: result.issues || [],
          retry: retry
        },
        tip: autoNext ? '这条过了，马上到下一个' : '这条过了，点下面的「下一个」继续'
      });
      this._flashCelebrate(false);
      if (autoNext) this._advance();
      return;
    }

    sfx.playWrong();
    this.setData({
      holding: false,
      settling: false,
      passed: false,
      celebrate: false,
      autoNext: false,
      canSkip: canSkip,
      feedback: {
        grade: 'bad',
        verdict: canSkip ? '读了 3 遍还不太顺，可以跳过' : '再读一遍',
        issues: result.issues || [],
        retry: retry
      },
      tip: canSkip ? '不用勉强，点「可以跳过」先往下走'
        : '再读一遍（还能读 ' + Math.max(0, scorer.MAX_RETRY - attempts) + ' 次）',
      retry: attempts
    });
  },

  /** 兜底出口：读满 3 次 / 麦克风不可用时可跳过，留痕进报告待练清单 */
  onSkipItem: function () {
    var item = this.data.item;
    if (!item || this.data.passed) return;
    // 还在缓冲里点跳过也要立刻生效：先让在路上的那次判定作废，再把麦克风收掉
    this._holdGen = (this._holdGen || 0) + 1;
    if (this._tailTimer) { clearTimeout(this._tailTimer); this._tailTimer = null; }
    if (oral.getState && oral.getState() !== 'IDLE') oral.reset();
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
      settling: false,
      passed: true,
      canSkip: false,
      celebrate: false,
      autoNext: false,
      feedback: { grade: 'bad', verdict: '先跳过，报告里会记下来', issues: [], retry: this.data.retry },
      tip: '跳过也会进待练清单'
    });
  },

  onNext: function () {
    // 门槛在方法层再守一次：wxml 只给已过的人显示按钮，但方法不该假设调用方守规矩
    if (!this.data.passed) return;
    if (this._advanceTimer) { clearTimeout(this._advanceTimer); this._advanceTimer = null; }
    var i = this.data.idx + 1;
    if (i < this._items.length) {
      this.setData({ idx: i });
      this.showLeadItem();
      return;
    }
    this.startCheck();
  },

  /* ---------------- ② 口语抽查 ---------------- */

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
    if (this._qTailTimer) { clearTimeout(this._qTailTimer); this._qTailTimer = null; }
    if (this._qAdvanceTimer) { clearTimeout(this._qAdvanceTimer); this._qAdvanceTimer = null; }
    var q = this._qList[this.data.qIdx];
    if (!q) { this.endCheckRound(); return; }
    // 抽查阶段刻意不播示范音：这一轮考的是"自己能不能读出来"
    this.setData({
      q: q,
      qHolding: false,
      qSettling: false,
      qCelebrate: false,
      qFeedback: null,
      qPassed: false,
      stepText: '第 2 步 抽查 · ' + (this.data.qIdx + 1) + '/' + this._qList.length +
        ' · ' + q.label + (this.data.checkRound > 1 ? '（再过一遍）' : ''),
      progressPct: Math.round(this.data.qIdx / this._qList.length * 100),
      tip: '这一遍不给示范音，按住读出声'
    });
  },

  onQHoldStart: function () {
    if (!this._active || this.data.qHolding || this.data.qSettling ||
        this.data.qPassed || this.data.qCelebrate) return;
    var q = this.data.q;
    if (!q || q.type !== 'oral') return;
    this._pressing = true;
    if (this._micReady === false) {
      this._needAuth = true;
      this.setData({ tip: '松开手指，先允许用麦克风' });
      return;
    }
    this.beginQHold(q);
  },

  beginQHold: function (q) {
    var self = this;
    var gen = (this._qGen = (this._qGen || 0) + 1);
    this.setData({ qHolding: true, qSettling: false, qFeedback: null,
      tip: '按住别松手，读完再抬手' });
    oral.startHold({
      type: 'custom', ref_text: q.refText, ref_word: q.word || '', code_id: '', source: 'local'
    }).then(function (out) {
      if (!self._active || gen !== self._qGen) return;
      if (self._qTailTimer) { clearTimeout(self._qTailTimer); self._qTailTimer = null; }
      self.onQScored(out);
    }).catch(function (err) {
      if (!self._active || gen !== self._qGen) return;
      if (self._qTailTimer) { clearTimeout(self._qTailTimer); self._qTailTimer = null; }
      if (err && /CANCELED/.test(err.message || '')) {
        self.setData({ qHolding: false, qSettling: false, tip: '刚才被打断了，再按住读一遍' });
        return;
      }
      self.setData({ qHolding: false, qSettling: false, qPassed: true, qFeedback: null,
        tip: self.errorText(err) });
      if (err && /DENIED/i.test(err.message || '')) privacy.onDenied(err, 'microphone');
    });
  },

  onQHoldMove: function () {},

  onQHoldEnd: function () {
    this._pressing = false;
    if (this._needAuth) {
      this._needAuth = false;
      this.ensureMic();
      return;
    }
    if (!this.data.qHolding || this.data.qSettling) return;
    var self = this;
    this.setData({ qHolding: false, qSettling: true, tip: '在听你读完…稍等一下' });
    if (this._qTailTimer) clearTimeout(this._qTailTimer);
    this._qTailTimer = setTimeout(function () {
      self._qTailTimer = null;
      oral.stop().catch(function () { /* 状态已复位 */ });
    }, TAIL_MS);
  },

  onQScored: function (out) {
    var q = this.data.q;
    if (!q) return;
    // 抽查不给示范音 → listened:false，最多拿到「读完了」，不冒充流畅
    var trimmed = scorer.trimTailSilence(out.frames, TAIL_MS);
    var result = scorer.score({
      frames: trimmed.frames,
      durationMs: Math.max(0, (out.durationMs || 0) - trimmed.removedMs),
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
    if (ok) sfx.playCorrect(); else sfx.playWrong();
    this.setData({
      qHolding: false,
      qSettling: false,
      qPassed: true,
      qCelebrate: ok,
      qFeedback: {
        grade: result.grade,
        verdict: ok ? '读出来了' : '没关系，最后会再过一遍',
        issues: result.issues || []
      },
      tip: ok ? '这条过了' : '没关系的，最后会再过一遍'
    });
    this._flashCelebrate(true);
    this._advanceQ();
  },

  onQNext: function () {
    if (!this.data.qPassed) return;
    if (this._qAdvanceTimer) { clearTimeout(this._qAdvanceTimer); this._qAdvanceTimer = null; }
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
    this._clearTimers();
    // 先切到过渡态再跳：分包加载有几百毫秒，别让孩子对着上一题的白屏发愣
    this.setData({ stage: 'drill', stepText: '第 3 步 背词', progressPct: 100 });
    wx.redirectTo({ url: '/pkg-media/pages/drill/drill?fromFlow=1' });
  },

  /* ---------------- ④ 报告 ---------------- */

  showReport: function () {
    this._clearTimers();
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
    this._clearTimers();
    flow.clear();
    this.startLead();
  },

  onHome: function () {
    this._clearTimers();
    wx.redirectTo({ url: '/pages/index/index' });
  },

  /* ---------------- 内部 ---------------- */

  _clearTimers: function () {
    var self = this;
    ['_tailTimer', '_qTailTimer', '_advanceTimer', '_qAdvanceTimer',
      '_celebrateTimer', '_qCelebrateTimer'].forEach(function (k) {
      if (self[k]) { clearTimeout(self[k]); self[k] = null; }
    });
  },

  /**
   * ✓ 庆祝层是全屏遮罩，只能闪一下。
   * 之前它只在切到下一条时消失 —— 而「没到 3 遍先停下问一句」的流程里
   * 会一直压着「下一个」按钮，看着像点不动。
   */
  _flashCelebrate: function (isQ) {
    var self = this;
    var key = isQ ? '_qCelebrateTimer' : '_celebrateTimer';
    if (this[key]) { clearTimeout(this[key]); this[key] = null; }
    this[key] = setTimeout(function () {
      self[key] = null;
      if (!self._active) return;
      self.setData(isQ ? { qCelebrate: false } : { celebrate: false });
    }, CELEBRATE_MS);
  },

  /** 合格后的自动进条：与 drill 答对庆祝层停 1 秒再跳词同款节奏 */
  _advance: function () {
    var self = this;
    if (this._advanceTimer) { clearTimeout(this._advanceTimer); this._advanceTimer = null; }
    this._advanceTimer = setTimeout(function () {
      self._advanceTimer = null;
      if (self._active) self.onNext();
    }, ADVANCE_MS);
  },

  _advanceQ: function () {
    var self = this;
    if (this._qAdvanceTimer) { clearTimeout(this._qAdvanceTimer); this._qAdvanceTimer = null; }
    this._qAdvanceTimer = setTimeout(function () {
      self._qAdvanceTimer = null;
      if (self._active) self.onQNext();
    }, ADVANCE_MS);
  },

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
    if (/CANCELED/i.test(m)) return '刚才被打断了，再按住读一遍';
    if (/DENIED/i.test(m)) return '没拿到麦克风权限，可以在设置里打开；也能先跳过';
    if (oral.errorText) return oral.errorText(err);
    return '这条没录成，再试一次，或者先跳过';
  }
});
