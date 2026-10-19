/**
 * 云端 TTS：自定义词库的发音兜底（内置 454 词走包内 mp3，不经过这里）
 *
 * 为什么存在：个人主体搜不到「微信同声传译」插件（2026-10-05、2026-10-19 两次实锤），
 * 词库外的词原本只能静默失败 —— 自定义词库点喇叭没声、听写题全被降级成拼写。
 * 本函数按词合成英文发音，结果存云存储 tts-cache/<key>.mp3，一词只合成一次，
 * 之后所有用户共享（存储权限需开"所有用户可读"，里面全是合成音频，无隐私内容）。
 *
 * 密钥：腾讯云 SecretId/Key 走云函数环境变量 TTS_SECRET_ID / TTS_SECRET_KEY，
 * 绝不进仓库（mp 后台不提供云函数环境变量配置，用云开发控制台 → 云函数 → 配置）。
 * 未配置时 synthesize 返回 UNAVAILABLE，客户端自然降级回静默失败，一切照旧 ——
 * 所以这个函数可以安全地在配密钥之前部署。
 *
 * 引擎：腾讯云 TTS（2026-10-19 用户拍板），官方 SDK v20190823.TextToVoice，
 * 英文音色 voiceType 1001（美音女声）。客户端拿 fileID 后 wx.cloud.downloadFile，
 * 走微信内部通道，不占 downloadFile 域名白名单。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { key: audioKey } = require('./audio-key');
const tencentcloud = require('tencentcloud-sdk-nodejs-tts');

const COLL = 'tts_audio';       // key → fileID 缓存索引
const REGION = 'ap-guangzhou';
const VOICE_TYPE = 1001;        // 英文女声（美音）
const MAX_TEXT = 40;            // 词/短语长度上限
const RATE_WINDOW_MS = 1000;    // 同一 openid 1 秒内最多 8 次，防连点打爆额度
const RATE_MAX = 8;

let ttsClient = null;
let ttsClientKey = '';

function getTtsClient(secretId, secretKey) {
  var k = secretId + ':' + secretKey;
  if (ttsClient && ttsClientKey === k) return ttsClient;
  const Client = tencentcloud.tts.v20190823.Client;
  ttsClient = new Client({
    credential: { secretId: secretId, secretKey: secretKey },
    region: REGION,
    profile: { httpProfile: { endpoint: 'tts.tencentcloudapi.com' } }
  });
  ttsClientKey = k;
  return ttsClient;
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

/** 写缓存索引；集合不存在则建了重试（用户不用手动建集合） */
function saveCache(key, fileID) {
  var data = { fileID: fileID, created_at: Date.now() };
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

  // 1) 缓存命中：直接回 fileID（客户端 wx.cloud.downloadFile(fileID)，不占域名白名单）
  var hit = null;
  try {
    var r = await db.collection(COLL).doc(key).get();
    hit = r && r.data && r.data.fileID ? r.data : null;
  } catch (e) { /* doc.get 对不存在文档各环境行为不一，一律视作未命中 */ }
  if (hit) return { ok: true, key: key, fileID: hit.fileID, cached: true };

  // 2) 未命中：必须已配密钥，没配就明确降级
  var secretId = process.env.TTS_SECRET_ID;
  var secretKey = process.env.TTS_SECRET_KEY;
  if (!secretId || !secretKey) return { ok: false, code: 'UNAVAILABLE', msg: '云端发音未配置' };

  // 3) 合成 → 上传云存储 → 写缓存（并发竞态只是多合成几次同键覆盖，幂等无害）
  var res = await getTtsClient(secretId, secretKey).TextToVoice({
    Text: String(word).trim(),
    SessionId: 'tts-' + key,
    Volume: 0,
    Speed: 0,
    VoiceType: VOICE_TYPE,
    Language: 'en-US',
    EnableSubtitle: false
  });
  if (!res || !res.Audio) return { ok: false, code: 'TTS_EMPTY', msg: '合成结果为空' };
  var buf = Buffer.from(res.Audio, 'base64');
  var up = await cloud.uploadFile({ cloudPath: 'tts-cache/' + key + '.mp3', fileContent: buf });
  if (!up || !up.fileID) return { ok: false, code: 'UPLOAD_FAIL', msg: '音频上传失败' };
  await saveCache(key, up.fileID);
  return { ok: true, key: key, fileID: up.fileID, cached: false };
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
