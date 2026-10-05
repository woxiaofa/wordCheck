/**
 * 释义修正补丁：把 scripts/data/examples.js 里 POS_OVERRIDES 的 def 字段
 * 直接应用到 miniprogram/data/words.js（适用于手头没有 ECDICT CSV、
 * 无法全量重建的场景）。未来的全量重建同样会带上这些覆盖。
 *
 * 用法：node scripts/patch-words.js
 * 特性：
 *   - 幂等：重复运行无副作用（目标已是新释义则跳过）
 *   - 严格：只改 def_cn 字段，且要求"词 + 旧释义"逐字匹配才替换；
 *     匹配不上的会在最后列出（说明词库已变，需人工确认），并以非零码退出
 *   - 只碰 def_cn，不保证动 pos / phonetic / 例句
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORDS_FILE = path.join(ROOT, 'miniprogram', 'data', 'words.js');
const OVERRIDES = require('./data/examples.js').POS_OVERRIDES;

function main() {
  const source = fs.readFileSync(WORDS_FILE, 'utf8');
  const defOverrides = Object.entries(OVERRIDES)
    .filter(([, ov]) => ov && ov.def)
    .map(([word, ov]) => [word, ov.def]);

  console.log('待应用释义修正：' + defOverrides.length + ' 条');

  let applied = 0, already = 0, missed = [];
  let out = source;

  for (const [word, def] of defOverrides) {
    // 定位该词条的 def_cn 值（在 word 所在行之后的第一处）
    const wordIdx = out.indexOf("word: '" + word + "'");
    if (wordIdx < 0) { missed.push(word + '（词不在词库中）'); continue; }

    const defIdx = out.indexOf("def_cn: '", wordIdx);
    const lineEnd = out.indexOf('\n', wordIdx);
    if (defIdx < 0 || defIdx > lineEnd) { missed.push(word + '（行内未找到 def_cn）'); continue; }

    const start = defIdx + "def_cn: '".length;
    const end = out.indexOf("'", start);
    const current = out.slice(start, end);

    if (current === def) { already++; continue; }

    out = out.slice(0, start) + def + out.slice(end);
    applied++;
    console.log('  ' + word + ': ' + current + '  →  ' + def);
  }

  if (missed.length) {
    console.error('\n以下词条未能应用（词库与覆盖表不一致，需人工确认）：');
    missed.forEach((m) => console.error('  ✗ ' + m));
  }

  if (applied > 0) {
    fs.writeFileSync(WORDS_FILE, out, 'utf8');
    console.log('\n已写入 ' + applied + ' 条修正，' + already + ' 条本就是新值');
    console.log('下一步：node scripts/export-words-for-cloud.js 重新导出云端导入文件');
  } else {
    console.log('\n无需改动（' + already + ' 条均为最新）');
  }

  if (missed.length) process.exit(1);
}

main();
