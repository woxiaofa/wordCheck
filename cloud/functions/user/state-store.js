/**
 * user_word_state 统一读写器 v5 —— 集合级迁移版
 *
 * 背景（内测实锤时间线）：
 *   v1  add → 撞唯一键 → 清脏 → 重试。败于：唯一索引 (user_id, word_id) 把 null 视同值。
 *   v2  doc(_id).set 的 data 带 _id → 必抛 -501007；update 对不存在文档静默 updated:0 假成功。
 *   v3  data 不带 _id。但 add 报错文本含 Duplicate 被误判"撞键=成功" → repair 假成功。
 *   v4  所有路径成功后必须回读验证。如实报错生效了，但 v1 集合的写入**仍然全路径失败**
 *       （set/add 双双 -502001，而同函数写 review_logs 一直正常）——矛头指向该集合自身的
 *       唯一索引损坏/隐形残留文档（扫描看不到却占着索引，插入必撞）。
 *   v5（当前）：**放弃在坏集合上继续修，整体迁到全新集合 user_word_state_v2**：
 *       - 无唯一索引，防重靠确定性 _id（user_id:word_id）+ set upsert；
 *       - 读取一律走 queryStates：v2 + v1(legacy) 双查合并，v2 优先 —— 历史数据不丢；
 *       - 回读验证契约不变：宣告成功前必须读得回。
 */

/** 新家集合：无唯一索引 */
const STATE_COLL = 'user_word_state_v2';
/** 旧家集合：只读兼容，历史记录仍参与合并 */
const LEGACY_COLL = 'user_word_state';

function isDupErr(e) {
  if (!e) return false;
  const msg = String(e.errMsg || e.message || '');
  return /E11000|duplicate key/i.test(msg);
}

/** 确定性主键。同一用户同一词永远落在同一个 _id 上（冒号格式，探针专项验证过） */
function stateDocId(userId, wordId) {
  return String(userId) + ':' + String(wordId);
}

function mergeKey(d) {
  return String(d.user_id) + '\u0001' + String(d.word_id);
}

/**
 * 统一读：v2 + legacy 双查合并（同词 v2 优先），调用方无感知。
 * @param {Object} opts { orderBy:{name,dir}, field, limit }
 */
async function queryStates(db, where, opts) {
  opts = opts || {};
  async function run(name) {
    let q = db.collection(name).where(where);
    if (opts.orderBy) q = q.orderBy(opts.orderBy.name, opts.orderBy.dir || 'asc');
    if (opts.field) q = q.field(opts.field);
    const r = await q.limit(opts.limit || 1000).get().catch(() => ({ data: [] }));
    return r.data || [];
  }
  const fresh = await run(STATE_COLL);
  const legacy = await run(LEGACY_COLL);
  const seen = {};
  const out = [];
  fresh.forEach((d) => { out.push(d); seen[mergeKey(d)] = 1; });
  legacy.forEach((d) => { if (!seen[mergeKey(d)]) out.push(d); });
  return out;
}

/** 按 (user_id, word_id) 回读（含 legacy）。返回命中文档或 null */
async function readBack(db, userId, wordId) {
  const rows = await queryStates(db, { user_id: userId, word_id: wordId }, { limit: 1 });
  return rows[0] || null;
}

/* ---- 集合自动创建 ----
 * 云数据库的集合必须显式存在，往不存在的集合写会报 -502005
 * "Db or Table not exist"（2026-10-07 实锤：v2 新集合忘了建，写入全挂）。
 * createCollection 是服务端（wx-server-sdk）专属能力；客户端副本没有
 * 这个方法，typeof 守卫直接跳过。成功与否记入模块级缓存，热实例内只建一次。 */
const _ensured = {};
async function ensureCollection(db, name) {
  if (typeof db.createCollection !== 'function') return false;
  if (_ensured[name]) return true;
  try {
    await db.createCollection(name);
    _ensured[name] = true;
    return true;
  } catch (e) {
    // 并发/重复创建会报 "already exists" —— 集合在 = 目标达成。
    // ⚠ 只有真实创建成功才进缓存：already-exists 分支不缓存，否则
    // "集合被人删了再重建"的场景会被过期缓存挡住（测试 ⑬ 实锤过）
    if (/exists/i.test(String((e && (e.errMsg || e.message)) || e))) {
      return true;
    }
    console.error('[state-store] createCollection 失败:', name,
      String((e && (e.errMsg || e.message)) || e).slice(0, 120));
    return false;
  }
}

/** 单次完整写入尝试（set → update 老文档 → add），成功返回 null，失败返回错误串 */
async function tryWrite(db, userId, wordId, doc, now) {
  const coll = db.collection(STATE_COLL);
  const _id = stateDocId(userId, wordId);
  // ⚠ set/add 的 data 里都不能带 _id：云端规定 set 带 _id 必抛 -501007
  const payload = Object.assign(
    { user_id: userId, word_id: wordId, created_at: now },
    doc
  );
  let lastErr = '';

  // ① 首选：确定性 _id 直接 set（云端 upsert：有则替换无则新建）
  try {
    await coll.doc(_id).set({ data: payload });
    if (await readBack(db, userId, wordId)) return null;
  } catch (e) {
    lastErr = String((e && (e.errMsg || e.message)) || e).slice(0, 160);
    console.warn('[state-store] set 失败，走兜底：', wordId, lastErr);
  }

  // ② 兜底：老版本自动 _id 的同词文档（含 legacy）→ 按其真实 _id 更新
  const hit = await readBack(db, userId, wordId);
  if (hit && hit._id !== _id) {
    const targets = [db.collection(STATE_COLL), db.collection(LEGACY_COLL)];
    for (const t of targets) {
      try {
        const r = await t.doc(hit._id).update({ data: doc });
        if (r && r.stats && Number(r.stats.updated) > 0) return null;
        if (await readBack(db, userId, wordId)) return null;
      } catch (e) {
        lastErr = String((e && (e.errMsg || e.message)) || e).slice(0, 160);
      }
    }
  }

  // ③ 最后兜底：add（自动主键）。v2 无唯一索引不会撞键；确定性 _id ①失败时保证数据不丢
  try {
    await coll.add({ data: payload });
    if (await readBack(db, userId, wordId)) return null;
    lastErr = 'add 后回读不到';
  } catch (e2) {
    lastErr = String((e2 && (e2.errMsg || e2.message)) || e2).slice(0, 160);
  }

  console.error('[state-store] 全部写入路径失败:', wordId, lastErr);
  return 'STATE_WRITE_FAIL:' + lastErr;
}

/**
 * 写入（幂等 upsert 到 v2，成功前回读验证）。
 * 集合不存在（-502005）时自动 createCollection 后整体重试一次。
 * @returns {Promise<string|null>} null=成功；字符串为错误码（含底层报错摘要，供前端流水展示）
 */
async function upsertState(db, userId, wordId, doc, now) {
  let err = await tryWrite(db, userId, wordId, doc, now);
  if (err && /-502005|not exist/i.test(err)) {
    const built = await ensureCollection(db, STATE_COLL);
    if (built) err = await tryWrite(db, userId, wordId, doc, now);
  }
  return err;
}

module.exports = {
  STATE_COLL,
  LEGACY_COLL,
  upsertState,
  queryStates,
  readBack,
  ensureCollection,
  isDupErr,
  stateDocId
};
