/**
 * 云函数：review —— 复习反馈提交
 *
 * 这个文件是"服务端业务逻辑怎么写"的参考实现，重点演示四条硬约定：
 *   1) 幂等：同一个 client_req_id 重复提交只生效一次
 *   2) 时区：统一按 UTC+8 计算"今天"
 *   3) SRS：档位与间隔的规则集中在 shared/srs.js，页面和云函数都不许自己算
 *   4) 数据库读写只出现在本层（将来迁自建 Koa 只需重写这一层）
 *
 * 部署：云函数目录里需要带上 shared/ 的副本（或用 npm 私有包/软链），
 *       实际项目里建议把 shared 发布成内部包，避免双份代码漂移。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const { nextState, REQ_ID_TTL_DAYS } = require('./shared/srs');
const { getLocalDate, getLocalDayStart } = require('./shared/time');

const COLL = {
  state: 'user_word_state',
  logs: 'review_logs',
  requests: 'request_dedup',
  tasks: 'daily_tasks',
  users: 'users'
};

/**
 * 云函数入口。约定调用方式：wx.cloud.callFunction({ name:'review', data:{ action:'submit', ... } })
 */
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('NO_IDENTITY', '无法识别用户身份');

  switch (event.action) {
    case 'submit': return onSubmit(OPENID, event);
    case 'due':    return onDueList(OPENID, event);
    default:       return fail('BAD_ACTION', '未知 action: ' + event.action);
  }
};

/* ------------------------------------------------------------------ */
/* 复习反馈提交                                                        */
/* ------------------------------------------------------------------ */
async function onSubmit(openid, { wordId, feedback, mode, durationMs, clientReqId }) {
  // --- 入参校验：服务端不能相信客户端传来的任何值 ---
  if (!wordId) return fail('BAD_PARAM', '缺少 wordId');
  if (!['forgot', 'vague', 'known'].includes(feedback)) return fail('BAD_PARAM', '非法 feedback');
  if (!clientReqId) return fail('BAD_PARAM', '缺少 clientReqId（幂等要求）');

  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先调用 user.login');

  // --- 幂等第一道闸：相同请求只处理一次 ---
  const dedupId = user._id + ':' + clientReqId;
  const dup = await db.collection(COLL.requests).where({ _id: dedupId }).limit(1).get()
    .catch(() => ({ data: [] }));
  if (dup.data && dup.data.length) {
    // 已处理过：直接回放上次结果，客户端不会看到重复计数
    return ok({ replay: true, state: dup.data[0].result });
  }

  const now = Date.now();
  const today = getLocalDate(now);   // UTC+8 的 YYYY-MM-DD

  // --- 读取当前状态（唯一索引 (user_id, word_id) 保证只有一条） ---
  const stRes = await db.collection(COLL.state)
    .where({ user_id: user._id, word_id: wordId })
    .limit(1).get();
  const prev = stRes.data && stRes.data[0] ? stRes.data[0] : null;

  // --- 用共享模块算新状态：算法只有一份，前后端不许各写一套 ---
  const next = nextState(prev, feedback, now);

  const doc = {
    user_id: user._id,
    word_id: wordId,
    stage: next.stage,
    last_feedback: next.lastFeedback,
    next_review_at: next.nextReviewAt,
    correct_count: (prev ? prev.correct_count : 0) + (feedback === 'known' ? 1 : 0),
    wrong_count: (prev ? prev.wrong_count : 0) + (feedback === 'forgot' ? 1 : 0),
    last_wrong_type: feedback === 'forgot' ? (mode || null) : (prev ? prev.last_wrong_type : null),
    updated_at: now
  };

  if (prev) {
    await db.collection(COLL.state).doc(prev._id).update({ data: doc });
  } else {
    await db.collection(COLL.state).add({ data: Object.assign({ created_at: now }, doc) });
  }

  // --- 记录明细（用于错词本与后续算法调优；保留策略见《设计约定》） ---
  await db.collection(COLL.logs).add({
    data: {
      user_id: user._id,
      word_id: wordId,
      feedback,
      mode: mode || 'review',
      duration_ms: Math.max(0, Number(durationMs) || 0),
      review_date: today,
      created_at: now
    }
  });

  // --- 当天答错的词，回到今日任务里再考一次（当日闭环，不跨天） ---
  if (feedback === 'forgot') {
    await enqueueTodayOnce(user._id, today, wordId, now);
  }

  // --- 幂等第二道闸：写入去重记录（带过期时间，由定时任务清理） ---
  const result = { stage: next.stage, nextReviewAt: next.nextReviewAt };
  await db.collection(COLL.requests).add({
    data: {
      _id: dedupId,
      user_id: user._id,
      action: 'review.submit',
      result,
      expire_at: now + REQ_ID_TTL_DAYS * 24 * 3600 * 1000,
      created_at: now
    }
  }).catch(() => {});   // 并发重复写入时忽略唯一键冲突，结果已生效

  return ok({ replay: false, state: result, todayDoneDelta: 1 });
}

/* ------------------------------------------------------------------ */
/* 今日到期列表（任务组装的最小依赖，完整组装见 task 云函数）           */
/* ------------------------------------------------------------------ */
async function onDueList(openid, { limit }) {
  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在');

  const cap = Math.min(Number(limit) || 100, 200);   // 一定要有上限，防全表扫
  const res = await db.collection(COLL.state)
    .where({ user_id: user._id, next_review_at: _.lte(Date.now()) })
    .orderBy('next_review_at', 'asc')
    .limit(cap)
    .field({ word_id: true, stage: true, next_review_at: true })
    .get();

  return ok({ due: res.data, truncated: res.data.length >= cap });
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */
async function getUser(openid) {
  const r = await db.collection(COLL.users).where({ openid }).limit(1).get();
  return r.data && r.data[0] ? r.data[0] : null;
}

/**
 * 把当天答错的词加回今日任务（快照里的 extra 列表），且不重复加。
 * 之所以不直接改 next_review_at，是为了让"今日再考一次"留在当天，不污染 SRS 的跨天排程。
 */
async function enqueueTodayOnce(userId, today, wordId, now) {
  const r = await db.collection(COLL.tasks)
    .where({ user_id: userId, task_date: today })
    .limit(1).get();
  if (!r.data || !r.data[0]) return;              // 今天还没生成任务，下次生成时会带上错词
  const task = r.data[0];
  const extra = Array.isArray(task.snapshot_json && task.snapshot_json.repeat)
    ? task.snapshot_json.repeat : [];
  if (extra.includes(wordId)) return;
  extra.push(wordId);
  await db.collection(COLL.tasks).doc(task._id).update({
    data: { 'snapshot_json.repeat': extra, updated_at: now }
  });
}

const ok = (data) => ({ ok: true, data });
const fail = (code, message) => ({ ok: false, code, message });
