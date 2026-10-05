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

const { nextState, REQ_ID_TTL_DAYS } = require('./srs');
const { getLocalDate, getLocalDayStart } = require('./time');
const { upsertState } = require('./state-store');

const COLL = {
  state: 'user_word_state',
  logs: 'review_logs',
  requests: 'request_dedup',
  tasks: 'daily_tasks',
  users: 'users'
};

/**
 * 版本戳：随每个响应返回（_v 字段），小程序端 Console 会打印
 * "[cloud] review 云端版本: xxx"。判断"云端跑的是不是最新代码"
 * 不用再猜 —— 版本号对不上就是没部署成功。
 */
const VERSION = 'rev-20261005-state-id';

/**
 * 云函数入口。约定调用方式：wx.cloud.callFunction({ name:'review', data:{ action:'submit', ... } })
 */
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('NO_IDENTITY', '无法识别用户身份');

  switch (event.action) {
    case 'submit':   return onSubmit(OPENID, event);
    case 'due':      return onDueList(OPENID, event);
    // 自检：云控制台 → 云函数 → review → 云端测试，填 {"action":"diagnose"} 即可
    case 'diagnose': return onDiagnose(OPENID, event);
    default:         return fail('BAD_ACTION', '未知 action: ' + event.action);
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
    // 新词进入 SRS：撞唯一键时由 state-store 自愈（清理 word_id 为空的
    // 脏文档 → 回读 → 重试），脏数据导致的"进度恒 0"在这里自动恢复
    const errCode = await upsertState(db, COLL.state, user._id, wordId, doc, now);
    if (errCode) {
      return fail('STATE_CONFLICT',
        '学习状态写入冲突：请在云控制台 user_word_state 集合删除 word_id 为空的记录' +
        '（云函数日志有现场）；若反复出现请把日志发开发');
    }
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

  // --- 冗余统计（实施手册规范 6：看板数字冗余在 users.stats_cache 上，
  //     教练端"已学 N 词/连续 N 天"直接读它，禁止高频 count() 聚合） ---
  // 这里只做增量：新词进入 SRS 时 learned_words+1；按 last_active_date 判定连续打卡
  const sc = user.stats_cache || { total_words: 0, learned_words: 0, streak_days: 0 };
  let streak = sc.streak_days || 0;
  if (sc.last_active_date !== today) {
    const yesterday = getLocalDate(now - 86400000);
    streak = (sc.last_active_date === yesterday) ? streak + 1 : 1;
  }
  await db.collection(COLL.users).doc(user._id).update({
    data: {
      stats_cache: {
        total_words: sc.total_words || 0,
        learned_words: (sc.learned_words || 0) + (prev ? 0 : 1),
        streak_days: streak,
        last_active_date: today
      }
    }
  }).catch(() => {});   // 统计失败不影响主流程，可由后续提交自然修正

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
/* 自检：把"云端到底怎么回事"摆到台面上                                */
/* ------------------------------------------------------------------ */

/**
 * 自检入口，两种用法：
 *
 * A) 云控制台 → 云函数 → review → 云端测试（**不需要**小程序登录态）：
 *      {"action":"diagnose","all":true}                 全表只查
 *      {"action":"diagnose","all":true,"clean":true}    全表连清带查
 *    早先版本在这里要求 OPENID，控制台测试永远返回 NO_USER，自检形同虚设。
 *
 * B) 小程序端调用（带登录态）：{"action":"diagnose"}
 *      只看当前用户；加 "clean":true 连清带看。
 *
 * 返回：记录总数、word_id 为空的脏记录数、review_logs 是否有数据、
 *       stats_cache 当前值 —— "进度恒 0"一眼定位到是哪一环断了。
 */
async function onDiagnose(openid, { clean, all }) {
  if (all || !openid) return diagnoseAll(clean);
  const user = await getUser(openid);
  if (!user) return diagnoseAll(clean);

  const res = await db.collection(COLL.state)
    .where({ user_id: user._id })
    .limit(1000)
    .field({ word_id: true, stage: true, last_feedback: true })
    .get();
  const allRows = res.data || [];
  const dirty = allRows.filter((d) => d.word_id === null || d.word_id === undefined || d.word_id === '');

  let cleaned = 0;
  if (clean) {
    for (const d of dirty) {
      const r = await db.collection(COLL.state).doc(d._id).remove().catch(() => null);
      if (r) cleaned++;
    }
  }

  const logs = await db.collection(COLL.logs)
    .where({ user_id: user._id }).limit(1).get().catch(() => ({ data: [] }));

  return ok({
    scope: 'user',
    userId: user._id,
    version: VERSION,
    stateTotal: allRows.length,
    dirty: dirty.length,
    dirtyIds: dirty.slice(0, 10).map((d) => String(d._id)),
    cleaned: cleaned,
    hasReviewLog: !!(logs.data && logs.data.length),
    statsCache: user.stats_cache || null,
    hint: dirty.length
      ? '存在 word_id 为空的脏记录（' + dirty.length + ' 条）。' +
        (clean ? '已清理 ' + cleaned + ' 条。' : '加 "clean":true 可自动清理。')
      : '状态表干净，学习数据可以正常写入'
  });
}

/** 全表诊断：不依赖任何用户身份，控制台"云端测试"可直接跑 */
async function diagnoseAll(clean) {
  const res = await db.collection(COLL.state)
    .limit(1000)
    .field({ user_id: true, word_id: true })
    .get().catch(() => ({ data: [] }));
  const allRows = res.data || [];
  const dirty = allRows.filter((d) => d.word_id === null || d.word_id === undefined || d.word_id === '');

  const byUser = {};
  allRows.forEach((d) => {
    const k = String(d.user_id);
    byUser[k] = (byUser[k] || 0) + 1;
  });

  let cleaned = 0;
  if (clean) {
    for (const d of dirty) {
      const r = await db.collection(COLL.state).doc(d._id).remove().catch(() => null);
      if (r) cleaned++;
    }
  }

  const logCount = await db.collection(COLL.logs).count()
    .catch(() => ({ total: -1 }));

  return ok({
    scope: 'all',
    version: VERSION,
    stateTotal: allRows.length,
    usersWithState: Object.keys(byUser).length,
    perUserCounts: byUser,
    dirty: dirty.length,
    dirtyIds: dirty.slice(0, 10).map((d) => String(d._id)),
    cleaned: cleaned,
    reviewLogTotal: logCount.total,
    hint: dirty.length
      ? '全表存在 word_id 为空的脏记录（' + dirty.length + ' 条）。' +
        (clean ? '已清理 ' + cleaned + ' 条。' : '加 "clean":true 可自动清理。')
      : '状态表干净。当前写入器用确定性 _id（user_id:word_id），脏数据也挡不住新写入。'
  });
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

const ok = (data) => ({ ok: true, _v: VERSION, data });
const fail = (code, message) => ({ ok: false, _v: VERSION, code, message });
