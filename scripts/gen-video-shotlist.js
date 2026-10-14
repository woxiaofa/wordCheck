/**
 * 生成《D2~D7 静音版配音时长表》文档。
 *
 * 场景的分镜数据（含每条台词 line）唯一来源是 assets/video/成片合集.html，
 * 时长公式与页面内的 sceneDur() 保持一致 —— 改一处改两处，否则录制与文档会对不上。
 *
 * 用法：node scripts/gen-video-shotlist.js
 * 输出：docs/短视频-静音版配音表.md
 */
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var HTML = path.join(ROOT, 'assets', 'video', '成片合集.html');
var OUT = path.join(ROOT, 'docs', '短视频-静音版配音表.md');

var html = fs.readFileSync(HTML, 'utf8');

/* ---- 时长公式（copy of 成片合集.html::talkLen/animNeed/sceneDur） ---- */
var RATE = 4.6;
function talkLen(t) {
  t = t || '';
  var cn = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  var en = (t.replace(/[\u4e00-\u9fa5]/g, '').match(/[A-Za-z0-9]/g) || []).length * 0.6;
  var pause = (t.match(/[，。、？！：；—…]/g) || []).length * 0.22;
  return 0.55 + (cn + en + pause) / RATE;
}
function animNeed(sc) {
  if (sc.kind === 'hook') return 2.4;
  if (sc.kind === 'gold') return 2.8;
  if (sc.kind === 'end') return 3.2;
  if (sc.view === 'spell') return 1.9 + ((sc.data && sc.data.typed || '').length) * 0.34;
  if (sc.view === 'cloze') return 2.3 + ((sc.data && sc.data.ans && sc.data.ans[0]) || '').length * 0.34;
  if (sc.view === 'assign') return 3.4;
  return 2.2;
}
function sceneDur(sc) {
  return Math.round((Math.max(talkLen(sc.line), animNeed(sc)) + 0.5) * 10) / 10;
}

/* ---- 从 HTML 里取每一天的场景 ---- */
var VIEW_NAME = {
  spell: '拼写题界面', cloze: '情景填空界面', report: '今日报告',
  wrong: '错词本', assign: '布置作业', plan: '自动布置卡片', stats: '后台数据'
};
var KIND_NAME = { hook: '大字卡', gold: '金句（叠在视频上）', clip: '真人空镜', end: '结尾卡' };

var dayRe = /\n (\d):\{name:'([^']*)', scenes:\[([\s\S]*?)\n \]\}/g;
var days = {};
var m;
while ((m = dayRe.exec(html))) {
  var scenes = [];
  // 场景对象之间以 `},\n   {` / `}` 结束分隔；这里按行首的 `{kind:` 拆更稳
  var body = m[3];
  var parts = body.split(/\n\s+\{kind:'/).slice(1);
  parts.forEach(function (p) {
    scenes.push({
      kind: p.slice(0, p.indexOf("'")),
      line: (p.match(/line:'([^']*)'/) || [])[1] || '',
      cap: (p.match(/cap:'([^']*)'/) || [])[1] || '',
      view: (p.match(/view:'([^']*)'/) || [])[1] || '',
      typed: (p.match(/typed:'([^']*)'/) || [])[1] || '',
      ans: (p.match(/ans:\['([^']*)'/) || [])[1] || ''
    });
  });
  scenes.forEach(function (s) {
    if (s.view === 'spell') s.data = { typed: s.typed };
    if (s.view === 'cloze') s.data = { ans: [s.ans] };
  });
  days[Number(m[1])] = { name: m[2], scenes: scenes };
}

/* ---- 输出 ---- */
var out = [];
out.push('# 静音版配音表（D2~D7）');
out.push('');
out.push('页面：`assets/video/成片合集.html`（**默认无配音、无背景音乐**）。');
out.push('流程：**打开页面 → 选 Dn → T 看表 → F11 全屏 → 录屏 → 剪映里按这张表逐句配音**。');
out.push('');
out.push('> 每个切割点有约 ±0.3 秒容差。配完发现某句偏长，就在剪映里把该句语速调快一点，');
out.push('> 或把上一幕末尾拖长一帧；不必字字同步——画面在讲同一件事就行。');
out.push('');

Object.keys(days).map(Number).sort(function (a, b) { return a - b; }).forEach(function (d) {
  var day = days[d];
  if (d === 1) return; // D1 用户已自己剪
  var t = 0, warns = [];
  out.push('## D' + d + ' · ' + day.name);
  out.push('');
  out.push('| # | 时间轴 | 时长 | 画面 | 台词（照着配） |');
  out.push('|---|---|---|---|---|');
  day.scenes.forEach(function (sc, i) {
    var dur = sceneDur(sc);
    var start = t; t = Math.round((t + dur) * 10) / 10;
    var pic = KIND_NAME[sc.kind] || VIEW_NAME[sc.view] || sc.view || sc.kind;
    var line = (sc.line || '（无台词）').replace(/\|/g, '\\|');
    // 长静止画面会掉完播（D1 实测 2 秒跳出 56%）：静态空镜/金句超过 6 秒要提醒
    if (dur > 6 && (sc.kind === 'clip' || sc.kind === 'gold' || sc.kind === 'hook')) {
      pic += ' ⚠' + (warns.length + 1);
      warns.push('第 ' + (i + 1) + ' 幕 ' + dur.toFixed(1) + ' 秒是**静止画面**，建议换成界面演示，' +
        '或把这句拆成两句（一句配静态画面，一句配录屏）');
    }
    out.push('| ' + (i + 1) + ' | ' + start.toFixed(1) + '~' + t.toFixed(1) + 's | ' +
      dur.toFixed(1) + 's | ' + pic + ' | ' + line + ' |');
  });
  out.push('');
  out.push('总时长 **' + t.toFixed(1) + ' 秒**（不含片头封面标题）');
  if (warns.length) {
    out.push('');
    warns.forEach(function (w) { out.push('> ⚠ ' + w); });
  }
  out.push('');
});

out.push('---');
out.push('');
out.push('## 配音踩点三件事');
out.push('');
out.push('1. **一句一场景**：每句台词对应一幕画面，别合并也别拆开，时间点才对得上。');
out.push('2. **语速**：表格按 4.6 字/秒算。剪映默认音色偏慢，选「知识 / 新闻」类或调快到 1.1~1.2x。');
out.push('3. **英文词**：`Wednesday`、`library` 读得别扭就换成说法「星期三这个词」「图书馆」，');
out.push('   原文全文见 `docs/短视频口播文案.txt`。');
out.push('');
out.push('## 要重算 / 要调整');
out.push('');
out.push('- **改台词**：改 `scripts/gen-video-narration.py` 的 LINES → `node scripts/patch-video-lines.js`');
out.push('  重新写入页面 → 再跑本脚本。');
out.push('- **改节奏**：页面里的 `var RATE=4.6;`（越大越快）与本脚本同名常量需同步修改。');

fs.writeFileSync(OUT, out.join('\n'), 'utf8');
console.log('已生成 ' + OUT);
Object.keys(days).map(Number).sort(function (a, b) { return a - b; }).forEach(function (d) {
  var t = 0;
  days[d].scenes.forEach(function (sc) { t += sceneDur(sc); });
  console.log('D' + d + ' ' + days[d].name + '：' + days[d].scenes.length + ' 幕 / ' + t.toFixed(1) + ' 秒');
});
