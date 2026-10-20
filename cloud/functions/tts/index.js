/**
 * 云端发音：自定义词库的兜底发音（内置 454 词走包内 mp3，不经过这里）
 *
 * 为什么存在：个人主体搜不到「微信同声传译」插件（2026-10-05 / 10-19 两次实锤），
 * 词库外的词原本只能静默失败 —— 自定义词库点喇叭没声、听写题全被降级成拼写。
 *
 * 2026-10-20 推倒重来（用户拍板）：**不接任何付费云服务、不需要任何密钥**。
 *   - 发音源：有道词典的公开发音接口（免费、无需注册）
 *   - 传输：音频以 base64 放进云函数返回值（一个词约 15~25KB，远小于 1MB 上限）
 *   - 缓存：云数据库 tts_audio 集合存 base64（一词一条，集合不存在自动建）
 *   - 客户端：拿到 base64 写进 USER_DATA_PATH，之后本机直读，不再走网络
 *
 * 因此整个链路不需要：云存储权限配置、环境变量、腾讯云账号、任何付费开通。
 * 只吃微信云开发的免费额度（调用次数 + 数据库读写）。
 *
 * 风险与兜底：有道是非官方公开接口，若某天变更/限流，本函数返回 TTS_ERROR，
 * 客户端表现为"这个词暂时没声音"（与改造前一致），不会崩、不会卡住做题。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { key: audioKey } = require('./audio-key');
const https = require('https');

const COLL = 'tts_audio';       // key → { audio: base64, created_at }
const MAX_TEXT = 40;            // 词/短语长度上限
const RATE_WINDOW_MS = 1000;    // 同一 openid 1 秒内最多 8 次，防连点
const RATE_MAX = 8;
const FETCH_TIMEOUT = 8000;

/** 有道发音（美音）。免费、无密钥；失败抛错，由上层转成 TTS_ERROR */
function fetchYoudao(word) {
  return new Promise(function (resolve, reject) {
    var url = 'https://dict.youdao.com/dictvoice?type=2&audio=' + encodeURIComponent(String(word).trim());
    var req = https.get(url, { timeout: FETCH_TIMEOUT }, function (res) {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP_' + res.statusCode));
        return;
      }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var buf = Buffer.concat(chunks);
        if (!buf.length) { reject(new Error('EMPTY_AUDIO')); return; }
        resolve(buf);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('TIMEOUT')); });
  });
}

/** 词合法性：字母开头，只允许字母/空格/撇号/连字符/点 —— 拒掉中文、URL 和注入串 */
function validWord(w) {
  if (typeof w !== 'string') return false;
  w = w.trim();
  if (!w || w.length > MAX_TEXT) return false;
  return /^[A-Za-z][A-Za-z'\-. ]*$/.test(w);
}

/** 同一 openid 简易限频：实例内存即可，连点保护不需要跨实例精确 */
var hits = {};
function rateLimited(openid) {
  var now = Date.now();
  var arr = (hits[openid] || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
  arr.push(now);
  hits[openid] = arr;
  return arr.length > RATE_MAX;
}

/** 写缓存；集合不存在则建了重试（用户不用手动建集合） */
function saveCache(key, audio) {
  var data = { audio: audio, created_at: Date.now() };
  return db.collection(COLL).doc(key).set({ data: data }).catch(function (e) {
    var s = String((e && e.message) || e);
    if (s.indexOf('-502005') === -1 && s.indexOf('not exists') === -1) throw e;
    return db.createCollection(COLL).then(function () {
      return db.collection(COLL).doc(key).set({ data: data });
    });
  });
}

async function synthesize(word, openid) {
  if (!validWord(word)) return { ok: false, code: 'BAD_WORD', msg: '词不合法或超长' };
  if (openid && rateLimited(openid)) return { ok: false, code: 'RATE_LIMIT', msg: '点太快了' };

  var key = audioKey(word);
  if (!key) return { ok: false, code: 'BAD_WORD', msg: '净化后为空' };

  // 1) 缓存命中：直接回 base64，不再请求发音源
  try {
    var r = await db.collection(COLL).doc(key).get();
    if (r && r.data && r.data.audio) {
      return { ok: true, key: key, audio: r.data.audio, cached: true };
    }
  } catch (e) { /* doc.get 对不存在文档各环境行为不一，一律视作未命中 */ }

  // 2) 未命中：取免费发音源 → 写缓存 → 回 base64
  var buf;
  try {
    buf = await fetchYoudao(word);
  } catch (e) {
    return { ok: false, code: 'TTS_ERROR', msg: '发音源暂时不可用' };
  }
  var audio = buf.toString('base64');
  try { await saveCache(key, audio); } catch (e) { /* 缓存写不进去只影响下次速度，不影响本次 */ }
  return { ok: true, key: key, audio: audio, cached: false };
}

exports.main = async function (event) {
  const wxctx = cloud.getWXContext();
  const openid = wxctx.OPENID;
  const action = event && event.action;
  try {
    if (action === 'synthesize') return await synthesize(event.word, openid);
    return { ok: false, code: 'BAD_ACTION', msg: '未知 action' };
  } catch (e) {
    return { ok: false, code: 'TTS_ERROR', msg: String((e && e.message) || e) };
  }
};
