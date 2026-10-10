/**
 * 每日学习简报订阅测试（假数据库 + 真云函数代码）
 *
 * 为什么订阅这一步必须测：它有两个"看着成功其实没生效"的经典坑 ——
 *   ① 点了订阅按钮，服务端没配模板 → 如果不显式报错，用户以为订上了，晚上一条都没有；
 *   ② 定时器每天跑一次，若不限制"同一天只发一条"，一次重跑就把家长手机刷爆，
 *      结果是家长直接屏蔽，比没推送更糟。
 * 这两条都不是"功能能不能跑"，而是"信任会不会被消耗掉"，所以单独钉死。
 */

var assert = require('assert');
var fake = require('./fakedb.js');
// 与服务端同一个"今天"：review_date 写死具体日期会隔天就失败（2026-10-09 踩过）
var timeLib = require('../shared/time.js');
var TODAY = timeLib.getLocalDate(Date.now());
var db = fake.create();
var CURRENT_OPENID = '';
var CURRENT_DB = db;
var sentMessages = [];
var fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'test',
  init: function () {},
  getWXContext: function () { return { OPENID: CURRENT_OPENID }; },
  database: function () { return CURRENT_DB; },
  openapi: {
    subscribeMessage: {
      send: function (payload) {
        sentMessages.push(payload);
        return Promise.resolve({ errCode: 0 });
      }
    }
  }
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
var OUTSIDER = 'openid-x';

function seed() {
  db.reset();
  db.seed('users', [
    { _id: 'T', openid: COACH, role: 'coach', class_id: 'C1', nickname: '王老师' },
    { _id: 'A', openid: S_A, role: 'student', class_id: 'C1', nickname: '小明', last_seen_at: 1 },
    { _id: 'B', openid: S_B, role: 'student', class_id: 'C1', nickname: '小红', last_seen_at: 1 },
    { _id: 'X', openid: OUTSIDER, role: 'student', class_id: '', nickname: '路人' }
  ]);
  db.seed('classes', [{
    _id: 'C1', name: '四年二班', code: 'ABC234', owner_id: 'T',
    student_ids: ['A', 'B'], created_at: 1000
  }]);
  db.seed('review_logs', []);
  db.seed('user_word_state_v2', []);
  db.seed('brief_subs', []);
  sentMessages = [];
}

function as(openid, fn) {
  CURRENT_OPENID = openid;
  return Promise.resolve().then(fn).then(function (r) { CURRENT_OPENID = ''; return r; });
}

function call(action, payload, openid) {
  var body = Object.assign({ action: action }, payload || {});
  return as(openid || COACH, function () { return classFn.main(body); });
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

console.log('每日简报订阅测试：');

ok('① 没配模板时订阅必须明确报错（不能"看着成功其实没生效"）', function () {
  seed();
  classFn.setBriefTemplateForTest('');
  return call('subscribeBrief', { studentId: 'A' }).then(function (r) {
    assert.strictEqual(r.ok, false, '没模板却返回成功 = 骗用户');
    assert.strictEqual(r.code, 'NO_TEMPLATE');
    assert.ok(String(r.message).indexOf('模板') >= 0, '要说明原因：' + r.message);
  });
});

ok('② 没配模板时发送优雅降级（skipped，不是崩溃也不是假成功）', function () {
  seed();
  classFn.setBriefTemplateForTest('');
  return call('sendBriefs', {}).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.skipped, true);
    assert.strictEqual(r.data.sent, 0);
    assert.strictEqual(sentMessages.length, 0, '没模板就不该真的发');
  });
});

ok('③ 配好模板后可以订阅，且只有本班学员能被订阅', function () {
  seed();
  classFn.setBriefTemplateForTest('TMPL-TEST-1');
  return call('subscribeBrief', { studentId: 'A' }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.subscribed, true);
    return call('subscribeBrief', { studentId: 'X' });
  }).then(function (r) {
    assert.strictEqual(r.ok, false, '班外的人不该能订阅');
    assert.strictEqual(r.code, 'FORBIDDEN');
  });
});

ok('④ 订阅状态能被查回来（前端据此渲染开关）', function () {
  seed();
  classFn.setBriefTemplateForTest('TMPL-TEST-1');
  return call('subscribeBrief', { studentId: 'A' }).then(function () {
    return call('briefSubs', {});
  }).then(function (r) {
    assert.strictEqual(r.data.template_ready, true);
    assert.strictEqual(r.data.subs.length, 1);
    assert.strictEqual(r.data.subs[0].student_id, 'A');
  });
});

ok('⑤ ★ 同一天不重复推送（定时器重跑 / 手动再点都不会刷屏）', function () {
  seed();
  classFn.setBriefTemplateForTest('TMPL-TEST-1');
  return call('subscribeBrief', { studentId: 'A' }).then(function () {
    return call('sendBriefs', {});
  }).then(function (r) {
    assert.strictEqual(r.data.sent, 1, '应发出 1 条，实际 ' + JSON.stringify(r.data));
    assert.strictEqual(sentMessages.length, 1);
    return call('sendBriefs', {});
  }).then(function (r) {
    assert.strictEqual(r.data.sent, 0, '同一天第二次应为 0 条');
    assert.strictEqual(r.data.skippedToday, 1, '应记为"今天已发过"');
    assert.strictEqual(sentMessages.length, 1, '不该再发第二遍');
  });
});

ok('⑥ 推送内容有干货：模板数据里带"学了多少 / 掌握几题"而不是一句话空话', function () {
  seed();
  classFn.setBriefTemplateForTest('TMPL-TEST-1');
  // 小明今天学了 3 个词（TODAY 与服务端 getLocalDate 同源，不写死日期）
  db.seed('review_logs', [
    { _id: 'l1', user_id: 'A', word_id: 'w1', feedback: 'known', mode: 'learn', duration_ms: 60000,
      review_date: TODAY, created_at: 1 },
    { _id: 'l2', user_id: 'A', word_id: 'w2', feedback: 'known', mode: 'learn', duration_ms: 60000,
      review_date: TODAY, created_at: 2 },
    { _id: 'l3', user_id: 'A', word_id: 'w3', feedback: 'known', mode: 'learn', duration_ms: 60000,
      review_date: TODAY, created_at: 3 }
  ]);
  return call('subscribeBrief', { studentId: 'A' }).then(function () {
    return call('sendBriefs', {});
  }).then(function () {
    assert.strictEqual(sentMessages.length, 1);
    var payload = sentMessages[0];
    assert.strictEqual(payload.touser, COACH, '应发给订阅人（家长/老师自己）');
    assert.strictEqual(payload.templateId, 'TMPL-TEST-1');
    assert.ok(payload.page, '要带落地页，点进去能看到详情');
    var text = JSON.stringify(payload.data);
    assert.ok(text.indexOf('3 个词') >= 0, '应带上今天学了多少：' + text);
    Object.keys(payload.data).forEach(function (k) {
      assert.ok(String(payload.data[k].value).length <= 20,
        '订阅消息字段不得超 20 字（' + k + '：' + payload.data[k].value + '）');
    });
  });
});

ok('⑦ 退订：删订阅，且退订永远可用（哪怕模板已被摘掉）', function () {
  seed();
  classFn.setBriefTemplateForTest('TMPL-TEST-1');
  return call('subscribeBrief', { studentId: 'A' }).then(function () {
    classFn.setBriefTemplateForTest('');     // 模拟模板下架
    return call('subscribeBrief', { studentId: 'A', unsubscribe: true });
  }).then(function (r) {
    assert.strictEqual(r.ok, true, '模板没了也必须能退订：' + JSON.stringify(r));
    assert.strictEqual(r.data.subscribed, false);
    return call('briefSubs', {});
  }).then(function (r) {
    assert.strictEqual(r.data.subs.length, 0, '订阅记录应已删除');
  });
});

ok('⑧ 定时触发入口：没有 OPENID 也能工作（定时器不是真人）', function () {
  seed();
  classFn.setBriefTemplateForTest('TMPL-TEST-1');
  return call('subscribeBrief', { studentId: 'A' }).then(function () {
    CURRENT_OPENID = '';
    //  timer 触发器送进来的事件形态
    return classFn.main({ Type: 'Timer', triggerName: 'dailyBrief' });
  }).then(function (r) {
    assert.strictEqual(r.ok, true, '定时器调用不该因为没有 OPENID 就失败：' + JSON.stringify(r));
    assert.strictEqual(r.data.sent, 1);
  });
});

ok('⑨ 单个失败不拖垮整批（一个人授权失效，全班照收）', function () {
  seed();
  classFn.setBriefTemplateForTest('TMPL-TEST-1');
  var calls = 0;
  fakeSdk.openapi.subscribeMessage.send = function (payload) {
    calls++;
    sentMessages.push(payload);
    // 模拟第一个人的授权已失效
    if (calls === 1) return Promise.reject(new Error('43101 user refuse to accept the msg'));
    return Promise.resolve({ errCode: 0 });
  };
  return call('subscribeBrief', { studentId: 'A' }).then(function () {
    return call('subscribeBrief', { studentId: 'B' });
  }).then(function () {
    return call('sendBriefs', {});
  }).then(function (r) {
    assert.strictEqual(r.data.total, 2, '应有 2 个订阅：' + JSON.stringify(r.data));
    assert.strictEqual(r.data.sent, 1, '一个成功');
    assert.strictEqual((r.data.failures || []).length, 1, '一个失败要被记录下来而不是吞掉');
  }).finally(function () {
    // 还原，别影响后面的用例
    fakeSdk.openapi.subscribeMessage.send = function (payload) {
      sentMessages.push(payload);
      return Promise.resolve({ errCode: 0 });
    };
  });
});

ok('⑩ ★ brief_subs 集合还没建：订阅必须报错，不许"记一笔就算成功"', function () {
  // 云端写不存在的集合会抛 -502005；如果这层被 .catch 吞掉再回 ok:true，
  // 家长看到的开关是"已订阅"，但要等的简报永远不来 —— 这比直接报错糟得多。
  // 严格模式：集合没显式建过就报 -502005（复刻云端）。
  // 专治"写失败被 .catch 吞掉后照样回 ok:true"，所以要能随时开关。
  db.setStrict(true);
  db.reset();
  db.seed('users', [
    { _id: 'T', openid: COACH, role: 'coach', class_id: 'C1', nickname: '王老师' },
    { _id: 'A', openid: S_A, role: 'student', class_id: 'C1', nickname: '小明', last_seen_at: 1 }
  ]);
  db.seed('classes', [{
    _id: 'C1', name: '四年二班', code: 'ABC234', owner_id: 'T',
    student_ids: ['A'], created_at: 1000
  }]);
  classFn.setBriefTemplateForTest('TMPL-TEST-1');
  return Promise.resolve()
    .then(function () { return call('subscribeBrief', { studentId: 'A' }); })
    .then(function (r) {
      assert.strictEqual(r.ok, false, '集合不存在却返回成功 = 骗用户去等一条不会来的简报');
      assert.strictEqual(r.code, 'NO_COLLECTION');
      assert.ok(String(r.message).indexOf('brief_subs') >= 0, '要说清缺哪个集合：' + r.message);
      return call('briefSubs', {});
    })
    .then(function (r) {
      assert.strictEqual(r.ok, true, '查询本身不该挂');
      assert.strictEqual(r.data.collections_ready, false, '要把"集合没建"这件事带回去给前端提示');
    })
    .finally(function () { db.setStrict(false); seed(); });
});

steps.reduce(function (chain, fn) { return chain.then(fn); }, Promise.resolve())
  .then(function () { console.log('\n' + (process.exitCode ? '有用例失败' : '全部通过：' + steps.length + ' 项 ✓')); });
