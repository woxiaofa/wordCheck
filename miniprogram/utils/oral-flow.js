/**
 * 体验主流程编排（纯逻辑，可 Node 直测）
 *
 * 四阶段是用户 2026-11-12 的原话落成的状态机：
 *   带读（词 → 短句 → 小段，逐条判定、合格才下一条）
 *   → 口语抽查（不给示范音，自己读一遍，错的再过）
 *   → 现有背词（复用 pkg-media/pages/drill，认 → 写 → 巩固，一行不重造）
 *   → 一张报告（口语与书面并列 + 待练清单 + 只练没读流畅的）
 *
 * 这个文件不放任何 wx 录音 / 播放 / 跳转，只做：
 *   · 题目怎么拼（buildCheck / buildRetry）
 *   · 门槛怎么定（shouldRetry）
 *   · 报告怎么合并（mergeReport / practiceList）
 *   · 跨页会话怎么交接（session，纯文本，绝不含录音与 PCM 帧）
 *
 * 为什么跨页会话用 storage 而不是全局变量：flow 页 → drill 页用的是
 * redirectTo，flow 实例会被销毁；模块内存虽在，但小程序被系统回收后就没了。
 * 只写文本（参考句、三档、书面统计），不写任何音频、不上传，符合既有隐私承诺。
 */

var SESSION_KEY = 'oral_flow_session';
var CHECK_MAX_ROUNDS = 2;      // 抽查最多过两轮：第一遍 + 错的再过一遍，不无限循环
var memorySession = null;      // Node 测试桩 / storage 不可用时的兜底

/* ------------------------------ 口语抽查 ------------------------------ */

/** 确定性洗牌：同一 seed 出同一套题，便于复现与回归测试 */
function seededShuffle(list, seed) {
  var out = list.slice();
  var s = Number(seed || 1) || 1;
  for (var i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    var j = s % (i + 1);
    var t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

function oralQuestion(item, i) {
  return {
    id: 'q' + i,
    type: 'oral',
    label: '读',
    refText: item.refText,
    display: item.display,
    lines: item.lines || [],
    cn: item.cn || '',
    phonetic: item.phonetic || '',
    word: item.word || '',
    kind: item.kind,
    audio: item.audio || '',     // 抽查阶段页面**不主动播**，只留作报告展示
    stem: '',
    options: [],
    answer: ''
  };
}

/**
 * 抽查题（2026-11-13 用户拍板）：只考「自己读出来」，体验页不另造选择题。
 * 书面的「认 / 写」全部交给现有 drill，避免两套选择题互相打架、UI 也两套。
 * 4 个词 + 1 个代表短句，不给示范音；错的再过一轮。
 * @param {Array} items buildItems() 的带读条目
 * @param {Array} pool  保留参数兼容调用方（不再用于出干扰项）
 * @param {number} seed 洗牌种子
 */
function buildCheck(items, pool, seed) {
  var list = items || [];
  var words = list.filter(function (x) { return x.kind === 'word'; });
  var sentences = list.filter(function (x) { return x.kind === 'sentence'; });
  var qs = [];
  words.forEach(function (x) { qs.push(oralQuestion(x, qs.length)); });
  if (sentences.length) qs.push(oralQuestion(sentences[0], qs.length));
  return seededShuffle(qs, seed);
}

/** 错题再过一轮：只重放错的那些，不重出整轮 */
function buildRetry(wrong, seed) {
  var list = (wrong || []).map(function (q, i) {
    var c = {};
    Object.keys(q).forEach(function (k) { c[k] = q[k]; });
    c.id = 'r' + i;
    return c;
  });
  return seededShuffle(list, seed);
}

function shouldRetry(wrong, round) {
  return !!(wrong && wrong.length && Number(round || 0) < CHECK_MAX_ROUNDS);
}

/* ------------------------------ 报告 ------------------------------ */

/**
 * 待练清单：只挑没到「完美」的条目。
 * 「精益求精的可以反复都读完美」—— 报告里这个按钮只重练这些，不浪费已读好的。
 */
function practiceList(traces) {
  var seen = {};
  var out = [];
  (traces || []).forEach(function (t) {
    if (!t || !t.refText || seen[t.refText]) return;
    if (t.grade === 'perfect') return;
    seen[t.refText] = 1;
    out.push({
      refText: t.refText,
      kind: t.kind || 'word',
      grade: t.grade,
      reason: t.forced ? '读了几次还不太顺' :
        (t.grade === 'bad' ? '这条再读一遍' : '已经读完，还能更流畅'),
      issues: (t.issues || []).slice(0, 2)
    });
  });
  return out;
}

/**
 * 合并报告：口语（带读 + 抽查）+ 抽查书面 + 现有背词，一张纸看完。
 * drill 为空表示孩子中途没走完背词阶段，报告照样能出，不许崩。
 */
function mergeReport(session) {
  var s = session || {};
  var traces = s.traces || [];
  var oral = { total: traces.length, perfect: 0, ok: 0, bad: 0, forced: 0, honest: true };
  traces.forEach(function (t) {
    if (t.grade === 'perfect') oral.perfect++;
    else if (t.grade === 'bad') oral.bad++;
    else oral.ok++;
    if (t.forced) oral.forced++;
    if (t.honest === false) oral.honest = false;
  });
  var check = s.check || { total: 0, wrong: 0, rounds: 0 };
  var drill = s.drill || null;
  var practice = practiceList(traces);
  return {
    oral: oral,
    check: check,
    drill: drill,
    practice: practice,
    allPerfect: practice.length === 0 && oral.total > 0 &&
      check.wrong === 0 && (!drill || !!drill.allDone)
  };
}

/* ------------------------------ 跨页会话 ------------------------------ */

function load() {
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      return wx.getStorageSync(SESSION_KEY) || null;
    }
  } catch (e) { /* 落到内存兜底 */ }
  return memorySession;
}

function save(session) {
  var s = session || {};
  memorySession = s;
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(SESSION_KEY, s);
  } catch (e) { /* 写不进就只留内存，不阻断流程 */ }
  return s;
}

function clear() {
  memorySession = null;
  try {
    if (typeof wx !== 'undefined' && wx.removeStorageSync) wx.removeStorageSync(SESSION_KEY);
  } catch (e) { /* 忽略 */ }
}

/** drill 页 finish 时调用：把书面结果交回 flow 出合并报告 */
function setDrillResult(result) {
  var s = load() || {};
  s.drill = result || null;
  return save(s);
}

module.exports = {
  SESSION_KEY: SESSION_KEY,
  CHECK_MAX_ROUNDS: CHECK_MAX_ROUNDS,
  seededShuffle: seededShuffle,
  buildCheck: buildCheck,
  buildRetry: buildRetry,
  shouldRetry: shouldRetry,
  practiceList: practiceList,
  mergeReport: mergeReport,
  load: load,
  save: save,
  clear: clear,
  setDrillResult: setDrillResult
};
