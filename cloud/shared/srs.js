/**
 * SRS 状态机（共享模块 · 唯一真相来源）
 *
 * ⚠️ 两份副本由 scripts/sync-shared.js 生成，内容必须逐字节一致，勿手改副本：
 *   - miniprogram/utils/srs.js   （小程序侧）
 *   - cloud/shared/srs.js        （云函数侧）
 *
 * 为什么必须一致：小程序与云函数目录无法互相引用代码，硬做会引入构建层。
 * 所以选"单一来源 + 脚本生成 + 指纹校验"；两份一旦漂移，就会出现
 * "界面显示 7 天后复习、服务端排了 15 天"这类极难定位的问题。
 *
 * 规则（与《背单词教练小程序-可行性与产品方案》第 8 章一致）：
 *   档位:    0      1     2     3     4      5      6      7      8
 *   间隔:  10分钟   1天   2天   4天   7天   15天   30天   60天   120天
 *
 *   没想起来     → 档位归 0，10 分钟后重考
 *   想起来但费劲  → 档位不变，间隔 = 当前档位默认间隔 × 0.5（不累乘）
 *   连续两次费劲  → 按没想起来处理
 *   想得很快     → 档位 +2（上限 8）
 *   逾期 >7 天   → 档位 -1（记忆衰减）
 */

var MINUTE = 60 * 1000;
var DAY = 24 * 60 * MINUTE;

var STAGE_INTERVAL = [
  10 * MINUTE,
  1 * DAY,
  2 * DAY,
  4 * DAY,
  7 * DAY,
  15 * DAY,
  30 * DAY,
  60 * DAY,
  120 * DAY
];

var MAX_STAGE = STAGE_INTERVAL.length - 1;
var REQ_ID_TTL_DAYS = 7;            // 幂等记录保留天数
var OVERDUE_DECAY_DAYS = 7;         // 逾期多少天开始衰减
var REPEAT_VAGUE_AS_FORGOT = true;  // 连续两次"费劲"按"不认识"处理

/**
 * 学习阶段能到达的最高档位。
 *
 * 这是"用户自评不能给自己发通行证"的实现方式：
 * 学习时无论点多少次"认识"，档位最多到 4（间隔 7 天）；
 * 想进入 15 天以上的长间隔，必须在**抽查里答对**（抽查答对 +3，可突破这个上限）。
 *
 * 因此"档位 ≥5"就等于"这个词在抽查中被验证过"，
 * 掌握率的定义（档位≥5）自动变得有意义，不需要再加"是否抽查过"的字段。
 */
var LEARN_STAGE_CAP = 4;

/** 学习时点"认识"的升档幅度（一次跳 2 档，快速拉开已会/不会的差距） */
var LEARN_KNOWN_STEP = 2;

/** 抽查答对的升档幅度（比学习更大：这是通过验证的奖励） */
var QUIZ_KNOWN_STEP = 3;

function clampStage(s, cap) {
  var n = Number(s);
  if (!isFinite(n)) return 0;
  var hi = (typeof cap === 'number') ? Math.min(cap, MAX_STAGE) : MAX_STAGE;
  return Math.max(0, Math.min(hi, Math.floor(n)));
}

/** 按档位与反馈算间隔（毫秒） */
function intervalFor(stage, feedback) {
  var s = clampStage(stage);
  if (feedback === 'forgot') return STAGE_INTERVAL[0];
  if (feedback === 'vague') return Math.max(Math.round(STAGE_INTERVAL[s] * 0.5), STAGE_INTERVAL[0]);
  return STAGE_INTERVAL[s];
}

/**
 * 状态流转
 * @param {object|null} prev 现有状态（首学传 null）
 * @param {'forgot'|'vague'|'known'} feedback
 * @param {number} now 毫秒时间戳
 * @param {object} [opts]
 * @param {boolean} [opts.fromQuiz] 是否来自抽查。抽查答对可突破学习阶段的档位上限；
 *                                  学习阶段则封顶在 LEARN_STAGE_CAP，必须靠抽查才能到长间隔。
 */
function nextState(prev, feedback, now, opts) {
  var cur = prev || { stage: 0, last_feedback: null, next_review_at: null };
  var fromQuiz = !!(opts && opts.fromQuiz);
  var stage = clampStage(cur.stage);
  var lastFeedback = cur.last_feedback;

  if (feedback === 'forgot') {
    stage = 0;
    lastFeedback = 'forgot';
  } else if (feedback === 'vague') {
    if (REPEAT_VAGUE_AS_FORGOT && lastFeedback === 'vague') {
      stage = 0;
      lastFeedback = 'forgot';
    } else {
      lastFeedback = 'vague';
    }
  } else {
    var step = fromQuiz ? QUIZ_KNOWN_STEP : LEARN_KNOWN_STEP;
    var cap = fromQuiz ? MAX_STAGE : LEARN_STAGE_CAP;
    stage = clampStage(stage + step, cap);
    lastFeedback = 'known';
  }

  var decayed = false;
  if (cur.next_review_at && stage > 0 && (now - cur.next_review_at) > OVERDUE_DECAY_DAYS * DAY) {
    stage = Math.max(0, stage - 1);
    decayed = true;
  }

  return {
    stage: stage,
    lastFeedback: lastFeedback,
    nextReviewAt: now + intervalFor(stage, feedback),
    decayed: decayed,
    /** 是否被学习阶段的档位上限挡住了（用于界面提示"要通过抽查才能到更长间隔"） */
    capped: !fromQuiz && feedback === 'known' && (clampStage(cur.stage) + LEARN_KNOWN_STEP) > LEARN_STAGE_CAP
  };
}

/** 掌握率口径：档位 ≥5（间隔已到 15 天以上）算掌握 */
function isMastered(state) {
  return !!state && clampStage(state.stage) >= 5;
}

/** 生成幂等用的请求 ID（小程序与云函数都要同一套格式） */
function newReqId() {
  var t = Date.now().toString(36);
  var r = Math.random().toString(36).slice(2, 10);
  return t + '-' + r;
}

/** 档位可读文案，用于界面展示 */
function stageLabel(stage) {
  var s = clampStage(stage);
  var min = STAGE_INTERVAL[s] / MINUTE;
  if (min < 60) return min + ' 分钟';
  var h = min / 60;
  if (h < 24) return h + ' 小时';
  return (h / 24) + ' 天';
}

module.exports = {
  MINUTE: MINUTE,
  DAY: DAY,
  STAGE_INTERVAL: STAGE_INTERVAL,
  MAX_STAGE: MAX_STAGE,
  LEARN_STAGE_CAP: LEARN_STAGE_CAP,
  LEARN_KNOWN_STEP: LEARN_KNOWN_STEP,
  QUIZ_KNOWN_STEP: QUIZ_KNOWN_STEP,
  REQ_ID_TTL_DAYS: REQ_ID_TTL_DAYS,
  clampStage: clampStage,
  intervalFor: intervalFor,
  nextState: nextState,
  isMastered: isMastered,
  newReqId: newReqId,
  stageLabel: stageLabel
};
