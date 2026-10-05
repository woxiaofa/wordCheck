/**
 * 底部导航
 *
 * 用自绘组件而不是小程序原生 tabBar：原生 tabBar 的图标是必需资源，
 * 而本仓库刻意不引入二进制图标文件；自绘也便于后续加"今日待办"角标。
 */

var ITEMS = [
  { key: 'index', label: '今日', icon: '◎', path: '/pages/index/index' },
  { key: 'study', label: '学习', icon: '▶', path: '/pages/study/study' },
  { key: 'quiz', label: '抽查', icon: '✎', path: '/pages/quiz/quiz' },
  { key: 'stats', label: '数据', icon: '▤', path: '/pages/stats/stats' },
  { key: 'class', label: '班级', icon: '⌂', path: '/pages/class/class' }
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
