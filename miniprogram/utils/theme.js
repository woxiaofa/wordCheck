/**
 * 界面皮肤（1.2.0）
 *
 * 设计取向：
 *   1. 默认「夜色」的 token 取值与原深色硬编码逐一对齐 —— 变量化改造后视觉零变化。
 *   2. 换肤靠「给页面根节点挂 skin-xxx 类」，CSS 变量从根节点往下继承，
 *      包括被 page 引用的自定义组件（小程序自定义组件无样式隔离槽位，继承照常）。
 *   3. 功能色（对/错/警示/金币/主题紫）不参与换肤 —— 语义色跟着皮肤变会让人看不懂对错。
 *   4. 解锁留三层：free 默认开放 / tasks 完成 N 次任务 / paid 预留（个人主体暂不可支付）。
 */

var KEY = 'word_skin_id';

/**
 * 皮肤清单。
 * tokens 未列出的键会继承 skin-night（默认）的值，新增皮肤只需写差异部分。
 */
var SKINS = [
  {
    id: 'night',
    name: '夜色',
    desc: '默认深色，晚上背词不刺眼',
    unlock: { type: 'free' },
    tokens: {
      bg: '#0f1620', bg2: '#101a24',
      surface: '#18222e', surface2: '#1e2a38', surface3: '#243040',
      fill: '#16202c', fill2: '#16222f', fill3: '#141d28',
      line: '#2b3949', line2: '#223044', line3: '#22303f',
      line4: '#26313f', line5: '#2c4157', line6: '#223042',
      text: '#e8eef5', text2: '#e8f0f8', text3: '#cfe0f0',
      muted: '#8fa3b7', muted2: '#8b9bad', muted3: '#8fa8c0',
      muted4: '#7f93a8', muted5: '#6b7a8c',
      accent: '#3ea6ff', active: '#3a4a5e'
    }
  }
];

function byId(id) {
  for (var i = 0; i < SKINS.length; i++) {
    if (SKINS[i].id === id) return SKINS[i];
  }
  return SKINS[0];
}

/** 当前皮肤 id，读不到就用夜色 */
function skinId() {
  try {
    return wx.getStorageSync(KEY) || 'night';
  } catch (e) {
    return 'night';
  }
}

/** 页面根节点要挂的类名，如 skin-night */
function cls() {
  return 'skin-' + skinId();
}

/** 换肤：只在白名单内生效，返回是否成功 */
function set(id) {
  if (!byId(id) || id !== byId(id).id) return false;
  try {
    wx.setStorageSync(KEY, id);
  } catch (e) {
    return false;
  }
  return true;
}

/** 是否已解锁：type=free 恒 true；tasks 看完成次数；paid 暂一律 false（预留） */
function unlocked(skin, doneCount) {
  if (!skin) return false;
  if (skin.unlock.type === 'free') return true;
  if (skin.unlock.type === 'tasks') return (doneCount || 0) >= (skin.unlock.need || 0);
  if (skin.unlock.type === 'paid') return false;
  return false;
}

module.exports = {
  KEY: KEY,
  SKINS: SKINS,
  skinId: skinId,
  cls: cls,
  set: set,
  unlocked: unlocked
};
