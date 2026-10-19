/**
 * 词书（按考试标签切分）
 *
 * 为什么现在就要有它：
 *   词库是按 tags（中考/高考/四级）切出来的混合库，但用户要背的其实是"我这本"——
 *   初三学生看到考研词会困惑，大学生看到中考词会觉得简单。选了词书，
 *   任务量、新词、抽查都只在这一本里出，用户才有"这是我的计划"的感觉。
 *
 * 为什么不按词书分别存学习进度：
 *   SRS 状态是按 word 存的（word_state_mirror[word]），不是按词书存的。
 *   切换词书时旧进度自然还在，切回来不用重学——这是刻意的设计，
 *   换词书不该等于清空努力。
 *
 * 当前是本地版（词库在包里）。云端版词书放云存储按需加载后，
 * 这里的 getWords() 换成按 bookId 拉取即可，调用方不用改。
 */

var WORDS = require('../data/words');
var TREE = require('../data/booktree');

var STORAGE_KEY = 'word_book';

/**
 * 词书定义：tag 是 words.js 里存的显示名（切词时已由 TAG_CN 转成中文）
 *
 * 顺序即界面顺序：外研四上排第一（2026-10-10 用户拍板 —— 产品主场景就是教材同步，
 * 老师家长打开词书列表第一眼就该看到它）；默认词书也是它（见 DEFAULT_KEY）。
 */
var DEFAULT_KEY = 'wy4a';
var BOOKS = [
  { key: 'wy4a', name: '外研四上', desc: '外研版（三起）·四年级上册·2024新版', tag: '外研四上' },
  { key: 'all', name: '全部', desc: '中考 + 高考 + 四级混合', tag: null },
  { key: 'zk', name: '中考', desc: '初中核心词', tag: '中考' },
  { key: 'gk', name: '高考', desc: '高中核心词', tag: '高考' },
  { key: 'cet4', name: '四级', desc: '大学四级词', tag: '四级' }
];

/**
 * 取某本词书的词表。
 * key 为空或不存在时回退到全部——用户清过 storage、或以后删掉某本词书时，
 * 不能因此变成"一个词都没有"（那是之前踩过的坑：40 词学完就空白）。
 */
function getWords(key) {
  if (!key || key === 'all') return WORDS;
  // 自定义词库：直接回它的词表（字段已补齐，下游无需区分）。
  // 注意不能用前缀判断 key —— 内置词书 cet4 也以 c 开头（踩过一次，cet4 变空）
  var c = key ? findCustom(key) : null;
  if (c) return (c.words || []);
  var book = null;
  for (var i = 0; i < BOOKS.length; i++) {
    if (BOOKS[i].key === key) { book = BOOKS[i]; break; }
  }
  if (!book || !book.tag) return WORDS;

  return WORDS.filter(function (w) {
    return (w.tags || []).indexOf(book.tag) >= 0;
  });
}

/** 当前词书 key（持久化）。没存过 / 存的是已下线的词书 → 默认外研四上（教材同步是主场景） */
function getKey() {
  try {
    var k = wx.getStorageSync(STORAGE_KEY);
    return k && isValidKey(k) ? k : DEFAULT_KEY;
  } catch (e) {
    return DEFAULT_KEY;      // 非小程序环境（跑测试时）也能用
  }
}

function setKey(key) {
  if (!isValidKey(key)) return false;
  try { wx.setStorageSync(STORAGE_KEY, key); } catch (e) { /* 测试环境忽略 */ }
  return true;
}

/* ---------------- 自定义词库（粘贴 / 表格导入，2026-10-19） ---------------- */

var CUSTOM_KEY = 'word_books_custom';

/** 用户自己导入的词库：[{ key, name, words:[{word, def_cn}], created_at }] */
function customBooks() {
  try {
    var arr = wx.getStorageSync(CUSTOM_KEY);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveCustomBooks(arr) {
  try { wx.setStorageSync(CUSTOM_KEY, arr); } catch (e) { /* 测试环境忽略 */ }
}

/**
 * 存一本自定义词库。
 * 词对象补齐与内置词表一致的字段（unit/unit_order/volume），这样下游（学习、
 * 巩固轮、错词本）完全不用知道它来自导入 —— 换一个数据源不该改调用方。
 */
function addCustomBook(name, words) {
  if (!words || !words.length) return null;
  var arr = customBooks();
  var key = 'c' + Date.now();
  var list = words.map(function (w, i) {
    return {
      word: w.word,
      def_cn: w.def_cn || '',
      phonetic: '',
      pos: '',
      tags: ['自定义'],
      volume: 'custom',
      unit: 1,
      unit_order: i + 1
    };
  });
  arr.push({ key: key, name: (name || '我的词库').slice(0, 12), words: list, created_at: Date.now() });
  saveCustomBooks(arr);
  return key;
}

function removeCustomBook(key) {
  var arr = customBooks().filter(function (b) { return b.key !== key; });
  saveCustomBooks(arr);
  // 正用着这本就退回默认：不能出现"选了不存在的词库 → 一个词都没有"
  if (getKey() === key) setKey(DEFAULT_KEY);
  return true;
}

function findCustom(key) {
  var arr = customBooks();
  for (var i = 0; i < arr.length; i++) if (arr[i].key === key) return arr[i];
  return null;
}

function isValidKey(key) {
  for (var i = 0; i < BOOKS.length; i++) if (BOOKS[i].key === key) return true;
  return !!findCustom(key);
}

/** 给界面用的词书列表（带每本的词数，让用户知道选了什么） */
function list() {
  var out = BOOKS.map(function (b) {
    return { key: b.key, name: b.name, desc: b.desc, count: getWords(b.key).length };
  });
  customBooks().forEach(function (b) {
    out.push({
      key: b.key,
      name: b.name,
      desc: '自己导入 · ' + (b.words || []).length + ' 个词',
      count: (b.words || []).length,
      custom: true
    });
  });
  return out;
}

/** 当前词书的名字，用于首页/学习页展示 */
function currentName() {
  var k = getKey();
  for (var i = 0; i < BOOKS.length; i++) if (BOOKS[i].key === k) return BOOKS[i].name;
  var c = findCustom(k);
  return c ? c.name : '全部';
}

/* ------------------------------------------------------------------ */
/* 教材三级结构：版本 → 册 → 单元                                       */
/* ------------------------------------------------------------------ */

/**
 * 为什么这一层必须存在：K12 场景里家长判断"这个能不能用"只看一条——教材同步不。
 * 老师的第一个动作是"布置 Unit 3"，不是"布置 10 个中考词"。
 * 所以除了原有的按标签切词库，还得能按 (册, 单元) 精确取词，且**词序必须与课本一致**。
 */

/** 全部册（扁平化，给选择器用）：[{ key, name, tag, bookName, count }] */
function volumes() {
  var out = [];
  (TREE.books || []).forEach(function (b) {
    (b.volumes || []).forEach(function (v) {
      var n = WORDS.filter(function (w) { return w.volume === v.key; }).length;
      out.push({
        key: v.key,
        name: v.name,
        tag: v.tag || '',
        bookKey: b.key,
        bookName: b.name,
        count: n,
        // 端上一次给全：选择器不需要二次请求，离线也能用
        units: (v.units || []).map(function (u) {
          return { no: u.no, name: u.name, count: u.count };
        })
      });
    });
  });
  return out;
}

function findVolume(volumeKey) {
  var vs = volumes();
  for (var i = 0; i < vs.length; i++) if (vs[i].key === volumeKey) return vs[i];
  return null;
}

/** 某册的单元列表：[{ no, name, count }]；册不存在时返回空数组（不抛，方便界面兜底） */
function unitsOf(volumeKey) {
  var v = findVolume(volumeKey);
  return v ? v.units : [];
}

/**
 * 取某册某单元的词，按课本顺序（unit_order）排。
 * @param {string} volumeKey 册 key，如 'wy4a'
 * @param {number|string} unitNo 单元号（1 起）；传 0 / 空表示整册（按 unit → unit_order 排）
 */
function getWordsByUnit(volumeKey, unitNo) {
  var no = Number(unitNo) || 0;
  var list = WORDS.filter(function (w) {
    if (w.volume !== volumeKey) return false;
    return no ? (Number(w.unit) === no) : !!w.unit;
  });
  list.sort(function (a, b) {
    var ua = Number(a.unit) || 0, ub = Number(b.unit) || 0;
    if (ua !== ub) return ua - ub;
    return (Number(a.unit_order) || 0) - (Number(b.unit_order) || 0);
  });
  return list;
}

/** 单元的可读标签："四年级上册 · Unit 3 公园里"（作业名与页面标题都用它） */
function unitLabel(volumeKey, unitNo) {
  var v = findVolume(volumeKey);
  if (!v) return '';
  var no = Number(unitNo) || 0;
  if (!no) return v.bookName + ' · ' + v.name;
  var name = '';
  v.units.forEach(function (u) { if (u.no === no) name = u.name; });
  return v.bookName + ' · ' + v.name + ' · Unit ' + no + (name ? ' ' + name : '');
}

module.exports = {
  BOOKS: BOOKS,
  STORAGE_KEY: STORAGE_KEY,
  CUSTOM_KEY: CUSTOM_KEY,
  DEFAULT_KEY: DEFAULT_KEY,
  customBooks: customBooks,
  addCustomBook: addCustomBook,
  removeCustomBook: removeCustomBook,
  getWords: getWords,
  getKey: getKey,
  setKey: setKey,
  isValidKey: isValidKey,
  list: list,
  currentName: currentName,
  volumes: volumes,
  unitsOf: unitsOf,
  findVolume: findVolume,
  getWordsByUnit: getWordsByUnit,
  unitLabel: unitLabel
};
