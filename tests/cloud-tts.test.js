/**
 * tts 云函数集成测试（假数据库 + 假腾讯云 SDK）
 *
 * 覆盖：词校验（拒中文/注入/超长）、audio-key 缓存键一致性、缓存命中不重复合成、
 * 未配密钥明确降级（部署先于配密钥，客户端照旧）、合成→上传→写缓存闭环、
 * 集合不存在自动建（用户零操作）、同 openid 连点限频。
 *
 * 假数据库刻意复刻云端两个真实行为：
 *   1) 集合必须显式存在，写不存在的集合报 -502005
 *   2) doc(id).get() 对缺失文档返回 { data: null }（不抛错）
 */

var assert = require('assert');
var Module = require('module');

/* ---------------- 假数据库 ---------------- */

function createFakeDb() {
  var colls = {};          // name -> { id: doc }
  var missing = {};        // name -> true = 集合尚未创建
  var api = {
    created: [],           // createCollection 调用记录
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
              var data = JSON.parse(JSON.stringify(o.data));
              colls[n] = colls[n] || {};
              colls[n][id] = data;
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

/* ---------------- 假 SDK ---------------- */

var uploaded = [];           // cloud.uploadFile 调用记录
var ttsCalls = [];           // TextToVoice 调用记录
var currentOpenid = 'test-openid';
var fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'test',
  init: function () {},
  getWXContext: function () { return { OPENID: currentOpenid }; },
  database: function () { return db; },
  uploadFile: function (o) {
    uploaded.push(o);
    return Promise.resolve({ fileID: 'cloud://env/' + o.cloudPath });
  }
};

var fakeTencent = {
  tts: {
    v20190823: {
      Client: function (opts) {
        this.opts = opts;
        this.TextToVoice = function (p) {
          ttsCalls.push(p);
          return Promise.resolve({ Audio: 'QUJDRA==' }); // 任意 base64
        };
      }
    }
  }
};

var origLoad = Module._load;
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeSdk;
  if (request === 'tencentcloud-sdk-nodejs-tts') return fakeTencent;
  return origLoad.apply(this, arguments);
};
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

function withEnv(id, key, fn) {
  return function () {
    process.env.TTS_SECRET_ID = id;
    process.env.TTS_SECRET_KEY = key;
    return Promise.resolve().then(fn).then(function (r) {
      delete process.env.TTS_SECRET_ID;
      delete process.env.TTS_SECRET_KEY;
      return r;
    }, function (e) {
      delete process.env.TTS_SECRET_ID;
      delete process.env.TTS_SECRET_KEY;
      throw e;
    });
  };
}

var steps = [];

steps.push(function () {
  return ok('① 词校验：中文/空串/超长/注入串/数字开头 一律 BAD_WORD，不打引擎', function () {
    db.reset(); ttsCalls.length = 0; uploaded.length = 0;
    var bad = ['苹果', '', 'a'.repeat(41), 'hi<script>', '1word', null];
    return Promise.all(bad.map(function (w) { return call(w); })).then(function (rs) {
      rs.forEach(function (r, i) {
        assert.strictEqual(r.ok, false, '第 ' + i + ' 个词应拒绝');
        assert.strictEqual(r.code, 'BAD_WORD');
      });
      assert.strictEqual(ttsCalls.length, 0, '不该碰 TTS 引擎');
      assert.strictEqual(uploaded.length, 0, '不该上传云存储');
    });
  });
});

steps.push(function () {
  return ok('② 缓存键净化：短语/撇号与 shared/audio-key 同键（存了就得找得到）', function () {
    db.reset(); ttsCalls.length = 0;
    db.raw.tts_audio = { 'ice-cream': { fileID: 'cloud://c/ice-cream.mp3' } };
    return call('ICE CREAM').then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.cached, true);
      assert.strictEqual(r.key, 'ice-cream');
      assert.strictEqual(r.fileID, 'cloud://c/ice-cream.mp3');
    });
  });
});

steps.push(function () {
  return ok('③ 缓存命中：直接回 fileID，不调引擎、不上传', function () {
    db.reset(); ttsCalls.length = 0; uploaded.length = 0;
    db.raw.tts_audio = { hello: { fileID: 'cloud://c/hello.mp3' } };
    return call('hello').then(function (r) {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.cached, true);
      assert.strictEqual(ttsCalls.length, 0, '命中不应调 TTS');
      assert.strictEqual(uploaded.length, 0, '命中不应上传');
    });
  });
});

steps.push(function () {
  return ok('④ 未配密钥：UNAVAILABLE 明确降级，不打引擎（可先于配密钥部署）', function () {
    db.reset(); ttsCalls.length = 0;
    delete process.env.TTS_SECRET_ID;
    delete process.env.TTS_SECRET_KEY;
    return call('hello').then(function (r) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'UNAVAILABLE');
      assert.strictEqual(ttsCalls.length, 0);
    });
  });
});

steps.push(function () {
  return ok('⑤ 合成闭环：调引擎(英文参数) → 上传云存储 → 写缓存 → 二次命中', withEnv('id', 'key', function () {
    db.reset(); ttsCalls.length = 0; uploaded.length = 0;
    return call('world').then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.cached, false);
      assert.strictEqual(r.fileID, 'cloud://env/tts-cache/world.mp3');
      assert.strictEqual(ttsCalls.length, 1, '应调一次 TextToVoice');
      assert.strictEqual(ttsCalls[0].Text, 'world');
      assert.strictEqual(ttsCalls[0].VoiceType, 1001, '英文音色');
      assert.strictEqual(ttsCalls[0].Language, 'en-US');
      assert.strictEqual(uploaded.length, 1, '应上传一次');
      assert.strictEqual(uploaded[0].cloudPath, 'tts-cache/world.mp3');
      assert.strictEqual(db.raw.tts_audio.world.fileID, 'cloud://env/tts-cache/world.mp3', '缓存索引应写入');
      return call('WORLD').then(function (r2) {
        assert.strictEqual(r2.cached, true, '二次（大小写不同）应命中缓存');
        assert.strictEqual(ttsCalls.length, 1, '不应重复合成');
      });
    });
  }));
});

steps.push(function () {
  return ok('⑥ 集合不存在：自动建 tts_audio 后重试写入（用户零操作）', withEnv('id', 'key', function () {
    db.reset(); ttsCalls.length = 0;
    db.setMissing('tts_audio');
    return call('brandnew').then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.ok(db.created.indexOf('tts_audio') !== -1, '应自动 createCollection');
      assert.ok(db.raw.tts_audio.brandnew, '重试后应写入成功');
    });
  }));
});

steps.push(function () {
  return ok('⑦ 限频：同一 openid 1 秒内第 9 次 RATE_LIMIT（防连点打爆额度）', function () {
    // 全新模块实例：清零限频计数（重载期间必须重新打桩，否则 require 到真 wx-server-sdk）
    Module._load = function (request) {
      if (request === 'wx-server-sdk') return fakeSdk;
      if (request === 'tencentcloud-sdk-nodejs-tts') return fakeTencent;
      return origLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve('../cloud/functions/tts/index.js')];
    ttsFn = require('../cloud/functions/tts/index.js');
    Module._load = origLoad;
    currentOpenid = 'ratelimit-user';
    delete process.env.TTS_SECRET_ID;
    var words = ['wa', 'wb', 'wc', 'wd', 'we', 'wf', 'wg', 'wh', 'wi'];
    return Promise.all(words.map(function (w) { return call(w); })).then(function (rs) {
      var codes = rs.map(function (r) { return r.code; });
      assert.strictEqual(codes[7], 'UNAVAILABLE', '前 8 次放行（未配密钥则 UNAVAILABLE）');
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
