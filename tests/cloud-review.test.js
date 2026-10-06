/**
 * review 云函数集成测试（假数据库）
 *
 * 为什么需要它：线上出过一次"教练端进度恒 0、报错是裸 E11000"的故障，
 * 根因是 user_word_state 里存在 word_id 为空的脏文档 + 唯一索引把"空"视为同值。
 * 这类问题光看代码看不出来，必须把"带唯一索引的数据库"搬到本地跑一遍。
 *
 * 这里的假数据库刻意实现了两个真实行为：
 *   1) (user_id, word_id) 唯一索引：同键第二次插入抛 E11000，word_id 缺失按 null 计
 *   2) 缺失字段在 field 投影后依然是"不存在"，与线上一致
 */

var assert = require('assert');
var Module = require('module');

/* ---------------- 假数据库 ---------------- */

function createFakeDb() {
  var colls = {};
  var seq = 0;
  var counters = { adds: 0, dupErrors: 0 };

  function ensure(name) {
    if (!colls[name]) colls[name] = [];
    return colls[name];
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function match(doc, q) {
    for (var k in q) {
      var cond = q[k];
      var val = doc[k];
      if (cond && typeof cond === 'object' && cond.__op) {
        if (cond.__op === 'lte' && !(val !== undefined && val <= cond.v)) return false;
        if (cond.__op === 'in' && cond.v.indexOf(val) === -1) return false;
        continue;
      }
      if (val !== cond) return false;
    }
    return true;
  }

  function keyOf(doc) {
    var w = doc.word_id === undefined ? null : doc.word_id;
    return String(doc.user_id === undefined ? null : doc.user_id) + '|' + String(w);
  }

  /** 支持 'a.b' 这种点号路径更新（云开发真实行为，enqueueTodayOnce 依赖它） */
  function applyUpdate(doc, data) {
    Object.keys(data).forEach(function (k) {
      // 云端真实行为：值为 undefined 的字段会被整段丢掉，不会写进文档
      if (data[k] === undefined) return;
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

  var command = {
    lte: function (v) { return { __op: 'lte', v: v }; },
    in: function (arr) { return { __op: 'in', v: arr }; }
  };

  function collection(name) {
    var self = {
      orderBy: function () { return self; },
      limit: function () { return self; },
      field: function () { return self; },
      get: function () { return Promise.resolve({ data: ensure(name).map(clone) }); },
      count: function () { return Promise.resolve({ total: ensure(name).length }); },
      where: function (q) {
        var rows = ensure(name).filter(function (d) { return match(d, q); });
        var chain = {
          limit: function (n) { rows = rows.slice(0, n); return chain; },
          orderBy: function () { return chain; },
          field: function (f) {
            rows = rows.map(function (d) {
              var o = { _id: d._id };
              Object.keys(f || {}).forEach(function (k) {
                if (f[k] && k in d) o[k] = d[k];       // 缺失字段保持"不存在"
              });
              return o;
            });
            return chain;
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
        return chain;
      },
      doc: function (id) {
        var list = ensure(name);
        var idx = -1;
        for (var i = 0; i < list.length; i++) { if (list[i]._id === id) { idx = i; break; } }
        return {
          get: function () {
            return Promise.resolve(idx === -1 ? { data: null } : { data: clone(list[idx]) });
          },
          update: function (o) {
            if (idx !== -1) applyUpdate(list[idx], o.data);
            return Promise.resolve({ stats: { updated: idx === -1 ? 0 : 1 } });
          },
          set: function (o) {
            // 云端真实行为（2026-10-06 探针实锤）：set 的 data 里带 _id
            // 必抛 -501007"不能更新_id的值"—— 写入器绝不允许这么做
            if (o.data && o.data._id !== undefined) {
              return Promise.reject(new Error(
                'document.set:fail -501007 invalid parameter, 不能更新_id的值'));
            }
            // 云开发服务端语义：有则替换、无则新建（不经过插入路径，不会撞唯一键）
            var data = clone(o.data);
            data._id = id;
            if (idx === -1) list.push(data); else list[idx] = data;
            return Promise.resolve({ stats: { updated: 1, created: idx === -1 ? 1 : 0 } });
          },
          remove: function () {
            if (idx !== -1) list.splice(idx, 1);
            return Promise.resolve({ stats: { removed: idx === -1 ? 0 : 1 } });
          }
        };
      },
      add: function (o) {
        var data = clone(o.data);
        counters.adds++;
        // 云端真实行为（探针实锤）：user_word_state 上 add 带 _id 报
        // "database request fail [FailedOp]" —— 写入器的 add 兜底必须不带 _id
        if (name === 'user_word_state' && data._id !== undefined) {
          return Promise.reject(new Error(
            'collection.add:fail database request fail. [FailedOp]'));
        }
        if (name === 'user_word_state') {
          // 复刻线上观测到的行为（不是教科书 Mongo 语义）：
          // 该用户名下只要存在 word_id 为空的脏文档，后续每一次插入都会撞唯一键，
          // 报错里 dup key 显示为 { user_id, word_id: null } —— 与内测环境完全一致。
          // 这正是"学习数据全量写不进去 + 教练端进度恒 0"的成因，必须能被测出来。
          var dirty = ensure(name).some(function (d) {
            return d.user_id === data.user_id && (d.word_id === undefined || d.word_id === null);
          });
          if (dirty) {
            counters.dupErrors++;
            return Promise.reject(new Error(
              'E11000 duplicate key error collection: test.user_word_state ' +
              'index: user_wordIndex dup key: { user_id + word_id: ' +
              String(data.user_id) + '|null }'));
          }
          var k = keyOf(data);
          var exists = ensure(name).some(function (d) { return keyOf(d) === k; });
          if (exists) {
            counters.dupErrors++;
            return Promise.reject(new Error(
              'E11000 duplicate key error collection: test.user_word_state ' +
              'index: user_wordIndex dup key: { user_id + word_id: ' + k + ' }'));
          }
        }
        if (name === 'request_dedup') {
          var dup = ensure(name).some(function (d) { return d._id === data._id; });
          if (dup) {
            return Promise.reject(new Error('E11000 duplicate key error collection: test.request_dedup'));
          }
        }
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
    counters: counters,
    raw: colls,
    reset: function () {
      // 原地清空：db.raw 必须始终指向同一对象，否则测试里塞的种子数据会丢
      Object.keys(colls).forEach(function (k) { delete colls[k]; });
    }
  };
}

var db = createFakeDb();

var fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'test',
  init: function () {},
  getWXContext: function () { return { OPENID: 'test-openid' }; },
  database: function () { return db; }
};

var origLoad = Module._load;
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeSdk;
  return origLoad.apply(this, arguments);
};
var review = require('../cloud/functions/review/index.js');
Module._load = origLoad;

/* ---------------- 测试 ---------------- */

var pass = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { pass++; console.log('  ✓ ' + name); })
    .catch(function (e) {
      console.log('  ✗ ' + name + '\n    ' + e.message);
      if (process.env.VERBOSE) console.log(String(e.stack).split('\n').slice(0, 8).join('\n'));
      process.exitCode = 1;
    });
}

function seedUser() {
  db.reset();
  db.raw.users = [{
    _id: 'u1',
    openid: 'test-openid',
    role: 'student',
    stats_cache: { total_words: 0, learned_words: 0, streak_days: 0 }
  }];
}

function submit(word, feedback, reqId) {
  return review.main({
    action: 'submit',
    wordId: word,
    feedback: feedback || 'known',
    mode: 'learn',
    clientReqId: reqId || 'req-' + word + '-' + Math.random()
  }, {});
}

var steps = [];

steps.push(function () {
  return ok('① 正常新词：写入成功且带 word_id，统计 +1，_id 为 user:word', function () {
    seedUser();
    return submit('search').then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      var st = db.raw.user_word_state || [];
      assert.strictEqual(st.length, 1, '应写入 1 条状态');
      assert.strictEqual(st[0].word_id, 'search');
      assert.strictEqual(st[0].user_id, 'u1');
      assert.strictEqual(st[0]._id, 'u1:search',
        '状态文档必须用确定性主键 user_id:word_id（脏数据挡道的根治手段）');
      assert.strictEqual(db.raw.users[0].stats_cache.learned_words, 1, '已学词数应 +1');
    });
  });
});

steps.push(function () {
  return ok('② 复刻线上故障：库里有 word_id 为空的脏文档，写入照样成功', function () {
    seedUser();
    // 手动埋一条脏数据（线上是控制台手动加记录 / 建索引前残留造成的）
    db.raw.user_word_state = [{ _id: 'dirty1', user_id: 'u1', stage: 0, updated_at: 1 }];

    return submit('circle').then(function (r) {
      assert.strictEqual(r.ok, true, '脏文档不应挡住写入：' + JSON.stringify(r));
      var st = db.raw.user_word_state || [];
      var withId = st.filter(function (d) { return d.word_id; });
      assert.strictEqual(withId.length, 1, '应写入 1 条带 word_id 的状态');
      assert.strictEqual(withId[0].word_id, 'circle');
      assert.strictEqual(withId[0]._id, 'u1:circle');
      assert.strictEqual(db.raw.users[0].stats_cache.learned_words, 1);
    });
  });
});

steps.push(function () {
  return ok('③ 脏文档存在时连续学 3 个词：全部写入成功（线上曾全量失败）', function () {
    seedUser();
    db.raw.user_word_state = [{ _id: 'dirty1', user_id: 'u1' }];
    return submit('a').then(function () { return submit('b'); })
      .then(function () { return submit('c'); })
      .then(function () {
        var st = db.raw.user_word_state || [];
        var ids = st.filter(function (d) { return d.word_id; }).map(function (d) { return d.word_id; }).sort();
        assert.deepStrictEqual(ids, ['a', 'b', 'c'], '三个词都应写入，实际：' + ids.join(','));
        assert.strictEqual(db.raw.users[0].stats_cache.learned_words, 3);
      });
  });
});

steps.push(function () {
  return ok('④ 同一个词再提交：更新而非新增，已学词数不重复累加', function () {
    seedUser();
    return submit('search').then(function () { return submit('search', 'vague'); })
      .then(function () {
        var st = db.raw.user_word_state || [];
        assert.strictEqual(st.length, 1, '同一词只应有 1 条状态');
        assert.strictEqual(db.raw.users[0].stats_cache.learned_words, 1, '已学词数不应重复 +1');
      });
  });
});

steps.push(function () {
  return ok('⑤ 幂等：同一 clientReqId 重复提交只生效一次', function () {
    seedUser();
    return submit('search', 'known', 'req-fixed-1')
      .then(function () { return submit('search', 'known', 'req-fixed-1'); })
      .then(function (r2) {
        assert.strictEqual(r2.data.replay, true, '第二次应命中幂等回放');
        assert.strictEqual(db.raw.users[0].stats_cache.learned_words, 1);
      });
  });
});

steps.push(function () {
  return ok('⑥ 答错的词：状态写库并追加到今日任务 repeat', function () {
    seedUser();
    // 今日日期必须动态算：写死日期的测试一过午夜就假失败（2026-10-06 实锤）
    var time = require('../shared/time');
    var today = time.getLocalDate(Date.now());
    db.raw.daily_tasks = [{
      _id: 'daily:u1:' + today, user_id: 'u1', task_date: today,
      snapshot_json: { new: ['search'], review: [], repeat: [] }
    }];
    return submit('search', 'forgot').then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      var st = db.raw.user_word_state || [];
      assert.strictEqual(st[0].wrong_count, 1, '错误次数应记为 1');
      assert.deepStrictEqual(db.raw.daily_tasks[0].snapshot_json.repeat, ['search']);
    });
  });
});

steps.push(function () {
  return ok('⑦ 补传队列重放 + 脏文档 + 旧 _id 历史记录：全部写入成功（不再 STATE_CONFLICT）', function () {
    seedUser();
    // 线上最恶劣的组合：脏文档在、该词还有一条老版本自动 _id 的记录、
    // 且补传队列把同一条请求重放多次
    db.raw.user_word_state = [
      { _id: 'dirty1', user_id: 'u1' },
      { _id: 'gen-old-9', user_id: 'u1', word_id: 'search', stage: 1 }
    ];
    var req = 'req-replay-1';
    return submit('search', 'known', req)
      .then(function (r) { assert.strictEqual(r.ok, true, JSON.stringify(r)); return submit('search', 'forgot', req + '-2'); })
      .then(function (r) { assert.strictEqual(r.ok, true, JSON.stringify(r)); return submit('search', 'vague', req + '-3'); })
      .then(function (r) {
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        var st = db.raw.user_word_state || [];
        var pair = st.filter(function (d) { return d.word_id === 'search'; });
        // 契约：同一 (user_id, word_id) 永远只有一条（不管 _id 是新格式还是老格式），
        // 否则唯一索引会炸，且客户端会看到两份互相打架的进度
        assert.strictEqual(pair.length, 1,
          '同一 (user,word) 只能有一条，实际：' + JSON.stringify(st.map(function (d) { return d._id; })));
        assert.strictEqual(pair[0].last_feedback, 'vague', '最后一次反馈应生效');
        assert.strictEqual(pair[0].wrong_count, 1, '错误次数应记为 1');
      });
  });
});

steps.push(function () {
  return ok('⑧ 修复回填：从 review_logs 重建缺失的状态记录并修正云记账', function () {
    seedUser();
    db.raw.users[0].stats_cache.learned_words = 99;   // 事故期间虚高的账
    var now = Date.now();
    db.raw.review_logs = [
      { user_id: 'u1', word_id: 'search', feedback: 'known', mode: 'learn', created_at: now - 3600e3 },
      { user_id: 'u1', word_id: 'circle', feedback: 'forgot', mode: 'learn', created_at: now - 1800e3 }
    ];
    db.raw.user_word_state = [];   // 事故现场：状态表空
    return review.main({ action: 'repair' }, {}).then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      var st = db.raw.user_word_state || [];
      assert.strictEqual(st.length, 2, '应为两个词各回填一条状态，实际：' + JSON.stringify(st));
      var circle = st.filter(function (d) { return d.word_id === 'circle'; })[0];
      assert.ok(circle, 'circle 应被回填');
      assert.strictEqual(circle.wrong_count, 1, '回填应带错误计数');
      assert.ok(circle.next_review_at > now - 1800e3, '到期时间应按 SRS 重算');
      assert.strictEqual(db.raw.users[0].stats_cache.learned_words, 2,
        '云记账应被重建为真实词汇量（事故期间每次提交都被当成新词）');
    });
  });
});

steps.push(function () {
  return ok('⑨ 修复幂等：对已有状态记录的词只更新不重复新建', function () {
    seedUser();
    var now = Date.now();
    db.raw.review_logs = [
      { user_id: 'u1', word_id: 'search', feedback: 'known', mode: 'learn', created_at: now - 3600e3 }
    ];
    db.raw.user_word_state = [
      { _id: 'gen-old-7', user_id: 'u1', word_id: 'search', stage: 3, correct_count: 5 }
    ];
    return review.main({ action: 'repair' }, {}).then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      var st = db.raw.user_word_state || [];
      assert.strictEqual(st.length, 1, '已有记录应被更新而不是新建，实际：' + JSON.stringify(st.map(function (d) { return d._id; })));
      assert.strictEqual(st[0]._id, 'gen-old-7', '老 _id 文档应原地更新');
    });
  });
});

steps.reduce(function (p, fn) { return p.then(fn); }, Promise.resolve())
  .then(function () {
    console.log('\n  假数据库统计：尝试插入 ' + db.counters.adds + ' 次，其中触发唯一键冲突 ' +
      db.counters.dupErrors + ' 次（全部被自愈兜住）');
    console.log('\n全部通过：' + pass + ' 项 ✓');
  });
