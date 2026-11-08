/**
 * 跟读练习的隐私与合规自检
 *
 * 录音即便纯本机仍是隐私接口：授权漏一处，线上就是「点了没反应」；
 * 文案里写了「不上传」就得真的没有上传代码。这里把两者的收敛点都锁死。
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function walk(dir, ext, out) {
  out = out || [];
  fs.readdirSync(path.join(ROOT, dir)).forEach(function (n) {
    var rel = dir + '/' + n;
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, ext, out);
    else if (rel.slice(-ext.length) === ext) out.push(rel);
  });
  return out;
}

console.log('\n跟读隐私与合规自检');

async function main() {
  var privacySrc = read('miniprogram/utils/privacy.js');

  ok('① privacy.js 提供 ensureRecord / paste / 三档 onDenied', function () {
    assert.ok(privacySrc.indexOf('function ensureRecord') >= 0);
    assert.ok(privacySrc.indexOf('scope.record') >= 0);
    assert.ok(privacySrc.indexOf('function paste') >= 0);
    ['clipboard', 'microphone', 'album'].forEach(function (s) {
      assert.ok(privacySrc.indexOf(s + ':') >= 0, 'DENY_TEXT 缺 ' + s);
    });
  });

  /* 行为：拒绝隐私授权时，麦克风档要给对文案，且按钮字数 ≤4（⑭ 会扫全工程） */
  {
    var modals = [];
    global.wx = { showModal: function (o) { modals.push(o); } };
    var privacy = require('../miniprogram/utils/privacy.js');
    var denied = new Error('PRIVACY_DENIED');

    ok('② 麦克风档弹窗：说清用途与「不上传」，按钮不超过 4 字', function () {
      modals.length = 0;
      assert.strictEqual(privacy.onDenied(denied, 'microphone'), true);
      assert.strictEqual(modals.length, 1);
      var m = modals[0];
      assert.ok(m.content.indexOf('麦克风') >= 0, m.content);
      assert.ok(m.content.indexOf('不会上传') >= 0, m.content);
      assert.ok(m.confirmText.length <= 4, 'confirmText 超 4 字会让整个弹窗 fail');
    });

    ok('③ 旧签名 onDenied(err) 仍按剪贴板处理（6 处既有调用不用改）', function () {
      modals.length = 0;
      assert.strictEqual(privacy.onDenied(denied), true);
      assert.ok(modals[0].content.indexOf('剪贴板') >= 0, modals[0].content);
      assert.strictEqual(privacy.onDenied(new Error('OTHER')), false);
    });

    /* ④ 是异步断言，不能塞进同步的 ok()（那样会假绿灯）：单独 await + 手动计数 */
    var name4 = '④ ensureRecord：已授权直接放行；未授权走 wx.authorize(scope.record)';
    try {
      var authorized = null;
      global.wx.getSetting = function (q) { q.success({ authSetting: {} }); };
      global.wx.authorize = function (q) { authorized = q.scope; q.success(); };
      await privacy.ensureRecord();
      assert.strictEqual(authorized, 'scope.record');
      authorized = null;
      global.wx.getSetting = function (q) { q.success({ authSetting: { 'scope.record': true } }); };
      await privacy.ensureRecord();
      assert.strictEqual(authorized, null, '已授权时不该再弹 authorize');
      console.log('  ✓ ' + name4); pass++;
    } catch (e) {
      console.log('  ✗ ' + name4 + '\n    ' + e.message); fail++;
    }
  }

  ok('⑤ 录音管理器收敛单点：只有 utils/oral.js 能拿 RecorderManager', function () {
    var bad = walk('miniprogram', '.js').filter(function (f) {
      return read(f).indexOf('wx.getRecorderManager') >= 0 && f !== 'miniprogram/utils/oral.js';
    });
    assert.strictEqual(bad.length, 0, '别处裸调了录音管理器：' + bad.join(', '));
    assert.ok(read('miniprogram/utils/oral.js').indexOf('wx.getRecorderManager') >= 0);
  });

  ok('⑥ 剪贴板收敛单点：读写都只走 utils/privacy.js', function () {
    var bad = walk('miniprogram', '.js').filter(function (f) {
      var s = read(f);
      return (s.indexOf('wx.setClipboardData') >= 0 || s.indexOf('wx.getClipboardData') >= 0) &&
        f !== 'miniprogram/utils/privacy.js';
    });
    assert.strictEqual(bad.length, 0, '别处裸调了剪贴板：' + bad.join(', '));
  });

  ok('⑦ 跟读链路零上传：页面与模块都不含任何联网能力', function () {
    ['miniprogram/utils/oral.js', 'miniprogram/utils/oral-code.js',
      'miniprogram/pkg-oral/pages/oral/oral.js'].forEach(function (f) {
      var s = read(f);
      ['wx.cloud', 'uploadFile', 'wx.request', 'callFunction'].forEach(function (k) {
        assert.strictEqual(s.indexOf(k), -1, f + ' 里出现了 ' + k);
      });
    });
  });

  ok('⑧ 上线清单写明麦克风、用途与保存期限', function () {
    var d = read('docs/上线检查清单.md');
    assert.ok(d.indexOf('麦克风') >= 0, '隐私指引没勾麦克风');
    assert.ok(d.indexOf('保存期限') >= 0, '没写保存期限');
    assert.ok(d.indexOf('不上传服务器') >= 0, '没写清不上传');
  });

  ok('⑨ 首页与跟读页都写明「录音仅存本机、不上传」', function () {
    assert.ok(read('miniprogram/pages/index/index.wxml').indexOf('录音仅存本机、不上传') >= 0);
    var w = read('miniprogram/pkg-oral/pages/oral/oral.wxml');
    assert.ok(w.indexOf('不上传') >= 0);
    assert.ok(w.indexOf('不会上传') >= 0);
  });

  ok('⑩ 新页在独立分包、四件套齐全，且主包没被塞进第 6 个页', function () {
    var j = JSON.parse(read('miniprogram/app.json'));
    var roots = (j.subpackages || []).map(function (s) { return s.root; });
    assert.ok(roots.indexOf('pkg-oral') >= 0, '缺 pkg-oral 分包');
    assert.ok(j.pages.every(function (p) { return p.indexOf('oral') < 0; }), 'oral 页不该进主包');
    ['js', 'json', 'wxml', 'wxss'].forEach(function (ext) {
      assert.ok(fs.existsSync(path.join(ROOT, 'miniprogram/pkg-oral/pages/oral/oral.' + ext)),
        '缺 oral.' + ext);
    });
  });

  ok('⑪ 新页兼容换肤：挂 {{skin}}、onShow 走 theme.syncPage(this)', function () {
    var j = read('miniprogram/pkg-oral/pages/oral/oral.js');
    var w = read('miniprogram/pkg-oral/pages/oral/oral.wxml');
    assert.ok(j.indexOf('skin: theme.cls()') >= 0);
    assert.ok(j.indexOf('theme.syncPage(this)') >= 0);
    assert.ok(/<view\s+class="page[^"]*\{\{skin\}\}"/.test(w));
  });

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 项 ✓' +
    (fail ? '，失败 ' + fail + ' 项' : ''));
  process.exit(fail ? 1 : 0);
}

main();
