/**
 * user_word_state 统一写入器（带自愈）
 *
 * 背景（内测实锤）：集合里一旦存在 word_id 为空的"脏文档"（控制台手动加过
 * 记录、或建唯一索引之前的残留），唯一索引会把所有"空"视为同一个值，
 * 之后该用户每条新词插入都会 E11000 —— 表现为学习数据全量写不进去、
 * 教练端进度恒为 0，报错还是裸的天书。
 *
 * 策略：
 *   1) 常规 add；
 *   2) 撞唯一键 → 清理该用户名下 word_id 为空的脏文档 → 回读目标词：
 *      命中（并发重复提交场景）改更新；未命中重试一次 add；
 *   3) 仍失败 → 返回 STATE_CONFLICT，云函数日志里有完整现场。
 *
 * 返回 null 表示写入成功，字符串为错误码。
 */

function isDupErr(e) {
  if (!e) return false;
  const msg = String(e.errMsg || e.message || '');
  return /E11000|duplicate key/i.test(msg);
}

async function upsertState(db, collName, userId, wordId, doc, now) {
  const coll = db.collection(collName);
  const payload = Object.assign({ user_id: userId, word_id: wordId, created_at: now }, doc);

  try {
    await coll.add({ data: payload });
    return null;
  } catch (e) {
    if (!isDupErr(e)) throw e;   // 非唯一键冲突（权限/网络等）原样抛出
  }

  // --- 冲突分支：先清该用户 word_id 为空的脏文档 ---
  try {
    const all = await coll.where({ user_id: userId }).limit(100)
      .field({ word_id: true }).get();
    const bad = (all.data || []).filter((d) => d.word_id === null || d.word_id === undefined);
    for (const d of bad) {
      await coll.doc(d._id).remove().catch(() => {});
    }
    if (bad.length) console.log('[state-store] 已清理 word_id 为空的脏文档', bad.length, '条');
  } catch (e) {
    console.warn('[state-store] 清理脏文档失败（继续尝试回读）', e && e.errMsg);
  }

  // --- 回读目标词：并发重复提交会在这里命中，收敛为更新 ---
  const again = await coll.where({ user_id: userId, word_id: wordId }).limit(1).get()
    .catch(() => null);
  const hit = again && again.data && again.data[0];
  if (hit) {
    await coll.doc(hit._id).update({ data: doc });
    return null;
  }

  // --- 重试一次 ---
  try {
    await coll.add({ data: payload });
    return null;
  } catch (e2) {
    console.error('[state-store] 二次写入仍冲突:', wordId, e2 && (e2.errMsg || e2.message));
    return 'STATE_CONFLICT';
  }
}

module.exports = { upsertState, isDupErr };
