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

/** 模拟真实库的唯一索引：daily_tasks 上 (user_id + task_date) 相同即写失败 */
var UNIQUE_PAIRS = [];
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
        var pair = JSON.stringify([o.data.user_id, o.data.task_date]);
        if (UNIQUE_PAIRS.indexOf(pair) !== -1) {
          return Promise.reject(new Error(
            'collection.set:fail -502001 duplicate key error, dup key: ' + pair));
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
  // 把现有配对登记进唯一索引模拟器（含老文档的键）
  tasksDocs().forEach(function (d) {
    UNIQUE_PAIRS.push(JSON.stringify([d.user_id, d.task_date]));
  });
  installUniqueIndex();
  // 干掉今天的确定性文档，模拟"回读 miss → 走创建 → 撞索引"
  db.raw.daily_tasks = tasksDocs().filter(function (d) { return d._id !== 'daily:U:' + TODAY; });
  UNIQUE_PAIRS.push(JSON.stringify(['U', TODAY]));   // 老文档占着键，set 必炸

  return asU(function () { return taskFn.main({ action: 'today' }); }).then(function (r) {
    assert.strictEqual(r.ok, true, '应回放老文档而不是报错：' + JSON.stringify(r));
    assert.deepStrictEqual(r.data.task.new, ['apple'], '应回放老文档的快照');
    var today = tasksDocs().filter(function (d) { return d.task_date === TODAY; });
    assert.strictEqual(today.length, 1, '不应再新建第二条，实际 ' + today.length);
  });
});

(function run() {
  return steps.reduce(function (p, s) { return p.then(s); }, Promise.resolve())
    .then(function () { console.log('\n通过：' + steps.length + ' 项 ✓'); });
})();
