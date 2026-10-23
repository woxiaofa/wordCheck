/**
 * 日报 / 周报 / 月报（本地真值 + 纯计算）
 *
 * 为什么自己记一份本地明细，而不是只查云端 review_logs：
 *   内测期云端链路出过多次故障（云函数未部署、通道不通、脏数据挡写入），
 *   只要云上一抖，家长的报告就整片空白 —— 而它恰恰是家长唯一看的东西。
 *   所以"每答一题"先在本地落一笔（跟镜像同生同死），云端只是冗余备份。
 *
 * 口径（与方案文档一致，不许各页面自己定义）：
 *   练习题数 = 区间内所有评分次数
 *   答对率   = known / 总题数（vague、forgot 都算没答对）
 *   活跃天数 = 区间内有练习记录的天数
 *   环比     = 本区间答对率 − 上一个等长区间的答对率
 */

var time = require('./time');

var KEY = 'daily_detail_v1';
var KEEP_DAYS = 120;          // 本地明细保留窗口，超出即丢弃（storage 有上限）

function readRaw() {
  try { return wx.getStorageSync(KEY) || {}; } catch (e) { return {}; }
}
function writeRaw(raw) {
  try { wx.setStorageSync(KEY, raw); } catch (e) { /* storage 不可用时报告降级，不影响学习 */ }
}

function emptyDay() {
  return { total: 0, known: 0, vague: 0, forgot: 0, words: {} };
}

/**
 * 记一笔。wordId 必填，feedback ∈ known/vague/forgot。
 * @param {string} wordId
 * @param {string} feedback
 */
function record(wordId, feedback) {
  if (!wordId || !feedback) return;
  var raw = readRaw();
  var d = time.getLocalDate();
  var day = raw[d] || emptyDay();

  day.total += 1;
  if (day[feedback] !== undefined) day[feedback] += 1;

  var w = day.words[wordId] || { n: 0, wrong: 0, last: '' };
  w.n += 1;
  if (feedback !== 'known') w.wrong += 1;
  w.last = feedback;
  day.words[wordId] = w;

  raw[d] = day;
  trim(raw);
  writeRaw(raw);
}

/** 丢掉过老的明细，避免 storage 无限膨胀 */
function trim(raw) {
  var earliest = time.shiftLocalDate(time.getLocalDate(), -KEEP_DAYS);
  Object.keys(raw).forEach(function (d) {
    if (d < earliest) delete raw[d];
  });
}

function rateOf(day) {
  return day.total ? Math.round(day.known / day.total * 100) : 0;
}

function sumWindow(raw, endInclusive, days) {
  var out = emptyDay();
  for (var i = 0; i < days; i++) {
    var d = time.shiftLocalDate(endInclusive, -i);
    var v = raw[d];
    if (!v) continue;
    out.total += v.total || 0;
    out.known += v.known || 0;
    out.vague += v.vague || 0;
    out.forgot += v.forgot || 0;
    Object.keys(v.words || {}).forEach(function (word) {
      var w = v.words[word];
      var acc = out.words[word] || { n: 0, wrong: 0 };
      acc.n += w.n || 0;
      acc.wrong += w.wrong || 0;
      out.words[word] = acc;
    });
  }
  return out;
}

/**
 * 生成一份报告。
 * @param {number} days 区间长度（1=日报 / 7=周报 / 30=月报）
 * @param {function} [defOf] 词 → 中文释义（用于错词榜；不传则只显示单词）
 */
function build(days, defOf) {
  days = Number(days) || 1;
  var raw = readRaw();
  var today = time.getLocalDate();

  var cur = sumWindow(raw, today, days);
  var prevEnd = time.shiftLocalDate(today, -days);
  var prev = sumWindow(raw, prevEnd, days);

  var curRate = rateOf(cur);
  var prevRate = rateOf(prev);
  var delta = (cur.total && prev.total) ? (curRate - prevRate) : null;

  // 逐日明细（日报只 1 天，周/月报按天排开，用于趋势条）
  var series = [];
  var maxTotal = 0;
  for (var i = days - 1; i >= 0; i--) {
    var d = time.shiftLocalDate(today, -i);
    var v = raw[d] || emptyDay();
    var r = rateOf(v);
    if (v.total > maxTotal) maxTotal = v.total;
    series.push({
      date: d,
      label: days === 1 ? '今天' : shortLabel(d),
      total: v.total,
      known: v.known,
      rate: r,
      height: 0          // 下面按区间最大值归一后回填
    });
  }
  // 归一：最高的那天顶满，其余按比例；有练习的日子至少留 12% 高度，避免"1 题"看不见
  series.forEach(function (s) {
    s.height = s.total ? Math.max(12, Math.round(s.total / maxTotal * 100)) : 0;
  });

  // 展示用趋势条（wxml 只认 bars，不认 series）：
  // 月报 30 根逐日条挤一行，每根只剩十几 rpx 宽、日期标签互相压字，家长根本读不了。
  // 超过 14 天的区间按 5 桶聚合（30 天 → 每桶 6 天），周报 7 根放得下、保持逐日。
  // series 保留逐日明细，活跃天数 / 最佳一天的口径不变。
  var bars = series;
  if (days > 14) {
    var size = Math.ceil(days / 5);
    bars = [];
    var maxBucket = 0;
    for (var b = 0; b < series.length; b += size) {
      var chunk = series.slice(b, b + size);
      var bt = 0, bk = 0;
      chunk.forEach(function (s) { bt += s.total; bk += s.known; });
      if (bt > maxBucket) maxBucket = bt;
      bars.push({
        date: chunk[0].date,
        label: shortLabel(chunk[0].date) + '–' + shortLabel(chunk[chunk.length - 1].date),
        total: bt,
        known: bk,
        height: 0
      });
    }
    bars.forEach(function (s) {
      s.height = s.total ? Math.max(12, Math.round(s.total / maxBucket * 100)) : 0;
    });
  }

  // 错词榜：只统计真的答错/模糊过的词
  var wrongs = Object.keys(cur.words)
    .filter(function (w) { return cur.words[w].wrong > 0; })
    .map(function (w) {
      return {
        word: w,
        wrong: cur.words[w].wrong,
        n: cur.words[w].n,
        def: defOf ? (defOf(w) || '') : ''
      };
    })
    .sort(function (a, b) { return b.wrong - a.wrong || b.n - a.n; })
    .slice(0, 5);

  var activeDays = series.filter(function (s) { return s.total > 0; }).length;
  var best = series.reduce(function (a, b) { return b.total > a.total ? b : a; }, series[0]);

  return {
    days: days,
    rangeLabel: rangeLabel(days, today),
    subLabel: subLabel(days),
    total: cur.total,
    known: cur.known,
    vague: cur.vague,
    forgot: cur.forgot,
    rate: curRate,
    prevRate: prevRate,
    delta: delta,
    deltaText: delta === null ? '暂无对比' : (delta >= 0 ? '↑ ' + delta : '↓ ' + Math.abs(delta)) + ' 个百分点',
    deltaUp: delta !== null && delta >= 0,
    activeDays: activeDays,
    bestDay: best && best.total ? best : null,
    series: series,
    bars: bars,
    maxTotal: maxTotal,
    topWrong: wrongs,
    headline: headline(days, cur, curRate, delta, activeDays, best),
    parentLine: parentLine(cur, curRate, wrongs)
  };
}

function shortLabel(d) {
  var p = d.split('-');
  return Number(p[1]) + '/' + Number(p[2]);
}

function rangeLabel(days, today) {
  var p = today.split('-');
  var head = Number(p[1]) + '月' + Number(p[2]) + '日';
  if (days === 1) return '日报 · ' + head;
  var from = time.shiftLocalDate(today, -(days - 1));
  var fp = from.split('-');
  return (days === 7 ? '周报 · ' : '月报 · ') +
    Number(fp[1]) + '月' + Number(fp[2]) + '日 – ' + head;
}

function subLabel(days) {
  if (days === 1) return '今天练了多少、错在哪，一眼看完';
  if (days === 7) return '近 7 天趋势，对比上一个 7 天';
  return '近 30 天趋势，对比上一个 30 天';
}

function headline(days, cur, rate, delta, activeDays, best) {
  if (!cur.total) {
    return days === 1
      ? '今天还没有练习记录。去学 10 个词，这里就会出第一条。'
      : '这段时间还没有练习记录。开始学习后，这里会自动生成报告。';
  }
  var name = days === 1 ? '今天' : (days === 7 ? '本周' : '本月');
  var s = name + '共练 ' + cur.total + ' 题，答对 ' + rate + '%';
  if (delta !== null) {
    s += delta >= 0 ? '，比上一周期提高 ' + delta + ' 个百分点' : '，比上一周期下降 ' + Math.abs(delta) + ' 个百分点';
  }
  s += '；' + activeDays + ' 天有练习';
  if (best && best.total) s += '，练得最多的是 ' + shortLabel(best.date) + '（' + best.total + ' 题）';
  return s + '。';
}

function parentLine(cur, rate, wrongs) {
  if (!cur.total) return '还没有数据。孩子完成一次学习后，这里会给出给家长的一句话总结。';
  if (rate >= 85) {
    return '掌握得很扎实：正确率 ' + rate + '%。可以往前推进新词，' +
      (wrongs.length ? '顺手把「' + wrongs[0].word + '」这类易错词清一清。' : '错题本基本是空的。');
  }
  if (rate >= 60) {
    return '整体在推进：正确率 ' + rate + '%，但还有 ' + cur.forgot + ' 题没答上来。' +
      (wrongs.length ? '建议这两天专攻：' + wrongs.slice(0, 3).map(function (w) { return w.word; }).join('、') + '。' : '');
  }
  return '需要加练：正确率只有 ' + rate + '%，' + cur.forgot + ' 题没答上来。' +
    '先把量降下来，把「' + (wrongs.length ? wrongs[0].word : '易错词') + '」这类词反复过几遍再往前走。';
}

module.exports = {
  KEY: KEY,
  record: record,
  build: build,
  readRaw: readRaw,
  clear: function () { writeRaw({}); }
};
