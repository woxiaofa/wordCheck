/**
 * 班级作业词单参数的编解码（URL 契约）
 *
 * 为什么单独一个文件：这里出过一次实锤故障 —— 跳转方对词单做了
 * encodeURIComponent（逗号 → %2C），而学习页只解码了作业名、没解码词单，
 * 于是 10 个词被当成"一个超长单词"，split 得长度 1：
 *   进度条显示 0/1、日志"作业词单里有 1 个词不在当前词库"、队列为空直接"学完了"。
 * 这类接缝 bug 单测覆盖不到（每个函数自己都是对的），所以把解析抽成纯函数，
 * 由 tests/assignment-coherence.test.js 钉死往返契约。
 */

/**
 * 解析 URL 里的作业词单（兼容明文与 encodeURIComponent 两种形态）
 * @param {string} raw 原始参数值（微信不会自动解码 options.*，必须自己处理）
 * @returns {string[]} 词文本的干净数组（去空、去重、去首尾空格）
 */
function parseIdsParam(raw) {
  if (!raw) return [];
  var s = String(raw);
  // 含 % 说明被编码过；个别不可解码的串（如 %zz）要吞掉异常保留原样，
  // 不能让一个坏参数把整个学习页打崩
  if (s.indexOf('%') >= 0) {
    try { s = decodeURIComponent(s); } catch (e) { /* 保持原串，继续按逗号切 */ }
  }
  var seen = {};
  var out = [];
  s.split(',').forEach(function (part) {
    var w = String(part || '').trim();
    if (!w || seen[w]) return;
    seen[w] = 1;
    out.push(w);
  });
  return out;
}

/** 生成跳转 URL 的查询串（跳转方必须用它，保证与 parseIdsParam 成对） */
function buildIdsParam(ids) {
  return encodeURIComponent((ids || []).join(','));
}

module.exports = {
  parseIdsParam: parseIdsParam,
  buildIdsParam: buildIdsParam
};
