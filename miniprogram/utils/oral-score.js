/**
 * 口语评分器 —— 可插拔契约 + 本期本地完成度引擎
 *
 * 设计目的：把「怎么判」和「判完怎么用」彻底分开。
 * 页面只认 score() 返回的统一结构，将来接 SOE 真发音评分时，
 * 只需注入一个新引擎，页面、门槛逻辑、报告留痕一行都不改。
 *
 * 本期引擎 local 的诚实边界（必须写清楚，不许包装成发音准确度）：
 *   它能算的只有 PCM 帧能量导出的：有没有开口、读了多久、停了多久、连贯不连贯；
 *   它算不出音素、单词准确度、漏读错读。所以三档是「完成度三档」，
 *   对外文案一律写「再读一遍 / 读完了 / 读得很流畅」，
 *   绝不能写成「发音正确、得分、评分、评测」。个人主体审核禁词，也会误导家长。
 *
 * 契约（所有引擎通用）：
 *   input  { frames:[{rms,ms}], durationMs, refText, retry }
 *   output { grade:'bad'|'ok'|'perfect', scores:{voicedMs,pauseMs,continuity},
 *            issues:[string], engine:string, verdict:string, honest:boolean }
 *
 *   honest=true 表示 engine 是 local（只测完成度）；接了真评分引擎后为 false，
 *   页面据此决定要不要展示「读得准不准」的字样，避免两种口径串味。
 */

/** 重读上限：第 3 次仍不合格也放行，绝不把孩子卡死（2026-11-12 用户拍板） */
var MAX_RETRY = 3;

/** 三档文案：完成度口径，不含任何发音准确度暗示 */
var VERDICT = {
  bad: '再读一遍',
  ok: '读完了',
  perfect: '读得很流畅'
};

/** 判定阈值：都基于「参考文本有多长」动态算，不对长句用词的固定时长 */
var MS_PER_WORD = 380;      // 每个英文词大概 380ms 的朗读时长
var BASE_MS = 320;          // 起手/收尾的余量
var MIN_EXPECT_MS = 600;
var MAX_EXPECT_MS = 20000;
var SILENCE_RMS = 0.012;    // 低于此能量视为静音（16bit PCM 归一化后的经验值）

/**
 * 2026-11-13 真机反馈「有些词怎么读都过不去，放慢一个字一个字蹦着读反而容易过」。
 * 根因是旧版拿「期望时长」当尺子：读得快一点就判「太短」，中间喘口气就判「断续」。
 * 本机只能测完成度，**没有资格要求孩子按某个语速读**，所以：
 *   · 不合格只剩两种——基本没出声、只读了一点点；
 *   · 停顿不再判错（慢慢读、换气都算读完），只影响能不能拿「很流畅」；
 *   · 读太长也不判错（孩子重复读、清嗓子都不该罚）。
 */
var MIN_VOICED_MS = 180;    // 短于这个基本等于没开口
var MIN_COVER_RATIO = 0.15; // 有效发声不足期望时长的 15%
var MIN_COVER_MS = 350;     // 且不低于这个绝对下限，两者取小的当门槛
var PERFECT_CONTINUITY = 0.7;
var PERFECT_MAX_PAUSE = 600;

function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/** 参考文本长度 → 期望朗读时长 */
function expectMs(refText) {
  var n = words(refText);
  var ms = BASE_MS + Math.max(1, n) * MS_PER_WORD;
  return Math.min(MAX_EXPECT_MS, Math.max(MIN_EXPECT_MS, ms));
}

/**
 * 帧能量 → 完成度指标。frames 由录音层的 onFrameRecorded 采样后传入。
 * 只累加能量，不做任何频谱/识别 —— 这是能力边界，不是偷懒。
 *
 * continuity 只统计「第一次出声 → 最后一次出声」这一段：
 * 按住之前的那半秒、抬手之后的那点尾巴都不该算进分母，
 * 否则孩子读得再完整，也会被前摇后摇拖成「不连贯」。
 */
function measure(frames, durationMs) {
  var list = Array.isArray(frames) ? frames : [];
  var voicedMs = 0;
  var total = 0;
  var t = 0;
  var firstAt = -1;
  var lastEnd = 0;
  var i;

  for (i = 0; i < list.length; i++) {
    var f = list[i] || {};
    var ms = Math.max(0, Number(f.ms) || 0);
    var rms = Math.max(0, Number(f.rms) || 0);
    total += ms;
    if (ms > 0 && rms >= SILENCE_RMS) {
      voicedMs += ms;
      if (firstAt < 0) firstAt = t;
      lastEnd = t + ms;
    }
    t += ms;
  }

  // 停顿只算开口区间内部的空档：开头吸气、末尾抬手都不算断续
  var pauseMs = 0;
  if (firstAt >= 0 && lastEnd > firstAt) {
    var run = 0;
    t = 0;
    for (i = 0; i < list.length; i++) {
      var ff = list[i] || {};
      var ms2 = Math.max(0, Number(ff.ms) || 0);
      var rms2 = Math.max(0, Number(ff.rms) || 0);
      var s = t;
      var e = t + ms2;
      t = e;
      if (e <= firstAt || s >= lastEnd) continue;
      if (rms2 >= SILENCE_RMS) {
        if (run > pauseMs) pauseMs = run;
        run = 0;
      } else {
        run += ms2;
      }
    }
    if (run > pauseMs) pauseMs = run;
  }

  var region = firstAt >= 0 ? Math.max(0, lastEnd - firstAt) : 0;
  // 一帧都没采到时长是 0 时，退回录音总时长，别把「读完」判成「没读」
  var span = region > 0 ? region : Math.max(total, Number(durationMs) || 0);
  return {
    voicedMs: Math.round(voicedMs),
    pauseMs: Math.round(pauseMs),
    spanMs: Math.round(span),
    continuity: span > 0 ? Math.round(voicedMs / span * 100) / 100 : 0
  };
}

/**
 * 裁掉松手后的尾部静音缓冲。
 *
 * 页面会在抬手后多录 ~1.2 秒（孩子常常话没落音就松手，尾音会被切掉）。
 * 这段缓冲全是静音，若原样交给 measure()，会被算成「中间停了很久」，
 * 把本来读完的一遍判成不合格。这里只从**末尾**整帧地裁静音，
 * 中间的停顿一帧都不动，也就不会掩盖真正的断续。
 *
 * @param {Array} frames [{rms, ms}]
 * @param {number} maxMs 最多裁掉多少毫秒（与页面缓冲时长一致）
 * @returns {{frames: Array, removedMs: number}}
 */
function trimTailSilence(frames, maxMs) {
  var list = Array.isArray(frames) ? frames.slice() : [];
  var budget = Math.max(0, Number(maxMs) || 0);
  var removedMs = 0;
  while (list.length) {
    var last = list[list.length - 1] || {};
    var rms = Math.max(0, Number(last.rms) || 0);
    if (rms >= SILENCE_RMS) break;                 // 末尾是有声帧，别把尾音裁掉
    var ms = Math.max(0, Number(last.ms) || 0);
    if (ms < 1 || removedMs + ms > budget) break; // 只整帧裁，不越预算
    list.pop();
    removedMs += ms;
  }
  return { frames: list, removedMs: removedMs };
}

/**
 * 本地完成度引擎：**只判「有没有开口、读没读完」**，不判发音。
 *
 * 设计原则（2026-11-13 真机反馈后收紧）：宁可放过，不可误伤。
 * 孩子读错音、语速快、中间换气，本机都听不出来，也就没资格判不合格 ——
 * 只有「几乎没声音」和「只读了开头一小截」才拦，其余一律放行。
 */
function localEngine(input) {
  var ref = String(input.refText || '');
  var list = Array.isArray(input.frames) ? input.frames : [];
  var expect = expectMs(ref);
  var dur = Math.max(0, Number(input.durationMs) || 0);
  var issues = [];

  /* 一帧都没采到：部分机型 PCM 帧回调不触发。
     这时只能看「这次录了多久」，不能因此把孩子永久卡在一条上。 */
  if (!list.length) {
    var durOk = dur >= 450;
    return {
      grade: durOk ? 'ok' : 'bad',
      scores: { voicedMs: 0, pauseMs: 0, spanMs: Math.round(dur), continuity: 0 },
      issues: durOk ? ['这条没听清细节，先按读完算'] : ['没听到声音，靠近一点再读'],
      engine: 'local',
      verdict: durOk ? VERDICT.ok : VERDICT.bad,
      honest: true,
      expectMs: expect,
      sampled: false
    };
  }

  var m = measure(list, dur);
  var grade = 'ok';
  var minVoiced = Math.min(expect * MIN_COVER_RATIO, MIN_COVER_MS);

  if (m.voicedMs < MIN_VOICED_MS) {
    grade = 'bad';
    issues.push('没听到声音，靠近一点再读');
  } else if (m.voicedMs < minVoiced) {
    grade = 'bad';
    issues.push('读得太短了，把整句读完再松手');
  }

  if (grade === 'ok' && input.listened !== false && Number(input.retry || 0) === 0 &&
      m.continuity >= PERFECT_CONTINUITY && m.pauseMs <= PERFECT_MAX_PAUSE &&
      m.voicedMs >= expect * 0.45 && m.voicedMs <= expect * 2.2) {
    grade = 'perfect';
  }

  return {
    grade: grade,
    scores: m,
    issues: issues,
    engine: 'local',
    verdict: VERDICT[grade],
    honest: true,
    expectMs: expect,
    sampled: true
  };
}

/**
 * 真发音评分引擎的**结果归一化**（不是网络调用）。
 * 接 SOE 后，服务端返回的结构在这里折成统一契约，页面零改动。
 * 现在只做纯函数映射：密钥、签名、上传全在服务端，端上一行不留。
 */
function normalizeRemote(resp) {
  var r = resp || {};
  var acc = Number(r.accuracy !== undefined ? r.accuracy : r.PronAccuracy);
  if (isNaN(acc)) acc = 0;
  var grade = acc >= 85 ? 'perfect' : (acc >= 60 ? 'ok' : 'bad');
  return {
    grade: grade,
    scores: {
      accuracy: acc,
      fluency: Number(r.fluency || r.PronFluency || 0),
      completeness: Number(r.completeness || r.PronCompletion || 0),
      voicedMs: 0, pauseMs: 0, continuity: 0
    },
    issues: (r.issues || r.PhoneInfos || []).slice ? (r.issues || []).slice(0, 6) : [],
    engine: r.engine || 'remote',
    verdict: VERDICT[grade],
    honest: false,
    expectMs: 0
  };
}

var engines = { local: localEngine };
var current = 'local';

/** 注入引擎：将来 register('soe', fn) 一行切换，页面不感知 */
function register(name, fn) {
  if (!name || typeof fn !== 'function') return false;
  engines[name] = fn;
  return true;
}

function use(name) {
  if (!engines[name]) return false;
  current = name;
  return true;
}

function engineName() { return current; }

/** 统一入口 */
function score(input) {
  var fn = engines[current] || localEngine;
  var out = fn(input || {});
  if (!out || !out.grade) return localEngine(input || {});
  return out;
}

/** 门槛：合格（ok/perfect）才放行；重读满 MAX_RETRY 次也放行，留痕交报告 */
function shouldPass(result, retry) {
  if (!result) return true;
  if (result.grade !== 'bad') return true;
  return Number(retry || 0) >= MAX_RETRY;
}

/** 报告用的留痕：一条口语条目的完整过程 */
function trace(entry) {
  var e = entry || {};
  return {
    refText: String(e.refText || ''),
    kind: e.kind || 'word',
    grade: (e.result && e.result.grade) || 'bad',
    retry: Number(e.retry || 0),
    forced: !!e.forced,
    engine: (e.result && e.result.engine) || 'local',
    honest: e.result ? e.result.honest !== false : true,
    issues: (e.result && e.result.issues) || []
  };
}

module.exports = {
  MAX_RETRY: MAX_RETRY,
  VERDICT: VERDICT,
  SILENCE_RMS: SILENCE_RMS,
  expectMs: expectMs,
  measure: measure,
  trimTailSilence: trimTailSilence,
  localEngine: localEngine,
  normalizeRemote: normalizeRemote,
  register: register,
  use: use,
  engineName: engineName,
  score: score,
  shouldPass: shouldPass,
  trace: trace
};
