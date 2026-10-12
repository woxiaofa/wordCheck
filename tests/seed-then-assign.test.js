/**
 * 一次性「词库重导入 + 换版清理」验收（假库跑真函数 + 跨函数衔接）
 *
 * 为什么必须有它：cloud/functions/seedwords 是一次性工具，用完即删，
 * 但它在真云上只会跑一次——一旦逻辑有错，错的是生产数据（300 条历史记录可能被写坏）。
 * 所以先在假库把"旧库 → 清理 → 导入 → 回查 → 布置 Unit 3"整条链跑通，
 * 再拿同样的代码上真云，剩下的不确定性就只有网络。
 *
 * 三条刻意设计的断言，都是本项目出过的事故类型：
 *   ① 导入前 Unit 3 必须查不到 —— 把"老师布置成功却是空词单"这件事提前演一遍；
 *   ② 布置结果必须与课本顺序一致 —— 顺序错了不算错数据，但孩子练的顺序跟课本对不上。
 *   ③ clean 换版清理的计数必须与本地重建完全一致（删 80 / 摘 7 / 留 22）——
 *      云端规则若与 scripts/build-waiyan.js 的 cleanStaleVolume 有一丝不同构，
 *      云端词库就会和本地 words.js 悄悄分叉，而且是那种"看总数看不出"的分叉。
 *      旧库现场用 tests/fixtures/old-cloud-1010.js（git 提交 befaf7d 快照拼装）。
 *
 * 本文件随 seedwords 函数一起删除。
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
var seedFn = require('../cloud/functions/seedwords/index.js');
var classFn = require('../cloud/functions/class/index.js');
Module._load = origLoad;

var TOKEN = 'wc-seed-20261008';
var WORDS = require('../miniprogram/data/words.js');
var DATA = require('../cloud/functions/seedwords/words-data.js');
/** 换版前真实云端现场（400 词：291 底库 + 109 个挂旧版三级字段的教材词） */
var OLD_CLOUD = require('./fixtures/old-cloud-1010.js');
/** 新词表本册词全集：clean 的白名单 */
var NEW_SET = WORDS.filter(function (w) { return w.volume === 'wy4a'; }).map(function (w) { return String(w.word); });

var COACH = 'openid-coach';

/** 期望值全部从词库算出来，不手抄 —— 手抄的数字会在下次改词库时撒谎 */
function localUnit(no) {
  return WORDS.filter(function (w) { return w.volume === 'wy4a' && Number(w.unit) === no; })
    .sort(function (a, b) { return a.unit_order - b.unit_order; })
    .map(function (w) { return w.word; });
}
var EXPECT = {};
for (var u = 1; u <= 6; u++) EXPECT[u] = localUnit(u);   // 2024 新版只有 6 个 Unit
var NEW_COUNT = WORDS.filter(function (w) { return w.freq >= 7000; }).length;
var OLD_COUNT = WORDS.length - NEW_COUNT;

/**
 * 旧云端：2026-10-07 那版导出的 300 词，**刻意不带三级字段**，
 * 这就是"老师按 Unit 布置会拿到空词单"的现场。
 */
function seedOldCloud() {
  db.reset();
  var i = 0;
  db.seed('words', WORDS.filter(function (w) { return w.freq < 7000; }).map(function (w) {
    return {
      _id: 'old-' + (i++), word: w.word, def_cn: w.def_cn, tags: w.tags, freq: w.freq
    };
  }));
  db.seed('users', [
    { _id: 'T', openid: COACH, role: 'coach', class_id: 'C1', nickname: '王老师' },
    { _id: 'A', openid: 'openid-a', role: 'student', class_id: 'C1', nickname: '小明', last_seen_at: 1 }
  ]);
  db.seed('classes', [{
    _id: 'C1', name: '四年二班', code: 'ABC234', owner_id: 'T',
    student_ids: ['A'], created_at: 1000
  }]);
  db.seed('assignments', []);
  db.seed('user_word_state_v2', []);
}

/**
 * 真实旧库现场（clean 用例专用）：tests/fixtures/old-cloud-1010.js 的 400 词，
 * 含 109 个挂 volume:'wy4a' + unit:1..10 的旧版教材词 —— 这就是云端 2026-10-10
 * 换版时的真实状态（probe 的 stale_units 不为 0、Unit 词数对不上新课本）。
 * fakedb 的 seed 不补 _id，这里必须带上，clean 要用 doc(_id).remove()。
 */
function seedRealOldCloud() {
  seedOldCloud();
  db.seed('words', OLD_CLOUD.map(function (d, i) {
    return Object.assign({ _id: 'oldc-' + i }, d);
  }));
}

function seedRun(action, extra) {
  var payload = { action: action, token: TOKEN };
  Object.keys(extra || {}).forEach(function (k) { payload[k] = extra[k]; });
  return seedFn.main(payload);
}

function as(openid, fn) {
  CURRENT_OPENID = openid;
  return Promise.resolve().then(fn).then(function (r) { CURRENT_OPENID = ''; return r; });
}

var reqSeq = 0;
function assignUnit(unit, count) {
  return as(COACH, function () {
    return classFn.main({
      action: 'assign', clientReqId: 'seed-req-' + (++reqSeq),
      volume: 'wy4a', unit: unit, count: count
    });
  });
}

var steps = [];
function ok(name, fn) {
  steps.push(function () {
    return Promise.resolve().then(fn).then(function () {
      console.log('  ✓ ' + name);
    }).catch(function (e) {
      console.log('  ✗ ' + name + ' —— ' + e.message);
      process.exitCode = 1;
    });
  });
}

console.log('词库重导入验收（旧库 ' + OLD_COUNT + ' 词 + 新词 ' + NEW_COUNT + ' 条）\n');

ok('① 导入前：云端按 Unit 3 一个词都查不到（这就是"空作业"事故的现场）', function () {
  seedOldCloud();
  return seedRun('probe').then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.units[2].count, 0, 'Unit 3 应为 0 个词，实际 ' + r.units[2].count);
    assert.strictEqual(r.total, OLD_COUNT, 'total 应为旧库条数 ' + OLD_COUNT);
  });
});

ok('② token 不对必须被拒（这个函数能全表 upsert，不能敞开）', function () {
  return seedFn.main({ action: 'import', token: 'wrong' }).then(function (r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'BAD_TOKEN');
  });
});

// 循环分片把 400 词导完（模拟用户在控制台按 next_from 连点几次）
function importAll(chunkSize) {
  var agg = { added: 0, updated: 0, skipped_same: 0, failures: [], rounds: 0 };
  function step(from) {
    return seedRun('import', { from: from, size: chunkSize || 100 }).then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      agg.rounds++;
      agg.added += r.added;
      agg.updated += r.updated;
      agg.skipped_same += r.skipped_same;
      agg.failures = agg.failures.concat(r.failures);
      if (r.done) return agg;
      assert.ok(r.next_from > from, 'next_from 必须前进，否则死循环');
      return step(r.next_from);
    });
  }
  return step(0);
}

ok('③ 导入（分片跑完）：新词入库（add ' + NEW_COUNT + '）、旧教材词补字段（update 9）、无变化的旧词跳过', function () {
  return importAll().then(function (agg) {
    // 旧库里真正"有变化"的只有 9 个教材词（freq<7000 的 wy4a 词，要补三级字段）；
    // 其余 291 个非教材旧词目标值是 book:''/volume:''/unit:0 —— 与"字段不存在"语义相等，跳过。
    // 这不是偷懒：300 次无效写入省掉后，单片耗时大幅低于 60s 超时线。
    var DIRTY_OLD = WORDS.filter(function (w) { return w.volume === 'wy4a' && w.freq < 7000; }).length;
    assert.strictEqual(agg.failures.length, 0, '不该有失败：' + JSON.stringify(agg.failures));
    assert.strictEqual(agg.added, NEW_COUNT, 'added');
    assert.strictEqual(agg.updated, DIRTY_OLD, 'updated 应=需补字段的旧教材词数 ' + DIRTY_OLD);
    assert.strictEqual(agg.skipped_same, OLD_COUNT - DIRTY_OLD, 'skipped_same');
    assert.ok(agg.rounds >= 4, '400 词 / 100 每片，至少 4 轮，实际 ' + agg.rounds);
  });
});

ok('④ ★ 回查：每个 Unit 的词数与课本完全一致，合计 ' + NEW_SET.length, function () {
  return seedRun('probe').then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.unit_sum, EXPECT_COUNT(), 'unit_sum');
    for (var u = 1; u <= 6; u++) {
      assert.strictEqual(r.units[u - 1].count, EXPECT[u].length,
        'Unit ' + u + ' 词数：云端 ' + r.units[u - 1].count + ' vs 课本 ' + EXPECT[u].length);
      assert.strictEqual(r.units[u - 1].continuous, true, 'Unit ' + u + ' 的 unit_order 不是 1..n 连续');
    }
  });
  function EXPECT_COUNT() {
    return WORDS.filter(function (w) { return w.volume === 'wy4a'; }).length;
  }
});

ok('⑤ ★ 回查顺序：Unit 3 前三个词必须是课本那三个（一律 unit_order，不是 freq）', function () {
  return seedRun('probe').then(function (r) {
    var top3 = r.units[2].top3.map(function (s) { return s.replace(/\(\d+\)$/, ''); });
    assert.deepStrictEqual(top3, EXPECT[3].slice(0, 3),
      'Unit 3 前 3 词：云端 ' + JSON.stringify(top3) + ' vs 课本 ' + JSON.stringify(EXPECT[3].slice(0, 3)));
  });
});

ok('⑥ 幂等：再导一次不重复插、不改写（skipped_same 全部跳过，上线手抖点两下也不脏库）', function () {
  return importAll().then(function (agg) {
    assert.strictEqual(agg.added, 0, '第二次不该有新增，实际 added=' + agg.added);
    assert.strictEqual(agg.updated, 0, '内容没变的词不该改写，实际 updated=' + agg.updated);
    assert.strictEqual(agg.skipped_same, WORDS.length, 'skipped_same 应=总词数');
    assert.strictEqual(agg.failures.length, 0, JSON.stringify(agg.failures));
  });
});

ok('⑥b ★ 断点续跑：模拟 3 秒超时被掐断（只完成第 1 片），从 next_from 接着跑必须补齐', function () {
  function WY_COUNT() {
    return WORDS.filter(function (w) { return w.volume === 'wy4a'; }).length;
  }
  seedOldCloud();  // 还原事故现场：旧库 300 词、无三级字段
  return seedRun('import', { from: 0, size: 100 }).then(function (r1) {
    assert.strictEqual(r1.ok, true, JSON.stringify(r1));
    assert.strictEqual(r1.done, false, '第 1 片不该 done');
    // 事故现场确认：此刻云端 Unit 词不全（就像 probe 截图里 wy4a_total:3）
    return seedRun('probe').then(function (p) {
      assert.ok(p.unit_sum < WY_COUNT(), '中断时 unit_sum 应不足 ' + WY_COUNT() + '，实际 ' + p.unit_sum);
    });
  }).then(function () {
    return importAll();  // 用户重跑：已完成的词 skipped_same 跳过，只补缺口
  }).then(function (agg) {
    assert.strictEqual(agg.failures.length, 0, JSON.stringify(agg.failures));
    assert.ok(agg.skipped_same > 0, '第 1 片的词应被跳过，实际 skipped_same=' + agg.skipped_same);
    return seedRun('probe');
  }).then(function (p) {
    assert.strictEqual(p.unit_sum, WY_COUNT(), '续跑后 unit_sum 必须补齐到 ' + WY_COUNT());
    assert.strictEqual(p.total, WORDS.length, 'total');
  });
});

ok('⑦ ★ 跨函数衔接：导入后的库，老师布置 Unit 3 拿到的就是课本那 ' + EXPECT[3].length + ' 个词且顺序一致', function () {
  return assignUnit(3, 30).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var a = r.data.assignment;
    assert.strictEqual(a.word_ids.join(','), EXPECT[3].join(','),
      '布置出来的词单与课本不一致：\n  云端 ' + a.word_ids.join(',') + '\n  课本 ' + EXPECT[3].join(','));
    assert.ok(a.unit_label.indexOf('Unit 3') >= 0, '作业名应带单元：' + a.unit_label);
  });
});

ok('⑧ Unit 6（小单元）同样成立：布置数给大了也收敛到实际 ' + EXPECT[6].length + ' 个', function () {
  return assignUnit(6, 30).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var a = r.data.assignment;
    assert.strictEqual(a.word_ids.length, EXPECT[6].length,
      'Unit 6 应收敛到 ' + EXPECT[6].length + ' 个，实际 ' + a.word_ids.length);
    assert.strictEqual(a.count, EXPECT[6].length, 'count 必须等于实际词数');
  });
});

/** clean 期望计数：与 clean 处置规则同构地从夹具算，不手抄 —— 手抄的 80/7/22 会在下次换版时撒谎 */
function cleanExpectation() {
  var newSet = new Set(NEW_SET);
  var exp = { kept: 0, deleted: 0, untagged: 0 };
  OLD_CLOUD.forEach(function (d) {
    if (d.volume !== 'wy4a') return;
    if (newSet.has(String(d.word))) exp.kept++;
    else if (Number(d.freq || 0) >= 7000) exp.deleted++;
    else exp.untagged++;
  });
  return exp;
}

/** 模拟控制台连点：from 起步，一路跑到 done（next_from 回 0） */
function cleanAll() {
  var agg = { deleted: 0, untagged: 0, kept: 0, failures: [], calls: 0 };
  function step(from) {
    return seedRun('clean', { from: from }).then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      agg.calls++;
      agg.deleted += r.deleted;
      agg.untagged += r.untagged;
      agg.kept += r.kept;
      agg.failures = agg.failures.concat(r.failures);
      if (r.done) return agg;
      assert.ok(r.next_from > from, 'next_from 必须前进，否则死循环');
      return step(r.next_from);
    });
  }
  return step(1);
}

ok('⑨ 换版现场：真实旧库（400 词 / 109 个挂旧版三级字段）probe 必须报 stale_units > 0', function () {
  seedRealOldCloud();
  var stale = OLD_CLOUD.filter(function (d) {
    return d.volume === 'wy4a' && Number(d.unit) > 6;
  }).length;
  return seedRun('probe').then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.total, OLD_CLOUD.length, 'total 应为旧库 400');
    assert.strictEqual(r.stale_units, stale,
      'stale_units 应为旧 Unit 7~10 的 ' + stale + ' 词，实际 ' + r.stale_units);
    assert.ok(r.stale_units > 0, '换版没清理前 stale_units 必须能报警');
  });
});

ok('⑩ ★ clean 跑完：删/摘/留的计数与本地重建完全同构（80 删 / 7 摘 / 22 留），库内无幽灵词', function () {
  var exp = cleanExpectation();
  return cleanAll().then(function (agg) {
    assert.strictEqual(agg.failures.length, 0, '不该有失败：' + JSON.stringify(agg.failures));
    assert.strictEqual(agg.deleted, exp.deleted, 'deleted 应=' + exp.deleted + '（与本地 cleanStaleVolume 一致）');
    assert.strictEqual(agg.untagged, exp.untagged, 'untagged 应=' + exp.untagged);
    assert.strictEqual(agg.kept, exp.kept, 'kept 应=' + exp.kept);
    assert.ok(agg.calls >= 5, '10 个单元 / 每次扫 2 个，至少 5 次调用，实际 ' + agg.calls);
    return db.collection('words').where({ volume: 'wy4a' }).get();
  }).then(function (res) {
    var newSet = new Set(NEW_SET);
    var ghosts = res.data.filter(function (w) { return !newSet.has(String(w.word)); });
    assert.strictEqual(ghosts.length, 0,
      '库内不该再有不属于新词表的 wy4a 词（幽灵词）：' + ghosts.map(function (w) { return w.word; }).join(','));
    // 摘标签退回普通词的：无外研四上标签、三级字段清空
    var untagged = {};
    OLD_CLOUD.forEach(function (d) {
      if (d.volume === 'wy4a' && !newSet.has(String(d.word)) && Number(d.freq || 0) < 7000) untagged[d.word] = d;
    });
    return db.collection('words').where({}).get().then(function (all) {
      var byWord = {};
      all.data.forEach(function (w) { byWord[w.word] = w; });
      Object.keys(untagged).forEach(function (word) {
        var w = byWord[word];
        assert.ok(w, '摘标签的词不该被删：' + word);
        assert.ok((w.tags || []).indexOf('外研四上') === -1, word + ' 不该再挂教材标签');
        assert.ok(!w.volume || w.volume === '', word + ' 的 volume 应已清空');
      });
      // 删除的：整条没了
      var deleted = {};
      OLD_CLOUD.forEach(function (d) {
        if (d.volume === 'wy4a' && !newSet.has(String(d.word)) && Number(d.freq || 0) >= 7000) deleted[d.word] = d;
      });
      Object.keys(deleted).forEach(function (word) {
        assert.ok(!byWord[word], '该删的词还躺在库里：' + word);
      });
      // 291 个底库普通词一个都不能少（clean 只动本册）
      assert.strictEqual(all.data.length, OLD_CLOUD.length - exp.deleted, '总词数应=400-' + exp.deleted);
    });
  });
});

ok('⑪ clean 幂等 + clean 后 import + probe 终检：stale_units 归零、6 个 Unit 与课本一致', function () {
  return cleanAll().then(function (agg) {   // 再跑一遍：全库已干净，应零删零摘
    assert.strictEqual(agg.deleted, 0, '第二遍 clean 不该再删（幂等），实际 ' + agg.deleted);
    assert.strictEqual(agg.untagged, 0, '第二遍 clean 不该再摘（幂等），实际 ' + agg.untagged);
    return importAll();
  }).then(function (agg) {
    assert.strictEqual(agg.failures.length, 0, JSON.stringify(agg.failures));
    return seedRun('probe');
  }).then(function (p) {
    assert.strictEqual(p.ok, true, JSON.stringify(p));
    assert.strictEqual(p.stale_units, 0, '终检 stale_units 必须归零，实际 ' + p.stale_units);
    assert.strictEqual(p.total, WORDS.length, 'total 应=新词库 ' + WORDS.length);
    assert.strictEqual(p.unit_sum, NEW_SET.length, 'unit_sum 应=163');
    for (var u = 1; u <= 6; u++) {
      assert.strictEqual(p.units[u - 1].count, EXPECT[u].length,
        'Unit ' + u + ' 词数：云端 ' + p.units[u - 1].count + ' vs 课本 ' + EXPECT[u].length);
    }
  }).then(function () {
    // 清理+导入后的库，布置 Unit 1 必须拿到课本词单（旧库上直接跑的老路径对照）
    return assignUnit(1, 30);
  }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.assignment.word_ids.join(','), EXPECT[1].join(','),
      'clean+import 之后布置 Unit 1 的词单必须与课本一致');
  });
});

steps.reduce(function (chain, fn) { return chain.then(fn); }, Promise.resolve())
  .then(function () {
    console.log('\n' + (process.exitCode ? '有用例失败' : '全部通过：' + steps.length + ' 项 ✓'));
  });
