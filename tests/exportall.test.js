/**
 * exportall 云函数测试（假云端）
 *
 * 背景：免费云环境有到期日（约 2026-11-03），到期后云函数、数据库、云存储
 * 全部不可访问，数据被释放且不可恢复。所以做了一键导出全库的工具。
 *
 * 为什么必须测：这个函数平常没人碰，只在控制台手动跑一次。真到要备份那天
 * 才发现是坏的就来不及了。这里用假库把三条关键路径跑通：
 *   ① 分页：云数据库单次 get 上限 100 条，超出的要靠 skip 翻页拿全
 *   ② 缺集合不崩：集合还没建过时 get 会抛错，要记进 errors 继续下一个
 *   ③ 安全阀：数据量异常大时不能死循环把函数跑超时
 */

var assert = require('assert');
var Module = require('module');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var pass = 0;

function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

/**
 * 造一个假云端。
 * plan.colls    {集合名: 文档数组}
 * plan.missing  [不存在的集合名]（get 会抛错）
 */
function createFakeCloud(plan) {
  var calls = { upload: 0, tempUrl: 0, getPages: [] };
  var db = {
    collection: function (name) {
      if (plan.missing && plan.missing.indexOf(name) >= 0) {
        var boom = {
          get: function () {
            return Promise.reject(new Error('collection not exists: ' + name));
          }
        };
        boom.skip = function () { return boom; };
        boom.limit = function () { return boom; };
        return boom;
      }
      var rows = (plan.colls && plan.colls[name]) || [];
      var handle = {
        skip: function (n) {
          return {
            limit: function (m) {
              return {
                get: function () {
                  calls.getPages.push({ coll: name, skip: n, limit: m });
                  return Promise.resolve({ data: rows.slice(n, n + m) });
                }
              };
            }
          };
        }
      };
      return handle;
    }
  };
  var cloud = {
    DYNAMIC_CURRENT_ENV: 'fake-env',
    init: function () { },
    database: function () { return db; },
    uploadFile: function (o) {
      calls.upload++;
      calls.cloudPath = o.cloudPath;
      calls.bytes = o.fileContent.length;
      return Promise.resolve({ fileID: 'cloud://fake/' + o.cloudPath });
    },
    getTempFileURL: function (o) {
      calls.tempUrl++;
      return Promise.resolve({
        fileList: o.fileList.map(function (id) {
          return { tempFileURL: 'https://example.com/f/' + encodeURIComponent(id) };
        })
      });
    }
  };
  return { cloud: cloud, calls: calls };
}

var origLoad = Module._load;
function withCloud(cloud, fn) {
  Module._load = function (request) {
    if (request === 'wx-server-sdk') return cloud;
    return origLoad.apply(this, arguments);
  };
  return fn();
}

function loadExport() {
  var p = path.join(ROOT, 'cloud', 'functions', 'exportall', 'index.js');
  delete require.cache[p];
  return require(p);
}

console.log('\nexportall 全库导出测试');

async function main() {
  /* ① 正常全量导出：条数统计正确 + 拿到下载链接 */
  {
    var fc = createFakeCloud({
      colls: {
        users: [{ _id: 'u1' }, { _id: 'u2' }],
        words: [{ _id: 'w1' }]
      }
    });
    var mod = withCloud(fc.cloud, loadExport);
    var r = await mod.main({});
    Module._load = origLoad;
    ok('① 导出成功：ok=true、统计到 3 条、给出下载链接', function () {
      assert.strictEqual(r.ok, true, 'ok 应为 true');
      assert.strictEqual(r.total, 3, '总数应为 3，实际 ' + r.total);
      assert.strictEqual(r.counts.users, 2, 'users 应为 2 条');
      assert.ok(r.downloadUrl.indexOf('https://') === 0,
        'downloadUrl 应是 https 链接，实际 ' + r.downloadUrl);
      assert.ok(r.bytes > 0, '导出字节数应大于 0');
    });
  }

  /* ② 分页：250 条必须拿全（单次 get 只有 100 条上限） */
  {
    var many = [];
    for (var i = 0; i < 250; i++) many.push({ _id: 'd' + i, word: 'w' + i });
    var fc2 = createFakeCloud({ colls: { review_logs: many } });
    var mod2 = withCloud(fc2.cloud, loadExport);
    var r2 = await mod2.main({ collection: 'review_logs' });
    Module._load = origLoad;
    ok('② 超过 100 条的数据能翻页取全（250 条一条不少）', function () {
      assert.strictEqual(r2.counts.review_logs, 250,
        'review_logs 应导出 250 条，实际 ' + r2.counts.review_logs);
      var pages = fc2.calls.getPages.filter(function (p) { return p.coll === 'review_logs'; });
      assert.ok(pages.length >= 3, '至少应翻 3 页，实际 ' + pages.length);
    });
  }

  /* ③ 集合不存在不崩：记进 errors，其余集合照常导出 */
  {
    var fc3 = createFakeCloud({
      colls: { users: [{ _id: 'u1' }] },
      missing: ['wipe_backup', 'diag_scratch']
    });
    var mod3 = withCloud(fc3.cloud, loadExport);
    var r3 = await mod3.main({ collection: 'wipe_backup' });
    Module._load = origLoad;
    ok('③ 集合不存在时不崩，记进 errors 并返回 ok=false', function () {
      assert.strictEqual(r3.counts.wipe_backup, -1, '缺失集合应记为 -1');
      assert.ok(r3.errors.wipe_backup, 'errors 里应有该集合的原因');
      assert.strictEqual(r3.ok, false, '有失败集合时 ok 应为 false');
    });
  }

  /* ④ 大数据量：1000 条要能完整导出并正常终止 */
  {
    var endless = [];
    for (var k = 0; k < 1000; k++) endless.push({ _id: 'e' + k });
    var fc4 = createFakeCloud({ colls: { drill_scores: endless } });
    var mod4 = withCloud(fc4.cloud, loadExport);
    var r4 = await mod4.main({ collection: 'drill_scores' });
    Module._load = origLoad;
    ok('④ 1000 条数据全部导出且能正常终止', function () {
      assert.strictEqual(r4.counts.drill_scores, 1000,
        '应导出 1000 条，实际 ' + r4.counts.drill_scores);
    });
  }

  /* ⑤ 安全阀：集合"永远返回满页"（取之不尽）时必须停下来。
     这不是抬杠——循环终止条件用的是「这一页不满 100 条」，
     万一云端因为某种原因每次都给满页，函数就会一直翻到超时（默认 20s 上限），
     备份拿不到，还白占资源。所以必须有个硬顶。 */
  {
    var asked = 0;
    function fullPage() {
      var rows = [];
      for (var i = 0; i < 100; i++) rows.push({ _id: 'x' + asked + '_' + i });
      return rows;
    }
    var greedy = {
      DYNAMIC_CURRENT_ENV: 'fake',
      init: function () { },
      database: function () {
        return {
          collection: function () {
            var api = {};
            api.get = function () { asked++; return Promise.resolve({ data: fullPage() }); };
            api.skip = function () { return api; };
            api.limit = function () { return api; };
            return api;
          }
        };
      },
      uploadFile: function (o) { return Promise.resolve({ fileID: 'cloud://fake/' + o.cloudPath }); },
      getTempFileURL: function (o) {
        return Promise.resolve({
          fileList: o.fileList.map(function (i) { return { tempFileURL: 'https://x/' + i }; })
        });
      }
    };

    Module._load = function (r) { if (r === 'wx-server-sdk') return greedy; return origLoad.apply(this, arguments); };
    var pg = path.join(ROOT, 'cloud', 'functions', 'exportall', 'index.js');
    delete require.cache[pg];
    var modg = require(pg);
    Module._load = origLoad;

    var rg = await modg.main({ collection: 'greedy_coll' });
    ok('⑤ 安全阀：数据取之不尽时硬顶在 30000 条并停下，不会无限翻页',
      function () {
        assert.strictEqual(rg.counts.greedy_coll, 30000,
          '应停在安全阀上限 30000，实际 ' + rg.counts.greedy_coll);
        // 30000 / 100 = 300 页 —— 到第 300 页累计满上限后停下
        assert.strictEqual(asked, 300, '应恰好翻 300 页后停住，实际 ' + asked);
      });
  }

  /* ⑥ 备份清单不能漏集合：2026-11-08 读 tts/index.js 源码补上的第 18 个。
       用行为断言（跑一次全量看 counts 的键），而不是去比对源码里的字符串列表。 */
  {
    var fc6 = createFakeCloud({ colls: { users: [{ _id: 'u1' }] } });
    var mod6 = withCloud(fc6.cloud, loadExport);
    var r6 = await mod6.main({});
    Module._load = origLoad;
    ok('⑥ 全量导出覆盖 18 个集合，含 tts_audio 发音缓存', function () {
      assert.strictEqual(Object.keys(r6.counts).length, 18,
        '应导出 18 个集合，实际 ' + Object.keys(r6.counts).length);
      assert.ok(Object.prototype.hasOwnProperty.call(r6.counts, 'tts_audio'),
        'counts 里缺 tts_audio（tts 云函数把 base64 缓存在这个集合）');
    });
  }

  console.log('\n全部通过：' + pass + ' 项 ✓');
}

main();
