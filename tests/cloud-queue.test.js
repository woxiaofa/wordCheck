/**
 * 补传队列测试
 *
 * 为什么需要它：学习记录一旦没送到云端，家长端就永远显示"已学 0 词"，
 * 而用户完全察觉不到。失败的写请求必须进本地队列、恢复后重放，
 * 且因为服务端对 clientReqId 幂等，重放不能造成重复计数。
 */

var assert = require('assert');

var storage = {};
var callImpl = null;      // 每次测试替换，模拟"云端不可用/可用"

global.wx = {
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  cloud: {
    init: function () { return true; },
    callFunction: function (o) {
      return callImpl(o);
    }
  }
};

var cloud = require('../miniprogram/utils/cloud');

var pass = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { pass++; console.log('  ✓ ' + name); })
    .catch(function (e) {
      console.log('  ✗ ' + name + '\n    ' + e.message);
      process.exitCode = 1;
    });
}

function failAll() {
  callImpl = function (o) { o.fail({ errMsg: 'cloud.callFunction:fail 网络不可用' }); };
}
function okAll(calls) {
  callImpl = function (o) {
    if (calls) calls.push(o.data);
    o.success({ result: { ok: true, data: { stage: 1 } } });
  };
}

var steps = [];

steps.push(function () {
  return ok('① 云端失败时：请求进队列，且页面仍收到 reject（不吞错）', function () {
    storage = {};
    failAll();
    return cloud.api.submitReview({ wordId: 'search', feedback: 'known', clientReqId: 'r1' })
      .then(function () { throw new Error('应当 reject'); },
        function (err) {
          assert.ok(err, '失败要传给调用方，页面才能提示/记日志');
          assert.strictEqual(cloud.pendingCount(), 1, '失败请求应入队');
        });
  });
});

steps.push(function () {
  return ok('② 云端恢复后：重放成功并出队', function () {
    var calls = [];
    okAll(calls);
    return cloud.flushPending().then(function (r) {
      assert.strictEqual(r.done, 1, '应补传成功 1 条');
      assert.strictEqual(cloud.pendingCount(), 0, '成功后应出队');
      assert.strictEqual(calls[0].wordId, 'search', '补传的应是原请求');
      assert.strictEqual(calls[0].clientReqId, 'r1', '必须带原幂等 ID，服务端才能识别为同一条');
    });
  });
});

steps.push(function () {
  return ok('③ 成功时不入队（正常路径零开销）', function () {
    storage = {};
    okAll();
    return cloud.api.submitReview({ wordId: 'circle', feedback: 'known', clientReqId: 'r2' })
      .then(function () {
        assert.strictEqual(cloud.pendingCount(), 0);
      });
  });
});

steps.push(function () {
  return ok('④ 没有幂等 ID 的请求不进队列（无法安全重放）', function () {
    storage = {};
    failAll();
    return cloud.api.submitReview({ wordId: 'x', feedback: 'known' })
      .catch(function () {
        assert.strictEqual(cloud.pendingCount(), 0, '缺 clientReqId 不能重放');
      });
  });
});

steps.push(function () {
  return ok('⑤ 连续失败 5 次后放弃该条，不再无限重试', function () {
    storage = {};
    failAll();
    return cloud.api.submitReview({ wordId: 'abandon', feedback: 'known', clientReqId: 'r3' })
      .catch(function () {
        var chain = Promise.resolve();
        for (var i = 0; i < 5; i++) chain = chain.then(function () { return cloud.flushPending(); });
        return chain;
      })
      .then(function () {
        assert.strictEqual(cloud.pendingCount(), 0, '超过重试上限应丢弃：' + cloud.pendingCount());
      });
  });
});

steps.push(function () {
  return ok('⑥ 多条积压：一次重放全部，失败的下次继续', function () {
    storage = {};
    failAll();
    return cloud.api.submitReview({ wordId: 'a', feedback: 'known', clientReqId: 'qa' })
      .catch(function () { return cloud.api.submitReview({ wordId: 'b', feedback: 'known', clientReqId: 'qb' }); })
      .catch(function () {
        assert.strictEqual(cloud.pendingCount(), 2);
        okAll();
        return cloud.flushPending();
      })
      .then(function (r) {
        assert.strictEqual(r.done, 2, '两条都应补传成功');
        assert.strictEqual(cloud.pendingCount(), 0);
      });
  });
});

steps.reduce(function (p, fn) { return p.then(fn); }, Promise.resolve())
  .then(function () { console.log('\n全部通过：' + pass + ' 项 ✓'); });
