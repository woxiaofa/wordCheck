/**
 * 情景填句素材（共享模块 · 唯一真相来源）
 *
 * 为什么要有它：竞品普遍只做到"词"一级，而老师真的听写、真的考试都是"句子"级。
 * 给中文 + 场景，把句子里的目标词挖空让孩子拼，既考拼写又考用法 —— 这也是
 * D4 宣传片里承诺的形态（给中文给图，把句子补完整）。
 *
 * 数据格式：key 是词的小写形式；en 拆成 [挖空前, 挖空后] 两段，拼装即完整句子。
 * 取舍：例句必须自撰或已授权（释义与例句是受保护的作品，不能爬），
 * 所以先只覆盖 2024 外研四上 Unit 2（家务主题，42 词里挑出 36 个能造句的）。
 * 没覆盖到的词不会出错 —— quiz.buildQuestion 会自动降级成普通拼写题。
 */
var SENTENCES = {
  clean: { pic: '🧹', cn: '我每天打扫我的房间。', en: ['I ', ' my room every day.'] },
  desk: { pic: '🪑', cn: '我的书桌现在很整齐。', en: ['My ', ' is tidy now.'] },
  house: { pic: '🏠', cn: '我们一起打扫房子。', en: ['We clean the ', ' together.'] },
  also: { pic: '👦', cn: '我也帮忙做晚饭。', en: ['I ', ' help cook dinner.'] },
  pig: { pic: '🐷', cn: '猪在院子里。', en: ['The ', ' is in the yard.'] },
  wash: { pic: '🍽️', cn: '晚饭后我洗碗。', en: ['I ', ' the dishes after dinner.'] },
  dish: { pic: '🍽️', cn: '这个盘子现在干净了。', en: ['The ', ' is clean now.'] },
  feed: { pic: '🐄', cn: '我每天早上喂奶牛。', en: ['I ', ' the cow every morning.'] },
  sweep: { pic: '🧹', cn: '我每天扫地。', en: ['I ', ' the floor every day.'] },
  floor: { pic: '🧹', cn: '地板脏了。', en: ['The ', ' is dirty.'] },
  rubbish: { pic: '🗑️', cn: '我每天倒垃圾。', en: ['I take out the ', ' every day.'] },
  chore: { pic: '🧺', cn: '做这件家务不容易。', en: ['Doing this ', ' is not easy.'] },
  may: { pic: '🙋', cn: '妈妈，我可以出去玩吗？', en: ['Mum, ', ' I play outside?'] },
  outside: { pic: '🌳', cn: '我们放学后在外面玩。', en: ['We play ', ' after school.'] },
  tidy: { pic: '📚', cn: '我收拾我的书桌。', en: ['I ', ' my desk.'] },
  easy: { pic: '✅', cn: '这个任务很容易。', en: ['This job is ', '.'] },
  job: { pic: '👍', cn: '干得好，山姆！', en: ['Good ', ', Sam!'] },
  dirty: { pic: '🧱', cn: '墙很脏。', en: ['The wall is ', '.'] },
  wall: { pic: '🧱', cn: '墙现在干净了。', en: ['The ', ' is clean now.'] },
  again: { pic: '🔁', cn: '请再做一次。', en: ['Please do it ', '.'] },
  problem: { pic: '🙆', cn: '没问题，我可以帮忙。', en: ['No ', ', I can help.'] },
  finish: { pic: '✔️', cn: '我八点做完作业。', en: ['I ', ' my homework at eight.'] },
  sunshine: { pic: '☀️', cn: '今天的阳光很温暖。', en: ['The ', ' is warm today.'] },
  must: { pic: '❗', cn: '你必须先做完它。', en: ['You ', ' finish it first.'] },
  sometimes: { pic: '😪', cn: '我有时会觉得累。', en: ['', ' I feel tired.'] },
  feel: { pic: '😪', cn: '做完家务我觉得累。', en: ['I ', ' tired after the chores.'] },
  tired: { pic: '😄', cn: '我很累，但是很开心。', en: ['I am ', ' but happy.'] },
  helpful: { pic: '🤝', cn: '他是个乐于助人的人。', en: ['He is very ', '.'] },
  warm: { pic: '♨️', cn: '水是温的。', en: ['The water is ', '.'] },
  water: { pic: '🌷', cn: '我每天给花浇水。', en: ['I ', ' the flowers every day.'] },
  yard: { pic: '🏡', cn: '我们在院子里玩。', en: ['We play in the ', '.'] },
  helper: { pic: '🤝', cn: '你是我的好帮手。', en: ['You are a good ', '.'] },
  pick: { pic: '🍎', cn: '我星期天摘苹果。', en: ['I ', ' apples on Sunday.'] },
  cow: { pic: '🐄', cn: '奶牛在吃草。', en: ['The ', ' eats grass.'] },
  cut: { pic: '🌿', cn: '我修剪草坪。', en: ['I ', ' the grass.'] },
  grass: { pic: '🌿', cn: '草很绿。', en: ['The ', ' is green.'] }
};

module.exports = {
  /** 取某个词的情景句；没有就返回 null（调用方降级成普通拼写题） */
  get: function (word) {
    if (!word) return null;
    return SENTENCES[String(word).toLowerCase()] || null;
  },
  /** 拼出完整句子（填完空后读一遍用） */
  full: function (item, filled) {
    if (!item) return '';
    return item.en[0] + (filled || '') + item.en[1];
  },
  count: function () { return Object.keys(SENTENCES).length; }
};
