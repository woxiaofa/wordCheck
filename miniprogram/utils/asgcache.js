/**
 * 作业快照缓存 + 同步状态
 *
 * 为什么必须有它（2026-10-08）：
 *   加"布置作业"之前，整个练习流程都在本地 —— 词在本地、进度在本地、飞机上照样能练。
 *   加了之后作业词单只在云端，于是断网时孩子打开看到的是"没有作业"，
 *   甚至更糟：白屏期间他只能去练默认词库的词，练完的数据对不上作业，
 *   联网后家长端显示"作业 0/10"，还会怀疑数据坏了。
 *
 * 这里做的事很简单：把老师布置过的最新作业落在孩子手机里，
 * 断网时照着这份快照继续练（已经有的补传队列负责联网后回传）。
 *
 * 三条刻意的设计：
 *   1) **只缓存"够用来练"的字段**：id / 名字 / 词单 / 数量 / 单元标签。
 *      缓存全量作业对象等于给自己埋雷 —— 老版本写进去的字段结构不一定能反序列化。
 *   2) **失败才用缓存，成功永远以云端为准**：孩子学完几个词，联网再进来必须看到新进度，
 *      绝不能因为"本地有一份"就把家长的入口钉死在旧数字上。
 *   3) **不缓存敏感信息**：这里只有词和作业名，没有昵称、没有别的孩子的信息。
 */

var cloud = require('./cloud');

var KEY_SNAP = 'assign_snapshot_v1';
var KEY_SYNC = 'cls_sync_state_v1';
/** 快照有效期：超过 30 天的作业基本已经过期（那时连云端都不展示了） */
var SNAP_TTL_MS = 30 * 86400000;

function read(key, fallback) {
  try {
    var v = wx.getStorageSync(key);
    if (!v) return fallback;
    return v;
  } catch (e) {
    return fallback;      // 测试环境（无 wx）也能用
  }
}

function write(key, val) {
  try { wx.setStorageSync(key, val); } catch (e) { /* 存不下最多丢，不影响主流程 */ }
}

/**
 * 保存云端下发的作业列表。
 * @param {Array} list class.myAssignments 的 assignments
 */
function save(list) {
  if (!list || !list.length) return 0;
  var snap = (list || []).map(function (a) {
    return {
      id: a.id,
      name: a.name || a.tag || '班级作业',
      ids: a.word_ids || [],
      count: a.count || (a.word_ids || []).length,
      deadline: a.deadline || '',
      unit_label: a.unit_label || '',
      personalized: !!a.personalized
    };
  }).filter(function (a) { return a.ids.length > 0; });

  write(KEY_SNAP, { list: snap, at: Date.now() });
  return snap.length;
}

/** 最近一份作业（可能已过期）；没有缓存时返回 null */
function latest() {
  var s = read(KEY_SNAP, null);
  if (!s || !s.list || !s.list.length) return null;
  var a = s.list[0];
  return {
    id: a.id,
    name: a.name,
    ids: a.ids || [],
    count: a.count || (a.ids || []).length,
    deadline: a.deadline || '',
    unit_label: a.unit_label || '',
    personalized: !!a.personalized,
    savedAt: s.at || 0,
    /** 快照已过期（超过 TTL）：还能练，但要提示"可能不是最新" */
    stale: !!(s.at && Date.now() - s.at > SNAP_TTL_MS)
  };
}

/**
 * 本地算一下完成进度。
 * 为什么要本地算：断网时云端的 done 拿不到，但孩子到底学过哪些词在本地就有答案
 * （word_state_mirror 是"学过即算"的同一口径），不该因为断网就显示 0/10。
 * @param {Array<string>} ids 词文本
 * @param {object} mirror 本地 SRS 镜像 { [word]: {...} }
 */
function localProgress(ids, mirror) {
  var m = mirror || {};
  var done = 0;
  (ids || []).forEach(function (w) {
    if (m[w]) done++;
  });
  return { done: done, count: (ids || []).length };
}

/* ---------------- 同步状态 ---------------- */

function markOk() {
  write(KEY_SYNC, { lastOkAt: Date.now(), lastFailAt: 0, offline: false });
}

function markFail(msg) {
  var cur = read(KEY_SYNC, {}) || {};
  write(KEY_SYNC, {
    lastOkAt: cur.lastOkAt || 0,
    lastFailAt: Date.now(),
    offline: true,
    lastMsg: String((msg && (msg.errMsg || msg.message)) || msg || '').slice(0, 80)
  });
}

/**
 * 当前网络/同步状态。
 * offline 的含义是"最近一次云端调用失败"，而不是系统的网络类型 ——
 * 家长更关心"作业进度是不是最新的"，而不是"Wi-Fi 连没连上"。
 */
function state() {
  var s = read(KEY_SYNC, {}) || {};
  var pending = 0;
  try { pending = cloud.pendingCount(); } catch (e) { pending = 0; }
  var snap = read(KEY_SNAP, null);
  return {
    offline: !!s.offline,
    lastOkAt: s.lastOkAt || 0,
    lastFailAt: s.lastFailAt || 0,
    lastMsg: s.lastMsg || '',
    pending: pending,
    hasSnapshot: !!(snap && snap.list && snap.list.length)
  };
}

function hasSnapshot() {
  return !!latest();
}

/** 清除（退出班级/换班时用：别人的作业不能留在本机） */
function clear() {
  write(KEY_SNAP, null);
  write(KEY_SYNC, null);
}

module.exports = {
  KEY_SNAP: KEY_SNAP,
  KEY_SYNC: KEY_SYNC,
  SNAP_TTL_MS: SNAP_TTL_MS,
  save: save,
  latest: latest,
  localProgress: localProgress,
  markOk: markOk,
  markFail: markFail,
  state: state,
  hasSnapshot: hasSnapshot,
  clear: clear
};
