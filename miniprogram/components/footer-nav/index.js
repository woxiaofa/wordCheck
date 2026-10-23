/**
 * 底部导航
 *
 * 用自绘组件而不是小程序原生 tabBar：原生 tabBar 的图标是必需资源，
 * 而本仓库刻意不引入二进制图标文件；自绘也便于后续加"今日待办"角标。
 *
 * 注意：没有"抽查"入口 —— 2026-10-07 起背词页已合并抽查（认 → 写 → 巩固），
 * 再留一个"抽查"tab 会让家长以为这是两条独立的练习线（用户实锤反馈）。
 * 独立交卷制抽查页（quiz）保留，供首页"检验真实水平"按钮进入。
 *
 * 2026-10-23 起：tab 由四个缩为三个 —— 「数据」「班级」是低频管理动作，
 * 连同新增的皮肤一起收进「设置」页。高频动作（今日 / 背词）留在手指够得着的地方。
 */

var ITEMS = [
  { key: 'index', label: '今日', icon: '◎', path: '/pages/index/index' },
  { key: 'study', label: '背词', icon: '▶', path: '/pkg-media/pages/drill/drill' },
  { key: 'settings', label: '设置', icon: '⚙', path: '/pages/settings/settings' }
];

Component({
  properties: {
    /** 当前所在页面：用对应 page 的 key，或直接传页面路径 */
    active: { type: String, value: '' }
  },

  data: {
    items: ITEMS
  },

  methods: {
    onGo: function (e) {
      var path = e.currentTarget.dataset.path;
      if (!path) return;
      var pages = getCurrentPages();
      var current = pages.length ? ('/' + pages[pages.length - 1].route) : '';
      if (current === path) return;          // 已经在目标页，不重复跳
      wx.redirectTo({ url: path });          // redirect 而非 navigate，避免页面栈无限增长
    }
  }
});
