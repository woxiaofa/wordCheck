/**
 * 学员学习报告（独立页面，2026-10-10）
 *
 * 为什么从班级页的内联展开改成独立页：
 *   ① 报告内容越来越长（简报 + 荣誉 + 作业完成度 + 最近评分 + 字母级诊断），
 *      塞在学员卡下面，学员一多整页就乱 —— 家长/老师只想看"这一个孩子"时也得滚半天；
 *   ② 独立页才谈得上"大方、专业"：可以有头部、分区、留白，也才谈得上
 *      以后的打印与分享成图（一个折叠区没法导出成一张能打印的纸）。
 *
 * 数据只有一份真相：cloud.api.studentDetail（与学员端同一句简报文案、同一份荣誉词）。
 * 权限在云端把关（只有本班教练能看），所以分享出去的链接别人打开会收到明确提示，
 * 而不是泄露别人的学习数据 —— 页面只需把 FORBIDDEN 翻成人话。
 */

var theme = require('../../utils/theme');
var cloud = require('../../utils/cloud');
var time = require('../../utils/time');
var wrongLib = require('../../utils/wrong');
var privacy = require('../../utils/privacy');
var links = require('../../utils/links');

Page({
  data: {
    skin: theme.cls(),
    sid: '',
    loading: true,
    error: '',
    dateText: '',
    clsName: '',
    student: null,        // { nickname, avatar, stats }
    status: null,         // { icon, label, tone }：与班级页同一套状态五档
    summary: null,        // 今日简报（含 honor）
    kpis: [],             // 三个核心数字
    assignments: [],
    logs: [],
    wrongTop: [],         // 错得最多的词
    mistakeTop: [],       // 错法归类
    letterTop: [],        // 字母混淆对
    wrongCounted: 0,
    hasWrongStat: false,
    making: false         // 正在生成长图（防重复点）
  },

  onShow: function () {
    theme.applyNav();                // 导航栏是系统控件，CSS 变量管不到它
  },

  onLoad: function (query) {
    var sid = query.sid || query.id || '';
    if (!sid) {
      this.setData({ loading: false, error: '缺少学员参数，请从班级页点学员卡进入' });
      return;
    }
    this.setData({ sid: sid, dateText: this.fmtDate(Date.now()) });
    this.load(sid);
  },

  /* ---------------- 数据 ---------------- */

  load: function (sid) {
    var self = this;
    var detail = null;
    this.setData({ loading: true, error: '' });
    wx.showLoading({ title: '生成报告中…' });
    cloud.api.studentDetail(sid).then(function (r) {
      detail = r;
      // 班级名只用于报告头和长图落款，拿不到也不阻塞正文
      return cloud.api.myClass().catch(function () { return {}; });
    }).then(function (clsRes) {
      var patch = self.build(detail);
      // 服务端带回的班级名优先（转发链路的打开者自己没有班，myClass 拿不到）
      patch.clsName = detail.class_name || (clsRes && clsRes.class && clsRes.class.name) || '';
      wx.hideLoading();
      self.setData(patch);
      // 标题带学员名：几十个学员来回切时不至于分不清在看谁
      var who = (patch.student && patch.student.nickname) || '';
      if (who) wx.setNavigationBarTitle({ title: who + ' 的报告' });
    }).catch(function (err) {
      wx.hideLoading();
      // 权限/成员不匹配时云端回 FORBIDDEN：翻成家长看得懂的话，不要甩错误码
      var msg = cloud.humanError(err);
      self.setData({ loading: false, error: msg });
      console.warn('[report] 加载失败', err);
    });
  },

  /** 把服务端原始数据摊平成"页面直接能渲染"的结构（拼接逻辑不进 wxml） */
  build: function (r) {
    var self = this;
    var stu = r.student || {};
    var summary = r.summary || null;
    var rawLogs = r.recent_logs || [];

    var logs = rawLogs.slice(0, 20).map(function (l) {
      return {
        word_text: l.word_text || l.word_id || '',
        translation: l.translation || '',
        ok: l.feedback === 'known',
        spot: l.wrong_answer ? wrongLib.spotLabel(l.word_text, l.wrong_answer) : '',
        typed: l.wrong_answer || '',
        timeText: l.created_at ? self.fmtTime(l.created_at) : ''
      };
    });

    // 字母级诊断：只认带错拼原文的记录（老客户端没上报的自动略过，宁少勿猜）
    var rows = rawLogs.filter(function (l) { return !!l.wrong_answer; })
      .map(function (l) { return { word: l.word_text || l.word_id, wrong: l.wrong_answer }; });
    var kinds = [];
    var pairs = [];
    rows.forEach(function (x) {
      var k = wrongLib.mistakeKind(x.word, x.wrong);
      if (k && k !== '其它' && k !== '相同') kinds.push(k);
      var p = wrongLib.singleLetterPair(x.word, x.wrong);
      if (p) pairs.push(p);
    });
    var topWords = wrongLib.topWords(rows.map(function (x) { return { word: x.word }; }), 5);
    var transMap = {};
    rawLogs.forEach(function (l) { if (l.word_text) transMap[l.word_text] = l.translation || ''; });

    var kpis = [];
    if (summary) {
      kpis.push({ num: String(summary.learned || 0), label: '今日练词' });
      // 掌握率优先用云端算好的 rate（含 drill 主流程的 review_logs 口径）。
      // 兜底：老版本云函数还没下发 rate 时退回只看 quiz_items，不至于显示成 —。
      var rateNum = (summary.rate === 0 || summary.rate) ? summary.rate
        : (summary.quiz_total ? Math.round(summary.mastered / summary.quiz_total * 100) : null);
      kpis.push({ num: rateNum === null ? '—' : (rateNum + '%'), label: '今日掌握率' });
      kpis.push({ num: String((stu.stats && stu.stats.learned_words) || 0), label: '累计学词' });
    }

    return {
      loading: false,
      error: '',
      student: stu,
      summary: summary,
      kpis: kpis,
      assignments: (r.assignments || []).map(function (a) {
        return {
          name: a.name || a.note || a.tag + '作业',
          done: a.done || 0,
          count: a.count || 0,
          pct: a.count ? Math.round(a.done * 100 / a.count) : 0,
          personalized: !!a.personalized,
          deadline: a.deadline || ''
        };
      }),
      logs: logs,
      status: this.statusOf(stu, summary),
      wrongTop: topWords.map(function (w) {
        return { word: w.word, cnt: w.cnt, trans: (transMap[w.word] || '').slice(0, 24) };
      }),
      mistakeTop: wrongLib.topBy(kinds, 3),
      letterTop: wrongLib.topBy(pairs, 3),
      wrongCounted: rows.length,
      hasWrongStat: topWords.length > 0 || wrongLib.topBy(kinds, 3).length > 0
    };
  },

  /** 状态五档（与班级页同一套口径，改这里要一起改） */
  statusOf: function (stu, summary) {
    var learned = summary ? (summary.learned || 0) : 0;
    var forgot = summary ? (summary.forgot_today || 0) : 0;
    var failed = summary ? (summary.failed || 0) : 0;
    if (!learned && !(summary && summary.quiz_total)) {
      return { icon: '⏳', label: '今天还没学', tone: 'gray' };
    }
    if (forgot || failed) {
      return { icon: '⚠️', label: '有 ' + (forgot || failed) + ' 个没记住', tone: 'amber' };
    }
    return { icon: '🟢', label: '今天练得不错', tone: 'green' };
  },

  reload: function () {
    if (this.data.sid) this.load(this.data.sid);
  },

  /* ---------------- 外发：复制简报 / 分享 / 生成长图 ---------------- */

  copySummary: function () {
    var s = this.data.summary;
    if (!s || !s.text) return;
    var text = s.text + (s.honor ? '\n' + s.honor.badge + ' · ' + s.honor.detail : '');
    text += '\n' + links.openLine('看这份报告');
    privacy.copy(text, function () { wx.showToast({ title: '简报已复制', icon: 'none' }); });
  },

  onShareAppMessage: function () {
    var stu = this.data.student || {};
    var name = stu.nickname || '学员';
    return {
      title: '【' + name + '】学习报告 · ' + this.data.dateText,
      // 带 sid：对方点开直接就是这份报告（云端仍会校验对方是不是本班教练）
      path: '/pages/report/report?sid=' + this.data.sid,
      imageUrl: ''
    };
  },

  /**
   * 生成长图（A4 风格，可保存相册/直接打印）。
   * 用 canvas 2d 手绘而不是截图：截图会把页面滚动状态、按钮也拍进去，
   * 打印出来一塌糊涂；手绘只放"值得留在纸上的东西"。
   */
  onMakeImage: function () {
    var self = this;
    if (this.data.making) return;
    this.setData({ making: true });
    wx.showLoading({ title: '生成图片中…' });
    var query = wx.createSelectorQuery();
    query.select('#shareCanvas').fields({ node: true, size: true }).exec(function (res) {
      var info = res && res[0];
      if (!info || !info.node) {
        wx.hideLoading();
        self.setData({ making: false });
        wx.showToast({ title: '图像组件不可用，请升级微信后重试', icon: 'none' });
        return;
      }
      self.drawCard(info.node, info.width).then(function (height) {
        return new Promise(function (resolve, reject) {
          wx.canvasToTempFilePath({
            canvas: info.node,
            x: 0, y: 0, width: info.width, height: height,
            destWidth: info.width * 2, destHeight: height * 2,
            success: function (r) { resolve(r.tempFilePath); },
            fail: reject
          });
        });
      }).then(function (file) {
        wx.hideLoading();
        self.setData({ making: false });
        self.saveImage(file);
      }).catch(function (err) {
        wx.hideLoading();
        self.setData({ making: false });
        console.warn('[report] 生成图片失败', err);
        wx.showToast({ title: '生成图片失败，请重试', icon: 'none' });
      });
    });
  },

  /** 保存到相册：拒绝授权时引导去设置页，而不是静默失败 */
  saveImage: function (file) {
    var self = this;
    if (!file) return;
    // 写入相册同样属于隐私接口：先确认授权，再保存；拒绝时给一句人话，不静默失败
    privacy.ensure().then(function () {
      wx.saveImageToPhotosAlbum({
        filePath: file,
        success: function () {
          wx.showModal({
            title: '已保存到相册',
            content: '这张图可以直接分享给家长，也可以连打印机打出来（A4 竖版排版）。',
            showCancel: false,
            confirmText: '知道了'
          });
        },
        fail: function (err) {
          var raw = String((err && err.errMsg) || '');
          // toast 别再显示 "saveImageToPhotosAlb" 这种截断的 API 名 —— 取 fail 后面的真原因
          var msg = raw.indexOf('fail') >= 0 ? raw.slice(raw.indexOf('fail') + 5) : raw;
          if (raw.indexOf('auth deny') >= 0 || raw.indexOf('authorize') >= 0) {
            wx.showModal({
              title: '需要相册权限',
              content: '保存报告图片需要「保存到相册」权限，去设置里开一下就能用了。',
              confirmText: '去设置',
              success: function (r) { if (r.confirm) wx.openSetting(); }
            });
          } else if (raw.indexOf('not declared') >= 0 || raw.indexOf('privacy') >= 0) {
            wx.showModal({
              title: '暂时存不了相册',
              content: '保存相册要等小程序后台的隐私指引补上「相册」权限才会生效，我们会尽快修好。也可以先截图发给家长。',
              showCancel: false,
              confirmText: '知道了'
            });
          } else {
            wx.showToast({ title: '保存失败：' + (msg || '未知原因').slice(0, 30), icon: 'none' });
          }
        }
      });
    }).catch(function (err) { privacy.onDenied(err); });
  },

  /**
   * 手绘报告长图；返回画布实际高度（canvasToTempFilePath 坐标系）。
   * 2026-10-19 重排：旧版布局坐标按宽屏写死（标题缩进 250px、每行 30 字），
   * 真机画布只有 ~350px 宽，标题重叠、右侧全被裁掉。现在布局固定按 750 逻辑宽算，
   * 再整体缩放到实际画布 —— 任何屏幕上比例一致。
   */
  drawCard: function (canvas, width) {
    var self = this;
    var ctx = canvas.getContext('2d');
    var W = 750;                // 逻辑宽：布局的唯一依据
    var k = width / W;          // 逻辑 → 物理比例
    var dpr = 2;
    var pad = 64;
    var y = 0;

    // 先按内容把高度算出来（一次性设定 canvas 尺寸，避免画到一半撑高）
    var blocks = this.cardBlocks();
    var H = 96 + 90 + 190;     // 品牌条 + 学员行 + KPI 区
    blocks.forEach(function (b) { H += b.height; });
    H += 120;                  // 落款

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(H * dpr * k);
    ctx.scale(dpr * k, dpr * k);

    // 纸底 + 顶部品牌条（打印出来也像一回事）
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#2b6cb0';
    ctx.fillRect(0, 0, W, 96);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText('学员学习报告', pad, 62);
    var titleW = ctx.measureText('学员学习报告').width;
    if (this.data.clsName) {
      // 班级名给足右边界（留 160px 给右侧日期），放不下就截断 —— 不再叠到标题上
      ctx.font = '22px sans-serif';
      ctx.globalAlpha = 0.92;
      ctx.fillText(fitText(ctx, this.data.clsName, W - pad * 2 - titleW - 160), pad + titleW + 24, 62);
      ctx.globalAlpha = 1;
    }
    ctx.font = '22px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(this.data.dateText, W - pad, 62);
    ctx.textAlign = 'left';

    // 学员行：状态紧跟姓名（旧版 +160 固定缩进会把状态挤出屏幕）
    y = 150;
    var stu = this.data.student || {};
    var name = stu.nickname || '学员';
    ctx.fillStyle = '#1a2432';
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText(name, pad, y);
    var nameW = ctx.measureText(name).width;
    if (this.data.status) {
      ctx.font = '24px sans-serif';
      ctx.fillStyle = this.data.status.tone === 'green' ? '#1f8a4c'
        : (this.data.status.tone === 'amber' ? '#b37602' : '#6b7a8c');
      ctx.fillText(this.data.status.icon + ' ' + this.data.status.label,
        pad + nameW + 28, y);
    }

    // KPI 三格
    var kpiY = y + 36;
    var colW = (W - pad * 2) / 3;
    this.data.kpis.forEach(function (k2, i) {
      var x = pad + colW * i;
      ctx.fillStyle = '#f2f6fa';
      ctx.fillRect(x, kpiY, colW - 16, 118);
      ctx.fillStyle = '#0f1620';
      ctx.font = 'bold 44px sans-serif';
      ctx.fillText(k2.num, x + 24, kpiY + 60);
      ctx.fillStyle = '#6b7a8c';
      ctx.font = '22px sans-serif';
      ctx.fillText(k2.label, x + 24, kpiY + 96);
    });
    y = kpiY + 118 + 48;

    // 分区
    blocks.forEach(function (b) {
      ctx.fillStyle = '#0f1620';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText(b.title, pad, y);
      y += 18;
      ctx.fillStyle = '#2b6cb0';
      ctx.fillRect(pad, y, 64, 5);
      y += 34;
      y = b.draw(ctx, pad, y, W - pad * 2) || y;
      y += 40;
    });

    ctx.fillStyle = '#9aa8b6';
    ctx.font = '20px sans-serif';
    ctx.fillText(fitText(ctx, '功课抽查小程序' +
      (this.data.clsName ? ' · ' + this.data.clsName : '') +
      ' · 数据截至 ' + this.data.dateText +
      (this.data.wrongCounted ? ' · 诊断依据 ' + this.data.wrongCounted + ' 条错拼记录' : ''),
      W - pad * 2), pad, H - 44);
    return Promise.resolve(Math.round(H * k));
  },

  /** 长图上要出现的分区（页面上的按钮、提示一律不上图） */
  cardBlocks: function () {
    var self = this;
    var out = [];

    var s = this.data.summary;
    if (s && s.text) {
      // 折行宽度跟着画布走：24px 字号下每行约 26 个汉字（旧版写死 30 字会裁掉右半）
      var chars = Math.floor((750 - 64 * 2) / 24);
      var lines = wrap(s.text, chars);
      out.push({
        title: '今日简报',
        height: 64 + lines.length * 38 + ((s.honor ? 46 : 0)),
        draw: function (ctx, x, y, w) {
          ctx.fillStyle = '#33404f';
          ctx.font = '24px sans-serif';
          lines.forEach(function (ln) { ctx.fillText(ln, x, y); y += 38; });
          if (s.honor) {
            ctx.fillStyle = '#1f8a4c';
            ctx.font = 'bold 26px sans-serif';
            ctx.fillText(fitText(ctx, s.honor.badge + '  ' + (s.honor.detail || ''), w), x, y + 22);
          }
          return y;
        }
      });
    }

    if (this.data.assignments.length) {
      out.push({
        title: '作业完成度',
        height: 64 + this.data.assignments.length * 66,
        draw: function (ctx, x, y, w) {
          self.data.assignments.forEach(function (a) {
            ctx.fillStyle = '#33404f';
            ctx.font = '24px sans-serif';
            // 名称里常带日期+教材+单元，很长：给右侧数字留 110px，放不下截断加 …
            ctx.fillText(fitText(ctx, a.name, w - 110), x, y);
            ctx.textAlign = 'right';
            ctx.fillText(a.done + '/' + a.count, x + w, y);
            ctx.textAlign = 'left';
            ctx.fillStyle = '#dfe6ee';
            ctx.fillRect(x, y + 14, w, 14);
            ctx.fillStyle = a.done >= a.count ? '#1f8a4c' : '#2b6cb0';
            ctx.fillRect(x, y + 14, w * (a.pct / 100), 14);
            y += 66;
          });
          return y;
        }
      });
    }

    if (this.data.wrongTop.length) {
      out.push({
        title: '错得最多的词',
        height: 60 + Math.ceil(this.data.wrongTop.length / 2) * 60,
        draw: function (ctx, x, y, w) {
          self.data.wrongTop.forEach(function (wt, i) {
            var col = i % 2;
            var row = Math.floor(i / 2);
            var cx = x + col * (w / 2);
            var cy = y + row * 60;
            ctx.fillStyle = '#f2f6fa';
            ctx.fillRect(cx, cy, w / 2 - 20, 44);
            ctx.fillStyle = '#1a2432';
            ctx.font = 'bold 22px sans-serif';
            ctx.fillText(wt.word + ' ×' + wt.cnt, cx + 14, cy + 28);
            if (wt.trans) {
              ctx.fillStyle = '#6b7a8c';
              ctx.font = '18px sans-serif';
              ctx.fillText(wt.trans.slice(0, 10), cx + 120, cy + 28);
            }
          });
          return y;
        }
      });
    }

    if (this.data.mistakeTop.length) {
      out.push({
        title: '错法归类',
        height: 60 + Math.ceil(this.data.mistakeTop.length / 2) * 50,
        draw: function (ctx, x, y, w) {
          ctx.fillStyle = '#33404f';
          ctx.font = '22px sans-serif';
          self.data.mistakeTop.forEach(function (m, i) {
            var col = i % 2;
            var row = Math.floor(i / 2);
            ctx.fillText(m.key + ' ×' + m.cnt, x + col * (w / 2), y + row * 50);
          });
          return y;
        }
      });
    }

    return out;
  },

  /* ---------------- 小工具 ---------------- */

  fmtDate: function (ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  },

  fmtTime: function (ts) {
    var d = new Date(ts);
    if (time.getLocalDate(ts) === time.getLocalDate(Date.now())) {
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  },

  goBack: function () {
    wx.navigateBack();
  }
});

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** 长图里的中文折行（canvas 没有自动换行，按字宽硬折） */
function wrap(text, perLine) {
  var out = [];
  var s = String(text || '');
  for (var i = 0; i < s.length; i += perLine) out.push(s.slice(i, i + perLine));
  return out.length ? out : [''];
}

/** 长图里的超长文本截断（按当前字体实测宽度，超出加 …）—— 作业名/落款专用 */
function fitText(ctx, text, maxW) {
  var s = String(text || '');
  if (!s || ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
