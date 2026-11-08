/**
 * 跟读练习：本机录音索引 + 录音状态机（第 1 期 · 零 AI、零后端）
 *
 * 这一版要验证的只有一件事：孩子会不会真的开口录、家长愿不愿在本机听。
 * 所以能力边界写得死死的：
 *   - 录音只写进这台手机的持久目录，索引只进本机缓存，全程不联网；
 *   - 最多留 12 条，超了淘汰最老并删文件；可一键清空，卸载即清理；
 *   - 不写任何学习状态、打卡数据。那是按词数算的，混进录音次数会把
 *     复习排程、掌握率、皮肤解锁判定全带偏 —— 两套数据必须各走各的。
 *
 * 范式照抄 utils/drafts.js：本机文件 + 索引 + 上限淘汰 + 隐私接口收敛单点。
 * 录音采集收敛在本文件，别处不许直接拿录音管理器（漏一处授权就静默失败）。
 *
 * 状态机：IDLE → RECORDING → SAVING → IDLE；回放是并行的 PLAYING。
 * 最长 60 秒到点自动收尾，页面切后台/卸载也要 stop 并保存，不能丢。
 */
var privacy = require('./privacy');
var code = require('./oral-code');
var audioKey = require('./audio-key');
var tts = require('./tts');

var STORAGE_KEY = 'oral_records';
var MAX_RECORDS = 12;          // 与 drafts.js 的草稿上限一致
var MAX_MS = 60000;            // 单条最长 60 秒
var RECORD_OPTIONS = {
  duration: MAX_MS,
  sampleRate: 16000,           // 与主流口语评测的 16k 输入对齐，将来免重采样
  numberOfChannels: 1,
  encodeBitRate: 48000,
  format: 'mp3'
};

var manifest = {};
try { manifest = require('../data/audio-manifest.js'); } catch (e) { manifest = {}; }
var byLower = {};
(function () {
  for (var k in manifest) {
    if (Object.prototype.hasOwnProperty.call(manifest, k)) byLower[k.toLowerCase()] = k;
  }
})();

/* ----------------------------- 索引 ----------------------------- */

function list() {
  try {
    var arr = wx.getStorageSync(STORAGE_KEY);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function save(arr) {
  try { wx.setStorageSync(STORAGE_KEY, arr); } catch (e) { /* 测试环境忽略 */ }
}

function get(id) {
  var arr = list();
  for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
  return null;
}

/** 时间戳 + 递增序号：同一次会话、同一毫秒内连录两条也不撞号 */
var seq = 0;
function newId() {
  seq += 1;
  return 'o' + Date.now() + '_' + seq;
}

function byNewest(a, b) { return (b.created_at || 0) - (a.created_at || 0); }

function unlink(p) {
  try {
    if (!p || p.indexOf('http') === 0 || p.indexOf('cloud:') === 0) return;
    var fs = wx.getFileSystemManager && wx.getFileSystemManager();
    if (!fs || !fs.unlink) return;
    fs.unlink({ filePath: p, fail: function () {} });
  } catch (e) { /* 删不掉就算了，不能因为清不掉一个文件把用户卡住 */ }
}

/**
 * 落一条记录。满了先淘汰最老的（连同本机文件一起删）。
 * 字段里 client_record_id 是给第 2 期预留的幂等键，现在就等于 id。
 */
function add(rec) {
  var arr = list();
  arr.sort(byNewest);
  while (arr.length >= MAX_RECORDS) {
    var old = arr.pop();
    unlink(old && old.audio_path);
  }
  arr.unshift(rec);
  save(arr);
  return rec;
}

function update(id, patch) {
  var arr = list();
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].id !== id) continue;
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) arr[i][k] = patch[k];
    }
    save(arr);
    return true;
  }
  return false;
}

function remove(id) {
  var arr = list();
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].id === id) { unlink(arr[i].audio_path); continue; }
    out.push(arr[i]);
  }
  save(out);
  return true;
}

function clear() {
  var arr = list();
  for (var i = 0; i < arr.length; i++) unlink(arr[i].audio_path);
  save([]);
  return true;
}

/** 临时路径当晚会失效，必须另存为持久文件；存不下就退回临时路径并提示 */
function persist(tmp) {
  return new Promise(function (resolve) {
    try {
      var fs = wx.getFileSystemManager && wx.getFileSystemManager();
      if (!fs || !fs.saveFile) { resolve(tmp); return; }
      fs.saveFile({
        tempFilePath: tmp,
        success: function (r) { resolve((r && r.savedFilePath) || tmp); },
        fail: function () { resolve(tmp); }
      });
    } catch (e) { resolve(tmp); }
  });
}

/* -------------------------- 示范音与拆词 -------------------------- */

function hasLocal(word) {
  return !!byLower[String(word || '').toLowerCase()];
}

/**
 * 只播放内置清单里有的词。清单外的词一律不交给发音模块 ——
 * 它会走云端兜底，而这版承诺了不联网，且云端能力随时可能不可用。
 */
function speak(word) {
  if (!hasLocal(word)) return false;
  try { tts.speak(word); return true; } catch (e) { return false; }
}

/** 自定义文本没有句子级示范音：拆成词，命中的可逐词点听，没命中的置灰 */
function chips(text) {
  return code.words(text).map(function (w) {
    return { word: w, key: audioKey.key(w), hasAudio: hasLocal(w) };
  });
}

/* ---------------------------- 录音状态机 ---------------------------- */

var state = 'IDLE';           // IDLE | RECORDING | SAVING | PLAYING
var recorder = null;
var player = null;
var stopCb = null;
var autoTimer = null;
var pendingMeta = null;

function clearAutoTimer() {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
}

function rec() {
  if (recorder) return recorder;
  if (typeof wx === 'undefined' || !wx.getRecorderManager) return null;
  recorder = wx.getRecorderManager();
  if (recorder.onStop) recorder.onStop(function (res) { onStopped(res); });
  if (recorder.onError) recorder.onError(function (err) { onFailed(err); });
  return recorder;
}

function normalizeMeta(meta) {
  var m = meta || {};
  return {
    type: m.type === 'word' ? 'word' : 'custom',
    ref_text: String(m.ref_text || '').slice(0, code.MAX_REF),
    ref_word: String(m.ref_word || '').slice(0, 60),
    code_id: String(m.code_id || '').slice(0, 40),
    source: String(m.source || 'local').slice(0, 20)
  };
}

function onStopped(res) {
  clearAutoTimer();
  if (state !== 'RECORDING' && state !== 'SAVING') return;
  state = 'SAVING';
  var cb = stopCb;
  stopCb = null;
  var tmp = res && (res.tempFilePath || res.apFilePath);
  if (!tmp) {
    state = 'IDLE';
    if (cb) cb(null, new Error('RECORD_FAIL'));
    return;
  }
  var m = pendingMeta || normalizeMeta(null);
  pendingMeta = null;
  persist(tmp).then(function (path) {
    var id = newId();
    var item = {
      id: id,
      client_record_id: id,   // 第 2 期接回服务端时做幂等唯一键，不用重映射
      type: m.type,
      ref_text: m.ref_text,
      ref_word: m.ref_word,
      code_id: m.code_id,
      source: m.source,
      audio_path: path,
      duration_ms: (res && res.duration) || 0,
      file_size: (res && res.fileSize) || 0,
      created_at: Date.now(),
      listened: false,
      marked_read: false,
      passed: false
    };
    add(item);
    state = 'IDLE';
    if (cb) cb(item, null);
  });
}

/** 错误必须分类透传，不能吞成「取消」—— 拒绝授权和没空间是完全不同的两件事 */
function classify(e) {
  var m = String((e && (e.errMsg || e.message)) || e || '');
  if (/auth|deny|permission|authorize|privacy/i.test(m)) return 'MIC_DENIED';
  if (/interrupt|phone|来电/i.test(m)) return 'INTERRUPTED';
  if (/encode|format|codec/i.test(m)) return 'ENCODE_FAIL';
  if (/space|size|storage/i.test(m)) return 'NO_SPACE';
  return 'RECORD_FAIL';
}

function onFailed(err) {
  clearAutoTimer();
  state = 'IDLE';
  pendingMeta = null;
  var cb = stopCb;
  stopCb = null;
  if (cb) cb(null, new Error(classify(err)));
}

/** 起录失败（授权拒绝 / 设备不支持 / start 抛错）时把状态完整还回去 */
function rollback(e) {
  clearAutoTimer();
  state = 'IDLE';
  pendingMeta = null;
  var cb = stopCb;
  stopCb = null;
  if (cb) cb(null, e);
}

/**
 * 开始录。唯一入口：先过隐私与麦克风授权，再拿录音管理器。
 *
 * 状态要「同步占住」：授权是异步的，若等 then 里才设 RECORDING，
 * 这段空窗里重复点会漏进来，页面也来不及把按钮切成「录好了，停」。
 * @returns {Promise<object>} 录完并落盘的记录
 */
function start(meta) {
  return new Promise(function (resolve, reject) {
    if (state === 'PLAYING') stopPlay();
    if (state !== 'IDLE') { reject(new Error('BUSY')); return; }
    state = 'RECORDING';
    pendingMeta = normalizeMeta(meta);
    stopCb = function (item, err) { if (err) reject(err); else resolve(item); };
    privacy.ensureRecord().then(function () {
      var r = rec();
      if (!r) { rollback(new Error('NO_RECORDER')); return; }
      try {
        r.start(RECORD_OPTIONS);
      } catch (e) { rollback(e); return; }
      autoTimer = setTimeout(function () { if (state === 'RECORDING') stop(); }, MAX_MS + 200);
    }).catch(function (e) { rollback(e); });
  });
}

function stop() {
  if (state !== 'RECORDING') return Promise.reject(new Error('NOT_RECORDING'));
  var r = rec();
  state = 'SAVING';
  try {
    r.stop();
  } catch (e) {
    state = 'IDLE'; stopCb = null; pendingMeta = null;
    return Promise.reject(e);
  }
  return Promise.resolve(true);
}

/** 页面 onHide / onUnload 调它：录着就收尾保存，播着就停 */
function cancelRecord() {
  if (state === 'RECORDING') return stop();
  stopPlay();
  return Promise.resolve(true);
}

function stopPlay() {
  if (player && player.stop) { try { player.stop(); } catch (e) { /* 忽略 */ } }
  if (state === 'PLAYING') state = 'IDLE';
  return true;
}

function play(id) {
  var item = get(id);
  if (!item || !item.audio_path) return false;
  if (state === 'RECORDING' || state === 'SAVING') return false;
  if (typeof wx === 'undefined' || !wx.createInnerAudioContext) return false;
  if (!player) player = wx.createInnerAudioContext();
  stopPlay();
  state = 'PLAYING';
  try {
    player.src = item.audio_path;
    if (player.onEnded) player.onEnded(function () { if (state === 'PLAYING') state = 'IDLE'; });
    if (player.onError) player.onError(function () { if (state === 'PLAYING') state = 'IDLE'; });
    player.play();
  } catch (e) {
    state = 'IDLE';
    return false;
  }
  update(id, { listened: true });
  return true;
}

function getState() { return state; }

/* ------------------------------ 汇总 ------------------------------ */

function day(ts) {
  var d = new Date(ts || Date.now());
  function p(n) { return n < 10 ? '0' + n : '' + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 本机练习汇总文字：家长复制后转发给老师。
 * 只带统计、不带音频 —— 录音是本机文件，别人手机打不开，硬发过去只会是个死链。
 */
function summary() {
  var arr = list();
  if (!arr.length) return '这段时间还没有跟读记录。';
  var days = {}, listened = 0, read = 0, passed = 0, custom = 0;
  var min = Infinity, max = 0;
  for (var i = 0; i < arr.length; i++) {
    var r = arr[i];
    days[day(r.created_at)] = 1;
    if (r.listened) listened++;
    if (r.marked_read) read++;
    if (r.passed) passed++;
    if (r.type === 'custom') custom++;
    if (r.created_at < min) min = r.created_at;
    if (r.created_at > max) max = r.created_at;
  }
  return [
    '【功课抽查 · 跟读练习汇总】',
    '日期：' + day(min) + ' ~ ' + day(max),
    '录音：' + arr.length + ' 条，覆盖 ' + Object.keys(days).length + ' 天',
    '回放自听：' + listened + ' 条',
    '标记已读：' + read + ' 条',
    '家长确认：' + passed + ' 条',
    '材料：单词 ' + (arr.length - custom) + ' 条 / 自定义 ' + custom + ' 条',
    '（录音只存在这台手机，不上传；本条汇总只有文字，不含音频）'
  ].join('\n');
}

var ERR_TEXT = {
  BUSY: '正在录音或保存，先等一下',
  NOT_RECORDING: '现在没有在录音',
  NO_RECORDER: '这台设备不支持录音',
  MIC_DENIED: '需要打开麦克风授权才能录音',
  PRIVACY_DENIED: '需要你先同意隐私指引',
  RECORD_FAIL: '录音没成功，再试一次',
  INTERRUPTED: '录音被来电或切后台打断了，再录一次',
  ENCODE_FAIL: '录音格式没生成好，再试一次',
  NO_SPACE: '手机空间不够，先删掉几条旧录音',
  NO_FILE: '没找到这条录音，可能已被清理',
  NO_PLAYER: '这台设备不能播放录音',
  PLAY_FAIL: '这条录音播放失败'
};

function errorText(e) {
  var k = String((e && e.message) || e || '');
  return ERR_TEXT[k] || '录音出了点问题，再试一次';
}

module.exports = {
  STORAGE_KEY: STORAGE_KEY,
  MAX_RECORDS: MAX_RECORDS,
  MAX_MS: MAX_MS,
  RECORD_OPTIONS: RECORD_OPTIONS,
  list: list,
  get: get,
  add: add,
  update: update,
  remove: remove,
  clear: clear,
  hasLocal: hasLocal,
  speak: speak,
  chips: chips,
  start: start,
  stop: stop,
  cancelRecord: cancelRecord,
  play: play,
  stopPlay: stopPlay,
  getState: getState,
  summary: summary,
  errorText: errorText
};
