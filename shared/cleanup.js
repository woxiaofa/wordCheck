/**
 * daily_tasks 脏数据清理（共享模块）
 *
 * 背景（2026-10-23 用户实锤）：控制台刷 -502001 duplicate key，
 * collection: daily_tasks，dup key 里 task_date 是空值。
 * 成因是历史版本用 add() 写入，留下了两类脏文档：
 *   ① task_date 为空/缺失的旧格式文档；
 *   ② 同一 (user_id, task_date) 有多份、_id 各不相同的重复文档。
 * 这两类文档会一直占着唯一索引，导致当天快照写不进去 —— 而快照写不进去，
 * 家长看到的数据就是空的。所以必须能清理，而且最好能自愈。
 *
 * 设计：
 *   - repairUserTasks(db, userId)：扫该用户全部任务文档，按 task_date 分组，
 *     每组只留"胜者"，删掉其余；顺带把空日期文档也清掉。返回统计。
 *   - 清理是**幂等**的：跑第二次 removed 应为 0。
 *   - 只处理调用者自己的数据（按 user_id 限定），不碰别人的。
 *
 * 胜者规则（与 task 云函数的确定性 _id 一致）：
 *   ① _id === 'daily:{userId}:{date}' 的优先保留（后续写入会命中它，不撞键）；
 *   ② 否则取 updated_at 最新的（最新快照更可信）；
 *   ③ 再否则取 _id 小的，保证结果稳定可复现。
 */

const TASK_COLL = 'daily_tasks';

/** 与 task 云函数保持一致的确定性 _id 规则 */
function taskIdOf(userId, date) {
  return 'daily:' + userId + ':' + date;
}

/**
 * 清理某用户的重复任务文档
 * @param {object} db cloud.database()
 * @param {string} userId
 * @returns {Promise<{scanned:number, groups:number, removed:number, kept:number}>}
 */
async function repairUserTasks(db, userId) {
  const groups = new Map();
  let scanned = 0;
  let skip = 0;

  for (;;) {
    const res = await db.collection(TASK_COLL)
      .where({ user_id: userId })
      .skip(skip)
      .limit(100)
      .get()
      .catch(() => null);

    const rows = (res && res.data) || [];
    rows.forEach(function (d) {
      const key = d.task_date == null ? '' : String(d.task_date);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    });

    scanned += rows.length;
    if (rows.length < 100) break;
    skip += 100;
  }

  let removed = 0;
  const kept = [];

  const keys = Array.from(groups.keys());
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const list = groups.get(key);

    // task_date 缺失/为空：旧格式脏文档，空占着 (user_id, task_date) 唯一索引，整组删掉
    if (key === '') {
      for (let m = 0; m < list.length; m++) {
        const gone = await db.collection(TASK_COLL).doc(list[m]._id).remove()
          .then(function () { return true; }).catch(function () { return false; });
        if (gone) removed++;
      }
      continue;
    }

    if (list.length <= 1) {
      if (list.length === 1) kept.push(list[0]._id);
      continue;
    }

    list.sort(function (a, b) { return cmpWinner(a, b, userId, key); });
    kept.push(list[0]._id);
    for (let j = 1; j < list.length; j++) {
      const gone = await db.collection(TASK_COLL)
        .doc(list[j]._id)
        .remove()
        .then(function () { return true; })
        .catch(function () { return false; });
      if (gone) removed++;
    }
  }

  return { scanned: scanned, groups: keys.length, removed: removed, kept: kept.length };
}

function cmpWinner(a, b, userId, date) {
  const want = taskIdOf(userId, date);
  const aw = a._id === want ? 1 : 0;
  const bw = b._id === want ? 1 : 0;
  if (aw !== bw) return bw - aw;                       // 确定性 _id 优先
  const au = Number(a.updated_at) || 0;
  const bu = Number(b.updated_at) || 0;
  if (au !== bu) return bu - au;                        // 其次取最新
  return String(a._id) < String(b._id) ? -1 : 1;         // 最后兜底，保证可复现
}

module.exports = {
  TASK_COLL: TASK_COLL,
  taskIdOf: taskIdOf,
  repairUserTasks: repairUserTasks
};
