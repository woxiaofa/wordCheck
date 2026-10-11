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
const wrongLib = require('./wrong');

const COLL = {
  users: 'users',
  classes: 'classes',
  assignments: 'assignments',
  /** 个性化作业的学员词单快照：{assignment_id, user_id, word_ids} */
  asgStudents: 'assignment_students',
  state: STATE_COLL,           // v5：读走合并查询（v2+legacy），写不经本函数
  requests: 'request_dedup',
  logs: 'review_logs',
  /** 每日简报订阅：{user_id, openid, student_id, template_id, last_sent_at} */
  briefSubs: 'brief_subs',
  /**
   * 自动布置计划（2026-10-11）：{class_id, teacher_id, volume, unit, start,
   * per_day, days, done, personalized, active, last_date, created_at}
   * 老师一次设定"这个单元分几天发完"，之后每天早上由定时器接着发 ——
   * 不用每天来点布置，只管看报告和催一催。
   */
  plans: 'assign_plans'
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

/**
 * 教材三级结构的白名单（服务端必须自己校验，不能信客户端传来的 volume/unit）
 *
 * 为什么不查库验证：布置作业是高频动作，每次多一次 count 查询不值；
 * 而这份映射本身很小，改动时也方便一眼看完。
 * 新增一册要同时改这里 + 重新导入 words 集合（词表必须带 volume/unit/unit_order）。
 */
const TEXTBOOKS = {
  // 2026-10-10 换新版教材（2024 版·孙有中主编）：Unit 1~6（旧版是 Module 1~10）
  wy4a: { tag: '外研四上', units: 6, name: '外研版（三起）·四年级上册' }
};

// 邀请码 → 班级 文档的缓存有效期（沿用 request_dedup 的清理思路，靠 TTL 惰性过期）
const REQ_TTL_MS = 2 * 86400000;

/**
 * 每日简报推送配置
 *
 * ⚠️ TEMPLATE_ID 必须替换：微信公众平台 → 订阅消息 → 选模板 → 复制模板 ID 填到这里。
 * 留空时整条链路**安全降级**（不报错、不打扰用户，接口返回 skipped），
 * 这样"还没申请到模板"不会变成"点了订阅却什么也没发生"。
 *
 * 为什么要这一层：简报文案早就有了，但只出现在孩子的手机上。
 * 家长/老师是同一个微信号时也一样 —— 他们不可能每天记得打开小程序去看，
 * 所以简报要能被送到微信会话里。
 */
const BRIEF = {
  TEMPLATE_ID: '',
  PAGE: 'pages/index/index',
  /** 订阅一次最多管多少天（微信一次订阅只发一条，这里只当显示用） */
  MAX_DAYS: 7
};

exports.main = async (event) => {
  // 定时触发（config.json 里的 timer）：没有用户身份，只做"给所有订阅者发当天简报"。
  // 必须放在取 OPENID 之前 —— 定时器调用方不是人，拿不到也不该要求 OPENID。
  if (event && (event.Type === 'Timer' || event.triggerName)) {
    return onTimerTick(event);
  }
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
    case 'subscribeBrief': return onSubscribeBrief(OPENID, event);
    case 'briefSubs':     return onBriefSubs(OPENID);
    case 'sendBriefs':    return onSendBriefs(OPENID, event);
    case 'planCreate':    return onPlanCreate(OPENID, event);
    case 'planList':      return onPlanList(OPENID);
    case 'planStop':      return onPlanStop(OPENID, event);
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
async function onAssign(openid, { tag, count, deadline, note, clientReqId, personalized, volume, unit, words }) {
  if (!clientReqId) return fail('BAD_PARAM', '缺少 clientReqId（幂等要求）');

  const ctx = await requireCoach(openid);
  if (ctx.err) return ctx.err;

  // --- 入参校验 ---
  // 取词范围有两种：① 老方式按词库标签；② 新方式按教材单元（老师的真实动作）。
  // 两条路最终都归一出一个 scope，后面的幂等/写库/个性化完全共用。
  const scope = resolveScope(tag, volume, unit);
  if (scope.err) return scope.err;

  // --- 自定义词单（布置预览编辑后的产物，2026-10-09）---
  // 前端把"预览词单"整份传上来：所见即所得。没编辑过时前端不传 words，
  // 走下面的 tag/unit 服务端选词老路径 —— 两条路不混用。
  let customWords = null;
  if (Array.isArray(words) && words.length) {
    if (words.length > LIMITS.ASSIGN_COUNT_MAX) {
      return fail('BAD_PARAM', '自定义词单最多 ' + LIMITS.ASSIGN_COUNT_MAX + ' 个词');
    }
    const cleaned = [];
    const seen = new Set();
    for (const w of words) {
      if (typeof w !== 'string') continue;
      const t = w.trim().slice(0, 40);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      cleaned.push(t);
    }
    if (cleaned.length < LIMITS.ASSIGN_COUNT_MIN) {
      return fail('BAD_PARAM', '编辑后至少保留 ' + LIMITS.ASSIGN_COUNT_MIN + ' 个词');
    }
    customWords = cleaned;
  }

  count = customWords ? customWords.length : parseInt(count, 10);
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
  // 编辑过词单的作业加"自定义"后缀 —— 家长一眼看出这份和课本词单不完全一样。
  const effScope = customWords
    ? Object.assign({}, scope, { label: (scope.label || scope.tag) + '·自定义' })
    : scope;
  const name = note || autoAssignName(effScope, now, personal);

  // --- 幂等闸 ---
  const dup = await db.collection(COLL.requests)
    .where({ _id: ctx.user._id + ':assign:' + clientReqId }).limit(1).get()
    .catch(() => ({ data: [] }));
  if (dup.data && dup.data[0]) {
    const prev = await db.collection(COLL.assignments).doc(dup.data[0].ref).get().catch(() => null);
    if (prev && prev.data) return ok({ assignment: publicAssignment(prev.data), dedup: true });
  }

  // --- 选词 ---
  // 按词库：按词频升序取前 count 个（简单可解释，学生先学高频词）
  // 按单元：按 unit_order 升序 —— 词序必须跟课本一致，否则孩子练的顺序不是老师讲的顺序
  // 个性化作业要多拉一些候选：好让"已掌握的词跳过、易错词补进来"有挑选余地
  const fetchMax = personal
    ? Math.min(LIMITS.WORDS_FETCH_MAX, count * LIMITS.PERSONAL_POOL_FACTOR)
    : Math.min(LIMITS.WORDS_FETCH_MAX, count);
  // 自定义词单：按词文本查库、保持老师排好的顺序；查不到的如实回报（不静默丢）
  const pickRes = customWords
    ? await chooseWordsByList(customWords)
    : await chooseWords(scope, fetchMax);
  const missingWords = customWords ? (pickRes.missing || []) : [];
  // 关键：存 word 文本而非 _id —— user_word_state.word_id / task snapshot /
  // 客户端本地词库匹配全都用文本，进度查询与"继续学"队列才能对上
  const poolTexts = (pickRes.data || []).map(w => w.word).slice(0, fetchMax);
  const wordIds = poolTexts.slice(0, count);   // 基础词单（全班默认 / 教师端展示用）
  if (wordIds.length < LIMITS.ASSIGN_COUNT_MIN) {
    return fail('WORDS_EMPTY', customWords
      ? '词单里的词几乎都不在词库中（收到 ' + customWords.length + ' 个、配上 ' + wordIds.length + ' 个）'
      : '该词库暂无可布置的单词');
  }

  const addRes = await db.collection(COLL.assignments).add({
    data: {
      class_id: ctx.cls._id,
      tag: scope.tag,
      // 教材单元：没走这条路的作业保持老结构（不带这两个字段），老数据安全
      volume: scope.mode === 'unit' ? scope.volume : '',
      unit: scope.mode === 'unit' ? scope.unit : 0,
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
    student_count: personal ? (ctx.cls.student_ids || []).length : 0,
    // 自定义词单里有词配不上库时如实带回，前端提示 —— 不静默、不假成功
    missing: missingWords.length ? missingWords : undefined
  });
}

/* ------------------------------------------------------------------ */
/* 自动布置计划（2026-10-11 用户反馈：42 个词的单元分 4 天发完，别每天来点）  */
/* ------------------------------------------------------------------ */

/**
 * 为什么要它：老师的真实节奏是"这周把 Unit 2 过完"，不是"每天下午四点来布置 10 个词"。
 * 一次设定，定时器每天早 8 点接着发 —— 老师只剩两件事：看报告、催一催。
 *
 * 刻意不做的事：
 *   1) 不猜每天该布置多少 —— 由老师定天数，我们按 ceil(剩余/天数) 均分；
 *   2) 不自动跳过"孩子已经会的词"（那是个性化开关的事，计划只管按课本序往前推）；
 *   3) 定时器无身份，所以计划文档里自带 class_id 与 teacher_id，写库不依赖 openid。
 */
async function onPlanCreate(openid, { volume, unit, start, days, personalized, clientReqId }) {
  if (!clientReqId) return fail('BAD_PARAM', '缺少 clientReqId（幂等要求）');
  const ctx = await requireCoach(openid);
  if (ctx.err) return ctx.err;

  const scope = resolveScope(null, volume, unit);
  if (scope.err) return scope.err;
  if (scope.mode !== 'unit') return fail('BAD_PARAM', '自动布置只支持按教材单元');

  const startNo = Math.max(1, parseInt(start, 10) || 1);
  const daysNo = Math.min(14, Math.max(2, parseInt(days, 10) || 2));

  // 单元总词数：按 volume+unit 计数（不拉全文，只要个数量）
  const totalRes = await db.collection('words')
    .where({ volume: scope.volume, unit: scope.unit }).count().catch(() => ({ total: 0 }));
  const unitTotal = totalRes.total || 0;
  const remaining = unitTotal - startNo + 1;
  if (remaining < 2) return fail('BAD_PARAM', '这个单元从这个起点往后没有词可布置了');

  // 每天词数 = 均分向上取整（42 词 4 天 → 11/11/10/10），最后一天可能少一个
  const perDay = Math.max(1, Math.ceil(remaining / daysNo));
  const realDays = Math.min(daysNo, Math.ceil(remaining / perDay));

  // 集合可能还没建（新功能第一次用）：先自愈一次，省得老师点完布置只看到一句报错。
  // 建不成也要给得出人话 —— "点了没反应"比"报错"更让人怀疑数据坏了。
  await ensureCollection(db, COLL.plans);

  const now = Date.now();
  const doc = {
    class_id: ctx.cls._id,
    teacher_id: ctx.user._id,
    volume: scope.volume,
    unit: scope.unit,
    start: startNo,
    per_day: perDay,
    days: realDays,
    done: 0,
    personalized: personalized === true,
    active: true,
    last_date: '',
    created_at: now
  };
  const addRes = await db.collection(COLL.plans).add({ data: doc }).catch((e) => ({
    __err: String((e && (e.errMsg || e.message)) || e)
  }));
  if (addRes && addRes.__err) {
    return fail('NO_COLLECTION',
      '云端还没建 assign_plans 集合（自动布置要用）：去云开发控制台建一个，或重试一次');
  }

  // 第一天当场发出：老师设定完立刻能在"已布置"里看到，孩子今天就有得练。
  // 剩下的交给定时器 —— "设完什么都没发生"是最让人不安的体验。
  const first = await planEmitAssignment(Object.assign({ _id: addRes._id }, doc));
  if (first.err) {
    // 第一份都没发出来就别留个假计划在班里转：立刻停掉并如实报错
    await db.collection(COLL.plans).doc(addRes._id).update({ data: { active: false } }).catch(() => {});
    return first.err;
  }

  const saved = await db.collection(COLL.plans).doc(addRes._id).get();
  return ok({ plan: publicPlan(saved.data), assignment: first.assignment });
}

/** 教练端：本班的自动布置计划（含进度） */
async function onPlanList(openid) {
  const ctx = await requireCoach(openid);
  if (ctx.err) return ctx.err;
  const r = await db.collection(COLL.plans)
    .where({ class_id: ctx.cls._id })
    .orderBy('created_at', 'desc')
    .limit(10)
    .get().catch(() => ({ data: [] }));
  return ok({ plans: (r.data || []).map(publicPlan) });
}

/** 停掉计划：已经发出去的作业保留（那是孩子已经领到的活），只是不再往后发 */
async function onPlanStop(openid, { planId }) {
  const ctx = await requireCoach(openid);
  if (ctx.err) return ctx.err;
  if (!planId) return fail('BAD_PARAM', '缺少 planId');
  const r = await db.collection(COLL.plans).doc(planId).get().catch(() => null);
  if (!r || !r.data) return fail('NOT_FOUND', '计划不存在');
  // 只能停自己班的（定时器侧不需要 openid，权限必须在数据上卡住）
  if (r.data.class_id !== ctx.cls._id) return fail('FORBIDDEN', '这不是本班的计划');
  await db.collection(COLL.plans).doc(planId).update({ data: { active: false } });
  return ok({ stopped: true });
}

/** 给前端看的计划：把"还剩几天、下一个词是第几个"摊平，前端不拼字符串 */
function publicPlan(p) {
  const nextStart = (p.start || 1) + ((p.done || 0) * (p.per_day || 0));
  return {
    id: p._id,
    volume: p.volume,
    unit: p.unit,
    unit_label: p.volume && p.unit ? scopeLabel({ mode: 'unit', tag: '', volume: p.volume, unit: p.unit }) : '',
    start: p.start || 1,
    per_day: p.per_day || 0,
    days: p.days || 0,
    done: p.done || 0,
    left: Math.max(0, (p.days || 0) - (p.done || 0)),
    next_start: nextStart,
    personalized: !!p.personalized,
    active: p.active !== false,
    last_date: p.last_date || ''
  };
}

/**
 * 按计划发一天的作业（第 done+1 天）。
 * 取词 = 课本序跳过 start-1+done*per_day，取 per_day 个 —— 与老师手动布置同一口径。
 * 幂等：靠 last_date 挡住（同一天被定时器重复触发也不会发两份）。
 */
async function planEmitAssignment(plan) {
  const offset = (plan.start - 1) + plan.done * plan.per_day;
  const r = await db.collection('words')
    .where({ volume: plan.volume, unit: plan.unit })
    .orderBy('unit_order', 'asc')
    .skip(offset)
    .limit(plan.per_day)
    .get().catch(() => ({ data: [] }));
  const wordIds = (r.data || []).map(w => w.word);
  if (wordIds.length < 1) {
    return { err: fail('WORDS_EMPTY', '这个单元从这个起点往后没有词可布置了') };
  }

  const now = Date.now();
  const scope = resolveScope(null, plan.volume, plan.unit);
  const dayNo = plan.done + 1;
  const name = scope.label + ' 第 ' + dayNo + '/' + plan.days + ' 天（' +
    (plan.start + plan.done * plan.per_day) + '~' +
    (plan.start + plan.done * plan.per_day + wordIds.length - 1) + ' 词）';

  const addRes = await db.collection(COLL.assignments).add({
    data: {
      class_id: plan.class_id,
      tag: scope.tag,
      volume: plan.volume,
      unit: plan.unit,
      name,
      word_ids: wordIds,
      count: wordIds.length,
      deadline: '',
      note: '',
      personalized: !!plan.personalized,
      pool_ids: [],
      // 溯源：这份作业是自动计划发的第几天（排查"孩子说没作业"时能立刻查到）
      plan_id: plan._id,
      plan_day: dayNo,
      created_by: plan.teacher_id,
      created_at: now
    }
  });

  await db.collection(COLL.plans).doc(plan._id).update({
    data: {
      done: dayNo,
      last_date: getLocalDate(now),
      active: dayNo < plan.days
    }
  }).catch((e) => {
    console.error('[class] 计划进度回写失败（可能重复发同一天）:',
      String((e && (e.errMsg || e.message)) || e).slice(0, 120));
  });

  if (plan.personalized) {
    const cls = await db.collection(COLL.classes).doc(plan.class_id).get().catch(() => null);
    const sids = (cls && cls.data && cls.data.student_ids) || [];
    for (const sid of sids) {
      await wordsForStudent({ _id: addRes._id, word_ids: wordIds, personalized: true }, sid)
        .catch(() => {});
    }
  }

  const created = await db.collection(COLL.assignments).doc(addRes._id).get();
  return { assignment: publicAssignment(created.data) };
}

/** 定时器：每天早 8 点把所有进行中的计划往前推一天 */
async function runDailyPlans() {
  const today = getLocalDate(Date.now());
  const r = await db.collection(COLL.plans)
    .where({ active: true })
    .limit(50)
    .get().catch(() => ({ data: [] }));
  const plans = r.data || [];
  let sent = 0;
  for (const p of plans) {
    // 幂等：同一天只发一次（定时器偶发重触发、或多个触发器撞一起）
    if (p.last_date === today) continue;
    if (!p._id) continue;
    const res = await planEmitAssignment(p).catch((e) => ({ err: String((e && e.message) || e) }));
    if (res && !res.err) sent++;
  }
  return { plans: plans.length, sent: sent };
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

  // 字母级诊断的原料：全班在这些作业词上答错时**实际拼出来的字符串**。
  // 一次拉齐（班级上限 50 人）而不是每份作业查一次 —— N 份作业 N 次查询会明显拖慢打开速度。
  const allWords = [];
  assignments.forEach((a) => (a.word_ids || []).forEach((w) => {
    if (w && allWords.indexOf(w) === -1 && allWords.length < 300) allWords.push(w);
  }));
  const wrongRes = (studentIds.length && allWords.length)
    ? await db.collection(COLL.logs)
        .where({ user_id: _.in(studentIds), word_id: _.in(allWords), feedback: 'forgot' })
        .limit(1000)
        .field({ word_id: true, wrong_answer: true })
        .get().catch(() => ({ data: [] }))
    : { data: [] };
  const wrongRows = (wrongRes.data || []).filter((r) => !!r.wrong_answer);

  const withProgress = [];
  for (const a of assignments) {
    const per = await progressForAssignment(a, studentIds);
    // 分级点名（2026-10-10 用户反馈：9/10·忘 1 的孩子和 0/10 的混在同一句"还没完成"
    // 里点名，老师看着像都没交 —— 实际人家把 10 个词全学了一遍，只是 1 个抽查答了忘）。
    // 完成口径不变（忘词不算完成，重学自动回完成），只把"学过但有忘词"单独分层：
    //   pending —— 真没怎么动的（done+forgot 连一半都不到）：红标催
    //   review  —— 词全学过但有忘词（done+forgot>=count 且 done<count）：黄标温和提醒巩固
    //   done    —— 全部答对
    per.forEach(p => {
      if (p.count > 0 && p.done >= p.count) p.state = 'done';
      else if (p.count > 0 && p.done + p.forgot >= p.count) p.state = 'review';
      else p.state = 'pending';
    });
    const pend = per.filter(p => p.state === 'pending').map(p => p.nickname);
    const review = per.filter(p => p.state === 'review')
      .map(p => p.nickname + '（忘 ' + p.forgot + '）');
    withProgress.push(Object.assign(publicAssignment(a), {
      finished: per.filter(p => p.state === 'done').length,
      total_students: studentIds.length,
      per_student: per,
      // 老师打开页面 5 秒内要能答的三个问题，都在这里一次性给全：
      //   谁没交 / 错得最多的是哪几个词 / 错成什么样（少字母？顺序颠倒？）
      pending_names: pend,
      review_names: review,
      class_wrong: await wrongSummaryFor(a, wrongRows)
    }));
  }
  return ok({ assignments: withProgress });
}

/**
 * 一份作业的班级级错因汇总。
 * @param {object} a 作业
 * @param {Array} wrongRows [{ word_id, wrong_answer }]，已按班级成员过滤
 *
 * 刻意只给"有据可查"的结论：没有 wrong_answer（老版本客户端没上报）的行会被跳过，
 * 于是这份汇总可能比"班上答错的总次数"少 —— 少而准，好过全而猜。
 */
async function wrongSummaryFor(a, wrongRows) {
  // 词文本统一去首尾空白（2026-10-10 用户实锤：错词 chip 样式被撑坏，
  // 根因之一是日志里的 word_id 带空格 —— 统计、配释义、展示三处都会跟着错）
  const norm = (w) => String(w || '').trim();
  const scope = {};
  (a.word_ids || []).forEach((w) => { scope[norm(w)] = 1; });
  const rows = wrongRows
    .map((r) => Object.assign({}, r, { word_id: norm(r.word_id) }))
    .filter((r) => scope[r.word_id]);
  if (!rows.length) return { wrong_top: [], mistake_top: [], letter_top: [], counted: 0 };

  const kinds = [];
  const pairs = [];
  rows.forEach((r) => {
    const kind = wrongLib.mistakeKind(r.word_id, r.wrong_answer);
    if (kind && kind !== '其它' && kind !== '相同') kinds.push(kind);
    const pair = wrongLib.singleLetterPair(r.word_id, r.wrong_answer);
    if (pair) pairs.push(pair);
  });

  const words = wrongLib.topWords(rows.map(r => ({ word: r.word_id })), 5);
  // 错词配释义：老师拿着这张表要能直接开讲，不该再去翻字典
  const trans = await translationsOf(words.map(w => w.word));
  return {
    counted: rows.length,
    wrong_top: words.map(w => ({ word: w.word, cnt: w.cnt, trans: trans[w.word] || '' })),
    // 取 4 类：班里常见的错法一般不超过 4 种，全列出来老师才说得准"这次是普遍问题"
    mistake_top: wrongLib.topBy(kinds, 4),
    // 字母混淆对（如 o→u）：这是最细的一条诊断，只有确实错单个字母时才出
    letter_top: wrongLib.topBy(pairs, 3)
  };
}

/** 词文本 → 中文释义（补习信息缺失时给空串，前端不显示而不是显示 undefined） */
async function translationsOf(words) {
  const out = {};
  if (!words.length) return out;
  const res = await db.collection('words')
    .where({ word: _.in(words) })
    .limit(100)
    .field({ word: true, translation: true, def_cn: true })
    .get().catch(() => ({ data: [] }));
  (res.data || []).forEach((w) => {
    if (!w.word) return;
    // ECDICT 的 translation 常是"多词义竖排"（含 \n），有的还带前导空行 ——
    // 直接塞进 chip 会把它撑成大气泡（2026-10-10 用户实锤"样式不对，单词前有空格"）。
    // 清洗：换行分词义 → 顿号连接；压平所有空白；掐头去尾；限长防止 chip 换行。
    const raw = String(w.translation || w.def_cn || '');
    out[w.word] = raw
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('、')
      .slice(0, 24);
  });
  return out;
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
      // 错拼原文（2026-10-10）：独立报告页要按它做字母级诊断 ——
      // 错在哪几个词、错成什么样（少字母？相邻颠倒？），只能靠客户端上报的原文。
      // 老版本客户端没上报 → 空串，诊断部分自动不显示（少而准，好过全而猜）。
      wrong_answer: l.wrong_answer || '',
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

  // 微信聊天里的 #小程序:// 文本会被微信自动变成可点链接（2026-10-10 用户拍板）：
  // 家长把催学文案发给孩子，孩子点一下就直接打开小程序，不用再找入口。
  // 它带不了参数（邀请码场景仍走分享卡片），所以这里只做"直接打开"的引导。
  // 必须放在最后一行：链接是收尾的行动指引，插中间会打断文案的故事线。
  parts.push('点这里直接打开小程序 👉 #小程序://功课抽查/');

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
/* 每日学习简报：订阅 + 推送                                            */
/* ------------------------------------------------------------------ */

/**
 * 订阅某个孩子的每日简报。
 *
 * 前置：前端必须先 wx.requestSubscribeMessage 拿到用户授权 ——
 * 微信只允许"用户点一下同意"之后发一条，我们不在后台偷偷攒名额。
 * 这里的职责只是记账：谁订阅了谁的简报。
 */
async function onSubscribeBrief(openid, { studentId, unsubscribe }) {
  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先 login');
  if (!studentId) return fail('BAD_PARAM', '缺少学员 id');

  // 权限：只能订阅自己班级里的学员
  const cls = await findOwnedClass(user._id);
  if (!cls) return fail('NOT_COACH', '只有班级创建者可以订阅学员简报');
  if ((cls.student_ids || []).indexOf(studentId) === -1) {
    return fail('FORBIDDEN', '该学生不在你的班级');
  }

  const id = user._id + ':' + studentId;

  // 退订优先，且必须写在模板校验之前：哪怕模板已经下架（或压根没配），
  // 用户也已经决定不再收了 —— 这时候回"服务端没配模板"等于把人锁在里面。
  if (unsubscribe) {
    await db.collection(COLL.briefSubs).doc(id).remove().catch(() => {});
    return ok({ subscribed: false, student_id: studentId });
  }

  if (!BRIEF.TEMPLATE_ID) {
    return fail('NO_TEMPLATE', '服务端还没配置订阅消息模板 ID，暂时用不了每日简报推送');
  }

  try {
    await db.collection(COLL.briefSubs).doc(id).set({
      data: {
        user_id: user._id,
        openid: openid,
        student_id: studentId,
        template_id: BRIEF.TEMPLATE_ID,
        created_at: Date.now(),
        last_sent_at: 0
      }
    });
  } catch (e) {
    // 不许吞错误：集合不存在时如果还回"订阅成功"，家长会在每天 20:30
    // 等一条永远不来的简报 —— 这比直接告诉他"还没开通"糟得多。
    if (String(e.errCode || e.code) === '-502005') {
      return fail('NO_COLLECTION', '云端还没建 brief_subs 集合，现在订阅不会生效（云开发控制台 → 数据库 → 新建 brief_subs）');
    }
    return fail('DB_ERR', '订阅写入失败：' + String(e.message || e).slice(0, 80));
  }
  return ok({ subscribed: true, student_id: studentId });
}

/** 我订阅了哪些孩子的简报（前端据此渲染开关状态） */
async function onBriefSubs(openid) {
  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先 login');
  let list = [];
  let colErr = '';
  try {
    const res = await db.collection(COLL.briefSubs)
      .where({ user_id: user._id }).limit(50).get();
    list = res.data || [];
  } catch (e) {
    // 读不到集合时降级为"没订阅过"（这就是事实），但要把原因带回去，
    // 前端才好提示去建集合 —— 否则开关永远关着，人会以为是点了没反应。
    if (String(e.errCode || e.code) === '-502005') colErr = 'NO_COLLECTION';
    list = [];
  }
  const templateReady = !!BRIEF.TEMPLATE_ID;
  return ok({
    template_ready: templateReady,
    collections_ready: !colErr,
    subs: list.map((s) => ({
      student_id: s.student_id,
      created_at: s.created_at || 0,
      last_sent_at: s.last_sent_at || 0
    }))
  });
}

/**
 * 给订阅者发当天简报。
 * @param {string} [openid] 有值时只发这个人（手动触发/调试用）；空 = 定时器给所有人发
 */
async function onSendBriefs(openid, event) {
  if (!BRIEF.TEMPLATE_ID) {
    // 没配模板不能算成功，也不能算业务失败 —— 明确回 skipped，前端/日志都能看懂
    return ok({ skipped: true, reason: 'NO_TEMPLATE', sent: 0 });
  }
  const today = getLocalDate(Date.now());

  const query = {};
  if (openid) {
    const user = await getUser(openid);
    if (!user) return fail('NO_USER', '用户不存在，请先 login');
    query.user_id = user._id;
  }
  const base = Object.keys(query).length
    ? db.collection(COLL.briefSubs).where(query)
    : db.collection(COLL.briefSubs);
  const res = await base.limit(100).get().catch(() => ({ data: [] }));
  const subs = res.data || [];
  if (!subs.length) return ok({ sent: 0, skipped: false, total: 0 });

  let sent = 0, skippedToday = 0;
  const failures = [];
  for (const s of subs) {
    // 同一天不重复发：定时器重跑 / 用户手动点都不会把家长手机刷爆
    if (getLocalDate(s.last_sent_at || 0) === today) { skippedToday++; continue; }
    const uRes = await db.collection(COLL.users).doc(s.student_id).get().catch(() => null);
    const stu = uRes && uRes.data ? uRes.data : null;
    if (!stu) continue;

    const summary = await summaryLib.learnSummary(
      db, s.student_id, stu.nickname || '同学', today
    );
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: s.openid,
        templateId: BRIEF.TEMPLATE_ID,
        page: BRIEF.PAGE,
        data: briefTemplateData(summary, today)
      });
      sent++;
      await db.collection(COLL.briefSubs).doc(s._id)
        .update({ data: { last_sent_at: Date.now() } }).catch(() => {});
    } catch (e) {
      // 单个失败不中断整批：一个人授权失效不该让全班都收不到
      failures.push(String(s.student_id).slice(-6) + ':' + String((e && e.errMsg) || e).slice(0, 60));
    }
  }
  return ok({ sent: sent, skippedToday: skippedToday, total: subs.length, failures: failures });
}

/** 定时触发入口（config.json 的 timer 每天调一次） */
/**
 * 定时器分发（config.json 里两条 timer）：
 *   dailyBrief  20:30 —— 给订阅者发当天简报
 *   dailyAssign 08:00 —— 把进行中的自动布置计划往前推一天
 * 两条必须分开：8 点那个要是顺手发了简报，家长早上就收到"今天练了 0 个词"。
 */
async function onTimerTick(event) {
  const name = (event && (event.triggerName || event.TriggerName)) || '';
  if (name === 'dailyAssign') return runDailyPlans();
  if (name === 'dailyBrief') return onSendBriefs(null, {});
  // 拿不到触发器名（手工触发/老环境）：两件都做，行为与加自动布置之前一致
  const briefs = await onSendBriefs(null, {});
  const plans = await runDailyPlans().catch(() => ({ sent: 0 }));
  return Object.assign({}, briefs, { daily_plans: plans });
}

/**
 * 订阅消息模板数据。
 * ⚠️ 这里的字段名（thing/date/time 等编号）必须和你在公众平台选用的模板一致，
 *    不一致会报 47003 data format error —— 换了模板就改这个函数，别改别的地方。
 */
function briefTemplateData(summary, date) {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const hh = ('0' + now.getUTCHours()).slice(-2);
  const mi = ('0' + now.getUTCMinutes()).slice(-2);
  return {
    thing1: { value: cut(summary.honor ? summary.honor.title : '今日学习简报', 20) },
    thing2: { value: cut(briefHeadline(summary), 20) },
    date3: { value: date },
    time4: { value: hh + ':' + mi }
  };
}

/** 一句话摘要：Push 上只放得下 20 个字，必须是"今天练了多少、还要不要练"。
 *  口径与 shared/summary 一致（2026-10-09）："抽查"是练习里的拼写环节，
 *  不是学完之后要另外去做的事。 */
function briefHeadline(s) {
  if (!s.learned && !s.quiz_total) return '今天还没学习记录';
  const base = '练了 ' + s.learned + ' 个词 / ' + s.minutes + ' 分钟';
  if (!s.quiz_total) return base + '，还没拼写';
  return base + '，抽查 ' + s.mastered + '/' + s.quiz_total + ' 掌握' +
    (s.need_loop ? '，还要巩固' : '，已全掌握');
}

function cut(s, n) {
  return String(s || '').slice(0, n);
}

exports.setBriefTemplateForTest = setBriefTemplateForTest;

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

/* ------------------------------------------------------------------ */
/* 取词范围：按词库标签 / 按教材单元                                     */
/* ------------------------------------------------------------------ */

/**
 * 把客户端传来的 (tag, volume, unit) 归一成一个 scope。
 * 返回 { err } 或 { mode:'tag'|'unit', tag, volume, unit, label }
 *
 * 为什么必须服务端裁决：客户端可以同时传 tag 和 unit，甚至传一个库里没有的 volume。
 * 只靠前端保证等于没保证 —— 幂等之外的所有业务参数都得服务端认定一次。
 */
function resolveScope(tag, volume, unit) {
  const VALID_TAGS = ['全部', '中考', '高考', '四级', '外研四上'];
  const u = parseInt(unit, 10);
  const v = typeof volume === 'string' ? volume.trim() : '';

  // 走教材单元：必须给出合法册 + 合法单元号
  if (u > 0) {
    const book = TEXTBOOKS[v];
    if (!book) return { err: fail('BAD_PARAM', '教材册无效：' + (v || '(空)')) };
    if (u > book.units) return { err: fail('BAD_PARAM', '单元号超出该册范围（最大 Unit ' + book.units + '）') };
    // 客户端顺手传的 tag 与教材不符时以教材为准，避免"作业名说 Unit 3、范围却是中考词"
    return {
      mode: 'unit', tag: book.tag, volume: v, unit: u,
      label: scopeLabel({ mode: 'unit', tag: book.tag, volume: v, unit: u })
    };
  }

  if (!VALID_TAGS.includes(tag)) return { err: fail('BAD_PARAM', '词库标签无效') };
  return { mode: 'tag', tag, volume: '', unit: 0, label: tag };
}

/** 范围的可读名：作业自动命名与前端展示共用，避免两端写出两种叫法 */
function scopeLabel(scope) {
  if (scope.mode !== 'unit') return scope.tag;
  const book = TEXTBOOKS[scope.volume];
  return (book ? book.name : scope.volume) + '·Unit ' + scope.unit;
}

async function chooseWords(scope, fetchMax) {
  if (scope.mode === 'unit') {
    // 索引提醒：words 集合需建 {volume:1, unit:1, unit_order:1} 复合索引，否则大数据量下会慢查
    return db.collection('words')
      .where({ volume: scope.volume, unit: scope.unit })
      .orderBy('unit_order', 'asc')
      .limit(fetchMax)
      .get();
  }
  return db.collection('words')
    .where(scope.tag === '全部' ? {} : { tags: scope.tag })
    .orderBy('freq', 'asc')
    .limit(fetchMax)
    .get();
}

/** 自定义词单选词：按词文本查库，返回顺序 = 老师排的顺序（预览里看到什么顺序就存什么顺序） */
async function chooseWordsByList(list) {
  const _ = db.command;
  const res = await db.collection('words')
    .where({ word: _.in(list) })
    .limit(list.length)
    .get();
  const byText = new Map((res.data || []).map(w => [w.word, w]));
  return {
    data: list.filter(t => byText.has(t)).map(t => byText.get(t)),
    missing: list.filter(t => !byText.has(t))
  };
}

/** 作业自动命名：按 UTC+8 取"10月7日 12:10·全部·个性化"这样的名字，见名知时知范围 */
function autoAssignName(scope, nowMs, personal) {
  const d = new Date(nowMs + 8 * 3600 * 1000);          // UTC+8
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  const hh = ('0' + d.getUTCHours()).slice(-2);
  const mi = ('0' + d.getUTCMinutes()).slice(-2);
  return mm + '月' + dd + '日 ' + hh + ':' + mi + '·' + (scope.label || scope.tag) +
    (personal ? '·个性化' : '');
}

function publicAssignment(a) {
  // 单元 Mode的作业：前端要显示"外研四上 Unit 3"，让人一眼看出这份覆盖到哪课。
  // 标签直接由服务端算好下发，不允许前端自己拼（拼法两边不一致就是两个名字）。
  const vol = a.volume && TEXTBOOKS[a.volume] ? a.volume : '';
  const no = Number(a.unit) || 0;
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
    personalized: !!a.personalized,
    unit: vol && no ? no : 0,
    // 教练端"接着上次布置"要按 volume+unit 找同单元的旧作业（2026-10-11）
    volume: vol,
    unit_label: vol && no ? scopeLabel({ mode: 'unit', tag: a.tag, volume: vol, unit: no }) : ''
  };
}

/**
 * 仅测试用：注入模板 ID，让推送链路在没有真实模板的情况下也能被完整验证
 * （生产环境不会被调用；发放 localhost 外的调用一律走 config.json 里的账号配置）。
 */
function setBriefTemplateForTest(id) {
  BRIEF.TEMPLATE_ID = id;
  return BRIEF.TEMPLATE_ID;
}

const VERSION = 'class-20261010-wy4a6';
const ok = (data) => ({ ok: true, _v: VERSION, data });
const fail = (code, message) => ({ ok: false, _v: VERSION, code, message });
