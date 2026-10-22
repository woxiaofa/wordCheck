/**
 * 拍照整理词表（D7"拍照上传"的落地形态：拍照 → 识别 → 核对修改 → 入库）
 *
 * 为什么单独一页：识别结果必须能逐条改；塞进导入页会两头都变小。
 * 关键体验有两层：
 *   1) 少打字 —— 英文词表照片交给云函数 ocr 认，认出来直接进列表；
 *   2) 说得清 —— 实测中文释义会被认成符号（"apple ·F"），所以每一行都是输入框，
 *      想改就改、想删就删，存之前还挡一道"这条不像英文"。
 * 另外**随时能停下**：每次改动 400ms 后写草稿，退出/切后台立刻 flush，
 * 下次从草稿箱进来接着改 —— 这才是"离线整理"的意思。
 */
var books = require('../../../utils/books');
var drafts = require('../../../utils/drafts');
var importer = require('../../../utils/wordimport');
var privacy = require('../../../utils/privacy');

var MAX_OCR_BYTES = 500 * 1024;   // 云函数入参上限 1MB，base64 膨胀 4/3，留余量
var SAVE_DELAY = 400;             // 输入防抖：连打一串字只写一次 storage

/**
 * 构建号 —— 每次上传体验版手动改这里。
 * 为什么写死：体验版的 wx.getAccountInfoSync 拿不到具体版本（只回 'trial'），
 * 而"改了没生效"和"版本没更新"从截图上分不清。写死后截图里能直接看出跑的是哪一版。
 */
var BUILD = '1.1.35';

/* ---------------------------- OCR 取文 ---------------------------- */

/** 顺便量一下文件多大：拿不到就报 0，让云端那道 700KB 闸兜底 */
function fileSize(file) {
  return new Promise(function (resolve) {
    var done = function (n) { resolve(n || 0); };
    try {
      var fs = wx.getFileSystemManager();
      if (fs && fs.getFileInfo) {
        fs.getFileInfo({ filePath: file, success: function (r) { done(r.size); }, fail: function () { done(0); } });
        return;
      }
    } catch (e) { /* 落到老接口 */ }
    if (wx.getFileInfo) {
      wx.getFileInfo({ filePath: file, success: function (r) { done(r.size); }, fail: function () { done(0); } });
    } else { done(0); }
  });
}

/** 压一张图：只负责"压"，量大小的事交给 compressForOcr */
function squeezeOnce(src, width, quality) {
  return new Promise(function (resolve, reject) {
    var opts = {
      src: src,
      quality: quality,
      success: function (r) {
        if (r && r.tempFilePath) resolve(r.tempFilePath);
        else reject(new Error('COMPRESS_FAIL'));
      },
      fail: function () { reject(new Error('COMPRESS_FAIL')); }
    };
    // 老基础库不认 compressedWidth：多传的参数会被忽略，真不支持就让它 fail 掉走下一档
    if (width) opts.compressedWidth = width;
    wx.compressImage(opts);
  });
}

/**
 * 压到 OCR 能收的大小。
 * 为什么先缩边长：真机原图 3000px 宽，光把质量降到 35 也还有 1MB+（base64 后必超
 * callFunction 的传输上限，真机上直接"云函数没连上"）。先缩到 1600/1200/900，
 * 再配合质量档，词表照片 200~400KB 就稳了，OCR 也够用。
 */
function compressForOcr(src) {
  var plans = [];
  [1600, 1200, 900].forEach(function (w) {
    [60, 40].forEach(function (q) { plans.push({ w: w, q: q }); });
  });
  plans.push({ w: 0, q: 40 }, { w: 0, q: 20 });   // 兜底：老基础库只认质量

  return new Promise(function (resolve, reject) {
    var i = 0;
    function next() {
      if (i >= plans.length) { reject(new Error('TOO_BIG')); return; }
      var p = plans[i++];
      squeezeOnce(src, p.w, p.q)
        .then(function (out) { return fileSize(out).then(function (size) { return [out, size]; }); })
        .then(function (pair) {
          // size=0 = 量不出来：别卡死用户，放行（云端 700KB 闸会拦真正超的）
          if (!pair[1] || pair[1] <= MAX_OCR_BYTES) { resolve(pair[0]); return; }
          next();
        })
        .catch(next);
    }
    next();
  });
}

function readBase64(file) {
  return new Promise(function (resolve, reject) {
    var fs = wx.getFileSystemManager();
    fs.readFile({
      filePath: file,
      encoding: 'base64',
      success: function (r) { resolve(r.data); },
      fail: function () { reject(new Error('READ_FAIL')); }
    });
  });
}

function callOcr(b64) {
  return new Promise(function (resolve, reject) {
    wx.cloud.callFunction({
      name: 'ocr',
      data: { action: 'recognize', image: b64 },
      success: function (res) { resolve(res && res.result); },
      fail: function (e) {
        // 2026-10-20 真机实锤：这里曾把所有 fail 一律吞成 CLOUD_FAIL —— 图片太大、
        // 超时、函数没部署，全显示"云函数没连上"，真机上没法排查。必须透传：
        var m = String((e && e.errMsg) || '');
        if (m.indexOf('Payload Too Large') >= 0 || m.indexOf('413') >= 0) {
          reject(new Error('PAYLOAD_TOO_LARGE')); return;
        }
        if (m.indexOf('FUNCTION_NOT_FOUND') >= 0 || m.indexOf('not found') >= 0) {
          reject(new Error('FUNC_MISSING')); return;
        }
        // 超时有四种写法，漏一种就又变成"云函数没连上"（2026-10-20 真机 -504003 踩实）：
        //   errCode: -504003 | errMsg: Invoking task timed out after 3 seconds
        if (m.indexOf('timed out') >= 0 || m.indexOf('timeout') >= 0 ||
            m.indexOf('-504003') >= 0 || m.indexOf('TIME_LIMIT') >= 0) {
          reject(new Error('CLOUD_TIMEOUT')); return;
        }
        reject(new Error('CLOUD_FAIL|' + m.slice(0, 70)));
      }
    });
  });
}

/** 云端/端上所有失败都要翻成一句人话 —— 用户不需要知道 TOO_LARGE 是什么 */
var OCR_TEXT = {
  TOO_BIG: '这张图压不小，靠太近重拍一张（只拍词表那几行）',
  TOO_LARGE: '图片传不过去，靠太近重拍一张（只拍词表那几行）',
  PAYLOAD_TOO_LARGE: '图片传不过去，靠太近重拍一张（只拍词表那几行）',
  COMPRESS_FAIL: '这张图压不小，重拍一张试试',
  READ_FAIL: '照片读不出来，重拍一张吧',
  FUNC_MISSING: '识别功能还没上线，过几分钟再点一次',
  // 超时和配置有关，得把"去哪改"写进提示，否则用户只会一遍遍重试。
  // 用一整句不用 \n：ocrNote 是 view 渲染的，\n 在 view 里不换行，只会变成一串空格。
  CLOUD_TIMEOUT: '识别超时（云函数默认只给 3 秒，认一张图要 3~5 秒）。去「云开发控制台 → 云函数 → ocr → 配置」把超时改成 60 秒；急用先手动录',
  ENV_TIMEOUT_TOO_SMALL: '云函数超时太小，识别跑不完。去「云开发控制台 → 云函数 → ocr → 配置」把超时改成 60 秒',
  CLOUD_FAIL: '云函数没连上，先手动录、回头再识别',
  OCR_UNAVAILABLE: '识别服务暂时连不上，先手动录、回头再识别',
  RATE_LIMIT: '识别太频繁了，歇一分钟再点「重新识别」',
  EMPTY: '这张图没认出文字，重拍一张（对准、光足、别反光）',
  BAD_IMAGE: '这张图读不出来，重拍一张吧'
};

function ocrErrorText(res) {
  var code = String((res && res.code) || '');
  if (OCR_TEXT[code]) return OCR_TEXT[code];
  return '识别没成功：' + ((res && res.msg) || '原因不明') + '。可以先手动录';
}

function localErrorText(err) {
  var msg = String((err && err.message) || '');
  var parts = msg.split('|');
  if (OCR_TEXT[parts[0]]) {
    // 带上原始尾码（如 CLOUD_FAIL|errCode…，截前 70 字）：用户一截图就能定位，不用猜
    return OCR_TEXT[parts[0]] + (parts[1] ? '（' + parts[1] + '）' : '');
  }
  return OCR_TEXT[msg] || '识别没成功，先手动录、回头再试一次';
}

/* ---------------------------- 词表合并 ---------------------------- */

/**
 * 给每条一个临时 key。
 * wx:key 不能用 word —— 输入框里改字母 word 就变，节点被重建，光标会跳。
 * _k 只在内存里用，落盘/入词库前会被 strip 掉。
 */
var keySeq = 0;
function nextKey() { keySeq += 1; return 'k' + keySeq; }

/** 这一格看起来不像英文单词吗（空的不算：清空输入框 = 这条不要了） */
function markBad(word) {
  var w = String(word || '').trim();
  return !!(w && !importer.isWord(w));
}

/**
 * 合并两批词：先来后到，同词只留一条。
 * 后到的只用来补前一条空着的释义 —— 用户已经改过的不能被识别结果盖掉。
 */
function mergeWords(existing, incoming) {
  var out = [];
  var at = {};
  function push(w, d) {
    var word = String(w == null ? '' : w).trim().replace(/\s+/g, ' ');
    if (!word) return;
    var k = word.toLowerCase();
    var def = String(d == null ? '' : d).trim();
    if (at[k] !== undefined) {
      var prev = out[at[k]];
      if (!prev.def_cn && def) prev.def_cn = def;
      return;
    }
    at[k] = out.length;
    out.push({ _k: nextKey(), word: word, def_cn: def, bad: markBad(word) });
  }
  (existing || []).forEach(function (x) { push(x && x.word, x && x.def_cn); });
  (incoming || []).forEach(function (x) { push(x && x.word, x && x.def_cn); });
  return out.slice(0, drafts.MAX_WORDS);
}

/** 红框行数：存之前必须清零，不然背的时候才发现词是错的 */
function countBad(list) {
  var n = 0;
  (list || []).forEach(function (x) { if (x && x.bad) n++; });
  return n;
}

/** 落盘/入词库前的形状：只留 word + def_cn（_k / bad 是页面内的临时字段） */
function plainWords(list) {
  var out = [];
  (list || []).forEach(function (x) {
    var w = String((x && x.word) || '').trim().replace(/\s+/g, ' ');
    if (!w) return;
    out.push({ word: w, def_cn: String((x && x.def_cn) || '').trim() });
  });
  return out;
}

Page({
  data: {
    id: '',
    img: '',
    imgBroken: false,
    name: '',
    w: '',
    d: '',
    focusW: false,
    words: [],
    badCount: 0,
    toast: '',
    recognizing: false,
    ocrNote: '',
    barHint: '',           // 底栏主按钮的临时文案：点完自己变字 = 证明这一下真的点到了
    ver: ''                // 运行中的版本号（体验版会显示 1.1.29 这种），截图就能核对
  },

  onLoad: function (q) {
    var id = (q && q.id) || '';
    this.readVersion();
    var d = drafts.get(id);
    if (!d) {
      this.setData({ toast: '这份草稿找不到了，回导入页重新拍一张吧' });
      return;
    }
    var words = mergeWords([], d.words);
    this.setData({
      id: id,
      img: d.path || '',
      name: d.name || '',
      words: words,
      badCount: countBad(words),
      imgBroken: false
    });
    // 第一次进来、还没词、也没识别过 → 自动认一遍（额度有限，只自动跑一次）
    if (!words.length && this.data.img && !d.ocr_at) this.doOcr();
  },

  /** 拿运行版本号：体验版是 1.1.29 这种，开发版没有版本号就用 envVersion 顶上 */
  readVersion: function () {
    var env = '';
    try {
      var acc = wx.getAccountInfoSync && wx.getAccountInfoSync();
      var p = acc && acc.miniProgram;
      env = (p && (p.version || p.envVersion)) || '';
    } catch (e) { /* 老基础库没有这个接口 */ }
    this.setData({ ver: env ? BUILD + ' · ' + env : BUILD });
  },

  /** 切后台 / 退出前把防抖里的改动强制落盘：不能等 400ms，进程可能就没了 */
  onHide: function () { this.flush(); },
  onUnload: function () {
    this.flush();
    if (this._flashTimer) { clearTimeout(this._flashTimer); this._flashTimer = null; }
    if (this._hintTimer) { clearTimeout(this._hintTimer); this._hintTimer = null; }
  },

  flush: function () {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this.data.id) drafts.setWords(this.data.id, plainWords(this.data.words));
  },

  /** 改动落盘（防抖）：连打一串字只写一次同步 storage */
  queueSave: function () {
    var self = this;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(function () {
      self._saveTimer = null;
      drafts.setWords(self.data.id, plainWords(self.data.words));
    }, SAVE_DELAY);
  },

  /* --------------------------- 识别 --------------------------- */

  doOcr: function () {
    var self = this;
    if (this.data.recognizing || !this.data.img) return;
    drafts.markOcr(this.data.id);            // 记一笔：下次进页面不再自动重跑
    this.setData({ recognizing: true, ocrNote: '', toast: '' });

    var before = this.data.words.length;
    var retried = false;

    /**
     * 超时自动重试一次，只重试超时。
     * 为什么值得重试：云函数冷启动（加载 wx-server-sdk）就要 1~2 秒，OCR.space 出网
     * 实测 1.7~2.5 秒，加起来第一次很容易撞上超时闸；第二次函数已经热着，大概率能过。
     * 为什么只重试超时：图片太大、函数没部署这类重试一万次也一样，白等还费额度。
     */
    function callWithRetry(b64) {
      return callOcr(b64).then(function (r) { return r; }, function (err) {
        if (String((err && err.message) || '').split('|')[0] !== 'CLOUD_TIMEOUT' || retried) throw err;
        retried = true;
        self.setData({ ocrNote: '第一次没跑完（云函数刚醒），正在重试…' });
        return callOcr(b64);
      });
    }

    compressForOcr(this.data.img)
      .then(readBase64)
      .then(callWithRetry)
      .then(function (res) {
        if (!res || !res.ok) { self.setData({ ocrNote: ocrErrorText(res) }); return; }
        var parsed = importer.parse(res.text);
        var merged = mergeWords(self.data.words, parsed.words);
        var added = merged.length - before;
        drafts.setWords(self.data.id, plainWords(merged));
        self.setData({ words: merged, badCount: countBad(merged) });

        if (!parsed.words.length) {
          self.setData({ ocrNote: '这张图没认出英文单词，重拍一张（对准、光足、别反光），或手动录' });
        } else if (parsed.skipped.length) {
          self.setData({ ocrNote: '认出 ' + parsed.words.length + ' 个词，另有 ' + parsed.skipped.length +
            ' 行没认准跳过了 —— 少没少对着照片看一眼' });
        } else if (added > 0) {
          self.setData({ ocrNote: '认出 ' + added + ' 个词，中文释义容易被认错，挨个核一遍再存' });
        } else {
          self.setData({ ocrNote: '这些词之前已经认出来了，没新的' });
        }
      })
      .catch(function (err) {
        self.setData({ ocrNote: localErrorText(err) });
      })
      .then(function () {
        self.setData({ recognizing: false });
      });
  },

  /* --------------------------- 录入 / 编辑 --------------------------- */

  onW: function (e) { this.setData({ w: e.detail.value, toast: '' }); },
  onD: function (e) { this.setData({ d: e.detail.value, toast: '' }); },
  onName: function (e) { this.setData({ name: e.detail.value }); },

  /** 行内改英文：只 setData 这一格，别整表重刷（整刷会让其它输入框闪一下） */
  onEditWord: function (e) {
    var i = Number(e.currentTarget.dataset.i);
    var v = e.detail.value;
    var row = this.data.words[i];
    if (!row) return;
    row.word = v;
    row.bad = markBad(v);
    var patch = { toast: '', badCount: countBad(this.data.words) };
    patch['words[' + i + '].word'] = v;
    patch['words[' + i + '].bad'] = row.bad;
    this.setData(patch);
    this.queueSave();
  },

  onEditDef: function (e) {
    var i = Number(e.currentTarget.dataset.i);
    var v = e.detail.value;
    if (!this.data.words[i]) return;
    var patch = { toast: '' };
    patch['words[' + i + '].def_cn'] = v;
    this.data.words[i].def_cn = v;
    this.setData(patch);
    this.queueSave();
  },

  /** 手动补一个：识别漏掉的兜底，也是识别彻底失败时唯一的出路 */
  addWord: function () {
    var w = String(this.data.w || '').trim();
    var d = String(this.data.d || '').trim();
    if (!w) { this.setData({ toast: '先填英文单词' }); return; }
    if (!importer.isWord(w)) { this.setData({ toast: '「' + w + '」不像英文单词' }); return; }
    var low = w.toLowerCase();
    var dup = false;
    this.data.words.forEach(function (x) {
      if (String(x.word).toLowerCase() === low) dup = true;
    });
    if (dup) { this.setData({ toast: '「' + w + '」已经录过了' }); return; }
    if (this.data.words.length >= drafts.MAX_WORDS) {
      this.setData({ toast: '一本词库最多 ' + drafts.MAX_WORDS + ' 个词' });
      return;
    }
    var words = this.data.words.concat([{ _k: nextKey(), word: w, def_cn: d, bad: false }]);
    drafts.setWords(this.data.id, plainWords(words));      // 立刻落盘：中途退出不丢
    var self = this;
    this.setData({ words: words, badCount: countBad(words), w: '', d: '', toast: '', focusW: false }, function () {
      self.setData({ focusW: true });          // focus 要变化才会重新聚焦，所以先 false 再 true
    });
  },

  removeWord: function (e) {
    var i = Number(e.currentTarget.dataset.i);
    var words = this.data.words.slice();
    words.splice(i, 1);
    drafts.setWords(this.data.id, plainWords(words));
    this.setData({ words: words, badCount: countBad(words), toast: '' });
  },

  /* --------------------------- 照片 --------------------------- */

  preview: function () {
    if (!this.data.img) return;
    wx.previewImage({ urls: [this.data.img], current: this.data.img });
  },

  retake: function () {
    var self = this;
    drafts.pickPhoto().then(function (path) {
      drafts.setPath(self.data.id, path);
      self.setData({ img: path, imgBroken: false, ocrNote: '' });
      self.doOcr();                            // 换图了就该认新的这张
    }).catch(function (err) { self.onPickError(err); });
  },

  onPickError: function (err) {
    if (privacy.onDenied(err)) return;          // 用户拒绝隐私指引：给一句人话
    if (err && err.message === 'CANCELED') return;   // 自己取消的，别弹提示
    wx.showToast({ title: '没拿到照片', icon: 'none' });
  },

  onImgError: function () {
    this.setData({ imgBroken: true });
  },

  /* --------------------------- 入库 --------------------------- */

  defaultName: function () {
    var d = new Date();
    return '照片词表 ' + (d.getMonth() + 1) + '-' + d.getDate();
  },

  /**
   * 分步回执：把保存流程的每一步都写进导航栏标题。
   * 为什么这么极端：真机上 toast / showModal / setData 的渲染都出现过"无声不响应"
   * （2026-10-21：ackTap 的标题能显示，但紧跟着的 showModal 就是不弹），只有
   * setNavigationBarTitle 每次都可靠。标题连起来就是一条执行轨迹 —— 卡在哪一步、
   * 有没有异常，用户截一张图全知道，不用再猜。
   */
  step: function (msg) {
    try { wx.setNavigationBarTitle({ title: msg }); } catch (e) { /* 标题改不了就算了 */ }
  },

  /** 标题复原为页面本来的标题 */
  restoreTitle: function () { this.step('对着照片录词'); },

  /** 任何异常都不许无声死掉：标题 + toast 同时现形 */
  crash: function (e) {
    // wx API 的 fail 回调给的是 {errMsg} 不是 Error，两个都要接住
    var m = String((e && (e.message || e.errMsg)) || e)
      .replace(/^showModal:fail\s*/, '').slice(0, 30);
    this.step('保存出错了');
    try { console.error('[organize] finish 出错：', e); } catch (e2) { /* 忽略 */ }
    try { wx.showToast({ title: '出错了：' + m, icon: 'none', duration: 4000 }); } catch (e3) { /* 忽略 */ }
  },

  finish: function () {
    var self = this;
    try {
      // 先挡一道：带着错词存进去，背的时候才发现就晚了。
      // 提示必须让人"当场看见"：以前 toast 写在核对卡片底部，而按钮在页面最下面，
      // 中间隔着一屏 —— 用户点按钮视口里什么都不发生，就像按钮坏了（2026-10-21 真机反馈）。
      // 所以现在三件事一起做：顶部 toast + 滚到第一个坏词 + 黄光闪烁标位。
      var bad = countBad(this.data.words);
      if (bad) {
        var me = this;
        // barHint 是"点到了"的实证：按钮自己变成这句话。用户看不到 toast 时，
        // 至少能分清"没点到按钮"还是"点到了但被拦住"（2026-10-21 反复说没反应）
        this.setData({
          badCount: bad,
          toast: '还有 ' + bad + ' 个不像英文单词（红底那些），改一下或删掉',
          barHint: '先改好红底的词'
        });
        this.step('还有 ' + bad + ' 个词要改');
        wx.showToast({ title: '先改好红底的词再存', icon: 'none' });
        // 触觉兜底：就算 toast 被键盘/悬浮球挡住，手上也有感觉
        try { if (wx.vibrateShort) wx.vibrateShort({ type: 'light' }); } catch (e) { /* 老机没有就算了 */ }
        this.jumpToFirstBad();
        if (this._hintTimer) clearTimeout(this._hintTimer);
        this._hintTimer = setTimeout(function () {
          me._hintTimer = null;
          me.setData({ barHint: '' });
          me.restoreTitle();                 // 坏词分支的终点：标题复原
        }, 1800);
        return;
      }
      var words = plainWords(this.data.words);
      if (!words.length) { this.setData({ toast: '还没有词呢' }); this.step('还没有词'); return; }
      var name = String(this.data.name || '').trim() || this.defaultName();
      wx.showModal({
        title: '存成词库？',
        content: '「' + name + '」共 ' + words.length + ' 个词，存好就直接用这本背了。',
        // confirmText 最多 4 个字，超了整个 showModal 直接 fail（2026-10-21 真机实锤：
        // "存，开始背"5 个字 → showModal:fail → 保存流程无声死掉，就是"点了没反应"的真凶）
        confirmText: '存好就背',
        cancelText: '再想想',
        // showModal 自己失败（真机调试模式下出现过）也必须现形，不能无声
        fail: function (e) { self.crash(e || new Error('showModal fail')); },
        success: function (res) {
          if (!res.confirm) { self.restoreTitle(); return; }
          try {
            self.step('正在存…');
            var key = books.addCustomBook(name, words);
            if (!key) { self.crash(new Error('词库没写进去')); return; }
            books.setKey(key);
            if (self._saveTimer) { clearTimeout(self._saveTimer); self._saveTimer = null; }
            drafts.remove(self.data.id);        // 入库了草稿就没用了（照片一并删）
            /**
             * 存完直接回首页：新词库当场生效，首页卡片、pill 列表都会变成这一本。
             * 以前 navigateBack 只退回导入页 —— 用户站在导入页里当然"不知道存哪了"
             * （2026-10-21 反馈：显示点击存好，但不知道在哪里）。
             */
            self.step('已存好');
            wx.showToast({ title: '已存好「' + name + '」', icon: 'none', duration: 1200 });
            setTimeout(function () {
              // 注意：本项目没有原生 tabBar（首页底栏是自制组件），switchTab 会
              // fail "can not switch to no-tabBar page"（2026-10-22 实锤）。
              // reLaunch 关闭全部页面再开首页，对任何页面都有效。
              wx.reLaunch({
                url: '/pages/index/index',
                fail: function (e) { self.crash(e || new Error('reLaunch fail')); }
              });
            }, 500);
          } catch (e2) { self.crash(e2); }
        }
      });
    } catch (e) {
      self.crash(e);
    }
  },

  /** 滚动到第一个坏词并闪 1.6s：长页面里"为什么存不了"必须自己走到用户眼前 */
  jumpToFirstBad: function () {
    var idx = -1;
    for (var i = 0; i < this.data.words.length; i++) {
      if (this.data.words[i].bad) { idx = i; break; }
    }
    if (idx < 0) return;
    var self = this;
    var on = {};
    on['words[' + idx + '].flash'] = true;
    this.setData(on);
    var q = wx.createSelectorQuery();
    q.select('#row-' + idx).boundingClientRect();
    q.selectViewport().scrollOffset();
    q.exec(function (res) {
      var rect = res && res[0];
      var view = res && res[1];
      if (rect && view) {
        wx.pageScrollTo({
          scrollTop: Math.max(0, view.scrollTop + rect.top - 140),   // 留出卡片上沿呼吸空间
          duration: 300
        });
      }
    });
    if (this._flashTimer) clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(function () {
      self._flashTimer = null;
      var off = {};
      off['words[' + idx + '].flash'] = false;
      self.setData(off);
    }, 1800);
  },

  /** "先存着"：草稿本就实时落盘，这里只是告诉用户一句，然后退回去 */
  saveLater: function () {
    var self = this;
    try {
      this.flush();
      if (this.data.name) drafts.setName(this.data.id, this.data.name);
      this.step('草稿已存');
      wx.showToast({ title: '已存 ' + this.data.words.length + ' 个词', icon: 'none' });
      setTimeout(function () {
        wx.navigateBack({
          fail: function (e) { self.crash(e || new Error('navigateBack fail')); }
        });
      }, 900);
    } catch (e) { this.crash(e); }
  },

  goBack: function () { this.flush(); wx.navigateBack(); }
});
