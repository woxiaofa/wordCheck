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

/* ⑨ 广告：提审版必须全关，且不许出现在孩子做题流程里 */
ok('⑨ 广告默认全关（AD_UNITS 留空），且做题页不得引用 utils/ads.js', function () {
  var s = read('miniprogram/utils/ads.js');
  assert.ok(/reward:\s*''/.test(s), 'ads.js 里 reward 广告位不是空串 —— 提审版不能带广告');
  assert.ok(/interstitial:\s*''/.test(s), 'ads.js 里 interstitial 广告位不是空串');
  assert.ok(/banner:\s*''/.test(s), 'ads.js 里 banner 广告位不是空串');
  // 广告失败必须放行：源码里 done(false) 的分支要足够多
  var guard = (s.match(/done\(false\)/g) || []).length;
  assert.ok(guard >= 4, 'ads.js 的失败放行分支只有 ' + guard + ' 处，广告不能阻断功能');
  ['pages/test-card/test-card', 'pages/drill/drill', 'pages/quiz/quiz', 'pages/study/study']
    .forEach(function (p) {
      var f = 'miniprogram/' + p + '.js';
      if (fs.existsSync(path.join(ROOT, f))) {
        assert.ok(read(f).indexOf('utils/ads') < 0, '孩子做题流程不该有广告：' + f);
      }
    });
});

/* ⑩ 调试入口：云自检/修复历史数据/原始报错，正式版必须一个都看不见 */
ok('⑩ 调试入口被 envVersion 开关卡住（正式版不渲染，云端还有教练权限门）', function () {
  var env = read('miniprogram/utils/env.js');
  assert.ok(env.indexOf('getAccountInfoSync') >= 0, 'env.js 必须用 getAccountInfoSync 判环境');
  assert.ok(env.indexOf("=== 'release'") >= 0 && env.indexOf("!== 'release'") >= 0, 'env.js 缺 release 判断');
  assert.ok(/return 'release'/.test(env), 'env.js 拿不到环境时必须按 release 处理（宁可少不能多）');

  var w = read('miniprogram/pages/class/class.wxml');
  assert.ok(w.indexOf('devTools: env.isDev()') >= 0 || read('miniprogram/pages/class/class.js').indexOf('devTools: env.isDev()') >= 0,
    'class.js 必须用 env.isDev() 生成 devTools 开关');
  // 每个 runDiagnose / runRepair 按钮上方 8 行内必须出现 devTools 的 wx:if
  var lines = w.split('\n');
  var bare = 0;
  lines.forEach(function (line, i) {
    if (line.indexOf('bindtap="runDiagnose"') < 0 && line.indexOf('bindtap="runRepair"') < 0) return;
    var gated = false;
    for (var j = Math.max(0, i - 8); j <= i; j++) {
      if (lines[j].indexOf('devTools') >= 0 && lines[j].indexOf('wx:if') >= 0) gated = true;
    }
    if (!gated) bare++;
  });
  assert.ok(bare === 0, '有 ' + bare + ' 个调试按钮没有被 devTools 开关包住（正式版会露出来）');
  // 原始报错文本同理：cloudRaw 只能在 devTools 下显示
  var rawLines = lines.filter(function (l) { return l.indexOf('{{cloudRaw') >= 0; });
  rawLines.forEach(function (l) {
    assert.ok(l.indexOf('devTools') >= 0, '原始报错 cloudRaw 必须加 devTools 条件：' + l.trim().slice(0, 60));
  });

  // 云端兜底：review 云函数的 diagnose(all)/repair 必须有教练/控制台权限门
  var rev = read('cloud/functions/review/index.js');
  assert.ok(rev.indexOf('isCoachOrConsole') >= 0, 'review 云函数缺 isCoachOrConsole 权限门');
  assert.ok(rev.indexOf("owner_id: openid") >= 0, '教练判定必须查 classes.owner_id（与 class 云函数同口径）');
  assert.ok(rev.indexOf("fail('FORBIDDEN'") >= 0, 'review 云函数缺 FORBIDDEN 拒绝分支');
});

/* ⑪ 小程序口令：必须是微信签发的真短链，且由 shared/links.js 单点提供 */
ok('⑪ #小程序:// 口令带 token（空路径版打不开），且四处文案统一走 shared/links.js', function () {
  var links = read('shared/links.js');
  assert.ok(/OPEN_LINK\s*=\s*'#小程序:\/\/[^']+\/[A-Za-z0-9_-]{6,}'/.test(links),
    'shared/links.js 的 OPEN_LINK 必须带随机码 token（手拼空路径版在微信里永远「链接无效」）');

  // 任何页面/云函数都不许再写死空路径口令（2026-10-19 前的写法）
  var files = [
    'miniprogram/pages/index/index.js',
    'miniprogram/pages/report/report.js',
    'miniprogram/pages/class/class.js',
    'cloud/functions/class/index.js'
  ];
  files.forEach(function (f) {
    var s = read(f);
    assert.ok(s.indexOf("'#小程序://功课抽查/'") < 0,
      f + ' 里还写死了空路径口令（应为 links.openLine(...)）');
  });
  // 复制入口必须来自共享模块
  assert.ok(read('miniprogram/pages/index/index.js').indexOf('utils/links') >= 0, '首页复制文案要走 utils/links');
  assert.ok(read('miniprogram/pages/report/report.js').indexOf('utils/links') >= 0, '报告页复制文案要走 utils/links');
  assert.ok(read('cloud/functions/class/index.js').indexOf("require('./links')") >= 0, '云端催一催要走 ./links');
});

/* ⑫ 拍照记词：选图是隐私接口，漏一处授权线上就是静默失败；照片也不许偷偷上传 */
ok('⑫ 拍照记词：选图只走 drafts.pickPhoto（先过隐私授权），照片只存本机不上传', function () {
  var d = read('miniprogram/utils/drafts.js');
  assert.ok(d.indexOf('privacy.ensure()') >= 0, 'drafts.js 选图前没过隐私授权');
  assert.ok(d.indexOf('wx.chooseMedia') >= 0, 'drafts.js 应统一用 chooseMedia 取图');
  assert.ok(d.indexOf('saveFile') >= 0, '照片要另存本机持久路径（临时路径会失效）');
  // 照片只存本机：出现云存储上传就说明改了承诺（页面上写的是"不上传"）
  assert.ok(d.indexOf('cloud.uploadFile') < 0 && d.indexOf('wx.cloud.uploadFile') < 0,
    'drafts.js 不该把照片传到云端（页面承诺只存本机）');

  // 别处一律不许裸调选图接口 —— 每多一处就多一处漏授权的风险
  walk('miniprogram', '.js').forEach(function (f) {
    if (f.indexOf('utils/drafts.js') >= 0) return;
    var s = read(f);
    assert.ok(s.indexOf('wx.chooseMedia') < 0, f + ' 里裸调了 wx.chooseMedia');
    assert.ok(s.indexOf('wx.chooseImage') < 0, f + ' 里裸调了 wx.chooseImage');
  });

  // 新页面必须落在分包（主包 pages 有 ≤5 的硬约束）
  var j = JSON.parse(read('miniprogram/app.json'));
  var sub = (j.subpackages || []).reduce(function (a, s) { return a.concat(s.pages || []); }, []);
  assert.ok(sub.indexOf('pages/organize/organize') >= 0, 'organize 页必须放 pkg-media 分包');
  assert.ok(j.pages.indexOf('pages/organize/organize') < 0, 'organize 页不该进主包');

  // 隐私保护指引要写明相册/摄像头，否则提审会被以"未声明收集的隐私"打回
  var doc = read('docs/上线检查清单.md');
  assert.ok(doc.indexOf('相册') >= 0, '清单里没写相册授权');
  assert.ok(doc.indexOf('摄像头') >= 0, '清单里没写摄像头授权');
});

/* ⑬ require 的相对路径必须指向真实存在的文件 */
ok('⑬ 端上所有 require 的相对路径都指向真实文件（分包多一层目录，少写一个 ../ 编译期才炸）', function () {
  // 2026-10-19 实锤：pkg-media 分包里的页面写成 require('../../utils/books')，
  // 实际应是 ../../../utils/books（分包根多一层）。npm run check 全绿看不出来，
  // 只有开发者工具编译时才 ENOENT —— 上传直接失败。这类错误必须机械拦住。
  var files = walk('miniprogram', '.js');
  var bad = [];
  files.forEach(function (f) {
    // 注释里的用法示例不算：先剥掉块注释与行注释，只看真代码
    var s = read(f)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[\s;])(\/\/[^\n]*)/g, '$1');
    var re = /require\(['"](\.[^'"]+)['"]\)/g;
    var m;
    while ((m = re.exec(s))) {
      var target = path.resolve(path.join(ROOT, path.dirname(f)), m[1]);
      if (fs.existsSync(target)) continue;
      if (fs.existsSync(target + '.js')) continue;
      if (fs.existsSync(path.join(target, 'index.js'))) continue;
      bad.push(f + ' → ' + m[1]);
    }
  });
  assert.strictEqual(bad.length, 0, 'require 指向不存在的文件：\n    ' + bad.join('\n    '));
});

console.log('\n通过：' + pass + ' 项' + (fail ? '，失败 ' + fail + ' 项' : ' ✓'));
process.exit(fail ? 1 : 0);
