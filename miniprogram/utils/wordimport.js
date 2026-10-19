/**
 * 粘贴 / 表格导入词库（D7 承诺的第一步：拍照上传之前，先把"粘贴"这条路走通）
 *
 * 为什么先做它：老师在 Excel 里早就有课本词表（word + 中文），复制粘贴是零门槛动作；
 * 拍照 OCR 要处理版面、去重、补例句，成本高一个数量级，排在后面。
 * 两种入口共用同一套解析与同一份存储，后面加拍照只是多一个"产文本的源"。
 *
 * 支持的格式（一行一个词，按优先级猜分隔符）：
 *   bus=公共汽车        单词=释义
 *   bus,公共汽车        逗号（中文逗号也认）
 *   bus\t公共汽车        Excel 直接复制（tab）
 *   bus 公共汽车        空格
 *   bus                 只有单词，释义留空（照样能拼、能听写）
 */
var MAX_WORDS = 300;

/** 分隔符优先级：tab > 等号/冒号 > 逗号 > 空白 */
function splitLine(line) {
  var s = String(line || '').trim();
  if (!s) return null;
  // 先剥序号：Word / Excel 复制出来常常带 "1." "2、" "(3)" 这类前缀，
  // 不剥的话 "1. apple 苹果" 整行都不是英文词，会被当成无效行丢掉（实测踩过）
  s = s.replace(/^\(?\d+[.、)．]\s*/, '');
  var parts = null;
  if (s.indexOf('\t') >= 0) parts = s.split('\t');
  else if (s.indexOf('=') >= 0) parts = s.split('=');
  else if (s.indexOf('：') >= 0) parts = s.split('：');
  else if (s.indexOf(':') >= 0) parts = s.split(':');
  else if (s.indexOf('，') >= 0) parts = s.split('，');
  else if (s.indexOf(',') >= 0) parts = s.split(',');
  else {
    var m = s.match(/^([A-Za-z][A-Za-z'’\- ]*?)\s+(.+)$/);
    if (m) parts = [m[1], m[2]];
    else parts = [s];
  }
  var word = String(parts[0] || '').trim().replace(/^[\d.、)]+\s*/, '');   // 去掉"1."这类序号
  var def = String(parts[1] || '').trim();
  return { word: word, def: def };
}

function isWord(s) {
  return /^[A-Za-z][A-Za-z'’\- ]{0,29}$/.test(String(s || '').trim());
}

/**
 * 解析整段文本。
 * 返回 { words: [{word, def_cn}], skipped: [{line, why}], total }
 * 跳过规则写给人看：每一行为什么没进去都要能说出来，不能默默吞掉。
 */
function parse(text) {
  var words = [];
  var skipped = [];
  var seen = {};
  var lines = String(text || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var s = String(raw || '').trim();
    if (!s || s.charAt(0) === '#') continue;            // 空行与注释行
    if (/^(单词|word|english|英文)/i.test(s) && /(=|,|\t|，)/.test(s)) continue;   // 表头
    var p = splitLine(s);
    if (!p || !isWord(p.word)) {
      skipped.push({ line: s, why: '不像英文单词' });
      continue;
    }
    var key = p.word.toLowerCase();
    if (seen[key]) {
      skipped.push({ line: s, why: '和前面的词重复' });
      continue;
    }
    if (words.length >= MAX_WORDS) {
      skipped.push({ line: s, why: '超过 ' + MAX_WORDS + ' 个上限' });
      continue;
    }
    seen[key] = 1;
    words.push({ word: p.word, def_cn: p.def });
  }
  return { words: words, skipped: skipped, total: lines.length };
}

/** 样例：页面第一次打开时填在输入框里，省得用户猜格式 */
var SAMPLE = [
  'bus=公共汽车',
  'library,图书馆',
  'homework 家庭作业',
  'Wednesday=星期三'
].join('\n');

module.exports = {
  MAX_WORDS: MAX_WORDS,
  parse: parse,
  splitLine: splitLine,
  isWord: isWord,
  SAMPLE: SAMPLE
};
