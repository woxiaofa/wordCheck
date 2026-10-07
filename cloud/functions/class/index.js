/**
 * 云函数：class —— 家长/老师端（教练端）
 *
 * 职责：建班级、邀请码加入、布置任务、看学员进度、生成催学文案。
 * 硬约定（实施手册第五章）：
 *   1) 身份只认 OPENID；coach 身份以 classes.owner_id 为准，不信客户端
 *   2) assign 走 client_req_id 幂等，重试不产生重复作业
 *   3) 催学只生成文本由家长自己发微信，不做任何推送（合规红线）
 *   4) 学员进度从 user_word_state 现算（班级规模小，不值得为它维护冗余集合）
 *
 * 部署前置：本目录需含平铺的共享模块副本（scripts/prepare-functions.js 生成，勿用子目录：CLI 部署后云端会丢）；
 *           控制台需建 classes 集合 + 唯一索引 {code:1}、assignments 索引
 *           {class_id:1, created_at:-1}、users 索引 {class_id:1}。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { getLocalDate, getLocalDayStart } = require('./time');
const { queryStates, STATE_COLL, ensureCollection } = require('./state-store');

const COLL = {
  users: 'users',
  classes: 'classes',
  assignments: 'assignments',
  /** 个性化作业的学员词单快照：{assignment_id, user_id, word_ids} */
  asgStudents: 'assignment_students',
  state: STATE_COLL,           // v5：读走合并查询（v2+legacy），写不经本函数
  requests: 'request_dedup',
  logs: 'review_logs'
};

const LIMITS = {
  NAME_MAX: 20,
  CODE_LEN: 6,
  CODE_ALPHABET: '23456789ABCDEFGHJKMNPQRSTUVWXYZ', // 去掉易混的 0O1IL
  CLASS_SIZE_MAX: 50,
  ASSIGN_COUNT_MIN: 3,
  ASSIGN_COUNT_MAX: 30,
  NOTE_MAX: 60,
  WORDS_FETCH_MAX: 50,         // 选词时最多拉取的候选数（freq 升序）
  /** 个性化作业时，候选池 = 词数 × 该倍数（给"跳过已掌握"留出挑选空间） */
  PERSONAL_POOL_FACTOR: 3
};

// 邀请码 → 班级 文档的缓存有效期（沿用 request_dedup 的清理思路，靠 TTL 惰性过期）
const REQ_TTL_MS = 2 * 86400000;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('NO_IDENTITY', '无法识别用户身份');

  switch (event.action) {
    case 'createClass':   return onCreateClass(OPENID, event);
    case 'joinClass':     return onJoinClass(OPENID, event);
    case 'leaveClass':    return onLeaveClass(OPENID);
    case 'myClass':       return onMyClass(OPENID);
    case 'assign':        return onAssign(OPENID, event);
    case 'assignments':   return onAssignments(OPENID);
    case 'myAssignments': return onMyAssignments(OPENID);
    case 'students':      return onStudents(OPENID);
    case 'studentDetail': return onStudentDetail(OPENID, event);
    case 'nudge':         return onNudge(OPENID, event);
    case 'summary':       return onSummary(OPENID, event);
    default:              return fail('BAD_ACTION', '未知 action: ' + event.action);
  }
};

/* ------------------------------------------------------------------ */
/* 建班级（家长/老师端入口）                                             */
/* ------------------------------------------------------------------ */
async function onCreateClass(openid, { name, clientReqId }) {
  if (!clientReqId) return fail('BAD_PARAM', '缺少 clientReqId（幂等要求）');
  name = typeof name === 'string' ? name.trim().slice(0, LIMITS.NAME_MAX) : '';
  if (!name) return fail('BAD_PARAM', '班级名称不能为空');

  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先 login');

  // 已是教练的不能再建（一个微信号管一个班，MVP 先立这条规矩）
  const owned = await findOwnedClass(user._id);
  if (owned) return ok({ class: publicClass(owned), created: false });

  // 邀请码撞码重试（6 位 30^6 ≈ 7 亿，实际一次就中）
  let cls = null;
  for (let i = 0; i < 5 && !cls; i++) {
    const code = genCode();
    const dup = await db.collection(COLL.classes).where({ code }).limit(1).get();
    if (dup.data && dup.data[0]) continue;
    const addRes = await db.collection(COLL.classes).add({
      data: {
        name,
        code,
        owner_id: user._id,
        student_ids: [],
        created_at: Date.now()
      }
    });
    cls = { _id: addRes._id, name, code, owner_id: user._id, student_ids: [] };
  }
  if (!cls) return fail('CODE_GEN_FAIL', '邀请码生成失败，请重试');

  await db.collection(COLL.users).doc(user._id)
    .update({ data: { role: 'coach', class_id: cls._id } });

  return ok({ class: publicClass(cls), created: true });
}

/* ------------------------------------------------------------------ */
/* 邀请码加入班级（学生端）                                              */
/* ------------------------------------------------------------------ */
async function onJoinClass(openid, { code }) {
  code = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (code.length !== LIMITS.CODE_LEN) return fail('BAD_PARAM', '邀请码格式不正确');

  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先 login');

  if (user.role === 'coach') return fail('ROLE_CONFLICT', '你是班级创建者，不能以学生身份加入其他班级');

  const found = await db.collection(COLL.classes).where({ code }).limit(1).get();
  const cls = found.data && found.data[0];
  if (!cls) return fail('CLASS_NOT_FOUND', '邀请码无效，请核对后重试');

  if (cls.owner_id === user._id) return fail('ROLE_CONFLICT', '这是你自己创建的班级');

  if (user.class_id === cls._id) return ok({ class: publicClass(cls), joined: false });

  const ids = Array.isArray(cls.student_ids) ? cls.student_ids : [];
  if (ids.length >= LIMITS.CLASS_SIZE_MAX) return fail('CLASS_FULL', '该班级人数已满');

  if (!ids.includes(user._id)) {
    await db.collection(COLL.classes).doc(cls._id)
      .update({ data: { student_ids: _.push(user._id) } }).catch(async () => {
        // student_ids 字段缺失（老数据）时整体写入
        await db.collection(COLL.classes).doc(cls._id)
          .update({ data: { student_ids: ids.concat(user._id) } });
      });
  }
  await db.collection(COLL.users).doc(user._id)
    .update({ data: { class_id: cls._id } });

  return ok({ class: publicClass(cls), joined: true });
}

/* ------------------------------------------------------------------ */
/* 学生退出班级（换班用；教练不能退出自己建的班）                          */
/* ------------------------------------------------------------------ */
async function onLeaveClass(openid) {
  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先 login');
  if (!user.class_id) return ok({ left: false });
  if (user.role === 'coach') return fail('ROLE_CONFLICT', '创建者不能退出班级，如需删除班级请联系开发者');

  await db.collection(COLL.classes).doc(user.class_id)
    .update({ data: { student_ids: _.pull(user._id) } }).catch(() => {});
  await db.collection(COLL.users).doc(user._id)
    .update({ data: { class_id: '' } });

  return ok({ left: true });
}

/* ------------------------------------------------------------------ */
/* 查我所在的班级（学生/教练通用）                                        */
/* ------------------------------------------------------------------ */
async function onMyClass(openid) {
  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先 login');
  if (!user.class_id) return ok({ class: null });

  const r = await db.collection(COLL.classes).doc(user.class_id).get().catch(() => null);
  if (!r || !r.data) return ok({ class: null });   // 班级被删了，视为无班级

  const cls = r.data;
  const isOwner = cls.owner_id === user._id;
  return ok({
    class: publicClass(cls),
    role: isOwner ? 'coach' : 'student',
    student_count: isOwner ? (cls.student_ids || []).length : undefined
  });
}

/* ------------------------------------------------------------------ */
/* 布置任务（教练端）                                                    */
/* ------------------------------------------------------------------ */
async function onAssign(openid, { tag, count, deadline, note, clientReqId, personalized }) {
  if (!clientReqId) return fail('BAD_PARAM', '缺少 clientReqId（幂等要求）');

  const ctx = await requireCoach(openid);
  if (ctx.err) return ctx.err;

  // --- 入参校验 ---
  const VALID_TAGS = ['全部', '中考', '高考', '四级'];
  if (!VALID_TAGS.includes(tag)) return fail('BAD_PARAM', '词库标签无效');
  count = parseInt(count, 10);
  if (!(count >= LIMITS.ASSIGN_COUNT_MIN && count <= LIMITS.ASSIGN_COUNT_MAX)) {
    return fail('BAD_PARAM', '词数需在 ' + LIMITS.ASSIGN_COUNT_MIN + '~' + LIMITS.ASSIGN_COUNT_MAX + ' 之间');
  }
  if (deadline !== undefined && deadline !== null && deadline !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return fail('BAD_PARAM', '截止日期格式应为 YYYY-MM-DD');
    if (deadline < getLocalDate()) return fail('BAD_PARAM', '截止日期不能早于今天');
  } else {
    deadline = '';
  }
  note = typeof note === 'string' ? note.trim().slice(0, LIMITS.NOTE_MAX) : '';

  const now = Date.now();
  const personal = personalized === true;

  // 作业名：备注优先；没写备注就自动按"日期 时间·词库"命名。
  // 此前所有作业都叫"全部作业"，两份并排完全同名，家长分不清哪份是哪份（2026-10-07 反馈）。
  const name = note || autoAssignName(tag, now, personal);

  // --- 幂等闸 ---
  const dup = await db.collection(COLL.requests)
    .where({ _id: ctx.user._id + ':assign:' + clientReqId }).limit(1).get()
    .catch(() => ({ data: [] }));
  if (dup.data && dup.data[0]) {
    const prev = await db.collection(COLL.assignments).doc(dup.data[0].ref).get().catch(() => null);
    if (prev && prev.data) return ok({ assignment: publicAssignment(prev.data), dedup: true });
  }

  // --- 选词：按词频升序取前 count 个（简单可解释，学生先学高频词）---
  // 个性化作业要多拉一些候选：好让"已掌握的词跳过、易错词补进来"有挑选余地
  const fetchMax = personal
    ? Math.min(LIMITS.WORDS_FETCH_MAX, count * LIMITS.PERSONAL_POOL_FACTOR)
    : Math.min(LIMITS.WORDS_FETCH_MAX, count);
  const wordsRes = await db.collection('words')
    .where(tag === '全部' ? {} : { tags: tag })
    .orderBy('freq', 'asc')
    .limit(fetchMax)
    .get();
  // 关键：存 word 文本而非 _id —— user_word_state.word_id / task snapshot /
  // 客户端本地词库匹配全都用文本，进度查询与"继续学"队列才能对上
  const poolTexts = (wordsRes.data || []).map(w => w.word).slice(0, fetchMax);
  const wordIds = poolTexts.slice(0, count);   // 基础词单（全班默认 / 教师端展示用）
  if (wordIds.length < LIMITS.ASSIGN_COUNT_MIN) {
    return fail('WORDS_EMPTY', '该词库暂无可布置的单词');
  }

  const addRes = await db.collection(COLL.assignments).add({
    data: {
      class_id: ctx.cls._id,
      tag,
      name,
      word_ids: wordIds,
      count: wordIds.length,
      deadline,
      note,
      personalized: personal,
      // 个性化取词范围：只有个性化作业才存，非个性化保持老结构不变
      pool_ids: personal ? poolTexts : [],
      created_by: ctx.user._id,
      created_at: now
    }
  });

  // 记录幂等映射（含引用，重复请求直接返回同一份作业）
  // ⚠ 必须 data 包裹：cloud-review 的假库忠实复刻云端后立刻抓到过同类 bug ——
  // 写成 add({_id,...}) 云端直接抛错，被下面的 catch 静默吞掉，
  // 结果幂等映射从来没落过库，"重复点击布置"就会真的布置出两份作业。
  await db.collection(COLL.requests).add({
    data: {
      _id: ctx.user._id + ':assign:' + clientReqId,
      ref: addRes._id,
      created_at: now,
      expire_at: now + REQ_TTL_MS
    }
  }).catch((e) => {
    console.error('[class] 幂等映射写入失败（重复点击可能布置出两份作业）:',
      String((e && (e.errMsg || e.message)) || e).slice(0, 120));
  });

  const created = await db.collection(COLL.assignments).doc(addRes._id).get();

  // 个性化作业：当场给每位在班学员固化专属词单（后加入的学员首次打开时再生成）
  if (personal) {
    const sids = ctx.cls.student_ids || [];
    for (const sid of sids) {
      await wordsForStudent(created.data, sid).catch(() => {});
    }
  }

  return ok({
    assignment: publicAssignment(created.data),
    dedup: false,
    personalized: personal,
    student_count: personal ? (ctx.cls.student_ids || []).length : 0
  });
}

/* ------------------------------------------------------------------ */
/* 教练端：作业列表（带全班进度）                                         */
/* ------------------------------------------------------------------ */
async function onAssignments(openid) {
  const ctx = await requireCoach(openid);
  if (ctx.err) return ctx.err;

  const list = await db.collection(COLL.assignments)
    .where({ class_id: ctx.cls._id })
    .orderBy('created_at', 'desc')
    .limit(20)
    .get();
  const assignments = list.data || [];
  if (!assignments.length) return ok({ assignments: [] });

  const studentIds = ctx.cls.student_ids || [];
  const withProgress = [];
  for (const a of assignments) {
    const per = await progressForAssignment(a, studentIds);
    withProgress.push(Object.assign(publicAssignment(a), {
      finished: per.filter(p => p.count > 0 && p.done >= p.count).length,
      total_students: studentIds.length,
      per_student: per
    }));
  }
  return ok({ assignments: withProgress });
}

/* ------------------------------------------------------------------ */
/* 学生端：我班级的作业 + 我的进度                                        */
/* ------------------------------------------------------------------ */
async function onMyAssignments(openid) {
  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先 login');
  if (!user.class_id) return ok({ assignments: [], role: user.role || '' });

  const clsRes0 = await db.collection(COLL.classes).doc(user.class_id).get().catch(() => null);
  const cls0 = clsRes0 && clsRes0.data ? clsRes0.data : null;
  const isOwner = !!(cls0 && cls0.owner_id === user._id);

  /* 身份闸门：作业是布置给学生的，不是给布置者的。
   * 内测实锤：家长（班级 owner）自己也有 class_id，于是首页把《hhh》当成"我的作业"
   * 弹出来，家长一脸问号。教练要看的是学员进度（走 progressByStudent），
   * 不是自己去做 10 个词 —— 这里直接不给作业，同时把身份回给前端。 */
  if (user.role === 'coach' || isOwner) {
    return ok({
      assignments: [],
      role: 'coach',
      reason: 'COACH_NO_TASK',
      class: cls0 ? publicClass(cls0) : null
    });
  }

  const list = await db.collection(COLL.assignments)
    .where({ class_id: user.class_id })
    .orderBy('created_at', 'desc')
    .limit(20)
    .get();
  const assignments = list.data || [];
  if (!assignments.length) {
    // 自诊断：学生说"看不到作业"时，先分清"老师真没布置"还是"加错了班"。
    // 若老师名下（created_by）存在任何作业、却不挂在本班 → 大概率存在同名班级，
    // 学生凭旧码/记错的码进了另一个班。给前端明确 hint，别只回空数组。
    const ownerId = cls0 ? cls0.owner_id : '';
    if (ownerId) {
      const any = await db.collection(COLL.assignments)
        .where({ created_by: ownerId }).limit(1).get().catch(() => null);
      if (any && any.data && any.data.length) {
        return ok({ assignments: [], role: 'student', hint: 'TEACHER_HAS_OTHER_CLASS' });
      }
    }
    return ok({ assignments: [], role: 'student' });
  }

  // 词单先归一成文本（兼容旧 _id 格式）；个性化作业换成"我的专属词单"
  for (const a of assignments) {
    a.word_ids = await wordsForStudent(a, user._id);
  }

  const wordAll = [];
  assignments.forEach(a => (a.word_ids || []).forEach(w => wordAll.push(w)));

  // 我对这些词的学习情况（v2+legacy 合并读，v2 优先）
  const stateRows = wordAll.length
    ? await queryStates(db, { user_id: user._id, word_id: _.in(wordAll) })
    : [];
  const stateMap = {};
  stateRows.forEach(s => { stateMap[s.word_id] = s; });

  const today = getLocalDate();
  const result = assignments.map(a => {
    let done = 0;
    const words = (a.word_ids || []).map(id => {
      const s = stateMap[id];
      // 完成定义 = 学过即算（有学习记录就算），与教练端 progressByStudent 同口径。
      // 旧口径（correct_count>0 || stage>0）会把选了"模糊"的孩子判成 0 —— 已实锤踩坑。
      const learned = !!s;
      if (learned) done++;
      return { word_id: id, learned };
    });
    return Object.assign(publicAssignment(a), {
      done,
      words,
      expired: !!(a.deadline && a.deadline < today)
    });
  });
  return ok({ assignments: result, role: 'student' });
}

/* ------------------------------------------------------------------ */
/* 教练端：学员列表                                                      */
/* ------------------------------------------------------------------ */
async function onStudents(openid) {
  const ctx = await requireCoach(openid);
  if (ctx.err) return ctx.err;

  const ids = ctx.cls.student_ids || [];
  if (!ids.length) return ok({ students: [] });

  // 逐条取：云开发里 where({_id: _.in(ids)}) 的行为在部分版本上不稳定，
  // 班级规模上限 50，直接按 id 取更可靠，也顺带跳过已被删除的学员
  const docs = await Promise.all(ids.map(id =>
    db.collection(COLL.users).doc(id).get().then(r => r.data).catch(() => null)
  ));
  // 家长最关心的不是"累计学了多少"，而是"今天学没学、学得怎么样、哪些词老错"。
  // 这里一次批量把三份数据取齐（班级上限 50，两次查询足够）：
  //   a) 今日学习明细（review_logs，按 user_id+created_at 索引）
  //   b) 累计掌握 / 易错词（user_word_state）
  //   c) 是否同步过（有日志 = 数据到过云端；否则卡片要显示"还没同步"而不是"0 词"，
  //      否则家长分不清"孩子没学"和"数据丢了"）
  const dayStart = getLocalDayStart(Date.now());

  const todayRes = await db.collection(COLL.logs)
    .where({ user_id: _.in(ids), created_at: _.gte(dayStart) })
    .limit(1000)
    .field({ user_id: true, feedback: true })
    .get().catch(() => ({ data: [] }));
  const todayMap = {};
  (todayRes.data || []).forEach((l) => {
    const m = todayMap[l.user_id] || (todayMap[l.user_id] = { count: 0, known: 0, forgot: 0 });
    m.count++;
    if (l.feedback === 'known') m.known++;
    else if (l.feedback === 'forgot') m.forgot++;
  });

  const stRows = ids.length
    ? await queryStates(
        db, { user_id: _.in(ids) },
        { field: { user_id: true, stage: true, correct_count: true, wrong_count: true } }
      )
    : [];
  const statMap = {};
  stRows.forEach((s) => {
    const m = statMap[s.user_id] || (statMap[s.user_id] = { learned: 0, wrong: 0, rated: 0 });
    // 完成定义 = 学过即算，与 stats_cache.learned_words / 作业完成度同口径。
    // 旧口径（correct_count>0 || stage>0）会让学员卡显示"累计 3 词"、
    // 催学文案却说"累计 10 词" —— 同一个孩子两个数字，家长只会觉得数据坏了。
    m.learned++;
    if ((s.wrong_count || 0) > 0) m.wrong++;
    m.rated++;
  });

  // 是否同步过：查一次该班任意一条历史日志即可（不下发明细）
  const syncRes = await db.collection(COLL.logs)
    .where({ user_id: _.in(ids) })
    .limit(1000)
    .field({ user_id: true })
    .get().catch(() => ({ data: [] }));
  const syncedSet = {};
  (syncRes.data || []).forEach((l) => { syncedSet[l.user_id] = true; });

  const students = docs.filter(Boolean).map((u) => {
    const today = todayMap[u._id] || { count: 0, known: 0, forgot: 0 };
    const st = statMap[u._id] || { learned: 0, wrong: 0, rated: 0 };
    return {
      id: u._id,
      nickname: u.nickname || '',
      avatar: u.avatar || '',
      stats: u.stats_cache || { total_words: 0, learned_words: 0, streak_days: 0 },
      today: today,
      // 今日掌握率：会 / 全部评过分（没评分时为 null，前端显示"—"而不是 0%）
      todayRate: today.count ? Math.round((today.known / today.count) * 100) : null,
      learned: st.learned,
      wrong: st.wrong,
      synced: !!syncedSet[u._id],
      last_seen_at: u.last_seen_at || 0
    };
  });
  return ok({ students });
}

/* ------------------------------------------------------------------ */
/* 教练端：单个学员详情（学习记录 + 各作业完成度）                          */
/* ------------------------------------------------------------------ */
async function onStudentDetail(openid, { studentId }) {
  const ctx = await requireCoach(openid);
  if (ctx.err) return ctx.err;

  const ids = ctx.cls.student_ids || [];
  if (!ids.includes(studentId)) return fail('FORBIDDEN', '该学生不在你的班级');

  const uRes = await db.collection(COLL.users).doc(studentId).get().catch(() => null);
  if (!uRes || !uRes.data) return fail('NOT_FOUND', '学生不存在');

  const logRes = await db.collection('review_logs')
    .where({ user_id: studentId })
    .orderBy('created_at', 'desc')
    .limit(30)
    .get();

  // 把 word_id 翻译成人能读的"单词 + 释义"（word_id 存的是词文本，
  // 这里同时按 _id 兜底查一遍，两种主键方案都兼容）
  const logs0 = logRes.data || [];
  const uniqIds = [];
  logs0.forEach((l) => {
    if (l.word_id && uniqIds.indexOf(l.word_id) === -1) uniqIds.push(l.word_id);
  });
  const wordMap = {};
  const wordFields = { word: true, translation: true };
  for (const key of ['word', '_id']) {
    if (!uniqIds.length) break;
    const q = key === 'word' ? { word: _.in(uniqIds) } : { _id: _.in(uniqIds) };
    const wr = await db.collection('words').where(q).limit(100).field(wordFields)
      .get().catch(() => ({ data: [] }));
    (wr.data || []).forEach((w) => {
      if (w.word) wordMap[w.word] = { text: w.word, trans: w.translation || '' };
      if (w._id) wordMap[w._id] = { text: w.word || w._id, trans: w.translation || '' };
    });
  }

  const assignments = await db.collection(COLL.assignments)
    .where({ class_id: ctx.cls._id })
    .orderBy('created_at', 'desc')
    .limit(20)
    .get();
  const withProgress = [];
  for (const a of (assignments.data || [])) {
    const texts = await wordsForStudent(a, studentId);
    const per = await progressByStudent([studentId], texts);
    withProgress.push(Object.assign(publicAssignment(a), {
      done: per.length ? per[0].done : 0,
      // 个性化作业下每个孩子的总数可能不同（已掌握的词被跳过），以他的为准
      count: texts.length || a.count,
      personalized: !!a.personalized
    }));
  }

  // 学习简报：与学员端同一句文案、同一份荣誉词（shared/summary 是唯一真相）
  const summary = await summaryLib.learnSummary(
    db, studentId, uRes.data.nickname || '同学', getLocalDate(Date.now())
  );

  return ok({
    student: {
      id: uRes.data._id,
      nickname: uRes.data.nickname || '',
      avatar: uRes.data.avatar || '',
      stats: uRes.data.stats_cache || {},
      last_seen_at: uRes.data.last_seen_at || 0
    },
    summary: summary,
    recent_logs: logs0.map(l => ({
      word_id: l.word_id,
      word_text: (wordMap[l.word_id] || {}).text || l.word_id,
      translation: (wordMap[l.word_id] || {}).trans || '',
      feedback: l.feedback,
      mode: l.mode,
      created_at: l.created_at
    })),
    assignments: withProgress
  });
}

/* ------------------------------------------------------------------ */
/* 催学：只生成文案，不做推送（家长复制后自己去发微信）                      */
/* ------------------------------------------------------------------ */
async function onNudge(openid, { studentId }) {
  const ctx = await requireCoach(openid);
  if (ctx.err) return ctx.err;

  const ids = ctx.cls.student_ids || [];
  if (!ids.includes(studentId)) return fail('FORBIDDEN', '该学生不在你的班级');

  const uRes = await db.collection(COLL.users).doc(studentId).get().catch(() => null);
  if (!uRes || !uRes.data) return fail('NOT_FOUND', '学生不存在');
  const stu = uRes.data;

  const assignments = await db.collection(COLL.assignments)
    .where({ class_id: ctx.cls._id })
    .orderBy('created_at', 'desc')
    .limit(5)
    .get();
  let assignLeft = null;   // { name, left, done, count, wordIds, deadline }
  for (const a of (assignments.data || [])) {
    const texts = await wordsForStudent(a, studentId);
    const per = await progressByStudent([studentId], texts);
    const done = per.length ? per[0].done : 0;
    const total = texts.length || a.count;
    const left = total - done;
    if (left > 0) {
      assignLeft = {
        name: a.name || a.note || a.tag + '作业',
        left: left,
        done: done,
        count: total,
        wordIds: texts,
        deadline: a.deadline || ''
      };
      break;
    }
  }

  const stats = stu.stats_cache || {};
  const seenAgo = stu.last_seen_at ? fmtAgo(Date.now() - stu.last_seen_at) : '还没来过';
  const seenRecent = stu.last_seen_at && (Date.now() - stu.last_seen_at < 12 * 3600000);

  // 今天的练习量直接数 review_logs（写入即有的真值）。
  // stats_cache 是冗余统计，可能滞后 —— 曾经出现过"孩子 28 分钟前活跃、
  // 文案却说一个没学"的自相矛盾，家长会觉得数据是假的。
  const today = getLocalDate(Date.now());
  const todayRes = await db.collection(COLL.logs)
    .where({ user_id: studentId, review_date: today })
    .limit(200)
    .field({ word_id: true })
    .get()
    .catch(() => ({ data: [] }));
  const todayLogs = todayRes.data || [];
  const todayCount = todayLogs.length;

  // 文案铁律：一段话里只讲一个故事。练了题 和 作业没动 两件事同时说，
  // 必须点明它们的关系，否则"练了 10 题还剩 10 个"家长只会觉得数字错了。
  const parts = [];
  parts.push('【' + ctx.cls.name + '】' + (stu.nickname || '同学'));
  if (assignLeft) {
    const tail = assignLeft.deadline ? '，' + assignLeft.deadline + ' 截止' : '';
    // 归因必须有据：先数今天练的词里有几个是作业词，再决定怎么说。
    // 实锤教训：孩子练的明明是作业词，文案却硬说"这些是每日任务的词，
    // 作业还没做"——家长拿它和作业进度一对照，只会认定数据是假的。
    let assignHits = 0;
    if (todayCount > 0 && assignLeft.wordIds.length) {
      const texts = await toWordTexts(assignLeft.wordIds);
      const asgSet = {};
      texts.forEach((w) => { asgSet[w] = 1; });
      todayLogs.forEach((l) => { if (asgSet[l.word_id]) assignHits++; });
    }
    if (todayCount > 0 && assignHits > 0) {
      parts.push('今天练了 ' + todayCount + ' 题，其中 ' + assignHits +
        ' 个就是作业《' + assignLeft.name + '》的词（已完成 ' + assignLeft.done + '/' +
        assignLeft.count + '）——首页点「继续学」把剩下的 ' + assignLeft.left +
        ' 个清完' + tail + '。');
    } else if (todayCount > 0) {
      parts.push('今天练了 ' + todayCount + ' 题是每日任务的词，作业《' + assignLeft.name +
        '》还没动——首页点「继续学」先做作业（还剩 ' + assignLeft.left + ' 个词' + tail + '）。');
    } else if (seenRecent) {
      parts.push('上次打开小程序是 ' + seenAgo + '，今天还没学。' +
        '作业《' + assignLeft.name + '》还剩 ' + assignLeft.left + ' 个词' + tail +
        '，打开首页点「继续学」就能接着做。');
      // 孩子的手机上有补传队列：云端写入失败的学习记录会在下次打开时自动重放。
      // 不写这条，家长看到"活跃了却 0 词"只会认定数据坏了。
      parts.push('（如果孩子说学了但这里没数字：记录还在孩子手机里排队，下次打开小程序会自动补上）');
    } else {
      parts.push('有一份作业《' + assignLeft.name + '》还剩 ' + assignLeft.left +
        ' 个词' + tail + '，打开首页点「继续学」就能开始。');
    }
  } else {
    // 没有未完成作业：讲每日任务的故事
    if (todayCount > 0) {
      parts.push('今天已经练了 ' + todayCount + ' 题' +
        (stats.learned_words > 0 ? '，累计 ' + stats.learned_words + ' 词' : '') +
        (stats.streak_days > 1 ? '，连续打卡 ' + stats.streak_days + ' 天' : '') + '，继续保持！');
    } else if (seenRecent) {
      parts.push('上次打开小程序是 ' + seenAgo + '，但今天还没开始学。花 5 分钟学第一课吧！');
      parts.push('（如果孩子说学了但这里没数字：记录还在孩子手机里排队，下次打开小程序会自动补上）');
    } else {
      parts.push('单词之旅还没有开始，今天花 5 分钟学第一课吧！');
    }
    parts.push('今天的任务：学 10 个新词 + 巩固到期复习，大约 3 分钟。');
  }
  parts.push('（上次活跃：' + seenAgo + '）');

  return ok({ text: parts.join('\n') });
}

/* ------------------------------------------------------------------ */
/* 学习简报：一句话讲清"学了多久、学了多少、抽查掌握几个、还要不要循环"      */
/* ------------------------------------------------------------------ */
async function onSummary(openid, { studentId }) {
  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先 login');

  const today = getLocalDate(Date.now());
  // 教练看学员（必须在本班）；学员看自己（学生端首页/班级页同一句文案）
  let target = user;
  if (studentId && studentId !== user._id) {
    const cls = await findOwnedClass(user._id);
    if (!cls) return fail('NOT_COACH', '仅班级创建者可查看学员简报');
    const ids = cls.student_ids || [];
    if (ids.indexOf(studentId) === -1) return fail('FORBIDDEN', '该学生不在你的班级');
    const uRes = await db.collection(COLL.users).doc(studentId).get().catch(() => null);
    if (!uRes || !uRes.data) return fail('NOT_FOUND', '学生不存在');
    target = uRes.data;
  }

  const summary = await summaryLib.learnSummary(
    db, target._id, target.nickname || '同学', today
  );
  // 两端同口径的凭证：谁看都应当拿到同一句话与同一份荣誉词
  return ok(Object.assign({ user_id: target._id, date: today, viewer: user.role || '' }, summary));
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
async function getUser(openid) {
  const r = await db.collection(COLL.users).where({ openid }).limit(1).get();
  return r.data && r.data[0] ? r.data[0] : null;
}

async function findOwnedClass(userId) {
  const r = await db.collection(COLL.classes).where({ owner_id: userId }).limit(1).get();
  return r.data && r.data[0] ? r.data[0] : null;
}

/** 教练校验 + 上下文。失败时返回 { err } */
async function requireCoach(openid) {
  const user = await getUser(openid);
  if (!user) return { err: fail('NO_USER', '用户不存在，请先 login') };
  if (user.role !== 'coach') return { err: fail('NOT_COACH', '仅班级创建者可执行此操作') };
  const cls = await findOwnedClass(user._id);
  if (!cls) return { err: fail('NO_CLASS', '你还没有创建班级') };
  return { user, cls };
}

/**
 * 按学生统计作业词的完成数。
 * 完成定义：user_word_state 里该词存在，且最近一次反馈不是 forgot
 * （学过即算；抽查答"忘了"的词不算，重学后自动回到完成。见 progressByStudent）。
 */
/**
 * 个性化取词与学员词单：规则只有一份真相（shared/personal.js），
 * class 与 task 共用，避免"作业说剩 3 个、今日任务塞另外 5 个"的接缝错位。
 */
const personal = require('./personal');
const summaryLib = require('./summary');
/** 适配成本函数的两参调用形态（共享模块需要显式传 db） */
const wordsForStudent = (a, userId) => personal.wordsForStudent(db, a, userId);

/** 一份作业的逐学员进度（各自词单、各自 count）。
 * 个性化作业必须让人看见"给谁、给了什么词"——否则家长开了个性化却
 * 只看到一个总进度条，根本无法确认两个孩子拿到的词单真的不同（2026-10-07 反馈）。 */
async function progressForAssignment(a, studentIds) {
  const out = [];
  const nickMap = await nicknameMap(studentIds);
  for (const sid of studentIds) {
    const texts = await wordsForStudent(a, sid);
    const per = await progressByStudent([sid], texts);
    const meta = a.personalized ? await personalMeta(a, sid) : null;
    out.push({
      user_id: sid,
      nickname: nickMap[sid] || '学员',
      done: per.length ? per[0].done : 0,
      forgot: per.length ? (per[0].forgot || 0) : 0,
      count: texts.length,
      // 词单预览：个性化时每人是自己的词，非个性化展示全班统一的头 3 个
      preview: texts.slice(0, 3).join('、'),
      wrong_top: meta ? meta.wrong_top : null,
      skipped_mastered: meta ? meta.skipped_mastered : null
    });
  }
  return out;
}

/** 用户 id → 昵称（催学文案与教练端展示都要人话，别甩一串 openid） */
async function nicknameMap(userIds) {
  const map = {};
  if (!userIds.length) return map;
  const res = await db.collection(COLL.users)
    .where({ _id: _.in(userIds) })
    .field({ nickname: true })
    .get().catch(() => ({ data: [] }));
  (res.data || []).forEach(u => { map[u._id] = u.nickname || ''; });
  return map;
}

/** 个性化词单快照的解释字段：错词几个、跳过已掌握几个（家长问"为什么是这些词"时有的答） */
async function personalMeta(a, userId) {
  const res = await db.collection(COLL.asgStudents).doc(a._id + ':' + userId)
    .get().catch(() => null);
  if (!res || !res.data) return null;
  return {
    wrong_top: res.data.wrong_top || 0,
    skipped_mastered: res.data.skipped_mastered || 0
  };
}

async function progressByStudent(studentIds, wordIds) {
  if (!studentIds.length || !wordIds || !wordIds.length) return [];
  // 词单兼容两种历史格式：words._id（初版实锤对不上学习状态表，进度恒 0）
  // 或 word 文本（与 user_word_state.word_id 一致的正确格式）。统一转成文本再查。
  const texts = await toWordTexts(wordIds);
  const rows = (studentIds.length && texts.length)
    ? await queryStates(db, { user_id: _.in(studentIds), word_id: _.in(texts) })
    : [];
  const map = {};
  rows.forEach(s => {
    // 完成定义 = 学过且最近一次反馈不是"忘了"。抽查答忘了（forgot）的词不计完成 ——
    // 否则"学了就算完成"，抽查暴露没记住的词反而把进度刷满，抽查等于白做（2026-10-07 实锤）。
    // 学过(known)/模糊(vague) 都算完成：不二次设卡，避免把认真学完但选"模糊"的孩子判成假 0。
    // 答忘的词重学（再点会了/抽查答对）后 last_feedback 变 known，自动回到"完成"。
    if (!map[s.user_id]) map[s.user_id] = { user_id: s.user_id, done: 0, forgot: 0 };
    if (s.last_feedback === 'forgot') map[s.user_id].forgot++;
    else map[s.user_id].done++;
  });
  return studentIds.map(id => map[id] || { user_id: id, done: 0, forgot: 0 });
}

/**
 * 作业词单 ID 归一：把可能存在的 words._id 翻译成 word 文本。
 * user_word_state.word_id 存的是文本（review/task 全链路如此），
 * 作业若存 _id 则永远查不到学习记录 —— 2026-10-06 截图实锤（作业恒 0/10）。
 * 新建作业已改为直接存文本，这里兜底翻译云上残留的旧格式作业。
 */
async function toWordTexts(ids) {
  if (!ids || !ids.length) return [];
  const res = await db.collection('words')
    .where({ _id: _.in(ids) })
    .limit(1000)
    .field({ word: true })
    .get()
    .catch(() => ({ data: [] }));
  if (!(res.data || []).length) return ids;   // 一个都没命中：说明本来就是文本
  const map = {};
  res.data.forEach(w => { map[w._id] = w.word; });
  return ids.map(id => map[id] || id);
}

function genCode() {
  let s = '';
  for (let i = 0; i < LIMITS.CODE_LEN; i++) {
    s += LIMITS.CODE_ALPHABET[Math.floor(Math.random() * LIMITS.CODE_ALPHABET.length)];
  }
  return s;
}

function fmtAgo(ms) {
  if (ms < 60000) return '1 分钟内';
  if (ms < 3600000) return Math.floor(ms / 60000) + ' 分钟前';
  if (ms < 86400000) return Math.floor(ms / 3600000) + ' 小时前';
  return Math.floor(ms / 86400000) + ' 天前';
}

function publicClass(c) {
  return {
    id: c._id,
    name: c.name,
    code: c.code,                 // 学生端输入邀请码用；教练本来就看得到
    created_at: c.created_at
  };
}

/** 作业下发字段：word_ids 明细只给学生端 myAssignments 用，教练列表不给 */
/** 作业自动命名：按 UTC+8 取"10月7日 12:10·全部·个性化"这样的名字，见名知时知范围 */
function autoAssignName(tag, nowMs, personal) {
  const d = new Date(nowMs + 8 * 3600 * 1000);          // UTC+8
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  const hh = ('0' + d.getUTCHours()).slice(-2);
  const mi = ('0' + d.getUTCMinutes()).slice(-2);
  return mm + '月' + dd + '日 ' + hh + ':' + mi + '·' + tag + (personal ? '·个性化' : '');
}

function publicAssignment(a) {
  return {
    id: a._id,
    tag: a.tag,
    // 老作业没有 name 字段：回退到备注，再退到旧默认名，前端不出现空标题
    name: a.name || a.note || (a.tag || '') + '作业',
    count: a.count,
    deadline: a.deadline || '',
    note: a.note || '',
    // 词单必须下发：客户端"继续学"要按这份词单组装队列（跳过已学的词）
    word_ids: a.word_ids || [],
    created_at: a.created_at,
    // 个性化作业：前端要标注"每人词单不同"，别让家长以为两份进度对不上是 bug
    personalized: !!a.personalized
  };
}

const VERSION = 'class-20261007-summary';
const ok = (data) => ({ ok: true, _v: VERSION, data });
const fail = (code, message) => ({ ok: false, _v: VERSION, code, message });
