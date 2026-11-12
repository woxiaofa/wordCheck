/**
 * 「开始背单词」体验课固定素材（2026-11-12 用户拍板的贯穿式口语流程）
 *
 * 为什么是固定一课，而不是每次从今日任务现拼：
 *   ① 短句 / 小段必须**先离线合成示范音**才能"出来就主动读一遍"，
 *      动态拼出来的句子没有音频，只能静默降级，体验就断在这里；
 *   ② 陌生人第一次进来要的是一条 3 分钟能走完的完整闭环，
 *      不是"今天该复习的 10 个随机词"；今日任务仍在后面的正式背词阶段照常生效。
 *
 * 版权：例句与中文全部自撰（与 utils/sentences.js 同一套自撰素材），
 * 不引用教材原文、不爬词典。词条的释义/音标取自 MIT 协议的 ECDICT 派生词库。
 *
 * 三级材料的顺序是用户原话：
 *   「词读完，短句读短句读完，一小段大概两三句读」—— 长篇文章体验版不提供。
 * 本课的"一小段"就是 3 句；将来老师留作业要逐句判断，属于下一阶段。
 *
 * audio 字段：句 / 段示范音由 scripts/gen_lesson_audio.py 用 Piper 离线合成，
 * 落在 pkg-oral/assets/lesson/（pkg-media 只剩 22KB，新音频一律不往里塞）。
 * 词级示范音不用这里 —— 454 个词级 mp3 已在 pkg-media，走 oral.speak() 只播本地。
 */

/** 本课 4 个词：都能在本地音频清单命中，且能串成一个「收拾房间」的小段 */
var WORDS = [
  { word: 'clean', phonetic: '/kli:n/', cn: '清理；使干净',
    sentence: 'I clean my room every day.', sentenceCn: '我每天打扫我的房间。', audio: 's1.mp3' },
  { word: 'desk', phonetic: '/desk/', cn: '书桌；办公桌',
    sentence: 'My desk is tidy now.', sentenceCn: '我的书桌现在很整齐。', audio: 's2.mp3' },
  { word: 'tidy', phonetic: '/ˈtaɪdi/', cn: '整理，收拾',
    sentence: 'I tidy my desk.', sentenceCn: '我收拾我的书桌。', audio: 's3.mp3' },
  { word: 'house', phonetic: '/haʊs/', cn: '房屋',
    sentence: 'We clean the house together.', sentenceCn: '我们一起打扫房子。', audio: 's4.mp3' }
];

/** 一小段：两三句，全部用本课的词自撰 */
var SEGMENTS = [
  {
    lines: [
      'I tidy my desk.',
      'Then I clean my room.',
      'Our house is clean now.'
    ],
    cn: '我收拾书桌。然后打扫房间。我们的房子现在干净了。',
    audio: 'p1.mp3'
  }
];

var AUDIO_DIR = '/pkg-oral/assets/lesson/';

/**
 * 带读条目：词 → 短句 → 小段，逐条出来、逐条过关。
 * 每条都是评分器的 refText（英文文本），页面只按 kind 决定怎么显示 / 怎么发音。
 * @returns {Array<{id,kind,label,refText,display,lines,cn,phonetic,word,audio}>}
 */
function buildItems() {
  var out = [];
  WORDS.forEach(function (w, i) {
    out.push({
      id: 'w' + i,
      kind: 'word',
      label: '词',
      refText: w.word,
      display: w.word,
      lines: [],
      cn: w.cn,
      phonetic: w.phonetic,
      word: w.word,
      audio: ''
    });
  });
  WORDS.forEach(function (w, i) {
    out.push({
      id: 's' + i,
      kind: 'sentence',
      label: '短句',
      refText: w.sentence,
      display: w.sentence,
      lines: [],
      cn: w.sentenceCn,
      phonetic: '',
      word: w.word,
      audio: AUDIO_DIR + w.audio
    });
  });
  SEGMENTS.forEach(function (s, i) {
    out.push({
      id: 'p' + i,
      kind: 'segment',
      label: '小段',
      refText: s.lines.join(' '),
      display: s.lines.join(' '),
      lines: s.lines.slice(),
      cn: s.cn,
      phonetic: '',
      word: '',
      audio: AUDIO_DIR + s.audio
    });
  });
  return out;
}

module.exports = {
  WORDS: WORDS,
  SEGMENTS: SEGMENTS,
  AUDIO_DIR: AUDIO_DIR,
  buildItems: buildItems
};
