/**
 * 按教材单元布置作业（集成测试：假数据库 + 真云函数代码）
 *
 * 为什么必须跑真云函数而不是断言源码：这里有三处只有在执行时才暴露的错位——
 *   ① 过滤条件写错（比如用 tags 而不是 volume）→ 取到的词根本不是这个 Unit 的；
 *   ② 排序字段写错（freq 而不是 unit_order）→ 词还是那批但顺序乱了，
 *      孩子练的顺序跟课本不一样，静态断言完全测不出来；
 *   ③ count 与单元实际词数不一致 → 老师说"布置 10 个"、实际只有 8 个，
 *      这种"数字互相矛盾"正是本项目出过的事故类型。
 * 另外守住一条红线：**老方式（只传 tag）必须原地不动**，老作业不能因为加了新功能就变样。
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

var WORDS = require('../miniprogram/data/words.js');

var COACH = 'openid-coach';
var S_A = 'openid-a';

/** Unit 3（What's the weather like?，27 词）按课本顺序 —— 期望值直接取自词库，不手抄，防止手抄写错 */
var UNIT_NO = 3;
var UNIT_WORDS = WORDS.filter(function (w) { return w.volume === 'wy4a' && Number(w.unit) === UNIT_NO; })
  .sort(function (a, b) { return a.unit_order - b.unit_order; })
  .map(function (w) { return w.word; });
/** Unit 6（Find your way，20 词）：新版词数最少的单元，用来验证"布置数 > 单元词数"时的收敛 */
var SMALL_UNIT = 6;
var SMALL_WORDS = WORDS.filter(function (w) { return w.volume === 'wy4a' && Number(w.unit) === SMALL_UNIT; })
  .sort(function (a, b) { return a.unit_order - b.unit_order; })
  .map(function (w) { return w.word; });

function seed() {
  db.reset();
  db.seed('users', [
    { _id: 'T', openid: COACH, role: 'coach', class_id: 'C1', nickname: '王老师' },
    { _id: 'A', openid: S_A, role: 'student', class_id: 'C1', nickname: '小明', last_seen_at: 1 }
  ]);
  db.seed('classes', [{
    _id: 'C1', name: '四年二班', code: 'ABC234', owner_id: 'T',
    student_ids: ['A'], created_at: 1000
  }]);
  // 词库：教材词带三级字段 + 一堆非教材词（用来证明过滤真的生效）
  var textbook = WORDS.filter(function (w) { return w.volume === 'wy4a'; }).map(function (w, i) {
    return {
      _id: 'wid-' + i, word: w.word, translation: w.def_cn, freq: 7000 + i,
      tags: w.tags, book: w.book, volume: w.volume, unit: w.unit, unit_order: w.unit_order
    };
  });
  var others = WORDS.filter(function (w) { return !w.volume; }).slice(0, 40).map(function (w, i) {
    return { _id: 'oid-' + i, word: w.word, translation: w.def_cn, freq: i + 1, tags: w.tags };
  });
  db.seed('words', textbook.concat(others));
  db.seed('user_word_state_v2', []);
}

function as(openid, fn) {
  CURRENT_OPENID = openid;
  return Promise.resolve().then(fn).then(function (r) { CURRENT_OPENID = ''; return r; });
}

var reqSeq = 0;
function assign(payload) {
  var base = { action: 'assign', clientReqId: 'unit-req-' + (++reqSeq) };
  Object.keys(payload || {}).forEach(function (k) { base[k] = payload[k]; });
  return as(COACH, function () { return classFn.main(base); });
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

console.log('按单元布置作业测试：');

ok('① 取到的正是这个 Unit 的词（不多不少，不掺别的 Unit）', function () {
  seed();
  return assign({ volume: 'wy4a', unit: UNIT_NO, count: 30 }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var a = r.data.assignment;
    assert.strictEqual(a.word_ids.length, UNIT_WORDS.length,
      '应取到 ' + UNIT_WORDS.length + ' 词，实际 ' + a.word_ids.length);
    UNIT_WORDS.forEach(function (w) {
      assert.ok(a.word_ids.indexOf(w) >= 0, '缺少本单元的词：' + w);
    });
    assert.strictEqual(a.unit, UNIT_NO, '作业应标记 unit');
  });
});

ok('② ★ 词序与课本一致（按 unit_order，不是 freq）', function () {
  seed();
  return assign({ volume: 'wy4a', unit: UNIT_NO, count: 30 }).then(function (r) {
    var got = r.data.assignment.word_ids.join(',');
    assert.strictEqual(got, UNIT_WORDS.join(','),
      '词序与课本不一致：\n      实际: ' + got + '\n      课本: ' + UNIT_WORDS.join(','));
  });
});

ok('③ 布置数大于单元词数时，按实际词数收敛（不出现"说 10 个只给 8 个"）', function () {
  seed();
  return assign({ volume: 'wy4a', unit: SMALL_UNIT, count: 30 }).then(function (r) {
    var a = r.data.assignment;
    assert.strictEqual(a.count, SMALL_WORDS.length,
      'count 应收敛为单元实际词数 ' + SMALL_WORDS.length + '，实际 ' + a.count);
    assert.strictEqual(a.word_ids.length, SMALL_WORDS.length);
    return as(S_A, function () { return classFn.main({ action: 'myAssignments' }); });
  }).then(function (r) {
    var a = r.data.assignments[0];
    assert.strictEqual(a.count, SMALL_WORDS.length, '学生端看到的词数必须一致');
    assert.deepStrictEqual(a.word_ids, SMALL_WORDS, '学生端词单与课本同序');
  });
});

ok('④ 作业名与标签带上 Unit N（两份作业不再同名）', function () {
  seed();
  return assign({ volume: 'wy4a', unit: UNIT_NO, count: 20 }).then(function (r) {
    var a = r.data.assignment;
    assert.ok(a.name.indexOf('Unit ' + UNIT_NO) >= 0, '作业名应含单元：' + a.name);
    assert.ok(a.unit_label.indexOf('Unit ' + UNIT_NO) >= 0, 'unit_label 应含单元：' + a.unit_label);
    assert.ok(a.unit_label.indexOf('四年级上册') >= 0, 'unit_label 应含册名：' + a.unit_label);
    assert.strictEqual(a.tag, '外研四上', '范围标签应自动归一为教材库');
  });
});

ok('⑤ 非法参数被服务端拒绝（不信任客户端）', function () {
  seed();
  var cases = [
    [{ volume: '不存在', unit: 1, count: 10 }, '教材册无效'],
    [{ volume: 'wy4a', unit: 99, count: 10 }, '单元号超出']   // 该册只有 6 个 Unit（2024 新版）
  ];
  return cases.reduce(function (chain, c) {
    return chain.then(function () {
      return assign(c[0]).then(function (r) {
        assert.strictEqual(r.ok, false, '非法参数不应布置成功：' + JSON.stringify(c[0]));
        assert.ok(String(r.message).indexOf(c[1]) >= 0,
          '错误信息应点明原因，实际：' + r.message);
      });
    });
  }, Promise.resolve());
});

ok('⑥ ★ 老方式（只传 tag）行为不变：按词频升序，不带单元字段', function () {
  seed();
  return assign({ tag: '中考', count: 5 }).then(function (r) {
    var a = r.data.assignment;
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(a.unit, 0, '老作业不应带 unit');
    assert.strictEqual(a.unit_label, '', '老作业不应带 unit_label');
    assert.strictEqual(a.tag, '中考');
    assert.strictEqual(a.word_ids.length, 5);
    return db.collection('assignments').where({}).get();
  }).then(function (res) {
    var raw = res.data[res.data.length - 1];
    assert.ok(!raw.unit, '库里也不该写 unit 字段（保持老结构）');
    assert.strictEqual(raw.tag, '中考');
  });
});

ok('⑦ 备注优先命名：老师自己写名字时不覆盖', function () {
  seed();
  return assign({ volume: 'wy4a', unit: UNIT_NO, count: 20, note: '周五听写' }).then(function (r) {
    assert.strictEqual(r.data.assignment.name, '周五听写');
    assert.ok(r.data.assignment.unit_label.indexOf('Unit ' + UNIT_NO) >= 0,
      '备注命名时也要能看出是哪个单元');
  });
});

ok('⑧ 幂等：同一 clientReqId 重复布置只产生一份作业', function () {
  seed();
  var reqId = 'dup-unit-1';
  return as(COACH, function () {
    return classFn.main({ action: 'assign', volume: 'wy4a', unit: UNIT_NO, count: 20, clientReqId: reqId });
  }).then(function () {
    return as(COACH, function () {
      return classFn.main({ action: 'assign', volume: 'wy4a', unit: UNIT_NO, count: 20, clientReqId: reqId });
    });
  }).then(function (r) {
    assert.strictEqual(r.data.dedup, true, '第二次应命中幂等');
    return db.collection('assignments').where({}).get();
  }).then(function (res) {
    assert.strictEqual(res.data.length, 1, '只应有 1 份作业，实际 ' + res.data.length);
  });
});

ok('⑨ 每个 Unit 都能布置成功（学生端取到的词非空且在最小词数以上）', function () {
  seed();
  var chain = Promise.resolve();
  [1, 2, 3, 4, 5, 6].forEach(function (no) {
    chain = chain.then(function () {
      return assign({ volume: 'wy4a', unit: no, count: 30 });
    }).then(function (r) {
      assert.strictEqual(r.ok, true, 'Unit ' + no + ' 布置失败：' + JSON.stringify(r));
      assert.ok(r.data.assignment.count >= 3, 'Unit ' + no + ' 词数低于布置下限');
    });
  });
  return chain;
});

steps.reduce(function (chain, fn) { return chain.then(fn); }, Promise.resolve())
  .then(function () { console.log('\n全部通过：' + steps.length + ' 项 ✓'); });
