/**
 * 共享模块生成脚本
 *
 * 背景：云函数目录无法引用小程序目录的代码，反向也同理。
 * 引入构建层（npm 私包 / 打包）会显著增加复杂度，收益却只有"少一份副本"，
 * 所以选择：以 shared/ 为唯一真相来源，用本脚本生成两份原生副本。
 *
 * 用法：
 *   node scripts/sync-shared.js            # 生成副本（会覆盖，仅当内容不同才写）
 *   node scripts/sync-shared.js --check     # 只校验，不写入；有不一致时以非零码退出（可用于 CI / git hook）
 *
 * 为什么要求"逐字节一致"而不是"逻辑等价"：只要允许两处各写各的，
 * 早晚会出现"界面显示 7 天后复习、服务端排了 15 天"这种极难定位的问题。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'shared');

/**
 * 同步目标：shared/ 下的每个文件都要生成两份副本。
 *
 * 这里刻意用"自动扫描 shared/ 目录"而不是硬编码文件名：
 * 早先的版本写死两个模块名，结果新增 quiz.js 时必然漏同步 —— 校验会报错倒是好事，
 * 但更省心的做法是让它天然覆盖新模块。
 */
const COPY_TARGETS = [
  'miniprogram/utils/{name}',
  'cloud/shared/{name}'
];

/** 不需要复制的文件（例如只给文档用的说明） */
const SKIP_FILES = ['README.md', '.DS_Store'];

const checkOnly = process.argv.includes('--check');

function hash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

function main() {
  const problems = [];
  const written = [];

  if (!fs.existsSync(SOURCE_DIR)) {
    console.error('找不到真相来源目录：' + SOURCE_DIR);
    process.exit(1);
  }

  const sourceFiles = fs.readdirSync(SOURCE_DIR).filter(function (f) {
    if (SKIP_FILES.indexOf(f) >= 0) return false;
    if (f.indexOf('.') === 0) return false;
    return fs.statSync(path.join(SOURCE_DIR, f)).isFile();
  });

  if (!sourceFiles.length) {
    console.error('shared/ 目录下没有可同步的文件');
    process.exit(1);
  }

  sourceFiles.forEach((file) => {
    const source = fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8');

    COPY_TARGETS.forEach((pattern) => {
      const rel = pattern.replace('{name}', file);
      const targetPath = path.join(ROOT, rel);
      const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;

      if (current === source) return;   // 已经一致

      if (checkOnly) {
        problems.push(
          '副本与真相来源不一致：' + rel +
          (current === null ? '（文件不存在）' : '（副本指纹 ' + hash(current) + '，源指纹 ' + hash(source) + '）')
        );
      } else {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, source, 'utf8');
        written.push(rel);
      }
    });
  });

  if (problems.length) {
    console.error('共享模块一致性校验未通过：');
    problems.forEach((p) => console.error('  ✗ ' + p));
    console.error('\n请先运行：node scripts/sync-shared.js   再提交');
    process.exit(1);
  }

  if (checkOnly) {
    console.log('共享模块一致性校验通过 ✓');
  } else if (written.length) {
    console.log('已同步共享模块：');
    written.forEach((w) => console.log('  → ' + w));
  } else {
    console.log('共享模块已是最新，无需写入 ✓');
  }
}

main();
