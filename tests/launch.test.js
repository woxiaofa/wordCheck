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
  // Pages 里数的是「真正会被用户用到的页」；test-card 是内测调试页，上线前要删，不计入。
  // 其余五页：首页 / 数据 / 设置 / 班级 / 报告 —— 再想往主包加页，先问能不能进 pkg-media 分包。
  var real = j.pages.filter(function (x) { return x !== 'pages/test-card/test-card'; });
  assert.ok(real.length <= 5, '主包页面过多：' + real.length + ' (' + real.join(',') + ')');
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
  ['pages/test-card/test-card', 'pages/drill/drill', 'pages/study/study']
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

/* ⑫ 拍照记词：选图是隐私接口，漏一处授权线上就是静默失败；照片也不许落云存储 */
ok('⑫ 拍照记词：选图只走 drafts.pickPhoto（先过隐私授权），照片不落云存储', function () {
  var d = read('miniprogram/utils/drafts.js');
  assert.ok(d.indexOf('privacy.ensure()') >= 0, 'drafts.js 选图前没过隐私授权');
  assert.ok(d.indexOf('wx.chooseMedia') >= 0, 'drafts.js 应统一用 chooseMedia 取图');
  assert.ok(d.indexOf('saveFile') >= 0, '照片要另存本机持久路径（临时路径会失效）');
  // 照片不落云存储：云存储要升级付费（用户明确不用），也违背"照片存手机"的承诺
  assert.ok(d.indexOf('cloud.uploadFile') < 0 && d.indexOf('wx.cloud.uploadFile') < 0,
    'drafts.js 不该把照片传到云存储');

  // 认字确实会把压缩图发给 ocr 云函数，所以文案里不能再说"不上传"——
  // 承诺与实现不一致，审核和用户都要各挨一次（2026-10-20 改）
  var imp = read('miniprogram/pkg-media/pages/import/import.wxml');
  assert.ok(imp.indexOf('不上传') < 0, 'import.wxml 还写着"不上传"，但认字会把图发给云函数');

  // 识别必须走云函数：客户端直连第三方 OCR 域名要配 request 白名单（个人主体还要备案）
  var org = read('miniprogram/pkg-media/pages/organize/organize.js');
  assert.ok(org.indexOf("name: 'ocr'") >= 0, '拍照识别要走 ocr 云函数');
  assert.ok(org.indexOf('wx.request') < 0, '客户端不该直连第三方识别域名');

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


/* ⑭ showModal 按钮文字最多 4 个字：超了整个弹窗 fail（"存，开始背"5 个字，
   真机上保存流程无声死掉 5 天，2026-10-21 才靠分步回执现形） */
ok('⑭ showModal 的 confirmText/cancelText 全部 ≤ 4 个字', function () {
  var bad = [];
  walk('miniprogram', '.js').forEach(function (f) {
    var src = read(f);
    var re = /(?:confirmText|cancelText)\s*:\s*'([^']*)'/g;
    var m;
    while ((m = re.exec(src))) {
      if (m[1].length > 4) bad.push(f + ' → "' + m[1] + '" (' + m[1].length + ' 字)');
    }
  });
  assert.strictEqual(bad.length, 0, '按钮文字超过 4 个字，showModal 会整体 fail：\n    ' + bad.join('\n    '));
});

/* ---------- ⑮~㉒ 跟读练习（2026-11-08 第 1 期，零 AI / 零后端） ----------
 * 录音是隐私接口，且页面文案对外承诺「不上传」。这两件事一旦回退，
 * 开发者工具里常常不报错，线上却是「点了没反应」或被审核判不符，必须机械拦住。 */

ok('⑮ 麦克风授权有唯一入口，且上线清单勾了「麦克风」', function () {
  var p = read('miniprogram/utils/privacy.js');
  assert.ok(p.indexOf('function ensureRecord') >= 0, '缺 ensureRecord');
  assert.ok(p.indexOf("scope: 'scope.record'") >= 0, '没向 wx.authorize 申请麦克风');
  assert.ok(p.indexOf('wx.openSetting') >= 0, '曾拒绝过授权要能引导去设置页');
  assert.ok(read('docs/上线检查清单.md').indexOf('麦克风') >= 0, '后台隐私指引没勾麦克风');
});

ok('⑯ 录音管理器收敛单点：别处不许裸调 wx.getRecorderManager', function () {
  var bad = [];
  walk('miniprogram', '.js').forEach(function (f) {
    if (f === 'miniprogram/utils/oral.js') return;
    if (read(f).indexOf('wx.getRecorderManager') >= 0) bad.push(f);
  });
  assert.strictEqual(bad.length, 0, '别处裸调了录音管理器：' + bad.join(', '));
});

ok('⑰ 跟读链路承诺「不上传」，代码里就不得有任何联网能力', function () {
  ['miniprogram/utils/oral.js', 'miniprogram/utils/oral-code.js',
    'miniprogram/utils/oral-score.js', 'miniprogram/utils/oral-flow.js',
    'miniprogram/utils/lesson-audio.js', 'miniprogram/data/oral-lesson.js',
    'miniprogram/pkg-oral/pages/oral/oral.js',
    'miniprogram/pkg-oral/pages/flow/flow.js'].forEach(function (f) {
    var s = read(f);
    ['wx.cloud', 'uploadFile', 'wx.request', 'callFunction'].forEach(function (k) {
      assert.strictEqual(s.indexOf(k), -1, f + ' 里出现了 ' + k);
    });
  });
});

ok('⑱ 跟读页在独立分包（pkg-media 已被 454 个音频占满 2MB 红线）', function () {
  var j = JSON.parse(read('miniprogram/app.json'));
  var roots = (j.subpackages || []).map(function (s) { return s.root; });
  assert.ok(roots.indexOf('pkg-oral') >= 0, '缺 pkg-oral 分包');
  assert.ok(j.pages.every(function (p) { return p.indexOf('oral') < 0; }), 'oral 不该进主包');
});

ok('⑲ onDenied 有麦克风专用文案，且说清录音不出本机', function () {
  var p = read('miniprogram/utils/privacy.js');
  assert.ok(p.indexOf('microphone:') >= 0, 'DENY_TEXT 缺 microphone 档');
  assert.ok(p.indexOf('录音只存在这台手机、不会上传') >= 0);
});

ok('⑳ 首页未成年人提示补了「录音仅存本机、不上传」', function () {
  assert.ok(read('miniprogram/pages/index/index.wxml').indexOf('录音仅存本机、不上传') >= 0);
});

ok('㉑ 跟读页四件套齐全，换肤与反馈入口都在', function () {
  ['js', 'json', 'wxml', 'wxss'].forEach(function (e) {
    var f = 'miniprogram/pkg-oral/pages/oral/oral.' + e;
    assert.ok(fs.existsSync(path.join(ROOT, f)), '缺 ' + f);
  });
  var j = read('miniprogram/pkg-oral/pages/oral/oral.js');
  var w = read('miniprogram/pkg-oral/pages/oral/oral.wxml');
  assert.ok(j.indexOf('theme.syncPage(this)') >= 0, 'onShow 没重算皮肤');
  assert.ok(/<view\s+class="page[^"]*\{\{skin\}\}"/.test(w), '根节点没挂皮肤类');
  assert.ok(w.indexOf('open-type="contact"') >= 0, '缺反馈入口');
});

/* check 链是硬编码字符串：新增测试文件不会自动被跑到，
   而 npm test 又比 check 少 9 个测试。这里直接比对目录与链，漏登记当场红。 */
ok('㉒ 全部在管的 tests/*.test.js 都登记进了 package.json 的 check 链', function () {
  // seed-then-assign.test.js 是早期试验脚本，未纳入 git、等用户确认后删除，
  // 不登记也不该擅自纳入。白名单里的文件反过来必须真的没进链，避免两边都占着。
  var IGNORE = ['seed-then-assign.test.js'];
  var files = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(function (n) { return /\.test\.js$/.test(n) && IGNORE.indexOf(n) < 0; });
  var chain = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.check;
  var missing = files.filter(function (n) { return chain.indexOf('node tests/' + n) < 0; });
  assert.strictEqual(missing.length, 0, 'check 链漏了：' + missing.join(', '));
  IGNORE.forEach(function (n) {
    assert.ok(chain.indexOf('node tests/' + n) < 0,
      n + ' 是待删的未纳管文件，不该登记进 check 链');
  });
});

/* ---------- ㉓㉔ 首页「去抽查」入口已删（2026-11-08 用户拍板） ----------
 * 主流程 goStudy 与底栏「背词」现在都进 flow（2026-11-12 起），
 * 书面阶段才由 flow 拉起 drill（认→写→巩固，2026-10-07 已合并抽查），
 * 首页再挂一个「去抽查」等于两条并行练习线。用户原话：「在我们整个流程里都没用」。
 * 只锁「用户可见的首页入口」，不动 quiz 页本体：utils/quiz.js 仍被 drill 用来出题，
 * 旧 study 流程与 tests/study-flow.test.js 也仍引用该页。
 * 不设守护的话，以后有人照旧稿加回按钮，开发者工具不会报任何错。 */
ok('㉓ 首页不再有「去抽查」按钮 / goQuiz / 跳去 quiz 页的代码', function () {
  var w = read('miniprogram/pages/index/index.wxml');
  var j = read('miniprogram/pages/index/index.js');
  assert.ok(w.indexOf('goQuiz') < 0, '首页 wxml 仍有 goQuiz 绑定');
  assert.ok(w.indexOf('去抽查') < 0, '首页仍有「去抽查」文案');
  assert.ok(j.indexOf('goQuiz') < 0, '首页 js 仍留着 goQuiz 方法');
  assert.ok(j.indexOf('/pkg-media/pages/quiz/quiz') < 0, '首页仍会跳去独立抽查页');
});

ok('㉔ 面向孩子的文案不再把「去抽查」说成另一项待办', function () {
  ['miniprogram/pages/index/index.wxml',
    'miniprogram/pages/index/index.js',
    'miniprogram/pages/stats/stats.wxml'].forEach(function (f) {
      assert.ok(read(f).indexOf('去抽查') < 0, f + ' 里仍有「去抽查」口吻');
    });
});

/* ---------- ㉕ 体验主流程（2026-11-12 用户拍板「口语贯穿式」） ----------
 * 旧实现把口语做成「一屏列出 10 个词、录一条整批放行」的前置闸门，用户实锤「现在不太行」。
 * 新链路：flow（带读→混排抽查）→ drill（现有背词）→ flow?report=1（合并报告）。
 * 这里只锁「链路没有断」：入口、分包登记、四件套、跨页交接、报告出口。
 * 各阶段的行为由 tests/oral-flow.test.js 用页面桩逐条自证。 */
ok('㉕ 「开始背单词」进体验主流程，四阶段闭环与合并报告都在链上', function () {
  var app = JSON.parse(read('miniprogram/app.json'));
  var oralPkg = (app.subpackages || []).filter(function (s) { return s.root === 'pkg-oral'; })[0];
  assert.ok(oralPkg && oralPkg.pages.indexOf('pages/flow/flow') >= 0, 'flow 页没登记进 pkg-oral');
  assert.ok(app.pages.every(function (p) { return p.indexOf('flow') < 0; }), 'flow 不该进主包');

  ['js', 'json', 'wxml', 'wxss'].forEach(function (e) {
    var f = 'miniprogram/pkg-oral/pages/flow/flow.' + e;
    assert.ok(fs.existsSync(path.join(ROOT, f)), '缺 ' + f);
  });

  var idx = read('miniprogram/pages/index/index.js');
  assert.ok(/goStudy:[\s\S]{0,500}pkg-oral\/pages\/flow\/flow/.test(idx),
    '首页「开始背单词」没进体验主流程');
  var nav = read('miniprogram/components/footer-nav/index.js');
  assert.ok(nav.indexOf("path: '/pkg-oral/pages/flow/flow'") >= 0, '底栏「背词」没跟上新流程');

  var drill = read('miniprogram/pkg-media/pages/drill/drill.js');
  assert.ok(drill.indexOf("fromFlow === '1'") >= 0, 'drill 没认出书面阶段');
  assert.ok(drill.indexOf('flow/flow?report=1') >= 0, '书面阶段结束没回合并报告');
  assert.ok(drill.indexOf('oralFlow.setDrillResult') >= 0, '书面结果没交给会话');

  var f = read('miniprogram/pkg-oral/pages/flow/flow.js');
  assert.ok(f.indexOf('oral.startHold') >= 0 && f.indexOf('scorer.score') >= 0,
    '带读没接按住跟读与评分器');
  assert.ok(f.indexOf("drill/drill?fromFlow=1") >= 0, '没有接上现有背词');
  assert.ok(f.indexOf('showReport') >= 0 && f.indexOf('onPractice') >= 0,
    '缺合并报告或只练没读流畅的入口');
  var w = read('miniprogram/pkg-oral/pages/flow/flow.wxml');
  assert.ok(w.indexOf('{{skin}}') >= 0, '根节点没挂皮肤类');
  assert.ok(w.indexOf('open-type="contact"') >= 0, '缺反馈入口');
  assert.ok(w.indexOf('honestTip') >= 0, '页面必须写明「不判断发音准不准」');
  assert.ok(w.indexOf('先不练了，回首页') >= 0 && w.indexOf("stage !== 'report'") >= 0,
    'redirectTo 进来的练习页中途必须有退出入口，否则真机没有返回箭头会困住孩子');
});

console.log('\n通过：' + pass + ' 项' + (fail ? '，失败 ' + fail + ' 项' : ' ✓'));
process.exit(fail ? 1 : 0);

