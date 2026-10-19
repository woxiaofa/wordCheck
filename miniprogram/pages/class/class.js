/**
 * 班级页 —— 家长/老师端与学生端共用的一个页面，按身份渲染三态：
 *   未加入 → 二选一入口（建班 / 输邀请码）
 *   coach  → 班级卡（邀请码复制）+ 布置任务表单 + 作业进度 + 学员列表 + 催学文案
 *   student→ 班级名 + 作业列表（逐词进度）+ 去做作业
 *
 * 数据一律来自 class 云函数（utils/cloud.js 的 api.* 薄封装）；
 * 云失败时整页降级为提示 + 重试，绝不影响本地学习功能。
 */

var assignParam = require('../../utils/assign');
var cloud = require('../../utils/cloud');
var srs = require('../../utils/srs');
var time = require('../../utils/time');
var layout = require('../../utils/layout');
var privacy = require('../../utils/privacy');
var books = require('../../utils/books');
var env = require('../../utils/env');
var WORDS = require('../../data/words');

// 布置词库选项：外研四上排第一并作为默认（2026-10-10 用户拍板 ——
// 主场景就是教材同步，老师一进布置表单看到的就是课本词库）
var TAGS = ['外研四上', '全部', '中考', '高考', '四级'];
var CREATE_KEY = 'class_create_reqid';   // 建班幂等 ID 持久化：重进页面不产生第二个班
var CREATE_ID_PREFIX = 'class-create:';

Page({
  behaviors: [layout.behavior()],
  data: {
    loading: true,
    cloudError: '',

    my: {},                 // { role: ''|'coach'|'student' }
    cls: null,              // { id, name, code }

    // 教练端
    tags: TAGS,
    /** 每日简报订阅：{ [studentId]: true } —— 家长不必开小程序就能收到一句"今天学得怎样" */
    briefSubs: {},
    briefReady: false,
    briefNote: '',
    form: { scope: 'tag', tag: '外研四上', count: 10, deadline: '', note: '', personalized: false,
            volume: '', unit: 0, unitIndex: 0, start: 1,
            // 自动布置：一次设定分几天发完（2026-10-11）—— 42 词的单元分 4 天，
            // 之后每天早上 8 点自动接着发，老师只看报告和催一催
            planOn: false, planDays: 4 },
    assigning: false,
    // 布置预览（2026-10-09 反馈：布置前必须能看到"到底是哪些词"，还能删/加）
    preview: [],           // 本次将布置的词（词文本），所见即所得
    previewEdited: false,  // 删/加过 → 提交时整份传给服务端，作业名带"自定义"
    searchKw: '',
    searchHits: [],        // 搜索添加候选（≤20 条）
    /**
     * 取词范围：'tag' 按词库（老方式）/ 'unit' 按教材单元。
     * 为什么加这条：K12 场景里老师的第一个动作是"布置 Unit 3"，不是"布置 10 个中考词"。
     * 老方式必须原样保留 —— 已经布置过的老作业不能因为加了新入口就变了样。
     */
    volumes: [],          // [{ key, name, bookName, units: [{no,name,count}] }]
    unitNames: [],        // picker 显示文案
    unitVals: [],         // picker 对应的单元号（0 = 整册）
    unitTotal: 0,         // 当前单元总词数（起点/词数两个滑杆的上限都由它算）
    countMax: 30,         // 词数滑杆上限：unit 模式 = 单元剩余词数（42 词的单元不再被 30 卡住）
    continueFrom: 0,      // 该单元已布置覆盖到第几个词；>1 时显示"接着上次"按钮（0 = 不适用）
    planDaysNames: ['2 天', '3 天', '4 天', '5 天', '6 天', '7 天'],
    planPerDay: 0,        // 自动布置时每天几个词（WXML 读不了方法，只能存字段）
    plans: [],            // 本班自动布置计划（含进度）
    assignments: [],
    students: [],
    /** 数据加载失败时显示在对应卡片里的错误（绝不静默吞错：吞了就无法排查） */
    assignError: '',
    stuError: '',

    /** 云自检结果文本（排查"云到底通不通"时展示，平时为空不占地方） */
    diagnoseText: '',

    // 学生端
    myAssignments: [],
    myAssignError: '',
    /** 空列表时的服务端诊断提示（如 TEACHER_HAS_OTHER_CLASS：老师布置过作业但不在这个班） */
    emptyHint: '',

    today: '',

    /** 调试入口开关（云自检/修复历史数据/原始报错）：只在开发与体验版渲染，
     *  正式版整块不出现 —— 审核员和用户都不该看到排查工具（2026-10-14）。 */
    devTools: env.isDev()
  },

  onShow: function () {
    this.setData({ today: time.getLocalDate(Date.now()) });
    this.ensureUnits();
    this.rebuildPreview();
    // 先补传本地积压的学习记录，再拉云端数据——教练看到的进度才包含
    // 孩子刚学的内容。补传最多等 1.5 秒（网络慢时不再多等，页面照常加载）
    var self = this;
    var flushed = cloud.flushPending().catch(function () {});
    Promise.race([flushed, new Promise(function (r) { setTimeout(r, 1500); })])
      .then(function () { self.reload(); });
  },

  /** 下拉手动同步：家长想看最新进度时不用退出重进 */
  onPullDownRefresh: function () {
    this.reload();
    wx.stopPullDownRefresh();
  },

  reload: function () {
    var self = this;
    self.setData({ loading: true, cloudError: '' });

    cloud.api.myClass().then(function (r) {
      if (!r.class) {
        self.setData({ loading: false, my: {}, cls: null });
        return;
      }
      var role = r.role || (r.class ? 'student' : '');
      self.setData({ loading: false, cls: r.class, my: { role: role } });
      if (role === 'coach') {
        self.loadCoachData();
      } else {
        self.loadStudentData();
      }
    }).catch(function (err) {
      self.setData({
        loading: false,
        cloudError: cloud.humanError(err),
        // 原始报错摊在页面上：不用翻 Console 也能定位
        cloudRaw: (err && (err.errMsg || err.message)) || String(err)
      });
      console.warn('[class] myClass 加载失败', (err && (err.errMsg || err.message)) || err);
    });
  },

  /* ---------------- 教练端 ---------------- */

  loadCoachData: function () {
    var self = this;
    cloud.api.coachAssignments().then(function (r) {
      // 老师要的从来不是图表，是三件事：谁没交、错得最多的是哪几个词、错在哪。
      // 所以这里把云端算好的班级错因摊平成"能直接读的字符串"，
      // 界面只负责显示 —— 拼接逻辑放 wxml 里会把"没有错词"和"有错词但统计失败"混成同一种空白。
      var list = (r.assignments || []).map(function (a) {
        var cw = a.class_wrong || {};
        var pend = a.pending_names || [];
        var rev = a.review_names || [];
        return Object.assign({}, a, {
          pending: pend.length,
          pendingText: pend.join('、'),
          // 忘词待巩固：词全学过但有抽查答忘的 —— 不进红标点名，单独黄标温和提醒
          review: rev.length,
          reviewText: rev.join('、'),
          // 学员数为 0（新班级还没人加入）时页面上要说"还没有学员加入"，
          // 不能显示"全班完成"——0 个人全完成是数学上对、体验上错的文案（2026-10-09 实锤）
          students: a.total_students || 0,
          wrongTop: cw.wrong_top || [],
          mistakeTop: cw.mistake_top || [],
          letterTop: cw.letter_top || [],
          wrongCounted: cw.counted || 0,
          hasWrongStat: (cw.wrong_top || []).length > 0 || (cw.mistake_top || []).length > 0
        });
      });
      self.setData({ assignments: list, assignError: '' });
      // 作业列表到手后重算"接着上次"：打开页面时表单先渲染、数据后到，
      // 不重算的话续接按钮会晚一拍（甚至这个会话里一直不出现）
      // ⚠ 这里是 then 回调：只能用 self（写 this 会抛 undefined，后面整段都不执行）
      if (self.data.form.scope === 'unit') self.syncUnitMeta();
      // 自动布置计划单独拉：它失败不该连累作业列表（老师的正事是看谁没交）
      cloud.api.planList().then(function (pr) {
        self.setData({ plans: (pr && pr.data && pr.data.plans) || [] });
      }).catch(function () {
        self.setData({ plans: [] });
      });
    }).catch(function (err) {
      // 不静默：加载失败必须让教练看到原因，否则"布置了却看不到"无从排查
      self.setData({ assignError: cloud.humanError(err) });
      console.warn('[class] assignments 加载失败', err);
    });

    cloud.api.coachStudents().then(function (r) {
      var now = Date.now();
      var students = (r.students || []).map(function (s) {
        var stu = Object.assign({}, s, {
          lastSeenText: s.last_seen_at ? fmtAgo(now - s.last_seen_at) : '还没来过'
        });
        // 状态图标（2026-10-10 用户反馈：两行长文案太乱，改"一个状态图标 + 简短数据"）：
        //   💤 还没同步  ⏳ 今天还没学  🔴 好几天没来  ⚠️ 今天有忘词  🟢 学得不错
        var t = s.today || { count: 0, known: 0, forgot: 0 };
        var staleDays = s.last_seen_at ? (now - s.last_seen_at) / 86400000 : Infinity;
        if (!s.synced) {
          stu.status = { icon: '💤', label: '还没同步数据', tone: 'gray' };
        } else if (!t.count && staleDays >= 3) {
          stu.status = { icon: '🔴', label: (stu.lastSeenText || '很久') + '活跃', tone: 'red' };
        } else if (!t.count) {
          stu.status = { icon: '⏳', label: '今天还没学', tone: 'gray' };
        } else if (t.forgot) {
          stu.status = { icon: '⚠️', label: '今天 ' + t.count + ' 个 · 忘 ' + t.forgot + ' 个', tone: 'amber' };
        } else {
          stu.status = { icon: '🟢', label: '今天 ' + t.count + ' 个 · 掌握 ' + stu.todayRate + '%', tone: 'green' };
        }
        return stu;
      });
      self.setData({ students: students, stuError: '' });
    }).catch(function (err) {
      self.setData({ stuError: cloud.humanError(err) });
      console.warn('[class] students 加载失败', err);
    });

    self.loadBriefSubs();
  },

  /** 每日简报订阅状态：决定每个学员卡上的开关长什么样 */
  loadBriefSubs: function () {
    var self = this;
    cloud.api.briefSubs().then(function (r) {
      var map = {};
      (r.subs || []).forEach(function (s) { map[s.student_id] = true; });
      var ids = Object.keys(map);
      // 单独给一个数字：wxml 里跑 Object.keys 不一定可靠，别让界面表达式决定能不能看见按钮
      var note = r.template_ready
        ? ''
        : '（服务端还没配置订阅模板，暂时只能在这里看简报）';
      if (r.collections_ready === false) {
        // 集合没建时服务端会给 collections_ready:false —— 这时候按钮点了也是白点，
        // 与其让人反复试，不如把"要去控制台建 brief_subs 集合"直接写在页面上
        note = '（云端还没建 brief_subs 集合，订阅暂时不会生效）';
      }
      self.setData({
        briefSubs: map,
        briefCount: ids.length,
        briefReady: !!(r.template_ready && r.collections_ready !== false),
        briefNote: note
      });
    }).catch(function (err) {
      console.warn('[class] 简报订阅状态加载失败：', (err && (err.errMsg || err.message)) || err);
    });
  },

  /**
   * 订阅 / 退订某个孩子的每日简报。
   * 顺序不能反：必须先让用户勾授权，再记账 —— 微信只认"用户主动同意"的那一次。
   */
  toggleBrief: function (e) {
    var id = e.currentTarget.dataset.id;
    var subscribed = !!this.data.briefSubs[id];
    var self = this;

    // toast 一屏最多十来个字，服务端那句"要去控制台新建集合"会被截成半句话 ——
    // 与其让人读半句，不如在前端把常见原因压成短文案说清楚。
    var failToast = function (err) {
      var short = {
        NO_TEMPLATE: '还没开通推送（缺模板 ID）',
        NO_COLLECTION: '云端缺 brief_subs 集合',
        FORBIDDEN: '只能订阅本班学员',
        NOT_COACH: '只有创建者能订阅'
      }[(err && err.code) || ''];
      wx.showToast({ title: short || cloud.humanError(err), icon: 'none' });
    };

    var done = function (subscribedNow) {
      var upd = {};
      upd['briefSubs.' + id] = subscribedNow;
      upd.briefCount = countSubs(self.data.briefSubs, id, subscribedNow);
      self.setData(upd);
      wx.showToast({
        title: subscribedNow ? '已订阅，每天 20:30 发' : '已退订',
        icon: 'none'
      });
    };

    if (subscribed) {
      cloud.api.subscribeBrief(id, true).then(function () { done(false); })
        .catch(failToast);
      return;
    }
    cloud.requestSubscribe().then(function () {
      return cloud.api.subscribeBrief(id, false);
    }).then(function () { done(true); })
      .catch(failToast);
  },

  /** 立刻发一次今天的简报（不用等到晚上） */
  pushBriefNow: function () {
    var self = this;
    wx.showLoading({ title: '发送中…' });
    cloud.api.sendBriefs().then(function (r) {
      wx.hideLoading();
      wx.showToast({
        title: r && r.skipped ? '还没开通推送（缺模板 ID）'
          : ('已发出 ' + ((r && r.sent) || 0) + ' 条'),
        icon: 'none'
      });
    }).catch(function (err) {
      wx.hideLoading();
      wx.showToast({ title: cloud.humanError(err), icon: 'none' });
    });
  },

  startCreate: function () {
    var self = this;
    wx.showModal({
      title: '给班级起个名字',
      editable: true,
      placeholderText: '如：三年二班 / 我家娃的单词营',
      success: function (res) {
        if (!res.confirm) return;
        var name = (res.content || '').trim();
        if (!name) {
          wx.showToast({ title: '名字不能为空', icon: 'none' });
          return;
        }
        // 幂等 ID 落本地存储：网络重试/页面重进都不会建出第二个班
        var reqId = wx.getStorageSync(CREATE_KEY);
        if (!reqId) {
          reqId = CREATE_ID_PREFIX + srs.newReqId();
          wx.setStorageSync(CREATE_KEY, reqId);
        }
        wx.showLoading({ title: '创建中…' });
        cloud.api.createClass(name, reqId).then(function (r) {
          wx.hideLoading();
          self.setData({ cls: r.class, my: { role: 'coach' } });
          self.loadCoachData();
          wx.showToast({ title: '建好了，把邀请码发给孩子', icon: 'none', duration: 2500 });
        }).catch(function (err) {
          wx.hideLoading();
          wx.showToast({ title: cloud.humanError(err), icon: 'none' });
        });
      }
    });
  },

  /**
   * 教材单元选择器（只在教练端用得到，进页面时构建一次）。
   * 词数与单元名都来自本地目录树（data/booktree.js），不需要联网 ——
   * 老师在教室里网络很差时也得能布置。
   */
  ensureUnits: function () {
    if (this.data.volumes.length) return;
    var vs = books.volumes();
    if (!vs.length) return;
    var names = [];
    var vals = [];
    vs.forEach(function (v) {
      var total = v.units.reduce(function (s, u) { return s + u.count; }, 0);
      // 只有一个版本 + 一册时不必显示冗长前缀，直接给"整册 / Unit N"
      names.push(v.name + ' 整册（' + total + ' 词）');
      vals.push({ volume: v.key, unit: 0, count: total });
      v.units.forEach(function (u) {
        names.push('Unit ' + u.no + (u.name ? ' ' + u.name : '') + '（' + u.count + ' 词）');
        vals.push({ volume: v.key, unit: u.no, count: u.count });
      });
    });
    this.setData({
      volumes: vs,
      unitNames: names,
      unitVals: vals,
      'form.volume': vs[0].key
    });
  },

  pickScope: function (e) {
    var scope = e.currentTarget.dataset.scope;
    this.setData({ 'form.scope': scope });
    if (scope === 'unit') {
      this.ensureUnits();
      this.clampCountToUnit();
      this.syncUnitMeta();
    } else {
      // 回到按词库：上限回到老规则（30），起点无意义重置 ——
      // 两个模式各记各的状态，切回来时别带着上一次的残留
      this.setData({ 'form.start': 1, countMax: 30, continueFrom: 0 });
    }
    this.rebuildPreview();
  },

  pickUnit: function (e) {
    var idx = Number(e.detail.value) || 0;
    var opt = this.data.unitVals[idx];
    if (!opt) return;
    var upd = {
      'form.unitIndex': idx,
      'form.unit': opt.unit,
      'form.volume': opt.volume,
      // 换单元 = 换了一_pool 词，起点回到开头（续接按钮会提示可以从哪继续）
      'form.start': 1
    };
    // 词数不能超过该单元的词数：否则布置界面说 10 个、实际只给 8 个，
    // 又是"两个数字互相打架"（这类问题的修复成本远高于提前夹住）
    var max = opt.count || 0;
    if (max && this.data.form.count > max) upd['form.count'] = max;
    this.setData(upd);
    this.syncUnitMeta();
    this.rebuildPreview();
  },

  /** 重算当前单元的两个滑杆上限与"接着上次"提示（unit 模式专用，切范围/换单元/作业列表刷新后都要跑） */
  syncUnitMeta: function () {
    var f = this.data.form;
    var opt = this.data.unitVals[f.unitIndex];
    var total = (opt && opt.count) || 0;
    var upd = { unitTotal: total };
    // 词数上限 = 从起点到单元末尾还剩多少个 —— 42 个词的单元不再被写死的 30 卡住
    upd.countMax = f.scope === 'unit' && total ? Math.max(3, total - f.start + 1) : 30;
    upd.continueFrom = this.computeContinueFrom();
    this.setData(upd);
    this.refreshPlanPerDay();
  },

  /**
   * 这个单元已经布置到第几个词了？（unit 模式的"接着上次布置"数据源）
   * 拿该班所有同单元作业的词单，跟课本词序对齐，取最靠后的一个的位置。
   * word_id 可能有前后空格（老数据），两边都 trim+lower 再比 —— 比错一个字母就是"明明布置过却说没布置"。
   */
  computeContinueFrom: function () {
    var f = this.data.form;
    if (f.scope !== 'unit' || !f.volume || !f.unit) return 0;
    var unitWords = (books.getWordsByUnit(f.volume, f.unit) || [])
      .map(function (w) { return String(w.word || '').trim().toLowerCase(); });
    if (!unitWords.length) return 0;
    var assigned = {};
    (this.data.assignments || []).forEach(function (a) {
      if (Number(a.unit) !== f.unit || a.volume !== f.volume) return;
      (a.word_ids || []).forEach(function (w) {
        assigned[String(w || '').trim().toLowerCase()] = true;
      });
    });
    var last = 0;
    unitWords.forEach(function (w, i) {
      if (assigned[w]) last = Math.max(last, i + 1);
    });
    return last ? last + 1 : 0;   // 下一个该布置的词的序号（1-based）；一个都没布置过返回 0
  },

  /** 一键续接：起点挪到"上次布置的下一个词"，词数沿用当前设置（默认还是 10 个） */
  continueFromLast: function () {
    var n = this.data.continueFrom;
    if (!n) return;
    var upd = { 'form.start': n };
    var total = this.data.unitTotal;
    var left = total ? total - n + 1 : 0;
    if (left && this.data.form.count > left) upd['form.count'] = left;
    upd.countMax = total ? Math.max(3, total - n + 1) : 30;
    this.setData(upd);
    this.rebuildPreview();
    wx.showToast({ title: '从第 ' + n + ' 个词接着布置', icon: 'none' });
  },

  /** 自动布置开关：只按单元可用（tag 池没有"课本序"，谈不上下一天） */
  togglePlan: function (e) {
    this.setData({ 'form.planOn': !!e.detail.value });
  },

  pickPlanDays: function (e) {
    this.setData({ 'form.planDays': Number(e.detail.value) + 2 });
    this.refreshPlanPerDay();
  },

  /** 每天多少个词：向上均分（42 词 4 天 → 11/11/10/10），与云端同一算法。
   *  放在 data 里而不是方法 —— WXML 调不了方法，只能读字段。 */
  refreshPlanPerDay: function () {
    var f = this.data.form;
    var total = this.data.unitTotal || 0;
    var left = total ? total - f.start + 1 : 0;
    this.setData({
      planPerDay: left ? Math.max(1, Math.ceil(left / (f.planDays || 2))) : 0
    });
  },

  stopPlan: function (e) {
    var id = e.currentTarget.dataset.id;
    var self = this;
    wx.showModal({
      title: '停止自动布置？',
      content: '已经发出去的作业会保留，只是不再往后自动发。',
      confirmText: '停止',
      success: function (r) {
        if (!r.confirm) return;
        cloud.api.stopPlan(id).then(function () {
          wx.showToast({ title: '已停止', icon: 'none' });
          self.loadCoachData();
        }).catch(function (err) {
          wx.showToast({ title: cloud.humanError(err), icon: 'none' });
        });
      }
    });
  },

  pickStart: function (e) {
    var start = Number(e.detail.value) || 1;
    var upd = { 'form.start': start };
    var total = this.data.unitTotal;
    var left = total ? total - start + 1 : 0;
    // 起点往后挪，剩余词数变少：词数必须跟着夹住，否则预览只有 5 个词、滑杆却显示 10
    if (left && this.data.form.count > left) upd['form.count'] = left;
    upd.countMax = total ? Math.max(3, left) : 30;
    this.setData(upd);
    this.refreshPlanPerDay();
    this.rebuildPreview();
  },

  clampCountToUnit: function () {
    var f = this.data.form;
    var opt = this.data.unitVals[f.unitIndex];
    if (!opt) return;
    if (opt.count && f.count > opt.count) this.setData({ 'form.count': opt.count });
  },

  pickTag: function (e) {
    this.setData({ 'form.tag': e.currentTarget.dataset.tag });
    this.rebuildPreview();
  },

  pickCount: function (e) {
    this.setData({ 'form.count': e.detail.value });
    this.rebuildPreview();   // 改数量 = 重新取词，编辑过的词单会被重建（预览区有小字说明）
  },

  /* ---------------------------------------------------------------- */
  /* 布置预览 + 编辑：删词 / 搜索加词（2026-10-09 反馈）                     */
  /* ---------------------------------------------------------------- */

  /** 按当前范围生成预览词单 —— 取词口径必须与服务端 chooseWords 完全一致：
   *  unit 模式按 unit_order（课本序），从第 start 个起取 count 个（起点滑杆，2026-10-11 反馈）；
   *  tag 模式按 freq 升序。本地词库与云端同源。 */
  rebuildPreview: function () {
    var f = this.data.form;
    var list;
    if (f.scope === 'unit') {
      var start = Math.max(1, Number(f.start) || 1);
      list = (books.getWordsByUnit(f.volume, f.unit) || [])
        .slice(start - 1, start - 1 + f.count).map(function (w) { return w.word; });
    } else {
      var pool = f.tag === '全部' ? WORDS : WORDS.filter(function (w) {
        return (w.tags || []).indexOf(f.tag) >= 0;
      });
      list = pool.slice().sort(function (a, b) { return a.freq - b.freq; })
        .slice(0, f.count).map(function (w) { return w.word; });
    }
    this.setData({ preview: list, previewEdited: false, searchKw: '', searchHits: [] });
  },

  removeWord: function (e) {
    var idx = e.currentTarget.dataset.idx;
    var list = this.data.preview.slice();
    list.splice(idx, 1);
    this.setData({ preview: list, previewEdited: true });
  },

  onSearchInput: function (e) {
    var kw = (e.detail.value || '').trim().toLowerCase();
    if (!kw) {
      this.setData({ searchKw: e.detail.value, searchHits: [] });
      return;
    }
    var inPreview = {};
    this.data.preview.forEach(function (w) { inPreview[w.toLowerCase()] = true; });
    var hits = [];
    for (var i = 0; i < WORDS.length && hits.length < 20; i++) {
      var w = WORDS[i];
      if (w.word.toLowerCase().indexOf(kw) >= 0 && !inPreview[w.word.toLowerCase()]) {
        hits.push(w.word);
      }
    }
    this.setData({ searchKw: e.detail.value, searchHits: hits });
  },

  addWord: function (e) {
    var word = e.currentTarget.dataset.word;
    if (!word) return;
    if (this.data.preview.indexOf(word) >= 0) {
      wx.showToast({ title: '已在词单里', icon: 'none' });
      return;
    }
    // 60 的来源：最大的单元 42 词 + 搜索补词的空间。旧的 30 是拍脑袋写的，
    // 结果 42 个词的单元后 12 个只能靠搜索一个个加（2026-10-11 反馈）
    if (this.data.preview.length >= 60) {
      wx.showToast({ title: '最多 60 个词', icon: 'none' });
      return;
    }
    var list = this.data.preview.concat([word]);
    this.setData({ preview: list, previewEdited: true, searchKw: '', searchHits: [] });
  },

  pickDeadline: function (e) {
    this.setData({ 'form.deadline': e.detail.value });
  },

  clearDeadline: function () {
    this.setData({ 'form.deadline': '' });
  },

  inputNote: function (e) {
    this.setData({ 'form.note': e.detail.value });
  },

  /** 个性化开关：勾上后每个孩子的词单按各自程度裁剪（易错优先、已掌握跳过） */
  togglePersonal: function (e) {
    this.setData({ 'form.personalized': !!e.detail.value });
  },

  submitAssign: function () {
    var self = this;
    var f = this.data.form;
    if (this.data.assigning) return;
    this.setData({ assigning: true });

    // 自动布置：一次设定，剩下的交给每天早上 8 点的定时器（第一天当场发出）
    if (f.scope === 'unit' && f.planOn) {
      cloud.api.createPlan({
        volume: f.volume,
        unit: f.unit,
        start: f.start,
        days: f.planDays,
        personalized: !!f.personalized,
        clientReqId: 'plan:' + srs.newReqId()
      }).then(function (r) {
        self.setData({ assigning: false, 'form.note': '' });
        var p = (r && r.data && r.data.plan) || {};
        wx.showToast({
          title: '已布置第 1 天 · 剩下 ' + (p.left || 0) + ' 天每天早 8 点自动发',
          icon: 'success',
          duration: 3000
        });
        self.loadCoachData();
      }).catch(function (err) {
        self.setData({ assigning: false });
        wx.showToast({ title: cloud.humanError(err), icon: 'none' });
      });
      return;
    }

    // 按词库 / 按教材单元，两条路的参数集不同：别把 unit 塞给只认 tag 的老链路，
    // 也别让按单元布置时多带一个会被无视的 tag（服务端会忽略，但看着像 bug）
    var payload = {
      count: f.count,
      deadline: f.deadline,
      note: f.note,
      personalized: !!f.personalized,
      clientReqId: 'assign:' + srs.newReqId()
    };
    if (f.scope === 'unit') {
      payload.volume = f.volume;
      payload.unit = f.unit;
    } else {
      payload.tag = f.tag;
    }
    // 预览词单整份上交：所见即所得。本地词库与云端同源，预览里看到的
    // 就是孩子练到的；服务端对配不上的词会如实回报 missing，不静默丢。
    var preview = this.data.preview || [];
    if (preview.length) {
      payload.words = preview;
      payload.count = preview.length;   // 编辑过删/加后，数量以词单为准
    }

    cloud.api.assignTask(payload).then(function (r) {
      self.setData({ assigning: false, 'form.note': '' });
      var n = (r && r.data && r.data.personalized) ? (r.data.student_count || 0) : 0;
      var asg = (r && r.data && r.data.assignment) || {};
      var real = asg.count && asg.count !== payload.count
        ? ' · 实际 ' + asg.count + ' 词' : '';
      // 预览里有词配不上云端词库：如实提示（正常情况不会发生，发生了说明两边词库不同步）
      var missing = (r && r.data && r.data.missing) || [];
      if (missing.length) {
        wx.showToast({ title: '已布置，' + missing.length + ' 个词不在词库：' + missing[0], icon: 'none', duration: 3000 });
      } else {
        wx.showToast({
          title: n ? ('已布置 · ' + n + ' 人各自词单')
            : ('已布置' + (asg.unit ? ' · Unit ' + asg.unit : '') + real),
          icon: 'success'
        });
      }
      self.loadCoachData();
    }).catch(function (err) {
      self.setData({ assigning: false });
      wx.showToast({ title: cloud.humanError(err), icon: 'none' });
    });
  },

  makeNudge: function (e) {
    var id = e.currentTarget.dataset.id;
    var self = this;
    wx.showLoading({ title: '同步数据中…' });
    // 点击即刷新：学员卡和催学文案必须基于同一份最新数据。
    // 否则会出现"卡片还是旧数字、文案却是刚生成的"这种自相矛盾
    this.loadCoachData();
    cloud.api.nudgeText(id).then(function (r) {
      wx.hideLoading();
      privacy.copy(r.text, function () {
        wx.showModal({
          title: '已复制，去微信发给孩子吧',
          content: r.text,
          showCancel: false,
          confirmText: '知道了'
        });
      });
    }).catch(function (err) {
      wx.hideLoading();
      wx.showToast({ title: cloud.humanError(err), icon: 'none' });
    });
  },

  /**
   * 学员进度报告：点学员卡展开/收起。首次展开（或数据超过 5 分钟）时
   * 拉取该学员的作业完成度 + 最近学习记录（单词文本已在服务端翻译好）。
   */
  /**
   * 打开学员报告（独立页，2026-10-10）。
   * 之前是点卡片在这里内联展开：内容越加越长，学员一多整页就乱，
   * 而且内联区没法打印、也没法导出成能分享的图 —— 独立页才谈得上这些。
   */
  openReport: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/report/report?sid=' + id });
  },

  copyCode: function () {
    var code = this.data.cls && this.data.cls.code;
    if (!code) return;
    // 不只复制光秃秃的码：带上打开链接和用法，对方收到就知道怎么用。
    // #小程序:// 文本粘贴到微信聊天会自动变成可点链接（但带不了参数，
    // 所以邀请码还是要手输 —— 文案里把这一步说清楚）
    var name = (this.data.cls && this.data.cls.name) || '我的班级';
    var text = '【' + name + '】邀请码：' + code +
      '\n点这里打开小程序 👉 #小程序://功课抽查/ ，在「班级」页输入邀请码就能加入';
    privacy.copy(text, function () { wx.showToast({ title: '邀请文案已复制', icon: 'success' }); });
  },

  /**
   * 分享班级卡：把邀请码放进转发卡片。
   * 为什么标题要带码：家长/老师本来就要把这张卡发给另一个微信号（自己的微信或孩子），
   * 对方点开就得能直接加班，不然还要再回来复制一次。
   */
  onShareAppMessage: function () {
    var cls = this.data.cls || {};
    var code = cls.code || '';
    // 文案带行动指令：对方看到就知道「要做什么」（输入邀请码加班），不只是个名字
    return {
      title: code
        ? ('邀你加入【' + (cls.name || '我的班级') + '】 · 邀请码 ' + code)
        : '功课抽查 · 输入邀请码加入班级',
      path: '/pages/class/class',
      imageUrl: ''
    };
  },

  /* ---------------- 学生端 ---------------- */

  startJoin: function () {
    var self = this;
    wx.showModal({
      title: '输入邀请码',
      editable: true,
      placeholderText: '6 位字母数字',
      success: function (res) {
        if (!res.confirm) return;
        var code = (res.content || '').trim().toUpperCase();
        if (!code) return;
        cloud.api.joinClass(code).then(function (r) {
          self.setData({ cls: r.class, my: { role: 'student' } });
          self.loadStudentData();
          wx.showToast({ title: '加入成功', icon: 'success' });
        }).catch(function (err) {
          wx.showToast({ title: cloud.humanError(err), icon: 'none' });
        });
      }
    });
  },

  loadStudentData: function () {
    var self = this;
    cloud.api.myAssignments().then(function (r) {
      self.setData({
        myAssignments: r.assignments || [],
        myAssignError: '',
        emptyHint: r.hint || ''
      });
    }).catch(function (err) {
      // 不静默：学生"看不到作业"曾因这里吞错而无法排查
      self.setData({ myAssignError: cloud.humanError(err) });
      console.warn('[class] myAssignments 加载失败', err);
    });
  },

  /** 去做作业：暂跳学习页（词级联动待批次 2，先保证闭环能跑） */
  /** 去做这份作业：把作业词单带给学习页，按"没学过的优先"续学，而不是从头再来 */
  goStudyAssignment: function (e) {
    var idx = e.currentTarget.dataset.idx;
    var a = (this.data.myAssignments || [])[idx] || {};
    var ids = (a.word_ids || []).join(',');
    if (!ids) {
      // 旧版服务端不下发词单：退回普通学习页，至少有得学
      wx.redirectTo({ url: '/pkg-media/pages/drill/drill' });
      return;
    }
    var name = a.name || a.note || (a.tag ? a.tag + '作业' : '班级作业');
    wx.redirectTo({
      url: '/pkg-media/pages/drill/drill?ids=' + assignParam.buildIdsParam(a.word_ids || []) +
        '&name=' + encodeURIComponent(name)
    });
  },

  /** 试做这份作业（教练端）：2026-10-09 实锤 —— 老师布置完 Unit 2 想亲自点开
   * 看看词对不对，却没有入口；从首页"开始学习"进去走的是个人今日任务，
   * 练到的还是旧词库的词，让人以为作业错了。试做走的就是学生同一条
   * drill?ids= 路径，练的正是这份作业的词单（学习记录照常上报，不污染
   * 班级进度：进度统计只算班级学员）。 */
  goTryAssignment: function (e) {
    var idx = e.currentTarget.dataset.idx;
    var a = (this.data.assignments || [])[idx] || {};
    var ids = a.word_ids || [];
    if (!ids.length) {
      wx.showToast({ title: '这份作业没有词单', icon: 'none' });
      return;
    }
    var name = (a.name || a.note || (a.tag ? a.tag + '作业' : '班级作业')) + ' · 试做';
    wx.navigateTo({
      url: '/pkg-media/pages/drill/drill?ids=' + assignParam.buildIdsParam(ids) +
        '&name=' + encodeURIComponent(name)
    });
  },

  /** 历史数据修复：v2 写入器事故期间的学习明细都在日志里，一键无损找回 */
  runRepair: function () {
    var self = this;
    this.setData({ diagnoseText: '修复中…（从学习日志回填状态记录）' });
    cloud.api.repairHistory().then(function (r) {
      var lines = [
        '✅ 回填完成',
        '扫描日志 ' + (r.scannedLogs || 0) + ' 条 · 涉及 ' + (r.distinctPairs || 0) + ' 个词',
        '新建状态 ' + (r.created || 0) + ' 条 · 更新 ' + (r.updated || 0) + ' 条'
      ];
      var lu = r.learnedByUser || {};
      Object.keys(lu).forEach(function (uid) {
        lines.push('  ' + uid.slice(-6) + ': 现有 ' + lu[uid] + ' 词');
      });
      if (r.writeFails && r.writeFails.length) {
        lines.push('⚠ 写入失败 ' + r.writeFails.length + ' 条: ' + r.writeFails.join(', '));
      }
      lines.push('建议：回到首页/班级页下拉刷新，再看作业进度');
      self.setData({ diagnoseText: lines.join('\n') });
    }).catch(function (err) {
      self.setData({ diagnoseText: '修复失败：' + ((err && (err.errMsg || err.message)) || err) });
    });
  },

  /** 云自检：把"云函数活着吗 / 库里有数据吗"直接摊在页面上，不靠猜 */
  runDiagnose: function () {
    var self = this;
    this.setData({ diagnoseText: '自检中…' });
    cloud.api.diagnose(true).then(function (r) {
      // 新版：云函数把"同一瞬间的全库快照"拼成文本行，端上只负责展示。
      // 好处：状态表/日志/用户/班级四路查询在服务端一次拉齐，
      // 不会再出现"学员卡一个数、自检另一个数"的时间差假矛盾。
      if (r.lines && r.lines.length) {
        var head = ['云函数版本 ' + (r.version || '未带版本戳（旧代码）')];
        self.setData({ diagnoseText: head.concat(r.lines).join('\n') });
        return;
      }
      // 旧版云函数兜底：没有 lines 字段时按老格式渲染
      var lines = [
        '状态记录 ' + r.stateTotal + ' 条 / 覆盖 ' + r.usersWithState + ' 人',
        '脏记录 ' + r.dirty + ' 条 · 学习日志 ' + r.reviewLogTotal + ' 条'
      ];
      // 作业诊断：0/10 的原因直接摊开（词单格式 / 学员命中数）
      (r.assignments || []).forEach(function (a) {
        lines.push('── 作业《' + a.name + '》' + a.count + ' 词');
        if (a.idHits > 0) {
          lines.push('  ⚠ 仍是旧 _id 格式（命中 ' + a.idHits + ' 个），依赖云端自动翻译');
        }
        lines.push('  词单: ' + (a.normHead || []).join(', ') + ((a.count > 6) ? ' …' : ''));
        if (!(a.perStudent || []).length) {
          lines.push('  学员: 没有任何学习记录同步到云端');
        } else {
          (a.perStudent || []).forEach(function (p) {
            lines.push('  ' + p.who + ': 命中 ' + p.learned + '/' + a.count +
              '（学的词如: ' + (p.sample || []).join(',') + '）');
          });
        }
      });
      lines.push(r.hint || '');
      self.setData({ diagnoseText: lines.join('\n') });
    }).catch(function (err) {
      self.setData({ diagnoseText: '自检失败：' + ((err && (err.errMsg || err.message)) || err) });
    });
  },

  /** 学生退出班级（换班用） */
  leaveConfirm: function () {
    var self = this;
    wx.showModal({
      title: '退出班级？',
      content: '退出后需要重新输入邀请码才能再加入。',
      success: function (res) {
        if (!res.confirm) return;
        cloud.api.leaveClass().then(function () {
          self.setData({ cls: null, my: {}, myAssignments: [] });
        }).catch(function (err) {
          wx.showToast({ title: cloud.humanError(err), icon: 'none' });
        });
      }
    });
  }
});

/** 订阅数：把改动后的地图算一遍，避免界面表达式里再依赖 Object.keys */
function countSubs(map, id, subscribed) {
  var n = 0;
  Object.keys(map || {}).forEach(function (k) {
    if (k === id) { if (subscribed) n++; return; }
    if (map[k]) n++;
  });
  if (!map || !(id in map)) return subscribed ? n + 1 : n;
  return n;
}

function fmtAgo(ms) {
  if (ms < 60000) return '1 分钟内活跃';  if (ms < 3600000) return Math.floor(ms / 60000) + ' 分钟前活跃';
  if (ms < 86400000) return Math.floor(ms / 3600000) + ' 小时前活跃';
  return Math.floor(ms / 86400000) + ' 天前活跃';
}

