/**
 * 跟读口令编解码自检（纯函数，不需要 wx 桩）
 *
 * 口令是第 1 期「老师给的文本怎么到学生手里」的唯一通道：没有服务端，
 * 全靠微信里复制一段文本。所以它必须能挡住截断、手抄错字、夹带多余字段，
 * 而且失败时要给人话，不能静默导入半截文本。
 */
var assert = require('assert');
var code = require('../miniprogram/utils/oral-code.js');

var pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}
console.log('\n跟读口令自检');

/** 手工造一条合法口令（可夹带任意字段，用来验证解码侧的白名单） */
function craft(obj) {
  var body = code.b64encode(JSON.stringify(obj));
  return 'WC1.' + body + '.' + code.checksum(body);
}

ok('① 往返一致：文本、词数、类型、时间戳都能还原', function () {
  var r = code.encode({ ref: 'The cat is on the mat.', t: 'custom', ts: 1700000000000 });
  assert.strictEqual(r.ok, true, r.reason);
  var d = code.decode(r.code);
  assert.strictEqual(d.ok, true, d.reason);
  assert.strictEqual(d.data.ref, 'The cat is on the mat.');
  assert.strictEqual(d.data.n, 6);
  assert.strictEqual(d.data.t, 'custom');
  assert.strictEqual(d.data.ts, 1700000000000);
});

ok('② 版本前缀 WC1；不支持的版本明确报「版本不支持」', function () {
  var r = code.encode({ ref: 'apple' });
  assert.strictEqual(r.code.indexOf(code.PREFIX + '.'), 0);
  var bad = code.decode('WX1.AAAA.0000');
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.reason.indexOf('版本不支持') >= 0, bad.reason);
});

ok('③ 正文改动 1 个字符即被校验和拦下', function () {
  var parts = code.encode({ ref: 'hello world' }).code.split('.');
  var i = Math.floor(parts[1].length / 2);
  var ch = parts[1].charAt(i) === 'A' ? 'B' : 'A';
  var tampered = 'WC1.' + parts[1].slice(0, i) + ch + parts[1].slice(i + 1) + '.' + parts[2];
  var bad = code.decode(tampered);
  assert.strictEqual(bad.ok, false, '改了一个字符却放行了');
});

ok('④ 校验和本身被改也要拦下', function () {
  var parts = code.encode({ ref: 'hello world' }).code.split('.');
  var wrong = parts[2] === 'ffff' ? '0000' : 'ffff';
  assert.strictEqual(code.decode('WC1.' + parts[1] + '.' + wrong).ok, false);
});

ok('⑤ 超过 600 字符的口令被拒', function () {
  var bad = code.decode('WC1.' + new Array(701).join('A') + '.0000');
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.reason.indexOf('太长') >= 0, bad.reason);
});

ok('⑥ 中文等非法字符：编码时拒绝，不给膨胀后的口令', function () {
  var r = code.encode({ ref: '你好 hello' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.indexOf('英文') >= 0, r.reason);
});

ok('⑦ 字段白名单：口令里夹带的隐私字段一律丢弃', function () {
  var d = code.decode(craft({
    v: 1, t: 'custom', ref: 'hello world', n: 2, ts: 123,
    evil: 'steal', phone: '13800000000', name: 'xiaoming'
  }));
  assert.strictEqual(d.ok, true, d.reason);
  assert.strictEqual(Object.keys(d.data).length, 5, '只应回 5 个字段');
  assert.strictEqual(d.data.phone, undefined);
  assert.strictEqual(d.data.name, undefined);
  assert.strictEqual(d.data.evil, undefined);
});

ok('⑧ 朗读文本超过 200 字被拒（编码侧与解码侧都拦）', function () {
  var long = new Array(202).join('a');   // 201 个 a
  assert.strictEqual(code.encode({ ref: long }).ok, false);
  var d = code.decode(craft({ v: 1, t: 'custom', ref: long, n: 1, ts: 1 }));
  assert.strictEqual(d.ok, false);
  assert.ok(d.reason.indexOf('不合法') >= 0, d.reason);
});

ok('⑨ 词数 n 与实际文本不一致时拒绝', function () {
  var d = code.decode(craft({ v: 1, t: 'custom', ref: 'hello world', n: 99, ts: 1 }));
  assert.strictEqual(d.ok, false);
  assert.ok(d.reason.indexOf('词数') >= 0, d.reason);
});

ok('⑩ 自实现 base64 的往返（含 = 填充，两端不依赖 Buffer/btoa）', function () {
  ['a', 'ab', 'abc', 'abcd', 'The cat is on the mat.', '{"v":1}'].forEach(function (s) {
    assert.strictEqual(code.b64decode(code.b64encode(s)), s);
  });
});

ok('⑪ 空口令 / 缺段 / 空文本都给人话提示', function () {
  assert.ok(code.decode('').reason.indexOf('空') >= 0);
  assert.ok(code.decode('WC1.abc').reason.indexOf('不完整') >= 0);
  assert.ok(code.encode({ ref: '' }).reason.length > 0);
  assert.ok(code.encode({ ref: '！？' }).reason.length > 0);
});

ok('⑫ 200 字边界内可以生成，且整条口令不超过 600 字符', function () {
  var ref = new Array(201).join('a');   // 恰好 200 个 a
  var r = code.encode({ ref: ref });
  assert.strictEqual(r.ok, true, r.reason);
  assert.ok(r.code.length <= 600, '口令长度 ' + r.code.length);
  assert.strictEqual(code.decode(r.code).data.n, 1);
});

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 项 ✓' +
  (fail ? '，失败 ' + fail + ' 项' : ''));
process.exit(fail ? 1 : 0);
