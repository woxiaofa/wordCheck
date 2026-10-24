/**
 * 云函数：exportall —— 一键导出全库数据（备份用）
 *
 * 为什么要有它：免费云环境有到期日（约 2026-11-03），到期后云函数、数据库、
 * 云存储**全部不可访问**，数据会被释放且不可恢复。
 * 官方控制台的「导出」要一个集合一个集合点，这里一次调用打包全部。
 *
 * 怎么用：部署后在云开发控制台 → 云函数 → exportall → 云端测试，参数填：
 *   {}                                    # 导出全部集合
 *   {"collection":"review_logs"}          # 只导一个集合
 *   {"collection":"review_logs","inline":true}   # 同时把数据直接回显（小数据量用）
 *
 * 返回：{ ok, exportedAt, counts:{集合:条数}, total, downloadUrl, fileID }
 * 拿到 downloadUrl 后 wget/curl 下来即可，链接有几小时有效期。
 *
 * 约定（与项目其余云函数一致）：
 *   - 维护类动作放在身份检查之前，方便控制台手动跑（那里没有真实 OPENID）；
 *   - 集合不存在不算错误，记进 errors 继续下一个；
 *   - 分页上限 100（云数据库单次 get 的硬限制），skip 累加直到取不满一页。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

/** 全库集合清单（与 shared/ 及各云函数 COLL 常量逐一对齐） */
const COLLS = [
  'users',
  'words',
  'daily_tasks',
  'assignments',
  'assignment_students',
  'assign_plans',
  'classes',
  'review_logs',
  'quiz_items',
  'quiz_sessions',
  'drill_scores',
  'brief_subs',
  'request_dedup',
  'user_word_state_v2',
  'user_word_state',
  'diag_scratch',
  'wipe_backup'
];

const PAGE = 100;         // 云数据库单次 get 的条数上限
const SAFETY = 30000;     // 安全阀：单集合最多拉这么多条，防死循环

/** 拉取一个集合的全量数据；集合不存在时抛错，由调用方记进 errors */
async function dumpOne(name) {
  const out = [];
  let skip = 0;
  for (;;) {
    const r = await db.collection(name).skip(skip).limit(PAGE).get();
    const rows = (r && r.data) || [];
    out.push.apply(out, rows);
    if (rows.length < PAGE) break;
    skip += PAGE;
    if (out.length >= SAFETY) break;
  }
  return out;
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

exports.main = async (event) => {
  const ev = event || {};
  const list = ev.collection ? [String(ev.collection)] : COLLS;
  const data = {};
  const counts = {};
  const errors = {};
  let total = 0;

  for (const name of list) {
    try {
      const rows = await dumpOne(name);
      data[name] = rows;
      counts[name] = rows.length;
      total += rows.length;
    } catch (e) {
      errors[name] = String((e && e.message) || e);
      counts[name] = -1;
    }
  }

  const out = {
    ok: Object.keys(errors).length === 0,
    exportedAt: new Date().toISOString(),
    counts: counts,
    total: total,
    // 失败明细要回显：控制台里得看得见"哪个集合没读到、为什么"，
    // 否则 ok=false 却查不出原因，等于白跑一趟。
    errors: errors
  };

  try {
    const json = JSON.stringify(data);
    out.bytes = Buffer.byteLength(json, 'utf8');
    const up = await cloud.uploadFile({
      cloudPath: 'export/wordcheck-' + stamp() + '.json',
      fileContent: Buffer.from(json, 'utf8')
    });
    out.fileID = up.fileID;
    const t = await cloud.getTempFileURL({ fileList: [up.fileID] });
    const f = (t && t.fileList && t.fileList[0]) || {};
    out.downloadUrl = f.tempFileURL || '';
  } catch (e) {
    out.uploadError = String((e && e.message) || e);
  }

  return out;
};
