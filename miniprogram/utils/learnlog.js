/**
 * 学习流水（可自证的每一行："我做了什么 → 进度有没有往前走"）
 *
 * 为什么需要它：内测期出现过"孩子明明学了一堆词，作业进度却恒 0/10"，
 * 家长没法判断是自己操作不对、还是程序有问题。口头解释不算数，
 * 所以把每一次评分的全过程就地记账：
 *   什么时候 · 哪个词 · 什么模式（作业/今日任务/抽查）· 点了什么（认识/模糊/忘了）
 *   → 本地有没有记下 → 云端有没有确认 → 失败原因是什么
 * 首页可以原样看到最近若干条，也能一键复制出来发给我。
 *
 * 完成口径（与云端一致，写在这里避免各页面自己定义）：
 *   **学过即算** —— 一个词只要被评价过一次（认识/模糊/忘了都算），
 *   它在 user_word_state 里就有记录，作业进度就 +1。抽查答不答对不影响完成度。
 */

var KEY = 'learn_log_v1';
var MAX = 60;                 // 环形：只留最近 60 条，storage 有上限

function read() {
  try { return wx.getStorageSync(KEY) || []; } catch (e) { return []; }
}
function write(list) {
  try { wx.setStorageSync(KEY, list); } catch (e) { /* 记不下日志不能影响学习本身 */ }
}

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

/**
 * 开一笔流水。
 * @param {Object} e { word, mode, assign, feedback, reqId }  mode: 'assign'|'task'|'quiz'
 * @returns {string} id，用于稍后 patch 云端结果
 */
function push(e) {
  var item = {
    id: newId(),
    ts: Date.now(),
    word: e.word || '',
    mode: e.mode || 'task',                 // assign=班级作业 / task=今日任务 / quiz=抽查
    assign: e.assign || '',                 // 作业名（作业模式才有）
    feedback: e.feedback || '',             // known / vague / forgot
    reqId: e.reqId || '',                   // 云端幂等 ID：补传队列重放成功后靠它回填
    local: true,                            // 本地镜像已生效（调用点一定是先落本地再提交）
    cloud: 'pending'                        // pending / ok / fail
  };
  var list = read();
  list.unshift(item);
  if (list.length > MAX) list = list.slice(0, MAX);
  write(list);
  return item.id;
}

/** 回填云端结果。errCode 非空即失败，原样显示在流水里 */
function patch(id, cloud, errCode) {
  if (!id) return;
  var list = read();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      list[i].cloud = cloud;
      if (errCode) list[i].err = String(errCode).slice(0, 60);
      break;
    }
  }
  write(list);
}

/** 最近 n 条（默认 8，首页展示用） */
function recent(n) {
  return read().slice(0, n || 8);
}

/** 按云端幂等 ID 回填（补传队列重放成功时用） */
function patchByReq(reqId, cloud, errCode) {
  if (!reqId) return false;
  var list = read();
  var hit = false;
  for (var i = 0; i < list.length; i++) {
    if (list[i].reqId && list[i].reqId === reqId) {
      list[i].cloud = cloud;
      if (errCode) list[i].err = String(errCode).slice(0, 60);
      hit = true;
      break;
    }
  }
  if (hit) write(list);
  return hit;
}

/** 把 pending 标记为失败（例如明确知道没发出去） */
function failPending(reason) {
  var list = read();
  list.forEach(function (it) {
    if (it.cloud === 'pending') { it.cloud = 'fail'; it.err = String(reason || '未确认').slice(0, 60); }
  });
  write(list);
}

function clear() { write([]); }

var MODE_LABEL = { assign: '作业', task: '任务', quiz: '抽查' };
var FB_LABEL = { known: '认识', vague: '模糊', forgot: '忘了' };

function hhmmss(ts) {
  var d = new Date(ts);
  function p(n) { return n < 10 ? '0' + n : '' + n; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 给页面渲染用：每条拼成一行"时间 · 词 · 模式 · 反馈 · 云端状态" */
function lines(n) {
  return recent(n || 8).map(function (it) {
    var cloudTxt = it.cloud === 'ok' ? '云端✓'
      : (it.cloud === 'fail' ? '云端✗' + (it.err ? '(' + it.err + ')' : '') : '云端…');
    return {
      id: it.id,
      time: hhmmss(it.ts),
      word: it.word,
      mode: MODE_LABEL[it.mode] || it.mode,
      assign: it.assign,
      feedback: FB_LABEL[it.feedback] || it.feedback,
      cloud: it.cloud,
      cloudTxt: cloudTxt
    };
  });
}

/** 一键复制的纯文本（含口径说明），家长发我排查用 */
function toText(n) {
  var head = [
    '学习流水（最新在前）',
    '进度口径：学过即算 —— 每个词评价一次即计入作业完成，抽查对错不影响',
    '------------------------------------'
  ];
  var body = recent(n || 30).map(function (it) {
    var cloudTxt = it.cloud === 'ok' ? '云端已确认'
      : (it.cloud === 'fail' ? '云端失败 ' + (it.err || '') : '云端未确认');
    return hhmmss(it.ts) + ' · ' + it.word +
      ' · ' + (MODE_LABEL[it.mode] || it.mode) + (it.assign ? '《' + it.assign + '》' : '') +
      ' · ' + (FB_LABEL[it.feedback] || it.feedback) +
      ' · 本地已记 · ' + cloudTxt;
  });
  return head.concat(body).join('\n');
}

module.exports = { push, patch, patchByReq, recent, lines, toText, clear, failPending };
