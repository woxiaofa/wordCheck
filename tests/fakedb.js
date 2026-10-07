/**
 * 假数据库（云开发服务端 SDK 的最小复刻）—— 给"假库跑真云函数"的集成测试用。
 *
 * 为什么自己写：云开发的几个坑只有复刻了才测得出来 ——
 *   1) set 的 data 里带 _id 必抛 -501007（cloud-review 版假库复刻了这条）
 *   2) 写不存在的集合报 -502005（createCollection 才能建）
 *   3) update 一个不存在的文档会静默返回 updated:0（不是报错！）
 * 本文件是 assignment-coherence / assignment-personal 共用的基础件。
 */

function createFakeDb(opts) {
  opts = opts || {};
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
        if (cond.__op === 'lt' && !(val !== undefined && val < cond.v)) return false;
        if (cond.__op === 'gt' && !(val !== undefined && val > cond.v)) return false;
        if (cond.__op === 'lte' && !(val !== undefined && val <= cond.v)) return false;
        if (cond.__op === 'gte' && !(val !== undefined && val >= cond.v)) return false;
        if (cond.__op === 'in' && cond.v.indexOf(val) === -1) return false;
        continue;
      }
      // 云端语义：字段是数组时，等值条件会匹配数组里的元素（tags:['中考'] 能被 {tags:'中考'} 命中）
      if (Array.isArray(val) && !Array.isArray(cond)) {
        if (val.indexOf(cond) === -1) return false;
        continue;
      }
      if (val !== cond) return false;
    }
    return true;
  }

  var command = {
    lt: function (v) { return { __op: 'lt', v: v }; },
    gt: function (v) { return { __op: 'gt', v: v }; },
    lte: function (v) { return { __op: 'lte', v: v }; },
    gte: function (v) { return { __op: 'gte', v: v }; },
    in: function (arr) { return { __op: 'in', v: arr }; }
  };

  /** 查询链。rows 是当时的快照，每个算子都返回新链（与云开发的链式调用一致） */
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
      // 不带 where 的全表链式入口（task.today 取词库 / class.onAssign 选词走这条）
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
            // 云端真实行为：文档不存在时静默 updated:0（不报错）—— 假成功事故的源头
            return Promise.resolve({ stats: { updated: i === -1 ? 0 : 1 } });
          },
          set: function (o) {
            if (opts.strictSetId && o.data && o.data._id !== undefined) {
              return Promise.reject(new Error(
                'document.set:fail -501007 invalid parameter, 不能更新_id的值'));
            }
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
    // 云端真实行为：集合必须显式创建（写不存在的集合报 -502005），已存在则报 already exists
    createCollection: function (name) {
      if (colls[name]) {
        return Promise.reject(new Error('-502001 already exists: ' + name));
      }
      colls[name] = [];
      return Promise.resolve({});
    },
    raw: colls,
    reset: function () { Object.keys(colls).forEach(function (k) { delete colls[k]; }); },
    seed: function (name, docs) { colls[name] = clone(docs); }
  };
}

module.exports = { create: createFakeDb };
