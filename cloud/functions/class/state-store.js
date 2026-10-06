/**
 * user_word_state 统一写入器（确定性 _id + 云端 upsert）
 *
 * 背景（内测实锤）：集合里一旦存在 word_id 为空的"脏文档"，唯一索引 (user_id, word_id)
 * 会把所有"空"视为同一个值，之后该用户每条新词插入都会 E11000。
 *
 * 演进：
 *   v1（已废弃）：add → 撞唯一键 → 清脏 → 回读 → 重试 add。
 *   v2（已废弃）：doc(_id).set({data}) 的 data 里带了 _id → 必抛 -501007；
 *     兜底 update 对不存在的文档静默 updated:0 被当成功 → 新词永远进不了状态表。
 *   v3（已废弃）：data 不带 _id + update 校验行数。但 2026-10-06 修复实测实锤新漏洞：
 *     add 抛出的 -502001 报错文本含 "Duplicate" 字样被 isDupErr 误判成"撞键=成功"，
 *     而文档实际不存在 → repair 假成功"新建 10 条"，状态表里却一条都没有。
 *   v4（当前）：**所有路径成功后必须回读验证，读不到就不算成功**。
 *     add 即使报撞键也回读：读得到=已存在=成功；读不到=真失败。
 *
 * 兜底链：set(无_id) → update(校验行数) → where 回读命中老文档则 update → add(无_id)+回读验证
 * 返回 null 表示写入成功（已验证读回），字符串为错误码。
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

/** 按 (user_id, word_id) 回读。返回命中文档或 null */
async function readBack(coll, userId, wordId) {
  const r = await coll.where({ user_id: userId, word_id: wordId }).limit(1).get()
    .catch(() => null);
  return (r && r.data && r.data[0]) || null;
}

/**
 * 写入（幂等 upsert，带回读验证）。
 * @returns {Promise<string|null>} null=成功（已验证可读回）；字符串为错误码
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
    if (await readBack(coll, userId, wordId)) return null;
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
  const hit = await readBack(coll, userId, wordId);
  if (hit) {
    try {
      const r2 = await coll.doc(hit._id).update({ data: doc });
      if (!r2 || !r2.stats || Number(r2.stats.updated) > 0) {
        if (await readBack(coll, userId, wordId)) return null;
      }
    } catch (e) { /* 继续兜底 */ }
  }

  // ④ 兜底 3：add（不带 _id，自动主键）。唯一索引 (user_id, word_id) 防重。
  //    ⚠ v4 教训：即使 add 报"撞键"，也必须回读验证 —— -502001 的报错文本
  //    可能含 Duplicate 字样但实际没写入（v3 的假成功事故）
  try {
    await coll.add({ data: payload });
  } catch (e2) {
    if (!isDupErr(e2)) {
      console.error('[state-store] 全部写入路径均失败:', wordId,
        String(e2 && (e2.errMsg || e2.message)).slice(0, 200));
      return 'STATE_WRITE_FAIL';
    }
    // 撞键 → 文档应已存在，落到下面的回读验证
  }
  if (await readBack(coll, userId, wordId)) return null;
  console.error('[state-store] 写入后回读不到（假成功被拦截）:', wordId);
  return 'STATE_WRITE_FAIL';
}

module.exports = { upsertState, isDupErr, stateDocId, readBack };
