/**
 * 自动布置计划测试（假库 + 真云函数代码）
 *
 * 为什么不能只靠静态断言：这个功能的全部价值在"分几天、每天几个词、不会重发"，
 * 三件事都是算术 —— 静态断言只能证明按钮存在，证明不了 42 个词分 4 天真的是 11/11/10/10，
 * 也证明不了定时器被重复触发时不会同一天发两份作业（那等于孩子看到两份一样的作业）。
 *
 * 钉死：
 *   1) 42 词分 4 天 → per_day=11，第一天取课本第 1~11 个
 *   2) 定时器往前推一天 → 取第 12~22 个（课本序不串行）
 *   3) 同一天重复触发只发一次（last_date 幂等）
 *   4) 最后一天发完自动结束（active=false，不会无限发下去）
 *   5) 停掉计划：已发出的作业保留，只是不再往后发
 */

var assert = require('assert');
var fake = require('./fakedb.js');
var db = fake.create();

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
var classFn = require('../cloud/functions/class/index.js');
Module._load = origLoad;

var COACH = 'openid-coach';
var UNIT_WORDS = [];
for (var i = 1; i <= 42; i++) UNIT_WORDS.push('w' + i);

function seed() {
  db.reset();
  db.seed('users', [
    { _id: 'T', openid: COACH, role: 'coach', class_id: 'C1', nickname: '王老师' }
  ]);
  db.seed('classes', [{
    _id: 'C1', name: '四年二班', code: 'ABC234', owner_id: 'T',
    student_ids: [], created_at: 1000
  }]);
  // Unit 2 的 42 个词（unit_order 严格 1~42，课本序）
  db.seed('words', UNIT_WORDS.map(function (w, idx) {
    return { _id: 'doc-' + w, word: w, volume: 'wy4a', unit: 2, unit_order: idx + 1, freq: idx + 1 };
  }));
}

function as(openid, fn) {
  CURRENT_OPENID = openid;
  return Promise.resolve().then(fn).then(function (r) { CURRENT_OPENID = ''; return r; });
}

var steps = [];
function step(name, fn) { steps.push([name, fn]); }

var pass = 0;
var fail = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    pass++; console.log('  ✓ ' + name);
  }).catch(function (e) {
    fail++; console.log('  ✗ ' + name + '\n    ' + e.message);
    process.exitCode = 1;
  });
}

function all() {
  return db.collection('assignments').orderBy('created_at', 'asc').get().then(function (r) {
    return r.data || [];
  });
}

console.log('自动布置计划（假库 + 真云函数）');

seed();

var planId = '';

step('① 42 个词分 4 天：每天 11 个，第一天当场发出第 1~11 个', function () {
  return as(COACH, function () {
    return classFn.main({
      action: 'planCreate', volume: 'wy4a', unit: 2, start: 1, days: 4,
      clientReqId: 'r1'
    });
  }).then(function (r) {
    assert.ok(r && r.ok, 'planCreate 应成功：' + JSON.stringify(r).slice(0, 160));
    var p = r.data.plan;
    planId = p.id;
    assert.strictEqual(p.per_day, 11, '42 词 4 天应每天 11 个，实际 ' + p.per_day);
    assert.strictEqual(p.days, 4, '天数应为 4，实际 ' + p.days);
    assert.strictEqual(p.done, 1, '第一天应当场发出');
    assert.strictEqual(p.left, 3);
    assert.strictEqual(r.data.assignment.count, 11, '第一天应 11 个词');
    assert.deepStrictEqual(r.data.assignment.word_ids.slice(0, 3), ['w1', 'w2', 'w3'],
      '第一天必须从课本第 1 个词开始');
    assert.strictEqual(r.data.assignment.word_ids[10], 'w11');
  });
});

step('② 同一天再触发定时器：不重复发（幂等）', function () {
  return classFn.main({ Type: 'Timer', triggerName: 'dailyAssign' }).then(function (r) {
    assert.strictEqual(r.sent, 0, '同一天不该再发，实际发了 ' + r.sent + ' 份');
    return all();
  }).then(function (list) {
    assert.strictEqual(list.length, 1, '作业总数应仍为 1，实际 ' + list.length);
  });
});

step('③ 第二天：接着取第 12~22 个（课本序不串行）', function () {
  // 把计划的 last_date 改成昨天，模拟"到了第二天"
  return db.collection('assign_plans').doc(planId).update({ data: { last_date: '2020-01-01' } })
    .then(function () {
      return classFn.main({ Type: 'Timer', triggerName: 'dailyAssign' });
    })
    .then(function (r) {
      assert.strictEqual(r.sent, 1, '第二天应发 1 份，实际 ' + r.sent);
      return all();
    })
    .then(function (list) {
      assert.strictEqual(list.length, 2);
      var day2 = list[1];
      assert.strictEqual(day2.plan_day, 2, '应标记为计划第 2 天');
      assert.deepStrictEqual(day2.word_ids.slice(0, 2), ['w12', 'w13'], '第二天应从 w12 开始');
      assert.strictEqual(day2.word_ids.length, 11);
    });
});

step('④ 发完最后一天自动结束（不会无限发下去）', function () {
  return db.collection('assign_plans').doc(planId).update({ data: { last_date: '2020-01-01' } })
    .then(function () { return classFn.main({ Type: 'Timer', triggerName: 'dailyAssign' }); })
    .then(function () {
      return db.collection('assign_plans').doc(planId).update({ data: { last_date: '2020-01-01' } });
    })
    .then(function () { return classFn.main({ Type: 'Timer', triggerName: 'dailyAssign' }); })
    .then(function () { return all(); })
    .then(function (list) {
      assert.strictEqual(list.length, 4, '4 天计划共应发 4 份，实际 ' + list.length);
      var day4 = list[3];
      // 42 - 33 = 9：最后一天少两个，不能硬切成 11
      assert.strictEqual(day4.word_ids.length, 9, '最后一天应为剩下的 9 个词，实际 ' + day4.word_ids.length);
      assert.strictEqual(day4.word_ids[8], 'w42');
      return db.collection('assign_plans').doc(planId).get();
    })
    .then(function (r) {
      assert.strictEqual(r.data.active, false, '发完应自动结束');
      assert.strictEqual(r.data.done, 4);
    });
});

step('⑤ 结束之后再触发：一份都不发', function () {
  return classFn.main({ Type: 'Timer', triggerName: 'dailyAssign' }).then(function (r) {
    assert.strictEqual(r.sent, 0);
    return all();
  }).then(function (list) {
    assert.strictEqual(list.length, 4);
  });
});

step('⑥ 计划列表带进度，且能停掉（已发的作业保留）', function () {
  return as(COACH, function () { return classFn.main({ action: 'planList' }); })
    .then(function (r) {
      assert.ok(r.ok);
      var p = r.data.plans[0];
      assert.strictEqual(p.done, 4);
      assert.strictEqual(p.left, 0);
      assert.strictEqual(p.active, false);
      assert.strictEqual(p.next_start, 45, 'next_start = start + done*per_day');
      return as(COACH, function () {
        return classFn.main({ action: 'planStop', planId: planId });
      });
    })
    .then(function (r) {
      assert.ok(r.ok, '停止应成功');
      return all();
    })
    .then(function (list) {
      assert.strictEqual(list.length, 4, '停掉计划不该删除已发出的作业');
    });
});

step('⑦ 起点不是 1 时从起点开始切（布置过前 10 个的场景）', function () {
  seed();
  return as(COACH, function () {
    return classFn.main({
      action: 'planCreate', volume: 'wy4a', unit: 2, start: 11, days: 3,
      clientReqId: 'r2'
    });
  }).then(function (r) {
    assert.ok(r.ok, JSON.stringify(r).slice(0, 160));
    var a = r.data.assignment;
    assert.deepStrictEqual(a.word_ids.slice(0, 2), ['w11', 'w12'], '应从第 11 个词开始');
    // 剩余 32 个分 3 天 → 每天 11 个
    assert.strictEqual(r.data.plan.per_day, 11);
  });
});

(function run(i) {
  if (i >= steps.length) {
    console.log('\n' + (fail ? '有失败：' + fail + ' 项' : '全部通过：' + pass + ' 项 ✓'));
    process.exit(fail ? 1 : 0);
    return;
  }
  ok(steps[i][0], steps[i][1]).then(function () { run(i + 1); });
})(0);
