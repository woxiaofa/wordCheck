/**
 * 录音状态机自检（假 RecorderManager / 假文件系统）
 *
 * 录音是全项目第一次引入「提交物」，状态一旦串台就会出现「点了没反应」
 * 或「录完找不到文件」。这里把 IDLE → RECORDING → SAVING → IDLE 每一步
 * 都跑一遍，特别覆盖 60 秒自动收尾、拒绝授权、错误不吞、回放冲突。
 */
var assert = require('assert');
var path = require('path');

var pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}
console.log('\n录音状态机自检');

var ORAL = require.resolve('../miniprogram/utils/oral.js');

function fresh(extra) {
  var o = extra || {};
  var store = {};
  var handlers = {};
  var recObj = {
    start: function (opt) { o.lastOptions = opt; },
    stop: function () {
      if (handlers.onStop) handlers.onStop({
        tempFilePath: 'tmp://take1', duration: 3000, fileSize: 12345
      });
    },
    onStop: function (cb) { handlers.onStop = cb; },
    onError: function (cb) { handlers.onError = cb; }
  };
  var playerObj = {
    src: '',
    stop: function () { o.playerStops = (o.playerStops || 0) + 1; },
    play: function () {},
    onEnded: function (cb) { handlers.ended = cb; },
    onError: function () {}
  };
  global.wx = {
    getStorageSync: function (k) { return store[k]; },
    setStorageSync: function (k, v) { store[k] = v; },
    getFileSystemManager: function () {
      return {
        unlink: function () {},
        saveFile: function (q) {
          if (q.success) q.success({ savedFilePath: 'wxfile://saved-' + q.tempFilePath });
        }
      };
    },
    getRecorderManager: function () { return recObj; },
    createInnerAudioContext: function () { return playerObj; }
  };
  if (o.getSetting) global.wx.getSetting = o.getSetting;
  if (o.authorize) global.wx.authorize = o.authorize;
  if (o.openSetting) global.wx.openSetting = o.openSetting;
  global.wx.__handlers = handlers;
  global.wx.__o = o;
  delete require.cache[ORAL];
  return require(ORAL);
}

function meta() { return { type: 'word', ref_text: 'apple', ref_word: 'apple' }; }

/** 授权是异步的：等一拍让 start() 的 .then 把录音管理器绑定好 */
function tick() { return new Promise(function (r) { setImmediate(r); }); }

async function main() {
  /* ① 起录 → 状态与录音参数 */
  {
    var o1 = {};
    var oral1 = fresh(o1);
    var p1 = oral1.start(meta());
    await tick();
    ok('① 起录后进入 RECORDING，参数是 16k / 单声道 / mp3 / 60s', function () {
      assert.strictEqual(oral1.getState(), 'RECORDING');
      assert.strictEqual(o1.lastOptions.sampleRate, 16000);
      assert.strictEqual(o1.lastOptions.format, 'mp3');
      assert.strictEqual(o1.lastOptions.duration, 60000);
    });

    /* ② 重复 start 被拒 */
    var busy = null;
    try { await oral1.start(meta()); } catch (e) { busy = e; }
    ok('② 录制中重复 start 被拒（BUSY），状态不乱', function () {
      assert.ok(busy && busy.message === 'BUSY', '应报 BUSY，实际 ' + (busy && busy.message));
      assert.strictEqual(oral1.getState(), 'RECORDING');
    });

    /* ③ 停止 → 落盘 → 回 IDLE */
    await oral1.stop();
    var r1 = await p1;
    ok('③ 停止后回到 IDLE，saveFile 的持久路径写回索引', function () {
      assert.strictEqual(oral1.getState(), 'IDLE');
      assert.ok(r1 && r1.id, '应返回落盘的记录');
      assert.strictEqual(r1.audio_path, 'wxfile://saved-tmp://take1');
      assert.strictEqual(r1.duration_ms, 3000);
      assert.strictEqual(r1.file_size, 12345);
      assert.strictEqual(r1.client_record_id, r1.id);
      assert.strictEqual(oral1.get(r1.id).ref_text, 'apple');
    });

    /* ④ 同毫秒连录两条，id 不能撞 */
    var p1b = oral1.start(meta());
    await tick();
    await oral1.stop();
    var r1b = await p1b;
    ok('④ 同一次会话连录两条，id 不重复', function () {
      assert.notStrictEqual(r1b.id, r1.id);
      assert.strictEqual(oral1.list().length, 2);
    });
  }

  /* ⑤ 60 秒自动收尾：劫持定时器同步执行，顺便断言延迟值 */
  {
    var o5 = {};
    var oral5 = fresh(o5);
    var captured = null, delay = -1;
    var realTimeout = global.setTimeout;
    global.setTimeout = function (fn, ms) { captured = fn; delay = ms; return 987654; };
    var p5;
    try { p5 = oral5.start(meta()); await tick(); } finally { global.setTimeout = realTimeout; }
    ok('⑤ 注册了 60 秒自动停止的定时器', function () {
      assert.ok(captured, '没注册自动停止');
      assert.strictEqual(delay, 60200, '应在 60 秒 + 200ms 后收尾');
    });
    captured();
    var r5 = await p5;
    ok('⑤b 到点自动 stop 并保存成功', function () {
      assert.ok(r5 && r5.id);
      assert.strictEqual(oral5.getState(), 'IDLE');
    });
  }

  /* ⑥ 曾经拒绝过授权：authorize 不会再弹，必须走 openSetting */
  {
    var opened = 0;
    var o6 = {
      getSetting: function (q) { q.success({ authSetting: { 'scope.record': false } }); },
      openSetting: function (q) { opened++; q.success({ authSetting: { 'scope.record': false } }); }
    };
    var oral6 = fresh(o6);
    var err6 = null;
    try { await oral6.start(meta()); } catch (e) { err6 = e; }
    ok('⑥ 拒绝过麦克风授权时走 openSetting，且失败明确报 MIC_DENIED', function () {
      assert.strictEqual(opened, 1, '应引导去设置页一次');
      assert.ok(err6 && err6.message === 'MIC_DENIED', '应报 MIC_DENIED');
      assert.strictEqual(oral6.getState(), 'IDLE');
    });
  }

  /* ⑦ 首次授权成功 → 正常起录 */
  {
    var o7 = {
      getSetting: function (q) { q.success({ authSetting: {} }); },
      authorize: function (q) { assert.strictEqual(q.scope, 'scope.record'); q.success(); }
    };
    var oral7 = fresh(o7);
    var p7 = oral7.start(meta());
    ok('⑦ 首次授权走 wx.authorize(scope.record) 且能起录', function () {
      assert.strictEqual(oral7.getState(), 'RECORDING');
    });
    await tick();
    await oral7.stop();
    await p7;
  }

  /* ⑧ onError 不吞错，分类透传给页面 */
  {
    var oral8 = fresh({});
    var p8 = oral8.start(meta());
    await tick();
    global.wx.__handlers.onError({ errMsg: 'record:fail auth deny' });
    var err8 = null;
    try { await p8; } catch (e) { err8 = e; }
    ok('⑧ onError 不吞错：授权失败被分类成 MIC_DENIED 并让 Promise 拒绝', function () {
      assert.ok(err8 && err8.message === 'MIC_DENIED', '实际 ' + (err8 && err8.message));
      assert.strictEqual(oral8.getState(), 'IDLE');
      assert.ok(oral8.errorText(err8).indexOf('麦克风') >= 0, '页面文案要提到麦克风');
    });
  }

  /* ⑨ 回放中起录会先停掉回放，不会两个音频叠着 */
  {
    var o9 = {};
    var oral9 = fresh(o9);
    oral9.add({
      id: 'p1', client_record_id: 'p1', type: 'word', ref_text: 'apple',
      audio_path: 'wxfile://p1', duration_ms: 1000, file_size: 1,
      created_at: Date.now(), listened: false, marked_read: false, passed: false
    });
    var played = oral9.play('p1');
    ok('⑨ 回放进入 PLAYING，并把该条记为已听', function () {
      assert.strictEqual(played, true);
      assert.strictEqual(oral9.getState(), 'PLAYING');
      assert.strictEqual(oral9.get('p1').listened, true);
    });
    var p9 = oral9.start(meta());
    ok('⑨b 回放中起录先停回放', function () {
      assert.ok(o9.playerStops >= 1, '应先 stop 播放器');
      assert.strictEqual(oral9.getState(), 'RECORDING');
    });
    await tick();
    await oral9.stop();
    await p9;
  }

  /* ⑩ 切后台 / 卸载时 cancelRecord 会收尾保存，不丢刚录的 */
  {
    var oral10 = fresh({});
    var p10 = oral10.start(meta());
    await tick();
    await oral10.cancelRecord();
    var r10 = await p10;
    ok('⑩ onHide / onUnload 的 cancelRecord 会自动保存', function () {
      assert.ok(r10 && r10.id);
      assert.strictEqual(oral10.getState(), 'IDLE');
    });
  }

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 项 ✓' +
    (fail ? '，失败 ' + fail + ' 项' : ''));
  process.exit(fail ? 1 : 0);
}

main();
