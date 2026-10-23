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
 * 为什么只有五套：蔷薇（rose）曾是第二套粉色，与樱粉并排几乎分辨不出，
 * 占一个里程碑又不产生获得感，故移除。浅色之间必须拉得开家族差异
 * （粉/橘/绿/蓝），宁可少一套也不要两套看着一样。
 * tokens 未列出的键会继承 skin-night（默认）的值，新增皮肤只需写差异部分。
 * 浅色皮肤的取值不是拍脑袋来的：每个「文字/底色」组合都跑过 WCAG 对比度校验，
 * 见 scripts/check-contrast.js 与 tests/theme.test.js（不达标会被测试拦下）。
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
  },
  {
    id: 'sakura',
    name: '樱粉',
    desc: '免费 · 白天暖调，看着不累',
    unlock: { type: 'free' },
    tokens: {
      bg: '#fff7fa', bg2: '#fdeff3',
      surface: '#ffffff', surface2: '#fff2f6', surface3: '#ffe3ec',
      fill: '#fff6f9', fill2: '#ffeff5', fill3: '#ffe8f0',
      line: '#eebfd2', line2: '#e8b6c9', line3: '#f0c4d5',
      line4: '#e8b8cb', line5: '#e4adc2', line6: '#f4d2df',
      text: '#3a2731', text2: '#4c3841', text3: '#6b555f',
      muted: '#8f6f7a', muted2: '#997a85', muted3: '#8c6c7d',
      muted4: '#a0848d', muted5: '#a07e88',
      accent: '#cf2b56', active: '#f6c9d7'
    }
  },
  {
    id: 'honey',
    name: '蜜橘',
    desc: '完成 5 次任务解锁',
    unlock: { type: 'tasks', need: 5 },
    tokens: {
      bg: '#fffaf1', bg2: '#fdf4e6',
      surface: '#ffffff', surface2: '#fff3e1', surface3: '#ffe4c4',
      fill: '#fff7e9', fill2: '#fff1dd', fill3: '#ffe8cf',
      line: '#e7cd9c', line2: '#e0c290', line3: '#ecd5ad',
      line4: '#e3c99d', line5: '#debf8e', line6: '#f1dfba',
      text: '#3c2a15', text2: '#4d3a21', text3: '#6a553a',
      muted: '#8d7454', muted2: '#977e5f', muted3: '#8a7155',
      muted4: '#9d8667', muted5: '#a69072',
      accent: '#9a5a00', active: '#f5dcb6'
    }
  },
  {
    id: 'mint',
    name: '薄荷',
    desc: '完成 7 次任务解锁',
    unlock: { type: 'tasks', need: 7 },
    tokens: {
      bg: '#f3fbf7', bg2: '#e9f6f0',
      surface: '#ffffff', surface2: '#e9f6f1', surface3: '#d6eee4',
      fill: '#f0f9f5', fill2: '#e9f6f1', fill3: '#e0f1ea',
      line: '#b4d9c8', line2: '#a9d1bf', line3: '#badfd0',
      line4: '#a9d2c1', line5: '#9ec9b7', line6: '#c9e5d9',
      text: '#1e322c', text2: '#31433d', text3: '#4c6158',
      muted: '#6f887e', muted2: '#79918a', muted3: '#6d857c',
      muted4: '#81978e', muted5: '#7e958b',
      accent: '#0c7355', active: '#c4e4d7'
    }
  },
  {
    id: 'sky',
    name: '晴空',
    desc: '付费预留（个人主体暂无支付通道）',
    unlock: { type: 'paid', price: 600 },
    tokens: {
      bg: '#f4faff', bg2: '#e9f2fd',
      surface: '#ffffff', surface2: '#e9f3fd', surface3: '#d7e8fa',
      fill: '#f1f8fe', fill2: '#e9f3fd', fill3: '#e0eefa',
      line: '#b4d2ec', line2: '#a8caE6', line3: '#bad5ee',
      line4: '#a8c9e6', line5: '#9dc0e0', line6: '#c9def3',
      text: '#1d2b3a', text2: '#304250', text3: '#4b5d70',
      muted: '#6d8398', muted2: '#778da0', muted3: '#6b8194',
      muted4: '#7f93a6', muted5: '#7c90a3',
      accent: '#1259b8', active: '#c3dcf2'
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
