/**
 * 云开发调用层
 *
 * 约定：页面与组件不得直接调用 wx.cloud.callFunction，一律走这里。
 * 理由有二：
 *   1) 将来若从云开发迁移到自建后端，只需要重写这一个文件；
 *   2) 统一处理"云函数返回 { ok:false }"这种业务失败，避免每个页面各写一套判断。
 */

/** 云环境 ID —— 部署前必须改成你自己的环境 ID（不要提交到公开仓库） */
var ENV_ID = 'cloud1-d0gmmv8o9df84265e';

var initialized = false;
var initError = null;

/** 小程序启动时调用一次 */
function initCloud() {
  if (initialized) return true;
  try {
    if (!wx.cloud) {
      initError = '当前基础库不支持云开发，请在开发者工具中把调试基础库调到 2.2.3 以上';
      return false;
    }
    wx.cloud.init({ env: ENV_ID, traceUser: true });
    initialized = true;
    return true;
  } catch (e) {
    initError = (e && e.message) ? e.message : String(e);
    return false;
  }
}

function getInitError() {
  return initError;
}

/**
 * 调用云函数
 * @param {string} name 云函数名，如 'task'
 * @param {string} action 动作名，如 'today'
 * @param {object} payload 业务参数
 * @returns {Promise<object>} resolve 业务 data；reject 一个带 code/message 的 Error
 */
function call(name, action, payload) {
  if (!initCloud()) {
    return Promise.reject(makeError('CLOUD_NOT_INIT', initError || '云开发未初始化'));
  }
  if (ENV_ID === 'REPLACE_WITH_YOUR_ENV_ID') {
    return Promise.reject(makeError('ENV_NOT_SET',
      '请先在 miniprogram/utils/cloud.js 里把 ENV_ID 改成你的云环境 ID'));
  }

  return new Promise(function (resolve, reject) {
    wx.cloud.callFunction({
      name: name,
      data: Object.assign({ action: action }, payload || {}),
      success: function (res) {
        var r = res && res.result;
        if (!r) return reject(makeError('EMPTY_RESULT', '云函数没有返回内容'));
        if (r.ok === false) return reject(makeError(r.code || 'BIZ_FAIL', r.message || '操作失败'));
        resolve(r.data);
      },
      fail: function (err) {
        // 这里最常见的原因：云函数未部署、函数名拼错、环境 ID 不对
        reject(makeError('CALL_FAIL', (err && err.errMsg) ? err.errMsg : '网络异常，请重试'));
      }
    });
  });
}

function makeError(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

/** 把错误转成可直接给用户看toast的一句话 */
function humanError(err) {
  if (!err) return '未知错误';
  if (err.code === 'ENV_NOT_SET' || err.code === 'CLOUD_NOT_INIT') return err.message;
  if (err.code === 'CALL_FAIL') {
    if (String(err.message).indexOf('cannot find') >= 0) return '云函数未部署，请先上传部署';
    if (String(err.message).indexOf('timeout') >= 0) return '网络超时，请重试';
    return '网络异常，请重试';
  }
  return err.message || '操作失败';
}

/* ---------------- 业务接口（薄封装，页面只认这些方法名） ---------------- */

var api = {
  /** 登录 / 首次调用自动建用户 */
  login: function () {
    return call('user', 'login', {});
  },

  /** 取今日任务（幂等：同一天多次调用返回同一快照） */
  todayTask: function (date) {
    return call('task', 'today', { date: date });
  },

  /** 提交一次复习反馈（必须带幂等 ID） */
  submitReview: function (params) {
    return call('review', 'submit', params);
  },

  /** 取今日到期词（学习卡队列来源） */
  dueList: function (limit) {
    return call('review', 'due', { limit: limit });
  },

  /**
   * 出题（返回的题目**不含答案**）
   * @param {{count?:number}} params
   * @returns {Promise<{questions:Array}>}
   */
  generateQuiz: function (params) {
    return call('quiz', 'generate', params);
  },

  /**
   * 交卷判分
   * @param {{answers:Array<{wordId:string,type:string,answer:string|string[]}>, clientReqId:string, durationMs?:number}} params
   *        answer：选义题为选中的释义字符串；拼写/听写题为输入的字符数组
   */
  submitQuiz: function (params) {
    return call('quiz', 'submit', params);
  },

  /** 周报数据 */
  weeklyReport: function (week) {
    return call('report', 'weekly', { week: week });
  },

  /* ------------- 班级（家长/老师端，批次 1） ------------- */

  /** 建班级（幂等：重复调用返回同一班级） */
  createClass: function (name, clientReqId) {
    return call('class', 'createClass', { name: name, clientReqId: clientReqId });
  },

  /** 学生凭邀请码加入 */
  joinClass: function (code) {
    return call('class', 'joinClass', { code: code });
  },

  /** 学生退出班级（换班用） */
  leaveClass: function () {
    return call('class', 'leaveClass', {});
  },

  /** 查我所在的班级（教练/学生通用，没有则 class 为 null） */
  myClass: function () {
    return call('class', 'myClass', {});
  },

  /** 教练布置任务（幂等） */
  assignTask: function (params) {
    return call('class', 'assign', params);
  },

  /** 教练：作业列表（带全班进度） */
  coachAssignments: function () {
    return call('class', 'assignments', {});
  },

  /** 学生：我班级的作业 + 我的逐词进度 */
  myAssignments: function () {
    return call('class', 'myAssignments', {});
  },

  /** 教练：学员列表 */
  coachStudents: function () {
    return call('class', 'students', {});
  },

  /** 教练：单个学员详情 */
  studentDetail: function (studentId) {
    return call('class', 'studentDetail', { studentId: studentId });
  },

  /** 教练：生成催学文案（只返回文本，不推送） */
  nudgeText: function (studentId) {
    return call('class', 'nudge', { studentId: studentId });
  }
};

module.exports = {
  ENV_ID: ENV_ID,
  initCloud: initCloud,
  getInitError: getInitError,
  call: call,
  humanError: humanError,
  api: api
};
