/**
 * 导入词库测试：粘贴解析（wordimport）+ 拍照草稿箱（drafts）
 *
 * 覆盖的是"用户最容易白干一场"的地方：
 *   1) 复制出来的格式千奇百怪，解析错了要能看见哪几行没进去、为什么；
 *   2) 拍照草稿是"先拍后录"，录一半退出绝不能丢 —— 落盘时机错了这个功能就废了。
 */

var assert = require('assert');

var storage = {};
var unlinked = [];
global.wx = {
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  getFileSystemManager: function () {
    return {
      saveFile: function (o) { if (o.success) o.success({ savedFilePath: 'wxfile://saved_' + o.tempFilePath }); },
      unlink: function (o) { unlinked.push(o.filePath); if (o.success) o.success(); }
    };
  }
};

var importer = require('../miniprogram/utils/wordimport');
var drafts = require('../miniprogram/utils/drafts');
var books = require('../miniprogram/utils/books');

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('导入词库测试：');

/* ------------------------------ 粘贴解析 ------------------------------ */

ok('四种写法都认：等号 / 逗号 / 空格 / 只有单词', function () {
  var r = importer.parse('bus=公共汽车\nlibrary,图书馆\nhomework 家庭作业\nWednesday');
  assert.strictEqual(r.words.length, 4, '应解析出 4 个词，实际 ' + r.words.length);
  assert.strictEqual(r.words[0].word, 'bus');
  assert.strictEqual(r.words[0].def_cn, '公共汽车');
  assert.strictEqual(r.words[2].def_cn, '家庭作业');
  assert.strictEqual(r.words[3].def_cn, '', '只有单词时释义留空，但不该整行被丢');
});

ok('Excel 直接复制（tab 分隔）能用', function () {
  var r = importer.parse('bus\t公共汽车\nlibrary\t图书馆');
  assert.strictEqual(r.words.length, 2);
  assert.strictEqual(r.words[1].def_cn, '图书馆');
});

ok('行首序号要剥掉：带 1. / 2、 / (3) 都不能变成无效行', function () {
  var r = importer.parse('1. apple 苹果\n2、banana 香蕉\n(3) cat 猫');
  assert.strictEqual(r.words.length, 3, r.skipped.map(function (s) { return s.line + ':' + s.why; }).join(' | '));
  assert.strictEqual(r.words[0].word, 'apple');
  assert.strictEqual(r.words[2].word, 'cat');
});

ok('跳过的行必须写明原因（不能默默吞掉）', function () {
  var r = importer.parse('bus=公共汽车\n###不是单词\nbus=重复的');
  assert.strictEqual(r.words.length, 1);
  assert.strictEqual(r.skipped.length, 1, '重复那行要被跳过');
  assert.ok(r.skipped[0].why.indexOf('重复') >= 0, '跳过原因要能看懂：' + r.skipped[0].why);
  assert.ok(r.skipped[0].line, '要带上原文，用户才知道是哪一行');
});

ok('表头行（单词=英文 这类）不算词', function () {
  var r = importer.parse('单词=释义\nbus=公共汽车');
  assert.strictEqual(r.words.length, 1);
  assert.strictEqual(r.words[0].word, 'bus');
});

ok('上限 300：超了要跳并说明，不能无限灌', function () {
  // 得用真·字母组合：isWord 不认数字，用 w0/w1 会全被当成无效行（写测试时踩到）
  var A = 'abcdefghijklmnopqrstuvwxyz';
  var lines = [];
  for (var i = 0; i < 305; i++) lines.push(A[Math.floor(i / 26)] + A[i % 26]);
  var r = importer.parse(lines.join('\n'));
  assert.strictEqual(r.words.length, importer.MAX_WORDS);
  assert.ok(r.skipped.length === 5, '应跳过 5 行，实际 ' + r.skipped.length);
  assert.ok(r.skipped[0].why.indexOf('上限') >= 0);
});

ok('空输入不会炸，返回空结果', function () {
  var r = importer.parse('');
  assert.strictEqual(r.words.length, 0);
  assert.ok(r.skipped.length === 0 || r.skipped.length === 0);
  var r2 = importer.parse(null);
  assert.strictEqual(r2.words.length, 0);
});

/* ------------------------------ 拍照草稿 ------------------------------ */

ok('拍照后立刻建草稿：一个词没录也在（先拍后录的前提）', function () {
  storage[drafts.STORAGE_KEY] = [];
  var d = drafts.add('wxfile://a.jpg');
  assert.ok(d && d.id, '要返回带 id 的草稿');
  assert.strictEqual(drafts.list().length, 1);
  assert.deepStrictEqual(drafts.get(d.id).words, []);
});

ok('每加一个词立刻落盘：中途退出不丢（离线整理的命根子）', function () {
  storage[drafts.STORAGE_KEY] = [];
  var d = drafts.add('wxfile://b.jpg');
  drafts.setWords(d.id, [{ word: 'bus', def_cn: '公共汽车' }]);
  // 模拟"杀掉小程序再进来"：只读 storage，不看内存
  var back = null;
  JSON.parse(JSON.stringify(storage[drafts.STORAGE_KEY])).forEach(function (x) {
    if (x.id === d.id) back = x;
  });
  assert.ok(back, '草稿应该在 storage 里');
  assert.strictEqual(back.words.length, 1);
  assert.strictEqual(back.words[0].word, 'bus');
  assert.strictEqual(back.words[0].def_cn, '公共汽车');
});

ok('词数封顶（和粘贴导入同一把尺子）', function () {
  storage[drafts.STORAGE_KEY] = [];
  var d = drafts.add('wxfile://c.jpg');
  var many = [];
  for (var i = 0; i < drafts.MAX_WORDS + 20; i++) many.push({ word: 'w' + i, def_cn: '' });
  drafts.setWords(d.id, many);
  assert.strictEqual(drafts.get(d.id).words.length, drafts.MAX_WORDS);
});

ok('草稿有上限，超了淘汰最老的并删掉它的照片', function () {
  storage[drafts.STORAGE_KEY] = [];
  unlinked.length = 0;
  var first = null;
  for (var i = 0; i < drafts.MAX_DRAFTS + 3; i++) {
    var d = drafts.add('wxfile://p' + i + '.jpg');
    if (i === 0) first = d;
  }
  assert.strictEqual(drafts.list().length, drafts.MAX_DRAFTS, '草稿数必须封顶');
  assert.ok(!drafts.get(first.id), '最老的草稿该被淘汰');
  assert.ok(unlinked.indexOf('wxfile://p0.jpg') >= 0, '淘汰时要连照片一起删，别让本机文件白涨');
});

ok('删草稿：记录没了，照片也删了', function () {
  storage[drafts.STORAGE_KEY] = [];
  unlinked.length = 0;
  var d = drafts.add('wxfile://d.jpg');
  drafts.remove(d.id);
  assert.strictEqual(drafts.list().length, 0);
  assert.ok(unlinked.indexOf('wxfile://d.jpg') >= 0);
});

ok('重拍：换路径并删掉旧照片', function () {
  storage[drafts.STORAGE_KEY] = [];
  unlinked.length = 0;
  var d = drafts.add('wxfile://old.jpg');
  drafts.setPath(d.id, 'wxfile://new.jpg');
  assert.strictEqual(drafts.get(d.id).path, 'wxfile://new.jpg');
  assert.ok(unlinked.indexOf('wxfile://old.jpg') >= 0, '旧照片要清掉');
});

ok('id 不撞号：同一毫秒连建多份也不会互相覆盖', function () {
  storage[drafts.STORAGE_KEY] = [];
  var a = drafts.add('wxfile://x1.jpg');
  var b = drafts.add('wxfile://x2.jpg');
  var c = drafts.add('wxfile://x3.jpg');
  var ids = [a.id, b.id, c.id];
  assert.strictEqual(new Set(ids).size, 3, 'id 必须互不相同：' + ids.join(','));
  assert.strictEqual(drafts.list().length, 3);
});

/* ---------------------- 端到端：草稿 → 词库 → 能背 ---------------------- */

ok('草稿录完存成词库，切过去就能背到这些词', function () {
  storage[drafts.STORAGE_KEY] = [];
  storage[books.CUSTOM_KEY] = [];
  var d = drafts.add('wxfile://e.jpg');
  drafts.setWords(d.id, [
    { word: 'sweep', def_cn: '打扫' },
    { word: 'rubbish', def_cn: '垃圾' }
  ]);
  var key = books.addCustomBook('照片词表 10-19', drafts.get(d.id).words);
  assert.ok(key, '要返回新词库 key');
  var words = books.getWords(key);
  assert.strictEqual(words.length, 2, '自定义词库必须取得到（不能用前缀判断，会误伤 cet4）');
  assert.strictEqual(words[0].word, 'sweep');
  assert.strictEqual(words[0].def_cn, '打扫');
  drafts.remove(d.id);
  assert.strictEqual(drafts.list().length, 0);
});

console.log('\n通过：' + pass + ' 项' + (process.exitCode ? '，有失败' : ' ✓'));
process.exit(process.exitCode || 0);
