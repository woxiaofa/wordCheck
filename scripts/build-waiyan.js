/**
 * 把外研版（三起）四年级上册词表并入本地词库
 *
 *   node scripts/build-waiyan.js           # 写入 miniprogram/data/words.js + 目录树 + 云端导入文件
 *   node scripts/build-waiyan.js --check   # 只校验是否已导入（用于 CI）
 *
 * 三条刻意的设计：
 *   1) **已存在的词只补标签，不建第二条**：ECDICT 那 300 词里已经有 fish / light /
 *      day 这类小学词，再插一条同名词会让"同一个词有两个进度"，抽查也可能连出两遍。
 *   2) **新词 freq 排在 7000+**：词库按 freq 升序取词（"全部"词库取前 N 个），
 *      小学词若排在前面，会把原本的中考/高考词挤掉 —— 教材词应当靠"选词书/选标签"
 *      来取，而不是偷偷改变"全部"的取词结果。
 *   3) **三级结构落在词条上（book / volume / unit / unit_order），目录树单独生成**：
 *      老师的核心动作是"布置 Unit 3"，所以必须能按单元取词，且**词序与课本一致**。
 *      词序不能靠 freq：freq 是全局词频，会把同一个 Unit 的词打散，
 *      孩子拿到手的顺序跟课本不一样，家长第一眼就觉得"这不对"。所以额外存 unit_order。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORDS_JS = path.join(ROOT, 'miniprogram', 'data', 'words.js');
const TREE_JS = path.join(ROOT, 'miniprogram', 'data', 'booktree.js');
const CLOUD_JSON = path.join(ROOT, 'scripts', 'cloud-import', 'words.json');
const SOURCE = require('./data/waiyan4a.js');
const UNITS = require('./data/waiyan4a.js').units || [];

/** 三级结构的恒等标记：这是"版本 → 册"两级，unit 在词条里 */
const BOOK_KEY = 'wy3s';          // 版本：外研版三年级起点
const BOOK_NAME = '外研版（三年级起点）';
const BOOK_DESC = '外语教学与研究出版社 · 三年级起点';
const VOLUME_KEY = 'wy4a';        // 册：四年级上册（与 utils/books.js 的词书 key 同名）
const VOLUME_NAME = '四年级上册';
const TAG = '外研四上';
const FREQ_BASE = 7000;
const checkOnly = process.argv.includes('--check');

function loadWords() {
  // 词库文件是 CommonJS：直接 require 拿到的就是数组（测试与页面也是这么拿的）
  delete require.cache[require.resolve(WORDS_JS)];
  return require(WORDS_JS);
}

/**
 * 给词条打三级标记。
 * unit_order 是"在本单元内的第几个"，布置整册时也按它排序，
 * 保证孩子看到的词序与课本一致（见文件头第 3 条）。
 */
function stampUnit(row, unitNo, orderInUnit) {
  row.book = BOOK_KEY;
  row.volume = VOLUME_KEY;
  row.unit = Number(unitNo) || 0;
  row.unit_order = Number(orderInUnit) || 0;
}

/**
 * 换版清理（2026-10-10 新版教材 6 Unit 替换旧版 10 Module 时加）：
 * words.js 里带着 wy4a 三级字段的旧词，凡是不在新词表里的——
 *   - freq >= 7000（当年为旧版专门加的）→ 整条删除：
 *     留着就是"幽灵词"，全部词库里还会被抽到；
 *   - freq < 7000（ECDICT 底库词被补过教材标签）→ 摘掉"外研四上"标签、
 *     清空三级字段，退回普通词（学习进度按 word 存，不受影响）。
 * 不清的后果是实打实的：旧 Unit 1 的 straight/ supermarket 还挂在 volume:wy4a,
 * unit:1 上，新版 Unit 1 的布置查询会把它们混进去 —— 词单对不上课本。
 */
function cleanStaleVolume(words) {
  const keep = new Set(SOURCE.map((s) => String(s.word)));
  let removed = 0, untagged = 0;
  const out = words.filter((w) => {
    if (w.volume !== VOLUME_KEY) return true;          // 只动本册
    if (keep.has(String(w.word))) return true;         // 新词表还在用的，字段由 reindex 重写
    if (Number(w.freq || 0) >= FREQ_BASE) { removed++; return false; }
    w.tags = (w.tags || []).filter((t) => t !== TAG);
    delete w.book; delete w.volume; delete w.unit; delete w.unit_order;
    untagged++;
    return true;
  });
  return { words: out, removed: removed, untagged: untagged };
}

function merge() {
  const cleaned = cleanStaleVolume(loadWords());
  const words = cleaned.words;
  const byWord = {};
  words.forEach((w) => { byWord[w.word] = w; });

  let added = 0, tagged = 0, skipped = 0;
  SOURCE.forEach((s, i) => {
    if (!s.word) { skipped++; return; }
    const exist = byWord[s.word];
    if (exist) {
      // 已存在：补一个教材标签 + 三级标记（同一份进度，不重复词条）
      exist.tags = exist.tags || [];
      if (exist.tags.indexOf(TAG) === -1) { exist.tags.push(TAG); tagged++; }
      else { skipped++; }
      stampUnit(exist, s.m, 0);   // 序号由 reindexUnitOrder 统一重算
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
    stampUnit(row, s.m, 0);
    words.push(row);
    byWord[s.word] = row;
    added++;
  });
  return { words: words, added: added, tagged: tagged, skipped: skipped,
    removed: cleaned.removed, untagged: cleaned.untagged };
}

/**
 * 重算 unit_order：不能用单元内出现顺序直接数 —— 同一个词可能先在 ECDICT 里存在
 * （被补标签的那批），计数会错位。统一按 SOURCE 里的原始次序重写一遍，
 * 保证"Unit 3 的第 1 个词"就是课本上的第一个词。
 */
function reindexUnitOrder(words) {
  const counter = {};
  SOURCE.forEach((s) => {
    if (!s.word) return;
    const w = words.find((x) => x.word === s.word);
    if (!w) return;
    counter[s.m] = (counter[s.m] || 0) + 1;
    w.unit = Number(s.m) || 0;
    w.unit_order = counter[s.m];
    w.book = BOOK_KEY;
    w.volume = VOLUME_KEY;
  });
  return words;
}

/** 单元名称表：no → name（拿不到就退回 "Unit N"，不许出现 undefined） */
function unitName(no) {
  for (const u of UNITS) if (u.no === Number(no)) return u.name;
  return 'Unit ' + no;
}

/** 生成目录树数据文件（供 utils/books.js 与老师端"按单元布置"使用） */
function buildTree(words) {
  const mine = words.filter((w) => w.volume === VOLUME_KEY);
  const counts = {};
  mine.forEach((w) => { counts[w.unit] = (counts[w.unit] || 0) + 1; });

  const units = UNITS.map((u) => ({
    no: u.no,
    name: u.name,
    count: counts[u.no] || 0
  }));

  return {
    books: [{
      key: BOOK_KEY,
      name: BOOK_NAME,
      desc: BOOK_DESC,
      volumes: [{
        key: VOLUME_KEY,
        name: VOLUME_NAME,
        tag: TAG,
        book_key: BOOK_KEY,
        // 每个 Unit 的收词上限（>5 词的 Unit 允许只布置一部分）
        units: units
      }]
    }]
  };
}

function renderTree(tree) {
  return '/*\n' +
    ' * 教材目录树（版本 → 册 → 单元）—— 由 scripts/build-waiyan.js 生成，请勿手改\n' +
    ' *\n' +
    ' * 为什么单独一个文件：老师的第一个动作是"布置 Unit 3"，\n' +
    ' * 而"四上有几个 Unit、每个 Unit 多少词"这件事必须在端上就能答，\n' +
    ' * 不能每次都去云端问一遍（离线也要能布置/续练）。\n' +
    ' * 词条侧的对应关系写在 words.js 的 book / volume / unit / unit_order 四个字段上。\n' +
    ' */\n\n' +
    'module.exports = ' + JSON.stringify(tree, null, 2) + ';\n';
}

function render(words) {
  const lines = words.map((w) => {
    const tags = (w.tags || []).map((t) => "'" + t + "'").join(', ');
    // 三级字段只给教材词写：其它词（中考/高考/四级）没有单元概念，
    // 写了只会让字段含义变得暧昧（unit:0 是个 Unit 还是"没有"？不写就是"没有"）
    const unitPart = w.volume
      ? ', book: ' + JSON.stringify(w.book) + ', volume: ' + JSON.stringify(w.volume) +
        ', unit: ' + Number(w.unit || 0) + ', unit_order: ' + Number(w.unit_order || 0)
      : '';
    return '  { word: ' + JSON.stringify(w.word) + ', phonetic: ' + JSON.stringify(w.phonetic) +
      ', pos: ' + JSON.stringify(w.pos) + ', def_cn: ' + JSON.stringify(w.def_cn) + ',\n' +
      '    example_en: ' + JSON.stringify(w.example_en) + ', example_cn: ' + JSON.stringify(w.example_cn) +
      ',\n    tags: [' + tags + '], freq: ' + w.freq + unitPart + ' }';
  });
  return 'module.exports = [\n' + lines.join(',\n') + '\n];\n';
}

// ⚠ 必须先快照磁盘上的原样，再 merge：merge 是在内存里补字段的，
// 拿 merge 后的结果做 --check 永远是"全部合格"（自己验自己，等于没验）
const before = checkOnly ? loadWords().map((w) => Object.assign({}, w)) : null;

const r = merge();
reindexUnitOrder(r.words);
const tree = buildTree(r.words);

if (checkOnly) {
  const bad = before.filter((w) => (w.tags || []).indexOf(TAG) >= 0).length;
  const noUnit = before.filter((w) => (w.tags || []).indexOf(TAG) >= 0 && !w.unit).length;
  const staleUnit = before.filter((w) => w.volume === VOLUME_KEY && Number(w.unit) > UNITS.length).length;
  const unitsOfNode = tree.books[0].volumes[0].units;
  const total = unitsOfNode.reduce((s, u) => s + u.count, 0);
  console.log('外研四上：词库内带该标签的词 ' + bad + ' 个（本次新增 ' + r.added +
    '、补标签 ' + r.tagged + '、已存在跳过 ' + r.skipped + '、清理删除 ' + r.removed +
    '、摘标签退回普通词 ' + r.untagged + '）');
  console.log('三级结构：' + UNITS.length + ' 个 Unit，共 ' + total + ' 词；缺 unit 字段 ' + noUnit + ' 个');
  if (staleUnit > 0) {
    console.error('仍有 ' + staleUnit + ' 个旧版 Unit（>' + UNITS.length + '）的词没清干净，先跑完整构建再 --check');
    process.exit(1);
  }
  if (bad < SOURCE.length) {
    console.error('词库还不完整：应至少 ' + SOURCE.length + ' 个，实际 ' + bad);
    process.exit(1);
  }
  if (noUnit > 0 || total !== bad) {
    console.error('三级结构不完整：缺 unit ' + noUnit + ' 个，目录树合计 ' + total + ' 词 vs 实际 ' + bad);
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
fs.writeFileSync(TREE_JS, renderTree(tree), 'utf8');

// 云端导入文件与本地词库保持一致（导入云端后两边才对得上）
fs.writeFileSync(CLOUD_JSON, r.words.map((w) => JSON.stringify(w)).join('\n') + '\n', 'utf8');

console.log('外研四上导入完成：');
console.log('  新增词条 ' + r.added + ' 个');
console.log('  已有词补标签 ' + r.tagged + ' 个（共用一份学习进度，不重复出词）');
console.log('  换版清理：删除旧版专加词条 ' + r.removed + ' 个、摘标签退回普通词 ' + r.untagged + ' 个');
console.log('  三级结构：' + BOOK_NAME + ' · ' + VOLUME_NAME + ' · ' + UNITS.length + ' 个 Unit');
UNITS.forEach((u) => {
  const c = tree.books[0].volumes[0].units.find((x) => x.no === u.no).count;
  console.log('    Unit ' + u.no + ' ' + u.name + '：' + c + ' 词');
});
console.log('  词库总数 ' + r.words.length + ' → ' + WORDS_JS);
console.log('  目录树 → ' + TREE_JS);
console.log('  云端导入文件已同步：' + CLOUD_JSON);
console.log('  ⚠ 记得重新执行 node scripts/export-words-for-cloud.js 后导入云端 words 集合');
