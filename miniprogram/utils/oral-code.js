/**
 * 跟读口令编解码（纯函数，无 wx 依赖，Node 可直接单测）
 *
 * 为什么要有它：第 1 期零云端，老师/家长写的朗读文本没法经服务器下发。
 * 用一段可复制的短码走微信转发，学生端粘贴导入 —— 零后端、跨设备，
 * 而且口令解开就是一段可读的英文，对方能看见里面到底是什么，不会夹带隐私。
 *
 * 格式：WC1.<base64(紧凑JSON)>.<4位校验和>
 *   - 版本前缀 WC1：将来改格式时旧版能明确报「版本不支持」，而不是解出一堆乱码
 *   - 校验和：微信转发/手抄时被截断或改一个字符，必须报错而不是静默导入错文本
 *   - 紧凑 JSON 只允许 5 个字段：v / t / ref / n / ts，未知字段一律丢弃
 *
 * 字符集白名单：只放英文、数字、空格与常见标点。中文经 base64 会膨胀，
 * 且说明性文字在微信里另发即可 —— 口令里不该出现学生姓名、手机号等隐私信息。
 *
 * 本文件不依赖任何环境 API：base64 与校验和都自己实现。
 * 小程序端没有 Buffer/btoa，Node 端没有 wx，两端必须逐字节一致。
 */

var PREFIX = 'WC1';
var MAX_CODE = 600;      // 整条口令上限（微信里转发、手抄都不至于被截断）
var MAX_REF = 200;       // 朗读文本上限，约 1~2 句
var TEXT_RE = /^[A-Za-z0-9 ,.'!?;:()\-"]*$/;
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 标准 base64（输入保证是 ASCII，白名单已经挡掉中文） */
function b64encode(s) {
  var out = '', i = 0;
  while (i < s.length) {
    var c1 = s.charCodeAt(i++) & 0xff;
    var c2 = i < s.length ? s.charCodeAt(i++) & 0xff : -1;
    var c3 = i < s.length ? s.charCodeAt(i++) & 0xff : -1;
    var e1 = c1 >> 2;
    var e2 = ((c1 & 3) << 4) | (c2 < 0 ? 0 : c2 >> 4);
    var e3 = c2 < 0 ? 64 : (((c2 & 15) << 2) | (c3 < 0 ? 0 : c3 >> 6));
    var e4 = c3 < 0 ? 64 : (c3 & 63);
    out += B64.charAt(e1) + B64.charAt(e2) +
      (e3 === 64 ? '=' : B64.charAt(e3)) + (e4 === 64 ? '=' : B64.charAt(e4));
  }
  return out;
}

function b64decode(s) {
  if (!s || s.length % 4 !== 0) return null;
  var out = '';
  for (var i = 0; i < s.length; i += 4) {
    var q = s.slice(i, i + 4);
    var e1 = B64.indexOf(q.charAt(0));
    var e2 = B64.indexOf(q.charAt(1));
    var e3 = q.charAt(2) === '=' ? -1 : B64.indexOf(q.charAt(2));
    var e4 = q.charAt(3) === '=' ? -1 : B64.indexOf(q.charAt(3));
    if (e1 < 0 || e2 < 0 || (q.charAt(2) !== '=' && e3 < 0) ||
        (q.charAt(3) !== '=' && e4 < 0)) return null;
    out += String.fromCharCode((e1 << 2) | (e2 >> 4));
    if (e3 >= 0) out += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
    if (e4 >= 0) out += String.fromCharCode(((e3 & 3) << 6) | e4);
  }
  return out;
}

/** djb2 取低 16 位 → 4 位十六进制。不是为了防篡改，是为了挡截断和手抄错字。 */
function checksum(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return ('000' + ((h % 65536).toString(16))).slice(-4);
}

/** 按非字母数字切词；撇号保留（don't 算一个词），与本地音频清单的净化规则同向 */
function words(text) {
  return String(text || '').trim()
    .split(/[^A-Za-z0-9']+/)
    .filter(function (w) { return /[A-Za-z0-9]/.test(w); });
}

/**
 * 生成口令。
 * @param {object} input { ref: 朗读文本, t: 'word'|'custom', ts?: 时间戳 }
 * @returns {{ok:true,code:string,data:object}|{ok:false,reason:string}}
 */
function encode(input) {
  var obj = input || {};
  var ref = String(obj.ref || '').replace(/\s+/g, ' ').trim();
  if (!ref) return { ok: false, reason: '请先填要读的内容' };
  if (ref.length > MAX_REF) return { ok: false, reason: '朗读内容超过 ' + MAX_REF + ' 字，请拆成两句分别发' };
  if (!TEXT_RE.test(ref)) return { ok: false, reason: '口令里只能放英文、数字和常见标点；中文说明请在微信里另发' };
  var ws = words(ref);
  if (!ws.length) return { ok: false, reason: '没找到可跟读的英文词' };
  var payload = {
    v: 1,
    t: obj.t === 'word' ? 'word' : 'custom',
    ref: ref,
    n: ws.length,
    ts: Number(obj.ts) || Date.now()
  };
  var body = b64encode(JSON.stringify(payload));
  var full = PREFIX + '.' + body + '.' + checksum(body);
  if (full.length > MAX_CODE) return { ok: false, reason: '内容太长，请拆成两句分别发' };
  return { ok: true, code: full, data: payload };
}

/**
 * 解析口令。任何一步失败都给人话提示，绝不静默返回半截文本。
 * @returns {{ok:true,data:object}|{ok:false,reason:string}}
 */
function decode(raw) {
  // 微信里复制常带前后空格/换行；口令内部不含空白，直接去掉更安全
  var s = String(raw || '').replace(/\s+/g, '');
  if (!s) return { ok: false, reason: '口令是空的，请重新复制完整的一段' };
  if (s.length > MAX_CODE) return { ok: false, reason: '口令太长，可能连同别的内容一起复制了' };
  var parts = s.split('.');
  if (parts.length !== 3) return { ok: false, reason: '口令不完整，请连前缀和结尾一起复制' };
  if (parts[0] !== PREFIX) return { ok: false, reason: '这个口令的版本不支持，请让对方重新生成' };
  if (!/^[0-9a-f]{4}$/.test(parts[2])) return { ok: false, reason: '口令结尾不对，请重新复制' };
  if (checksum(parts[1]) !== parts[2]) return { ok: false, reason: '口令有改动或不完整，请重新复制一次' };
  var json = b64decode(parts[1]);
  if (json === null) return { ok: false, reason: '口令内容读不出来，请重新复制' };
  var o;
  try { o = JSON.parse(json); } catch (e) { return { ok: false, reason: '口令内容读不出来，请重新复制' }; }
  if (!o || o.v !== 1 || (o.t !== 'word' && o.t !== 'custom')) {
    return { ok: false, reason: '这个口令的版本不支持，请让对方重新生成' };
  }
  var ref = String(o.ref || '');
  if (!ref || ref.length > MAX_REF || !TEXT_RE.test(ref)) {
    return { ok: false, reason: '口令里的朗读内容不合法' };
  }
  if (words(ref).length !== Number(o.n)) {
    return { ok: false, reason: '口令里的词数对不上，复制时可能少了一段' };
  }
  // 字段白名单：只回这 5 个字段，口令里夹带的其它内容一律丢弃
  return {
    ok: true,
    data: { v: 1, t: o.t, ref: ref, n: Number(o.n), ts: Number(o.ts) || 0 }
  };
}

module.exports = {
  PREFIX: PREFIX,
  MAX_CODE: MAX_CODE,
  MAX_REF: MAX_REF,
  encode: encode,
  decode: decode,
  words: words,
  checksum: checksum,
  b64encode: b64encode,
  b64decode: b64decode
};
