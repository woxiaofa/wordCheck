/**
 * 云函数：user —— 登录与资料
 *
 * 约定：
 *   1) 身份只认 OPENID（云函数上下文自带），客户端传什么 userId 一律忽略
 *   2) login 幂等：首次自动建用户，重复调用返回同一用户
 *   3) 不强制手机号、不拿 getUserProfile 也能玩（合规红线，见 docs/设计约定.md）
 *
 * 与 review/quiz 一致：数据库读写只出现在本层。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 2026-11-16 提审被拒（拒绝情形 3.2）：昵称 / 头像会展示给班级其他成员，
// 落库前必须过内容安全（security.msgSecCheck / imgSecCheck）。
const seccheck = require('./seccheck');

const COLL = {
  users: 'users'
};

const NICKNAME_POOL = [
  '小学霸', '背词达人', '小书虫', '单词侠', '晨读者',
  '小蜜蜂', '追光者', '小橡树', '闪电侠', '思维鸟'
];

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('NO_IDENTITY', '无法识别用户身份');

  switch (event.action) {
    case 'login':   return onLogin(OPENID, event);
    case 'profile': return onProfile(OPENID, event);
    default:        return fail('BAD_ACTION', '未知 action: ' + event.action);
  }
};

/* ------------------------------------------------------------------ */
/* 登录：首次自动建用户                                                 */
/* ------------------------------------------------------------------ */
async function onLogin(openid) {
  const now = Date.now();
  const found = await db.collection(COLL.users).where({ openid }).limit(1).get();
  if (found.data && found.data[0]) {
    const user = found.data[0];
    // 顺手刷新 last_seen（失败不影响登录）
    await db.collection(COLL.users).doc(user._id)
      .update({ data: { last_seen_at: now } }).catch(() => {});
    return ok({ user: publicUser(user), created: false });
  }

  // 昵称用词库兜底，不强制用户起名（孩子端零门槛进入）
  const nickname = NICKNAME_POOL[Math.floor(Math.random() * NICKNAME_POOL.length)];
  const addRes = await db.collection(COLL.users).add({
    data: {
      openid,
      role: 'student',          // 家长/老师角色等角色体系上线后再扩
      nickname,
      avatar: '',
      class_id: '',
      member_until: 0,
      stats_cache: { total_words: 0, learned_words: 0, streak_days: 0 },
      created_at: now,
      last_seen_at: now
    }
  });

  const doc = await db.collection(COLL.users).doc(addRes._id).get();
  return ok({ user: publicUser(doc.data), created: true });
}

/* ------------------------------------------------------------------ */
/* 资料更新（昵称/头像，选填）                                          */
/* ------------------------------------------------------------------ */
async function onProfile(openid, { nickname, avatar }) {
  const user = await getUser(openid);
  if (!user) return fail('NO_USER', '用户不存在，请先 login');

  const patch = {};
  if (typeof nickname === 'string' && nickname.trim()) {
    // 内容安全（2026-11-16 审核硬要求）：昵称在榜单 / 学员列表 / 简报里展示给他人
    const sec = await seccheck.checkText(cloud, openid, nickname, seccheck.SCENE.PROFILE);
    if (sec.blocked) return fail('SEC_BLOCK', '昵称包含平台不允许的内容，请换一个');
    patch.nickname = nickname.trim().slice(0, 20);
  }
  if (typeof avatar === 'string') {
    // 头像：云存储 fileID 才展示给他人（本地临时路径只有自己能看到），检图片内容
    const secImg = await seccheck.checkImage(cloud, openid, avatar);
    if (secImg.blocked) return fail('SEC_BLOCK', '头像图片包含平台不允许的内容，请换一张');
    patch.avatar = avatar.slice(0, 500);
  }
  if (!Object.keys(patch).length) return fail('BAD_PARAM', '没有可更新的字段');

  await db.collection(COLL.users).doc(user._id).update({ data: patch });
  return ok({ user: publicUser(Object.assign({}, user, patch)) });
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
async function getUser(openid) {
  const r = await db.collection(COLL.users).where({ openid }).limit(1).get();
  return r.data && r.data[0] ? r.data[0] : null;
}

/** 只下发客户端需要的字段，openid 等敏感信息绝不出门 */
function publicUser(u) {
  return {
    id: u._id,
    nickname: u.nickname || '',
    avatar: u.avatar || '',
    role: u.role || 'student',
    stats: u.stats_cache || { total_words: 0, learned_words: 0, streak_days: 0 }
  };
}

const VERSION = 'user-20261005';
const ok = (data) => ({ ok: true, _v: VERSION, data });
const fail = (code, message) => ({ ok: false, _v: VERSION, code, message });
