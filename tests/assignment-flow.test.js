/**
 * 班级作业闭环：布置 → 首页入口 → 续学 → 进度回传
 *
 * 踩过的坑（2026-10-06 截图实锤）：
 *   ① "去做这份作业"只是跳到普通学习页，词单根本没带上 → 永远从头学；
 *   ② 作业完成度只认"答对过/进入复习"，选"模糊"的孩子永远是 0/10；
 *   ③ 首页没有作业入口，孩子得自己去班级页翻。
 * 这三条都是产品闭环断点，用静态断言钉死，防止改回去。
 */

var assert = require('assert');
var fs = require('fs');

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

function read(p) { return fs.readFileSync(p, 'utf8'); }

console.log('班级作业闭环测试：');

ok('① 云端：完成度口径 = 学过即算（不再要求答对/进复习）', function () {
  var src = read('cloud/functions/class/index.js');
  assert.ok(src.indexOf("完成定义 = 学过") >= 0, 'progressByStudent 应有新口径注释');
  // 旧口径必须消失：correct_count>0 || stage>0 的过滤会把"模糊"判成没学
  var region = src.slice(src.indexOf('async function progressByStudent'), src.indexOf('function genCode'));
  assert.ok(region.indexOf('correct_count > 0') === -1, '完成度不得再依赖 correct_count');
  assert.ok(region.indexOf('stage > 0') === -1, '完成度不得再依赖 stage');
});

ok('② 云端：作业下发必须带 word_ids（客户端续学的依据）', function () {
  var src = read('cloud/functions/class/index.js');
  var region = src.slice(src.indexOf('function publicAssignment'), src.indexOf('const VERSION'));
  assert.ok(region.indexOf('word_ids') >= 0, 'publicAssignment 必须下发 word_ids');
});

ok('③ 班级页：去做这份作业要带词单和作业名给学习页', function () {
  var js = read('miniprogram/pages/class/class.js');
  assert.ok(/goStudyAssignment[\s\S]*?word_ids/.test(js), '应从作业里取 word_ids');
  assert.ok(/goStudyAssignment[\s\S]*?encodeURIComponent/.test(js), 'ids/name 必须 encodeURIComponent');
});

ok('④ 学习页：作业模式按词单组队，没学过的优先（断点续学）', function () {
  var js = read('miniprogram/pages/study/study.js');
  assert.ok(/onLoad[\s\S]*?options\.ids/.test(js), 'onLoad 应解析作业词单参数');
  assert.ok(js.indexOf('assignmentQueue') >= 0, '应有作业队列组装');
  assert.ok(js.indexOf('updateAssignProgress') >= 0, '应有作业进度计算');
  // 评价后必须实时刷新进度，否则孩子学完家长还看不到
  assert.ok(/mirror\[w\.word\] = localSt;[\s\S]{0,200}updateAssignProgress/.test(js),
    '每次评价后应刷新作业进度');
});

ok('⑤ 学习页：作业进度条有 UI（名字 + done/total）', function () {
  var wxml = read('miniprogram/pages/study/study.wxml');
  assert.ok(wxml.indexOf('assignName') >= 0, '应渲染作业名');
  assert.ok(wxml.indexOf('assignDone') >= 0 && wxml.indexOf('assignTotal') >= 0, '应渲染进度数字');
});

ok('⑥ 首页：有班级作业入口，能直接跳去续学', function () {
  var js = read('miniprogram/pages/index/index.js');
  assert.ok(js.indexOf('myAssignments') >= 0, '首页应拉取班级作业');
  assert.ok(js.indexOf('goClassAssign') >= 0, '应有跳转方法');
  var wxml = read('miniprogram/pages/index/index.wxml');
  assert.ok(wxml.indexOf('clsAssign') >= 0 && wxml.indexOf('goClassAssign') >= 0,
    '首页应有作业卡和入口按钮');
});

ok('⑦ 首页：作业未完成时取代任务卡，不再两份任务并排（2026-10-06 用户反馈）', function () {
  var wxml = read('miniprogram/pages/index/index.wxml');
  // 作业未完成 → 占据 hero 位置
  assert.ok(wxml.indexOf('clsAssign && !clsAssign.finished') >= 0,
    '未完成作业应渲染在 hero 主卡位');
  // 每日任务卡必须让位：只在无作业或作业已完成时出现
  assert.ok(wxml.indexOf('!clsAssign || clsAssign.finished') >= 0,
    '任务卡应加让位条件');
  // 已完成的作业降级为普通入口
  assert.ok(wxml.indexOf('clsAssign && clsAssign.finished') >= 0,
    '已完成作业应有降级展示');
  // 旧的双重展示（无条件 clsAssign 卡）必须消失
  assert.ok(/wx:if="\{\{clsAssign\}\}"/.test(wxml) === false,
    '不得再无条件渲染作业卡（会和任务卡并排打架）');
  // 今日进度卡同步让位：两个进度条并排会被当成"数字错了"（同日用户反馈）
  var heroEnd = wxml.indexOf('cls-assign');
  assert.ok(wxml.slice(0, heroEnd).indexOf('今日进度') === -1 ||
    /今日进度[\s\S]*?wx:if="\{\{!clsAssign/.test(wxml) ||
    wxml.indexOf('<!-- 今日进度：作业进行中时隐藏') >= 0,
    '今日进度卡在作业进行中应隐藏');
});

ok('⑧ 云端：作业词单全链路用 word 文本，不用 words._id（进度恒 0 的根因）', function () {
  var src = read('cloud/functions/class/index.js');
  // 新建作业直接存文本
  assert.ok(/map\(w => w\.word\)/.test(src), '新建作业应存 word 文本');
  // 兼容旧 _id 格式：必须有归一翻译
  assert.ok(src.indexOf('async function toWordTexts') >= 0, '应有 toWordTexts 归一');
  assert.ok(/progressByStudent[\s\S]{0,400}toWordTexts/.test(src),
    'progressByStudent 查询前应归一词单');
  // 学生端自查进度的口径必须与教练端一致：学过即算
  var region = src.slice(src.indexOf('async function onMyAssignments'),
    src.indexOf('教练端：学员列表'));
  assert.ok(region.indexOf('correct_count > 0') === -1,
    'onMyAssignments 不得再用旧口径（上次漏改导致学生端恒 0/10）');
  assert.ok(region.indexOf('const learned = !!s') >= 0,
    'onMyAssignments 应学过即算');
});

ok('⑨ 同步时机：班级页/首页 onShow 先补传再拉云端数据', function () {
  var cls = read('miniprogram/pages/class/class.js');
  var idx = read('miniprogram/pages/index/index.js');
  assert.ok(/onShow[\s\S]{0,500}flushPending/.test(cls), '班级页 onShow 应先 flushPending');
  assert.ok(/onShow[\s\S]{0,500}flushPending/.test(idx), '首页 onShow 应先 flushPending');
  // 补传不能卡死页面：必须有超时兜底
  assert.ok(cls.indexOf('Promise.race') >= 0, '班级页补传应有超时兜底');
  assert.ok(idx.indexOf('Promise.race') >= 0, '首页补传应有超时兜底');
});

console.log('\n全部通过：' + pass + ' 项 ✓');
