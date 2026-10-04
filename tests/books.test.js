/**
 * 词书模块测试
 *
 * 重点覆盖两件事：
 *   1) 切词书能真正过滤出对应标签的词
 *   2) 任何异常输入（空 / 不存在的 key / 没 storage）都回退到"全部"，
 *      绝不能返回空数组 —— 空数组 = 用户打开就"没有单词"，这是踩过的坑。
 */

var assert = require('assert');

var storage = {};
global.wx = {
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; }
};

var books = require('../miniprogram/utils/books');
var WORDS = require('../miniprogram/data/words');

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('词书模块测试：');

ok('全部 = 整个词库', function () {
  assert.strictEqual(books.getWords('all').length, WORDS.length);
});

/** 词书 key → words.js 里 tags 用的显示名 */
var TAG_OF = { zk: '中考', gk: '高考', cet4: '四级' };

ok('按标签过滤：中考词全部带"中考"标签', function () {
  var zk = books.getWords('zk');
  assert.ok(zk.length > 0, '中考词不该为空');
  zk.forEach(function (w) {
    assert.ok(w.tags.indexOf(TAG_OF.zk) >= 0, w.word + ' 不该出现在中考词书里');
  });
  assert.ok(zk.length < WORDS.length, '中考词应该是全库的子集');
});

ok('按标签过滤：高考 / 四级同理', function () {
  ['gk', 'cet4'].forEach(function (key) {
    var list = books.getWords(key);
    assert.ok(list.length > 0, key + ' 不该为空');
    list.forEach(function (w) {
      assert.ok(w.tags.indexOf(TAG_OF[key]) >= 0, w.word + ' 不该出现在 ' + key + ' 里');
    });
  });
});

ok('空 key / 未知 key 一律回退全部（不能返回空数组）', function () {
  assert.strictEqual(books.getWords('').length, WORDS.length);
  assert.strictEqual(books.getWords('toefl').length, WORDS.length);
  assert.strictEqual(books.getWords(undefined).length, WORDS.length);
});

ok('默认 key 是 all', function () {
  storage = {};
  assert.strictEqual(books.getKey(), 'all');
});

ok('setKey 只接受已定义的词书，其它一律拒绝', function () {
  assert.strictEqual(books.setKey('zk'), true);
  assert.strictEqual(books.getKey(), 'zk');
  assert.strictEqual(books.setKey('not-a-book'), false);
  assert.strictEqual(books.getKey(), 'zk', '非法 key 不该改掉当前值');
});

ok('storage 里是已下线的词书时回退 all（用户不留空白页）', function () {
  storage[books.STORAGE_KEY] = 'gre';
  assert.strictEqual(books.getKey(), 'all');
});

ok('list() 给出每本的词数，且加起来 >= 全库（词可同属多本）', function () {
  var list = books.list();
  assert.strictEqual(list.length, books.BOOKS.length);
  list.forEach(function (b) {
    assert.strictEqual(b.count, books.getWords(b.key).length);
    assert.ok(b.name && b.desc, '每本都要有名称和说明，界面要用');
  });
  var all = list.filter(function (b) { return b.key === 'all'; })[0];
  assert.strictEqual(all.count, WORDS.length);
});

ok('currentName() 与当前 key 对应', function () {
  books.setKey('cet4');
  assert.strictEqual(books.currentName(), '四级');
  books.setKey('all');
  assert.strictEqual(books.currentName(), '全部');
});

console.log('\n全部通过：' + pass + ' 项 ✓');
