/**
 * 项目自检脚本（不依赖任何第三方包）
 *
 *   node scripts/verify-project.js
 *
 * 做四件事，都是"肉眼看不出来、但一旦错了会直接白屏或算错"的问题：
 *   1) 共享模块是否与 shared/ 一致（两份副本漂移会产生极难定位的行为差异）
 *   2) app.json 里声明的每个页面，四个必需文件是否齐全
 *   3) 每个页面/组件的 wxml 里引用到的数据字段与事件处理函数，是否在 js 里存在
 *   4) WXML 标签是否配平（这类错误的表现就是整页空白）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

const problems = [];
const notes = [];

function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}
function exists(p) { return fs.existsSync(p); }

/* ---------------- 1. 共享模块一致性 ---------------- */

function checkShared() {
  const srcDir = path.join(ROOT, 'shared');
  if (!exists(srcDir)) { problems.push('缺少共享模块目录 shared/'); return; }

  const files = fs.readdirSync(srcDir).filter((f) => {
    if (f.indexOf('.') === 0) return false;
    return fs.statSync(path.join(srcDir, f)).isFile();
  });
  if (!files.length) { problems.push('shared/ 目录下没有文件'); return; }

  // 与 sync-shared.js 的 COPY_TARGETS 保持一致
  const targets = [(name) => 'miniprogram/utils/' + name, (name) => 'cloud/shared/' + name];

  files.forEach((name) => {
    const source = read(path.join(srcDir, name));
    targets.forEach((make) => {
      const rel = make(name);
      const label = rel.indexOf('miniprogram') === 0 ? '小程序' : '云函数';
      const content = read(path.join(ROOT, rel));
      if (content === null) problems.push(label + '侧副本缺失：' + rel + '（运行 node scripts/sync-shared.js）');
      else if (content !== source) problems.push(label + '侧副本与 shared/' + name + ' 不一致：' + rel + '（运行 node scripts/sync-shared.js）');
    });
  });
  notes.push('校验了 ' + files.length + ' 个共享模块 × 2 份副本');
}

/* ---------------- 1.5 引用双向检查 ---------------- */

/**
 * 递归收集某个目录下所有组件的相对路径（含 components/xxx 与 pages/xxx）
 */
function collectDirs(base, prefix, out) {
  if (!fs.existsSync(base)) return out;
  fs.readdirSync(base, { withFileTypes: true }).forEach((ent) => {
    if (!ent.isDirectory()) return;
    out.push(prefix + '/' + ent.name);
  });
  return out;
}

/**
 * 引用与被引用的双向检查。
 *
 * 为什么需要它：曾经因为删除了 pages/test-card 目录（app.json 与开发工具的
 * 项目索引还记着它），编译报 ENOENT、整个小程序渲染空白，而 Console 里只留下
 * 一些无关的 preload 警告，导致排查方向完全跑偏。
 * 这类"文件没了但引用还在"的错误必须在删除动作之前就报出来。
 */
function checkReferences() {
  const appJsonPath = path.join(MP, 'app.json');
  const appJson = read(appJsonPath);
  if (!appJson) return;
  let app;
  try { app = JSON.parse(appJson.replace(/^\uFEFF/, '')); } catch (e) { problems.push('app.json 不是合法 JSON：' + e.message); return; }

  const referenced = new Set();

  // 1) app.json 声明的页面
  (app.pages || []).forEach((p) => {
    referenced.add('pages/' + p.split('/').slice(1).join('/'));
    ['.js', '.json', '.wxml', '.wxss'].forEach((ext) => {
      if (!exists(path.join(MP, p + ext))) {
        problems.push('app.json 声明的页面文件缺失：miniprogram/' + p + ext +
          '（编译会报 ENOENT 并让整个小程序渲染空白）');
      }
    });
  });

  // 2) 各页面/组件 usingComponents 引用的组件
  const walkJson = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walkJson(p); return; }
      if (!ent.name.endsWith('.json')) return;
      let conf;
      try { conf = JSON.parse(read(p).replace(/^\uFEFF/, '')); } catch (e) { return; }
      if (!conf.usingComponents) return;
      Object.keys(conf.usingComponents).forEach((name) => {
        const target = String(conf.usingComponents[name]).replace(/^\//, '');
        referenced.add(target);
        ['.js', '.json', '.wxml'].forEach((ext) => {
          if (!exists(path.join(MP, target + ext))) {
            problems.push(path.relative(ROOT, p) + ' 引用的组件文件缺失：miniprogram/' + target + ext);
          }
        });
      });
    });
  };
  walkJson(MP);

  // 3) 反向检查：目录存在但没人引用（孤儿文件不会报错，但会拖慢编译、也会误导后续排查）
  //    注意：页面在 app.json 里是 "pages/index/index"，而目录是 "pages/index"，
  //    所以要用前缀匹配，不能直接比字符串相等。
  const isReferenced = (dirRel) => {
    let hit = false;
    referenced.forEach((r) => {
      if (r === dirRel || r.indexOf(dirRel + '/') === 0) hit = true;
    });
    return hit;
  };

  const orphans = [];
  collectDirs(path.join(MP, 'pages'), 'pages', []).forEach((rel) => {
    if (!isReferenced(rel)) orphans.push(rel);
  });
  collectDirs(path.join(MP, 'components'), 'components', []).forEach((rel) => {
    if (!isReferenced(rel)) orphans.push(rel);
  });
  if (orphans.length) {
    notes.push('未被引用的目录（不是错误，建议清理）：' + orphans.join('、'));
  }
}

/* ---------------- 2. 页面文件齐全 ---------------- */

function checkPages() {
  const appJson = read(path.join(MP, 'app.json'));
  if (!appJson) { problems.push('缺少 miniprogram/app.json'); return; }
  let app;
  try { app = JSON.parse(appJson); } catch (e) { problems.push('app.json 不是合法 JSON：' + e.message); return; }
  if (!Array.isArray(app.pages) || !app.pages.length) { problems.push('app.json 的 pages 为空'); return; }

  app.pages.forEach((p) => {
    const base = path.join(MP, p);
    const name = path.basename(p);
    ['.js', '.json', '.wxml', '.wxss'].forEach((ext) => {
      if (!exists(base + ext)) problems.push('页面文件缺失：miniprogram/' + p + ext);
    });
    // 页面同名文件里的处理函数是否都存在
    const js = read(base + '.js');
    const wxml = read(base + '.wxml');
    if (js && wxml) {
      checkHandlers('pages/' + name, js, wxml);
      checkData('pages/' + name, js, wxml);
    }
  });
  notes.push('app.json 声明了 ' + app.pages.length + ' 个页面');
}

/* ---------------- 3. 事件处理函数与数据字段 ---------------- */

/** wxml 里 bind / catch 绑定的方法名，必须在 js 里定义 */
function checkHandlers(label, js, wxml) {
  const bound = new Set();
  const re = /\b(?:bind|catch)(?::)?[a-zA-Z]+\s*=\s*"([A-Za-z_$][\w$]*)"/g;
  let m;
  while ((m = re.exec(wxml))) bound.add(m[1]);

  bound.forEach((fn) => {
    // 方法在 methods 里（组件）或页面对象里（页面），这里只做文本级存在性判断
    const defined = new RegExp('(^|[\\s,{])' + fn + '\\s*:\\s*function', 'm').test(js)
      || new RegExp('(^|[\\s,{])' + fn + '\\s*\\(', 'm').test(js)
      || new RegExp('(^|[\\s,{])' + fn + '\\s*:', 'm').test(js);
    if (!defined) problems.push(label + '：wxml 绑定了 ' + fn + '，但 js 里没有定义');
  });
}

/** 去掉 wxml 注释。必须在检查字段引用之前做：
    注释里出现的变量名（例如排错记录里写的 {{dragStyle}}）不该被当成真实引用。 */
function stripWxmlComments(wxml) {
  return String(wxml).replace(/<!--[\s\S]*?-->/g, '');
}

/** wxml 里用到的简单字段，最好在 js 的 data 里出现过（避免拼写错误导致空白） */
function checkData(label, js, wxmlRaw) {
  const wxml = stripWxmlComments(wxmlRaw);
  const dataMatch = js.match(/data\s*:\s*\{([\s\S]*?)\n\s{2,4}\}/);
  if (!dataMatch) return;
  const declared = new Set();
  const keyRe = /^\s*([A-Za-z_$][\w$]*)\s*:/gm;
  let k;
  while ((k = keyRe.exec(dataMatch[1]))) declared.add(k[1]);
  if (!declared.size) return;

  // wx:for 的循环变量名是任意的（item/index 只是默认值），必须从 wxml 里提取出来放行。
  // 早些时候我把 item/index 写成白名单，结果自定义名称（opt/row/k）被误报为拼写错误。
  const loopVars = new Set(['item', 'index']);
  const aliasRe = /wx:for-(?:item|index)\s*=\s*"([^"]+)"/g;
  let a;
  while ((a = aliasRe.exec(wxml))) loopVars.add(a[1].trim());

  // 组件通过 properties 接收的字段会直接出现在 wxml 里（如 word、length、confirmLabel），
  // 它们不在 data 里，必须一并放行
  const propMatch = js.match(/properties\s*:\s*\{([\s\S]*?)\n\s{2,4}\}/);
  if (propMatch) {
    const propRe = /^\s*([A-Za-z_$][\w$]*)\s*:/gm;
    let p;
    while ((p = propRe.exec(propMatch[1]))) loopVars.add(p[1]);
  }

  const used = new Set();
  const useRe = /\{\{\s*([A-Za-z_$][\w$]*)/g;
  let u;
  while ((u = useRe.exec(wxml))) used.add(u[1]);

  used.forEach((name) => {
    if (declared.has(name)) return;
    if (loopVars.has(name)) return;                       // wx:for 别名或组件 properties
    if (['true', 'false', 'null', 'undefined'].includes(name)) return;
    if (js.indexOf("'" + name + "'") >= 0 || js.indexOf('"' + name + '"') >= 0) return;   // setData 动态写入
    if (js.indexOf(name + ':') >= 0) return;
    problems.push(label + '：wxml 用到 ' + name + '，但 js 的 data 与 setData 里都没出现（可能是拼写错误）');
  });
}

/* ---------------- 4. WXML 标签配平 ---------------- */

const SELF_CLOSING = new Set(['image', 'input', 'icon', 'progress', 'slider', 'switch', 'textarea', 'navigator', 'canvas', 'camera', 'audio', 'video', 'live-player', 'live-pusher', 'open-data', 'web-view', 'import', 'include', 'wxs']);

function checkTags(label, wxml) {
  const stack = [];
  const re = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(wxml))) {
    const raw = m[0];
    const tag = m[1];
    const isClose = raw.startsWith('</');
    const selfClose = m[3] === '/' || SELF_CLOSING.has(tag);
    if (isClose) {
      const top = stack.pop();
      if (top !== tag) {
        problems.push(label + '：标签不配平，遇到 </' + tag + '> 但栈顶是 ' + (top ? '<' + top + '>' : '空'));
        return;
      }
    } else if (!selfClose) {
      stack.push(tag);
    }
  }
  if (stack.length) problems.push(label + '：有未闭合标签 ' + stack.map((t) => '<' + t + '>').join(' '));
}

/**
 * 检查单个元素上的重复属性。
 *
 * 为什么必须自动检查：曾经在组件根节点写了两个 style 属性（一个内联兜底、一个拖拽位移），
 * 重复属性会导致其后的子节点渲染异常 —— 表现为"卡片在、里面全空"。
 * 这种问题在真机/模拟器上极难定位，Console 里也没有任何报错，
 * 靠肉眼审 wxml 完全看不出来。所以交给脚本。
 */
function checkDuplicateAttrs(label, wxml) {
  const tagRe = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = tagRe.exec(wxml))) {
    const attrStr = m[2] || '';
    const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=/g;
    const seenLocal = {};
    let a;
    while ((a = attrRe.exec(attrStr))) {
      const name = a[1];
      // wx:for-item 等别名、以及同一元素上合法的重复属性不存在，所以一律视为错误
      if (seenLocal[name]) {
        const line = wxml.slice(0, m.index).split('\n').length;
        problems.push(label + ':' + line + '：<' + m[1] + '> 上重复出现了属性 ' + name +
          '（重复属性会导致其后子节点渲染异常，典型的"卡片空白"元凶）');
      }
      seenLocal[name] = true;
    }
  }
}

function checkAllWxml() {
  const files = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach((ent) => {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.wxml')) files.push(p);
    });
  })(MP);

  files.forEach((f) => {
    const wxml = read(f);
    const label = path.relative(MP, f);
    checkTags(label, wxml);
    checkDuplicateAttrs(label, wxml);
    const js = read(f.replace(/\.wxml$/, '.js'));
    if (js) { checkHandlers(label, js, wxml); checkData(label, js, wxml); }
  });
  notes.push('检查了 ' + files.length + ' 个 wxml 文件（含标签配平、重复属性、绑定一致性）');
}

/**
 * 4. 主包体积红线
 *
 * 为什么查：小程序主包上限 2MB。单词发音 mp3 打进主包后占大头（300 词 ≈1.4MB），
 * 词库一扩就会撞线，而且撞线是在"上传体验版"那一步才炸，本地看不出来。
 * 这里提前告警：>1.5MB 提示搬去分包/云存储，>2MB 直接算问题。
 */
const AUDIO_DIR = path.join(MP, 'assets', 'audio');
const MAIN_PKG_LIMIT = 2048 * 1024;   // 2MB
const AUDIO_WARN = 1500 * 1024;       // 1.5MB：留出余量给代码增长

function dirSize(dir) {
  let total = 0;
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach((ent) => {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    });
  })(dir);
  return total;
}

function checkPackageSize() {
  if (!exists(AUDIO_DIR)) {
    notes.push('未生成本地发音音频（assets/audio 不存在，发音走插件兜底）');
    return;
  }
  const audio = dirSize(AUDIO_DIR);
  const others = dirSize(MP) - audio;
  const total = audio + others;
  const kb = (n) => (n / 1024).toFixed(0) + 'KB';
  notes.push('主包体积：' + kb(total) + '（代码 ' + kb(others) + ' + 发音音频 ' + kb(audio) + '），上限 2MB');

  if (total > MAIN_PKG_LIMIT) {
    problems.push('主包体积 ' + kb(total) + ' 超过 2MB 上限：把 assets/audio 挪进分包（配 preloadRule）或改云存储按需拉取');
  } else if (audio > AUDIO_WARN) {
    notes.push('提示：发音音频已占 ' + kb(audio) + '，词库继续扩充前建议搬去分包/云存储');
  }
}

/* ---------------- 主流程 ---------------- */

if (require.main === module) {
  checkShared();
  checkReferences();
  checkPages();
  checkAllWxml();
  checkPackageSize();

  console.log('项目自检');
  notes.forEach((n) => console.log('  · ' + n));

  if (problems.length) {
    console.log('');
    problems.forEach((p) => console.log('  ✗ ' + p));
    console.log('\n共 ' + problems.length + ' 个问题');
    process.exit(1);
  }
  console.log('\n自检通过 ✓');
}

/**
 * 导出给其他脚本复用（scripts/check-bindings.js），避免同一套检查写两遍。
 * 传入 --json 时打印 JSON，便于被其它工具消费。
 */
module.exports = {
  checkTags: checkTags,
  checkDuplicateAttrs: checkDuplicateAttrs,
  checkHandlers: checkHandlers,
  checkData: checkData,
  notes: notes,
  problems: problems,
  ROOT: ROOT,
  MP: MP
};
