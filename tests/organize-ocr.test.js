/**
 * 拍照整理页 · 识别与核对测试
 *
 *   node tests/organize-ocr.test.js
 *
 * 这一页最容易出的事都不是"报错"，而是**安静地错**：
 *   1) 每次进草稿都重新识别一遍 —— OCR.space 免费额度 25000 次/月，几天就见底；
 *   2) 识别结果把用户已经改好的释义盖掉 —— 改了半天白改；
 *   3) 改动只停在屏幕上没落盘 —— 退出就丢，用户以为存好了；
 *   4) 带着红框错词存进词库 —— 背的时候才发现，等于白拍。
 * 所以下面每一条都对着这四个坑。
 */

var assert = require('assert');
var path = require('path');

/* ------------------------------ 环境桩 ------------------------------ */

var storage = {};
var cloud = { calls: [], result: null, fail: false };
var toast = [];
var modal = null;

global.wx = {
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  getFileSystemManager: function () {
    return {
      readFile: function (o) { o.success({ data: 'QkFTRTY0' }); },
      saveFile: function (o) { o.success({ savedFilePath: 'wxfile://saved' }); },
      unlink: function (o) { if (o.success) o.success(); }
    };
  },
  compressImage: function (o) { o.success({ tempFilePath: o.src + '?q' + o.quality }); },
  getFileInfo: function (o) { o.success({ size: 120 * 1024 }); },
  cloud: {
    callFunction: function (o) {
      cloud.calls.push(o.name);
      if (cloud.fail) { o.fail({ errMsg: 'cloud.callFunction:fail' }); return; }
      o.success({ result: cloud.result });
    }
  },
  showToast: function (o) { toast.push(o.title); },
  showModal: function (o) { modal = o; },
  navigateBack: function () {},
  previewImage: function () {}
};

var pageDef = null;
global.Page = function (def) { pageDef = def; };

var drafts = require('../miniprogram/utils/drafts');
var books = require('../miniprogram/utils/books');
require(path.resolve(__dirname, '../miniprogram/pkg-media/pages/organize/organize.js'));

/* ------------------------------ 工具 ------------------------------ */

var pass = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { pass++; console.log('  ✓ ' + name); })
    .catch(function (e) {
      console.log('  ✗ ' + name + '\n    ' + (e && e.message));
      if (process.env.VERBOSE) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'));
      process.exitCode = 1;
    });
}

/** setData 的 key 可能是 'words[2].word' 这种路径，得真按路径写进去 */
function setByPath(obj, key, val) {
  var m = /^([A-Za-z_$][\w$]*)\[(\d+)\]\.([\w$]+)$/.exec(key);
  if (!m) { obj[key] = val; return; }
  var arr = obj[m[1]];
  if (!arr || !arr[Number(m[2])]) return;
  arr[Number(m[2])][m[3]] = val;
}

function makePage(draftId) {
  var inst = {
    data: JSON.parse(JSON.stringify(pageDef.data)),
    setData: function (patch, cb) {
      Object.keys(patch).forEach(function (k) { setByPath(inst.data, k, patch[k]); });
      if (typeof cb === 'function') cb();
    }
  };
  Object.keys(pageDef).forEach(function (k) {
    if (typeof pageDef[k] === 'function') inst[k] = pageDef[k];
  });
  if (draftId !== undefined) {
    inst.onLoad({ id: draftId });
    inst._loaded = true;
  }
  return inst;
}

function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 5); }); }

function reset(words, imgPath) {
  Object.keys(storage).forEach(function (k) { delete storage[k]; });
  cloud.calls.length = 0;
  cloud.fail = false;
  cloud.result = { ok: true, text: '' };
  toast.length = 0;
  modal = null;
  storage[drafts.STORAGE_KEY] = [];
  storage[books.CUSTOM_KEY] = [];
  var d = drafts.add(imgPath === undefined ? 'wxfile://shot.jpg' : imgPath);
  if (words && words.length) drafts.setWords(d.id, words);
  return drafts.get(d.id);
}

/* ------------------------------ 用例 ------------------------------ */

var steps = [];

steps.push(function () {
  return ok('① 首次进来自动识别一次：认出英文词、中文乱码也照样进列表', function () {
    var d = reset();
    // 实测 OCR.space 的典型输出：英文准、中文变符号
    cloud.result = { ok: true, text: 'apple 苹果\ntiger ·F\nlibrary\nsweep' };
    var page = makePage(d.id);
    return tick(20).then(function () {
      assert.strictEqual(cloud.calls.length, 1, '应调用一次 ocr 云函数');
      assert.strictEqual(cloud.calls[0], 'ocr');
      assert.strictEqual(page.data.recognizing, false, '识别结束要把"正在认字"关掉');
      var ws = page.data.words.map(function (x) { return x.word; });
      assert.deepStrictEqual(ws, ['apple', 'tiger', 'library', 'sweep']);
      assert.strictEqual(page.data.words[0].def_cn, '苹果');
      assert.ok(page.data.ocrNote, '要告诉用户认出了几个、要不要核对');
      // 必须落盘：不落盘等于白认
      var back = drafts.get(d.id);
      assert.strictEqual(back.words.length, 4);
      assert.strictEqual(back.words[0].word, 'apple');
      assert.ok(back.ocr_at, '要记下"这张已识别"，不然下次进来又烧一次额度');
    });
  });
});

steps.push(function () {
  return ok('② 再进同一份草稿不重跑识别（额度只有 25000 次/月）', function () {
    var d = reset();
    cloud.result = { ok: true, text: 'apple' };
    var p1 = makePage(d.id);
    return tick(20).then(function () {
      assert.strictEqual(cloud.calls.length, 1);
      assert.strictEqual(p1.data.words.length, 1);
      var p2 = makePage(d.id);          // 退出再进来
      return tick(20).then(function () {
        assert.strictEqual(cloud.calls.length, 1, '第二次进来不该再调云函数');
        assert.strictEqual(p2.data.words.length, 1, '但从草稿读回来的词要在');
      });
    });
  });
});

steps.push(function () {
  return ok('②b 识别失败的草稿也不反复重跑（一进一出就烧一次额度）', function () {
    var d = reset();
    cloud.result = { ok: false, code: 'EMPTY', msg: '没识别出文字' };
    var p1 = makePage(d.id);
    return tick(20).then(function () {
      assert.strictEqual(cloud.calls.length, 1);
      assert.strictEqual(p1.data.words.length, 0, '失败时没有词，靠 ocr_at 挡住重跑');
      var p2 = makePage(d.id);
      return tick(20).then(function () {
        assert.strictEqual(cloud.calls.length, 1, '没词但识别过，也不该自动再跑');
        assert.ok(p2.data.ocrNote === '', '自动识别不会跑，就不该有上次的提示残留');
      });
    });
  });
});

steps.push(function () {
  return ok('③ 限频/失败：给一句人话，页面不崩、已录的词一个不丢', function () {
    var d = reset([{ word: 'bus', def_cn: '公共汽车' }]);
    var page = makePage(d.id);
    cloud.result = { ok: false, code: 'RATE_LIMIT', msg: '识别太频繁，歇一下再试' };
    page.doOcr();                       // 已有词时不会自动跑，这里模拟用户点「重新识别」
    return tick(20).then(function () {
      assert.strictEqual(cloud.calls.length, 1, '应该真发了一次请求');
      assert.strictEqual(page.data.recognizing, false);
      assert.ok(page.data.ocrNote.indexOf('歇') >= 0, '提示要能看懂：' + page.data.ocrNote);
      assert.strictEqual(page.data.words.length, 1, '已有的词不能被清掉');
      assert.strictEqual(page.data.words[0].word, 'bus');
    });
  });
});

steps.push(function () {
  return ok('④ 云函数连不上（fail 分支）也要落到人话，不能卡在"正在认字"', function () {
    var d = reset();
    cloud.fail = true;
    var page = makePage(d.id);
    return tick(20).then(function () {
      assert.strictEqual(page.data.recognizing, false, '失败也必须关掉识别中状态');
      assert.ok(page.data.ocrNote, '要有提示');
    });
  });
});

steps.push(function () {
  return ok('⑤ 合并去重：识别结果不覆盖用户已改好的释义，重复词只留一条', function () {
    var d = reset([{ word: 'Tiger', def_cn: '老虎' }]);
    var page = makePage(d.id);
    cloud.result = { ok: true, text: 'tiger ·F\nzoo 动物园\ntiger' };
    page.doOcr();
    return tick(20).then(function () {
      var ws = page.data.words;
      assert.strictEqual(ws.length, 2, '重复的 tiger 只留一条，实际：' + JSON.stringify(ws.map(function (x) { return x.word; })));
      assert.strictEqual(ws[0].word, 'Tiger', '先来的（用户录的）排前面');
      assert.strictEqual(ws[0].def_cn, '老虎', '用户改过的释义不能被识别结果盖掉');
      assert.strictEqual(ws[1].word, 'zoo');
    });
  });
});

steps.push(function () {
  return ok('⑥ 行内改英文：立刻标红 + 防抖后落盘（离开就 flush）', function () {
    var d = reset([{ word: 'apple', def_cn: '苹果' }]);
    var page = makePage(d.id);
    assert.strictEqual(page.data.words.length, 1, '前置：草稿里有一个词');
    page.onEditWord({ currentTarget: { dataset: { i: 0 } }, detail: { value: 'aple 苹果' } });
    assert.strictEqual(page.data.words[0].word, 'aple 苹果');
    assert.strictEqual(page.data.words[0].bad, true, '带中文/多词的行要标红');
    assert.strictEqual(page.data.badCount, 1);
    page.onUnload();                    // 模拟直接退出
    assert.strictEqual(drafts.get(d.id).words[0].word, 'aple 苹果', 'onUnload 必须强制 flush');
    assert.strictEqual(drafts.get(d.id).words[0].bad, undefined, 'bad 是页面内字段，不该写进 storage');
  });
});

steps.push(function () {
  return ok('⑦ 存之前挡住红框词：不弹确认框，只提示改哪几个', function () {
    var d = reset([{ word: 'apple', def_cn: '苹果' }, { word: '图书馆', def_cn: '' }]);
    var page = makePage(d.id);
    assert.strictEqual(page.data.badCount, 1, '「图书馆」不是英文单词，应标红');
    page.finish();
    assert.strictEqual(modal, null, '有错词时不该弹"存成词库？"');
    assert.ok(String(page.data.toast).indexOf('不像英文') >= 0, '提示要说清楚：' + page.data.toast);
    assert.strictEqual(drafts.list().length, 1, '草稿要留着，不能因为点了一下就没了');
  });
});

steps.push(function () {
  return ok('⑧ 正常入库：存成自定义词库并清掉草稿', function () {
    var d = reset([{ word: 'apple', def_cn: '苹果' }, { word: 'zoo', def_cn: '动物园' }]);
    var page = makePage(d.id);
    page.data.name = 'Unit 1';
    page.finish();
    assert.ok(modal, '应弹确认框');
    modal.success({ confirm: true });
    assert.strictEqual(drafts.list().length, 0, '入库后草稿要删掉');
    var key = books.getKey();
    var words = books.getWords(key);
    assert.strictEqual(words.length, 2);
    assert.strictEqual(words[0].word, 'apple');
    assert.strictEqual(words[0].def_cn, '苹果');
    assert.strictEqual(words[0]._k, undefined, '页面内临时字段不能进词库');
  });
});

steps.push(function () {
  return ok('⑨ 识别认不出词：不静默，告诉用户重拍或手动录', function () {
    var d = reset();
    cloud.result = { ok: true, text: '---\n###\n' };
    var page = makePage(d.id);
    return tick(20).then(function () {
      assert.strictEqual(page.data.words.length, 0);
      assert.ok(/重拍|手动/.test(page.data.ocrNote), '要给出下一步动作：' + page.data.ocrNote);
    });
  });
});

steps.reduce(function (p, s) { return p.then(s); }, Promise.resolve()).then(function () {
  console.log('\n通过：' + pass + ' 项' + (process.exitCode ? '，存在失败 ✗' : ' ✓'));
  process.exit(process.exitCode || 0);
});
