/**
 * 班级页静态回归测试
 *
 * 为什么要这个测试：踩过一次"页面看着正常、控制台零报错，但学生端永远看不到作业"。
 * 根因是 wxml 学生段渲染了教练端的变量（{{assignments}}），而学生态的数据写在
 * myAssignments 上——两个变量名只差一个前缀，肉眼和截图都看不出来。
 * 这类"渲染引用了永远不会被赋值的字段"只能用静态断言守住：
 *   学生段必须用自己的 myAssignments；教练段必须用 assignments。
 * 顺带守住：学生段引用到的字段，js 里必须真的写过（setData 或 data 初值）。
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/class/class.wxml'), 'utf8');
var js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/class/class.js'), 'utf8');

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

/** 取出某个 block 的内容（从标记行到 </block>） */
function block(marker) {
  var i = wxml.indexOf(marker);
  assert.ok(i >= 0, '找不到区块标记: ' + marker);
  var end = wxml.indexOf('</block>', i);
  assert.ok(end > i, '区块未闭合: ' + marker);
  return wxml.slice(i, end);
}

var STUDENT = block("my.role === 'student'");
var COACH = block("my.role === 'coach'");

console.log('班级页静态回归：');

ok('学生段渲染 myAssignments（不是教练端的 assignments）', function () {
  assert.ok(STUDENT.indexOf('{{myAssignments}}') >= 0, '学生段应渲染 myAssignments');
  // 出现独立的 {{assignments}} 引用即为回退（学生态该字段恒为空）
  assert.ok(STUDENT.indexOf('{{assignments}}') < 0,
    '学生段出现了 {{assignments}}：学生态该字段永远是空数组');
  assert.ok(STUDENT.indexOf('{{assignments.length}}') < 0,
    '学生段出现了 {{assignments.length}}');
});

ok('教练段仍渲染 assignments（带全班完成数）', function () {
  assert.ok(COACH.indexOf('{{assignments}}') >= 0, '教练段应渲染 assignments');
  assert.ok(COACH.indexOf('{{item.finished}}') >= 0, '教练段应显示全班完成数');
});

ok('学生段引用的字段在 js 里确实被赋值过', function () {
  ['myAssignments', 'myAssignError', 'emptyHint', 'cls'].forEach(function (k) {
    assert.ok(new RegExp('\\b' + k + '\\s*:').test(js), 'js 里没给 ' + k + ' 赋过值');
  });
});

ok('loadStudentData 写的是 myAssignments', function () {
  var i = js.indexOf('loadStudentData: function');
  assert.ok(i >= 0, '缺少 loadStudentData');
  var seg = js.slice(i, i + 400);
  assert.ok(seg.indexOf('myAssignments:') >= 0, 'loadStudentData 应 setData myAssignments');
});

ok('学生段有"空态 vs 加错班"的区分文案', function () {
  assert.ok(STUDENT.indexOf('TEACHER_HAS_OTHER_CLASS') >= 0,
    '学生段应能显示加错班的诊断提示');
});

ok('学员卡：状态图标 + 箭头，不再有会折行的"（点看报告）"（2026-10-10）', function () {
  assert.ok(COACH.indexOf('stu-status') >= 0, '学员卡要有状态图标行');
  assert.ok(COACH.indexOf('{{item.status.icon}}') >= 0, '状态行要渲染状态图标');
  assert.ok(COACH.indexOf('（点看报告）</text>') < 0, '旧的"（点看报告）"小字要删掉（会折行）');
  assert.ok(COACH.indexOf('stu-arrow') >= 0, '名字旁要有展开箭头（可发现性）');
  // 状态五档在 js 里都要算出来
  ['还没同步数据', '今天还没学', "staleDays >= 3", 't.forgot', '掌握'].forEach(function (k) {
    assert.ok(js.indexOf(k) >= 0, 'js 里缺状态分支标记：' + k);
  });
});

ok('学员报告走独立页：点学员卡 navigateTo /pages/report/report?sid=（2026-10-10）', function () {
  assert.ok(COACH.indexOf('bindtap="openReport"') >= 0, '学员卡应绑 openReport');
  assert.ok(js.indexOf('/pages/report/report?sid=') >= 0, 'js 应跳报告页并带上 sid');
  // 内联报告已下线：班级页不该再留报告展开区与相关状态
  assert.ok(COACH.indexOf('{{reports[') < 0, '班级页不该再渲染内联报告区');
  assert.ok(js.indexOf('toggleReport') < 0, '内联 toggleReport 应删除');
  assert.ok(js.indexOf("reports: {}") < 0, 'reports 状态应删除');

  // 页面必须真的存在且已注册（注册了却没文件 = 启动即白屏）
  var app = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
  assert.ok(app.pages.indexOf('pages/report/report') >= 0, 'app.json 要注册 pages/report/report');
  ['.js', '.json', '.wxml', '.wxss'].forEach(function (ext) {
    assert.ok(fs.existsSync(path.join(ROOT, 'miniprogram/pages/report/report' + ext)),
      '报告页缺少 report' + ext);
  });
});

ok('报告页支持外发：转发卡片带 sid + canvas 生成可打印长图', function () {
  var rjs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/report/report.js'), 'utf8');
  var rwxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/report/report.wxml'), 'utf8');
  assert.ok(/onShareAppMessage:\s*function/.test(rjs), '报告页要支持转发');
  assert.ok(rjs.indexOf("'/pages/report/report?sid='") >= 0, '转发 path 要带 sid 直达这份报告');
  assert.ok(rjs.indexOf('canvasToTempFilePath') >= 0, '要有导出长图的能力');
  assert.ok(rjs.indexOf('saveImageToPhotosAlbum') >= 0, '长图要能存相册（打印/发家长的落点）');
  assert.ok(rjs.indexOf('openSetting') >= 0, '拒绝相册权限要引导去设置，而不是静默失败');
  assert.ok(rwxml.indexOf('type="2d" id="shareCanvas"') >= 0, '报告页要有 2d 画布');
  // 分区齐全：家长/老师打印出来要能一页看全
  ['今日简报', '作业完成度', '错在哪', '最近评分'].forEach(function (sec) {
    assert.ok(rwxml.indexOf(sec) >= 0, '报告页缺少分区：' + sec);
  });
});

/**
 * chip 高度回归：以前用 <text class="wt-chip">，里面再套不同字号的 <text>（释义 20rpx / 次数 ×N），
 * 外层 text 的行盒被撑到约两倍高 —— 截图里就是那个 44px 的"大气泡"，肉眼看着像样式写错，
 * 其实是 text 的行盒行为。对策：chip 一律 view + flex 定高，字元素各占一段。
 * 这里钉死三件事：① 不许再出现 <text class="wt-chip">；② CSS 必须 flex + 固定 height；
 * ③ 全工程不许再有"text 里套 text"（嵌套一律走 view）。
 */
function rule(name, fn) { ok(name, fn); }

function allWxmlFiles(dir, out) {
  out = out || [];
  fs.readdirSync(dir).forEach(function (f) {
    var p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) allWxmlFiles(p, out);
    else if (f.slice(-5) === '.wxml') out.push(p);
  });
  return out;
}

rule('⑪ chip 是 view+flex 定高，不是 text 套 text（大气泡回归，2026-10-10）', function () {
  [['班级页', 'miniprogram/pages/class/class.wxml', 'miniprogram/pages/class/class.wxss'],
   ['报告页', 'miniprogram/pages/report/report.wxml', 'miniprogram/pages/report/report.wxss']]
  .forEach(function (t) {
    var name = t[0];
    var x = fs.readFileSync(path.join(ROOT, t[1]), 'utf8');
    var s = fs.readFileSync(path.join(ROOT, t[2]), 'utf8');
    assert.ok(!/<text[^>]*\bclass="[^"]*wt-chip/.test(x),
      name + '：chip 不能再用 <text class="wt-chip">（text 行盒会被内部字号撑高）');
    assert.ok(/<view[^>]*\bclass="[^"]*wt-chip/.test(x), name + '：chip 要是 view 容器');
    assert.ok(x.indexOf('class="wt-word"') >= 0, name + '：词要单独一段 wt-word');
    assert.ok(x.indexOf('class="wt-cnt"') >= 0, name + '：次数要单独一段 wt-cnt');

    var i = s.indexOf('.wt-chip {');
    assert.ok(i >= 0, name + '：找不到 .wt-chip 样式');
    var css = s.slice(i, s.indexOf('}', i));
    assert.ok(/display:\s*flex/.test(css), name + '：.wt-chip 必须 flex（别再靠行盒）');
    assert.ok(/height:\s*\d+rpx/.test(css), name + '：.wt-chip 必须写死高度');
    assert.ok(/line-height:\s*1\b/.test(css), name + '： chip 内 line-height 要为 1');
    assert.ok(/\.wt-chip \.wt-word[^{]*\{[^}]*nowrap|white-space: nowrap/.test(s),
      name + '：wt-word 要 nowrap，长词不许换行撑高');
  });
});

rule('⑫ 全工程零「text 里套 text」（混排字号会把行盒撑到两倍高）', function () {
  var bad = [];
  allWxmlFiles(path.join(ROOT, 'miniprogram')).forEach(function (f) {
    var src = fs.readFileSync(f, 'utf8');
    var re = /<text\b([^>]*)>((?:(?!<\/text>)[\s\S])*?)<\/text>/g;
    var m;
    while ((m = re.exec(src))) {
      if (/<text[\s>]/.test(m[2])) {
        bad.push(path.relative(ROOT, f) + ':' + src.slice(0, m.index).split('\n').length);
      }
    }
  });
  assert.deepStrictEqual(bad, [], '以下位置 text 里还套着 text，改成 view 再排：' + bad.join('、'));
});

rule('⑬ 布置作业：起点滑杆 + 续接上次 + 词数上限跟着单元走（2026-10-11）', function () {
  // 为什么：42 词的单元被写死的 max=30 卡住，后 12 个只能搜索；布置过前 10 个，
  // 想再布置 11~20 个只能删词重选 —— 都是把老师往"手动编辑词单"上逼
  assert.ok(wxml.indexOf('max="{{countMax}}"') >= 0,
    '词数滑杆上限要动态绑定 countMax（42 词的单元不该被 30 卡住）');
  assert.ok(wxml.indexOf('bindchange="pickStart"') >= 0, '要有一条起点滑杆');
  assert.ok(wxml.indexOf('bindtap="continueFromLast"') >= 0, '要有一键续接按钮');
  assert.ok(wxml.indexOf('已布置过 {{continueFrom - 1}} 个词') >= 0,
    '续接按钮要说明"已布置过几个"，老师才知道接着的是什么');
  assert.ok(wxml.indexOf('第 {{form.start}} ~ {{form.start + form.count - 1}} 个词') >= 0,
    '要显示本次取的是课本第几到第几个词');

  assert.ok(js.indexOf('pickStart:') >= 0, 'js 缺 pickStart');
  assert.ok(js.indexOf('continueFromLast:') >= 0, 'js 缺 continueFromLast');
  assert.ok(js.indexOf('computeContinueFrom:') >= 0, 'js 缺已布置覆盖数计算');
  assert.ok(js.indexOf("slice(start - 1, start - 1 + f.count)") >= 0,
    '预览取词必须从 start-1 开始切（口径与课本序一致）');
  assert.ok(js.indexOf("String(w || '').trim().toLowerCase()") >= 0,
    'word_id 比对必须 trim+lower（老数据 word_id 带前后空格，比错就是"布置过却说没布置"）');
  assert.ok(js.indexOf(">= 60") >= 0, '加词上限要放宽到 60（原 30 是拍脑袋值）');

  // 云端要下发 volume：前端按 volume+unit 找同单元旧作业
  var cjs = fs.readFileSync(path.join(ROOT, 'cloud/functions/class/index.js'), 'utf8');
  assert.ok(/volume:\s*vol,/.test(cjs), 'publicAssignment 必须下发 volume');
});

console.log('\n全部通过：' + pass + ' 项 ✓');
