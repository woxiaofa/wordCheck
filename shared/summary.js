/**
 * 学习简报：把"学了多久 / 学过几个词 / 抽查掌握几个 / 还有几个不会"合成一句话。
 *
 * 为什么要独立成模块：这句话学生端要看见、教练端也要看见（家长复制发给对方）。
 * 若两端各拼一次，迟早出现"学生端显示全掌握、家长端却说还剩 2 个"的接缝错位 ——
 * 文案与荣誉词的唯一真相只能有一处（本文件），由 scripts/sync-shared.js 分发。
 *
 * 数据口径（全部取当日，UTC+8 日期由调用方传入 getLocalDate 的结果）：
 *   minutes  = review_logs.duration_ms + quiz_sessions.duration_ms
 *   learned  = 今天学过的去重词数（学习页评价 + 抽查涉及，取并集）
 *   mastered / failed = quiz_items 今日 is_correct 的真/假计数
 *   forgotToday = 学习页今日评价为 forgot 的次数
 *   rate = 今日掌握率（review_logs 的 known + quiz_items 答对）/ 两侧总题次；无评价时为 null
 */

var COLL = {
  logs: 'review_logs',
  items: 'quiz_items',
  sessions: 'quiz_sessions'
};

/**
 * @param {Object} db 云数据库
 * @param {string} userId 学员 _id
 * @param {string} name 展示名（学生自己看就传"你"或昵称）
 * @param {string} today 本地日期 YYYY-MM-DD
 * @returns {Promise<Object>} 见文件头
 */
async function learnSummary(db, userId, name, today) {
  var who = name || '同学';

  var logs = await db.collection(COLL.logs)
    .where({ user_id: userId, review_date: today })
    .limit(200)
    .field({ word_id: true, duration_ms: true, feedback: true })
    .get().catch(() => ({ data: [] }));
  var logRows = logs.data || [];

  var items = await db.collection(COLL.items)
    .where({ user_id: userId, quiz_date: today })
    .limit(200)
    .field({ word_id: true, is_correct: true })
    .get().catch(() => ({ data: [] }));
  var itemRows = items.data || [];

  var sessions = await db.collection(COLL.sessions)
    .where({ user_id: userId, quiz_date: today })
    .limit(50)
    .field({ duration_ms: true })
    .get().catch(() => ({ data: [] }));
  var sessRows = sessions.data || [];

  // --- 时长：学习页 + 抽查合计；不足 1 分钟按 1 分钟说（"学了 0 分钟"听着像坏了） ---
  var ms = 0;
  logRows.forEach(function (l) { ms += Number(l.duration_ms) || 0; });
  sessRows.forEach(function (s) { ms += Number(s.duration_ms) || 0; });
  var minutes = ms > 0 ? Math.max(1, Math.round(ms / 60000)) : 0;

  // --- 学过几个词：两侧并集去重（同一个词先学后查，只算一个） ---
  var seen = {}, learned = 0;
  logRows.concat(itemRows).forEach(function (r) {
    if (!r.word_id || seen[r.word_id]) return;
    seen[r.word_id] = 1;
    learned++;
  });

  var quizTotal = itemRows.length;
  var mastered = itemRows.filter(function (r) { return r.is_correct === true; }).length;
  var failed = quizTotal - mastered;
  var forgotToday = logRows.filter(function (r) { return r.feedback === 'forgot'; }).length;

  /* --- 今日掌握率（2026-10-19 修） ---
   * 踩过的坑：掌握率原本只看 quiz_items，而 quiz_items **只有旧抽查页在写**
   * （cloud/functions/quiz/index.js）。现在的主流程是 drill（认→拼→巩固），
   * 每一题的评价全落在 review_logs。于是"今日掌握率"永远显示 — ，
   * 学员明明全对也显示 — ，家长只会以为数据坏了。
   *
   * 新口径与班级页 todayRate 完全一致（当日评价里 known 占几成）：
   *   分母 = 今日 review_logs 条数 + 今日 quiz_items 条数
   *   分子 = 今日 feedback==='known' 的条数 + quiz_items 答对条数
   * 两端同一个孩子必须只有一个数字，这是本项目反复强调的底线。 */
  var rateTotal = logRows.length + quizTotal;
  var rateMastered = logRows.filter(function (r) { return r.feedback === 'known'; }).length + mastered;
  var rate = rateTotal ? Math.round(rateMastered / rateTotal * 100) : null;

  var out = {
    minutes: minutes,
    learned: learned,
    quiz_total: quizTotal,
    mastered: mastered,
    failed: failed,
    forgot_today: forgotToday,
    rate_total: rateTotal,
    rate_mastered: rateMastered,
    rate: rate,                    // null = 今天还没有任何评价，前端显示"—"而不是 0%
    // 还要不要继续循环：有任何一个词没过（抽查答错 或 评价忘了）就得接着来
    need_loop: failed > 0 || forgotToday > 0,
    honor: null,
    text: ''
  };

  /* 文案口径（2026-10-09 用户反馈）：学习和抽查已是同一个流程（认→拼→巩固），
   * 简报里不得再把"抽查"说成学完之后要去做的另一件事（"还没抽查，去抽查一下"
   * 听着像还有第二项作业）。统一叫"练"，抽查只是练习里的拼写环节。 */

  if (!learned && !quizTotal) {
    out.text = who + '今天还没有学习记录。';
    return out;
  }

  if (!quizTotal) {
    out.text = who + '今天练了 ' + learned + ' 个单词（认了一遍），还没走到拼写 —— 明天完整走一遍（认 + 拼），看看能不能真的写出来。';
    return out;
  }

  if (failed > 0) {
    out.text = who + '今天练了 ' + minutes + ' 分钟、' + learned + ' 个单词，抽查 ' + quizTotal +
      ' 题：' + mastered + ' 个掌握、' + failed + ' 个没记住，明天继续循环。';
    return out;
  }

  // 全对：给荣誉词（学生端与教练端显示同一句，双方都有）
  if (forgotToday === 0) {
    out.honor = {
      badge: '🏅 今日全掌握',
      title: '今日全掌握',
      detail: '抽查 ' + quizTotal + ' 题全对，' + learned + ' 个词一个都没忘。'
    };
    out.text = who + '今天练了 ' + minutes + ' 分钟、' + learned + ' 个单词，抽查全对 —— 全部掌握 🎉 明天再循环巩固一次就稳了。';
  } else {
    // 抽查全对，但学习页今天还评价过"忘了"：不许发满分奖，如实说
    out.text = who + '今天练了 ' + minutes + ' 分钟、' + learned + ' 个单词，抽查 ' + quizTotal +
      ' 题全对，但今天还有 ' + forgotToday + ' 次"忘了"，这几个词明天要重点过。';
  }
  return out;
}

module.exports = { learnSummary: learnSummary };
