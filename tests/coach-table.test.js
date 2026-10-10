/**
 * 老师端"一张表"测试（假数据库 + 真云函数代码）
 *
 * 为什么要单独这一段：老师端的价值不在"能看到数据"，而在**5 秒内答出三个问题**——
 *   谁没交 / 错得最多是哪几个词 / 错成什么样（少字母？相邻颠倒？）
 * 这三条有一条算错，老师拿到手的就是一张漂亮但没法用的表：
 *   - pending_names 漏一个人 → 老师以为全班交齐了，孩子漏掉没人管；
 *   - 错词 TOP 排错序 → 明天早读讲错词；
 *   - 错法归类错 → 老师照着"粗心"去讲，其实孩子是字母顺序没建立。
 * 这些数据同口径Bug只会在真实聚合里暴露，静态断言测不出来，所以走假库跑真代码。
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
var S_A = 'openid-a';
var S_B = 'openid-b';
var WORD_LIST = ['cat', 'dog', 'bird', 'fish', 'book'];

function seed() {
  db.reset();
  db.seed('users', [
    { _id: 'T', openid: COACH, role: 'coach', class_id: 'C1', nickname: '王老师' },
    { _id: 'A', openid: S_A, role: 'student', class_id: 'C1', nickname: '小明', last_seen_at: 1 },
    { _id: 'B', openid: S_B, role: 'student', class_id: 'C1', nickname: '小红', last_seen_at: 1 }
  ]);
  db.seed('classes', [{
    _id: 'C1', name: '四年二班', code: 'ABC234', owner_id: 'T',
    student_ids: ['A', 'B'], created_at: 1000
  }]);
  db.seed('assignments', [{
    _id: 'A1', class_id: 'C1', tag: '中考', name: '周三作业', word_ids: WORD_LIST,
    count: WORD_LIST.length, deadline: '', note: '', personalized: false,
    created_by: 'T', created_at: 1000
  }]);
  db.seed('words', [
    { _id: 'w1', word: 'cat', def_cn: '猫', freq: 1, tags: ['中考'] },
    { _id: 'w2', word: 'dog', def_cn: '狗', freq: 2, tags: ['中考'] },
    { _id: 'w3', word: 'bird', def_cn: '鸟', freq: 3, tags: ['中考'] },
    { _id: 'w4', word: 'fish', def_cn: '鱼', freq: 4, tags: ['中考'] },
    { _id: 'w5', word: 'book', def_cn: '书', freq: 5, tags: ['中考'] }
  ]);
  // 小明：cat 学过（完成 1/5）；小红：一个都没学
  db.seed('user_word_state_v2', [
    { _id: 'A:cat', user_id: 'A', word_id: 'cat', stage: 1, correct_count: 1, wrong_count: 0,
      last_feedback: 'known', next_review_at: Date.now() + 86400000 },
    { _id: 'B:dog', user_id: 'B', word_id: 'dog', stage: 0, correct_count: 0, wrong_count: 1,
      last_feedback: 'forgot', next_review_at: 1000 }
  ]);
  db.seed('review_logs', [
    // 小明：cat 拼错两次（一次单个字母写错 c→k，一次相邻颠倒）
    { _id: 'l1', user_id: 'A', word_id: 'cat', feedback: 'forgot', mode: 'learn',
      duration_ms: 100, review_date: '2026-10-08', wrong_answer: 'kat', created_at: 1 },
    { _id: 'l2', user_id: 'A', word_id: 'cat', feedback: 'forgot', mode: 'learn',
      duration_ms: 100, review_date: '2026-10-08', wrong_answer: 'cta', created_at: 2 },
    // 小红：相邻颠倒 + 少字母
    { _id: 'l3', user_id: 'B', word_id: 'bird', feedback: 'forgot', mode: 'learn',
      duration_ms: 100, review_date: '2026-10-08', wrong_answer: 'brid', created_at: 3 },
    { _id: 'l4', user_id: 'B', word_id: 'fish', feedback: 'forgot', mode: 'learn',
      duration_ms: 100, review_date: '2026-10-08', wrong_answer: 'fsh', created_at: 4 },
    // 多字母
    { _id: 'l5', user_id: 'A', word_id: 'book', feedback: 'forgot', mode: 'learn',
      duration_ms: 100, review_date: '2026-10-08', wrong_answer: 'boook', created_at: 5 },
    // 老客户端上报（没有 wrong_answer）：不能计入错因，也不该污染词级统计
    { _id: 'l6', user_id: 'B', word_id: 'book', feedback: 'forgot', mode: 'learn',
      duration_ms: 100, review_date: '2026-10-08', created_at: 6 },
    // 跟作业无关的词：不该出现在班级表
    { _id: 'l7', user_id: 'A', word_id: 'apple', feedback: 'forgot', mode: 'learn',
      duration_ms: 100, review_date: '2026-10-08', wrong_answer: 'aple', created_at: 7 }
  ]);
}

function as(openid, fn) {
  CURRENT_OPENID = openid;
  return Promise.resolve().then(fn).then(function (r) { CURRENT_OPENID = ''; return r; });
}

function fetchAssignments() {
  return as(COACH, function () { return classFn.main({ action: 'assignments' }); });
}

var steps = [];
function ok(name, fn) {
  steps.push(function () {
    return Promise.resolve().then(fn).then(function () {
      console.log('  ✓ ' + name);
    }).catch(function (e) {
      console.log('  ✗ ' + name);
      console.log('    ' + (e && e.message));
      console.log(String((e && e.stack) || '').split('\n').slice(1, 4).join('\n'));
      process.exitCode = 1;
    });
  });
}

console.log('老师端一张表测试：');

ok('① 谁没交：pending_names 列出未完成的人', function () {
  seed();
  return fetchAssignments().then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var a = r.data.assignments[0];
    assert.strictEqual(a.total_students, 2);
    assert.deepStrictEqual(a.pending_names.slice().sort(), ['小红', '小明'].sort(),
      '两人都没做完，应都列出，实际：' + JSON.stringify(a.pending_names));
  });
});

ok('② ★ 完成了的人不再出现在未交名单里', function () {
  seed();
  // 小明把 5 个词都学过 → 不再是"没交"
  var now = Date.now() + 86400000;
  db.seed('user_word_state_v2', WORD_LIST.map(function (w, i) {
    return { _id: 'A:' + w, user_id: 'A', word_id: w, stage: 1, correct_count: 1, wrong_count: 0,
      last_feedback: 'known', next_review_at: now + i };
  }));
  return fetchAssignments().then(function (r) {
    var a = r.data.assignments[0];
    assert.deepStrictEqual(a.pending_names, ['小红'], '只剩小红：' + JSON.stringify(a.pending_names));
    assert.strictEqual(a.finished, 1, '完成人数应为 1');
  });
});

ok('③ 错词 TOP：按次数降序，且带释义（老师能直接开讲）', function () {
  seed();
  return fetchAssignments().then(function (r) {
    var a = r.data.assignments[0];
    var cw = a.class_wrong;
    assert.strictEqual(cw.wrong_top[0].word, 'cat', 'cat 错 2 次应排第一，实际 ' + JSON.stringify(cw.wrong_top));
    assert.strictEqual(cw.wrong_top[0].cnt, 2);
    assert.strictEqual(cw.wrong_top[0].trans, '猫', '应带中文释义');
    ['bird', 'fish', 'book'].forEach(function (w) {
      assert.ok(cw.wrong_top.some(function (x) { return x.word === w; }), '缺少错词 ' + w);
    });
  });
});

ok('④ 错法归类：相邻颠倒 / 少字母 / 多字母 / 单个字母写错', function () {
  seed();
  return fetchAssignments().then(function (r) {
    var kindOf = function (k) {
      var hit = null;
      r.data.assignments[0].class_wrong.mistake_top.forEach(function (m) {
        if (m.key === k) hit = m;
      });
      return hit;
    };
    assert.ok(kindOf('相邻字母颠倒'), '应有相邻字母颠倒');
    assert.strictEqual(kindOf('相邻字母颠倒').cnt, 2, 'cat→cta、bird→brid 共 2 次');
    assert.ok(kindOf('少字母'), 'fish→fsh 应判少字母');
    assert.ok(kindOf('多字母'), 'book→boook 应判多字母');
    assert.ok(kindOf('单个字母写错'), 'cat→kat 应判单个字母写错');
  });
});

ok('⑤ 字母混淆对（c→k）：最细的一条诊断只对单字母错误给出', function () {
  seed();
  return fetchAssignments().then(function (r) {
    var lt = r.data.assignments[0].class_wrong.letter_top;
    assert.ok(lt.length, '应有字母混淆统计');
    assert.strictEqual(lt[0].key, 'c→k', '实际：' + JSON.stringify(lt));
    assert.strictEqual(lt[0].cnt, 1);
    // 其余三条都不是单字母错误，不该出现在 letter_top
    lt.forEach(function (x) {
      assert.ok(x.key.indexOf('→') > 0, 'letter_top 只放确切的字母替换：' + x.key);
    });
  });
});

ok('⑥ 没有 wrong_answer 的老记录不计入错因（但也不崩）', function () {
  seed();
  return fetchAssignments().then(function (r) {
    var cw = r.data.assignments[0].class_wrong;
    assert.strictEqual(cw.counted, 5, '只有 5 条带错拼原文的记录，实际 ' + cw.counted);
    var book = cw.wrong_top.filter(function (w) { return w.word === 'book'; })[0];
    assert.strictEqual(book.cnt, 1, 'book 只应计入有错拼原文的那 1 条，实际 ' + book.cnt);
  });
});

ok('⑦ 与作业无关的词不进班级表（apple 不该出现）', function () {
  seed();
  return fetchAssignments().then(function (r) {
    var cw = r.data.assignments[0].class_wrong;
    cw.wrong_top.forEach(function (w) {
      assert.notStrictEqual(w.word, 'apple', '不该混进无关的词');
    });
  });
});

ok('⑧ 一个错拼都没有时给空结构而不是 undefined（前端不必到处判空）', function () {
  seed();
  db.seed('review_logs', []);
  return fetchAssignments().then(function (r) {
    var cw = r.data.assignments[0].class_wrong;
    assert.deepStrictEqual(cw.wrong_top, []);
    assert.deepStrictEqual(cw.mistake_top, []);
    assert.deepStrictEqual(cw.letter_top, []);
    assert.strictEqual(cw.counted, 0);
  });
});

ok('⑨ 点名分级：词全学过但有忘词 → review_names，不进红标"还没完成"（2026-10-10）', function () {
  seed();
  // 小明把 5 个词都学过，但其中 dog 抽查答了忘 → 9/10·忘1 型：不该和 0/10 的一起挨催
  var now = Date.now() + 86400000;
  db.seed('user_word_state_v2', WORD_LIST.map(function (w, i) {
    return {
      _id: 'A:' + w, user_id: 'A', word_id: w, stage: 1,
      correct_count: 1, wrong_count: 0,
      last_feedback: (w === 'dog') ? 'forgot' : 'known',
      next_review_at: now + i
    };
  }));
  return fetchAssignments().then(function (r) {
    var a = r.data.assignments[0];
    assert.deepStrictEqual(a.pending_names, ['小红'],
      '真没动的小红才进"还没完成"：' + JSON.stringify(a.pending_names));
    assert.deepStrictEqual(a.review_names, ['小明（忘 1）'],
      '学过但有忘词的进"忘词待巩固"：' + JSON.stringify(a.review_names));
    assert.strictEqual(a.finished, 0, '忘词不算完成，完成人数仍为 0（口径不变）');
    var ps = {};
    a.per_student.forEach(function (p) { ps[p.nickname] = p.state; });
    assert.strictEqual(ps['小明'], 'review', '小明应是 review 态');
    assert.strictEqual(ps['小红'], 'pending', '小红应是 pending 态');
  });
});

ok('⑩ 释义含换行/词文本带空格：清洗成一行，chip 不被撑成大气泡（2026-10-10 实锤）', function () {
  seed();
  // cat 的 translation 改成 ECDICT 常见的多词义竖排（含前导空行）；
  // 再造一条 word_id 带首尾空格的错拼日志
  db.seed('words', [
    { _id: 'w1', word: 'cat', def_cn: '', translation: '\n n. 猫 \n v. 猫叫 \n', freq: 1, tags: ['中考'] },
    { _id: 'w2', word: 'dog', def_cn: '狗', freq: 2, tags: ['中考'] },
    { _id: 'w3', word: 'bird', def_cn: '鸟', freq: 3, tags: ['中考'] },
    { _id: 'w4', word: 'fish', def_cn: '鱼', freq: 4, tags: ['中考'] },
    { _id: 'w5', word: 'book', def_cn: '书', freq: 5, tags: ['中考'] }
  ]);
  db.seed('review_logs', [
    { _id: 'l8', user_id: 'A', word_id: ' cat ', feedback: 'forgot', mode: 'learn',
      duration_ms: 100, review_date: '2026-10-10', wrong_answer: 'kat', created_at: 8 }
  ]);
  // 真实场景：作业词单本身就带空格（与日志同源），所以查询要用原始带空格的 id 才命中的上
  db.seed('assignments', [{
    _id: 'A1', class_id: 'C1', tag: '中考', name: '周三作业',
    word_ids: [' cat '].concat(WORD_LIST.slice(1)),
    count: WORD_LIST.length, deadline: '', note: '', personalized: false,
    created_by: 'T', created_at: 1000
  }]);
  return fetchAssignments().then(function (r) {
    var cw = r.data.assignments[0].class_wrong;
    var cat = cw.wrong_top.filter(function (w) { return w.word === 'cat'; })[0];
    assert.ok(cat, '带空格的 word_id 应清洗后计入 cat：' + JSON.stringify(cw.wrong_top));
    assert.ok(!/\s/.test(cat.word), '词文本不应残留空白：' + JSON.stringify(cat));
    assert.ok(cat.trans.indexOf('\n') < 0, '释义不能带换行：' + JSON.stringify(cat));
    assert.ok(cat.trans.length <= 24, '释义限长 24，实际 ' + cat.trans.length);
    assert.strictEqual(cat.trans, 'n. 猫、v. 猫叫', '释义应压成一行、顿号连接：' + cat.trans);
  });
});

steps.reduce(function (chain, fn) { return chain.then(fn); }, Promise.resolve())
  .then(function () { console.log('\n全部通过：' + steps.length + ' 项 ✓'); });
