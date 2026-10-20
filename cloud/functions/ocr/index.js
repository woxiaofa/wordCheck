/**
 * 拍照识别（OCR）：把课本词表照片转成文字行，交给客户端做"可修改"的核对
 *
 * 为什么在云端做：
 *   1) 客户端直连第三方 OCR 要配 request 合法域名（个人主体还要备案），
 *      云函数出网不受白名单限制，一步到位；
 *   2) 图片压到 ~500KB 后以 base64 放进 callFunction 参数（上限 1MB），
 *      不经过云存储 —— 云存储要升级付费，用户明确不用。
 *
 * 引擎：OCR.space（免费额度 25000 次/月，注册只要邮箱，不实名不付费）。
 *   实测（2026-10-20，800x600 词表图）：英文单词 8/8 全对，
 *   中文释义部分识别成符号 —— 所以客户端必须是"识别 → 人工核对修改"，不是直接入库。
 *
 * 密钥：优先读环境变量 OCR_SPACE_KEY；没有就用 'helloworld'（官方测试 key，
 *   会被限流）。正式使用请在 https://ocr.space/ocrapi 免费注册换自己的 key，
 *   然后配到云函数环境变量里（或直接替换下面的 FALLBACK_KEY）。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const https = require('https');

const ENDPOINT = 'api.ocr.space';
const FALLBACK_KEY = 'helloworld';
const MAX_B64 = 700 * 1024;      // callFunction 请求体上限 1MB，留出其余字段余量
const TIMEOUT = 25000;
const RATE_WINDOW_MS = 10000;    // OCR 比发音重：同一用户 10 秒内最多 2 次
const RATE_MAX = 2;

function apiKey() {
  return process.env.OCR_SPACE_KEY || FALLBACK_KEY;
}

/** POST application/x-www-form-urlencoded，返回解析后的 JSON */
function post(body) {
  return new Promise(function (resolve, reject) {
    var req = https.request({
      host: ENDPOINT,
      path: '/parse/image',
      method: 'POST',
      headers: {
        'apikey': apiKey(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: TIMEOUT
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) { reject(new Error('HTTP_' + res.statusCode)); return; }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('BAD_JSON')); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('TIMEOUT')); });
    req.write(body);
    req.end();
  });
}

var hits = {};
function rateLimited(openid) {
  var now = Date.now();
  var arr = (hits[openid] || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
  arr.push(now);
  hits[openid] = arr;
  return arr.length > RATE_MAX;
}

async function recognize(image, openid) {
  if (typeof image !== 'string' || !image) {
    return { ok: false, code: 'BAD_IMAGE', msg: '没有图片' };
  }
  // 允许客户端带 data: 前缀，统一剥掉
  var b64 = image.replace(/^data:image\/[a-z]+;base64,/i, '').trim();
  if (!b64) return { ok: false, code: 'BAD_IMAGE', msg: '图片为空' };
  if (b64.length > MAX_B64) {
    return { ok: false, code: 'TOO_LARGE', msg: '图片太大，请靠近一点只拍词表' };
  }
  if (openid && rateLimited(openid)) {
    return { ok: false, code: 'RATE_LIMIT', msg: '识别太频繁，歇一下再试' };
  }

  var body = 'base64Image=' + encodeURIComponent('data:image/jpeg;base64,' + b64) +
    '&language=chs&isTable=true&scale=true&OCREngine=2';

  var json;
  try {
    json = await post(body);
  } catch (e) {
    return { ok: false, code: 'OCR_UNAVAILABLE', msg: '识别服务暂时不可用' };
  }

  if (json && json.IsErroredOnProcessing) {
    var m = json.ErrorMessage;
    if (Array.isArray(m)) m = m.join(' ');
    return { ok: false, code: 'OCR_ERROR', msg: String(m || '识别失败').slice(0, 80) };
  }
  var results = (json && json.ParsedResults) || [];
  var text = results.map(function (r) { return (r && r.ParsedText) || ''; }).join('\n');
  if (!text.replace(/\s/g, '')) {
    return { ok: false, code: 'EMPTY', msg: '没识别出文字，重拍一张试试（对准、别反光）' };
  }
  return { ok: true, text: text };
}

exports.main = async function (event) {
  const wxctx = cloud.getWXContext();
  const openid = wxctx.OPENID;
  const action = event && event.action;
  try {
    if (action === 'recognize') return await recognize(event.image, openid);
    return { ok: false, code: 'BAD_ACTION', msg: '未知 action' };
  } catch (e) {
    return { ok: false, code: 'OCR_ERROR', msg: String((e && e.message) || e) };
  }
};
