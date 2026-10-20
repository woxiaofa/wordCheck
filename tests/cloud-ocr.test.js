/**
 * ocr 云函数集成测试（假 OCR.space + 假 wx-server-sdk）
 *
 *   node tests/cloud-ocr.test.js
 *
 * 这一层要钉死的是"钱"和"体面"：
 *   1) 请求参数必须是实测有效的那一组（language=chs / isTable / OCREngine=2），
 *      改错了识别率会掉，但接口照样 200，属于最难发现的那种坏；
 *   2) 图片大小要在进网络前就拦掉（callFunction 入参上限 1MB，超了整条链路报错）；
 *   3) 免费额度按次算，限频和错误码必须准确，别把"限频"报成"没认出文字"。
 */

var assert = require('assert');
var Module = require('module');
var EventEmitter = require('events');

/* ------------------------- 假 OCR.space ------------------------- */

var remote = {
  calls: [],
  body: '',
  status: 200,
  json: { ParsedResults: [{ ParsedText: 'apple 苹果\r\ntiger 老虎' }] },
  netError: false
};

var fakeHttps = {
  request: function (opts, cb) {
    remote.calls.push(opts);
    var req = new EventEmitter();
    req._body = '';
    req.write = function (b) { req._body += b; remote.body = req._body; };
    req.destroy = function (err) { if (err) req.emit('error', err); };
    req.end = function () {
      process.nextTick(function () {
        if (remote.netError) { req.emit('error', new Error('ECONNRESET')); return; }
        var res = new EventEmitter();
        res.statusCode = remote.status;
        cb(res);
        // 不管状态码都要走完 end：真实 http 里 502 也会把错误页发完再结束，
        // 少了这一步测试会静默挂住（第一次写就踩了：进程直接退出、什么都不打印）
        res.emit('data', Buffer.from(JSON.stringify(remote.json)));
        res.emit('end');
      });
    };
    return req;
  }
};

var currentOpenid = 'test-openid';
var fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'test',
  init: function () {},
  getWXContext: function () { return { OPENID: currentOpenid }; },
  database: function () { throw new Error('ocr 不该碰数据库'); }
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
var ocrFn = require('../cloud/functions/ocr/index.js');
Module._load = origLoad;

/* ---------------------------- 工具 ---------------------------- */

var pass = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { pass++; console.log('  ✓ ' + name); })
    .catch(function (e) {
      console.log('  ✗ ' + name + '\n    ' + (e && e.message));
      if (process.env.VERBOSE) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'));
      process.exitCode = 1;
    });
}

function call(image) {
  return ocrFn.main({ action: 'recognize', image: image }, {});
}

/**
 * 每个用例换一个 openid：限频是按人算的，同一个 id 连跑十几个用例会互相污染
 * （第一次写这个测试就踩了 —— 后半段全变成 RATE_LIMIT，看起来像代码坏了）
 */
var openidSeq = 0;
function reset() {
  currentOpenid = 'u' + (++openidSeq);
  remote.calls.length = 0;
  remote.body = '';
  remote.status = 200;
  remote.netError = false;
  remote.json = { ParsedResults: [{ ParsedText: 'apple 苹果\r\ntiger 老虎' }] };
}

var B64 = Buffer.alloc(400, 7).toString('base64');   // 约 400 字节的假图

var steps = [];

steps.push(function () {
  return ok('① 没有图 / 空串 / 非字符串 → BAD_IMAGE，不发请求', function () {
    reset();
    var bad = ['', null, undefined, 123];
    return Promise.all(bad.map(call)).then(function (rs) {
      rs.forEach(function (r) {
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.code, 'BAD_IMAGE');
      });
      assert.strictEqual(remote.calls.length, 0, '不该发出网络请求');
    });
  });
});

steps.push(function () {
  return ok('② 请求参数与实测一致（language=chs / isTable / OCREngine=2 / apikey）', function () {
    reset();
    return call(B64).then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(remote.calls.length, 1);
      var opts = remote.calls[0];
      assert.strictEqual(opts.host, 'api.ocr.space');
      assert.strictEqual(opts.path, '/parse/image');
      assert.strictEqual(opts.method, 'POST');
      assert.ok(opts.headers.apikey, '必须带 apikey');
      assert.strictEqual(opts.headers['Content-Type'], 'application/x-www-form-urlencoded');

      var body = decodeURIComponent(remote.body);
      assert.ok(body.indexOf('language=chs') >= 0, '中文文档要用 chs：' + body.slice(0, 120));
      assert.ok(body.indexOf('isTable=true') >= 0, '词表是表格排版，要开 isTable');
      assert.ok(body.indexOf('OCREngine=2') >= 0, '实测引擎 2 认英文更准');
      assert.ok(body.indexOf('data:image/jpeg;base64,') >= 0, '要带 data 前缀');
      assert.ok(body.indexOf(B64) >= 0, '图片必须原样带上');
    });
  });
});

steps.push(function () {
  return ok('③ data:image 前缀会被剥掉（客户端传两种写法都认）', function () {
    reset();
    return call('data:image/png;base64,' + B64).then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      var body = decodeURIComponent(remote.body);
      assert.strictEqual(body.split('base64,').length, 2, '前缀只能出现一次，不能套两层');
    });
  });
});

steps.push(function () {
  return ok('④ 正常结果：多段 ParsedText 合并成 text（客户端再按行解析）', function () {
    reset();
    remote.json = { ParsedResults: [{ ParsedText: 'apple 苹果' }, { ParsedText: 'tiger 老虎' }] };
    return call(B64).then(function (r) {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.text, 'apple 苹果\ntiger 老虎');
    });
  });
});

steps.push(function () {
  return ok('⑤ 图片太大：进网络前就拦掉 TOO_LARGE', function () {
    reset();
    var huge = Buffer.alloc(800 * 1024, 1).toString('base64');   // > 700KB 上限
    return call(huge).then(function (r) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'TOO_LARGE');
      assert.strictEqual(remote.calls.length, 0, '超限的图不该发出去浪费额度');
    });
  });
});

steps.push(function () {
  return ok('⑥ 一张白纸：EMPTY（和"服务挂了"必须分开报）', function () {
    reset();
    remote.json = { ParsedResults: [{ ParsedText: '  \r\n \r\n' }] };
    return call(B64).then(function (r) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'EMPTY');
      assert.ok(/重拍/.test(r.msg), '要给出下一步：' + r.msg);
    });
  });
});

steps.push(function () {
  return ok('⑦ 服务端报错：OCR_ERROR 带上原文（限频之类的要能看见）', function () {
    reset();
    remote.json = { IsErroredOnProcessing: true, ErrorMessage: ['E556: API rate limit exceeded'] };
    return call(B64).then(function (r) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'OCR_ERROR');
      assert.ok(r.msg.indexOf('rate limit') >= 0, '错误详情要透出来：' + r.msg);
    });
  });
});

steps.push(function () {
  return ok('⑧ 网络挂了 / 非 200：OCR_UNAVAILABLE，不把错误页当结果', function () {
    reset();
    remote.netError = true;
    return call(B64).then(function (r) {
      assert.strictEqual(r.code, 'OCR_UNAVAILABLE');
      reset();
      remote.status = 502;
      return call(B64).then(function (r2) {
        assert.strictEqual(r2.code, 'OCR_UNAVAILABLE');
        assert.strictEqual(r2.text, undefined, '不能返回半截文本');
      });
    });
  });
});

steps.push(function () {
  return ok('⑨ 限频：同一 openid 10 秒内第 3 次 RATE_LIMIT（一张图一次额度）', function () {
    reset();
    patchLoad();
    delete require.cache[require.resolve('../cloud/functions/ocr/index.js')];
    ocrFn = require('../cloud/functions/ocr/index.js');
    Module._load = origLoad;

    currentOpenid = 'ocr-heavy-user';
    var jobs = [1, 2, 3].map(function () { return call(B64); });
    return Promise.all(jobs).then(function (rs) {
      var codes = rs.map(function (r) { return r.code || 'OK'; });
      assert.strictEqual(codes[0], 'OK');
      assert.strictEqual(codes[2], 'RATE_LIMIT', '第 3 次应限频，实际：' + codes.join(','));
      currentOpenid = 'test-openid';
    });
  });
});

steps.push(function () {
  return ok('⑩ 环境变量里的 key 优先于内置测试 key', function () {
    reset();
    process.env.OCR_SPACE_KEY = 'my-own-key';
    return call(B64).then(function (r) {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(remote.calls[0].headers.apikey, 'my-own-key');
      delete process.env.OCR_SPACE_KEY;
      reset();
      return call(B64).then(function (r2) {
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(remote.calls[0].headers.apikey, 'helloworld', '没配 key 时退回官方测试 key');
      });
    });
  });
});

steps.push(function () {
  return ok('⑪ 未知 action：BAD_ACTION', function () {
    return ocrFn.main({ action: 'nope' }, {}).then(function (r) {
      assert.strictEqual(r.code, 'BAD_ACTION');
    });
  });
});

steps.reduce(function (p, s) { return p.then(s); }, Promise.resolve()).then(function () {
  console.log('\n通过：' + pass + ' 项' + (process.exitCode ? '，存在失败 ✗' : ' ✓'));
});
