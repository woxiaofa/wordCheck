/**
 * quiz 交卷写状态集成测试（假数据库 + 真云函数代码）
 *
 * 钉死 2026-10-07 的实锤 bug：抽查答对时云端什么都不写（只记 quiz_items），
 * 抽查结果完全不参与进度 —— 家长看到"点了会了就算完成，抽查白做"。
 * 契约：
 *   1) 答对 → upsert user_word_state：last_feedback=known、correct_count+1、档位推进
 *   2) 答错 → last_feedback=forgot、wrong_count+1（原有行为，回归保护）
 *   3) 先对后错 → 同一词只有一行状态（upsert 幂等），最近一次反馈为准
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
var quizFn = require('../cloud/functions/quiz/index.js');
Module._load = origLoad;

function stateOf(wordId) {
  var rows = db.raw.user_word_state_v2 || [];
  return rows.filter(function (s) { return s.user_id === 'U' && s.word_id === wordId; })[0] || null;
}

/** 以学员 U 的身份调用云函数（getWXContext 的 OPENID 由 CURRENT_OPENID 提供） */
function asU(run) {
  CURRENT_OPENID = 'openid-u';
  return Promise.resolve().then(run).then(function (r) { CURRENT_OPENID = ''; return r; });
}

db.seed('users', [{ _id: 'U', openid: 'openid-u', role: 'student' }]);
db.seed('words', [
  { _id: 'id-apple', word: 'apple', def_cn: '苹果', freq: 1, tags: ['全部'] },
  { _id: 'id-dog', word: 'dog', def_cn: '狗', freq: 2, tags: ['全部'] }
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

ok('① 抽查答对 → 写入 known 状态、correct_count+1（修复"抽查白做"）', function () {
  return asU(function () {
    return quizFn.main({
      action: 'submit', clientReqId: 'q-ok-1',
      answers: [{ wordId: 'apple', type: 'meaning', answer: '苹果' }]
    });
  }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.correct, 1);
    var s = stateOf('apple');
    assert.ok(s, '答对后必须存在该词的学习状态（此前完全没写）');
    assert.strictEqual(s.last_feedback, 'known');
    assert.strictEqual(s.correct_count, 1);
    assert.ok((s.stage || 0) >= 1, '档位应推进，实际 stage=' + s.stage);
  });
});

ok('② 抽查答错 → forgot、wrong_count+1（原有行为回归保护）', function () {
  return asU(function () {
    return quizFn.main({
      action: 'submit', clientReqId: 'q-bad-1',
      answers: [{ wordId: 'dog', type: 'meaning', answer: '猫' }]
    });
  }).then(function (r) {
    assert.strictEqual(r.data.correct, 0);
    var s = stateOf('dog');
    assert.ok(s, '答错也应留状态');
    assert.strictEqual(s.last_feedback, 'forgot');
    assert.strictEqual(s.wrong_count, 1);
    assert.ok((s.next_review_at || 0) > Date.now(), '忘了的词应被 SRS 排期尽快复习');
  });
});

ok('③ 同一词先对后错 → 一行状态、最近反馈为准（upsert 幂等）', function () {
  return asU(function () {
    return quizFn.main({
      action: 'submit', clientReqId: 'q-ok-2',
      answers: [{ wordId: 'apple', type: 'meaning', answer: '苹果' }]
    });
  }).then(function () {
    return asU(function () {
      return quizFn.main({
        action: 'submit', clientReqId: 'q-bad-2',
        answers: [{ wordId: 'apple', type: 'meaning', answer: '梨' }]
      });
    });
  }).then(function () {
    var rows = (db.raw.user_word_state_v2 || []).filter(function (s) {
      return s.user_id === 'U' && s.word_id === 'apple';
    });
    assert.strictEqual(rows.length, 1, '同一词只应有一行状态，实际 ' + rows.length);
    assert.strictEqual(rows[0].last_feedback, 'forgot', '最近一次答错 → forgot');
    assert.strictEqual(rows[0].correct_count, 2, '两次答对的计数保留');
    assert.strictEqual(rows[0].wrong_count, 1);
  });
});

steps.reduce(function (p, fn) { return p.then(fn); }, Promise.resolve())
  .then(function () {
    console.log(process.exitCode ? '\n有问题，见上方 ✗\n' : '\n全部通过：' + steps.length + ' 项 ✓\n');
  });
