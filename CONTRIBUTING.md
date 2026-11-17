# 贡献指南

先说清楚现状：**本项目已停止活跃维护**（为什么停见 README 末节）。所以：

- ✅ **欢迎**：词库 CSV、bug 修复、文档纠错、测试补充、云函数小改进
- ⚠️ **先开 issue 再动手**：UI 大改版、架构调整、新增云函数
- ❌ **别做**：把 `shared/` 改成 npm 包/子目录、绕开 `utils/cloud.js` 直调 `wx.cloud`、
  在页面里散落 `new Date()`——这些是踩过的坑，仓库里的测试会拦，省得互相浪费时间

## 环境准备

零依赖：Node ≥18，不需要 `npm install`，不需要微信开发者工具就能跑测试。

```bash
git clone <repo> && cd wordCheck
npm run check   # 首次克隆先跑一遍，确认基线全绿
```

## 词库贡献（最欢迎）

**只交 CSV，不要手改 `words.js`**（那是脚本产物）。格式、字段说明、必填约束见
README「贡献词库」一节。特别提醒：

- 例句**自撰**——释义文字与例句是受保护的作品，从词典/竞品抄是版权风险；
- `unit_order` 必须连续，它决定自动布置的取词次序；
- 一本教材一个 PR，标题写清「出版社 × 年级 × 册」。

## 开发流程

1. 从最新 `master` 拉分支；
2. 改动 `shared/` 下任何文件后**必须**跑 `node scripts/sync-shared.js`，
   自检是逐字节比较，漂移会直接红；
3. 云函数里的 `srs.js` / `quiz.js` / `seccheck.js` 等副本由 `scripts/prepare-functions.js`
   生成并**平铺**进函数目录（子目录方案在 CLI 部署后会 `Cannot find module`，已弃），
   永远改 `shared/` 原件，别手改副本；
4. `npm run check` 全绿再提 PR。

## 测试怎么写（本项目惯例）

每个修复配一个测试文件（或并入既有文件），并且做**变异自证**：
把你的修复代码撤掉（或改坏），对应断言必须变红——只测「绿」不测「红」的测试
等于没测。参考 `tests/oral-hold.test.js`（录音竞态）与 `tests/seccheck.test.js`
（内容安全，假 openapi 桩）。

新测试文件要登记进 `package.json` 的 `test` / `check` 脚本链
（`tests/launch.test.js` 有断言兜底：漏登记会被抓出来）。

## 硬约定（PR 会按这个审）

见 [`docs/设计约定.md`](docs/设计约定.md)，摘要：

1. 抽查答案不下发客户端
2. 提交类接口幂等（`clientReqId` 先查后写）
3. 「今天」只由 `shared/time.js` 决定（UTC+8）
4. 每日任务冻结快照，当天不变
5. `user_word_state` 唯一索引 `(user_id, word_id)`
6. 词库内容只用自撰或已授权来源

另外两条近期加入的合规底线：

- 所有 UGC（班级名 / 自定义词单 / 备注 / 昵称 / 头像）入库前必须过
  `seccheck.checkText` / `checkImage`（2026-11-16 提审被拒后的整改成果）；
- 任何密钥、真实用户数据、全库备份**绝不进仓库**（`.gitignore` 已兜底，别绕）。

## 提交信息

用现有风格：`type(scope): 一句话说明`，正文列要点。例：

```
fix(oral): 合格后自动进下一条，删除遍数门槛
```
