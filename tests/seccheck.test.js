/**
 * 内容安全检测（shared/seccheck.js）测试 —— 假 openapi
 *
 * 2026-11-16 提审被拒（运营规范·常见拒绝情形 3.2）：审核明确要求
 * 「创建班级」等发布场景必须接入 security.msgSecCheck，且要在任意发布场景生效。
 * 被检文本共四处：班级名、自定义词单、作业备注、昵称；头像图过 imgSecCheck。
 *
 * 这里真跑 shared/seccheck.js，用假 cloud 对象复刻四种线上行为：
 *   ① result.suggest === 'pass'   → 放行
 *   ② result.suggest !== 'pass'   → 拦（blocked:true）
 *   ③ 抛 errCode 87014（内容违规）→ 拦
 *   ④ 抛其他错误（权限未生效/网络）→ 放行（fail-open）—— 关键口径：
 *      内容接口抖一下不能把建班、布置作业全部瘫痪；
 *      但部署后必须看云函数日志确认没有 [seccheck] warn，确认权限生效。
 */

var assert = require('assert');
var seccheck = require('../shared/seccheck.js');

var pass = 0, fail = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { pass++; console.log('  ✓ ' + name); })
    .catch(function (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.message)); });
}

/** 造一个假 cloud：cases 是「每次调用返回/抛出的脚本」 */
function fakeCloud(script) {
  var calls = [];
  var cloud = {
    openapi: {
      security: {
        msgSecCheck: function (params) {
          calls.push({ api: 'text', content: params.content, scene: params.scene,
            version: params.version, openid: params.openid });
          var step = script[calls.length - 1] || { pass: true };
          if (step.throw) {
            var e = new Error(step.throw.message || 'x');
            e.errCode = step.throw.code;
            return Promise.reject(e);
          }
          return Promise.resolve({ result: { suggest: step.pass ? 'pass' : 'risky', label: 100 } });
        },
        imgSecCheck: function (params) {
          calls.push({ api: 'image', bytes: params.media.value.length });
          var step = script[calls.length - 1] || { pass: true };
          if (step.throw) {
            var e = new Error(step.throw.message || 'x');
            e.errCode = step.throw.code;
            return Promise.reject(e);
          }
          return Promise.resolve({ errcode: 0 });
        }
      }
    },
    downloadFile: function (p) {
      calls.push({ api: 'download', fileID: p.fileID });
      var step = script.download || { buf: Buffer.from('png') };
      if (step.throw) return Promise.reject(new Error(step.throw));
      return Promise.resolve({ fileContent: step.buf });
    }
  };
  cloud._calls = calls;
  return cloud;
}

(async function run() {

  await ok('① 空文本 / 纯空白：不调 API 直接放行', async function () {
    var cloud = fakeCloud([]);
    var r = await seccheck.checkText(cloud, 'o-1', ['  ', '', null], 2);
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(r.checked, 0);
    assert.strictEqual(cloud._calls.length, 0);
  });

  await ok('② 全部 pass：放行，且逐条都真的检了', async function () {
    var cloud = fakeCloud([{ pass: true }, { pass: true }]);
    var r = await seccheck.checkText(cloud, 'o-1', ['apple', 'banana'], 2);
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(r.checked, 2);
    // v2 必传字段：openid / scene / version=2（审核口径「API 在发布场景生效」）
    assert.strictEqual(cloud._calls[0].version, 2);
    assert.strictEqual(cloud._calls[0].openid, 'o-1');
    assert.strictEqual(cloud._calls[0].scene, seccheck.SCENE.COMMENT);
  });

  await ok('③ 命中违规（suggest !== pass）：拦截，且后面的不再检', async function () {
    var cloud = fakeCloud([{ pass: true }, { pass: false }]);
    var r = await seccheck.checkText(cloud, 'o-1', ['a', 'b', 'c'], 2);
    assert.strictEqual(r.blocked, true, '违规必须拦');
    assert.strictEqual(r.checked, 2, '命中即停，不再浪费调用');
    assert.strictEqual(cloud._calls.length, 2);
  });

  await ok('④ errCode 87014（v1/抛错版违规）：同样拦截', async function () {
    var cloud = fakeCloud([{ throw: { code: 87014 } }]);
    var r = await seccheck.checkText(cloud, 'o-1', '坏词', 2);
    assert.strictEqual(r.blocked, true);
  });

  await ok('⑤ API 故障（权限未生效 -604101 / 网络）：放行不瘫痪业务', async function () {
    var cloud = fakeCloud([{ throw: { code: -604101 } }, { throw: { code: 500 } }]);
    var r = await seccheck.checkText(cloud, 'o-1', ['a', 'b'], 2);
    assert.strictEqual(r.blocked, false, 'fail-open：接口挂了不能挡正常功能');
  });

  await ok('⑥ SDK 没有 openapi（未部署新代码）：放行并标 degraded', async function () {
    var cloud = {};   // 连 openapi 都没有：云端还是旧版代码
    var r = await seccheck.checkText(cloud, 'o-1', 'a', 2);
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(r.degraded, true);
  });

  await ok('⑦ 头像：cloud:// fileID 才检，本地临时路径不检', async function () {
    var cloud = fakeCloud({});
    var r1 = await seccheck.checkImage(cloud, 'o-1', 'wxfile://tmp/x.png');
    assert.strictEqual(r1.checked, false, '临时路径不进云存储，不检');
    assert.strictEqual(cloud._calls.length, 0);

    await seccheck.checkImage(cloud, 'o-1', 'cloud://env/avatar/1.png');
    assert.strictEqual(cloud._calls[0].api, 'download', '先下载再检');
  });

  await ok('⑧ 头像违规（87014）：拦截', async function () {
    var cloud = fakeCloud({ download: { buf: Buffer.from('bad-image') } });
    cloud.openapi.security.imgSecCheck = function () {
      var e = new Error('risky');
      e.errCode = 87014;
      return Promise.reject(e);
    };
    var r = await seccheck.checkImage(cloud, 'o-1', 'cloud://env/avatar/2.png');
    assert.strictEqual(r.blocked, true);
  });

  await ok('⑨ 头像超 1M：imgSecCheck 不支持，放行', async function () {
    var cloud = fakeCloud({ download: { buf: Buffer.alloc(1000001) } });
    var r = await seccheck.checkImage(cloud, 'o-1', 'cloud://env/avatar/3.png');
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(cloud._calls.filter(function (c) { return c.api === 'image'; }).length, 0);
  });

  /* ---------- 源码守护：审核要求「任意发布场景生效」，漏一处就是复审再被打回 ---------- */

  var fs = require('fs');
  var path = require('path');
  var ROOT = path.join(__dirname, '..');
  function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }

  await ok('⑩ 四个 UGC 入口都接了 checkText：班名 / 词单 / 备注 / 昵称', function () {
    var cls = read('cloud/functions/class/index.js');
    assert.ok(/require\('\.\/seccheck'\)/.test(cls), 'class 云函数没引入 seccheck');
    // onCreateClass：name 校验之后、写库之前
    var create = cls.slice(cls.indexOf('async function onCreateClass'), cls.indexOf('function onJoinClass'));
    assert.ok(/checkText/.test(create), 'onCreateClass 没过内容安全');
    assert.ok(/SEC_BLOCK/.test(create), 'onCreateClass 没给拦截错误码');
    // onAssign：词单与备注两处都要检（只检一处不足以覆盖「任意发布场景」）
    var assign = cls.slice(cls.indexOf('async function onAssign'), cls.indexOf('async function onPlanCreate'));
    assert.ok(assign.indexOf('checkText(cloud, openid, customWords') >= 0, 'onAssign 漏检自定义词单');
    assert.ok(assign.indexOf('checkText(cloud, openid, note') >= 0, 'onAssign 漏检作业备注');
    var user = read('cloud/functions/user/index.js');
    assert.ok(/require\('\.\/seccheck'\)/.test(user), 'user 云函数没引入 seccheck');
    var profile = user.slice(user.indexOf('async function onProfile'), user.indexOf('async function getUser'));
    assert.ok(/checkText/.test(profile) && /checkImage/.test(profile), 'onProfile 昵称/头像没过内容安全');
  });

  await ok('⑪ 两份 config.json 都声明了内容安全权限（不声明=云端调用直接报错）', function () {
    var cls = JSON.parse(read('cloud/functions/class/config.json'));
    assert.ok(cls.permissions.openapi.indexOf('security.msgSecCheck') >= 0,
      'class 的 openapi 权限漏了 security.msgSecCheck');
    var user = JSON.parse(read('cloud/functions/user/config.json'));
    assert.ok(user.permissions.openapi.indexOf('security.msgSecCheck') >= 0,
      'user/config.json 缺失或没声明 security.msgSecCheck');
    assert.ok(user.permissions.openapi.indexOf('security.imgSecCheck') >= 0,
      'user/config.json 缺 security.imgSecCheck（头像要检图）');
  });

  await ok('⑫ 前端 SEC_BLOCK 有可感知提示（挡了不说话=孩子以为改好了）', function () {
    var p = read('miniprogram/utils/profile.js');
    // 精确匹配到判断语句本身，防止「改个后缀」蒙混过关
    assert.ok(p.indexOf("err.code === 'SEC_BLOCK'") >= 0 && p.indexOf('showToast') >= 0,
      'profile 的云端同步没处理 SEC_BLOCK，被拦时用户毫无感知');
    // 建班 / 布置作业走 humanError 直显服务端 message，确认 catch 链路没被换掉
    var clsW = read('miniprogram/pages/class/class.js');
    assert.ok(clsW.indexOf('cloud.humanError(err)') >= 0, '班级页错误提示链路被改');
  });

  console.log('\n通过：' + pass + ' 项' + (fail ? '，失败 ' + fail + ' 项' : ' ✓'));
  process.exit(fail ? 1 : 0);

})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
