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

var STORAGE_KEY = 'word_book';

/** 词书定义：tag 是 words.js 里存的显示名（切词时已由 TAG_CN 转成中文） */
var BOOKS = [
  { key: 'all', name: '全部', desc: '中考 + 高考 + 四级混合', tag: null },
  { key: 'zk', name: '中考', desc: '初中核心词', tag: '中考' },
  { key: 'gk', name: '高考', desc: '高中核心词', tag: '高考' },
  { key: 'cet4', name: '四级', desc: '大学四级词', tag: '四级' },
  { key: 'wy4a', name: '外研四上', desc: '外研版四年级上册（三起）', tag: '外研四上' }
];

/**
 * 取某本词书的词表。
 * key 为空或不存在时回退到全部——用户清过 storage、或以后删掉某本词书时，
 * 不能因此变成"一个词都没有"（那是之前踩过的坑：40 词学完就空白）。
 */
function getWords(key) {
  if (!key || key === 'all') return WORDS;
  var book = null;
  for (var i = 0; i < BOOKS.length; i++) {
    if (BOOKS[i].key === key) { book = BOOKS[i]; break; }
  }
  if (!book || !book.tag) return WORDS;

  return WORDS.filter(function (w) {
    return (w.tags || []).indexOf(book.tag) >= 0;
  });
}

/** 当前词书 key（持久化） */
function getKey() {
  try {
    var k = wx.getStorageSync(STORAGE_KEY);
    return k && isValidKey(k) ? k : 'all';
  } catch (e) {
    return 'all';          // 非小程序环境（跑测试时）也能用
  }
}

function setKey(key) {
  if (!isValidKey(key)) return false;
  try { wx.setStorageSync(STORAGE_KEY, key); } catch (e) { /* 测试环境忽略 */ }
  return true;
}

function isValidKey(key) {
  for (var i = 0; i < BOOKS.length; i++) if (BOOKS[i].key === key) return true;
  return false;
}

/** 给界面用的词书列表（带每本的词数，让用户知道选了什么） */
function list() {
  return BOOKS.map(function (b) {
    return {
      key: b.key,
      name: b.name,
      desc: b.desc,
      count: getWords(b.key).length
    };
  });
}

/** 当前词书的名字，用于首页/学习页展示 */
function currentName() {
  var k = getKey();
  for (var i = 0; i < BOOKS.length; i++) if (BOOKS[i].key === k) return BOOKS[i].name;
  return '全部';
}

module.exports = {
  BOOKS: BOOKS,
  STORAGE_KEY: STORAGE_KEY,
  getWords: getWords,
  getKey: getKey,
  setKey: setKey,
  isValidKey: isValidKey,
  list: list,
  currentName: currentName
};
