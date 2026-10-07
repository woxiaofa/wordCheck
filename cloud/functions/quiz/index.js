/**
 * 云函数：quiz —— 出题与交卷判分
 *
 * 这个文件承担整个产品最关键的一条约束：
 *   **答案绝不下发给客户端。**
 * 出题只返回题目；用户作答后提交，由服务端判分。
 * 否则用户抓一次返回包就能全对，"抽查"这个产品就不存在了。
 *
 * 同时演示与 review 云函数一致的另外三条约定：幂等提交、UTC+8 时区、错词走共享的 SRS 规则。
 *
 * 部署提醒：需要和 review 一样带上 shared/ 的副本（quiz.js / srs.js / time.js）。
 * 日常请用 node scripts/sync-shared.js 同步，别手改副本。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const quizLib = require('./quiz');
const srs = require('./srs');
const { getLocalDate } = require('./time');
const {
  upsertState, queryStates, STATE_COLL
} = require('./state-store');

const COLL = {
  words: 'words',
  state: STATE_COLL,           // v5：读写都走新集合（无唯一索引）
  sessions: 'quiz_sessions',
  items: 'quiz_items',
  dedup: 'request_dedup',
  users: 'users'
};

const MAX_COUNT = 20;
const POOL_LIMIT = 300;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('NO_IDENTITY', '无法识别用户身份');

  switch (event.action) {
    case 'generate': return onGenerate(OPENID, event);
    case 'submit': return onSubmit(OPENID, event);
    case 'listen': return onListen(OPENID, event);
    default: return fail('BAD_ACTION', '未知 action: ' + event.action);
  }
};

/* ------------------------------------------------------------------ */
/* 出题                                                                */
/* ------------------------------------------------------------------ */

async function onGenerate(openid, { count }) {
  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先调用 user.login');

  const n = Math.min(Math.max(Number(count) || quizLib.DEFAULT_COUNT, 1), MAX_COUNT);

  const words = await buildWordPool(user._id);
  if (words.length < 4) {
    // 干扰项需要至少 1 个其它词，少于 4 个词时选义题意义不大，直接返回让客户端走本地兜底
    return fail('POOL_TOO_SMALL', '可用词库过小，无法组卷');
  }

  // 选题：错词 > 到期 > 其它（抽查的价值就在于查没记住的）
  const ordered = orderForQuiz(words);
  const picked = takeUnique(ordered, n);

  const plan = quizLib.planTypes(n);
  const questions = plan.map((type, i) => {
    const w = picked[i % picked.length];
    const q = quizLib.buildQuestion(type, w, words);
    // 双保险：即便 buildQuestion 将来被改动，这里也只挑白名单字段下发
    return {
      wordId: q.wordId,
      type: q.type,
      stem: q.stem,
      phonetic: q.phonetic,
      pos: q.pos,
      length: q.length,
      options: q.options            // 选义题才有
    };
  });

  return ok({ questions, serverGraded: true });
}

/** 组卷词池：优先该用户学过的词，不足再补其它公开词 */
async function buildWordPool(userId) {
  const pool = [];
  const seen = {};

  const push = (w) => {
    if (!w || !w.word || seen[w.word]) return;
    seen[w.word] = 1;
    pool.push(w);
  };

  // 1) 用户学过的词（带上 SRS 状态，供选题排序用；v2+legacy 合并读）
  const stRows = await queryStates(
    db, { user_id: userId },
    { orderBy: { name: 'next_review_at', dir: 'asc' }, limit: POOL_LIMIT }
  );

  const ids = stRows.map((s) => s.word_id);
  if (ids.length) {
    // 云数据库单次 in 查询有上限，分批取
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const wRes = await db.collection(COLL.words)
        .where({ word: _.in(chunk) })
        .limit(50)
        .get()
        .catch(() => ({ data: [] }));
      (wRes.data || []).forEach((w) => {
        push(w);
        // 把 SRS 状态挂上，供排序使用（不进入下发给客户端的字段）
        const st = (stRes.data || []).find((s) => s.word_id === w.word);
        if (st) pool[pool.length - 1]._state = st;
      });
    }
  }

  // 2) 不足时补公开词（保证干扰项够用）
  if (pool.length < 40) {
    const fill = await db.collection(COLL.words)
      .orderBy('freq', 'asc')
      .limit(60)
      .get()
      .catch(() => ({ data: [] }));
    (fill.data || []).forEach((w) => push(w));
  }

  return pool;
}

/** 抽查选题顺序：错词 > 到期 > 其它 */
function orderForQuiz(words) {
  const now = Date.now();
  const wrong = [], due = [], rest = [];
  words.forEach((w) => {
    const st = w._state;
    if (!st) { rest.push(w); return; }
    if (st.wrong_count > 0 && st.last_feedback !== 'known') wrong.push(w);
    else if (st.next_review_at && st.next_review_at <= now) due.push(w);
    else rest.push(w);
  });
  return wrong.concat(due).concat(rest);
}

function takeUnique(arr, n) {
  const seen = {};
  const out = [];
  arr.forEach((x) => {
    if (out.length >= n) return;
    if (seen[x.word]) return;
    seen[x.word] = 1;
    out.push(x);
  });
  return out.length ? out : arr.slice(0, n);
}

/* ------------------------------------------------------------------ */
/* 交卷判分                                                            */
/* ------------------------------------------------------------------ */

async function onSubmit(openid, { answers, clientReqId, durationMs }) {
  if (!Array.isArray(answers) || !answers.length) return fail('BAD_PARAM', '缺少 answers');
  if (!clientReqId) return fail('BAD_PARAM', '缺少 clientReqId（幂等要求）');

  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在');

  // 幂等：同一请求只处理一次，重复提交回放上次结果
  const dedupId = user._id + ':' + clientReqId;
  const dup = await db.collection(COLL.dedup).where({ _id: dedupId }).limit(1).get()
    .catch(() => ({ data: [] }));
  if (dup.data && dup.data.length) return ok(Object.assign({ replay: true }, dup.data[0].result));

  // 取答案：只查本次涉及的词
  const wordIds = answers.map((a) => a.wordId).filter(Boolean);
  const wordMap = await loadWords(wordIds);

  const now = Date.now();
  const today = getLocalDate(now);
  const details = [];
  let correct = 0;

  for (const a of answers) {
    const w = wordMap[a.wordId];
    if (!w) {
      details.push({ wordId: a.wordId, type: a.type, isCorrect: false, reason: 'WORD_NOT_FOUND' });
      continue;
    }

    let isCorrect = false;
    let correctAnswer = '';

    if (a.type === 'meaning') {
      correctAnswer = w.def_cn;
      // 选义题的作答一定是字符串；这里显式兜一下，避免客户端误传数组时被转成奇怪的值
      const choice = Array.isArray(a.answer) ? a.answer.join('') : a.answer;
      isCorrect = quizLib.isMeaningCorrect(choice, w.def_cn);
    } else if (a.type === 'spell' || a.type === 'listen') {
      correctAnswer = w.word;
      isCorrect = quizLib.isSpellingCorrect(a.answer, w.word, w.variant);
    } else {
      return fail('BAD_PARAM', '未知题型：' + a.type);
    }

    if (isCorrect) correct++;
    else {
      // 错词重置档位：复用与学习页完全相同的规则（只有一份实现）
      await applyForgot(user._id, w.word, now, a.type);
    }

    details.push({
      wordId: a.wordId,
      type: a.type,
      isCorrect,
      correctAnswer,
      userAnswer: a.answer
    });

    await db.collection(COLL.items).add({
      data: {
        user_id: user._id,
        word_id: a.wordId,
        question_type: a.type,
        user_answer: a.answer === undefined ? '' : String(a.answer),
        correct_answer: correctAnswer,
        is_correct: isCorrect,
        quiz_date: today,
        created_at: now
      }
    }).catch(() => {});
  }

  const result = {
    total: answers.length,
    correct,
    details,
    finishedAt: now
  };

  await db.collection(COLL.sessions).add({
    data: {
      user_id: user._id,
      source: 'quiz',
      total: answers.length,
      correct,
      duration_ms: Math.max(0, Number(durationMs) || 0),
      quiz_date: today,
      created_at: now
    }
  }).catch(() => {});

  await db.collection(COLL.dedup).add({
    data: {
      _id: dedupId,
      user_id: user._id,
      action: 'quiz.submit',
      result,
      expire_at: now + srs.REQ_ID_TTL_DAYS * 24 * 3600 * 1000,
      created_at: now
    }
  }).catch(() => {});

  return ok(Object.assign({ replay: false }, result));
}

async function loadWords(wordIds) {
  const map = {};
  const uniq = wordIds.filter((v, i, arr) => arr.indexOf(v) === i);
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const res = await db.collection(COLL.words)
      .where({ word: _.in(chunk) })
      .limit(50)
      .get()
      .catch(() => ({ data: [] }));
    (res.data || []).forEach((w) => { map[w.word] = w; });
  }
  return map;
}

/** 按"没想起来"重置该词状态（与 review 云函数的规则一致） */
async function applyForgot(userId, wordId, now, questionType) {
  const rows = await queryStates(db, { user_id: userId, word_id: wordId }, { limit: 1 });
  const prev = rows[0] || null;
  const next = srs.nextState(prev, 'forgot', now);

  const doc = {
    stage: next.stage,
    last_feedback: next.lastFeedback,
    next_review_at: next.nextReviewAt,
    wrong_count: (prev ? prev.wrong_count : 0) + 1,
    last_wrong_type: questionType || 'quiz',
    updated_at: now
  };

  // 一律 upsert（同 review：prev 可能来自 legacy，其 _id 在 v2 上不存在，
  // 对它 update 会静默 updated:0 假成功 —— 统一走确定性 _id 的全量 set）
  const errCode = await upsertState(db, userId, wordId, doc, now).catch((e) => {
    console.error('[quiz] 错词状态写入异常:', e && e.errMsg);
    return 'STATE_STORE_ERROR';
  });
  if (errCode) console.error('[quiz] 错词状态未能写入（不影响交卷判分）:', wordId, errCode);
}

/* ------------------------------------------------------------------ */
/* 听写发音                                                            */
/* ------------------------------------------------------------------ */

/**
 * 返回发音音频地址。
 *
 * 刻意不在这里拼第三方 TTS 链接：小程序对 request 域名有白名单要求，
 * 外部链接随时失效，写死会在真机上表现为"点了没声音"。
 * 正式做法：预生成音频放云存储，这里返回 fileID。
 * 配置好音频后，把 audio_file_id 字段填上即可。
 */
async function onListen(openid, { word }) {
  if (!word) return fail('BAD_PARAM', '缺少 word');
  const res = await db.collection(COLL.words).where({ word }).limit(1).get()
    .catch(() => ({ data: [] }));
  const w = res.data && res.data[0];
  if (!w) return fail('WORD_NOT_FOUND', '词库中没有这个单词');

  return ok({
    wordId: w.word,
    // 云端存有音频时用 fileID；为空则由客户端提示"未配置发音源"
    audioFileId: w.audio_file_id || '',
    phonetic: w.phonetic || ''
  });
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

async function getUser(openid) {
  const r = await db.collection(COLL.users).where({ openid }).limit(1).get()
    .catch(() => ({ data: [] }));
  return r.data && r.data[0] ? r.data[0] : null;
}

const VERSION = 'quiz-20261007-v2coll';
const ok = (data) => ({ ok: true, _v: VERSION, data });
const fail = (code, message) => ({ ok: false, _v: VERSION, code, message });
