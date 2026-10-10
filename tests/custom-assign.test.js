/**
 * 自定义词单布置（集成测试：假数据库 + 真云函数代码）
 *
 * 背景（2026-10-09 用户反馈）：布置作业想要"预览 + 编辑"—— 删掉不想要的词、
 * 搜索加词。前端把编辑后的词单整份传给服务端（words 参数），所见即所得。
 *
 * 必须在执行时才能暴露的错位：
 *   ① 服务端拿到 words 后按自己的规则重排/去重 → 预览里看到的顺序和实际练的顺序不一样；
 *   ② 词单里有库里没有的词被静默丢掉 → 老师以为布置了 8 个词、孩子只练到 6 个；
 *   ③ 老路径（不传 words 的 tag/unit 布置）被波及 → 老功能变样。
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

function seed() {
  db.reset();
  db.seed('users', [
    { _id: 'T', openid: COACH, role: 'coach', class_id: 'C1', nickname: '王老师' }
  ]);
  db.seed('classes', [{
    _id: 'C1', name: '四年二班', code: 'ABC234', owner_id: 'T',
    student_ids: [], created_at: 1000
  }]);
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
  var base = { action: 'assign', clientReqId: 'custom-req-' + (++reqSeq) };
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

console.log('自定义词单布置测试：');

ok('① 传 words 就按传入顺序存：预览里什么顺序、练的时候就是什么顺序', function () {
  seed();
  // 故意打乱 Unit 3 的课本顺序 —— 服务端必须尊重老师排的顺序
  var unit3 = WORDS.filter(function (w) { return w.volume === 'wy4a' && w.unit === 3; })
    .sort(function (a, b) { return a.unit_order - b.unit_order; })
    .map(function (w) { return w.word; });
  var shuffled = [unit3[5], unit3[0], unit3[8], unit3[2], unit3[11]];
  return assign({ words: shuffled, tag: '全部', count: 10 }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var a = r.data.assignment;
    assert.deepStrictEqual(a.word_ids, shuffled,
      '词单顺序必须与传入完全一致，实际：' + a.word_ids.join(','));
    assert.strictEqual(a.count, shuffled.length, 'count = 词单长度');
    assert.strictEqual(a.personalized, false);
  });
});

ok('② 词单里有库里没有的词：配上的照常布置，配不上的如实回报 missing', function () {
  seed();
  return assign({ words: ['sport', 'jump', 'high', 'zzznotexist', 'qqqnope'], tag: '全部' }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.data.assignment.word_ids, ['sport', 'jump', 'high']);
    assert.deepStrictEqual(r.data.missing, ['zzznotexist', 'qqqnope'],
      'missing 必须如实列出，实际：' + JSON.stringify(r.data.missing));
  });
});

ok('③ 词单几乎全不在库里：明确报错，绝不"布置成功"却只有 0 个词', function () {
  seed();
  return assign({ words: ['zzz1', 'zzz2', 'zzz3'], tag: '全部' }).then(function (r) {
    assert.strictEqual(r.ok, false, '不该成功：' + JSON.stringify(r));
    assert.strictEqual(r.code, 'WORDS_EMPTY');
  });
});

ok('④ 去重 + 清洗：重复传、带空格、非字符串都能收敛成干净词单', function () {
  seed();
  return assign({
    words: ['sport', ' sport ', 'sport', 42, '', null, 'jump', 'high', 'high'],
    tag: '全部'
  }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.data.assignment.word_ids, ['sport', 'jump', 'high'],
      '去重后应为 3 个，实际：' + JSON.stringify(r.data.assignment.word_ids));
  });
});

ok('⑤ 编辑后数量仍受上下限约束：少于 3 个 / 超过 30 个都要拒绝', function () {
  seed();
  return assign({ words: ['sport', 'jump'], tag: '全部' }).then(function (r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'BAD_PARAM');
    var tooMany = [];
    for (var i = 0; i < 31; i++) tooMany.push('w' + i);
    return assign({ words: tooMany, tag: '全部' });
  }).then(function (r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'BAD_PARAM');
  });
});

ok('⑥ 作业名带"自定义"后缀：家长一眼看出这份词单和课本不完全一样', function () {
  seed();
  return assign({ words: ['sport', 'jump', 'high'], volume: 'wy4a', unit: 1 }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var a = r.data.assignment;
    assert.ok(/自定义/.test(a.name), '作业名应含"自定义"，实际：' + a.name);
    assert.strictEqual(a.unit, 1, 'unit 字段保留（显示"Unit 1·自定义"用）');
  });
});

ok('⑦ ★ 个性化 + 自定义词单组合：候选池就是老师选的这批词', function () {
  seed();
  var list = ['sport', 'jump', 'high', 'far', 'hope', 'lose'];
  return assign({ words: list, tag: '全部', personalized: true }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var a = r.data.assignment;
    assert.strictEqual(a.personalized, true);
    // publicAssignment 不下发 pool_ids（池子是内部数据）—— 查原始库文档
    var raw = db.raw.assignments[0];
    assert.ok(raw.pool_ids && raw.pool_ids.length, '个性化作业必须存 pool_ids');
    raw.pool_ids.forEach(function (w) {
      assert.ok(list.indexOf(w) >= 0, '候选池混入了池外的词：' + w);
    });
    (a.word_ids || []).forEach(function (w) {
      assert.ok(list.indexOf(w) >= 0, '词单混入了池外的词：' + w);
    });
  });
});

ok('⑧ 老路径不受影响：不传 words 时按 tag/unit 服务端选词（行为与从前一致）', function () {
  seed();
  return assign({ tag: '全部', count: 5 }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var a = r.data.assignment;
    assert.strictEqual(a.count, 5);
    assert.ok(!/自定义/.test(a.name), '老路径作业名不该有"自定义"，实际：' + a.name);
    assert.strictEqual(r.data.missing, undefined);
    // freq 升序：应取 freq 最小的老词，而不是任何教材新词
    var minFreq = WORDS.filter(function (w) { return !w.volume; })
      .sort(function (x, y) { return x.freq - y.freq; }).slice(0, 5).map(function (w) { return w.word; });
    assert.deepStrictEqual(a.word_ids, minFreq);
  });
});

steps.reduce(function (chain, fn) { return chain.then(fn); }, Promise.resolve())
  .then(function () { console.log('\n' + (process.exitCode ? '有用例失败' : '全部通过：' + steps.length + ' 项 ✓')); });
