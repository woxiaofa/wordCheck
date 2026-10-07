/**
 * 作业链路数字一致性集成测试（假数据库 + 真云函数代码）
 *
 * 为什么需要它：2026-10-06 用户连续四次截图报"数字互相矛盾"——
 *   学生端 0/10、进去就学完了；老师端催学"练了 10 题、累计 10 词、还剩 10 个"。
 * 每个函数单看都对，错在**系统接缝**：
 *   1) URL 词单编码了没解码（10 个词被当成 1 个）
 *   2) 作业存 words._id，学习状态表存 word 文本（永远查不中）
 *   3) 每日任务与作业各选各的词（各说各话）
 *   4) 完成度口径不统一（选"模糊"不算学过）
 * 这里把整条链在假库上跑通，钉死"三处数字必须互相自洽"的不变量。
 */

var assert = require('assert');
var Module = require('module');

/* ---------------- 假数据库 ---------------- */

function createFakeDb() {
  var colls = {};
  var seq = 0;

  function ensure(name) {
    if (!colls[name]) colls[name] = [];
    return colls[name];
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function applyUpdate(doc, data) {
    Object.keys(data).forEach(function (k) {
      if (data[k] === undefined) return;      // 云端真实行为：undefined 整段丢字段
      if (k.indexOf('.') === -1) { doc[k] = clone(data[k]); return; }
      var parts = k.split('.');
      var cur = doc;
      for (var i = 0; i < parts.length - 1; i++) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = clone(data[k]);
    });
  }

  function match(doc, q) {
    for (var k in q) {
      var cond = q[k];
      var val = doc[k];
      if (cond && typeof cond === 'object' && cond.__op) {
        if (cond.__op === 'lte' && !(val !== undefined && val <= cond.v)) return false;
        if (cond.__op === 'gte' && !(val !== undefined && val >= cond.v)) return false;
        if (cond.__op === 'in' && cond.v.indexOf(val) === -1) return false;
        continue;
      }
      if (val !== cond) return false;
    }
    return true;
  }

  var command = {
    lte: function (v) { return { __op: 'lte', v: v }; },
    gte: function (v) { return { __op: 'gte', v: v }; },
    in: function (arr) { return { __op: 'in', v: arr }; }
  };

  /**
   * 查询链。rows 是当时的快照，每个算子都返回新链（与云开发的链式调用一致）。
   * 注意：既支持 where().orderBy() 也支持直接 collection.orderBy()（全表）——
   * task.today 取词库用的就是后者。
   */
  function chain(rows) {
    return {
      count: function () { return Promise.resolve({ total: rows.length }); },
      limit: function (n) { return chain(rows.slice(0, n)); },
      orderBy: function (f, dir) {
        var out = rows.slice();
        out.sort(function (a, b) {
          var x = a[f], y = b[f];
          if (x === y) return 0;
          return (x > y ? 1 : -1) * (dir === 'desc' ? -1 : 1);
        });
        return chain(out);
      },
      field: function (f) {
        return chain(rows.map(function (d) {
          var o = { _id: d._id };
          Object.keys(f || {}).forEach(function (k) {
            if (f[k] && k in d) o[k] = d[k];   // 缺失字段保持"不存在"
          });
          return o;
        }));
      },
      get: function () { return Promise.resolve({ data: rows.map(clone) }); },
      update: function (o) {
        rows.forEach(function (d) { applyUpdate(d, o.data); });
        return Promise.resolve({ stats: { updated: rows.length } });
      },
      remove: function () {
        var ids = rows.map(function (d) { return d._id; });
        colls[name] = ensure(name).filter(function (d) { return ids.indexOf(d._id) === -1; });
        return Promise.resolve({ stats: { removed: ids.length } });
      }
    };
  }

  function collection(name) {
    var self = {
      where: function (q) {
        return chain(ensure(name).filter(function (d) { return match(d, q); }));
      },
      // 不带 where 的全表链式入口（task.today 取词库走这条）
      orderBy: function (f, dir) { return chain(ensure(name).slice()).orderBy(f, dir); },
      limit: function (n) { return chain(ensure(name).slice()).limit(n); },
      field: function (f) { return chain(ensure(name).slice()).field(f); },
      get: function () { return chain(ensure(name).slice()).get(); },
      doc: function (id) {
        var list = ensure(name);
        function idx() {
          for (var i = 0; i < list.length; i++) { if (list[i]._id === id) return i; }
          return -1;
        }
        return {
          get: function () {
            var i = idx();
            return Promise.resolve(i === -1 ? { data: null } : { data: clone(list[i]) });
          },
          update: function (o) {
            var i = idx();
            if (i !== -1) applyUpdate(list[i], o.data);
            return Promise.resolve({ stats: { updated: i === -1 ? 0 : 1 } });
          },
          set: function (o) {
            var data = clone(o.data);
            data._id = id;
            var i = idx();
            if (i === -1) list.push(data); else list[i] = data;
            return Promise.resolve({ stats: { updated: 1 } });
          },
          remove: function () {
            var i = idx();
            if (i !== -1) list.splice(i, 1);
            return Promise.resolve({ stats: { removed: i === -1 ? 0 : 1 } });
          }
        };
      },
      add: function (o) {
        var data = clone(o.data);
        if (!data._id) data._id = 'gen' + (++seq);
        ensure(name).push(data);
        return Promise.resolve({ _id: data._id });
      }
    };
    return self;
  }

  return {
    collection: collection,
    command: command,
    raw: colls,
    reset: function () { Object.keys(colls).forEach(function (k) { delete colls[k]; }); },
    seed: function (name, docs) { colls[name] = clone(docs); }
  };
}

var db = createFakeDb();
var CURRENT_OPENID = '';

var fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'test',
  init: function () {},
  getWXContext: function () { return { OPENID: CURRENT_OPENID }; },
  database: function () { return db; }
};

var origLoad = Module._load;
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeSdk;
  return origLoad.apply(this, arguments);
};
var classFn = require('../cloud/functions/class/index.js');
var taskFn = require('../cloud/functions/task/index.js');
var assignParam = require('../miniprogram/utils/assign.js');
Module._load = origLoad;

/* ---------------- 场景搭建 ---------------- */

var COACH_OPENID = 'openid-coach';
var STU_OPENID = 'openid-stu';
var WORD_TEXTS = ['apple', 'tie', 'circle', 'democracy', 'search', 'bridge', 'cabin', 'dance', 'eagle', 'flame'];

/** 造 30 个词的词库：_id 是 w001…，word 是文本（真实库里两者并存） */
function makeWords() {
  var out = [];
  for (var i = 0; i < 30; i++) {
    var w = i < WORD_TEXTS.length ? WORD_TEXTS[i] : ('word' + i);
    out.push({ _id: 'w' + String(i + 101), word: w, translation: '释义' + w, freq: i + 1 });
  }
  return out;
}

/**
 * 建场景
 * @param {object} opt { wordIds: 作业词单（默认文本格式）, learned: 学生已学的作业词, feedback: 'known'|'vague'|'forgot' }
 */
function seed(opt) {
  opt = opt || {};
  var learned = opt.learned || [];
  var asgIds = opt.wordIds || WORD_TEXTS.slice();

  db.reset();
  db.seed('users', [
    { _id: 'T', openid: COACH_OPENID, role: 'coach', class_id: 'C1', nickname: '王老师' },
    {
      _id: 'S', openid: STU_OPENID, role: 'student', class_id: 'C1', nickname: '小学霸',
      last_seen_at: Date.now() - 20 * 60000,
      stats_cache: { learned_words: learned.length, streak_days: 1 }
    }
  ]);
  db.seed('classes', [{
    _id: 'C1', name: '三年级二班', code: 'ABC234', owner_id: 'T', student_ids: ['S'], created_at: Date.now()
  }]);
  db.seed('words', makeWords());
  db.seed('assignments', [{
    _id: 'A1', class_id: 'C1', created_by: 'T', tag: '全部', count: asgIds.length,
    note: 'hh', deadline: '', word_ids: asgIds, created_at: Date.now()
  }]);
  db.seed('user_word_state', learned.map(function (w) {
    // 默认模拟"认真学了但选了模糊/忘了"：correct_count=0、stage=0
    // 这是旧口径会判成 0 进度的场景，也是用户截图里的真实情况
    var fb = opt.feedback || 'vague';
    return {
      _id: 'S:' + w, user_id: 'S', word_id: w,
      stage: fb === 'known' ? 1 : 0,
      correct_count: fb === 'known' ? 1 : 0,
      wrong_count: fb === 'known' ? 0 : 1,
      last_feedback: fb,
      next_review_at: Date.now() + 86400000
    };
  }));
  db.seed('review_logs', learned.map(function (w, i) {
    return {
      _id: 'log' + i, user_id: 'S', word_id: w,
      feedback: opt.feedback || 'vague', mode: 'study',
      review_date: require('../cloud/functions/class/time.js').getLocalDate(Date.now()),
      created_at: Date.now() - i * 1000
    };
  }));
}

function as(openid, fn) {
  CURRENT_OPENID = openid;
  return Promise.resolve().then(fn).then(function (r) { CURRENT_OPENID = ''; return r; });
}

/* ---------------- 测试 ---------------- */

var steps = [];
function ok(name, fn) {
  steps.push(function () {
    return Promise.resolve()
      .then(fn)
      .then(function () { console.log('  ✓ ' + name); })
      .catch(function (e) {
        console.log('  ✗ ' + name + '\n    ' + e.message);
        if (process.env.VERBOSE) console.log(e.stack);
        process.exitCode = 1;
      });
  });
}

console.log('\n作业链路数字一致性（假库 + 真云函数）');

// ---- ① URL 接缝：编码过的词单必须解回 10 个词（复刻 0/1 那个 bug） ----
ok('① URL 契约：encodeURIComponent 的 10 词词单 → 解析出 10 个词（不是 1 个）', function () {
  var encoded = assignParam.buildIdsParam(WORD_TEXTS);
  assert.ok(encoded.indexOf('%2C') >= 0, '逗号应被编码为 %2C（否则测的是明文路径）');
  var parsed = assignParam.parseIdsParam(encoded);
  assert.strictEqual(parsed.length, 10, '实锤 bug：不解码时这里会得到 1');
  assert.deepStrictEqual(parsed, WORD_TEXTS);
  // 明文也要能吃（老客户端/手动分享链接）
  assert.strictEqual(assignParam.parseIdsParam(WORD_TEXTS.join(',')).length, 10);
  // 坏参数不能打崩页面
  assert.doesNotThrow(function () { assignParam.parseIdsParam('%E0%A4%A'); });
  assert.deepStrictEqual(assignParam.parseIdsParam(''), []);
});

// ---- ② 学生端进度：选"模糊"也算学过（旧口径会判 0） ----
ok('② 学生端 myAssignments：选了"模糊"的 3 个词算已学 → done=3', function () {
  seed({ learned: WORD_TEXTS.slice(0, 3), feedback: 'vague' });
  return as(STU_OPENID, function () {
    return classFn.main({ action: 'myAssignments' });
  }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var a = r.data.assignments[0];
    assert.strictEqual(a.count, 10);
    assert.strictEqual(a.done, 3, '学过即算：correct_count=0/stage=0 也必须计数');
    var learnedCount = a.words.filter(function (w) { return w.learned; }).length;
    assert.strictEqual(learnedCount, 3);
  });
});

// ---- ③ 教练端与学生端必须同一个数 ----
ok('③ 教练端 studentDetail 作业进度 = 学生端进度（两端不许各说各话）', function () {
  seed({ learned: WORD_TEXTS.slice(0, 3), feedback: 'vague' });
  return as(COACH_OPENID, function () {
    return classFn.main({ action: 'studentDetail', studentId: 'S' });
  }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var a = r.data.assignments[0];
    assert.strictEqual(a.done, 3, '教练端应同为 3');
    assert.strictEqual(a.count, 10);
    // 不变量：done 不可能超过 count（曾出现"学了 10 个还剩 10 个"）
    assert.ok(a.done <= a.count, 'done 不得超过 count');
  });
});

// ---- ④ 旧格式作业（存 words._id）也要算对 ----
ok('④ 旧格式作业（词单存 words._id）经归一后进度正确', function () {
  // 老作业：word_ids 里是 _id
  var oldIds = ['w101', 'w102', 'w103', 'w104', 'w105', 'w106', 'w107', 'w108', 'w109', 'w110'];
  seed({ wordIds: oldIds, learned: WORD_TEXTS.slice(0, 4) });
  return as(COACH_OPENID, function () {
    return classFn.main({ action: 'studentDetail', studentId: 'S' });
  }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.assignments[0].done, 4, '_id 应被翻译成文本后命中 4 条学习记录');
  });
});

// ---- ⑤ 每日任务优先清作业（治"练了 10 题还剩 10 个"） ----
ok('⑤ task.today：今日新词优先取作业里没学过的词 → 学每日任务=做作业', function () {
  seed({ learned: WORD_TEXTS.slice(0, 3) });
  return as(STU_OPENID, function () {
    return taskFn.main({ action: 'today' });
  }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var news = r.data.task.new || r.data.task.snapshot.new || [];
    assert.strictEqual(news.length, 10, '每日新词 10 个');
    var left = WORD_TEXTS.slice(3);           // 作业里还没学的 7 个
    left.forEach(function (w) {
      assert.ok(news.indexOf(w) >= 0, '作业未学的词「' + w + '」应出现在今日新词里');
    });
    // 已学过的 3 个不能重复塞进新词
    WORD_TEXTS.slice(0, 3).forEach(function (w) {
      assert.strictEqual(news.indexOf(w), -1, '已学过的「' + w + '」不该再当新词');
    });
  });
});

// ---- ⑥ 催学文案自洽：done + left = count ----
ok('⑥ 催学文案：剩余数 = 总数 - 已完成，且不再把练题数与作业剩余硬拼', function () {
  seed({ learned: WORD_TEXTS.slice(0, 3) });
  return as(COACH_OPENID, function () {
    return classFn.main({ action: 'nudge', studentId: 'S' });
  }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var t = r.data.text;
    assert.ok(t.indexOf('还剩 7 个词') >= 0, '应说还剩 7 个（10-3），实际文案：\n' + t);
    // 不变量：文案里不得同时出现"练了 N 题"和"还剩 M"这种两套口径的拼接
    var hasPractice = /今天已经练了\s*\d+\s*题/.test(t);
    var hasLeft = /还剩\s*\d+\s*个词/.test(t);
    assert.ok(!(hasPractice && hasLeft),
      '文案不得同时讲"练了多少题"和"作业还剩多少"——这正是用户看到的矛盾：\n' + t);
    assert.ok(t.indexOf('hh') >= 0, '应点名作业，让家长知道说的是哪一项');
  });
});

// ---- ⑦ 全部学完：不再说"还剩"，且两端一致 ----
ok('⑦ 学完全部 10 词：done=10、文案无"还剩"，两端一致', function () {
  seed({ learned: WORD_TEXTS.slice(), feedback: 'known' });
  return as(STU_OPENID, function () {
    return classFn.main({ action: 'myAssignments' });
  }).then(function (r) {
    assert.strictEqual(r.data.assignments[0].done, 10);
    return as(COACH_OPENID, function () { return classFn.main({ action: 'nudge', studentId: 'S' }); });
  }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.data.text.indexOf('还剩') === -1, '已完成不该再说"还剩"，实际：\n' + r.data.text);
  });
});

// ---- ⑧ 一个词没学：进度 0，文案催开始 ----
ok('⑧ 一个词都没学：done=0 且文案如实说"还没开始"', function () {
  seed({ learned: [] });
  return as(STU_OPENID, function () {
    return classFn.main({ action: 'myAssignments' });
  }).then(function (r) {
    assert.strictEqual(r.data.assignments[0].done, 0);
    return as(COACH_OPENID, function () { return classFn.main({ action: 'nudge', studentId: 'S' }); });
  }).then(function (r) {
    assert.ok(r.data.text.indexOf('还剩 10 个词') >= 0, '应说还剩 10 个，实际：\n' + r.data.text);
  });
});

// ---- ⑨ 编码只做一次：双重编码会让 %2C → %252C，又退化成一个词 ----
ok('⑨ URL 契约：编解码必须成对，不得二次编码', function () {
  var built = assignParam.buildIdsParam(WORD_TEXTS);
  assert.strictEqual(assignParam.parseIdsParam(built).length, 10, '一次编码 → 解析出 10 个');

  // 反面：二次编码后即使解码一次，逗号也回不来（证明这个坑真实存在）
  var twice = encodeURIComponent(built);
  assert.strictEqual(assignParam.parseIdsParam(twice).length, 1,
    '二次编码会让词单退化成 1 个 —— 所以构造 URL 时必须原样带上');

  // 静态钉死：任何跳转处都不得对已经是编码串的 ids 再编码一次
  var fs = require('fs');
  var path = require('path');
  var root = path.join(__dirname, '..');
  ['miniprogram/pages/index/index.js', 'miniprogram/pages/class/class.js'].forEach(function (f) {
    var src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(src.indexOf('buildIdsParam') >= 0, f + ' 应使用 buildIdsParam 构造词单参数');
    assert.ok(!/encodeURIComponent\(\s*a\.ids\s*\)/.test(src),
      f + ' 不得对已编码的 ids 二次编码（会退化成一个词）');
  });
});

// ---- ⑩ 三处"累计 N 词"必须同口径 ----
ok('⑩ 学员卡"累计 N 词" = stats_cache.learned_words（催学文案读的就是它）', function () {
  seed({ learned: WORD_TEXTS.slice(0, 3), feedback: 'vague' });
  return as(COACH_OPENID, function () {
    return classFn.main({ action: 'students' });
  }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var s = r.data.students[0];
    // 三个词都是"选了模糊"（correct_count=0, stage=0）：
    // 旧口径下 learned 会是 0，而 stats.learned_words 是 3 —— 同屏两个数字
    assert.strictEqual(s.stats.learned_words, 3, 'stats_cache 按学过即算，应为 3');
    assert.strictEqual(s.learned, s.stats.learned_words,
      '学员卡累计（' + s.learned + '）必须与 stats_cache（' + s.stats.learned_words + '）一致');
  });
});

// ---- ⑪ 身份闸门：家长/教练不是做作业的人，首页不该收到作业 ----
ok('⑪ 教练（班级创建者）调 myAssignments：不返回作业，role=coach', function () {
  seed({ learned: WORD_TEXTS.slice(0, 3), feedback: 'vague' });
  return as(COACH_OPENID, function () {
    return classFn.main({ action: 'myAssignments' });
  }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.role, 'coach', '应回传身份，前端据此渲染');
    assert.deepStrictEqual(r.data.assignments, [],
      '内测实锤：教练自己也有 class_id，不给作业才不会在家长首页弹出作业卡');
    assert.ok(r.data.class && r.data.class.name, '应回传班级，供首页给"看学员进度"入口');
  });
});

// ---- ⑫ 学生身份不受影响：帽子不能扣错人 ----
ok('⑫ 学生调 myAssignments：照常拿到作业，role=student', function () {
  seed({ learned: WORD_TEXTS.slice(0, 3), feedback: 'vague' });
  return as(STU_OPENID, function () {
    return classFn.main({ action: 'myAssignments' });
  }).then(function (r) {
    assert.strictEqual(r.data.role, 'student');
    assert.strictEqual(r.data.assignments.length, 1, '学生必须能看到作业');
    assert.strictEqual(r.data.assignments[0].done, 3);
  });
});

steps.reduce(function (p, fn) { return p.then(fn); }, Promise.resolve())
  .then(function () {
    console.log(process.exitCode ? '\n有问题，见上方 ✗\n' : '\n全部通过\n');
  });
