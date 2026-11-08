/**
 * 跟读录音的本机索引自检（假 wx：storage + 本机文件系统）
 *
 * 第 1 期不联网，索引就是全部数据。两件事必须守住：
 *   ① 满了要淘汰最老并删文件，不能让本机文件无限涨；
 *   ② 绝不写学习状态 / 打卡数据 —— 那是按词数算的，混进录音次数会
 *      把复习排程、掌握率、皮肤解锁判定全带偏。
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}
console.log('\n跟读本机索引自检');

var store = {};
var unlinked = [];
global.wx = {
  getStorageSync: function (k) { return store[k]; },
  setStorageSync: function (k, v) { store[k] = v; },
  getFileSystemManager: function () {
    return {
      unlink: function (o) { unlinked.push(o.filePath); },
      saveFile: function (o) {
        if (o.success) o.success({ savedFilePath: 'wxfile://saved-' + o.tempFilePath });
      }
    };
  }
};

var oral = require('../miniprogram/utils/oral.js');

function rec(id, extra) {
  var base = {
    id: id,
    client_record_id: id,
    type: 'word',
    ref_text: 'apple',
    ref_word: 'apple',
    code_id: '',
    source: 'local',
    audio_path: 'wxfile://' + id,
    duration_ms: 3000,
    file_size: 12345,
    created_at: Date.now(),
    listened: false,
    marked_read: false,
    passed: false
  };
  for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) base[k] = extra[k];
  return base;
}

ok('① 索引损坏（非数组）时返回空数组，不抛异常', function () {
  store[oral.STORAGE_KEY] = 'broken';
  assert.deepStrictEqual(oral.list(), []);
  store[oral.STORAGE_KEY] = null;
  assert.deepStrictEqual(oral.list(), []);
});

ok('② add / get 落盘正常，且预留了第 2 期的幂等键', function () {
  oral.clear();
  var r = rec('a1');
  oral.add(r);
  assert.strictEqual(oral.list().length, 1);
  assert.strictEqual(oral.get('a1').ref_text, 'apple');
  assert.strictEqual(oral.get('a1').client_record_id, 'a1');
});

ok('③ 上限 12 条：第 13 条进来要淘汰最老，并删掉它的本机文件', function () {
  oral.clear();
  unlinked.length = 0;
  for (var i = 0; i < 13; i++) oral.add(rec('r' + i, { created_at: 1000 + i }));
  assert.strictEqual(oral.list().length, oral.MAX_RECORDS, '应稳定在 12 条');
  assert.strictEqual(oral.get('r0'), null, '最老的 r0 应被淘汰');
  assert.ok(unlinked.indexOf('wxfile://r0') >= 0, '淘汰时要删本机文件');
  assert.strictEqual(oral.get('r12').created_at, 1012, '最新的应排在最前');
});

ok('④ update / remove / clear 都生效，remove 也删文件', function () {
  oral.update('r12', { listened: true, marked_read: true, passed: true });
  assert.strictEqual(oral.get('r12').listened, true);
  assert.strictEqual(oral.get('r12').passed, true);
  unlinked.length = 0;
  oral.remove('r12');
  assert.strictEqual(oral.get('r12'), null);
  assert.ok(unlinked.indexOf('wxfile://r12') >= 0, 'remove 要删本机文件');
  oral.clear();
  assert.strictEqual(oral.list().length, 0);
  assert.strictEqual(oral.get('r1'), null);
});

ok('⑤ 汇总文字：条数 / 天数 / 回放 / 已读 / 家长确认 / 材料占比都算对', function () {
  oral.clear();
  var t = Date.now();
  oral.add(rec('s1', { created_at: t, listened: true, marked_read: true }));
  oral.add(rec('s2', {
    type: 'custom', ref_text: 'hello world', created_at: t - 86400000, passed: true
  }));
  var s = oral.summary();
  assert.ok(s.indexOf('录音：2 条') >= 0, s);
  assert.ok(s.indexOf('覆盖 2 天') >= 0, s);
  assert.ok(s.indexOf('回放自听：1 条') >= 0, s);
  assert.ok(s.indexOf('标记已读：1 条') >= 0, s);
  assert.ok(s.indexOf('家长确认：1 条') >= 0, s);
  assert.ok(s.indexOf('单词 1 条 / 自定义 1 条') >= 0, s);
  assert.ok(s.indexOf('不上传') >= 0, '汇总要重申不上传');
  assert.ok(s.indexOf('打分') < 0 && s.indexOf('评分') < 0, '第 1 期汇总不能出现打分口径');
});

ok('⑥ 空索引的汇总也是人话，不抛异常', function () {
  oral.clear();
  assert.ok(oral.summary().indexOf('还没有') >= 0);
});

ok('⑦ 拆词：命中本地清单的词可点听，未命中的置灰', function () {
  var manifest = require('../miniprogram/data/audio-manifest.js');
  var known = Object.keys(manifest).filter(function (k) { return /^[A-Za-z]+$/.test(k); })[0];
  assert.ok(known, '本地音频清单应有词');
  var c = oral.chips(known + ' zzzzznotaword');
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[0].hasAudio, true, known + ' 应命中清单');
  assert.strictEqual(c[1].hasAudio, false);
  assert.ok(oral.hasLocal(known), 'hasLocal 应与 chips 口径一致');
  assert.strictEqual(oral.hasLocal('zzzzznotaword'), false);
});

ok('⑧ 源码红线：不碰打卡/学习状态，也不含任何联网能力', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'utils', 'oral.js'), 'utf8');
  ['activity_log', 'checkin', 'uploadFile', 'wx.cloud', 'wx.request', 'callFunction']
    .forEach(function (k) {
      assert.strictEqual(src.indexOf(k), -1, 'oral.js 不该出现 ' + k);
    });
});

ok('⑨ 录音参数与将来口语评测的 16k 输入对齐，且上限 60 秒', function () {
  var o = oral.RECORD_OPTIONS;
  assert.strictEqual(o.sampleRate, 16000);
  assert.strictEqual(o.numberOfChannels, 1);
  assert.strictEqual(o.format, 'mp3');
  assert.strictEqual(o.duration, 60000);
  assert.strictEqual(oral.MAX_MS, 60000);
});

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 项 ✓' +
  (fail ? '，失败 ' + fail + ' 项' : ''));
process.exit(fail ? 1 : 0);
