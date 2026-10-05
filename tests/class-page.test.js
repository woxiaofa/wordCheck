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

console.log('\n全部通过：' + pass + ' 项 ✓');
