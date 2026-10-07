/**
 * 个性化作业：按"这个孩子现在最需要练什么"裁剪词单。
 *
 * 为什么独立成模块：class（布置/读作业/催学）和 task（今日任务优先作业词）
 * 都要用同一套取词规则。若两边各写一份，早晚出现
 * "作业里说还剩 3 个、今日任务却塞了另外 5 个词"的接缝错位。
 * 因此规则只有一份真相（本文件），由 scripts/sync-shared.js 分发。
 */

var stateStore = require('./state-store');

/** 掌握档位：与 shared/srs.isMastered 同口径（stage ≥5，间隔 15 天+） */
var MASTER_STAGE = 5;

/** 学员专属词单集合（快照） */
var ASG_STUDENT_COLL = 'assignment_students';

/**
 * 取词排序：错词/忘了 > 模糊 > 到期复习 > 没学过 > 已学未到期 > 已掌握
 * 已掌握的词默认剔除 —— 已经会了的孩子不必重复抄写；只有候选不够时才拿它凑数。
 *
 * @param {string[]} pool 候选词（文本）
 * @param {Object} stateMap { [word]: stateRow }
 * @param {number} count 需要几个词
 * @param {number} now
 * @returns {{ words: string[], wrongCount: number, skippedMastered: number }}
 */
function personalPick(pool, stateMap, count, now) {
  var wrong = [], vague = [], due = [], fresh = [], rest = [], mastered = [];
  pool.forEach(function (w) {
    var s = stateMap[w];
    if (!s) { fresh.push(w); return; }                                        // 没学过
    if ((s.wrong_count || 0) > 0 || s.last_feedback === 'forgot') { wrong.push(w); return; }
    if (s.last_feedback === 'vague') { vague.push(w); return; }
    if ((s.stage || 0) >= MASTER_STAGE) { mastered.push(w); return; }          // 已掌握
    if (s.next_review_at && s.next_review_at <= now) { due.push(w); return; }  // 到期复习
    rest.push(w);                                                             // 已学但未到期
  });

  var ranked = [].concat(wrong, vague, due, fresh, rest);
  var words = ranked.slice(0, count);
  if (words.length < count) {
    words.push.apply(words, mastered.slice(0, count - words.length));          // 不够才用已掌握的凑
  }
  return {
    words: words,
    wrongCount: Math.min(wrong.length, count),
    // 被"已掌握"规则省下的词数：教练端要能解释"为什么这孩子只做了 7 个"
    skippedMastered: Math.max(0, Math.min(mastered.length, ranked.length - words.length))
  };
}

/** 词单 ID 归一：把可能存在的 words._id 翻译成 word 文本 */
async function toWordTexts(db, ids) {
  if (!ids || !ids.length) return [];
  var res = await db.collection('words')
    .where({ _id: db.command.in(ids) })
    .limit(1000)
    .field({ word: true })
    .get()
    .catch(() => ({ data: [] }));
  if (!(res.data || []).length) return ids;   // 一个都没命中：本来就是文本
  var map = {};
  res.data.forEach(function (w) { map[w._id] = w.word; });
  return ids.map(function (id) { return map[id] || id; });
}

/**
 * 取某个学员在这份作业上的词单。
 * 非个性化 → 全班同一张；个性化 → 读该学员快照，没有就当场生成并固化。
 *
 * 为什么要固化快照：词单若随学习进度实时变化，孩子昨天做完 5/10、
 * 今天因为又掌握了一个词变成 4/9，家长只会以为数据又坏了。
 */
async function wordsForStudent(db, a, userId) {
  if (!a.personalized) return toWordTexts(db, a.word_ids || []);
  var _id = a._id + ':' + userId;

  var exist = await db.collection(ASG_STUDENT_COLL).doc(_id).get().catch(() => null);
  if (exist && exist.data && (exist.data.word_ids || []).length) return exist.data.word_ids;

  var pool = await toWordTexts(db,
    (a.pool_ids && a.pool_ids.length) ? a.pool_ids : (a.word_ids || []));
  var rows = pool.length
    ? await stateStore.queryStates(db, { user_id: userId, word_id: db.command.in(pool) })
      .catch(() => [])
    : [];
  var map = {};
  rows.forEach(function (s) { map[s.word_id] = s; });

  var pick = personalPick(pool, map, a.count || pool.length, Date.now());
  var data = {
    assignment_id: a._id,
    user_id: userId,
    word_ids: pick.words,
    count: pick.words.length,
    wrong_top: pick.wrongCount,
    skipped_mastered: pick.skippedMastered,
    created_at: Date.now()
  };
  // 集合可能还没建（线上实锤过 -502005）：先建再写；都失败就返回当场算的词单，
  // 本轮照样可用，只是下次会重算 —— 绝不因为落库失败卡住学生。
  if (typeof db.createCollection === 'function') {
    await stateStore.ensureCollection(db, ASG_STUDENT_COLL).catch(() => false);
  }
  await db.collection(ASG_STUDENT_COLL).doc(_id).set({ data: data }).catch(() => {});
  return pick.words;
}

module.exports = {
  MASTER_STAGE: MASTER_STAGE,
  ASG_STUDENT_COLL: ASG_STUDENT_COLL,
  personalPick: personalPick,
  toWordTexts: toWordTexts,
  wordsForStudent: wordsForStudent
};
