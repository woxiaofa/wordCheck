/**
 * 学习简报集成测试（假数据库 + 真云函数代码）
 *
 * 一句话要同时出现在两端：学生自己看（首页）和教练看学员（报告/催学）。
 * 钉死的不变量：
 *   1) 文案含"经过 N 分钟学了 M 个单词，经过抽查，X 个掌握、Y 个不会，需要继续循环学习"
 *   2) 抽查全对且今天没"忘了" → 给荣誉词（honor），双方拿到的是同一句
 *   3) 抽查全对但今天评过"忘了" → 不发满分奖，如实说还有几次忘了
 *   4) 教练查学员 与 学员查自己 的 text/honor 必须逐字一致（"双方都有"）
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

var today = require('../cloud/functions/class/time.js').getLocalDate(Date.now());

var COACH = 'openid-coach';
var S_A = 'openid-a';   // 小明

function as(openid, fn) {
  CURRENT_OPENID = openid;
  return Promise.resolve().then(fn).then(function (r) { CURRENT_OPENID = ''; return r; });
}

function base() {
  db.reset();
  db.seed('users', [
    { _id: 'T', openid: COACH, role: 'coach', class_id: 'C1', nickname: '王老师' },
    { _id: 'A', openid: S_A, role: 'student', class_id: 'C1', nickname: '小明',
      last_seen_at: Date.now() - 60000, stats_cache: { learned_words: 6 } }
  ]);
  db.seed('classes', [{ _id: 'C1', name: '三年级二班', code: 'ABC234', owner_id: 'T',
    student_ids: ['A'], created_at: Date.now() }]);
}

/** 造今日学习记录：n 个词，每个 1.5 分钟 */
function seedLearn(n, feedback) {
  var rows = [];
  for (var i = 0; i < n; i++) {
    rows.push({ _id: 'l' + i, user_id: 'A', word_id: 'w' + i,
      feedback: feedback || 'known', mode: 'study', duration_ms: 90000,
      review_date: today, created_at: Date.now() - i * 1000 });
  }
  db.seed('review_logs', rows);
}

/** 造今日抽查明细：total 题，其中 wrong 题答错 */
function seedQuiz(total, wrong) {
  var rows = [];
  for (var i = 0; i < total; i++) {
    rows.push({ _id: 'q' + i, user_id: 'A', word_id: 'w' + i, is_correct: i >= wrong,
      quiz_date: today, created_at: Date.now() - i * 1000 });
  }
  db.seed('quiz_items', rows);
}

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

ok('① 有学有抽查且有错：说清"掌握 X 个、不会 Y 个、需要继续循环学习"', function () {
  base();
  seedLearn(10);
  seedQuiz(10, 2);
  db.seed('quiz_sessions', [{ _id: 's1', user_id: 'A', total: 10, correct: 8,
    duration_ms: 300000, quiz_date: today, created_at: Date.now() }]);
  return as(COACH, function () { return classFn.main({ action: 'summary', studentId: 'A' }); })
    .then(function (r) {
      var s = r.data;
      assert.strictEqual(s.learned, 10, '学过 10 个词');
      assert.strictEqual(s.mastered, 8);
      assert.strictEqual(s.failed, 2);
      assert.strictEqual(s.minutes, 20, '15 分钟学习 + 5 分钟抽查 = 20 分钟，实际 ' + s.minutes);
      assert.strictEqual(s.need_loop, true);
      assert.ok(!s.honor, '有错的词不发荣誉');
      var t = s.text;
      assert.ok(/经过 20 分钟学了 10 个单词/.test(t), '时长与词数，实际：' + t);
      assert.ok(/经过抽查，8 个掌握、2 个不会/.test(t), '掌握/不会，实际：' + t);
      assert.ok(/需要继续循环学习/.test(t), '循环学习结论，实际：' + t);
    });
});

ok('② 抽查全对且今天没"忘了" → 给荣誉词（双方同一句）', function () {
  base();
  seedLearn(10);
  seedQuiz(10, 0);
  return as(COACH, function () { return classFn.main({ action: 'summary', studentId: 'A' }); })
    .then(function (r) {
      var s = r.data;
      assert.ok(s.honor, '全对应给荣誉词');
      assert.strictEqual(s.honor.title, '今日全掌握');
      assert.ok(/全部掌握/.test(s.text), '文案应说全部掌握，实际：' + s.text);
      assert.strictEqual(s.need_loop, false);
      // 学员自己看到的必须逐字一致（否则"双方都有"就是假的）
      return as(S_A, function () { return classFn.main({ action: 'summary' }); })
        .then(function (r2) {
          assert.strictEqual(r2.data.text, s.text, '两端文案必须一致');
          assert.deepStrictEqual(r2.data.honor, s.honor, '两端荣誉词必须一致');
        });
    });
});

ok('③ 抽查全对但今天评过"忘了" → 不发满分奖，如实说', function () {
  base();
  seedLearn(6, 'forgot');
  seedQuiz(6, 0);
  return as(COACH, function () { return classFn.main({ action: 'summary', studentId: 'A' }); })
    .then(function (r) {
      var s = r.data;
      assert.ok(!s.honor, '今天有"忘了"就不能发全掌握');
      assert.strictEqual(s.need_loop, true);
      assert.ok(/全对/.test(s.text) && /忘了/.test(s.text), '应同时说全对与忘了，实际：' + s.text);
    });
});

ok('④ 没学习也没抽查 / 学了没抽查：分别说清楚，不编数字', function () {
  base();
  return as(S_A, function () { return classFn.main({ action: 'summary' }); })
    .then(function (r) {
      assert.ok(/还没有学习记录/.test(r.data.text), '空数据分支，实际：' + r.data.text);
      seedLearn(6);
      return as(S_A, function () { return classFn.main({ action: 'summary' }); });
    })
    .then(function (r) {
      assert.ok(/还没抽查/.test(r.data.text), '未抽查分支，实际：' + r.data.text);
      assert.ok(!r.data.honor, '没抽查就没有荣誉');
    });
});

ok('⑤ 学员报告（studentDetail）也带同一份简报', function () {
  base();
  seedLearn(5);
  seedQuiz(5, 1);
  return as(COACH, function () { return classFn.main({ action: 'studentDetail', studentId: 'A' }); })
    .then(function (r) {
      assert.ok(r.data.summary, '报告应带 summary');
      assert.ok(/4 个掌握、1 个不会/.test(r.data.summary.text),
        '报告简报应同口径，实际：' + r.data.summary.text);
    });
});

ok('⑥ 越权：教练只能看自己班里的学员', function () {
  base();
  // 注意：db.seed 会替换整个集合，这里只能追加，别把教练/小明冲掉
  (db.raw.users || (db.raw.users = [])).push(
    { _id: 'X', openid: 'openid-x', role: 'student', class_id: 'C9', nickname: '外人' });
  return as(COACH, function () { return classFn.main({ action: 'summary', studentId: 'X' }); })
    .then(function (r) {
      assert.strictEqual(r.ok, false, '不该允许看别班学员');
      assert.strictEqual(r.code, 'FORBIDDEN');
    });
});

steps.reduce(function (p, fn) { return p.then(fn); }, Promise.resolve())
  .then(function () {
    console.log(process.exitCode ? '\n有问题，见上方 ✗\n' : '\n全部通过：' + steps.length + ' 项 ✓\n');
  });
