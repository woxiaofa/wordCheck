/**
 * tts 云函数集成测试（假数据库 + 假发音源）
 *
 * 2026-10-20 推倒重来后的口径：
 *   - 发音源是**免费公开接口**，不用密钥、不用开通、不用云存储
 *   - 音频以 base64 放进返回值，客户端自己写本地文件
 *   - 云数据库只做 kv 缓存（key → base64），集合不存在自动建
 *
 * 假数据库复刻云端两个真实行为：
 *   1) 集合必须显式存在，写不存在的集合报 -502005
 *   2) doc(id).get() 对缺失文档返回 { data: null }（不抛错）
 */

var assert = require('assert');
var Module = require('module');
var EventEmitter = require('events');

/* ---------------- 假数据库 ---------------- */

function createFakeDb() {
  var colls = {};
  var missing = {};
  var api = {
    created: [],
    raw: colls,
    reset: function () {
      Object.keys(colls).forEach(function (k) { delete colls[k]; });
      Object.keys(missing).forEach(function (k) { delete missing[k]; });
      api.created.length = 0;
    },
    setMissing: function (n) { missing[n] = true; },
    createCollection: function (n) {
      api.created.push(n);
      delete missing[n];
      if (!colls[n]) colls[n] = {};
      return Promise.resolve({});
    },
    collection: function (n) {
      function rejectMissing() {
        return Promise.reject(new Error(
          'collection:fail -502005 database collection not exists. ' +
          '[ResourceNotFound] Db or Table not exist: ' + n));
      }
      return {
        doc: function (id) {
          return {
            get: function () {
              if (missing[n]) return rejectMissing();
              if (Object.prototype.hasOwnProperty.call(colls[n] || {}, id)) {
                return Promise.resolve({ data: JSON.parse(JSON.stringify(colls[n][id])) });
              }
              return Promise.resolve({ data: null });
            },
            set: function (o) {
              if (missing[n]) return rejectMissing();
              colls[n] = colls[n] || {};
              colls[n][id] = JSON.parse(JSON.stringify(o.data));
              return Promise.resolve({ stats: { updated: 1 } });
            }
          };
        }
      };
    }
  };
  return api;
}

var db = createFakeDb();

/* ---------------- 假发音源（https） ---------------- */

var youdao = {
  calls: [],
  status: 200,
  body: Buffer.from('FAKE-MP3-BYTES'),
  netError: false
};

var fakeHttps = {
  get: function (url, opts, cb) {
    youdao.calls.push(url);
    if (typeof opts === 'function') { cb = opts; }
    var req = new EventEmitter();
    req.destroy = function (err) { if (err) req.emit('error', err); };
    process.nextTick(function () {
      if (youdao.netError) { req.emit('error', new Error('ECONNRESET')); return; }
      var res = new EventEmitter();
      res.statusCode = youdao.status;
      res.resume = function () {};
      cb(res);
      if (youdao.status === 200) {
        res.emit('data', youdao.body);
        res.emit('end');
      }
    });
    return req;
  }
};

var currentOpenid = 'test-openid';
var fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'test',
  init: function () {},
  getWXContext: function () { return { OPENID: currentOpenid }; },
  database: function () { return db; }
};

var origLoad = Module._load;
function patchLoad() {
  Module._load = function (request) {
    if (request === 'wx-server-sdk') return fakeSdk;
    if (request === 'https') return fakeHttps;
    return origLoad.apply(this, arguments);
  };
}

patchLoad();
var ttsFn = require('../cloud/functions/tts/index.js');
Module._load = origLoad;

/* ---------------- 工具 ---------------- */

var pass = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { pass++; console.log('  ✓ ' + name); })
    .catch(function (e) {
      console.log('  ✗ ' + name + '\n    ' + (e && e.message));
      if (process.env.VERBOSE) console.log(String(e.stack).split('\n').slice(0, 8).join('\n'));
      process.exitCode = 1;
    });
}

function call(word) {
  return ttsFn.main({ action: 'synthesize', word: word }, {});
}

function resetAll() {
  db.reset();
  youdao.calls.length = 0;
  youdao.status = 200;
  youdao.netError = false;
}

var steps = [];

steps.push(function () {
  return ok('① 词校验：中文/空串/超长/注入串/数字开头 一律 BAD_WORD，不请求发音源', function () {
    resetAll();
    var bad = ['苹果', '', 'a'.repeat(41), 'hi<script>', '1word', null];
    return Promise.all(bad.map(call)).then(function (rs) {
      rs.forEach(function (r, i) {
        assert.strictEqual(r.ok, false, '第 ' + i + ' 个词应拒绝');
        assert.strictEqual(r.code, 'BAD_WORD');
      });
      assert.strictEqual(youdao.calls.length, 0, '不该请求发音源');
    });
  });
});

steps.push(function () {
  return ok('② 缓存键净化：短语/撇号与 shared/audio-key 同键（存了就得找得到）', function () {
    resetAll();
    db.raw.tts_audio = { 'ice-cream': { audio: 'CACHED_MP3' } };
    return call('ICE CREAM').then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.cached, true);
      assert.strictEqual(r.key, 'ice-cream');
      assert.strictEqual(r.audio, 'CACHED_MP3');
      assert.strictEqual(youdao.calls.length, 0, '命中缓存不该请求发音源');
    });
  });
});

steps.push(function () {
  return ok('③ 未命中：请求免费发音源 → 返回 base64 → 写缓存（一词一条）', function () {
    resetAll();
    return call('hello').then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.cached, false);
      assert.strictEqual(r.audio, youdao.body.toString('base64'), '应原样返回 base64');
      assert.strictEqual(youdao.calls.length, 1, '应请求一次发音源');
      assert.ok(youdao.calls[0].indexOf('audio=hello') >= 0, 'URL 应带词：' + youdao.calls[0]);
      assert.strictEqual(db.raw.tts_audio.hello.audio, r.audio, '缓存应写入 base64');
      return call('HELLO').then(function (r2) {
        assert.strictEqual(r2.cached, true, '二次（大小写不同）应命中缓存');
        assert.strictEqual(youdao.calls.length, 1, '不应重复请求发音源');
      });
    });
  });
});

steps.push(function () {
  return ok('④ 发音源不可用：TTS_ERROR，不写缓存（下次还会再试）', function () {
    resetAll();
    youdao.netError = true;
    return call('network').then(function (r) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'TTS_ERROR');
      assert.ok(!(db.raw.tts_audio || {}).network, '失败不应写缓存');
    });
  });
});

steps.push(function () {
  return ok('⑤ 发音源返回非 200：TTS_ERROR（不把错误页当音频存下来）', function () {
    resetAll();
    youdao.status = 404;
    return call('notfound').then(function (r) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'TTS_ERROR');
      assert.ok(!(db.raw.tts_audio || {}).notfound, '失败不应写缓存');
    });
  });
});

steps.push(function () {
  return ok('⑥ 集合不存在：自动建 tts_audio 后重试写入（用户零操作）', function () {
    resetAll();
    db.setMissing('tts_audio');
    return call('brandnew').then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.ok(db.created.indexOf('tts_audio') !== -1, '应自动 createCollection');
      assert.ok(db.raw.tts_audio.brandnew, '重试后应写入成功');
    });
  });
});

steps.push(function () {
  return ok('⑦ 限频：同一 openid 1 秒内第 9 次 RATE_LIMIT（防连点刷爆）', function () {
    resetAll();
    patchLoad();
    delete require.cache[require.resolve('../cloud/functions/tts/index.js')];
    ttsFn = require('../cloud/functions/tts/index.js');
    Module._load = origLoad;

    currentOpenid = 'ratelimit-user';
    db.raw.tts_audio = {};
    var words = ['wa', 'wb', 'wc', 'wd', 'we', 'wf', 'wg', 'wh', 'wi'];
    return Promise.all(words.map(call)).then(function (rs) {
      var codes = rs.map(function (r) { return r.code || 'OK'; });
      assert.strictEqual(codes[7], 'OK', '前 8 次放行');
      assert.strictEqual(codes[8], 'RATE_LIMIT', '第 9 次应限频');
      currentOpenid = 'test-openid';
    });
  });
});

steps.push(function () {
  return ok('⑧ 未知 action：BAD_ACTION', function () {
    return ttsFn.main({ action: 'nope' }, {}).then(function (r) {
      assert.strictEqual(r.code, 'BAD_ACTION');
    });
  });
});

steps.reduce(function (p, s) { return p.then(s); }, Promise.resolve()).then(function () {
  console.log('\n通过：' + pass + ' 项' + (process.exitCode ? '，存在失败 ✗' : ' ✓'));
});
