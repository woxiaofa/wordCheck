/**
 * 个性化作业集成测试（假数据库 + 真云函数代码）
 *
 * 为什么需要它：全班一张词单时，已经会了的孩子要陪着重新抄一遍，
 * 而真正总错的孩子反而练不到自己的错词。个性化按"这个孩子现在最需要什么"裁剪，
 * 但同时引入了新的对不上风险：
 *   1) 词单随进度实时变化 → 昨天 5/10、今天 4/9，家长以为数据又坏了（必须固化快照）
 *   2) 每人词单不同 → 教师端若仍拿全班词单算进度，两边数字必然打架
 *   3) 个性化不能破坏旧行为 → 不勾开关时必须和以前一模一样
 * 这里把三条链路在假库上跑通，钉死"个性化前后都自洽"的不变量。
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

/* ---------------- 场景 ---------------- */

var COACH = 'openid-coach';
var S_A = 'openid-a';   // 小明：有错词、有已掌握的词
var S_B = 'openid-b';   // 小红：全新，一个词都没学过

// 候选池 12 个词（布置 5 个，池要更大才看得出"跳过已掌握"）
var POOL = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10', 'w11', 'w12'];

function makeWords() {
  return POOL.map(function (w, i) {
    return { _id: 'id-' + w, word: w, translation: '释义' + w, freq: i + 1, tags: ['中考'] };
  });
}

/**
 * 建场景
 * @param {object} opt { personalized: 是否个性化, states: { [userId]: [stateRow] } }
 */
function seed(opt) {
  opt = opt || {};
  db.reset();
  db.seed('users', [
    { _id: 'T', openid: COACH, role: 'coach', class_id: 'C1', nickname: '王老师' },
    { _id: 'A', openid: S_A, role: 'student', class_id: 'C1', nickname: '小明',
      last_seen_at: Date.now() - 60000, stats_cache: { learned_words: 6, streak_days: 1 } },
    { _id: 'B', openid: S_B, role: 'student', class_id: 'C1', nickname: '小红',
      last_seen_at: Date.now() - 60000, stats_cache: { learned_words: 0, streak_days: 0 } }
  ]);
  db.seed('classes', [{
    _id: 'C1', name: '三年级二班', code: 'ABC234', owner_id: 'T',
    student_ids: ['A', 'B'], created_at: Date.now()
  }]);
  db.seed('words', makeWords());
  // 小明的状态：w1/w2 是错词，w3 已掌握（stage 5），w4 模糊，其余没学过
  db.seed('user_word_state_v2', [
    { _id: 'A:w1', user_id: 'A', word_id: 'w1', stage: 0, correct_count: 0, wrong_count: 3,
      last_feedback: 'forgot', next_review_at: Date.now() - 1000 },
    { _id: 'A:w2', user_id: 'A', word_id: 'w2', stage: 1, correct_count: 1, wrong_count: 2,
      last_feedback: 'vague', next_review_at: Date.now() - 1000 },
    { _id: 'A:w3', user_id: 'A', word_id: 'w3', stage: 5, correct_count: 9, wrong_count: 0,
      last_feedback: 'known', next_review_at: Date.now() + 30 * 86400000 },
    { _id: 'A:w4', user_id: 'A', word_id: 'w4', stage: 2, correct_count: 2, wrong_count: 0,
      last_feedback: 'vague', next_review_at: Date.now() + 86400000 }
  ]);
}

function as(openid, fn) {
  CURRENT_OPENID = openid;
  return Promise.resolve().then(fn).then(function (r) { CURRENT_OPENID = ''; return r; });
}

function assign(personalized) {
  return as(COACH, function () {
    return classFn.main({
      action: 'assign', tag: '中考', count: 5, note: '分层作业',
      personalized: personalized, clientReqId: 'req-' + (personalized ? 'p' : 'n')
    });
  });
}

/* ---------------- 测试 ---------------- */

var steps = [];
function ok(name, fn) {
  steps.push(function () {
    return Promise.resolve().then(fn).then(function () {
      console.log('  ✓ ' + name);
    }).catch(function (e) {
      console.log('  ✗ ' + name);
      console.log('    ' + (e && e.message));
      // 打印调用栈：假库内部报错（比如 clone(undefined)）只有栈顶才看得出是哪条链路
      console.log(String((e && e.stack) || '').split('\n').slice(1, 5).join('\n'));
      process.exitCode = 1;
    });
  });
}

// ---- ① 不勾开关：行为与个性化之前完全一致（向后兼容红线）----
ok('① 非个性化：全班同一张词单，结构不变（老作业不受影响）', function () {
  seed();
  return assign(false).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.personalized, false);
    return as(S_A, function () { return classFn.main({ action: 'myAssignments' }); });
  }).then(function (r) {
    var a = r.data.assignments[0];
    assert.strictEqual(a.personalized, false, '不应被标成个性化');
    assert.deepStrictEqual(a.word_ids, POOL.slice(0, 5), '应原样下发基础词单（按词频升序前 5）');
    assert.strictEqual(a.count, 5, '总数仍是 5');
  });
});

// ---- ② 个性化：错词优先入选、已掌握的词被跳过 ----
ok('② 个性化：错词排在最前，已掌握（stage≥5）的词不进词单', function () {
  seed();
  return assign(true).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.personalized, true);
    assert.strictEqual(r.data.student_count, 2, '两位学员各自生成词单');
    return as(S_A, function () { return classFn.main({ action: 'myAssignments' }); });
  }).then(function (r) {
    var a = r.data.assignments[0];
    assert.strictEqual(a.personalized, true);
    assert.strictEqual(a.word_ids.length, 5, '词数守恒：仍布置 5 个，实际 ' + a.word_ids.length);
    // 错词必在最前（w1 忘了、w2 模糊带错）
    assert.strictEqual(a.word_ids[0], 'w1', '错词 w1 应排第一，实际：' + a.word_ids.join(','));
    assert.strictEqual(a.word_ids[1], 'w2', '错词 w2 应排第二，实际：' + a.word_ids.join(','));
    // 已掌握的词不该出现（池里还有一堆没学过的可用）
    assert.strictEqual(a.word_ids.indexOf('w3'), -1,
      '已掌握的 w3 应被跳过，实际词单：' + a.word_ids.join(','));
  });
});

// ---- ③ 快照固化：学完之后词单不再变（防"昨天 5/10 今天 4/9"）----
ok('③ 快照固化：孩子学完几个词后再读，词单与总数都不变', function () {
  seed();
  return assign(true).then(function () {
    return as(S_B, function () { return classFn.main({ action: 'myAssignments' }); });
  }).then(function (r) {
    var first = r.data.assignments[0].word_ids.slice();
    // 小红把前两个词学掉了
    var coll = db.raw.user_word_state_v2 || (db.raw.user_word_state_v2 = []);
    first.slice(0, 2).forEach(function (w) {
      coll.push({ _id: 'B:' + w, user_id: 'B', word_id: w, stage: 1,
        correct_count: 1, wrong_count: 0, last_feedback: 'known',
        next_review_at: Date.now() + 86400000 });
    });
    return as(S_B, function () { return classFn.main({ action: 'myAssignments' }); })
      .then(function (r2) {
        var a = r2.data.assignments[0];
        assert.deepStrictEqual(a.word_ids, first,
          '作业开始后词单必须固定，否则进度会自己跳：\n  首次 ' + first.join(',') +
          '\n  现在 ' + a.word_ids.join(','));
        assert.strictEqual(a.done, 2, '新学的 2 个应计入完成');
        assert.strictEqual(a.count, first.length, '总数不变');
      });
  });
});

// ---- ④ 两端同口径：教师端按各自词单算，不拿全班词单一刀切 ----
ok('④ 教师端逐学员进度：用各自词单算，与学员自己看到的 done 一致', function () {
  seed();
  return assign(true).then(function () {
    // 小明把 w1、w2 学掉（都在他自己的词单里）
    var coll = db.raw.user_word_state_v2 || (db.raw.user_word_state_v2 = []);
    coll.forEach(function (s) { if (s.user_id === 'A' && s.word_id === 'w1') s.wrong_count = 3; });
    return as(COACH, function () { return classFn.main({ action: 'assignments' }); });
  }).then(function (r) {
    var a = r.data.assignments[0];
    var perA = a.per_student.filter(function (p) { return p.user_id === 'A'; })[0];
    var perB = a.per_student.filter(function (p) { return p.user_id === 'B'; })[0];
    assert.ok(perA && perB, '应给出逐学员进度');
    assert.strictEqual(perA.count, 5, '小明的总数=他自己的词单数');
    // 小明学过 w1/w2/w3/w4，但 w3 已掌握被裁掉了 → 他的词单里只有 3 个学过
    assert.strictEqual(perA.done, 3, '只应统计他自己词单里的词，实际 ' + perA.done);
    assert.strictEqual(perB.done, 0, '小红什么都没学过');
    // 关键：教师端不能拿全班基础词单（前 5 个 w1..w5）硬算所有人的进度
    assert.strictEqual(a.finished, 0, '没人做完，完成人数应为 0');
  });
});

// ---- ⑤ 后加入的学员：首次打开时补生成自己的词单 ----
ok('⑤ 后加入学员：首次读作业时补生成快照并落库', function () {
  seed();
  return assign(true).then(function () {
    // 新学员 C 加入班级
    var cls = db.raw.classes[0];
    cls.student_ids = ['A', 'B', 'C'];
    db.raw.users.push({ _id: 'C', openid: 'openid-c', role: 'student', class_id: 'C1',
      nickname: '小刚', last_seen_at: Date.now(), stats_cache: {} });
    return as('openid-c', function () { return classFn.main({ action: 'myAssignments' }); });
  }).then(function (r) {
    var a = r.data.assignments[0];
    assert.ok(a && a.word_ids.length === 5, '后加入学员应拿到 5 个词');
    var snaps = db.raw.assignment_students || [];
    var mine = snaps.filter(function (s) { return s.user_id === 'C'; });
    assert.strictEqual(mine.length, 1, '应落一份快照（下次读取直接复用）');
    assert.deepStrictEqual(mine[0].word_ids, a.word_ids, '快照内容应与下发一致');
  });
});

// ---- ⑥ 词数守恒：候选不够时也要凑够，不能给孩子 0 个词 ----
ok('⑥ 词数守恒：候选池只剩已掌握的词时，仍凑满布置数而不是空词单', function () {
  seed();
  // 把小明的状态改成：池里前 5 个全部已掌握、后面没学过的只剩 2 个
  db.raw.user_word_state_v2 = POOL.slice(0, 5).map(function (w) {
    return { _id: 'A:' + w, user_id: 'A', word_id: w, stage: 6, correct_count: 12, wrong_count: 0,
      last_feedback: 'known', next_review_at: Date.now() + 30 * 86400000 };
  });
  return assign(true).then(function () {
    return as(S_A, function () { return classFn.main({ action: 'myAssignments' }); });
  }).then(function (r) {
    var a = r.data.assignments[0];
    assert.strictEqual(a.word_ids.length, 5,
      '已掌握的词也要用来凑数（否则孩子打开是空的），实际 ' + a.word_ids.length);
  });
});

// ---- ⑦ 催学文案：个性化下数字仍自洽（done + left = 该学员自己的 count）----
ok('⑦ 催学文案：个性化作业下按该学员自己的词单说数字', function () {
  seed();
  var today = require('../cloud/functions/class/time.js').getLocalDate(Date.now());
  // 小明今天练了 w1/w2/w4 —— 正好全落在他自己的词单里
  db.seed('review_logs', ['w1', 'w2', 'w4'].map(function (w, i) {
    return { _id: 'l' + i, user_id: 'A', word_id: w, feedback: 'known', mode: 'study',
      review_date: today, created_at: Date.now() - i * 1000 };
  }));
  return assign(true).then(function () {
    // 小红今天没练过 → 走"还没开始学"分支，说还剩 5 个
    return as(COACH, function () { return classFn.main({ action: 'nudge', studentId: 'B' }); });
  }).then(function (r) {
    assert.ok(/还剩\s*5\s*个词/.test(r.data.text), '小红应说还剩 5 个，实际：\n' + r.data.text);
    return as(COACH, function () { return classFn.main({ action: 'nudge', studentId: 'A' }); });
  }).then(function (r) {
    var t = r.data.text;
    assert.ok(/已完成\s*3\/5/.test(t), '小明应为 3/5，实际：\n' + t);
    assert.ok(/其中\s*3\s*个/.test(t), '应归因"其中 3 个是作业的词"，实际：\n' + t);
    assert.ok(/剩下的\s*2\s*个/.test(t), '剩余应为 2 个，实际：\n' + t);
  });
});

steps.reduce(function (p, fn) { return p.then(fn); }, Promise.resolve())
  .then(function () {
    console.log(process.exitCode ? '\n有问题，见上方 ✗\n' : '\n全部通过：' + steps.length + ' 项 ✓\n');
  });
