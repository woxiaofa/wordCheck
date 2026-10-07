/**
 * task.today 幂等与 -502001 自愈集成测试（假库 + 真 task 云函数代码）
 *
 * 钉死 2026-10-07 的实锤：daily_tasks 库里有旧格式脏数据（task_date 为空），
 * add 撞 (user_id + task_date) 唯一索引且 _id 对不上 → 今天任务创建失败 →
 * 小程序端每次都回落本地词盘。
 * 修复：add 改为 doc(_id).set() upsert；set 仍失败时按业务键回放。
 * 契约：
 *   ① 首次创建成功：文档 _id = daily:{uid}:{date}，task_date 正确
 *   ② 同天重复调用幂等：仍只有一条文档
 *   ③ set 的 data 绝不带 _id（-501007，fakedb strictSetId 复刻）
 *   ④ set 撞唯一索引（老文档占用业务键）→ 按业务键回放老文档，不炸
 */

var assert = require('assert');
var fake = require('./fakedb.js');
var db = fake.create({ strictSetId: true });

var CURRENT_OPENID = '';
var fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'test',
  init: function () {},
  getWXContext: function () { return { OPENID: CURRENT_OPENID }; },
  database: function () { return db; }
};
var Module = require('module');
var origLoad = Module._load;
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeSdk;
  return origLoad.apply(this, arguments);
};
var taskFn = require('../cloud/functions/task/index.js');
Module._load = origLoad;

var time = require('../shared/time.js');
var TODAY = time.getLocalDate();

db.seed('users', [{ _id: 'U', openid: 'openid-u', role: 'student' }]);
db.seed('words', [
  { _id: 'w1', word: 'apple', def_cn: '苹果', freq: 1, tags: ['全部'] },
  { _id: 'w2', word: 'dog', def_cn: '狗', freq: 2, tags: ['全部'] },
  { _id: 'w3', word: 'cat', def_cn: '猫', freq: 3, tags: ['全部'] }
]);

var steps = [];
function ok(name, fn) {
  steps.push(function () {
    return Promise.resolve().then(fn).then(function () {
      console.log('  ✓ ' + name);
    }, function (e) {
      process.exitCode = 1;
      console.log('  ✗ ' + name);
      console.log('    ' + (e && e.message ? String(e.message).split('\n').join('\n    ') : e));
    });
  });
}

function asU(run) {
  CURRENT_OPENID = 'openid-u';
  return Promise.resolve().then(run).then(function (r) { CURRENT_OPENID = ''; return r; });
}

function tasksDocs() { return (db.raw.daily_tasks || []).slice(); }

/** 模拟真实库的唯一索引：daily_tasks 上 (user_id + task_date) 唯一。
 *  线上实锤语义：task_date 为空的旧脏文档会挡住同一用户的任何新插入
 *  （E11000 的 dup key 显示 task_date: null 即此因），按此建模。
 *  冲突直接查当前集合内容（动态），不再手工登记。 */
function installUniqueIndex() {
  var baseCollection = db.collection;
  db.collection = function (name) {
    var c = baseCollection(name);
    if (name !== 'daily_tasks') return c;
    var origDoc = c.doc;
    c.doc = function (id) {
      var d = origDoc.call(c, id);
      var origSet = d.set;
      d.set = function (o) {
        var nd = o.data.task_date === undefined ? null : o.data.task_date;
        function hits() {
          return (db.raw.daily_tasks || []).filter(function (d2) {
            return d2._id !== id && d2.user_id === o.data.user_id &&
              (d2.task_date === nd || d2.task_date == null || nd === null);
          });
        }
        if (hits().length) {
          var hit = hits()[0];
          var kv = JSON.stringify([hit.user_id, hit.task_date === undefined ? null : hit.task_date]);
          return Promise.reject(new Error(
            'collection.set:fail -502001 E11000 duplicate key error, dup key: ' + kv));
        }
        return origSet.call(d, o);
      };
      return d;
    };
    return c;
  };
}

ok('① 首次创建：_id=daily:{uid}:{date}、task_date 正确、data 不带 _id（-501007 复刻不炸）', function () {
  return asU(function () { return taskFn.main({ action: 'today' }); }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var docs = tasksDocs();
    assert.strictEqual(docs.length, 1, '应恰好 1 条任务，实际 ' + docs.length);
    assert.strictEqual(docs[0]._id, 'daily:U:' + TODAY);
    assert.strictEqual(docs[0].task_date, TODAY);
    assert.ok(docs[0].snapshot_json.new.length > 0, '新词快照不应为空');
  });
});

ok('② 同天重复调用幂等：不新建文档，快照一致', function () {
  return asU(function () { return taskFn.main({ action: 'today' }); }).then(function (r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(tasksDocs().length, 1, '仍应只有 1 条，实际 ' + tasksDocs().length);
    assert.strictEqual(r.data.task.date, TODAY);
  });
});

ok('③ set 撞唯一索引（老文档占用业务键）→ 按业务键回放，不炸、不新建', function () {
  // 老格式文档：同一天、不同 _id，占住了 (user_id, task_date) 唯一键
  db.raw.daily_tasks.push({
    _id: 'legacy-format-doc',
    user_id: 'U',
    task_date: TODAY,
    snapshot_json: { new: ['apple'], review: ['dog'], repeat: [] },
    new_count: 1, review_count: 1, quiz_count: 10,
    created_at: 1, updated_at: 1
  });
  installUniqueIndex();
  // 干掉今天的确定性文档，模拟"回读 miss → 走创建 → 撞索引"
  db.raw.daily_tasks = tasksDocs().filter(function (d) { return d._id !== 'daily:U:' + TODAY; });

  return asU(function () { return taskFn.main({ action: 'today' }); }).then(function (r) {
    assert.strictEqual(r.ok, true, '应回放老文档而不是报错：' + JSON.stringify(r));
    assert.deepStrictEqual(r.data.task.new, ['apple'], '应回放老文档的快照');
    var today = tasksDocs().filter(function (d) { return d.task_date === TODAY; });
    assert.strictEqual(today.length, 1, '不应再新建第二条，实际 ' + today.length);
  });
});

ok('⑤ 空日期脏文档占住唯一索引（E11000，task_date:null）→ 自愈删除后重试成功', function () {
  // 线上实锤形态：旧格式文档连 task_date 都没有，dup key 显示 task_date: null。
  // 隔离本场景：先清掉 ③ 留下的"今天日期旧文档"（那是 ③ 的回放场景）
  db.raw.daily_tasks = tasksDocs().filter(function (d) { return d._id !== 'legacy-format-doc'; });
  db.raw.daily_tasks.push({
    _id: 'dirty-null-date',
    user_id: 'U',
    snapshot_json: { new: [], review: [], repeat: [] },
    created_at: 1, updated_at: 1
  });

  // 干掉今天的确定性文档，制造"回读 miss → set 插入 → 撞 null 键"
  db.raw.daily_tasks = tasksDocs().filter(function (d) { return d._id !== 'daily:U:' + TODAY; });

  return asU(function () { return taskFn.main({ action: 'today' }); }).then(function (r) {
    assert.strictEqual(r.ok, true, '自愈后应创建成功：' + JSON.stringify(r));
    var nulls = tasksDocs().filter(function (d) { return d.user_id === 'U' && (d.task_date === null || d.task_date === undefined); });
    assert.strictEqual(nulls.length, 0, '空日期脏文档应被清理，剩 ' + nulls.length);
    var mine = tasksDocs().filter(function (d) { return d._id === 'daily:U:' + TODAY; });
    assert.strictEqual(mine.length, 1, '今天的任务应存在');
    assert.strictEqual(mine[0].task_date, TODAY);
  });
});

(function run() {
  return steps.reduce(function (p, s) { return p.then(s); }, Promise.resolve())
    .then(function () { console.log('\n通过：' + steps.length + ' 项 ✓'); });
})();
