/**
 * 共享模块一致性校验（云函数）
 *
 * 为什么需要它：云函数目录无法引用小程序目录的代码，所以 shared/ 的模块被复制成两份。
 * 一旦两份不一致（比如只改了小程序端），会出现"界面显示 7 天后复习、服务端排了 15 天"
 * 这类极难定位的问题。这个云函数或本地脚本都能做校验。
 *
 * 部署方式：本函数需要能读到两份副本，实际项目里更简单可靠的做法是
 * 在提交前跑本地脚本：node scripts/sync-shared.js --check
 * 本文件保留给"需要在服务器侧核对线上副本是否漂移"的场景。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 云函数部署后只上传自己的目录，因此默认无法访问仓库其他位置。
// 通过环境变量 SHARED_ROOT 指定仓库根目录（本地用云函数调试时可用）。
const ROOT = process.env.SHARED_ROOT;

const PAIRS = [
  ['miniprogram/utils/srs.js', 'cloud/shared/srs.js'],
  ['miniprogram/utils/time.js', 'cloud/shared/time.js'],
  ['miniprogram/utils/quiz.js', 'cloud/shared/quiz.js']
];

function fp(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8'), 'utf8').digest('hex').slice(0, 12);
  } catch (e) {
    return null;
  }
}

exports.main = async () => {
  if (!ROOT) {
    return {
      ok: false,
      code: 'NO_ROOT',
      message: '未设置 SHARED_ROOT 环境变量，无法定位两份副本。' +
        '日常请在提交前运行 node scripts/sync-shared.js --check'
    };
  }
  const drift = [];
  PAIRS.forEach(([a, b]) => {
    const fa = fp(path.join(ROOT, a));
    const fb = fp(path.join(ROOT, b));
    if (!fa || !fb || fa !== fb) drift.push({ pair: [a, b], a: fa, b: fb });
  });
  return drift.length
    ? { ok: false, code: 'DRIFT', message: '共享模块已漂移，请运行 node scripts/sync-shared.js', drift }
    : { ok: true, data: { checked: PAIRS.length } };
};
