/**
 * 按住跟读（PCM 帧采样）自测
 *
 * 关键红线：这条链路只服务即时反馈，**绝不落盘**。
 * 第 1 期的 12 条录音名额是给「可回放提交物」的，跟读评分每词一次、
 * 一轮几十次，若写进去会把历史录音全挤掉 —— 用假录音管理器实测索引不变。
 */
var assert = require('assert');

var pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}
console.log('\n按住跟读自检');

var ORAL = require.resolve('../miniprogram/utils/oral.js');

function fresh() {
  var o = {};
  var store = {};
  var handlers = {};
  var recObj = {
    start: function (opt) { o.lastOptions = opt; },
    stop: function () {
      if (handlers.onStop) handlers.onStop({ tempFilePath: 'tmp://hold', duration: 1200, fileSize: 38000 });
    },
    onStop: function (cb) { handlers.onStop = cb; },
    onError: function (cb) { handlers.onError = cb; },
    onFrameRecorded: function (cb) { handlers.onFrame = cb; }
  };
  global.wx = {
    getStorageSync: function (k) { return store[k]; },
    setStorageSync: function (k, v) { store[k] = v; },
    getFileSystemManager: function () {
      return {
        unlink: function () {},
        saveFile: function (q) { if (q.success) q.success({ savedFilePath: 'wxfile://saved' }); }
      };
    },
    getRecorderManager: function () { return recObj; },
    createInnerAudioContext: function () { return { stop: function () {}, play: function () {} }; },
    getSetting: function (q) { q.success({ authSetting: { 'scope.record': true } }); },
    authorize: function (q) { q.success(); }
  };
  global.wx.__handlers = handlers;
  global.wx.__o = o;
  delete require.cache[ORAL];
  return require(ORAL);
}

/** 造一帧 16bit PCM：amp 越大能量越高 */
function pcm(amp, samples) {
  var n = samples || 1600;
  var buf = new ArrayBuffer(n * 2);
  var dv = new DataView(buf);
  for (var i = 0; i < n; i++) dv.setInt16(i * 2, amp, true);
  return buf;
}

function tick() { return new Promise(function (r) { setImmediate(r); }); }

async function main() {
  /* ① 参数与既有 mp3 通道分离 */
  {
    var o1 = {}; var oral1 = fresh(); o1 = global.wx.__o;
    var h = oral1.HOLD_OPTIONS;
    assert.strictEqual(h.format, 'PCM');
    assert.strictEqual(h.sampleRate, 16000);
    assert.strictEqual(h.numberOfChannels, 1);
    assert.strictEqual(h.frameSize, 4);
    assert.strictEqual(h.duration, 15000);
    assert.strictEqual(oral1.RECORD_OPTIONS.format, 'mp3', '原 mp3 通道不能被改');
    ok('① 按住通道是 PCM + frameSize，原 mp3 通道不受影响', function () {});
  }

  /* ② 起录同步占住状态，帧回调累计能量，松手返回帧序列且不落盘 */
  {
    var oral2 = fresh();
    var o2 = global.wx.__o;
    var H = global.wx.__handlers;
    var before = oral2.list().length;
    var p2 = oral2.startHold({ type: 'word', ref_text: 'apple', ref_word: 'apple' });
    assert.strictEqual(oral2.getState(), 'RECORDING', '起录必须同步占住，防重复按下');
    await tick();
    assert.strictEqual(o2.lastOptions.format, 'PCM');
    H.onFrame({ frameBuffer: pcm(3000) });
    H.onFrame({ frameBuffer: pcm(0) });
    H.onFrame({ frameBuffer: pcm(2500) });
    oral2.stop();
    var out2 = await p2;
    assert.strictEqual(oral2.getState(), 'IDLE');
    assert.strictEqual(out2.frames.length, 3, '三帧都要拿到');
    assert.ok(out2.frames[0].rms > 0.05, '有声帧 RMS 应明显大于 0');
    assert.strictEqual(out2.frames[1].rms, 0, '静音帧 RMS 应为 0');
    assert.strictEqual(out2.frames[0].ms, 100, '1600 采样 @16k = 100ms');
    assert.strictEqual(out2.refText, 'apple');
    assert.strictEqual(out2.durationMs, 1200);
    assert.strictEqual(oral2.list().length, before, '按住跟读绝不写索引');
    ok('② 帧能量、时长、参考文本都回传，索引一条不写', function () {});
  }

  /* ③ 两条链路互斥：按住中不能再起普通录音 */
  {
    var oral3 = fresh();
    var p3 = oral3.startHold({ ref_text: 'book' });
    var busy = null;
    oral3.start({ ref_text: 'book' }).catch(function (e) { busy = e; });
    await tick();
    assert.ok(busy && busy.message === 'BUSY', '普通录音应被 BUSY 拒绝');
    global.wx.__handlers.onFrame({ frameBuffer: pcm(2000) });
    oral3.stop();
    await p3;
    ok('③ 按住中普通录音被 BUSY 挡住，麦克风不串台', function () {});
  }

  /* ④ 授权失败：Promise 明确拒绝，状态复位，不留半截 hold */
  {
    var oral4 = fresh();
    var H4 = global.wx.__handlers;
    var p4 = oral4.startHold({ ref_text: 'cat' });
    await tick();
    H4.onError({ errMsg: 'authorize fail: auth deny' });
    var err4 = null;
    try { await p4; } catch (e) { err4 = e; }
    assert.ok(err4 && err4.message === 'MIC_DENIED');
    assert.strictEqual(oral4.getState(), 'IDLE');
    // 失败后必须还能重新起录，否则页面会「点了没反应」
    var p4b = oral4.startHold({ ref_text: 'cat' });
    assert.strictEqual(oral4.getState(), 'RECORDING');
    await tick();
    global.wx.__handlers.onFrame({ frameBuffer: pcm(1000) });
    oral4.stop();
    var out4 = await p4b;
    assert.ok(out4.frames.length >= 1);
    ok('④ 授权失败明确拒绝且状态复位，能立刻重录', function () {});
  }

  /* ⑤ 帧回调只在按住期间生效，松手后的迟到帧不污染下一轮 */
  {
    var oral5 = fresh();
    var H5 = global.wx.__handlers;
    var p5 = oral5.startHold({ ref_text: 'dog' });
    await tick();
    H5.onFrame({ frameBuffer: pcm(2000) });
    oral5.stop();
    var a = await p5;
    H5.onFrame({ frameBuffer: pcm(2000) });   // 迟到的帧，此时不在录音中
    var p5b = oral5.startHold({ ref_text: 'sun' });
    await tick();
    H5.onFrame({ frameBuffer: pcm(2000) });
    oral5.stop();
    var b = await p5b;
    assert.strictEqual(a.frames.length, 1);
    assert.strictEqual(b.frames.length, 1, '新一轮不该带上上一轮的帧');
    ok('⑤ 每轮帧序列独立，迟到帧不串进下一轮', function () {});
  }

  /* ⑥ 源码红线：按住链路零联网、零上传、不碰学习状态 */
  {
    var fs = require('fs');
    var src = fs.readFileSync(require.resolve('../miniprogram/utils/oral.js'), 'utf8');
    ['wx.cloud', 'uploadFile', 'wx.request', 'callFunction', 'activity_log', 'checkin']
      .forEach(function (k) { assert.strictEqual(src.indexOf(k), -1, '不该出现 ' + k); });
    assert.ok(src.indexOf('HOLD_OPTIONS') >= 0);
    assert.ok(src.indexOf('startHold') >= 0);
    ok('⑥ 源码红线：零联网、零上传、不碰打卡与 SRS', function () {});
  }

  /* ⑦ 真机「按一下就闪一下」的根因回归：授权是异步的，抬手早于 recorder.start()
     时不能挂死 Promise，也不能让页面停在 holding 态。 */
  {
    var oral6 = fresh();
    var authQ = null;
    global.wx.getSetting = function (q) { authQ = q; };  // 模拟授权弹窗一直没回来
    var p6 = oral6.startHold({ ref_text: 'sun' });
    await tick();
    assert.ok(authQ, '授权查询没发起');
    assert.strictEqual(oral6.getState(), 'RECORDING', '起录要同步占住状态');
    assert.strictEqual(global.wx.__o.lastOptions, undefined, '授权没回来前不该 start');

    await oral6.stop();                                  // 孩子已经抬手
    var settled6 = false;
    p6.then(function () { settled6 = true; });
    await tick();
    assert.strictEqual(settled6, false, '没真正起录时不该提前给结果');
    assert.strictEqual(oral6.getState(), 'RECORDING', '状态不能提前放开，否则会串进下一次按住');

    authQ.success({ authSetting: { 'scope.record': true } });
    await tick(); await tick();
    assert.strictEqual(global.wx.__o.lastOptions.format, 'PCM', '授权通过后 start 要真的跑起来');
    var out6 = await p6;                                // 起录后自动补 stop，Promise 必须收敛
    assert.ok(out6 && Array.isArray(out6.frames), '没拿到帧序列');
    assert.strictEqual(oral6.getState(), 'IDLE', '收尾后状态要还回去');
    ok('⑦ 抬手早于起录：不挂死、不串台，授权通过后自动收尾', function () {});
  }

  /* ⑧ 源码守护：竞态标志与待停队列不许被顺手删掉 */
  {
    var fs6 = require('fs');
    var src6 = fs6.readFileSync(require.resolve('../miniprogram/utils/oral.js'), 'utf8');
    ['holdStarted', 'holdPendingStop', 'holdPendingStop = true', 'if (holdPendingStop)']
      .forEach(function (k) {
        assert.ok(src6.indexOf(k) >= 0, '录音层缺竞态防护 ' + k);
      });
    ok('⑧ 源码：起录完成标志与待停队列都在', function () {});
  }

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 项 ✓' +
    (fail ? '，失败 ' + fail + ' 项' : ''));
  if (fail) process.exitCode = 1;
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
