/**
 * 口语评分器自测：契约稳定 + 三档可解释 + 门槛不卡死 + 引擎可换
 *
 * 重点防两件事：
 *   ① 本地引擎被误当成「发音评分」对外呈现（文案与 honest 标记）；
 *   ② 将来接 SOE 时页面要跟着改 —— 用 register/use 证明替换引擎不改契约。
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var sc = require('../miniprogram/utils/oral-score');

var n = 0;
function ok(name, fn) {
  try { fn(); n++; }
  catch (e) { console.error('✗ ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; }
}

/** 造一串帧：n 个有声帧，可选中间夹一段静音 */
function frames(voicedCount, silentCount, ms, rms) {
  var out = [];
  for (var i = 0; i < voicedCount; i++) out.push({ rms: rms || 0.08, ms: ms || 100 });
  for (var j = 0; j < (silentCount || 0); j++) out.push({ rms: 0, ms: ms || 100 });
  return out;
}

ok('① 期望时长随参考文本词数增长，且有上下限', function () {
  var one = sc.expectMs('apple');
  var many = sc.expectMs('we searched the whole room for the missing key');
  assert.ok(many > one * 2, '长句期望时长应明显更长');
  assert.ok(sc.expectMs('') >= 600);
  assert.ok(sc.expectMs(new Array(200).join('word ')) <= 20000);
});

ok('② measure 只累加能量，静音段不计入 voicedMs', function () {
  var m = sc.measure(frames(10, 5, 100), 1500);
  assert.strictEqual(m.voicedMs, 1000);
  assert.strictEqual(m.pauseMs, 500);
  assert.strictEqual(m.spanMs, 1500);
  assert.ok(Math.abs(m.continuity - 0.67) < 0.01);
});

ok('③ 没开口 / 声音太短 → 不合格', function () {
  var silent = sc.score({ frames: frames(0, 10, 100), durationMs: 1000, refText: 'apple', retry: 0 });
  assert.strictEqual(silent.grade, 'bad');
  assert.ok(silent.issues[0].indexOf('没听到声音') >= 0);
  var tiny = sc.score({ frames: frames(3, 0, 100), durationMs: 300, refText: 'we searched the whole room', retry: 0 });
  assert.strictEqual(tiny.grade, 'bad');
  assert.ok(tiny.issues[0].indexOf('太短') >= 0);
});

ok('④ 完整读完 → 合格；一口气读完 → 完美', function () {
  var expect = sc.expectMs('apple');
  var okFrames = frames(Math.round(expect / 100), 4, 100);
  var ordinary = sc.score({ frames: okFrames, durationMs: okFrames.length * 100, refText: 'apple', retry: 1, listened: true });
  assert.strictEqual(ordinary.grade, 'ok');
  var smooth = sc.score({ frames: frames(Math.round(expect / 100), 0, 100), durationMs: Math.round(expect / 100) * 100, refText: 'apple', retry: 0, listened: true });
  assert.strictEqual(smooth.grade, 'perfect');
});

ok('⑤ 中间长停顿会掉到不合格，且不冒充「发音不准」', function () {
  var expect = sc.expectMs('apple');
  var f = frames(Math.round(expect / 100), 0, 100)
    .concat(frames(0, 20, 100))
    .concat(frames(Math.round(expect / 100), 0, 100));
  var r = sc.score({ frames: f, durationMs: f.length * 100, refText: 'apple', retry: 0 });
  assert.strictEqual(r.grade, 'bad');
  assert.strictEqual(r.honest, true, '本地引擎必须标记 honest');
  ['发音正确', '得分', '评分', '评测'].forEach(function (k) {
    assert.ok(r.verdict.indexOf(k) < 0, '三档文案不该出现 ' + k);
  });
});

ok('⑥ 三档文案是完成度口径，不是发音准确度', function () {
  assert.strictEqual(sc.VERDICT.bad, '再读一遍');
  assert.strictEqual(sc.VERDICT.ok, '读完了');
  assert.strictEqual(sc.VERDICT.perfect, '读得很流畅');
});

ok('⑦ 门槛：合格放行；不合格重读满 3 次也放行', function () {
  var bad = { grade: 'bad' };
  assert.strictEqual(sc.shouldPass({ grade: 'ok' }, 0), true);
  assert.strictEqual(sc.shouldPass({ grade: 'perfect' }, 0), true);
  assert.strictEqual(sc.shouldPass(bad, 0), false);
  assert.strictEqual(sc.shouldPass(bad, 2), false);
  assert.strictEqual(sc.shouldPass(bad, 3), true);
  assert.strictEqual(sc.MAX_RETRY, 3);
});

ok('⑧ 留痕含重试次数、档位、engine 与 honest', function () {
  var t = sc.trace({ refText: 'apple', kind: 'word', retry: 3, forced: true, result: sc.score({ frames: [], durationMs: 0, refText: 'apple' }) });
  assert.strictEqual(t.grade, 'bad');
  assert.strictEqual(t.retry, 3);
  assert.strictEqual(t.forced, true);
  assert.strictEqual(t.engine, 'local');
  assert.strictEqual(t.honest, true);
});

ok('⑨ 可插拔：注入新引擎后 score() 契约不变，页面无需改动', function () {
  var keys = Object.keys(sc.score({ frames: frames(5), durationMs: 500, refText: 'apple' })).sort();
  var fake = function (input) {
    return {
      grade: 'perfect', scores: { accuracy: 92 }, issues: [], engine: 'soe',
      verdict: '读得很流畅', honest: false, expectMs: 0, probe: input.refText
    };
  };
  assert.strictEqual(sc.register('test-soe', fake), true);
  assert.strictEqual(sc.use('test-soe'), true);
  assert.strictEqual(sc.engineName(), 'test-soe');
  var r = sc.score({ frames: [], durationMs: 0, refText: 'apple' });
  ['grade', 'scores', 'issues', 'engine', 'verdict', 'honest'].forEach(function (k) {
    assert.ok(keys.indexOf(k) >= 0, '契约缺 ' + k);
    assert.ok(k in r, '替换后的引擎缺 ' + k);
  });
  assert.strictEqual(r.honest, false, '真评分引擎不该标 honest（它测的是准确度）');
  assert.strictEqual(sc.use('local'), true);
  assert.strictEqual(sc.engineName(), 'local');
  assert.ok(sc.use('not-exist') === false, '不存在的引擎不应切过去');
});

ok('⑩ normalizeRemote 把 SOE 结果折成同一契约（纯函数，无网络）', function () {
  var hi = sc.normalizeRemote({ PronAccuracy: 91, PronFluency: 88, PronCompletion: 95, engine: 'soe' });
  assert.strictEqual(hi.grade, 'perfect');
  assert.strictEqual(hi.honest, false);
  assert.strictEqual(hi.verdict, sc.VERDICT.perfect);
  var low = sc.normalizeRemote({ PronAccuracy: 42 });
  assert.strictEqual(low.grade, 'bad');
  assert.ok(hi.scores && low.scores, '归一化后仍要有 scores');
});

ok('⑪ 源码红线：评分器零联网能力，密钥与上传都不在端上', function () {
  var src = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/oral-score.js'), 'utf8');
  ['wx.cloud', 'uploadFile', 'wx.request', 'callFunction', 'SecretId', 'SecretKey'].forEach(function (k) {
    assert.ok(src.indexOf(k) < 0, '评分器不该出现 ' + k);
  });
  assert.ok(src.indexOf('完成度三档') >= 0, '能力边界必须写在源码里');
});

console.log('oral-score: ' + n + ' 项通过');
