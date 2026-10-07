/**
 * 把外研版（三起）四年级上册词表并入本地词库
 *
 *   node scripts/build-waiyan.js           # 写入 miniprogram/data/words.js + 云端导入文件
 *   node scripts/build-waiyan.js --check   # 只校验是否已导入（用于 CI）
 *
 * 两条刻意的设计：
 *   1) **已存在的词只补标签，不建第二条**：ECDICT 那 300 词里已经有 fish / light /
 *      day 这类小学词，再插一条同名词会让"同一个词有两个进度"，抽查也可能连出两遍。
 *   2) **新词 freq 排在 7000+**：词库按 freq 升序取词（"全部"词库取前 N 个），
 *      小学词若排在前面，会把原本的中考/高考词挤掉 —— 教材词应当靠"选词书/选标签"
 *      来取，而不是偷偷改变"全部"的取词结果。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORDS_JS = path.join(ROOT, 'miniprogram', 'data', 'words.js');
const CLOUD_JSON = path.join(ROOT, 'scripts', 'cloud-import', 'words.json');
const SOURCE = require('./data/waiyan4a.js');

const TAG = '外研四上';
const FREQ_BASE = 7000;
const checkOnly = process.argv.includes('--check');

function loadWords() {
  // 词库文件是 CommonJS：直接 require 拿到的就是数组（测试与页面也是这么拿的）
  delete require.cache[require.resolve(WORDS_JS)];
  return require(WORDS_JS);
}

function merge() {
  const words = loadWords();
  const byWord = {};
  words.forEach((w) => { byWord[w.word] = w; });

  let added = 0, tagged = 0, skipped = 0;
  SOURCE.forEach((s, i) => {
    if (!s.word) { skipped++; return; }
    const exist = byWord[s.word];
    if (exist) {
      // 已存在：补一个教材标签（同一份进度，不重复词条）
      exist.tags = exist.tags || [];
      if (exist.tags.indexOf(TAG) === -1) { exist.tags.push(TAG); tagged++; }
      else { skipped++; }
      return;
    }
    const row = {
      word: s.word,
      phonetic: s.phonetic || '',
      pos: s.pos || '',
      def_cn: s.def_cn || '',
      example_en: s.example_en || '',
      example_cn: s.example_cn || '',
      tags: [TAG],
      freq: FREQ_BASE + i
    };
    words.push(row);
    byWord[s.word] = row;
    added++;
  });
  return { words: words, added: added, tagged: tagged, skipped: skipped };
}

function render(words) {
  const lines = words.map((w) => {
    const tags = (w.tags || []).map((t) => "'" + t + "'").join(', ');
    return '  { word: ' + JSON.stringify(w.word) + ', phonetic: ' + JSON.stringify(w.phonetic) +
      ', pos: ' + JSON.stringify(w.pos) + ', def_cn: ' + JSON.stringify(w.def_cn) + ',\n' +
      '    example_en: ' + JSON.stringify(w.example_en) + ', example_cn: ' + JSON.stringify(w.example_cn) +
      ',\n    tags: [' + tags + '], freq: ' + w.freq + ' }';
  });
  return 'module.exports = [\n' + lines.join(',\n') + '\n];\n';
}

const r = merge();

if (checkOnly) {
  const bad = r.words.filter((w) => (w.tags || []).indexOf(TAG) >= 0).length;
  console.log('外研四上：词库内带该标签的词 ' + bad + ' 个（本次新增 ' + r.added +
    '、补标签 ' + r.tagged + '、已存在跳过 ' + r.skipped + '）');
  if (bad < SOURCE.length) {
    console.error('词库还不完整：应至少 ' + SOURCE.length + ' 个，实际 ' + bad);
    process.exit(1);
  }
  process.exit(0);
}

// 只替换数组部分，保留文件头那段说明（它记录了数据来源与许可，不能丢）
const src = fs.readFileSync(WORDS_JS, 'utf8');
const at = src.indexOf('module.exports = [');
if (at < 0) {
  console.error('没找到 module.exports = [ —— 词库文件格式变了，人工确认后再跑');
  process.exit(1);
}
const header = src.slice(0, at);
fs.writeFileSync(WORDS_JS, header + render(r.words), 'utf8');

// 云端导入文件与本地词库保持一致（导入云端后两边才对得上）
fs.writeFileSync(CLOUD_JSON, r.words.map((w) => JSON.stringify(w)).join('\n') + '\n', 'utf8');

console.log('外研四上导入完成：');
console.log('  新增词条 ' + r.added + ' 个');
console.log('  已有词补标签 ' + r.tagged + ' 个（共用一份学习进度，不重复出词）');
console.log('  词库总数 ' + r.words.length + ' → ' + WORDS_JS);
console.log('  云端导入文件已同步：' + CLOUD_JSON);
