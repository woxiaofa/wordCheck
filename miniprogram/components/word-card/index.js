/**
 * 学习卡组件
 *
 * 交互（v3：只保留"上滑"一个手势，去掉下滑与拖动状态）：
 *   正面          只显示单词，底部提示"点一下看答案"
 *   点击卡片      直接显示答案 + 三个反馈按钮
 *   超时(8秒)     直接显示答案 + 两个反馈按钮（已超时，不再给"想得很快"，见下）
 *   上滑          直接记为「想得很快」并下一个词（不看答案的快速道）
 *   点反馈按钮    记下评价并下一个词
 *
 * ⚠️ 为什么去掉下滑与拖动状态（都是真机上付了代价的结论）：
 *   ① 翻面/拖动让"卡片显示什么"和"数据到哪一步"变成多个需要互相同步的状态，
 *      换词时漏掉任何一处复位，就会出现"下一个词还显示上一个词的答案"；
 *   ② 下滑原本有两个含义（未揭晓时看答案 / 已揭晓时过关），语义不直观 ——
 *      用户不知道该记成什么评价，产品上也不该替用户决定；
 *   ③ 删除拖动逻辑时发现一个真 bug：下滑分支里 `dy < 0` 不成立就直接 return，
 *      跳过了 resumeAuto()，导致自动揭晓计时器再也不恢复。
 *      状态越少，这类"某条路径漏掉收尾"的 bug 越少。
 *
 * 现在组件的可见性状态只有一个 revealed，收起答案就是把它置回 false。
 */

var srs = require('../../utils/srs');

var SWIPE_UP_THRESHOLD = 60;   // px，上滑超过这个位移才算数

Component({
  properties: {
    /** 单词对象：{ word, phonetic, pos, def_cn, example_en, example_cn, tags[] } */
    word: { type: Object, value: {} },
    /** 当前 SRS 状态：{ stage, wrong_count }，用于显示"当前档位" */
    state: { type: Object, value: null },
    /** 是否显示底部的操作提示（老用户可关掉） */
    showHint: { type: Boolean, value: true },
    /** 自动揭晓毫秒数；设为 0 表示关闭该功能 */
    revealAfter: { type: Number, value: 8000 },
    /** 示范卡模式：顶部提示"必须上滑一次"，且不显示中间的单词 */
    demo: { type: Boolean, value: false },
    /**
     * 当前卡片的标识（由页面传"第几张卡"）。
     * 注意必须与该卡唯一对应：曾经用过 word.word，而队列里相邻两项可能是同一个词
     * （首次使用的示范卡，后面紧跟的就是同一个真词）—— key 没变、不复位、bug 重现。
     */
    cardKey: { type: String, value: '' },
    /**
     * 过渡期间锁定：页面记完评价后有约 260ms 的"已记录"停顿，
     * 这段时间必须拒绝一切手势与点击 —— 否则连续点击会一次过掉两个词，
     * 而且"下一个词刚显示就被误触"会让用户以为按钮没生效。
     */
    locked: { type: Boolean, value: false }
  },

  data: {
    /** 是否已显示答案。唯一的可见性状态 */
    revealed: false,
    /** 本次揭晓是否由超时触发（用于决定要不要给"想得很快"） */
    autoRevealed: false,
    showKnownBtn: false,
    promptText: '刚才回忆得怎么样？',
    /** "认识"那条的补充说明：到了学习阶段的档位上限时，明确提示必须通过抽查才能继续拉长间隔 */
    cappedHint: '',
    /** 上滑提示的显隐 */
    showUp: false,
    autoOn: false,
    autoProgress: 100,
    stageText: ''
  },

  observers: {
    /**
     * 换词复位（兜底路径）。
     * 页面在推进到下一张卡时还会**直接调用 resetCard()**，因为真机上观察过
     * 单纯依赖属性 observer 并不可靠（可能与组件复用、setData 批处理有关）。
     * 两边都做才稳。
     */
    cardKey: function (key) {
      if (key === undefined || key === '') return;
      this.resetCard();
    },

    /**
     * 锁定状态以 locked 属性为准。
     * ⚠️ 这里必须显式维护 _locked：早先只写了一个 lock() 方法把 _locked 置 true，
     *    却没有对应的清除路径，于是页面把 locked 属性置回 false 之后，
     *    组件仍然永久拒绝一切点击与手势 —— 真机表现就是"点完按钮，后面全点不动了"。
     *    集成测试（tests/study-flow.test.js）抓到了这个（断言信息里会打印 _locked 值）。
     */
    locked: function (val) {
      this._locked = !!val;
      if (val) {
        // 刚上锁时清掉进行中的手势状态，避免残留上滑提示
        this.touch = null;
        this.setData({ showUp: false });
      }
    },

    /** 档位文案随 state 变化 */
    state: function (st) {
      this.applyStageText(st);
    }
  },

  lifetimes: {
    attached: function () { this.startAuto(); },
    detached: function () { this.stopAuto(); }
  },

  /* ⚠️ pageLifetimes 必须是 Component 的**顶层**配置项，不能嵌在 lifetimes 里。
     曾经错放进 lifetimes，结果组件渲染异常：卡片外框在、里面全空，Console 无报错。 */
  pageLifetimes: {
    hide: function () { this.stopAuto(); },
    show: function () { if (!this.data.revealed) this.startAuto(); }
  },

  methods: {
    /** 立即上锁（页面在记完评价时调用）。解锁靠页面把 locked 属性置回 false。 */
    lock: function () {
      this._locked = true;
      this.touch = null;
      this.setData({ showUp: false });
    },

    /* ---------------- 卡片状态 ---------------- */

    /** 按 SRS 状态计算档位文案 */
    applyStageText: function (st) {
      var text = '新词（首次学习）';
      var capped = '';
      if (st && typeof st.stage === 'number') {
        text = '当前档位 ' + st.stage + '（间隔 ' + srs.stageLabel(st.stage) + '）';
        if (st.wrong_count) text += ' · 历史错误 ' + st.wrong_count + ' 次';
      }

      // 已经在学习阶段的档位上限时，点"认识"也升不上去了 —— 必须明确告诉用户
      // "要通过抽查才能继续拉长间隔"，否则他会以为这个按钮坏了。
      var preview = srs.nextState(st, 'known', Date.now());
      if (preview.capped) {
        capped = '（学时最多到 ' + srs.stageLabel(srs.LEARN_STAGE_CAP) + '，通过抽查才会更长）';
      }

      this.setData({ stageText: text, cappedHint: capped });
    },

    /** 收起答案，回到"只显示单词"。换词时由页面调用（或 cardKey observer 兜底） */
    resetCard: function () {
      this.touch = null;
      this.suppressTap = false;
      this.setData({
        revealed: false,
        autoRevealed: false,
        showKnownBtn: false,
        promptText: '刚才回忆得怎么样？',
        showUp: false
      });
      this.applyStageText(this.data.state);
      this.startAuto();
    },

    /**
     * 显示答案
     * @param {boolean} byTimeout 是否由超时触发
     */
    reveal: function (byTimeout) {
      if (this.data.revealed) return;
      this.stopAuto();
      this.setData({
        revealed: true,
        autoRevealed: !!byTimeout,
        showKnownBtn: !byTimeout,          // 超时不给"想得很快"
        promptText: byTimeout ? '想不起来了？还是想得费劲？' : '刚才回忆得怎么样？',
        showUp: false
      });
      this.triggerEvent('reveal', { byTimeout: !!byTimeout });
    },

    /* ---------------- 自动揭晓计时 ---------------- */

    /** 解析时长：显式 0 表示关闭；非数字（属性未就绪）回退默认 8 秒 */
    resolveDuration: function () {
      var n = Number(this.data.revealAfter);
      if (n === 0) return 0;
      if (!isFinite(n) || n < 0) return 8000;
      return n;
    },

    startAuto: function () {
      var self = this;
      // 幂等：正在计时就不重来。用 autoEndAt 判断而不是 autoTimer ——
      // 揭晓后 stopAuto 会清空 autoTimer，若以它为准，换词时会被误判为"无需启动"。
      if (this.autoEndAt > 0) return;
      this.stopAuto();
      var duration = this.resolveDuration();
      if (duration === 0) return;
      if (this.data.revealed) return;

      this.autoEndAt = Date.now() + duration;
      this.setData({ autoOn: true, autoProgress: 100 });

      this.autoTimer = setInterval(function () {
        var left = Math.max(0, self.autoEndAt - Date.now());
        self.setData({ autoProgress: Math.round(left / duration * 100) });
        if (left <= 0) self.reveal(true);     // 超时揭晓，但停在这里等用户评价
      }, 80);
    },

    stopAuto: function () {
      if (this.autoTimer) { clearInterval(this.autoTimer); this.autoTimer = null; }
      this.autoEndAt = 0;
      this.setData({ autoOn: false, autoProgress: 0 });
    },

    /* ---------------- 上滑手势（唯一手势） ---------------- */

    onTouchStart: function (e) {
      if (this._locked || this.data.locked) return;
      var t = e.touches[0];
      this.touch = { x: t.clientX, y: t.clientY, up: false };
    },

    onTouchMove: function (e) {
      if (!this.touch) return;
      var t = e.touches[0];
      var dy = t.clientY - this.touch.y;
      var dx = Math.abs(t.clientX - this.touch.x);

      // 只有"明显向上、且竖向为主"才算上滑，避免和页面滚动抢手势
      var up = dy < -20 && Math.abs(dy) > dx;
      if (up !== this.touch.up) {
        this.touch.up = up;
        this.setData({ showUp: up });
      }
    },

    onTouchEnd: function (e) {
      if (!this.touch) return;
      var dy = e.changedTouches[0].clientY - this.touch.y;
      var wasUp = this.touch.up;
      this.touch = null;
      this.setData({ showUp: false });

      if (wasUp && dy < -SWIPE_UP_THRESHOLD) {
        this.suppressTap = true;      // 这一下不算点击
        this.stopAuto();
        this.triggerEvent('known');
      }
    },

    onTouchCancel: function () {
      this.touch = null;
      this.setData({ showUp: false });
    },

    /* ---------------- 点击 ---------------- */

    onCardTap: function () {
      if (this._locked || this.data.locked) return;
      if (this.suppressTap) return;
      if (this.data.revealed) return;     // 已显示答案，点击不再有别的含义
      this.reveal(false);                 // 点击揭晓：保留三个反馈按钮
    },

    onFeedback: function (e) {
      if (this._locked || this.data.locked) return;
      var fb = e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.fb : '';
      if (!fb) return;
      if (!this.data.revealed) return;    // 没看答案不算作答，防止手快跳过回忆
      this.stopAuto();
      this.triggerEvent('feedback', { feedback: fb });
    },

    onSpeak: function () {
      this.triggerEvent('speak', { word: this.data.word.word });
    }
  }
});
