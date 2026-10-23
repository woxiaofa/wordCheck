/**
 * daily_tasks 脏数据清理测试（假数据库）
 *
 * 背景：控制台长期刷 -502001 duplicate key（collection: daily_tasks，
 * dup key 里 task_date 是空）。历史版本用 add() 写入，留下了两类脏文档：
 *   ① task_date 缺失的旧格式文档；
 *   ② 同一 (user_id, task_date) 多份、_id 各不相同。
 * 它们占着唯一索引不放，导致当天快照写不进去 —— 家长看到的数据就是空的。
 *
 * 这里刻意复刻线上行为：**按 (user_id, task_date) 建唯一索引，
 * 第二次插同键就抛含 E11000 的 -502001**，并且把"清理前必撞键"也断言出来
 * —— 否则清理逻辑写得再漂亮，也证明不了它真的解决了问题。
 */

var assert = require('assert');
var Module = require('module');

/* ---------------- 带唯一索引的假数据库 ---------------- */

function createFakeDb() {
  var colls = {};
  var idx = { 'daily_tasks': ['user_id', 'task_date'] };
  var log = { dupErrors: 0 };

  function ensure(name) { if (!colls[name]) colls[name] = []; return colls[name]; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function norm(v) { return v === undefined || v === null ? null : String(v); }
  function keyOf(name, doc) {
    var keys = idx[name];
    if (!keys) return null;
    return keys.map(function (k) { return norm(doc[k]); }).join('|');
  }

  function collection(name) {
    var self = {
      get: function () { return Promise.resolve({ data: ensure(name).map(clone) }); },
      skip: function (n) { var rows = ensure(name).slice(n); return { limit: function (m) { rows = rows.slice(0, m); return { get: function () { return Promise.resolve({ data: rows.map(clone) }); } }; } }; },
      doc: function (id) {
        var list = ensure(name);
        var at = -1;
        for (var i = 0; i < list.length; i++) { if (list[i]._id === id) { at = i; break; } }
        return {
          get: function () { return Promise.resolve(at === -1 ? { data: null } : { data: clone(list[at]) }); },
          set: function (o) {
            if (o.data && o.data._id !== undefined) {
              return Promise.reject(new Error('document.set:fail -501007 不能更新_id的值'));
            }
            var data = clone(o.data);
            data._id = id;
            // 云端真实行为：只要有别的文档占了同一个 (user_id, task_date)，insert 就撞键
            var k = keyOf(name, data);
            if (k !== null && list.some(function (d) {
              return d._id !== id && keyOf(name, d) === k;
            })) {
              log.dupErrors++;
              return Promise.reject(new Error(
                'document.set:fail -502001 database request fail. ' +
                '[FailedOperation] E11000 duplicate key error collection: daily_tasks'));
            }
            if (at === -1) list.push(data); else list[at] = data;
            return Promise.resolve({ stats: { updated: 1 } });
          },
          remove: function () {
            if (at !== -1) list.splice(at, 1);
            return Promise.resolve({ stats: { removed: at === -1 ? 0 : 1 } });
          }
        };
      },
      where: function (q) {
        var rows = ensure(name).filter(function (d) { return match(d, q); });
        var chain = {
          limit: function (n) { rows = rows.slice(0, n); return chain; },
          skip: function (n) { rows = rows.slice(n); return chain; },
          get: function () { return Promise.resolve({ data: rows.map(clone) }); },
          remove: function () {
            var ids = rows.map(function (d) { return d._id; });
            colls[name] = ensure(name).filter(function (d) { return ids.indexOf(d._id) < 0; });
            return Promise.resolve({ stats: { removed: ids.length } });
          }
        };
        return chain;
      }
    };
    return self;
  }

  function match(doc, q) {
    for (var k in q) {
      var cond = q[k];
      var val = doc[k];
      if (cond && typeof cond === 'object' && cond.__op) {
        if (cond.__op === 'eq' && norm(val) !== norm(cond.v)) return false;
        if (cond.__op === 'or') return true;
        continue;
      }
      if (norm(val) !== norm(cond)) return false;
    }
    return true;
  }

  return {
    collection: collection,
    command: { eq: function (v) { return { __op: 'eq', v: v }; } },
    log: log,
    reset: function () { colls = {}; },
    seed: function (name, rows) { colls[name] = clone(rows); },
    rows: function (name) { return ensure(name).map(clone); }
  };
}

var db = createFakeDb();
var CURRENT_OPENID = 'openid-u1';

var origLoad = Module._load;
Module._load = function (request) {
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test',
      init: function () {},
      getWXContext: function () { return { OPENID: CURRENT_OPENID }; },
      database: function () { return db; }
    };
  }
  return origLoad.apply(this, arguments);
};
var cleanup = require('../shared/cleanup.js');
Module._load = origLoad;

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

function doc(id, userId, date, updatedAt) {
  return {
    _id: id,
    user_id: userId,
    task_date: date,
    snapshot_json: { new: ['apple'], review: [], repeat: [] },
    updated_at: updatedAt
  };
}

var CASES = [
  {
    name: '① 同一天多份文档：保留确定性 _id 那份，其余清掉',
    seed: [
      doc('legacy-1', 'U1', '2026-10-20', 900),
      doc('legacy-2', 'U1', '2026-10-20', 1200),
      doc('daily:U1:2026-10-20', 'U1', '2026-10-20', 1000)
    ],
    expect: function (r, rows) {
      assert.strictEqual(r.removed, 2, '应删掉两份重复');
      assert.strictEqual(r.kept, 1, '剩下的文档数');
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]._id, 'daily:U1:2026-10-20', '胜者应是确定性 _id 那份');
    }
  },
  {
    name: '② 没有确定性 _id 时：保留 updated_at 最新的那份',
    seed: [
      doc('legacy-a', 'U1', '2026-10-21', 500),
      doc('legacy-b', 'U1', '2026-10-21', 2000)
    ],
    expect: function (r, rows) {
      assert.strictEqual(r.removed, 1);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]._id, 'legacy-b', '应保留最新更新的那份');
    }
  },
  {
    name: '③ task_date 缺失的旧格式脏文档：整组删掉（它空占着唯一索引）',
    seed: [
      { _id: 'junk-1', user_id: 'U1', snapshot_json: {} },
      { _id: 'junk-2', user_id: 'U1', task_date: '', snapshot_json: {} },
      doc('daily:U1:2026-10-22', 'U1', '2026-10-22', 1000)
    ],
    expect: function (r, rows) {
      assert.strictEqual(rows.length, 1, '脏文档应被清掉');
      assert.strictEqual(rows[0]._id, 'daily:U1:2026-10-22', '正常文档必须留下');
    }
  },
  {
    name: '④ 幂等：清完再跑一次，removed = 0',
    seed: [
      doc('legacy-1', 'U1', '2026-10-23', 900),
      doc('daily:U1:2026-10-23', 'U1', '2026-10-23', 1000)
    ],
    expect: function (r, rows) {
      assert.strictEqual(r.removed, 1, '第一次应清掉一份');
    },
    second: function (r2) {
      assert.strictEqual(r2.removed, 0, '第二次不该再删东西');
    }
  },
  {
    name: '⑤ 不误伤：不同日期的正常文档都保留',
    seed: [
      doc('daily:U1:2026-10-18', 'U1', '2026-10-18', 1000),
      doc('daily:U1:2026-10-19', 'U1', '2026-10-19', 1000)
    ],
    expect: function (r, rows) {
      assert.strictEqual(r.removed, 0, '不同日期不是重复');
      assert.strictEqual(rows.length, 2);
    }
  },
  {
    name: '⑥ 清理前后对照：清之前同键插入必撞 -502001，清之后写入成功',
    seed: [
      doc('legacy-1', 'U1', '2026-10-24', 900),
      doc('daily:U1:2026-10-24', 'U1', '2026-10-24', 1000)
    ],
    expect: function (r, rows) {
      assert.strictEqual(rows.length, 1, '清理后只剩一份');
    },
    before: async function () {
      var before = true;
      await db.collection('daily_tasks').doc('other-id').set({
        data: { user_id: 'U1', task_date: '2026-10-24', updated_at: 1 }
      }).then(function () { before = false; }).catch(function () { before = true; });
      assert.strictEqual(before, true, '清理前同键插入必须撞唯一键（否则这条断言没意义）');
    },
    after: async function () {
      var okWrite = false;
      await db.collection('daily_tasks').doc('daily:U1:2026-10-24').set({
        data: { user_id: 'U1', task_date: '2026-10-24', updated_at: 2 }
      }).then(function () { okWrite = true; }).catch(function () { okWrite = false; });
      assert.strictEqual(okWrite, true, '清理后同样的写入应成功');
    }
  },
  {
    name: '⑦ 全库清（repairAll）：user_id 为空的孤儿脏文档也清得掉',
    all: true,
    seed: [
      { _id: 'orphan-1', snapshot_json: {} },                                  // user_id、task_date 双空
      { _id: 'orphan-2', user_id: null, task_date: null, snapshot_json: {} },
      doc('daily:U1:2026-10-25', 'U1', '2026-10-25', 1000)
    ],
    expect: function (r, rows) {
      assert.strictEqual(r.removed, 2, '孤儿文档必须被全库清掉（按用户清看不见它们）');
      assert.strictEqual(r.scanned, 3);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]._id, 'daily:U1:2026-10-25', '正常文档必须留下');
    }
  },
  {
    name: '⑧ repairAll 幂等 + 不误伤正常文档',
    all: true,
    seed: [
      doc('daily:U1:2026-10-26', 'U1', '2026-10-26', 1000),
      doc('daily:U2:2026-10-26', 'U2', '2026-10-26', 1000)
    ],
    expect: function (r, rows) {
      assert.strictEqual(r.removed, 0, '不同用户同一天不是重复');
      assert.strictEqual(rows.length, 2);
    },
    second: function (r2) {
      assert.strictEqual(r2.removed, 0, '第二次不该再删东西');
    }
  },
  {
    name: '⑨ diagnose：报得出脏数据的形态与条数',
    seed: [
      { _id: 'orphan-1', snapshot_json: {} },
      doc('legacy-1', 'U1', '2026-10-27', 900),
      doc('legacy-2', 'U1', '2026-10-27', 1200)
    ],
    expect: function (r, rows) {
      void r; void rows;
    },
    after: async function () {
      var h = await cleanup.diagnose(db);
      assert.strictEqual(h.total, 2, '用户级清完剩两份：孤儿 + 胜者');
      assert.strictEqual(h.emptyDate, 1, '孤儿文档（task_date 空）还在——用户级清看不见它');
      assert.strictEqual(h.emptyUser, 1);
      assert.strictEqual(h.dupKeys, 0, '同键重复已被清掉');
      assert.ok(h.samples.length >= 1 && h.samples[0]._id === 'orphan-1',
        '抽样要能直接看到孤儿文档的 _id');
    }
  }
];

async function main() {
  console.log('daily_tasks 脏数据清理测试：');

ok('⓪ task 云函数的 cleanup 可被控制台手动触发（不受 OPENID 检查拦截），版本戳已更新', function () {
  var fs = require('fs');
  var src = fs.readFileSync('cloud/functions/task/index.js', 'utf8');
  var mainAt = src.indexOf('exports.main');
  var cleanupAt = src.indexOf("event.action === 'cleanup'");
  var guardAt = src.indexOf('NO_IDENTITY', mainAt);
  assert.ok(mainAt >= 0 && cleanupAt > mainAt && cleanupAt < guardAt,
    'cleanup 必须在 NO_IDENTITY 检查之前分流，否则控制台「云端测试」调不了它');
  assert.ok(src.indexOf('task-20261023-cleanup') >= 0,
    '版本戳要随清理能力更新——否则控制台看不出云端跑的是哪版代码');
});
  for (var i = 0; i < CASES.length; i++) {
    var c = CASES[i];
    db.reset();
    db.seed('daily_tasks', c.seed);
    try {
      if (c.before) await c.before();
      var r = c.all ? await cleanup.repairAll(db) : await cleanup.repairUserTasks(db, 'U1');
      c.expect(r, db.rows('daily_tasks'));
      if (c.after) await c.after();
      if (c.second) {
        var r2 = c.all ? await cleanup.repairAll(db) : await cleanup.repairUserTasks(db, 'U1');
        c.second(r2);
      }
      pass++; console.log('  ✓ ' + c.name);
    } catch (e) {
      console.log('  ✗ ' + c.name + '\n    ' + e.message); process.exitCode = 1;
    }
  }
  console.log('\n全部通过：' + pass + ' 项 ✓');
}

main();
