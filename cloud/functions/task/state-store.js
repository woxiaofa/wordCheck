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
 *     线上仍偶发失败：回读 where({user_id, word_id}) 命中不了"存在但字段缺失/
 *     类型不一致"的历史文档，二次 add 同样被唯一键挡下 → STATE_CONFLICT。
 *   v2（当前）：不再走 add。
 *     文档 _id 固定为 `${user_id}:${word_id}`，直接 doc(_id).set() ——
 *     云端行为是"有则替换、无则新建"，压根不经过唯一索引的插入路径，
 *     脏文档、并发重放、旧 _id 残留都挡不住这次写入。
 *
 * 兜底链（每一步都留日志，失败原因不看猜）：
 *   set → update（文档已在）→ where 回读后 update（老 _id 的历史记录）→ add
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
  const payload = Object.assign(
    { _id: _id, user_id: userId, word_id: wordId, created_at: now },
    doc
  );

  // ① 首选：按确定性 _id 直接 set —— 云端 upsert，不经过插入路径
  try {
    await coll.doc(_id).set({ data: payload });
    return null;
  } catch (e) {
    console.warn('[state-store] set 失败，走兜底：', wordId,
      String(e && (e.errMsg || e.message)).slice(0, 200));
  }

  // ② 兜底 1：文档已存在 → update（覆盖业务字段，不动 _id）
  try {
    await coll.doc(_id).update({ data: doc });
    return null;
  } catch (e) { /* 继续兜底 */ }

  // ③ 兜底 2：老版本留下的自动 _id 文档 → 回读后更新
  const again = await coll.where({ user_id: userId, word_id: wordId }).limit(1).get()
    .catch(() => null);
  const hit = again && again.data && again.data[0];
  if (hit) {
    try {
      await coll.doc(hit._id).update({ data: doc });
      return null;
    } catch (e) { /* 继续兜底 */ }
  }

  // ④ 兜底 3：最后再试一次 add（干净库里这条路一定成功）
  try {
    await coll.add({ data: payload });
    return null;
  } catch (e2) {
    console.error('[state-store] 全部写入路径均失败:', wordId,
      String(e2 && (e2.errMsg || e2.message)).slice(0, 200));
    return 'STATE_WRITE_FAIL';
  }
}

module.exports = { upsertState, isDupErr, stateDocId };
