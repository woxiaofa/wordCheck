/**
 * 从 ECDICT 切出小程序本地词库
 *
 *   node scripts/build-words.js <ecdict.csv 路径> [目标词数] [输出路径] [词频下限] [--probe]
 *   例：node scripts/build-words.js /tmp/ecdict.csv 300
 *       node scripts/build-words.js /tmp/ecdict.csv 300 out.js 1200 --probe   # 只看样本不写文件
 *
 * 【词频下限为什么必须存在】
 *   按词频升序直接取前 300，拿到的是 the / and / have / that / for —— 全部是功能词，
 *   用户早就会了，背它们毫无价值还有损产品可信度。所以必须跳过最高频的那一批。
 *   默认下限 1500 / 上限 6000：落在"初中核心到高中/四级"这一段。
 *   再低会混进 the/and/have 这类功能词，再高就偏生僻了。用 --probe 可以先看分布再定。
 *
 * 为什么用 ECDICT：
 *   - MIT 协议，可商用。释义文字是有版权风险的（见 docs/词库与发音方案.md），
 *     这是选数据源的第一标准，不是"词多"。
 *   - 自带音标、中文释义、考试标签（zk 中考 / gk 高考 / cet4 四级 / cet6 / ky 考研 /
 *     ielts / toefl / gre）、柯林斯星级、词频，正好对得上我们的字段规范。
 *
 * 两个已知缺口：
 *   1) **没有例句** —— ECDICT 不提供例句。生成的词库 example_en/example_cn 为空，
 *      卡片已做条件渲染（没有例句就不显示）。需要例句时另行批量生成（自撰无版权问题）。
 *   2) 音标用了西里尔字母 ә(U+04D9) 代替 IPA ə(U+0259)，脚本里统一规范化。
 *
 * 本脚本不联网、不写死任何词，纯机械切分，可重复执行。
 */

var fs = require('fs');
var path = require('path');

/** 注意：不能用 `Number(x) || 1200` —— 传 0 时会被当成 falsy 而取默认值 */
function numArg(v, dflt) {
  var n = Number(v);
  return (v === undefined || v === '' || isNaN(n)) ? dflt : n;
}

var csvPath = process.argv[2] || '/tmp/ecdict.csv';
var target = numArg(process.argv[3], 300);
var outPath = process.argv[4] || path.join(__dirname, '..', 'miniprogram', 'data', 'words.js');
var minFrq = numArg(process.argv[5], 1500);
var maxFrq = numArg(process.argv[6], 6000);      // 0 = 不限
var probe = process.argv.indexOf('--probe') >= 0;

/** 考试标签 → 产品里展示的词库名 */
var TAG_CN = {
  zk: '中考', gk: '高考', cet4: '四级', cet6: '六级',
  ky: '考研', ielts: '雅思', toefl: '托福', gre: 'GRE'
};
/** 只取这三类，覆盖 K12 + 大学基础，与产品定位（中考/高考/四六级）一致 */
var WANTED_TAGS = ['zk', 'gk', 'cet4'];

/* ---------------- CSV 解析 ---------------- */

function parseLine(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  var out = [], field = '', inQ = false;
  for (var i = 0; i < line.length; i++) {
    var c = line.charAt(i);
    if (inQ) {
      if (c === '"') {
        if (line.charAt(i + 1) === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/* ---------------- 字段清洗 ---------------- */

/** ECDICT 音标里的西里尔字母 ә → IPA ə，并补上斜杠 */
function normPhonetic(p) {
  var s = String(p || '').trim();
  if (!s) return '';
  s = s.replace(/\u04D9/g, '\u0259');   // ә → ə
  if (s.charAt(0) !== '/') s = '/' + s + '/';
  return s;
}

/**
 * 中文释义 → { pos, def }
 * translation 形如： "n. 东方人, 东正教徒\na. 东方的, 向东的, 自东的"
 *
 * ⚠️ 关键：不能直接取第一行。ECDICT 的中文义项按"名词优先"排列，
 *    于是 eastern 会变成"n. 东方人"、primary 变成"n. 原色"——都不是学生要背的那个意思。
 *    这一版 CSV 的 pos 字段（词性占比）是空的，拿不到权重，
 *    所以用 definition（WordNet 义项，按常用度排序）的第一个词性来挑对应的中文组。
 */
function parseTranslation(tr, wantPos) {
  var groups = String(tr || '').split('\\n');
  var parsed = [];

  for (var i = 0; i < groups.length; i++) {
    var raw = groups[i].trim();
    if (!raw) continue;
    var m = raw.match(/^([a-z]+)\.?\s*(.*)$/i);
    var pos = '', rest = raw;
    if (m) { pos = m[1].toLowerCase(); rest = m[2]; }
    rest = rest.replace(/\[[^\]]*\]/g, '');        // 去掉 [网络] [计] 这类标注
    var items = rest.split(/[,;，；]/).map(function (s) { return s.trim(); })
      .filter(function (s) {
        if (!s || s.length > 12) return false;
        if (/[()（）]/.test(s)) return false;      // 括号里的多是专业义项，不适合中小学生
        return true;
      });
    if (!items.length) continue;
    parsed.push({ pos: pos, def: items.slice(0, 2).join('；') });
  }
  if (!parsed.length) return null;

  var pick = parsed[0];
  if (wantPos) {
    for (var j = 0; j < parsed.length; j++) {
      if (posMatches(parsed[j].pos, wantPos)) { pick = parsed[j]; break; }
    }
  }
  return { pos: normalizePos(pick.pos), def: pick.def };
}

/** translation 里的词性是否命中想要的主词性 */
function posMatches(pos, want) {
  var p = String(pos || '').toLowerCase();
  if (want === 'n') return p === 'n' || p === 'noun';
  if (want === 'v') return p === 'v' || p === 'vt' || p === 'vi';
  if (want === 'a') return p === 'a' || p === 'adj' || p === 's';
  if (want === 'r') return p === 'adv' || p === 'r';
  return false;
}

/** 从 definition（WordNet 义项，按常用度排序）取主词性 */
function mainPosFromDefinition(def) {
  var m = String(def || '').match(/^\s*([a-z]+)\.?\s/i);
  if (!m) return '';
  var p = m[1].toLowerCase();
  if (p === 'n' || p === 'noun') return 'n';
  if (p === 'v' || p === 'vt' || p === 'vi') return 'v';
  if (p === 'a' || p === 's' || p === 'adj') return 'a';   // s = WordNet 的形容词卫星义
  if (p === 'r' || p === 'adv') return 'r';
  return '';
}

/** 词性标注统一成国内教材习惯的写法 */
function normalizePos(pos) {
  var p = String(pos || '').toLowerCase();
  if (p === 'a' || p === 's') return 'adj.';
  if (p === 'r') return 'adv.';
  if (!p) return '';
  return p + '.';
}

function parseTags(tagStr) {
  var parts = String(tagStr || '').split(/\s+/);
  var out = [];
  for (var i = 0; i < WANTED_TAGS.length; i++) {
    if (parts.indexOf(WANTED_TAGS[i]) >= 0) out.push(TAG_CN[WANTED_TAGS[i]]);
  }
  return out;
}

/* ---------------- 主流程 ---------------- */

console.log('读取 ' + csvPath + ' …');
var text = fs.readFileSync(csvPath, 'utf8');
var lines = text.split('\n');
console.log('  共 ' + lines.length + ' 行');

var header = parseLine(lines[0]);
var IDX = {};
header.forEach(function (h, i) { IDX[h.trim()] = i; });
['word', 'phonetic', 'translation', 'tag', 'frq', 'collins', 'oxford'].forEach(function (k) {
  if (IDX[k] === undefined) throw new Error('CSV 缺少字段：' + k);
});

var picked = [];
var seen = {};

for (var i = 1; i < lines.length; i++) {
  var line = lines[i];
  if (!line) continue;
  var f = parseLine(line);
  var word = (f[IDX.word] || '').trim().toLowerCase();

  // 只要纯小写字母单词：排除短语、带撇号/连字符的、以及过短的词
  if (!/^[a-z]{3,}$/.test(word)) continue;
  if (seen[word]) continue;

  var tags = parseTags(f[IDX.tag]);
  if (!tags.length) continue;                       // 不在中考/高考/四级范围

  var frq = Number(f[IDX.frq]) || 0;
  if (frq <= 0) continue;                           // 没有词频数据的一律跳过（多半是生僻义项）
  if (frq < minFrq) continue;                       // 跳过 the/and/have 这类功能词，见文件头说明
  if (maxFrq > 0 && frq > maxFrq) continue;         // 上限：不要生僻词

  var tr = parseTranslation(f[IDX.translation], mainPosFromDefinition(f[IDX.definition]));
  if (!tr || !tr.def) continue;                     // 没有可用中文释义的不要

  var phonetic = normPhonetic(f[IDX.phonetic]);
  if (!phonetic) continue;                          // 没音标的不要：卡片上会空一大块

  seen[word] = 1;
  picked.push({
    word: word,
    phonetic: phonetic,
    pos: tr.pos,
    def_cn: tr.def,
    example_en: '',
    example_cn: '',
    tags: tags,
    freq: frq,
    variant: '',
    _collins: Number(f[IDX.collins]) || 0,
    _oxford: Number(f[IDX.oxford]) || 0
  });
}

console.log('  符合中考/高考/四级 且有词频与释义：' + picked.length + ' 个');

// 排序：词频升序（越小越常用）→ 保证切出来的是"最常用的那批"
picked.sort(function (a, b) { return a.freq - b.freq; });

if (probe) {
  console.log('\n[probe] 候选 ' + picked.length + ' 个，词频区间 ' +
    picked[0].freq + ' – ' + picked[picked.length - 1].freq);
  [0, 30, 80, 150, 250, 400, 700, 1200].forEach(function (i) {
    if (i >= picked.length) return;
    var w = picked[i];
    console.log('  #' + i + '\t' + w.word + '\tfrq=' + w.freq + '\t' +
      w.pos + ' ' + w.def_cn + '\t[' + w.tags.join('/') + ']');
  });
  console.log('\n[probe] 未写入文件');
  process.exit(0);
}

var top = picked.slice(0, target);
console.log('  取前 ' + top.length + ' 个，词频区间 ' + top[0].freq + ' – ' + top[top.length - 1].freq);

/* ---------------- 输出 ---------------- */

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

var body = top.map(function (w) {
  return "  { word: '" + w.word + "', phonetic: '" + esc(w.phonetic) + "', pos: '" + w.pos +
    "', def_cn: '" + esc(w.def_cn) + "',\n" +
    "    example_en: '', example_cn: '',\n" +
    "    tags: [" + w.tags.map(function (t) { return "'" + t + "'"; }).join(', ') +
    "], freq: " + w.freq + " }";
}).join(',\n');

var out = "/*\n" +
  " * 本地词库（" + top.length + " 词）— 由 scripts/build-words.js 从 ECDICT 切出，请勿手改\n" +
  " *\n" +
  " * 数据来源：ECDICT（https://github.com/skywind3000/ECDICT），**MIT 协议**，可商用。\n" +
  " *   选它的第一理由不是词多，而是许可：释义文字是有版权的，抓取商业词典或竞品内容\n" +
  " *   是法律风险（见 docs/词库与发音方案.md）。切分规则：中考 / 高考 / 四级标签，\n" +
  " *   按当代语料库词频升序取前 " + top.length + " 个。\n" +
  " *\n" +
  " * 已知缺口：**没有例句**（ECDICT 不提供）。example_en / example_cn 全为空，\n" +
  " *   卡片已做条件渲染。要例句时需另行生成——自撰的例句无版权问题，别去抄词典。\n" +
  " *\n" +
  " * 重新生成：node scripts/build-words.js <ecdict.csv> " + top.length + "\n" +
  " *\n" +
  " * 用途：① 开发阶段没有云环境也能把流程跑通；② 内测打底。\n" +
  " * 正式词库必须放云存储/CDN 按需加载：小程序有包体积上限，全量词库一定会超。\n" +
  " * 字段含义见《实施手册》第四节。\n" +
  " */\n\n" +
  "module.exports = [\n" + body + "\n];\n";

fs.writeFileSync(outPath, out, 'utf8');
console.log('已写入 ' + outPath + '（' + top.length + ' 词，' +
  Math.round(Buffer.byteLength(out, 'utf8') / 1024) + ' KB）');

console.log('\n前 15 个词：');
top.slice(0, 15).forEach(function (w) {
  console.log('  ' + w.word + '  ' + w.phonetic + '  ' + w.pos + ' ' + w.def_cn +
    '  [' + w.tags.join('/') + ']  frq=' + w.freq);
});

/* ---------------- 生成后自检：质量问题不看样本是发现不了的 ---------------- */
console.log('\n自检：');
var noPhonetic = top.filter(function (w) { return !w.phonetic; });
var noPos = top.filter(function (w) { return !w.pos; });
var shortDef = top.filter(function (w) { return w.def_cn.length <= 1; });
var dup = {};
var dupCount = 0;
top.forEach(function (w) { if (dup[w.word]) dupCount++; dup[w.word] = 1; });

var tagStat = {}, posStat = {};
top.forEach(function (w) {
  w.tags.forEach(function (t) { tagStat[t] = (tagStat[t] || 0) + 1; });
  posStat[w.pos || '(无)'] = (posStat[w.pos || '(无)'] || 0) + 1;
});

console.log('  标签分布：' + Object.keys(tagStat).map(function (k) {
  return k + ' ' + tagStat[k];
}).join(' / '));
console.log('  词性分布：' + Object.keys(posStat).map(function (k) {
  return k + ' ' + posStat[k];
}).join(' / '));
console.log('  缺音标 ' + noPhonetic.length +
  ' · 缺词性 ' + noPos.length +
  ' · 释义过短 ' + shortDef.length +
  ' · 重复 ' + dupCount);
if (noPhonetic.length) console.log('  缺音标的词：' + noPhonetic.map(function (w) { return w.word; }).join(', '));
if (shortDef.length) console.log('  释义过短：' + shortDef.map(function (w) { return w.word + '=' + w.def_cn; }).join(', '));
