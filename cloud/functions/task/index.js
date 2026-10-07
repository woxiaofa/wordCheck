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

const { getLocalDate } = require('./time');
const { wordsForStudent } = require('./personal');
const { queryStates, STATE_COLL } = require('./state-store');

const COLL = {
  users: 'users',
  words: 'words',
  state: STATE_COLL,           // v5：读走合并查询（v2+legacy），写不经本函数
  tasks: 'daily_tasks',
  assignments: 'assignments'
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

  // --- 组装：到期复习词 + 未学过的新词（v2+legacy 合并读） ---
  const dueRows = await queryStates(
    db, { user_id: user._id, next_review_at: _.lte(now) },
    { orderBy: { name: 'next_review_at', dir: 'asc' }, limit: DUE_LIMIT,
      field: { word_id: true } }
  );
  const dueIds = dueRows.map((s) => s.word_id);

  const learnedRows = await queryStates(
    db, { user_id: user._id }, { field: { word_id: true } }
  );
  const learnedSet = new Set(learnedRows.map((s) => s.word_id));

  // 词库按词频升序取新词（与本地 books.js 的排序策略一致）
  const allWords = await db.collection(COLL.words)
    .orderBy('freq', 'asc')
    .limit(1000)
    .field({ word: true })
    .get();

  // --- 作业优先：班级里有未完成的作业时，今日新词先清作业 ---
  // 否则"每日任务学的词"和"作业的词"是两套独立挑选，孩子学了一堆、
  // 作业进度却纹丝不动，家长看到的就是"学了 10 个词还剩 10 个"的自相矛盾。
  const assignmentWords = await classAssignmentWords(user);
  const newIds = [];
  for (const w of assignmentWords) {
    if (newIds.length >= NEW_COUNT) break;
    if (!learnedSet.has(w) && !newIds.includes(w)) newIds.push(w);
  }
  for (const w of allWords.data) {
    if (newIds.length >= NEW_COUNT) break;
    if (!learnedSet.has(w.word) && !newIds.includes(w)) newIds.push(w);
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

  // 用 doc().set() 语义写任务（文档不存在则创建）—— 从根上消除 add 撞唯一键的
  // -502001（2026-10-07 实锤：库里旧格式脏数据 task_date 为空，撞 (user_id+task_date)
  // 唯一索引且 _id 对不上，add 必炸）。set 的 data 不能带 _id（-501007）。
  const saveDoc = Object.assign({}, doc);
  delete saveDoc._id;
  try {
    await db.collection(COLL.tasks).doc(taskId).set({ data: saveDoc });
  } catch (e) {
    // set-upsert 仍可能撞唯一索引：插入瞬间，库里 task_date 为空的旧格式脏文档
    // 占住了 (user_id, task_date) 索引（dup key 显示 task_date: null 即此因）。
    // 自愈：删掉该用户的空日期脏文档后重试一次；重试还不行
    // （如今天日期的旧文档占键）就继续往下走业务键回放兜底。
    const msg = (e && (e.errMsg || e.message)) || '';
    if (/E11000|duplicate|502001/i.test(msg)) {
      await db.collection(COLL.tasks)
        .where({ user_id: user._id, task_date: _.eq(null) })
        .remove()
        .catch(() => null);
      try {
        await db.collection(COLL.tasks).doc(taskId).set({ data: saveDoc });
        const words = await fetchWords(newIds.concat(dueIds));
        return ok({ task: taskView(doc), words, date: today });
      } catch (e2) {
        // 重试仍撞键：走下面的业务键回放
      }
    }
    // 其他失败：按业务键找回照常回放
    const again = await db.collection(COLL.tasks).doc(taskId).get().catch(() => null);
    let t = again && again.data;
    if (!t) {
      const byBiz = await db.collection(COLL.tasks)
        .where({ user_id: user._id, task_date: today })
        .limit(1).get().catch(() => null);
      t = byBiz && byBiz.data && byBiz.data[0];
    }
    if (!t) {
      return fail('TASK_CREATE_FAIL', (e && e.errMsg) || '任务创建失败');
    }
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

/**
 * 孩子所在班级的作业词单（归一成 word 文本，按作业布置顺序拼在一起）。
 * 不在班级 / 没作业 / 查询失败都返回 []，任务组装逻辑不受影响。
 * 注意词单 ID 兼容：老作业存的是 words._id，新作业直接存文本 —— 都要接住。
 */
async function classAssignmentWords(user) {
  // 教练/家长是布置作业的人：自己的"今日任务"不该被班级作业词单占用，
  // 自己背单词就按默认词库走（内测实锤：家长首页被作业卡占满）。
  if (!user.class_id || user.role === 'coach') return [];
  const asgRes = await db.collection(COLL.assignments)
    .where({ class_id: user.class_id })
    .limit(20)
    .get()
    .catch(() => ({ data: [] }));
  const rawIds = [];
  for (const a of (asgRes.data || [])) {
    // 个性化作业：读"我"的专属词单（没有就当场生成并固化），
    // 否则今日任务会把全班词单塞给这个孩子，和他自己的作业对不上
    const texts = a.personalized
      ? await wordsForStudent(db, a, user._id)
      : (a.word_ids || []);
    texts.forEach(w => rawIds.push(w));
  }
  if (!rawIds.length) return [];

  const wRes = await db.collection(COLL.words)
    .where({ _id: _.in(rawIds) })
    .limit(1000)
    .field({ word: true })
    .get()
    .catch(() => ({ data: [] }));
  if (!(wRes.data || []).length) return rawIds;   // 一个都没命中：本来就是文本
  const map = {};
  wRes.data.forEach(w => { map[w._id] = w.word; });
  return rawIds.map(id => map[id] || id);
}

const VERSION = 'task-20261007-nullfix';
const ok = (data) => ({ ok: true, _v: VERSION, data });
const fail = (code, message) => ({ ok: false, _v: VERSION, code, message });
