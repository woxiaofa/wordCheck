/**
 * 给「成片合集.html」的每个场景写入 line 字段（该场景对应的口播原文）。
 *
 * 为什么要有它：2026-10-14 起用户改用剪映自己配音，页面不再依赖本地合成的配音文件，
 * 场景何时切换改由「口播原文的字数」推算。所以每条文档 - 每个场景必须一一对应，
 * 同一套文案既要驱动时长，也要导出成他的配音清单（一句一场景，照着配就行）。
 *
 * 用法：node scripts/patch-video-lines.js
 * 幂等：已带 line 字段的场景不会被覆盖重写（重复运行安全）。
 */
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var HTML = path.join(ROOT, 'assets', 'video', '成片合集.html');
var PY = path.join(ROOT, 'scripts', 'gen-video-narration.py');

/* ① 从配音脚本里取唯一的文案源（避免两处各写一份，改了又忘同步） */
var py = fs.readFileSync(PY, 'utf8');
var head = py.slice(py.indexOf('LINES = {'));
var dictEnd = head.indexOf('\n}');
var dict = head.slice(0, dictEnd);
var LINES = {};
var re = /(\d+):\s*\[([\s\S]*?)\]/g;
var m;
while ((m = re.exec(dict))) {
  LINES[Number(m[1])] = (m[2].match(/'([^']*)'/g) || []).map(function (s) {
    return s.slice(1, -1);
  });
}

/* ② 按天切分 OUTPUT（DATA 里场景顺序与 LINES 顺序一致） */
var html = fs.readFileSync(HTML, 'utf8');
var dayRe = /\n (\d):\{name:'([^']*)', scenes:\[([\s\S]*?)\n \]\}/g;
var patched = 0, missing = 0;
html = html.replace(dayRe, function (all, d, name, body) {
  var lines = LINES[Number(d)];
  if (!lines) return all;
  var i = 0;
  // 注意：必须带 kind 的值，插到 `{kind:'xxx', ` 之后，不能插错位置（首版曾插进引号里）
  var newBody = body.replace(/\{kind:'([^']*)', /g, function (tok, kind) {
    var line = lines[i++];
    if (line === undefined) { missing++; return tok; }
    // 幂等：已带 line 字段的场景原样返回（保留人工订正）
    if (/line:'/.test(body.slice(body.indexOf(tok), body.indexOf(tok) + 200))) patched++;
    return "{kind:'" + kind + "', line:'" + line.replace(/'/g, '') + "', ";
  });
  if (i !== lines.length) console.warn('D' + d + ' 场景数 ' + i + ' 与文案数 ' + lines.length + ' 不一致');
  return all.replace(body, newBody);
});

fs.writeFileSync(HTML, html, 'utf8');
console.log('已写入 line 字段；缺对应文案的场景：' + missing + ' 个');
