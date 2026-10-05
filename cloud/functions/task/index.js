/**
 * 云函数：task —— 今日任务快照
 *
 * 核心约定（docs/实施手册.md 第六、八章）：
 *   1) 幂等：同一天多次调用返回同一快照。实现方式是确定性 _id =
 *      "daily:{userId}:{today}"，重复创建直接命中唯一键冲突后回读。
 *   2) 快照冻结：生成后当天不再变（当日答错的词由 review 云函数
 *      追加进 snapshot_json.repeat，这是唯一允许的变更）。
 *   3) 时区：一律用 shared/time.js 的 getLocalDate()（UTC+8）。
 *   4) 列表查询限制字段 + 上限，禁止全量拉取。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const { getLocalDate } = require('./shared/time');

const COLL = {
  users: 'users',
  words: 'words',
  state: 'user_word_state',
  tasks: 'daily_tasks'
};

/** 每日新词数（与小程序本地默认一致） */
const NEW_COUNT = 10;
/** 复习到期词单次上限 */
const DUE_LIMIT = 100;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('NO_IDENTITY', '无法识别用户身份');

  switch (event.action) {
    case 'today': return onToday(OPENID, event);
    default:      return fail('BAD_ACTION', '未知 action: ' + event.action);
  }
};

async function onToday(openid) {
  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先调用 user.login');

  const now = Date.now();
  const today = getLocalDate(now);
  const taskId = 'daily:' + user._id + ':' + today;

  // --- 先读：已生成则直接回放快照（幂等） ---
  const existing = await db.collection(COLL.tasks).doc(taskId).get()
    .catch(() => null);
  if (existing && existing.data) {
    const t = existing.data;
    const words = await fetchWords(collectWordIds(t));
    return ok({ task: taskView(t), words, date: today });
  }

  // --- 组装：到期复习词 + 未学过的新词 ---
  const dueRes = await db.collection(COLL.state)
    .where({ user_id: user._id, next_review_at: _.lte(now) })
    .orderBy('next_review_at', 'asc')
    .limit(DUE_LIMIT)
    .field({ word_id: true })
    .get();
  const dueIds = dueRes.data.map((s) => s.word_id);

  const learnedRes = await db.collection(COLL.state)
    .where({ user_id: user._id })
    .limit(1000)
    .field({ word_id: true })
    .get();
  const learnedSet = new Set(learnedRes.data.map((s) => s.word_id));

  // 词库按词频升序取新词（与本地 books.js 的排序策略一致）
  const allWords = await db.collection(COLL.words)
    .orderBy('freq', 'asc')
    .limit(1000)
    .field({ word: true })
    .get();
  const newIds = [];
  for (const w of allWords.data) {
    if (newIds.length >= NEW_COUNT) break;
    if (!learnedSet.has(w.word)) newIds.push(w.word);
  }

  const snapshot = {
    new: newIds,
    review: dueIds,
    repeat: []            // 当日答错的词由 review 云函数往这里追加
  };

  const doc = {
    _id: taskId,
    user_id: user._id,
    task_date: today,
    snapshot_json: snapshot,
    new_count: newIds.length,
    review_count: dueIds.length,
    quiz_count: 10,
    assigned_by: '',      // 家长/老师布置时填对方 userId
    class_id: '',
    completed_at: 0,
    created_at: now,
    updated_at: now
  };

  // 确定性 _id：并发重复创建会命中唯一键冲突，回读即可
  try {
    await db.collection(COLL.tasks).add({ data: doc });
  } catch (e) {
    const again = await db.collection(COLL.tasks).doc(taskId).get().catch(() => null);
    if (!again || !again.data) {
      return fail('TASK_CREATE_FAIL', (e && e.errMsg) || '任务创建失败');
    }
    const t = again.data;
    const words = await fetchWords(collectWordIds(t));
    return ok({ task: taskView(t), words, date: today });
  }

  const words = await fetchWords(newIds.concat(dueIds));
  return ok({ task: taskView(doc), words, date: today });
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
async function getUser(openid) {
  const r = await db.collection(COLL.users).where({ openid }).limit(1).get();
  return r.data && r.data[0] ? r.data[0] : null;
}

/** 快照里出现过的所有词 id（含当日 repeat） */
function collectWordIds(taskDoc) {
  const s = taskDoc.snapshot_json || {};
  return [].concat(s.new || [], s.review || [], s.repeat || []);
}

/** 按 word 字符串批量取词库详情（_.in 单次上限有讲究，按 100 一批） */
async function fetchWords(wordIds) {
  const uniq = Array.from(new Set(wordIds.filter(Boolean)));
  if (!uniq.length) return [];
  const out = [];
  for (let i = 0; i < uniq.length; i += 100) {
    const batch = uniq.slice(i, i + 100);
    const res = await db.collection(COLL.words)
      .where({ word: _.in(batch) })
      .limit(100)
      .get();
    out.push.apply(out, res.data);
  }
  // 保持快照顺序（新词在前）
  const byWord = new Map(out.map((w) => [w.word, w]));
  return uniq.map((id) => byWord.get(id)).filter(Boolean);
}

/** 下发给客户端的任务视图 */
function taskView(t) {
  const s = t.snapshot_json || {};
  return {
    date: t.task_date,
    new: s.new || [],
    review: s.review || [],
    repeat: s.repeat || [],
    newCount: t.new_count,
    reviewCount: t.review_count,
    quizCount: t.quiz_count,
    completedAt: t.completed_at || 0
  };
}

const VERSION = 'task-20261005';
const ok = (data) => ({ ok: true, _v: VERSION, data });
const fail = (code, message) => ({ ok: false, _v: VERSION, code, message });
