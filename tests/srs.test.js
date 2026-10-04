/**
 * SRS 状态机测试 —— 用 Node 直接跑，不需要装任何依赖
 *
 *   node tests/srs.test.js
 *
 * 为什么先给算法写测试：档位与间隔的规则一旦上线再改，用户的复习节奏会被整体打乱，
 * 属于"改起来最贵"的一类逻辑。这些用例同时也是文档第 8 章的机器可读版本。
 */

var assert = require('assert');
var srs = require('../shared/srs');

var passed = 0;
var failed = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed.push({ name: name, message: e.message });
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

var MIN = srs.MINUTE;
var DAY = srs.DAY;

console.log('SRS 状态机测试');

/* ---------------- 档位与间隔 ---------------- */

test('学习时点"认识"档位 +2', function () {
  var prev = { stage: 2, last_feedback: 'known', next_review_at: 0 };
  var now = Date.now();
  var r = srs.nextState(prev, 'known', now);
  assert.strictEqual(r.stage, 4);
  assert.strictEqual(r.nextReviewAt - now, 7 * DAY);
});

test('★ 学习阶段封顶档位 4：无论点多少次"认识"都到不了长间隔', function () {
  var now = Date.now();
  var r = srs.nextState({ stage: 4, last_feedback: 'known' }, 'known', now);
  assert.strictEqual(r.stage, srs.LEARN_STAGE_CAP,
    '学习时最多到档位 ' + srs.LEARN_STAGE_CAP + '（7 天），不能自己给自己发通行证');
  assert.strictEqual(r.nextReviewAt - now, 7 * DAY);
});

test('学习时若被上限挡住，结果里标记 capped（供界面提示"要通过抽查"）', function () {
  var now = Date.now();
  var blocked = srs.nextState({ stage: 4, last_feedback: 'known' }, 'known', now);
  assert.strictEqual(blocked.capped, true, '已到上限，应标记被封顶');

  var free = srs.nextState({ stage: 1, last_feedback: 'known' }, 'known', now);
  assert.strictEqual(free.capped, false, '还没到上限，不应标记');
});

test('★ 抽查答对可以突破学习上限（这才是进入长间隔的唯一途径）', function () {
  var now = Date.now();
  var r = srs.nextState({ stage: 4, last_feedback: 'known' }, 'known', now, { fromQuiz: true });
  assert.strictEqual(r.stage, 7, '档位 4 + 抽查 +3 = 7');
  assert.strictEqual(r.nextReviewAt - now, 60 * DAY);
  assert.strictEqual(r.capped, false, '抽查不受学习上限约束');
});

test('抽查答对后能到的最高档位是 8', function () {
  var r = srs.nextState({ stage: 8, last_feedback: 'known' }, 'known', Date.now(), { fromQuiz: true });
  assert.strictEqual(r.stage, 8);
});

test('"没想起来"归零并给 10 分钟间隔', function () {
  var now = Date.now();
  var r = srs.nextState({ stage: 6, last_feedback: 'known' }, 'forgot', now);
  assert.strictEqual(r.stage, 0);
  assert.strictEqual(r.nextReviewAt - now, 10 * MIN);
  assert.strictEqual(r.lastFeedback, 'forgot');
});

/* ---------------- "模糊"的核心规则 ---------------- */

test('第一次"费劲"：档位不变，间隔 = 当前档位默认间隔的一半', function () {
  var now = Date.now();
  var r = srs.nextState({ stage: 5, last_feedback: 'known' }, 'vague', now);
  assert.strictEqual(r.stage, 5, '档位必须不变');
  assert.strictEqual(r.nextReviewAt - now, 7.5 * DAY, '档位 5 默认 15 天，减半 = 7.5 天');
});

test('"费劲"减半的基准是档位默认间隔，不是上次实际间隔（不累乘）', function () {
  var now = Date.now();
  // 构造一个"上次实际只排了 3 天"的状态：下次仍应是 7.5 天，而不是 1.5 天
  var prev = { stage: 5, last_feedback: 'known', next_review_at: now - 2 * DAY };
  var r = srs.nextState(prev, 'vague', now);
  assert.strictEqual(r.nextReviewAt - now, 7.5 * DAY);
});

test('低档位"费劲"不会算出 0：档位 0 时保底 10 分钟', function () {
  var now = Date.now();
  var r = srs.nextState({ stage: 0, last_feedback: 'forgot' }, 'vague', now);
  assert.strictEqual(r.nextReviewAt - now, 10 * MIN);
});

test('连续两次"费劲"按"没想起来"处理（档位归零）', function () {
  var now = Date.now();
  var r = srs.nextState({ stage: 6, last_feedback: 'vague' }, 'vague', now);
  assert.strictEqual(r.stage, 0);
  assert.strictEqual(r.lastFeedback, 'forgot');
  assert.strictEqual(r.nextReviewAt - now, 10 * MIN);
});

test('"费劲"与"想得很快"交替时不会被误判为连续费劲', function () {
  var now = Date.now();
  var r = srs.nextState({ stage: 5, last_feedback: 'known' }, 'vague', now);
  assert.strictEqual(r.stage, 5, '不能因为上上次是 vague 就归零');
});

/* ---------------- 记忆衰减 ---------------- */

test('逾期超过 7 天才衰减档位，刚逾期不衰减', function () {
  var now = Date.now();
  // 用抽查场景验证衰减：学习阶段有档位上限（4），看不出 +3 的效果
  var justOverdue = srs.nextState(
    { stage: 5, last_feedback: 'known', next_review_at: now - 1 * DAY }, 'known', now, { fromQuiz: true });
  assert.strictEqual(justOverdue.decayed, false);
  assert.strictEqual(justOverdue.stage, 8, '5 + 抽查 3 = 8（已是上限）');

  var longOverdue = srs.nextState(
    { stage: 5, last_feedback: 'known', next_review_at: now - 10 * DAY }, 'known', now, { fromQuiz: true });
  assert.strictEqual(longOverdue.decayed, true, '逾期超过 7 天应标记衰减');
  assert.strictEqual(longOverdue.stage, 7, '5 + 3 - 1 = 7');
});

test('衰减不会把档位压到负数', function () {
  var now = Date.now();
  var r = srs.nextState(
    { stage: 0, last_feedback: 'known', next_review_at: now - 30 * DAY }, 'forgot', now);
  assert.strictEqual(r.stage, 0);
});

/* ---------------- 首学与脏数据 ---------------- */

test('首学（prev 为 null）当作档位 0 处理', function () {
  var now = Date.now();
  var r = srs.nextState(null, 'known', now);
  assert.strictEqual(r.stage, 2);
  assert.strictEqual(r.nextReviewAt - now, 2 * DAY);
});

test('脏数据（stage 为字符串/负数/小数）被规整', function () {
  assert.strictEqual(srs.clampStage('abc'), 0);
  assert.strictEqual(srs.clampStage(-3), 0);
  assert.strictEqual(srs.clampStage(2.7), 2);
  assert.strictEqual(srs.clampStage(99), 8);
});

test('掌握率口径：档位 ≥5 才算掌握', function () {
  assert.strictEqual(srs.isMastered({ stage: 4 }), false);
  assert.strictEqual(srs.isMastered({ stage: 5 }), true);
  assert.strictEqual(srs.isMastered(null), false);
});

test('各档位的可读间隔文案正确', function () {
  assert.strictEqual(srs.stageLabel(0), '10 分钟');
  assert.strictEqual(srs.stageLabel(1), '1 天');
  assert.strictEqual(srs.stageLabel(3), '4 天');
  assert.strictEqual(srs.stageLabel(5), '15 天');
});

test('档位与间隔表长度一致（防止只改了一个数组）', function () {
  assert.strictEqual(srs.STAGE_INTERVAL.length, srs.MAX_STAGE + 1);
  assert.strictEqual(srs.STAGE_INTERVAL.length, 9);
});

/* ---------------- 结果 ---------------- */

console.log('');
if (failed.length) {
  console.log('失败 ' + failed.length + ' 项，通过 ' + passed + ' 项');
  process.exit(1);
} else {
  console.log('全部通过：' + passed + ' 项 ✓');
}
