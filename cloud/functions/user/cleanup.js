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
 * 两层清理（为什么不能只用按用户的那个）：
 *   - repairUserTasks(db, userId)：只扫该用户的文档，幂等、开销小，
 *     适合"每次写入撞键后"的自愈；
 *   - repairAll(db)：**全库扫**。实锤发现占键的脏文档可能连 user_id 都是空的
 *     ——按 userId scoped 的查询根本看不见它，只有全库扫才能揪出来。
 *     内测期集合很小（几百条），全扫可接受；量起来后要换成按索引前缀清。
 *
 * 胜者规则（与 task 云函数的确定性 _id 一致）：
 *   ① _id === 'daily:{userId}:{date}' 的优先保留（后续写入会命中它，不撞键）；
 *   ② 否则取 updated_at 最新的（最新快照更可信）；
 *   ③ 再否则取 _id 小的，保证结果稳定可复现。
 *   task_date 缺失/为空的文档**整组删除**（它们只会空占索引，没有回放价值）。
 */

const TASK_COLL = 'daily_tasks';

/** 与 task 云函数保持一致的确定性 _id 规则 */
function taskIdOf(userId, date) {
  return 'daily:' + userId + ':' + date;
}

function norm(v) {
  return v === undefined || v === null ? '' : String(v);
}

/** 拉一页文档（全库或按用户），返回 rows；拉不到按空处理 */
function fetchPage(db, userId, skip) {
  var q = db.collection(TASK_COLL);
  if (userId !== undefined) q = q.where({ user_id: userId });
  return q.skip(skip).limit(100).get().catch(function () { return null; })
    .then(function (res) { return (res && res.data) || []; });
}

/** 删一批文档，返回真正删掉的篇数 */
function removeDocs(db, docs) {
  var chain = Promise.resolve();
  var removed = 0;
  docs.forEach(function (d) {
    chain = chain.then(function () {
      return db.collection(TASK_COLL).doc(d._id).remove()
        .then(function () { removed++; })
        .catch(function () { });
    });
  });
  return chain.then(function () { return removed; });
}

/** 把 rows 按 (user_id, task_date) 分组；空日期单独一组 key=''（user 部分丢进 multi 键名） */
function groupRows(rows) {
  var groups = new Map();
  rows.forEach(function (d) {
    var u = norm(d.user_id);
    var date = norm(d.task_date);
    var key = date === '' ? '@empty@' + u + '@' + d._id : u + '|' + date;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  });
  return groups;
}

/**
 * 清理某用户的重复任务文档
 * @returns {Promise<{scanned:number, groups:number, removed:number, kept:number}>}
 */
function repairUserTasks(db, userId) {
  var rows = [];
  var scanned = 0;

  function page(skip) {
    return fetchPage(db, userId, skip).then(function (r) {
      rows = rows.concat(r);
      scanned += r.length;
      if (r.length < 100) return null;
      return page(skip + 100);
    });
  }

  return page(0).then(function () {
    return cleanGroups(db, groupRows(rows));
  }).then(function (r) {
    r.scanned = scanned;
    return r;
  });
}

/**
 * 全库清理：不管文档属于谁（含 user_id 为空的孤儿文档）。
 * @returns {Promise<{scanned:number, removed:number}>}
 */
function repairAll(db) {
  var rows = [];
  var scanned = 0;

  function page(skip) {
    return fetchPage(db, undefined, skip).then(function (r) {
      rows = rows.concat(r);
      scanned += r.length;
      if (r.length < 100) return null;
      return page(skip + 100);
    });
  }

  return page(0).then(function () {
    return cleanGroups(db, groupRows(rows));
  }).then(function (r) {
    return { scanned: scanned, removed: r.removed };
  });
}

/**
 * 分组清理的公共实现：空日期组整组删；同键多份只留胜者。
 * @returns {Promise<{removed:number, kept:number}>}
 */
function cleanGroups(db, groups) {
  var removed = 0;
  var kept = 0;
  var chain = Promise.resolve();

  groups.forEach(function (list, key) {
    chain = chain.then(function () {
      // task_date 缺失/为空：旧格式脏文档，只会空占唯一索引，整组删掉
      if (key.indexOf('@empty@') === 0) {
        return removeDocs(db, list).then(function (n) { removed += n; });
      }
      if (list.length <= 1) {
        kept += list.length;
        return null;
      }
      var parts = key.split('|');
      list.sort(function (a, b) { return cmpWinner(a, b, parts[0], parts[1]); });
      kept++;
      return removeDocs(db, list.slice(1)).then(function (n) { removed += n; });
    });
  });

  return chain.then(function () {
    return { removed: removed, kept: kept };
  });
}

function cmpWinner(a, b, userId, date) {
  var want = taskIdOf(userId, date);
  var aw = a._id === want ? 1 : 0;
  var bw = b._id === want ? 1 : 0;
  if (aw !== bw) return bw - aw;                       // 确定性 _id 优先
  var au = Number(a.updated_at) || 0;
  var bu = Number(b.updated_at) || 0;
  if (au !== bu) return bu - au;                        // 其次取最新
  return String(a._id) < String(b._id) ? -1 : 1;         // 最后兜底，保证可复现
}

/**
 * 体检报告：库里到底有些什么形态的脏数据。
 * 给 cleanup action 带回去 —— "清理有没有生效、为什么没生效"，看一眼就知道。
 */
function diagnose(db) {
  var rows = [];
  function page(skip) {
    return fetchPage(db, undefined, skip).then(function (r) {
      rows = rows.concat(r);
      if (r.length < 100) return null;
      return page(skip + 100);
    });
  }
  return page(0).then(function () {
    var stats = {
      total: rows.length,
      emptyDate: 0,          // task_date 缺失/为空（空占索引的主犯）
      emptyUser: 0,          // user_id 缺失（孤儿文档，按用户清看不见它）
      bothEmpty: 0,
      dupKeys: 0             // (user_id, task_date) 相同但 _id 不同的组数
    };
    var byKey = new Map();
    rows.forEach(function (d) {
      var u = norm(d.user_id);
      var date = norm(d.task_date);
      if (date === '') stats.emptyDate++;
      if (u === '') stats.emptyUser++;
      if (date === '' && u === '') stats.bothEmpty++;
      var k = u + '|' + date;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(d._id);
    });
    byKey.forEach(function (list) {
      if (list.length > 1) stats.dupKeys++;
    });
    // 抽样：最多 5 条脏文档的关键字段，人眼能直接认出是什么时代的旧数据
    stats.samples = rows.filter(function (d) {
      return norm(d.task_date) === '' || norm(d.user_id) === '';
    }).slice(0, 5).map(function (d) {
      return {
        _id: d._id,
        user_id: norm(d.user_id) || '(空)',
        task_date: norm(d.task_date) || '(空)',
        created_at: d.created_at || 0
      };
    });
    return stats;
  });
}

module.exports = {
  TASK_COLL: TASK_COLL,
  taskIdOf: taskIdOf,
  repairUserTasks: repairUserTasks,
  repairAll: repairAll,
  diagnose: diagnose
};
