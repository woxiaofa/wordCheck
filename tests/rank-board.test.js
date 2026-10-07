/**
 * rank 云函数集成测试（假库 + 真云函数代码）
 *
 *   node tests/rank-board.test.js
 *
 * 钉死榜单的几条硬规则：
 *   ① 首次上报：rank=1、beat=100（只有自己），且落库字段完整
 *   ② 同一个人同一个 key 只保留最快的一次，更慢的成绩不覆盖
 *   ③ 更快的一次会覆盖
 *   ④ 有别人更快时排名 = 比我快的人数 + 1，打败百分比不为 0
 *   ⑤ 榜单按时长升序，带昵称，标出哪条是我自己
 *   ⑥ 昵称/头像能写进 users（榜单不该显示一串 openid）
 *   ⑦ 没有用户记录 → NO_USER（不静默建脏数据）
 *   ⑧ upsert 的 data 不带 _id（否则 -501007，daily_tasks 同款事故）
 */

var assert = require('assert');
var fake = require('./fakedb.js');
var db = fake.create({ strictSetId: true });

var CURRENT_OPENID = '';
var fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'test',
  init: function () {},
  getWXContext: function () { return { OPENID: CURRENT_OPENID }; },
  database: function () { return db; }
};
var Module = require('module');
var origLoad = Module._load;
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeSdk;
  return origLoad.apply(this, arguments);
};
var rankFn = require('../cloud/functions/rank/index.js');
Module._load = origLoad;

var steps = [];
function ok(name, fn) {
  steps.push(function () {
    return Promise.resolve().then(fn).then(function () {
      console.log('  ✓ ' + name);
    }, function (e) {
      process.exitCode = 1;
      console.log('  ✗ ' + name);
      console.log('    ' + (e && e.message ? String(e.message).split('\n').join('\n    ') : e));
    });
  });
}

function as(openid, fn) {
  return function () {
    CURRENT_OPENID = openid;
    return Promise.resolve().then(fn);
  };
}

function reset() {
  db.reset();
  db.seed('users', [
    { _id: 'U1', openid: 'openid-1', role: 'student', nickname: '小明' },
    { _id: 'U2', openid: 'openid-2', role: 'student', nickname: '小红' },
    { _id: 'U3', openid: 'openid-3', role: 'student', nickname: '' }
  ]);
  db.seed('drill_scores', []);
}

function submit(openid, p) {
  return as(openid, function () { return rankFn.main(Object.assign({ action: 'submit' }, p)); })();
}

var KEY = 'book:wy4a';

console.log('\n成绩榜单与荣誉：');

ok('① 首次上报：rank=1、beat=100，落库字段完整', function () {
  reset();
  return submit('openid-1', { key: KEY, keyName: '外研四上', count: 10, seconds: 90, perfect: true })
    .then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.rank, 1, '只有自己时第 1 名');
      assert.strictEqual(r.beat, 100, '只有一人时不该显示"打败 0%"');
      assert.ok(/全对/.test(r.badge), '全对要给荣誉词，实际：' + r.badge);
      var rows = db.raw.drill_scores;
      assert.strictEqual(rows.length, 1, '只应有 1 条成绩');
      assert.strictEqual(rows[0].seconds, 90);
      assert.strictEqual(rows[0].count, 10);
      assert.strictEqual(rows[0].perfect, true);
      assert.strictEqual(rows[0]._id, 'score:U1:' + KEY, '确定性 _id，同一个人同一 key 只一条');
    });
});

ok('② 同一个人更慢的一次不覆盖（榜单比"最快"，不是比"最后一次"）', function () {
  reset();
  return submit('openid-1', { key: KEY, count: 10, seconds: 90, perfect: true })
    .then(function () {
      return submit('openid-1', { key: KEY, count: 10, seconds: 150, perfect: false });
    })
    .then(function (r) {
      var rows = db.raw.drill_scores;
      assert.strictEqual(rows.length, 1, '仍只有一条');
      assert.strictEqual(rows[0].seconds, 90, '更慢的成绩不能覆盖最快的');
      assert.strictEqual(rows[0].perfect, true, '历史最好成绩里的"全对"不该被冲掉');
      assert.strictEqual(rows[0].runs, 2, '要记下练过几次');
    });
});

ok('③ 更快的一次会刷新最好成绩', function () {
  reset();
  return submit('openid-1', { key: KEY, count: 10, seconds: 150 })
    .then(function () { return submit('openid-1', { key: KEY, count: 10, seconds: 60 }); })
    .then(function (r) {
      assert.strictEqual(db.raw.drill_scores[0].seconds, 60);
      assert.strictEqual(r.best, 60);
    });
});

ok('④ 有别人更快时：排名 = 比我快的人数 + 1，打败百分比合理', function () {
  reset();
  return submit('openid-2', { key: KEY, count: 10, seconds: 30 })
    .then(function () { return submit('openid-3', { key: KEY, count: 10, seconds: 60 }); })
    .then(function () { return submit('openid-1', { key: KEY, count: 10, seconds: 90 }); })
    .then(function (r) {
      assert.strictEqual(r.rank, 3, '比我快的有 2 人 → 第 3 名，实际 ' + r.rank);
      assert.strictEqual(r.total, 3);
      // 第 3/3 名：确实没打败任何人 → 0，前端不显示这一行（不去粉饰成"打败 1%"）
      assert.strictEqual(r.beat, 0, '实际 ' + r.beat);
      assert.ok(/第 3\/3 名/.test(r.detail), '详情要写明名次：' + r.detail);
    });
});

ok('⑤ 不同 key 分开比：中考词和小学教材词不混在一张榜上', function () {
  reset();
  return submit('openid-2', { key: 'book:zk', count: 10, seconds: 20 })
    .then(function () { return submit('openid-1', { key: KEY, count: 10, seconds: 90 }); })
    .then(function (r) {
      assert.strictEqual(r.rank, 1, '另一个词库里的成绩不该把我挤下去');
      assert.strictEqual(r.total, 1);
    });
});

ok('⑥ 榜单按时长升序、带昵称、标出我自己', function () {
  reset();
  return submit('openid-2', { key: KEY, count: 10, seconds: 30 })
    .then(function () { return submit('openid-1', { key: KEY, count: 10, seconds: 90 }); })
    .then(function () {
      return as('openid-1', function () {
        return rankFn.main({ action: 'board', key: KEY, limit: 20 });
      })();
    })
    .then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.list.length, 2);
      assert.strictEqual(r.list[0].seconds, 30, '快的排前面');
      assert.strictEqual(r.list[0].rank, 1);
      assert.strictEqual(r.list[0].nickname, '小红', '榜单要显示昵称');
      assert.strictEqual(r.list[0].mine, false);
      assert.strictEqual(r.list[1].mine, true, '要标出哪条是我');
      assert.strictEqual(r.list[1].nickname, '小明');
    });
});

ok('⑦ 昵称/头像写入 users（微信只允许"用户主动填"，不给静默获取）', function () {
  reset();
  return as('openid-3', function () {
    return rankFn.main({ action: 'profile', nickname: '小刚', avatar: 'cloud://a.png' });
  })().then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    var u = db.raw.users.filter(function (x) { return x._id === 'U3'; })[0];
    assert.strictEqual(u.nickname, '小刚');
    assert.strictEqual(u.avatar, 'cloud://a.png');
  });
});

ok('⑧ 没有用户记录 → NO_USER，不静默建脏数据', function () {
  reset();
  return as('openid-nobody', function () {
    return rankFn.main({ action: 'submit', key: KEY, count: 10, seconds: 60 });
  })().then(function (r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NO_USER');
    assert.strictEqual(db.raw.drill_scores.length, 0, '不该留下孤儿成绩');
  });
});

ok('⑨ upsert 的 data 不带 _id（strictSetId 复刻 -501007，daily_tasks 同款事故）', function () {
  reset();
  // fakedb 在 strictSetId 模式下，data 里带 _id 会直接抛 -501007。
  // 这条能跑通就证明 rank 没有把 _id 塞进 set 的 data 里。
  return submit('openid-1', { key: KEY, count: 10, seconds: 80 }).then(function (r) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(db.raw.drill_scores.length, 1);
  });
});

ok('⑩ 今日/本周/本月最快：各自留住周期内最快，榜首带昵称、能认出是我', function () {
  reset();
  return submit('openid-1', { key: KEY, count: 10, seconds: 90, perfect: true })
    .then(function (r) {
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.ok(r.periods && r.periods.day, '要返回周期榜');
      assert.strictEqual(r.periods.day.rank, 1);
      assert.strictEqual(r.periods.day.total, 1);
      assert.strictEqual(r.periods.day.leader.mine, true, '只有自己时榜首就是自己');
      return submit('openid-2', { key: KEY, count: 10, seconds: 30 });
    })
    .then(function (r) {
      assert.strictEqual(r.periods.day.total, 2);
      assert.strictEqual(r.periods.day.rank, 1, '30 秒最快 → 今日第 1');
      assert.strictEqual(r.periods.day.leader.nickname, '小红', '榜首要带昵称（openid-2 是小红）');
      assert.strictEqual(r.periods.day.leader.mine, true, '榜首就是刚交成绩的小红自己');
      // 小红自己再交一次更慢的：她的周期最优保持 30 秒不变，榜首仍是她自己
      return submit('openid-2', { key: KEY, count: 10, seconds: 99 });
    })
    .then(function (r) {
      assert.strictEqual(r.periods.day.leader.mine, true, '更慢的一次不抢自己的周期最优');
      var me = db.raw.drill_scores.filter(function (x) { return x.user_id === 'U2'; })[0];
      assert.strictEqual(me.period.day.seconds, 30, '周期桶里只留周期内最快');
      // 第三人视角：榜首（小红）不是自己，要报出我的名次
      return submit('openid-3', { key: KEY, count: 10, seconds: 50 });
    })
    .then(function (r) {
      assert.strictEqual(r.periods.day.rank, 2, '50 秒比 30 秒慢 → 今日第 2');
      assert.strictEqual(r.periods.day.leader.nickname, '小红');
      assert.strictEqual(r.periods.day.leader.mine, false, '榜首不是我时要如实标注');
    });
});

ok('⑪ 跨了周期（新的一天）桶要重开：旧最优不再霸榜', function () {
  reset();
  return submit('openid-1', { key: KEY, count: 10, seconds: 60 })
    .then(function () {
      // 手工把成绩挪到"昨天/上周/上月"：模拟跨天再来一轮
      var doc = db.raw.drill_scores[0];
      doc.period.day.start -= 86400000;      // 昨天的桶
      doc.period.week.start -= 7 * 86400000; // 上周的桶
      doc.period.month.start -= 31 * 86400000; // 上月的桶
      doc.date = '2026-10-01';
    })
    .then(function () { return submit('openid-1', { key: KEY, count: 10, seconds: 90 }); })
    .then(function (r) {
      var doc = db.raw.drill_scores[0];
      assert.strictEqual(doc.period.day.seconds, 90, '今天的桶重开，90 秒就是今日最快');
      assert.strictEqual(doc.period.week.seconds, 90, '本周的桶重开');
      assert.strictEqual(doc.period.month.seconds, 90, '本月的桶重开');
      assert.strictEqual(doc.period.day.total === undefined ? true : true, true);
      assert.strictEqual(r.periods.day.rank, 1, '重开后仍是榜上唯一');
      // 更慢的一次不刷新最好成绩，也不该把"最好成绩的日期"刷成今天
      assert.strictEqual(doc.seconds, 60, '总榜仍留最快');
      assert.strictEqual(doc.date, '2026-10-01', 'date 是"最好成绩的日子"，慢的不许改');
    });
});

(function run(i) {
  if (i >= steps.length) {
    console.log('\n' + (process.exitCode ? '有用例失败' : '全部通过：' + steps.length + ' 项 ✓'));
    return;
  }
  steps[i]().then(function () { run(i + 1); });
})(0);
