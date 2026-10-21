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
/** failTimes：先失败这么多次再成功 —— 用来验"超时自动重试"确实只重试一次 */
var cloud = { calls: [], result: null, fail: false, failMsg: '', failTimes: 0 };
var toast = [];
var modal = null;
var scrollCalls = [];             // pageScrollTo 的记录（jumpToFirstBad 用）
var navTitles = [];               // 导航栏标题的变化记录（ackTap 点击回执用）
var tabJumps = [];                // switchTab 的记录（存好回首页用）
var backs = 0;                    // navigateBack 次数
var fsSize = 120 * 1024;          // getFileInfo 报的文件大小，用例里可调
var compressCalls = [];           // compressImage 的调用记录（width/quality）

global.wx = {
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  getFileSystemManager: function () {
    return {
      readFile: function (o) { o.success({ data: 'QkFTRTY0' }); },
      saveFile: function (o) { o.success({ savedFilePath: 'wxfile://saved' }); },
      unlink: function (o) { if (o.success) o.success(); },
      getFileInfo: function (o) { o.success({ size: fsSize }); }
    };
  },
  compressImage: function (o) {
    compressCalls.push((o.compressedWidth || 0) + '/' + o.quality);
    o.success({ tempFilePath: o.src + '?q' + o.quality });
  },
  cloud: {
    callFunction: function (o) {
      cloud.calls.push(o.name);
      if (cloud.failTimes > 0) { cloud.failTimes--; o.fail({ errMsg: cloud.failMsg }); return; }
      if (cloud.fail) { o.fail({ errMsg: cloud.failMsg || 'cloud.callFunction:fail' }); return; }
      o.success({ result: cloud.result });
    }
  },
  showToast: function (o) { toast.push(o.title); },
  showModal: function (o) { modal = o; },
  navigateBack: function () { backs++; },
  switchTab: function (o) { tabJumps.push(o.url); },
  previewImage: function () {},
  pageScrollTo: function (o) { scrollCalls.push(o); },
  setNavigationBarTitle: function (o) { navTitles.push(o.title); },
  createSelectorQuery: function () {
    var q = {
      select: function () { return q; },
      selectViewport: function () { return q; },
      boundingClientRect: function () { return q; },
      scrollOffset: function () { return q; },
      // 假装第一个坏词在视口下方 500px、当前页面已滚 100px
      exec: function (cb) { cb([{ top: 500 }, { scrollTop: 100 }]); }
    };
    return q;
  }
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
  cloud.failMsg = '';
  cloud.failTimes = 0;
  cloud.result = { ok: true, text: '' };
  toast.length = 0;
  modal = null;
  scrollCalls.length = 0;
  navTitles.length = 0;
  tabJumps.length = 0;
  backs = 0;
  fsSize = 120 * 1024;
  compressCalls.length = 0;
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
  return ok('④b 图片被传输层拒（Payload Too Large）→ 提示靠太近重拍，不是"连不上"', function () {
    var d = reset();
    cloud.fail = true;
    cloud.failMsg = 'cloud.callFunction:fail Error: errCode: -401003 cloud function execution error ' +
      '(Payload Too Large)';
    var page = makePage(d.id);
    return tick(20).then(function () {
      assert.ok(page.data.ocrNote.indexOf('靠太近') >= 0, '提示要指向动作：' + page.data.ocrNote);
      assert.ok(page.data.ocrNote.indexOf('连不上') < 0, '不能误导用户去怀疑网络：' + page.data.ocrNote);
    });
  });
});

steps.push(function () {
  return ok('④c 未知 fail：原始 errMsg 必须露在提示里（用户截图就能定位，不用猜）', function () {
    var d = reset();
    cloud.fail = true;
    cloud.failMsg = 'cloud.callFunction:fail Error: errCode -401003 sdk wxcloud unknown error';
    var page = makePage(d.id);
    return tick(20).then(function () {
      assert.ok(page.data.ocrNote.indexOf('-401003') >= 0, '原始错误码要透出：' + page.data.ocrNote);
    });
  });
});

steps.push(function () {
  return ok('④d 图怎么压都超 500KB：走完压缩阶梯后停下，且一个字都没发给云函数', function () {
    var d = reset();
    fsSize = 600 * 1024;              // 每一档都超限
    var page = makePage(d.id);
    return tick(30).then(function () {
      assert.strictEqual(cloud.calls.length, 0, '超限的图不该发出去');
      assert.ok(page.data.ocrNote.indexOf('靠太近') >= 0, '提示要能看懂：' + page.data.ocrNote);
      assert.ok(compressCalls.indexOf('1600/60') >= 0, '阶梯要从 1600 起步');
      assert.ok(compressCalls.indexOf('900/40') >= 0, '阶梯要一路降到 900');
      assert.ok(compressCalls.indexOf('0/20') >= 0, '最后还有老基础库兜底档');
    });
  });
});

steps.push(function () {
  return ok('④e 真机 -504003（timed out）：指向超时配置，不能再说"云函数没连上"', function () {
    var d = reset();
    cloud.fail = true;
    // 真机原文：errCode: -504003 | errMsg: Invoking task timed out after 3 seconds
    cloud.failMsg = 'cloud.callFunction:fail Error: errCode: -504003 | errMsg: ' +
      'Invoking task timed out after 3 seconds';
    var page = makePage(d.id);
    return tick(40).then(function () {
      assert.ok(page.data.ocrNote.indexOf('超时') >= 0, '要认出这是超时：' + page.data.ocrNote);
      assert.ok(page.data.ocrNote.indexOf('60') >= 0, '要写明改到多少秒：' + page.data.ocrNote);
      assert.ok(page.data.ocrNote.indexOf('连不上') < 0, '这句是误导：' + page.data.ocrNote);
    });
  });
});

steps.push(function () {
  return ok('④f 超时自动重试一次：冷启动那次被掐，第二次函数热了就认出来', function () {
    var d = reset();
    cloud.failTimes = 1;              // 第一次超时，之后成功
    cloud.failMsg = 'cloud.callFunction:fail Error: errCode: -504003 | errMsg: timed out';
    cloud.result = { ok: true, text: 'apple 苹果\ntiger 老虎' };
    var page = makePage(d.id);
    return tick(40).then(function () {
      assert.strictEqual(cloud.calls.length, 2, '超时要重试一次，实际调了 ' + cloud.calls.length + ' 次');
      assert.strictEqual(page.data.words.length, 2, '重试成功就该把词填进来');
      assert.strictEqual(page.data.words[0].word, 'apple');
      assert.strictEqual(page.data.recognizing, false);
    });
  });
});

steps.push(function () {
  return ok('④g 只重试超时：图片太大这类重试一万次也一样，不能白等', function () {
    var d = reset();
    cloud.fail = true;
    cloud.failMsg = 'cloud.callFunction:fail Error: errCode: -401003 (Payload Too Large)';
    var page = makePage(d.id);
    return tick(40).then(function () {
      assert.strictEqual(cloud.calls.length, 1, '非超时错误只调一次，实际 ' + cloud.calls.length + ' 次');
    });
  });
});

steps.push(function () {
  return ok('④h 云端说"超时太小"：原样把去哪改讲清楚（不用用户自己猜）', function () {
    var d = reset();
    cloud.result = {
      ok: false, code: 'ENV_TIMEOUT_TOO_SMALL',
      msg: '云函数超时只给了 3 秒，识别跑不完',
      hint: '云开发控制台 → 云函数 → ocr → 配置 → 超时时间改成 60 秒'
    };
    var page = makePage(d.id);
    return tick(20).then(function () {
      assert.ok(page.data.ocrNote.indexOf('60') >= 0, '要写明改到多少秒：' + page.data.ocrNote);
      assert.ok(page.data.ocrNote.indexOf('云开发控制台') >= 0, '要写明去哪改：' + page.data.ocrNote);
      assert.strictEqual(cloud.calls.length, 1, '这种重试也没用，不该重试');
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
  return ok('⑦ 存之前挡住红框词：不弹确认框，还要把人带到坏词跟前（滚动+toast）', function () {
    var d = reset([{ word: 'apple', def_cn: '苹果' }, { word: '图书馆', def_cn: '' }]);
    var page = makePage(d.id);
    assert.strictEqual(page.data.badCount, 1, '「图书馆」不是英文单词，应标红');
    page.finish();
    assert.strictEqual(modal, null, '有错词时不该弹"存成词库？"');
    assert.ok(String(page.data.toast).indexOf('不像英文') >= 0, '页面提示要说清楚：' + page.data.toast);
    assert.ok(toast.join('|').indexOf('红底') >= 0, '顶部 toast 也要响一声（以前只写卡片底部，按钮旁边啥都看不见）：' + toast.join('|'));
    assert.strictEqual(scrollCalls.length, 1, '要滚动到坏词那里，实际滚了 ' + scrollCalls.length + ' 次');
    assert.strictEqual(scrollCalls[0].scrollTop, 100 + 500 - 140, '滚动位置 = 当前 100 + 元素 500 - 顶部余量 140');
    assert.strictEqual(page.data.words[1].flash, true, '坏词要闪一下标位');
    assert.strictEqual(drafts.list().length, 1, '草稿要留着，不能因为点了一下就没了');
  });
});

steps.push(function () {
  return ok('⑦b 闪完要熄灭：flash 只是临时标位，不能一直亮着', function () {
    var d = reset([{ word: '图书馆', def_cn: '' }]);
    var page = makePage(d.id);
    page.finish();
    assert.strictEqual(page.data.words[0].flash, true);
    return tick(2000).then(function () {
      assert.strictEqual(page.data.words[0].flash, false, '1.8s 后要恢复');
    });
  });
});

steps.push(function () {
  return ok('⑦c 全改好了再点：正常弹确认框，不再拦截', function () {
    var d = reset([{ word: 'apple', def_cn: '苹果' }]);
    var page = makePage(d.id);
    page.finish();
    assert.ok(modal, '没有坏词该弹"存成词库？"');
    assert.strictEqual(scrollCalls.length, 0, '不该滚动');
  });
});

steps.push(function () {
  return ok('⑦d 被拦时按钮自己变字：点了到底有没有生效，用户能自己看见', function () {
    var d = reset([{ word: '图书馆', def_cn: '' }]);
    var page = makePage(d.id);
    page.finish();
    assert.strictEqual(page.data.barHint, '先改好红底的词', '按钮文案要当场变，这是"点到了"的实证');
    return tick(2000).then(function () {
      assert.strictEqual(page.data.barHint, '', '1.8s 后恢复成「存成我的词库（N）」');
    });
  });
});

steps.push(function () {
  return ok('⑦e 页面显示构建号：截图就能分清"没改对"还是"版本没更新"', function () {
    var d = reset([{ word: 'apple', def_cn: '苹果' }]);
    var page = makePage(d.id);
    assert.ok(/^\d+\.\d+\.\d+/.test(String(page.data.ver)), '要能看出构建号：' + page.data.ver);
  });
});

steps.push(function () {
  return ok('⑦f 分步回执写进导航栏标题：走到哪一步、卡在哪，截图全知道', function () {
    var d = reset([{ word: 'apple', def_cn: '苹果' }]);
    var page = makePage(d.id);
    page.finish();
    var seq = navTitles.join(' → ');
    assert.ok(seq.indexOf('✓ 已点击 · 存成我的词库') >= 0, '第一拍要点名：' + seq);
    assert.ok(seq.indexOf('准备弹确认框') >= 0, '无坏词要走到弹确认框这一步：' + seq);
    // 取消确认框：标题要复原
    modal.success({ confirm: false });
    assert.strictEqual(navTitles[navTitles.length - 1], '对着照片录词', '取消后标题要复原');
  });
});

steps.push(function () {
  return ok('⑦g showModal 自身失败也要现形：标题显示出错原因，不能无声', function () {
    var d = reset([{ word: 'apple', def_cn: '苹果' }]);
    var page = makePage(d.id);
    page.finish();
    modal.fail(new Error('showModal:fail 调试模式吞弹窗'));
    assert.ok(navTitles.join('|').indexOf('✗ 出错') >= 0, '失败要写进标题：' + navTitles.join('|'));
    assert.ok(navTitles.join('|').indexOf('调试模式吞弹窗') >= 0, '原因也要带上：' + navTitles.join('|'));
  });
});

steps.push(function () {
  return ok('⑧ 正常入库：存成自定义词库并清掉草稿，然后直接跳回首页', function () {
    var d = reset([{ word: 'apple', def_cn: '苹果' }, { word: 'zoo', def_cn: '动物园' }]);
    var page = makePage(d.id);
    page.data.name = 'Unit 1';
    page.finish();
    assert.ok(modal, '应弹确认框');
    modal.success({ confirm: true });
    return tick(600).then(function () {
      assert.strictEqual(drafts.list().length, 0, '入库后草稿要删掉');
      assert.strictEqual(tabJumps.length, 1, '存好要跳转一次，实际 ' + JSON.stringify(tabJumps));
      assert.ok(String(tabJumps[0]).indexOf('pages/index/index') >= 0,
        '存好要 switchTab 回首页（用户不用自己找"存哪了"）：' + JSON.stringify(tabJumps));
      var key = books.getKey();
      var words = books.getWords(key);
      assert.strictEqual(words.length, 2);
      assert.strictEqual(words[0].word, 'apple');
      assert.strictEqual(words[0].def_cn, '苹果');
      assert.strictEqual(words[0]._k, undefined, '页面内临时字段不能进词库');
      assert.ok(String(books.currentName()).indexOf('Unit 1') >= 0, '当前词库要切到新存的这本：' + books.currentName());
    });
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
