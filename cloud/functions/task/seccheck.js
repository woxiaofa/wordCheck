/**
 * UGC 内容安全检测（msgSecCheck / imgSecCheck）—— 只在云函数端用。
 *
 * 2026-11-16 提审被拒（运营规范·常见拒绝情形 3.2「平台未允许的服务内容」）：
 *   审核明确要求「创建班级」等发布场景必须接入内容安全 API（security.msgSecCheck），
 *   并要求所调用的 API 可在小程序内任意发布的场景生效。
 *   用户自由输入并会展示给他人的文本一共四处，全部从本模块过：
 *     · 班级名（class 云函数 onCreateClass）
 *     · 自定义词单 + 作业备注（class 云函数 onAssign）
 *     · 昵称（user 云函数 onProfile）
 *     · 头像图片（user 云函数 onProfile，fileID 落库前过 imgSecCheck）
 *   不检的输入：加入班级的邀请码（只做匹配、不展示不存储为内容）；
 *   本地自定义词库（只存本机 storage，不上传、不分享，见 utils/books.js）。
 *
 * 判定口径（必须弄清再改）：
 *   · API 明确判违规（result.suggest !== 'pass'，或 errCode 87014）→ 必须拦；
 *   · API 本身故障（权限未生效 / 网络抖动 / 欠费 / SDK 太旧）→ **放行**并 console.warn。
 *     理由：内容安全接口抖一下就把建班、布置作业全部瘫痪，比放行一条违规文本
 *     伤害大得多；且权限刚部署未生效时会出现整批调用失败。部署后要看一次
 *     云函数日志确认没有 [seccheck] warn，确认权限真的生效了。
 */

/** msgSecCheck 的 scene 取值（v2 必传） */
var SCENE = {
  PROFILE: 1,   // 用户资料（昵称）
  COMMENT: 2,   // 评论 / 动态类发布（班级名、词单、备注都按这个走）
};

/** 图片检测的体积上限：imgSecCheck 要求 <1M，超了不检（fail-open） */
var IMG_MAX_BYTES = 1000000;

function clean(text) {
  return String(text == null ? '' : text).trim();
}

/**
 * 文本检测（可传单条或多条，多条逐条检、命中即停）
 * @returns {Promise<{blocked:boolean, checked:number, degraded?:boolean}>}
 */
async function checkText(cloud, openid, content, scene) {
  var texts = (Array.isArray(content) ? content : [content])
    .map(clean).filter(Boolean).slice(0, 30);
  if (!texts.length) return { blocked: false, checked: 0 };

  var api = cloud && cloud.openapi && cloud.openapi.security &&
    cloud.openapi.security.msgSecCheck;
  if (!api || typeof api !== 'function') {
    console.warn('[seccheck] openapi.security.msgSecCheck 不可用，放行');
    return { blocked: false, checked: 0, degraded: true };
  }

  for (var i = 0; i < texts.length; i++) {
    try {
      var res = await api({
        openid: openid,
        scene: scene || SCENE.COMMENT,
        version: 2,
        content: texts[i]
      });
      var r = res && res.result;
      if (r && r.suggest && r.suggest !== 'pass') {
        return { blocked: true, checked: i + 1, suggest: r.suggest };
      }
    } catch (err) {
      var code = err && (err.errCode !== undefined ? err.errCode : err.errcode);
      if (code === 87014) {
        return { blocked: true, checked: i + 1, suggest: 'risky' };
      }
      console.warn('[seccheck] msgSecCheck 调用失败，放行：',
        err && (err.errMsg || err.message || err));
    }
  }
  return { blocked: false, checked: texts.length };
}

/**
 * 图片检测：只检云存储 fileID（前端头像上传后的产物）。
 * 本地临时路径（wxfile:// 等）不进云存储、不会展示给他人，不检。
 * @returns {Promise<{blocked:boolean, checked:boolean, degraded?:boolean}>}
 */
async function checkImage(cloud, openid, fileID) {
  if (!fileID || String(fileID).indexOf('cloud://') !== 0) {
    return { blocked: false, checked: false };
  }
  var dl = cloud && cloud.downloadFile;
  var api = cloud && cloud.openapi && cloud.openapi.security &&
    cloud.openapi.security.imgSecCheck;
  if (!dl || !api || typeof api !== 'function') {
    console.warn('[seccheck] openapi.security.imgSecCheck 不可用，放行');
    return { blocked: false, checked: false, degraded: true };
  }
  var buf;
  try {
    var r = await dl({ fileID: fileID });
    buf = r && r.fileContent;
  } catch (err) {
    console.warn('[seccheck] 图片下载失败，放行：',
      err && (err.errMsg || err.message || err));
    return { blocked: false, checked: false };
  }
  if (!buf || !buf.length || buf.length > IMG_MAX_BYTES) {
    return { blocked: false, checked: false };
  }
  try {
    await api({ media: { contentType: 'image/png', value: buf } });
    return { blocked: false, checked: true };
  } catch (err) {
    var code = err && (err.errCode !== undefined ? err.errCode : err.errcode);
    if (code === 87014) return { blocked: true, checked: true };
    console.warn('[seccheck] imgSecCheck 调用失败，放行：',
      err && (err.errMsg || err.message || err));
    return { blocked: false, checked: false };
  }
}

module.exports = {
  SCENE: SCENE,
  checkText: checkText,
  checkImage: checkImage
};
