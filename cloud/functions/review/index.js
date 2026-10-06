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
  users: 'users',
  assignments: 'assignments',
  words: 'words',
  classes: 'classes'
};

/**
 * 版本戳：随每个响应返回（_v 字段），小程序端 Console 会打印
 * "[cloud] review 云端版本: xxx"。判断"云端跑的是不是最新代码"
 * 不用再猜 —— 版本号对不上就是没部署成功。
 */
const VERSION = 'rev-20261006-matrix';

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
    // 修复：状态表因 v2 写入器事故缺记录，从 review_logs 回填 + 重建云记账
    case 'repair':   return onRepair(OPENID, event);
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
    // 必须是 null 而不是 undefined：字段值为 undefined 时云端更新会把它整个丢掉/报错
    last_wrong_type: feedback === 'forgot' ? (mode || null) : ((prev && prev.last_wrong_type) || null),
    updated_at: now
  };

  if (prev) {
    await db.collection(COLL.state).doc(prev._id).update({ data: doc });
  } else {
    // 新词进入 SRS。写入器按确定性 _id 直接 upsert，
    // 脏文档/并发重放/历史 _id 残留都不会再挡住这次写入
    const errCode = await upsertState(db, COLL.state, user._id, wordId, doc, now);
    if (errCode) {
      return fail('STATE_WRITE_FAIL',
        '学习状态写入失败（云函数日志有完整现场，请把日志发开发）');
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

/* ------------------------------------------------------------------ */
/* 历史数据修复：从 review_logs 回填 user_word_state + 重建云记账        */
/* ------------------------------------------------------------------ */
/**
 * v2 写入器事故（set 带 _id 必抛 -501007、update 静默 updated:0）期间，
 * 提交都"成功"了（有日志、云记账在涨），但状态表一条新记录都没落下来。
 * 日志里有完整的学习明细（user_id + word_id + feedback + 时间），可以无损回填：
 *   - 每个日志里的 (user, word) 对：状态表缺就按确定性 _id 新建，
 *     档位用 srs.nextState 按最后一次反馈重算，与在线提交完全同构；
 *   - 顺手重建 users.stats_cache.learned_words（事故期间每次提交都被当成新词，
 *     记账虚高，跟真实词汇量对不上）。
 * 幂等：已存在的记录只更新不新建，跑多少次结果一致。
 */
async function onRepair(openid, { dryRun }) {
  const logsRes = await db.collection(COLL.logs)
    .orderBy('created_at', 'desc').limit(1000)
    .field({ user_id: true, word_id: true, feedback: true, created_at: true })
    .get().catch(() => ({ data: [] }));
  const rows = logsRes.data || [];
  if (!rows.length) return fail('NO_DATA', '学习日志为空，无从回填');

  // 按 (user, word) 归并：最后一次反馈决定档位，正误计数累加
  const pairs = {};
  rows.forEach((l) => {
    if (!l.user_id || !l.word_id) return;
    const k = String(l.user_id) + '|' + String(l.word_id);
    const m = pairs[k] || (pairs[k] = {
      user_id: l.user_id, word_id: l.word_id,
      known: 0, wrong: 0, last_feedback: 'known', last_at: 0, first_at: 0
    });
    if (l.feedback === 'known') m.known++;
    if (l.feedback === 'forgot') m.wrong++;
    if (l.created_at > m.last_at) { m.last_at = l.created_at; m.last_feedback = l.feedback; }
    if (!m.first_at || l.created_at < m.first_at) m.first_at = l.created_at;
  });

  let created = 0, updated = 0, skipped = 0;
  const detail = [];
  for (const k of Object.keys(pairs)) {
    const m = pairs[k];
    const next = nextState(null, m.last_feedback, m.last_at);
    const doc = {
      user_id: m.user_id,
      word_id: m.word_id,
      stage: next.stage,
      last_feedback: m.last_feedback,
      next_review_at: next.nextReviewAt,
      correct_count: m.known,
      wrong_count: m.wrong,
      last_wrong_type: m.wrong > 0 ? 'repair' : null,
      updated_at: m.last_at
    };
    if (dryRun) { skipped++; continue; }

    // 先按字段查（老版本自动 _id 的历史文档也要被更新而不是重复新建）
    const found = await db.collection(COLL.state)
      .where({ user_id: m.user_id, word_id: m.word_id }).limit(1).get()
      .catch(() => null);
    const hit = found && found.data && found.data[0];
    if (hit) {
      await db.collection(COLL.state).doc(hit._id).update({ data: doc }).catch(() => {});
      updated++;
    } else {
      const err = await upsertState(db, COLL.state, m.user_id, m.word_id, doc, m.first_at);
      if (err) { detail.push('写入失败:' + String(m.word_id)); continue; }
      created++;
    }
  }

  // 重建云记账：learned_words = 状态表里该用户的真实记录数
  const stRes = await db.collection(COLL.state).limit(1000)
    .field({ user_id: true }).get().catch(() => ({ data: [] }));
  const perUser = {};
  (stRes.data || []).forEach((d) => {
    const k = String(d.user_id);
    perUser[k] = (perUser[k] || 0) + 1;
  });
  const usRes = await db.collection(COLL.users).limit(50)
    .field({ stats_cache: true }).get().catch(() => ({ data: [] }));
  for (const u of (usRes.data || [])) {
    const learned = perUser[String(u._id)] || 0;
    const sc = u.stats_cache || {};
    await db.collection(COLL.users).doc(u._id).update({
      data: {
        stats_cache: {
          total_words: sc.total_words || 0,
          learned_words: learned,
          streak_days: sc.streak_days || 0,
          last_active_date: sc.last_active_date || ''
        }
      }
    }).catch(() => {});
  }

  return ok({
    scannedLogs: rows.length,
    distinctPairs: Object.keys(pairs).length,
    created: created,
    updated: updated,
    dryRunSkipped: skipped,
    learnedByUser: perUser,
    writeFails: detail.slice(0, 10)
  });
}

/** 全表诊断：不依赖任何用户身份，控制台"云端测试"可直接跑 */
async function diagnoseAll(clean) {
  /* 设计：所有查询在同一瞬间串行发出，输出一份"同一时刻的快照"。
   * 之前吃过亏：教师页学员卡和自检各自查询，中间数据被人动过，
   * 两个数字互相矛盾却都"没查错" —— 快照式输出就是为了消灭这种时间差。 */
  const lines = [];

  // ---- 状态表 ----
  const res = await db.collection(COLL.state)
    .limit(1000)
    .field({ user_id: true, word_id: true })
    .get().catch(() => ({ data: [] }));
  // 排除诊断自身的探针/哨兵文档，不污染真实数据
  const isProbeRow = (d) => String((d && d.user_id) || '').indexOf('diagprobe') === 0;
  const allRows = (res.data || []).filter((d) => !isProbeRow(d));
  const dirty = allRows.filter((d) => d.word_id === null || d.word_id === undefined || d.word_id === '');

  let cleaned = 0;
  if (clean) {
    for (const d of dirty) {
      const r = await db.collection(COLL.state).doc(d._id).remove().catch(() => null);
      if (r) cleaned++;
    }
  }

  const byUser = {};
  allRows.forEach((d) => {
    const k = String(d.user_id);
    (byUser[k] = byUser[k] || []).push(d.word_id);
  });
  const wordsByUser = {};
  allRows.forEach((d) => {
    if (d.user_id && d.word_id) {
      const k = String(d.user_id);
      (wordsByUser[k] = wordsByUser[k] || []).push(d.word_id);
    }
  });

  // ---- 学习日志（谁真的提交过、什么时候、提交的什么词）----
  const dayStart = getLocalDayStart(Date.now());
  const logRes = await db.collection(COLL.logs)
    .orderBy('created_at', 'desc').limit(1000)
    .field({ user_id: true, word_id: true, feedback: true, created_at: true })
    .get().catch(() => ({ data: [] }));
  const logRows = logRes.data || [];
  const logsByUser = {};
  logRows.forEach((l) => {
    const k = String(l.user_id);
    const m = logsByUser[k] || (logsByUser[k] = { total: 0, today: 0, words: {}, modes: {}, last: null });
    m.total++;
    if (l.created_at >= dayStart) m.today++;
    if (l.word_id) m.words[l.word_id] = 1;
    const mk = l.mode || 'review';
    m.modes[mk] = (m.modes[mk] || 0) + 1;
    if (!m.last) m.last = { at: l.created_at, word: l.word_id, feedback: l.feedback };
  });

  // ---- 用户表（stats_cache 是"云函数自己记的账"）----
  const uRes = await db.collection(COLL.users).limit(50)
    .field({ nickname: true, role: true, stats_cache: true, last_seen_at: true })
    .get().catch(() => ({ data: [] }));
  const users = uRes.data || [];
  const nickMap = {};
  users.forEach((u) => { nickMap[String(u._id)] = u.nickname || ''; });

  // ---- 班级名册（谁在班里、谁是教练）----
  const clsRes = await db.collection(COLL.classes).limit(10)
    .field({ name: true, code: true, owner_id: true, student_ids: true })
    .get().catch(() => ({ data: [] }));
  const classes = clsRes.data || [];

  const who = (uid) => {
    const s = String(uid);
    return (nickMap[s] || '?') + '(' + s.slice(-6) + ')';
  };
  const hm = (ts) => {
    if (!ts) return '?';
    return new Date(Number(ts) + 8 * 3600000).toISOString().slice(11, 16);
  };

  // ============ 拼快照文本 ============

  /* ---- 写入判定矩阵：一次诊断把"环境坏 / 集合坏 / _id 格式坏 / 残留挡路"当场分开 ----
   * v1 探针抓到过 -501007（data 带 _id）；本次升级起因：探针每次写固定
   * (diagprobe, probe)，被唯一索引的上一轮残留挡住 → -502001 假象，且残留
   * 被 isProbeRow 过滤器隐藏。矩阵全部用"每轮随机 key"，结果可复现可判读：
   *   A 状态表 set(随机key)      失败 → 集合级写入坏（索引/存储损坏）
   *   B 状态表 add(随机key)      失败 → 同上
   *   C 冒号 _id set             失败而 A 成功 → 确定性 _id 的冒号是毒
   *   D 白板集合 diag_scratch    失败而 A/B 成功 → 环境级问题
   *   E 探针残留计数              >0 → 上轮清理失败，此前探针报错是假象 */
  const probeOut = [];
  const now2 = Date.now();
  const uni = String(now2).slice(-8); // 每轮唯一后缀，杜绝与历史残留相撞

  // E) 先数残留：上一轮没清干净的探针文档（快照统计里被过滤，这里如实报告）
  const leftover = await db.collection(COLL.state)
    .where({ user_id: 'diagprobe' }).count()
    .catch(() => ({ total: -1 }));
  if (leftover.total > 0) probeOut.push('⚠探针残留 ' + leftover.total + ' 条（上轮清理失败，旧报错勿信）');

  // A) 状态表 set，随机 key，data 不带 _id，成功后回读验证
  const pid1 = 'diagprobe-set-' + uni;
  try {
    await db.collection(COLL.state).doc(pid1).set({
      data: { user_id: 'diagprobe', word_id: 'p' + uni, stage: 0, created_at: now2 }
    });
    const rb = await db.collection(COLL.state).doc(pid1).get()
      .then((r) => !!r.data).catch(() => false);
    probeOut.push('状态表set:' + (rb ? 'OK' : '⚠写入但读不回'));
  } catch (e) {
    probeOut.push('状态表set:FAIL(' + String((e && (e.errMsg || e.message)) || e).slice(0, 120) + ')');
  }

  // B) 状态表 add，随机 word_id，成功后按字段回读验证
  try {
    await db.collection(COLL.state).add({
      data: { user_id: 'diagprobe', word_id: 'a' + uni, stage: 0, created_at: now2 }
    });
    const rb2 = await db.collection(COLL.state)
      .where({ user_id: 'diagprobe', word_id: 'a' + uni }).limit(1).get()
      .then((r) => !!(r.data && r.data.length)).catch(() => false);
    probeOut.push('状态表add:' + (rb2 ? 'OK' : '⚠写入但读不回'));
  } catch (e) {
    probeOut.push('状态表add:FAIL(' + String((e && (e.errMsg || e.message)) || e).slice(0, 120) + ')');
  }

  // C) 冒号 _id 测试：真实写入器用 "user:word" 当 _id，单独验证这种格式
  try {
    await db.collection(COLL.state).doc('diagprobe:colon-' + uni).set({
      data: { user_id: 'diagprobe', word_id: 'c' + uni, stage: 0, created_at: now2 }
    });
    const rb3 = await db.collection(COLL.state).doc('diagprobe:colon-' + uni).get()
      .then((r) => !!r.data).catch(() => false);
    probeOut.push('冒号_id:' + (rb3 ? 'OK' : '⚠写入但读不回'));
  } catch (e) {
    probeOut.push('冒号_id:FAIL(' + String((e && (e.errMsg || e.message)) || e).slice(0, 120) + ')');
  }

  // D) 白板集合对照：隔离"环境问题"与"user_word_state 集合自身问题"
  try {
    await db.collection('diag_scratch').add({ data: { at: now2, note: 'probe' } });
    const rb4 = await db.collection('diag_scratch')
      .where({ at: now2 }).limit(1).get()
      .then((r) => !!(r.data && r.data.length)).catch(() => false);
    probeOut.push('白板集合:' + (rb4 ? 'OK' : '⚠写入但读不回'));
  } catch (e) {
    probeOut.push('白板集合:FAIL(' + String((e && (e.errMsg || e.message)) || e).slice(0, 120) + ')');
  }

  // 清理本轮全部探针文档（失败不再静默——残留会让下轮探针误报）
  const probeWordIds = ['p' + uni, 'a' + uni, 'c' + uni];
  for (const w of probeWordIds) {
    await db.collection(COLL.state)
      .where({ user_id: 'diagprobe', word_id: w }).remove()
      .catch((e) => probeOut.push('⚠清理失败:' + w));
  }

  // 哨兵：跨诊断存活检查（检出两轮之间的外部删除）。data 不带 _id（v2 教训）
  const SENTRY_ID = 'diagprobe-sentinel';
  const prevSent = await db.collection(COLL.state).doc(SENTRY_ID).get()
    .then((r) => r.data || null).catch(() => null);
  await db.collection(COLL.state).doc(SENTRY_ID).set({
    data: { user_id: 'diagprobe', word_id: 'sentinel', at: now2, created_at: now2 }
  }).catch((e) => probeOut.push('⚠哨兵埋设失败:' + String((e && e.errMsg) || e).slice(0, 60)));
  probeOut.push(prevSent
    ? '哨兵(上轮 ' + hm(prevSent.at) + ')仍在 → 无外部删除'
    : '本轮首次布置哨兵（下轮对比）');

  // 隐形文档检测：count() 总数若明显大于"扫描数+探针残留+哨兵"，说明有文档
  // 查询扫不到但占着唯一索引（存储损坏特征）—— 这正是"插入必报 duplicate"的元凶
  const stateCount = await db.collection(COLL.state).count()
    .catch(() => ({ total: -1 }));
  const expected = allRows.length + Math.max(leftover.total, 0) + 1; // +1 哨兵
  const ghost = (stateCount.total > expected) ? (stateCount.total - expected) : 0;

  lines.push('【状态表 user_word_state】扫描 ' + allRows.length + ' 条 · count=' +
    stateCount.total + ' 条 · 覆盖 ' + Object.keys(byUser).length + ' 人' +
    (ghost > 0 ? ' · ⚠隐形文档 ' + ghost + ' 条（扫不到但占索引）' : ''));
  lines.push('  探针: ' + probeOut.join(' · '));
  if (!Object.keys(byUser).length) {
    lines.push('  （空：没有任何学习状态同步到云端）');
  }
  // 逐人 count() 交叉核对：防止 limit(1000) 扫描与 where 查询口径不一致
  for (const uid of Object.keys(byUser)) {
    const c = await db.collection(COLL.state).where({ user_id: uid }).count()
      .catch(() => ({ total: -1 }));
    const ws = byUser[uid];
    const mark = (c.total === ws.length) ? '' : ' ⚠扫描与count不一致';
    lines.push('  ' + who(uid) + ': ' + ws.length + ' 词(count=' + c.total + ')' + mark +
      ' · 如 ' + ws.slice(0, 5).join(','));
  }

  lines.push('【学习日志 review_logs】' + logRows.length + ' 条 · 今日 ' +
    logRows.filter((l) => l.created_at >= dayStart).length + ' 条');
  if (!Object.keys(logsByUser).length) {
    lines.push('  （空：没有任何提交到达云端）');
  }
  Object.keys(logsByUser).forEach((uid) => {
    const m = logsByUser[uid];
    const nWords = Object.keys(m.words).length;
    const modeStr = Object.keys(m.modes).map((k) => k + '×' + m.modes[k]).join('/');
    lines.push('  ' + who(uid) + ': 共 ' + m.total + ' · 今日 ' + m.today +
      ' · 词数 ' + nWords + ' · 模式 ' + modeStr +
      ' · 最近 ' + hm(m.last.at) + ' ' + m.last.word + ' (' + m.last.feedback + ')');
  });

  lines.push('【用户 users】' + users.length + ' 人');
  users.forEach((u) => {
    const sc = u.stats_cache || {};
    lines.push('  ' + who(u._id) + ' ' + (u.role || 'student') +
      ' · 云记账已学=' + (sc.learned_words || 0) + ' · 连续=' + (sc.streak_days || 0) +
      ' · 最近学习日=' + (sc.last_active_date || '?') +
      ' · seen=' + (u.last_seen_at ? hm(u.last_seen_at) : '?'));
  });

  lines.push('【班级】' + classes.length + ' 个');
  classes.forEach((c) => {
    const ids = c.student_ids || [];
    lines.push('  ' + (c.name || '?') + '(' + (c.code || '?') + ') 教练=' +
      who(c.owner_id) + ' 学员(' + ids.length + ')=' +
      (ids.map(who).join(', ') || '无'));
  });

  /* ---- 作业诊断：回答"为什么作业进度是 0/10" ----
   * 三个可能断点各自留下不同的证据：
   *   a) 作业还是旧 words._id 格式（idHits>0）—— 归一逻辑应已兜底，但要看命中数
   *   b) 学员的词与作业词单零交集 —— 孩子学的是任务词/本地词，不是作业词
   *   c) 学员根本没有学习记录（perUserCounts 为空）—— 同步链路问题
   */
  const asgRes = await db.collection(COLL.assignments)
    .orderBy('created_at', 'desc').limit(5).get().catch(() => ({ data: [] }));
  const assignments = [];
  for (const a of (asgRes.data || [])) {
    const raw = a.word_ids || [];
    const idToWord = {};
    if (raw.length) {
      const wr = await db.collection(COLL.words).where({ _id: _.in(raw) })
        .limit(1000).field({ word: true }).get().catch(() => ({ data: [] }));
      (wr.data || []).forEach((w) => { idToWord[String(w._id)] = w.word; });
    }
    const texts = raw.map((id) => idToWord[String(id)] || id);
    const per = Object.keys(wordsByUser).map((uid) => {
      const set = {};
      wordsByUser[uid].forEach((w) => { set[w] = 1; });
      const hit = texts.filter((w) => set[w]).length;
      return {
        who: nickMap[uid] || uid.slice(-6),
        learned: hit,
        sample: wordsByUser[uid].slice(0, 6)
      };
    });
    assignments.push({
      id: a._id,
      name: a.note || (a.tag ? a.tag + '作业' : '作业'),
      count: a.count || raw.length,
      idHits: Object.keys(idToWord).length,   // >0 = 作业还是旧 _id 格式
      rawHead: raw.slice(0, 6),
      normHead: texts.slice(0, 6),
      perStudent: per
    });
    lines.push('【作业】《' + (a.note || a.tag || '作业') + '》' + (a.count || raw.length) + ' 词 · 旧_id翻译 ' +
      Object.keys(idToWord).length + '/' + raw.length);
    lines.push('  词单: ' + texts.slice(0, 6).join(', ') + (raw.length > 6 ? ' …' : ''));
    per.forEach((p) => {
      lines.push('  ' + p.who + ': 命中 ' + p.learned + '/' + texts.length);
    });
  }

  lines.push(dirty.length
    ? '⚠ 全表存在 word_id 为空的脏记录 ' + dirty.length + ' 条。' +
      (clean ? '已清理 ' + cleaned + ' 条。' : '加 "clean":true 可自动清理。')
    : '状态表干净（无 word_id 为空的脏记录）。');

  return ok({
    scope: 'all',
    version: VERSION,
    lines: lines,
    stateTotal: allRows.length,
    usersWithState: Object.keys(byUser).length,
    perUserCounts: byUser,
    dirty: dirty.length,
    dirtyIds: dirty.slice(0, 10).map((d) => String(d._id)),
    cleaned: cleaned,
    reviewLogTotal: logRows.length,
    logUsers: logsByUser,
    usersInfo: users.map((u) => ({
      id: u._id, nickname: u.nickname || '', role: u.role || 'student',
      stats_cache: u.stats_cache || null
    })),
    classesInfo: classes.map((c) => ({
      id: c._id, name: c.name, code: c.code,
      owner_id: c.owner_id, student_ids: c.student_ids || []
    })),
    assignments: assignments,
    hint: (dirty.length
      ? '全表存在 word_id 为空的脏记录（' + dirty.length + ' 条）。' +
        (clean ? '已清理 ' + cleaned + ' 条。' : '加 "clean":true 可自动清理。')
      : '状态表干净。当前写入器用确定性 _id（user_id:word_id），脏数据也挡不住新写入。')
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
