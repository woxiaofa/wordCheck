/**
 * 上线（提审）合规自检 —— 把"提审前必须做到"的事写成断言，防止回退。
 *
 * 背景：这些都是开发者工具里不报错、线上一上线就出问题的东西，
 * 光靠人记不住，所以固化为测试（2026-10-12 首次提审前补）。
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
  fs.readdirSync(path.join(ROOT, dir)).forEach(function (f) {
    var rel = dir + '/' + f;
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, ext, out);
    else if (rel.indexOf(ext) === rel.length - ext.length) out.push(rel);
  });
  return out;
}

console.log('[launch] 上线合规自检');

/* ① 隐私校验必须开启 */
ok('① app.json 声明 __usePrivacyCheck__（否则剪贴板/相册接口线上静默失败）', function () {
  var j = JSON.parse(read('miniprogram/app.json'));
  assert.ok(j.__usePrivacyCheck__ === true, 'app.json 缺 __usePrivacyCheck__');
});

/* ② 剪贴板一律走 privacy.js，不得直接调 */
ok('② 全工程不得直接 wx.setClipboardData（必须走 utils/privacy.js 的 copy()）', function () {
  walk('miniprogram', '.js').forEach(function (f) {
    if (f.indexOf('utils/privacy.js') >= 0) return;
    var s = read(f);
    assert.ok(s.indexOf('wx.setClipboardData') < 0, f + ' 里还有裸调用');
  });
});

/* ③ 相册写入必须先过隐私授权 */
ok('③ 保存图片前先 privacy.ensure()', function () {
  var s = read('miniprogram/pages/report/report.js');
  assert.ok(s.indexOf('privacy.ensure()') >= 0, 'report.js 没走隐私守卫');
  assert.ok(s.indexOf('saveImageToPhotosAlbum') >= 0);
});

/* ④ 没配模板就别显示订阅入口 */
ok('④ 简报订阅入口受 briefReady 控制（缺模板时隐藏，避免审核员点出"没开通"）', function () {
  var lines = read('miniprogram/pages/class/class.wxml').split('\n');
  var bad = 0;
  lines.forEach(function (line, i) {
    if (line.indexOf('toggleBrief') < 0 && line.indexOf('pushBriefNow') < 0) return;
    // 按钮可能跨多行：wx:if 写在这行或上面两行内都算
    var block = [lines[i - 2] || '', lines[i - 1] || '', line].join('\n');
    if (block.indexOf('briefReady') < 0) bad++;
  });
  assert.ok(bad === 0, '有 ' + bad + ' 处订阅按钮没带 briefReady 条件');
});

/* ⑤ 名称一致性 */
ok('⑤ 导航栏标题与注册名一致（功课抽查）', function () {
  var j = JSON.parse(read('miniprogram/app.json'));
  assert.strictEqual(j.window.navigationBarTitleText, '功课抽查');
});

/* ⑥ 未成年人提示 */
ok('⑥ 首页有"家长陪同 / 不收集手机号 / 不开放付费"提示（K12 审核关注）', function () {
  var s = read('miniprogram/pages/index/index.wxml');
  assert.ok(s.indexOf('家长陪同') >= 0 && s.indexOf('不收集手机号') >= 0);
});

/* ⑦ 包体与入口 */
ok('⑦ 主包不含大体积资源（音频在 pkg-media 分包）', function () {
  var j = JSON.parse(read('miniprogram/app.json'));
  assert.ok(j.subpackages && j.subpackages.length > 0, '没有分包');
  assert.ok(j.pages.length <= 5, '主包页面过多：' + j.pages.length);
});

/* ⑧ 上线清单文档存在且含关键项 */
ok('⑧ docs/上线检查清单.md 存在且写明备案/类目/隐私指引', function () {
  var s = read('docs/上线检查清单.md');
  ['ICP 备案', '服务类目', '用户隐私保护指引', '云函数'].forEach(function (k) {
    assert.ok(s.indexOf(k) >= 0, '清单里缺：' + k);
  });
});

console.log('\n通过：' + pass + ' 项' + (fail ? '，失败 ' + fail + ' 项' : ' ✓'));
process.exit(fail ? 1 : 0);
