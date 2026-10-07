/**
 * 云函数：rank —— 练词成绩、榜单、荣誉
 *
 * 设计取舍：
 *   1) 分组比，不混着比。key = 'book:{词库}' 或 'assign:{作业名}'。
 *      拿中考词跟小学教材词比速度没有意义，比出来的排名没人信。
 *   2) 比"最快"，不是比"最高分"。任务是固定词数，快 = 熟。
 *      同一个人在同一个 key 下只保留最快的一次（后一次更慢就不覆盖）。
 *   3) 排名 = 比我快的人数 + 1。打败百分比 = (总人数 - 排名) / 总人数。
 *      总人数为 1 时给 100%，不给 0%（"打败 0% 的人"是句废话还打击人）。
 *   4) 榜单挂了不能影响练词：小程序端已经做了兜底（只显示本地荣誉）。
 *   5) 集合可能还没建（新环境）→ 遇 -502005 自动建一次再重试。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const { getLocalDate } = require('./time');

const VERSION = 'rank-20261007-periods';

const COLL = {
  users: 'users',
  scores: 'drill_scores'
};

/** 榜单单次返回上限 */
const BOARD_LIMIT = 50;

/** 参与比的周期：今日 / 本周 / 本月（各自独立成榜，每人在每个周期内只留最快） */
const PERIODS = ['day', 'week', 'month'];

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('NO_IDENTITY', '无法识别用户身份');

  switch (event.action) {
    case 'submit':  return onSubmit(OPENID, event);
    case 'board':   return onBoard(OPENID, event);
    case 'profile': return onProfile(OPENID, event);
    default:        return fail('BAD_ACTION', '未知 action: ' + event.action);
  }
};

/* ------------------------------------------------------------------ */
/* 上报一轮成绩                                                        */
/* ------------------------------------------------------------------ */

async function onSubmit(openid, event) {
  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先进入小程序首页完成初始化');

  const key = cleanKey(event.key);
  const keyName = String(event.keyName || '').slice(0, 40);
  const count = clampInt(event.count, 0, 200);
  const seconds = clampInt(event.seconds, 1, 3600);
  const perfect = event.perfect === true;

  const scoreId = 'score:' + user._id + ':' + key;
  const now = Date.now();
  const today = getLocalDate(now);

  // 同一人同一 key 只留最快的一次：更慢的成绩不覆盖
  const prev = await readWithCreate(COLL.scores, async () =>
    db.collection(COLL.scores).doc(scoreId).get().catch(() => null));
  const prevData = prev && prev.data;
  const better = !prevData || !(prevData.seconds <= seconds);

  // 周期桶：今日/本周/本月各留一份"这个周期内的最快"。
  // 跨了周期（新的一天/周一/月初）就重开；没跨就只在你更快时刷新。
  // 这样"本周最快"不需要留存全部流水 —— 每个人的周期最优就躺在自己的成绩文档里。
  const starts = periodStarts(now);
  const prevPeriod = (prevData && prevData.period) || {};
  const period = {};
  for (const p of PERIODS) {
    const pb = prevPeriod[p];
    if (!pb || pb.start !== starts[p]) {
      period[p] = { start: starts[p], seconds: seconds, count: count, perfect: perfect };
    } else if (seconds < pb.seconds) {
      period[p] = { start: pb.start, seconds: seconds, count: count, perfect: perfect };
    } else {
      period[p] = pb;
    }
  }

  // upsert 的 data 里绝不能带 _id（doc(id).set() 已经指定了，再带会 -501007）
  const doc = {
    user_id: user._id,
    key: key,
    key_name: keyName,
    count: count,
    seconds: better ? seconds : prevData.seconds,
    perfect: better ? perfect : !!prevData.perfect,
    // date 是"最好成绩是哪天练的"：更慢的一次不该把它刷成今天（否则最好成绩的日期是假的）
    date: better ? today : (prevData.date || today),
    runs: (prevData && prevData.runs ? prevData.runs : 0) + 1,
    period: period,
    updated_at: now
  };

  // 一律 set upsert：add 撞唯一索引会 -502001（daily_tasks 上已经踩过一次）
  const wrote = await db.collection(COLL.scores).doc(scoreId).set({ data: doc })
    .then(() => true)
    .catch(async (e) => {
      if (!isMissingColl(e)) return false;
      await createCollection(COLL.scores);
      const again = await db.collection(COLL.scores).doc(scoreId).set({ data: doc })
        .then(() => true).catch(() => false);
      return again;
    });

  if (!wrote) {
    // 写不进去也要给出排名 —— 榜单是锦上添花，不该让完成页报错
    return ok(await rankOf(doc, user));
  }
  return ok(await rankOf(doc, user));
}

/**
 * 算排名与荣誉（总榜 + 今日/本周/本月三个周期榜）
 * @param {object} doc 成绩文档
 * @param {object} user 用户（取昵称）
 */
async function rankOf(doc, user) {
  const where = { key: doc.key };

  let total = 0;
  const cnt = await db.collection(COLL.scores).where(where).count().catch(() => null);
  total = (cnt && cnt.total) || 0;
  if (!total) total = 1;

  // 比我快的人数（同 key、用时更少）
  const faster = await db.collection(COLL.scores)
    .where({ key: doc.key, seconds: _.lt(doc.seconds) })
    .count().catch(() => null);
  const rank = ((faster && faster.total) || 0) + 1;

  // 打败百分比 = 比我慢的人占总人数的比例。
  // 只有自己一个人时给 100（"打败 0% 的人"是句废话）；
  // 垫底时算出来就是 0 —— 那是事实，前端会因 0 不显示这一行，不去粉饰。
  const beat = total <= 1 ? 100 : Math.round((total - rank) / total * 100);

  const who = (user && (user.nickname || '')) || '';
  const detail = (who ? who + ' · ' : '') +
    doc.count + ' 个词 · ' + fmtSeconds(doc.seconds) +
    ' · 第 ' + rank + '/' + total + ' 名';

  const periods = await periodRanks(doc);
  const best = doc.seconds;

  return {
    rank: rank,
    total: total,
    beat: beat,
    badge: badgeOf(rank, total, beat, doc.perfect),
    detail: detail,
    best: best,
    key: doc.key,
    keyName: doc.key_name || '',
    periods: periods
  };
}

/**
 * 三个周期榜（今日/本周/本月）里我的名次与榜首。
 * 取全 key 的成绩文档（同一人每 key 只一条，班级场景几十条封顶）在内存里算，
 * 不做聚合查询 —— 数据量级之下，简单可验证远比"看起来高级"重要。
 */
async function periodRanks(doc) {
  const starts = periodStarts(Date.now());
  const res = await db.collection(COLL.scores)
    .where({ key: doc.key }).limit(200).get().catch(() => null);
  const rows = (res && res.data) || [];

  // 榜首要显示昵称：一次性把涉及的用户批量取回
  const ids = rows.map(r => r.user_id).filter(Boolean);
  const users = {};
  if (ids.length) {
    const us = await db.collection(COLL.users).where({ _id: _.in(ids) })
      .limit(BOARD_LIMIT).get().catch(() => null);
    ((us && us.data) || []).forEach(u => { users[u._id] = u; });
  }

  const out = {};
  for (const p of PERIODS) {
    // 有这个周期成绩的人（start 相同 = 同一个今天/同一周/同一个月）
    const inP = rows.filter(r => r.period && r.period[p] &&
      r.period[p].start === starts[p]);
    if (!inP.length) { out[p] = null; continue; }

    const mine = doc.period && doc.period[p] ? doc.period[p].seconds : doc.seconds;
    const fasterInP = inP.filter(r => r.period[p].seconds < mine).length;
    const rankInP = fasterInP + 1;

    const leaderRow = inP.reduce((best, r) =>
      r.period[p].seconds < best.period[p].seconds ? r : best, inP[0]);
    const lu = users[leaderRow.user_id] || {};

    out[p] = {
      rank: rankInP,
      total: inP.length,
      seconds: mine,
      secondsText: fmtSeconds(mine),
      leader: {
        nickname: lu.nickname || '',
        seconds: leaderRow.period[p].seconds,
        secondsText: fmtSeconds(leaderRow.period[p].seconds),
        perfect: !!leaderRow.period[p].perfect,
        mine: leaderRow.user_id === doc.user_id
      }
    };
  }
  return out;
}

/** UTC+8 的三个周期起点（毫秒时间戳）：今天 0 点 / 本周一 0 点 / 本月 1 号 0 点 */
function periodStarts(now) {
  const t = new Date(now + 8 * 3600 * 1000);   // 平移到 UTC+8 后按 UTC 读字段
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const d = t.getUTCDate();
  const dow = t.getUTCDay();                    // 0=周日
  const mondayOffset = dow === 0 ? 6 : dow - 1;
  const DAY = 86400000;
  const TZ = 8 * 3600 * 1000;
  const dayStart = Date.UTC(y, m, d) - TZ;
  return {
    day: dayStart,
    week: dayStart - mondayOffset * DAY,
    month: Date.UTC(y, m, 1) - TZ
  };
}

/** 荣誉词：全对 > 第一 > 打败绝大多数 */
function badgeOf(rank, total, beat, perfect) {
  if (perfect && rank === 1) return '🏆 全对且最快';
  if (perfect) return '🏅 全对通关';
  if (total >= 3 && rank === 1) return '🥇 本组最快';
  if (total >= 5 && beat >= 90) return '🔥 打败 ' + beat + '% 的人';
  return '';
}

/* ------------------------------------------------------------------ */
/* 榜单                                                                */
/* ------------------------------------------------------------------ */

async function onBoard(openid, event) {
  const user = await getUser(openid);
  const key = cleanKey(event.key);
  const limit = clampInt(event.limit, 1, BOARD_LIMIT);

  const res = await readWithCreate(COLL.scores, async () =>
    db.collection(COLL.scores).where({ key: key })
      .orderBy('seconds', 'asc').limit(limit).get());

  const rows = (res && res.data) || [];
  const total = await db.collection(COLL.scores).where({ key: key }).count()
    .then(r => r.total).catch(() => rows.length);

  // 昵称/头像从 users 取一次批量补齐（榜单不该显示一串 openid）
  const ids = rows.map(r => r.user_id).filter(Boolean);
  const users = {};
  if (ids.length) {
    const us = await db.collection(COLL.users).where({ _id: _.in(ids) })
      .limit(BOARD_LIMIT).get().catch(() => null);
    ((us && us.data) || []).forEach(u => { users[u._id] = u; });
  }

  const list = rows.map((r, i) => {
    const u = users[r.user_id] || {};
    return {
      rank: i + 1,
      seconds: r.seconds,
      secondsText: fmtSeconds(r.seconds),
      count: r.count,
      perfect: !!r.perfect,
      nickname: u.nickname || '',
      avatar: u.avatar || '',
      mine: !!(user && user._id === r.user_id)
    };
  });

  return ok({ key: key, total: total, list: list });
}

/* ------------------------------------------------------------------ */
/* 昵称 / 头像                                                         */
/* ------------------------------------------------------------------ */

async function onProfile(openid, event) {
  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先进入小程序首页完成初始化');

  const patch = {};
  if (typeof event.nickname === 'string') patch.nickname = String(event.nickname).trim().slice(0, 16);
  if (typeof event.avatar === 'string' && event.avatar) patch.avatar = String(event.avatar).slice(0, 300);
  if (!Object.keys(patch).length) return ok({ saved: false });

  patch.updated_at = Date.now();

  // update 对"字段不存在"也能新增，但若文档结构异常会失败 → 退回 set
  const done = await db.collection(COLL.users).doc(user._id)
    .update({ data: patch }).then(() => true).catch(() => false);

  if (!done) return fail('PROFILE_SAVE_FAIL', '资料保存失败，请稍后重试');
  return ok({ saved: true, nickname: patch.nickname || '', avatar: patch.avatar || '' });
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function getUser(openid) {
  return db.collection(COLL.users).where({ openid: openid }).limit(1).get()
    .then(r => (r.data && r.data[0]) || null)
    .catch(() => null);
}

function cleanKey(k) {
  var s = String(k || '').trim().slice(0, 80);
  return s || 'book:zk';
}

function clampInt(v, min, max) {
  var n = Number(v);
  if (!isFinite(n)) return min;
  n = Math.floor(n);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function fmtSeconds(s) {
  s = Number(s) || 0;
  var m = Math.floor(s / 60);
  var sec = s % 60;
  return m ? (m + ' 分 ' + sec + ' 秒') : (sec + ' 秒');
}

function isMissingColl(e) {
  var msg = String((e && e.errMsg) || (e && e.message) || e || '');
  return /-502005|not exist|Collection doesn/.test(msg);
}

async function createCollection(name) {
  try { await db.createCollection(name); return true; }
  catch (e) {
    // 已经存在（并发创建）也算成功
    return /already exists|已存在|-501001/.test(String((e && e.errMsg) || e));
  }
}

/**
 * 集合不存在时先建再读一次。
 * 为什么不 try/catch 了事：新建的云环境里 drill_scores 根本不存在，
 * 直接读会 -502005，用户看到的就是"榜单永远空白"。
 */
async function readWithCreate(coll, readFn) {
  try {
    return await readFn();
  } catch (e) {
    if (!isMissingColl(e)) return null;
    await createCollection(coll);
    return await readFn().catch(() => null);
  }
}

function ok(data) {
  return Object.assign({ ok: true, _v: VERSION }, data || {});
}

function fail(code, message) {
  return { ok: false, code: code, message: message, _v: VERSION };
}
