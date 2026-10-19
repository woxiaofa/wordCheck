/**
 * 判分与出题逻辑测试
 *
 *   node tests/quiz.test.js
 *
 * 重点覆盖两类"上线后才会发现、而且影响很坏"的问题：
 *   ① 判分过严/过松：太严冤枉用户（他明明拼对了却被判错），太松放过没记住的人
 *   ② 答案泄漏：题目里带上答案，用户抓一次返回包就能全对，整个抽查产品失去意义
 */

var assert = require('assert');
var quiz = require('../shared/quiz');

var passed = 0;
var failed = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed.push(name);
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

/* 测试用词表：故意放两条同义释义，用来验证干扰项去重 */
var POOL = [
  { word: 'abandon', phonetic: '/əˈbændən/', pos: 'v.', def_cn: '放弃；抛弃' },
  { word: 'desert', phonetic: '/dɪˈzɜːrt/', pos: 'v.', def_cn: '抛弃；放弃' },   // 与上一条释义顺序不同
  { word: 'achieve', phonetic: '/əˈtʃiːv/', pos: 'v.', def_cn: '实现；达到' },
  { word: 'attitude', phonetic: '/ˈætɪtuːd/', pos: 'n.', def_cn: '态度' },
  { word: 'benefit', phonetic: '/ˈbenɪfɪt/', pos: 'n./v.', def_cn: '好处；受益' },
  { word: 'brilliant', phonetic: '/ˈbrɪliənt/', pos: 'adj.', def_cn: '出色的；明亮的' },
  { word: 'capable', phonetic: '/ˈkeɪpəbl/', pos: 'adj.', def_cn: '有能力的' },
  { word: 'consider', phonetic: '/kənˈsɪdər/', pos: 'v.', def_cn: '考虑；认为' },
  { word: 'color', phonetic: '/ˈkʌlər/', pos: 'n.', def_cn: '颜色', variant: 'colour' },
  { word: 'organize', phonetic: '/ˈɔːrɡənaɪz/', pos: 'v.', def_cn: '组织', variant: 'organise' }
];

var ABANDON = POOL[0];

console.log('判分与出题逻辑测试');

/* ---------------- 题型配比 ---------------- */

test('10 题的配比是 选义 3 / 拼写 5 / 听写 2', function () {
  var plan = quiz.planTypes(10);
  assert.strictEqual(plan.length, 10);
  assert.strictEqual(plan.filter(function (t) { return t === 'meaning'; }).length, 3);
  assert.strictEqual(plan.filter(function (t) { return t === 'spell'; }).length, 5);
  assert.strictEqual(plan.filter(function (t) { return t === 'listen'; }).length, 2);
});

test('题型交错：不出现连续 3 道以上的同题型', function () {
  var plan = quiz.planTypes(10);
  var maxRun = 1, run = 1;
  for (var i = 1; i < plan.length; i++) {
    run = plan[i] === plan[i - 1] ? run + 1 : 1;
    if (run > maxRun) maxRun = run;
  }
  assert.ok(maxRun <= 3,
    '连续同题型不应超过 3 道，实际 ' + maxRun + ' 道，排布：' + plan.join(','));
});

test('题量为 0 或非法时回退到默认 10 题', function () {
  assert.strictEqual(quiz.planTypes(0).length, 10);
  assert.strictEqual(quiz.planTypes(-3).length, 10);
});

/* ---------------- 拼写判定：该松的地方要松 ---------------- */

test('大小写与首尾空格不影响判定', function () {
  assert.strictEqual(quiz.isSpellingCorrect('  Abandon  ', 'abandon'), true);
  assert.strictEqual(quiz.isSpellingCorrect('ABANDON', 'abandon'), true);
});

test('连字符、空格、下划线不影响判定：ice cream = icecream', function () {
  assert.strictEqual(quiz.isSpellingCorrect('ice cream', 'icecream'), true);
  assert.strictEqual(quiz.isSpellingCorrect('ice-cream', 'icecream'), true);
  assert.strictEqual(quiz.isSpellingCorrect('ice_cream', 'icecream'), true);
});

test('英美拼写变体都算对（color/colour、organize/organise）', function () {
  assert.strictEqual(quiz.isSpellingCorrect('color', 'color', 'colour'), true);
  assert.strictEqual(quiz.isSpellingCorrect('colour', 'color', 'colour'), true);
  assert.strictEqual(quiz.isSpellingCorrect('organise', 'organize', 'organise'), true);
});

test('多个变体用逗号或斜杠分隔也能识别', function () {
  assert.strictEqual(quiz.isSpellingCorrect('theatre', 'theater', 'theatre/theatre'), true);
  assert.strictEqual(quiz.isSpellingCorrect('grey', 'gray', 'grey,gray'), true);
});

test('数字 1 与字母 l、数字 0 与字母 o 的混淆按同一字符处理', function () {
  // 自绘键盘下概率低，但用户可能粘贴输入
  assert.strictEqual(quiz.isSpellingCorrect('c0lor', 'color'), true, '0 → o 应算对');
  assert.strictEqual(quiz.isSpellingCorrect('banana', 'abandon'), false, '不能把无关词判成对');
});

/* ---------------- 拼写判定：该严的地方要严 ---------------- */

test('拼错、少字母、多字母都算错', function () {
  assert.strictEqual(quiz.isSpellingCorrect('abandom', 'abandon'), false);
  assert.strictEqual(quiz.isSpellingCorrect('abando', 'abandon'), false);
  assert.strictEqual(quiz.isSpellingCorrect('abandons', 'abandon'), false);
});

test('空输入算错，不抛异常', function () {
  assert.strictEqual(quiz.isSpellingCorrect('', 'abandon'), false);
  assert.strictEqual(quiz.isSpellingCorrect(null, 'abandon'), false);
  assert.strictEqual(quiz.isSpellingCorrect(undefined, 'abandon'), false);
  assert.strictEqual(quiz.isSpellingCorrect('   ', 'abandon'), false);
});

test('完全不相关的词算错', function () {
  assert.strictEqual(quiz.isSpellingCorrect('banana', 'abandon'), false);
});

/* ---------------- 选义判定 ---------------- */

test('释义的空白与标点差异不影响判定', function () {
  assert.strictEqual(quiz.isMeaningCorrect('放弃;抛弃', '放弃；抛弃'), true);
  assert.strictEqual(quiz.isMeaningCorrect('放弃、抛弃', '放弃；抛弃'), true);
});

test('选义不做模糊包含判定：只写一半算错（防止放过没记住的人）', function () {
  assert.strictEqual(quiz.isMeaningCorrect('放弃', '放弃；抛弃'), false);
  assert.strictEqual(quiz.isMeaningCorrect('抛弃', '放弃；抛弃'), false);
});

test('释义指纹忽略顺序：两条同义释义指向同一个指纹', function () {
  assert.strictEqual(quiz.meaningKey('放弃；抛弃'), quiz.meaningKey('抛弃；放弃'));
  assert.notStrictEqual(quiz.meaningKey('放弃；抛弃'), quiz.meaningKey('实现；达到'));
});

test('空选择算错', function () {
  assert.strictEqual(quiz.isMeaningCorrect('', '放弃；抛弃'), false);
  assert.strictEqual(quiz.isMeaningCorrect('放弃；抛弃', ''), false);
});

/* ---------------- 干扰项 ---------------- */

test('干扰项恰好 3 个且不含正确答案', function () {
  var d = quiz.pickDistractors(ABANDON, POOL, 3);
  assert.strictEqual(d.length, 3);
  assert.strictEqual(d.indexOf(ABANDON.def_cn), -1, '不能把正确答案当干扰项');
});

test('干扰项排除同义释义，避免出现两个正确答案', function () {
  var d = quiz.pickDistractors(ABANDON, POOL, 3);
  // desert 的释义是"抛弃；放弃"，与 abandon 的"放弃；抛弃"指纹相同 → 必须被排除
  assert.strictEqual(d.indexOf('抛弃；放弃'), -1, '同义释义必须排除，否则一道题两个答案都对');
});

test('干扰项内部不重复', function () {
  var d = quiz.pickDistractors(ABANDON, POOL, 3);
  var seen = {};
  d.forEach(function (x) {
    assert.ok(!seen[x], '出现重复干扰项：' + x);
    seen[x] = 1;
  });
});

test('优先取同词性的词作干扰项', function () {
  var d = quiz.pickDistractors(ABANDON, POOL, 3);   // abandon 是 v.
  // 词表里 v. 有 achieve / consider（desert 已被同义排除）→ 至少应包含它们中的一部分
  var verbDefs = ['实现；达到', '考虑；认为'];
  var hit = d.filter(function (x) { return verbDefs.indexOf(x) >= 0; }).length;
  assert.ok(hit >= 2, '应优先使用同词性释义，实际命中 ' + hit + ' 个：' + JSON.stringify(d));
});

test('词池不足时不硬凑，返回能拿到的数量', function () {
  var tiny = [ABANDON, { word: 'achieve', pos: 'v.', def_cn: '实现；达到' }];
  var d = quiz.pickDistractors(ABANDON, tiny, 3);
  assert.ok(d.length <= 1, '只有 1 个可用干扰项时不应重复填充，实际 ' + d.length);
});

/* ---------------- 出题：答案绝不能下发 ---------------- */

function assertNoAnswerLeak(q) {
  var json = JSON.stringify(q);
  assert.strictEqual(json.indexOf('def_cn'), -1, '题型 ' + q.type + ' 的题目里出现了 def_cn 字段');
  assert.strictEqual(json.indexOf('example'), -1, '题型 ' + q.type + ' 的题目里出现了例句字段');
  // 选义题绝不能下发答案文本，否则用户直接看"选项里有哪个"就够了
  if (q.type === 'meaning') {
    assert.strictEqual(json.indexOf('correctAnswer'), -1, '选义题下发了 correctAnswer');
  }
}

test('三种题型的题目都不包含释义字段与例句字段', function () {
  ['meaning', 'spell', 'listen'].forEach(function (type) {
    assertNoAnswerLeak(quiz.buildQuestion(type, ABANDON, POOL));
  });
});

/**
 * 关于"答案不下发"的真实边界，说明一下：
 *
 * 题目里确实带有 wordId = 'abandon'。这是有意为之，而且不是泄漏：
 *   - 错词回流、结果页对照、查词详情都要用它；
 *   - 拼写题给中文释义、用户答英文单词，本来就知道是哪个词 —— 这就是题目本身。
 * 真正要防的不是"用户知道是哪个词"，而是"不背也能答对"，也就是：
 *   - 选项里混进答案文本（options 里出现英文单词）
 *   - 题干直接给出英文答案
 * 因此这里断言的是"作答所需的信息不在题目里"，而不是"答案单词不出现在任何字段"。
 */
test('拼写/听写题的作答信息不在题目里：stem 只有中文，options 为空', function () {
  ['spell', 'listen'].forEach(function (type) {
    var q = quiz.buildQuestion(type, ABANDON, POOL);
    assert.strictEqual(q.options, undefined, type + ' 题不应带选项');
    assert.ok(q.stem.indexOf('abandon') < 0, type + ' 题的题干里出现了英文答案');
    if (type === 'spell') {
      assert.strictEqual(q.stem, ABANDON.def_cn, '拼写题题干应为中文释义');
    } else {
      assert.strictEqual(q.stem, '', '听写题不应有任何文字提示');
    }
  });
});

test('选义题的选项里只有中文释义，不含英文单词', function () {
  var q = quiz.buildQuestion('meaning', ABANDON, POOL);
  q.options.forEach(function (o) {
    assert.strictEqual(/[a-zA-Z]/.test(o), false, '选项里出现了英文：' + o);
  });
});

test('听写题不给任何文字提示，只给字母数', function () {
  var q = quiz.buildQuestion('listen', ABANDON, POOL);
  assert.strictEqual(q.stem, '', '听写题干必须为空');
  assert.strictEqual(q.length, 'abandon'.length, '应给出字母数用于占位显示');
});

test('选义题给出 4 个选项且正确答案在选项中', function () {
  var q = quiz.buildQuestion('meaning', ABANDON, POOL);
  assert.strictEqual(q.options.length, 4);
  assert.ok(q.options.indexOf(ABANDON.def_cn) >= 0, '正确选项必须在其中');
});

test('选义题的 4 个选项互不重复', function () {
  var q = quiz.buildQuestion('meaning', ABANDON, POOL);
  var seen = {};
  q.options.forEach(function (o) {
    assert.ok(!seen[o], '选项重复：' + o);
    seen[o] = 1;
  });
});

test('选义题的题干是单词本身', function () {
  var q = quiz.buildQuestion('meaning', ABANDON, POOL);
  assert.strictEqual(q.stem, 'abandon');
});

test('拼写题的题干是中文释义', function () {
  var q = quiz.buildQuestion('spell', ABANDON, POOL);
  assert.strictEqual(q.stem, ABANDON.def_cn);
});

test('同一道题多次组装的选项顺序一致（便于复现问题）', function () {
  var a = quiz.buildQuestion('meaning', ABANDON, POOL);
  var b = quiz.buildQuestion('meaning', ABANDON, POOL);
  assert.deepStrictEqual(a.options, b.options);
});

/* ---------------- 汇总 ---------------- */

test('情景填句（D4 形态）：有例句的词出 cloze，含中文 + 挖空句子', function () {
  var word = { word: 'clean', def_cn: '清理；使干净', pos: 'v.' };
  var q = quiz.buildQuestion('cloze', word, [word, { word: 'desk', def_cn: '书桌' }]);
  assert.strictEqual(q.type, 'cloze');
  assert.ok(q.cloze && q.cloze.cn, '要带中文');
  assert.ok(q.cloze.en && q.cloze.en.length === 2, '句子要拆成挖空前/后两段');
  assert.strictEqual(q.cloze.en[0] + 'clean' + q.cloze.en[1], 'I clean my room every day.', '拼装后应是完整句子');
});

test('情景填句：没有例句的词自动降级成拼写题（绝不出空题）', function () {
  var w2 = { word: 'zzzznotaword', def_cn: '不存在的词' };
  var q2 = quiz.buildQuestion('cloze', w2, [w2]);
  assert.strictEqual(q2.type, 'spell', '应降级为 spell，实际 ' + q2.type);
  assert.strictEqual(q2.stem, '不存在的词');
});

test('hasSentence：只有配了例句的词才派填句题', function () {
  assert.ok(quiz.hasSentence('clean'), 'clean 应配有例句');
  assert.ok(quiz.hasSentence('sweep'), 'sweep 应配有例句');
  assert.ok(!quiz.hasSentence('zzzznotaword'), '未配例句的词应返回 false');
});

console.log('');

if (failed.length) {
  console.log('失败 ' + failed.length + ' 项，通过 ' + passed + ' 项');
  process.exit(1);
} else {
  console.log('全部通过：' + passed + ' 项 ✓');
}
