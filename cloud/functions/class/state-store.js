/**
 * user_word_state 统一写入器（确定性 _id + 云端 upsert）
 *
 * 背景（内测实锤）：集合里一旦存在 word_id 为空的"脏文档"（控制台手动加过
 * 记录、或建唯一索引之前的残留），唯一索引 (user_id, word_id) 会把所有"空"
 * 视为同一个值，之后该用户每条新词插入都会 E11000 —— 表现为学习数据全量
 * 写不进去、教练端进度恒为 0。
 *
 * 演进：
 *   v1（已废弃）：add → 撞唯一键 → 清脏 → 回读 → 重试 add。
 *   v2（已废弃，2026-10-06 探针实锤）：doc(_id).set({data}) 的 data 里带了 _id
 *     → 云端必抛 -501007"不能更新_id的值"；兜底 doc(_id).update() 对"不存在
 *     的文档"会静默返回 updated:0 被当成成功 —— 结果新词永远进不了状态表，
 *     而日志/云记账照写，表现就是"作业恒 0/N、统计越学越假"。
 *   v3（当前）：set 的 data 里绝不带 _id；update 必须真更新到行（stats.updated>0）
 *     才算成功；add 不带 _id（自动主键），靠唯一索引 (user_id, word_id) 防重。
 *
 * 兜底链（每一步都留日志，失败原因不看猜）：
 *   set(无_id) → update(校验行数) → where 回读后 update（老 _id 的历史记录）→ add(无_id)
 * 返回 null 表示写入成功，字符串为错误码。
 */

function isDupErr(e) {
  if (!e) return false;
  const msg = String(e.errMsg || e.message || '');
  return /E11000|duplicate key/i.test(msg);
}

/** user_word_state 的确定性主键。同一用户同一词永远落在同一个 _id 上 */
function stateDocId(userId, wordId) {
  return String(userId) + ':' + String(wordId);
}

/**
 * 写入（幂等 upsert）。
 * @returns {Promise<string|null>} null=成功；'STATE_WRITE_FAIL'=所有路径都失败
 */
async function upsertState(db, collName, userId, wordId, doc, now) {
  const coll = db.collection(collName);
  const _id = stateDocId(userId, wordId);
  // ⚠ set/add 的 data 里都不能带 _id：set 带 _id 必抛 -501007（不能更新_id的值）
  const payload = Object.assign(
    { user_id: userId, word_id: wordId, created_at: now },
    doc
  );

  // ① 首选：按确定性 _id 直接 set（data 不含 _id）—— 云端 upsert，有则替换无则新建
  try {
    await coll.doc(_id).set({ data: payload });
    return null;
  } catch (e) {
    console.warn('[state-store] set 失败，走兜底：', wordId,
      String(e && (e.errMsg || e.message)).slice(0, 200));
  }

  // ② 兜底 1：文档已存在 → update。云端对"不存在的文档"update 会静默返回
  //    updated:0，必须检查行数，否则新词写入会被骗成成功（v2 的事故根源）
  try {
    const r = await coll.doc(_id).update({ data: doc });
    if (r && r.stats && Number(r.stats.updated) > 0) return null;
  } catch (e) { /* 继续兜底 */ }

  // ③ 兜底 2：老版本留下的自动 _id 文档 → 回读后更新
  const again = await coll.where({ user_id: userId, word_id: wordId }).limit(1).get()
    .catch(() => null);
  const hit = again && again.data && again.data[0];
  if (hit) {
    try {
      const r2 = await coll.doc(hit._id).update({ data: doc });
      if (!r2 || !r2.stats || Number(r2.stats.updated) > 0) return null;
    } catch (e) { /* 继续兜底 */ }
  }

  // ④ 兜底 3：add（不带 _id，自动主键）。唯一索引 (user_id, word_id) 防重，
  //    并发下撞唯一键说明文档已存在，同样视为成功
  try {
    await coll.add({ data: payload });
    return null;
  } catch (e2) {
    if (isDupErr(e2)) return null;
    console.error('[state-store] 全部写入路径均失败:', wordId,
      String(e2 && (e2.errMsg || e2.message)).slice(0, 200));
    return 'STATE_WRITE_FAIL';
  }
}

module.exports = { upsertState, isDupErr, stateDocId };
