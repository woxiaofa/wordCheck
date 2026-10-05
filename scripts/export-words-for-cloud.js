/**
 * 导出词库为云开发控制台可导入的 JSON Lines 文件
 *
 * 用法：node scripts/export-words-for-cloud.js
 * 产出：scripts/cloud-import/words.json （每行一条记录，控制台导入到 words 集合）
 *
 * 为什么用 JSON Lines：云开发控制台"导入"只接受两种格式——CSV，或
 * 每行一个 JSON 对象的 .json 文件。标准 JSON 数组会被当成一条记录而报错。
 * 冲突处理选 upsert（按 word 字段去重需要先在 words 集合给 word 建唯一索引，
 * 没建就选 insert，反正首次导入是空集合）。
 *
 * 前置：words.js 的 tags 是中文显示名（'中考'/'高考'/'四级'），
 * 与 miniprogram/utils/books.js 的匹配逻辑一致，导出时不做转码。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORDS = require(path.join(ROOT, 'miniprogram/data/words.js'));
const OUT_DIR = path.join(__dirname, 'cloud-import');

const REQUIRED = ['word', 'phonetic', 'pos', 'def_cn', 'tags', 'freq'];

function main() {
  const seen = new Set();
  const problems = [];

  const lines = WORDS.map((w) => {
    REQUIRED.forEach((k) => {
      if (w[k] === undefined) problems.push(w.word + ' 缺字段 ' + k);
    });
    if (seen.has(w.word)) problems.push('重复单词：' + w.word);
    seen.add(w.word);
    return JSON.stringify({
      word: w.word,
      phonetic: w.phonetic || '',
      pos: w.pos || '',
      def_cn: w.def_cn || '',
      example_en: w.example_en || '',
      example_cn: w.example_cn || '',
      tags: Array.isArray(w.tags) ? w.tags : [],
      freq: Number(w.freq) || 0
    });
  });

  if (problems.length) {
    console.error('导出前校验未通过：');
    problems.forEach((p) => console.error('  ✗ ' + p));
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'words.json');
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  console.log('已导出 ' + lines.length + ' 条 → ' + out);
  console.log('导入方式见 docs/云开发部署指南.md 第三章');
}

main();
