/**
 * 班级页 —— 家长/老师端与学生端共用的一个页面，按身份渲染三态：
 *   未加入 → 二选一入口（建班 / 输邀请码）
 *   coach  → 班级卡（邀请码复制）+ 布置任务表单 + 作业进度 + 学员列表 + 催学文案
 *   student→ 班级名 + 作业列表（逐词进度）+ 去做作业
 *
 * 数据一律来自 class 云函数（utils/cloud.js 的 api.* 薄封装）；
 * 云失败时整页降级为提示 + 重试，绝不影响本地学习功能。
 */

var cloud = require('../../utils/cloud');
var srs = require('../../utils/srs');
var time = require('../../utils/time');

var TAGS = ['全部', '中考', '高考', '四级'];
var CREATE_KEY = 'class_create_reqid';   // 建班幂等 ID 持久化：重进页面不产生第二个班
var CREATE_ID_PREFIX = 'class-create:';

Page({
  data: {
    loading: true,
    cloudError: '',

    my: {},                 // { role: ''|'coach'|'student' }
    cls: null,              // { id, name, code }

    // 教练端
    tags: TAGS,
    form: { tag: '全部', count: 10, deadline: '', note: '' },
    assigning: false,
    assignments: [],
    students: [],
    /** 数据加载失败时显示在对应卡片里的错误（绝不静默吞错：吞了就无法排查） */
    assignError: '',
    stuError: '',
    /** 学员进度报告：{ [studentId]: {loading, error, assignments, recent_logs} } */
    reports: {},

    // 学生端
    myAssignments: [],
    myAssignError: '',
    /** 空列表时的服务端诊断提示（如 TEACHER_HAS_OTHER_CLASS：老师布置过作业但不在这个班） */
    emptyHint: '',

    today: ''
  },

  onShow: function () {
    this.setData({ today: time.getLocalDate(Date.now()) });
    this.reload();
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
      self.setData({ loading: false, cloudError: cloud.humanError(err) });
      // 整页失败的现场必须留日志，否则"网络异常"四个字无从排查
      console.warn('[class] myClass 加载失败', (err && (err.errMsg || err.message)) || err);
    });
  },

  /* ---------------- 教练端 ---------------- */

  loadCoachData: function () {
    var self = this;
    cloud.api.coachAssignments().then(function (r) {
      self.setData({ assignments: r.assignments || [], assignError: '' });
    }).catch(function (err) {
      // 不静默：加载失败必须让教练看到原因，否则"布置了却看不到"无从排查
      self.setData({ assignError: cloud.humanError(err) });
      console.warn('[class] assignments 加载失败', err);
    });

    cloud.api.coachStudents().then(function (r) {
      var now = Date.now();
      var students = (r.students || []).map(function (s) {
        return Object.assign({}, s, {
          lastSeenText: s.last_seen_at ? fmtAgo(now - s.last_seen_at) : '还没来过'
        });
      });
      self.setData({ students: students, stuError: '' });
    }).catch(function (err) {
      self.setData({ stuError: cloud.humanError(err) });
      console.warn('[class] students 加载失败', err);
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

  pickTag: function (e) {
    this.setData({ 'form.tag': e.currentTarget.dataset.tag });
  },

  pickCount: function (e) {
    this.setData({ 'form.count': e.detail.value });
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

  submitAssign: function () {
    var self = this;
    var f = this.data.form;
    if (this.data.assigning) return;
    this.setData({ assigning: true });

    cloud.api.assignTask({
      tag: f.tag,
      count: f.count,
      deadline: f.deadline,
      note: f.note,
      clientReqId: 'assign:' + srs.newReqId()
    }).then(function () {
      self.setData({ assigning: false, 'form.note': '' });
      wx.showToast({ title: '已布置', icon: 'success' });
      self.loadCoachData();
    }).catch(function (err) {
      self.setData({ assigning: false });
      wx.showToast({ title: cloud.humanError(err), icon: 'none' });
    });
  },

  makeNudge: function (e) {
    var id = e.currentTarget.dataset.id;
    var self = this;
    wx.showLoading({ title: '生成中…' });
    cloud.api.nudgeText(id).then(function (r) {
      wx.hideLoading();
      wx.setClipboardData({
        data: r.text,
        success: function () {
          wx.showModal({
            title: '已复制，去微信发给孩子吧',
            content: r.text,
            showCancel: false,
            confirmText: '知道了'
          });
        }
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
  toggleReport: function (e) {
    var id = e.currentTarget.dataset.id;
    var cur = this.data.reports[id];
    var self = this;

    if (cur && !cur.loading) {
      if (cur.open) {
        var closeUpd = {};
        closeUpd['reports.' + id + '.open'] = false;
        this.setData(closeUpd);
        return;
      }
      var fresh = cur.at && (Date.now() - cur.at < 5 * 60000);
      var openUpd = {};
      openUpd['reports.' + id + '.open'] = true;
      this.setData(openUpd);
      if (fresh && !cur.error) return;   // 数据还新鲜，直接展示
    }

    var loadUpd = {};
    loadUpd['reports.' + id + '.loading'] = true;
    loadUpd['reports.' + id + '.open'] = true;
    loadUpd['reports.' + id + '.error'] = '';
    this.setData(loadUpd);
    cloud.api.studentDetail(id).then(function (r) {
      var logs = (r.recent_logs || []).slice(0, 10).map(function (l) {
        return Object.assign({}, l, {
          timeText: l.created_at ? fmtTime(l.created_at) : '',
          ok: l.feedback === 'known'
        });
      });
      var upd = {};
      upd['reports.' + id] = {
        open: true, loading: false, error: '', at: Date.now(),
        nickname: (r.student && r.student.nickname) || '',
        assignments: r.assignments || [],
        logs: logs
      };
      self.setData(upd);
    }).catch(function (err) {
      var upd = {};
      upd['reports.' + id] = {
        open: true, loading: false, error: cloud.humanError(err), at: Date.now(),
        assignments: [], logs: []
      };
      self.setData(upd);
      console.warn('[class] 学员报告加载失败', err);
    });
  },

  copyCode: function () {
    var code = this.data.cls && this.data.cls.code;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: function () { wx.showToast({ title: '邀请码已复制', icon: 'success' }); }
    });
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
  goStudyAssignment: function () {
    wx.redirectTo({ url: '/pages/study/study' });
  },

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

function fmtAgo(ms) {
  if (ms < 60000) return '1 分钟内活跃';
  if (ms < 3600000) return Math.floor(ms / 60000) + ' 分钟前活跃';
  if (ms < 86400000) return Math.floor(ms / 3600000) + ' 小时前活跃';
  return Math.floor(ms / 86400000) + ' 天前活跃';
}

/** 报告里的记录时间：今天显示时分，更早显示月-日 时分 */
function fmtTime(ts) {
  var d = new Date(ts);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  var today = time.getLocalDate(Date.now());
  if (time.getLocalDate(ts) === today) return hm;
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
}
