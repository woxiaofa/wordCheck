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

/**
 * 云端版本探测：每个云函数的响应都带 _v 版本戳。
 * 同一函数的版本变化、或压根没有 _v（= 云端还是没加版本戳的旧代码），
 * 都会在 Console 打一行明白话 —— "部署到底生效没有"不再靠猜。
 */
var seenVersions = {};

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
        trackVersion(name, r._v);
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

/** 记录并播报云端函数版本：变了、或发现旧版（无 _v）都明说 */
function trackVersion(name, v) {
  if (!v) {
    if (!seenVersions[name]) {
      seenVersions[name] = '(旧版本)';
      console.warn('[cloud] ' + name + ' 云端是旧版本（响应没有版本戳）——' +
        '这次改动没有部署成功，请在云函数目录右键"上传并部署"');
    }
    return;
  }
  if (seenVersions[name] !== v) {
    console.info('[cloud] ' + name + ' 云端版本: ' + v);
    seenVersions[name] = v;
  }
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
    var m = String(err.message);
    if (m.indexOf('cannot find') >= 0) return '云函数未部署，请先上传部署';
    if (m.indexOf('timeout') >= 0) return '网络超时，请重试';
    if (m.indexOf('Cannot find module') >= 0) return '云函数部署不完整（缺依赖模块），请重新上传部署';
    if (m.indexOf('execute fail') >= 0) return '云函数执行失败，点"云自检"看具体原因';
    return '网络异常，请重试';
  }
  return err.message || '操作失败';
}

var learnlog = require('./learnlog');

/* ---------------- 失败补传队列 ---------------- */

/**
 * 学习/抽查记录一旦没送到云端，家长端就永远看不到孩子进度（表现为"已学 0 词"），
 * 而用户完全无从察觉。这里把失败的写请求压进本地队列，下次启动/回到前台时重放。
 *
 * 安全性：服务端对 clientReqId 做幂等（重复提交返回 replay:true，不重复计数），
 * 所以同一条记录重放多少次都只会生效一次。
 */
var PENDING_KEY = 'cloud_pending_review';
var PENDING_MAX = 200;        // 队列上限，超出丢最旧的（防 storage 撑爆）
var PENDING_MAX_FAIL = 5;     // 单条最多重放 5 次，超过丢弃并记日志（可能是数据本身有问题）

function readPending() {
  try {
    var v = wx.getStorageSync(PENDING_KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

function writePending(list) {
  try { wx.setStorageSync(PENDING_KEY, list); } catch (e) { /* storage 不可用时只丢补偿，不影响主流程 */ }
}

function enqueuePending(name, action, payload) {
  if (!payload || !payload.clientReqId) return;   // 没有幂等 ID 的请求不能重放
  var list = readPending();
  if (list.length >= PENDING_MAX) list.shift();
  list.push({ name: name, action: action, payload: payload, fails: 0, at: Date.now() });
  writePending(list);
}

function pendingCount() {
  return readPending().length;
}

/**
 * 重放积压请求（顺序执行，最多重放整队）。
 * @returns {Promise<{tried:number,done:number,left:number}>}
 */
function flushPending() {
  var list = readPending();
  if (!list.length) return Promise.resolve({ tried: 0, done: 0, left: 0 });

  var results = [];
  var chain = Promise.resolve();
  list.forEach(function (item) {
    chain = chain.then(function () {
      return call(item.name, item.action, item.payload)
        .then(function () { results.push(true); }, function () { results.push(false); });
    });
  });

  return chain.then(function () {
    var rest = [];
    list.forEach(function (item, i) {
      var reqId = item.payload && item.payload.clientReqId;
      if (results[i]) {
        // 重放成功：把学习流水里那条从"云端…"改成"已确认"，家长能亲眼看到补上了
        if (reqId && learnlog.patchByReq(reqId, 'ok')) {
          console.log('[cloud] 补传成功并已回写流水：', item.payload && item.payload.wordId);
        }
        return;                                     // 成功，出队
      }
      if (reqId) learnlog.patchByReq(reqId, 'fail', '补传仍失败');
      item.fails = (item.fails || 0) + 1;
      if (item.fails >= PENDING_MAX_FAIL) {
        console.warn('[cloud] 补传放弃（已重试 ' + item.fails + ' 次）：', item.payload &&
          item.payload.wordId);
        return;
      }
      rest.push(item);
    });
    writePending(rest);
    return { tried: list.length, done: list.length - rest.length, left: rest.length };
  });
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

  /**
   * 提交一次复习反馈（必须带幂等 ID）
   * 失败不丢：压进补传队列，下次启动/回前台自动重放。
   * 调用方仍会收到 reject（页面上该提示提示），但数据不会永久丢失。
   */
  submitReview: function (params) {
    return call('review', 'submit', params).catch(function (err) {
      enqueuePending('review', 'submit', params);
      throw err;
    });
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
    return call('quiz', 'submit', params).catch(function (err) {
      enqueuePending('quiz', 'submit', params);
      throw err;
    });
  },

  /** 周报数据 */
  weeklyReport: function (week) {
    return call('report', 'weekly', { week: week });
  },

  /**
   * 云端自检（review 云函数的 diagnose）：{"action":"diagnose","all":true}
   * 排查"云函数到底活着没有、库里有没有数据"时用，页面可直接把结果摊开给用户看。
   */
  diagnose: function (all, clean) {
    return call('review', 'diagnose', { all: all !== false, clean: !!clean });
  },

  /**
   * 历史数据修复：从学习日志回填缺失的状态记录、重建云记账。
   * v2 写入器事故（set 带 _id 报 -501007）期间的学习明细都在日志里，可无损找回。
   */
  repairHistory: function () {
    return call('review', 'repair', {});
  },

  /**
   * 学习简报：一句话的"学了多久/多少个/抽查掌握几个/还要不要循环"。
   * 不传 studentId = 看自己（学生端首页）；教练传学员 id 看该学员 —— 两端同一句文案。
   */
  learnSummary: function (studentId) {
    return call('class', 'summary', { studentId: studentId || '' });
  },

  /* ------------- 成绩 / 荣誉 / 榜单 ------------- */

  /**
   * 上报一轮快刷成绩，换回排名与荣誉。
   * key 决定和谁比：'book:wy4a' 只跟同一个词库比，'assign:xxx' 只跟同一份作业比 ——
   * 拿中考词去跟小学教材词比速度没有意义。
   */
  drillScore: function (params) {
    return call('rank', 'submit', params);
  },

  /** 榜单：某个 key 下的前 N 名（含我自己） */
  drillBoard: function (key, limit) {
    return call('rank', 'board', { key: key, limit: limit || 20 });
  },

  /** 保存昵称/头像（榜单展示用；用户不填也能正常练词） */
  saveProfile: function (params) {
    return call('rank', 'profile', params);
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
  },

  /* ------------- 每日简报订阅（2026-10-08） ------------- */

  /**
   * 订阅某个孩子的每日简报。
   * 前置必须由页面先 wx.requestSubscribeMessage 拿到授权 —— 这里只记账。
   */
  subscribeBrief: function (studentId, unsubscribe) {
    return call('class', 'subscribeBrief', { studentId: studentId, unsubscribe: !!unsubscribe });
  },

  /** 我订阅了哪些孩子（含服务端是否已配好模板） */
  briefSubs: function () {
    return call('class', 'briefSubs', {});
  },

  /**
   * 立刻发一次今天的简报给我（不配等的用法；正常由云端定时器每天 20:30 发）
   */
  sendBriefs: function () {
    return call('class', 'sendBriefs', {});
  }
};

/**
 * 订阅消息的模板 ID —— 服务端的同一份这份要在云端 class/index.js 的 BRIEF.TEMPLATE_ID 里保持一致
 * （云端那份才是发消息的真正依据；这里只是请求授权时要用同一个 ID）。
 * ⚠️ 上线前必须改成你在微信公众平台选用后的模板 ID
 * （公众平台 → 订阅消息 → 公共模板库 → 选模板 → 复制模板 ID）。
 * 留空时前端会给出"该功能还没开"的明确提示，而不是静默失败。
 */
var BRIEF_TEMPLATE_ID = '';

/** 小程序wx.requestSubscribeMessage 的封装：统一处理"不愿授权"与"旧基础库不支持" */
function requestSubscribe() {
  return new Promise(function (resolve, reject) {
    if (!BRIEF_TEMPLATE_ID) {
      reject(makeError('NO_TEMPLATE', '每日简报推送还没开通（服务端未配置模板）'));
      return;
    }
    if (!wx.requestSubscribeMessage) {
      reject(makeError('NOT_SUPPORT', '当前微信版本不支持订阅消息，请升级微信'));
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [BRIEF_TEMPLATE_ID],
      success: function (res) {
        if (res[BRIEF_TEMPLATE_ID] === 'accept') resolve(true);
        else reject(makeError('SUB_REJECT', '没有勾选「总是保持以上选择」，这次不会推送'));
      },
      fail: function (err) {
        reject(makeError('SUB_FAIL', (err && (err.errMsg || err.message)) || '订阅失败'));
      }
    });
  });
}

module.exports = {
  ENV_ID: ENV_ID,
  BRIEF_TEMPLATE_ID: BRIEF_TEMPLATE_ID,
  initCloud: initCloud,
  getInitError: getInitError,
  call: call,
  humanError: humanError,
  requestSubscribe: requestSubscribe,
  api: api,
  // 补传队列：app 启动/回前台时重放，保证学习数据最终一定到云端
  flushPending: flushPending,
  pendingCount: pendingCount
};
