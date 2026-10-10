/**
 * 云函数端到端自测：不依赖"肉眼在模拟器里看"，脚本自己证明部署是通的。
 *
 *   node scripts/cloud-e2e.js            # 部署 + 下载回读校验
 *   node scripts/cloud-e2e.js --check    # 只做本地结构校验（不碰云端）
 *
 * 三道关卡：
 *   A) 本地：index.js 里每个 require('./x') 都必须能落到函数目录里的真实文件
 *      （"Cannot find module" 这类事故在本地就该抓住）；
 *   B) 部署：调用开发者工具 CLI 上传（云端装依赖），失败即终止；
 *   C) 回读：把云端函数包下载回来，逐文件与本地比对 sha1，并确认带版本戳、
 *      state-store 是"确定性 _id"新版 —— 部署是否真正生效，以云端下载件为准。
 *
 * 依赖：微信开发者工具已开启服务端口（设置 → 安全设置）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FUNCS_DIR = path.join(ROOT, 'cloud', 'functions');
const ENV_ID = 'cloud1-d0gmmv8o9df84265e';
const TMP = path.join(process.env.TEMP || '/tmp', 'wordcheck-cloud-e2e');

/** 不参与部署/自测的目录（辅助工具，从未上云） */
const SKIP = ['check-shared'];

const CLI_CANDIDATES = [
  'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat'
];
const CLI = CLI_CANDIDATES.find((p) => fs.existsSync(p));

const checkOnly = process.argv.includes('--check');

/** --verify <dir>：跳过部署/下载（已在别处完成），只校验 dir 下已下载的云端包 */
const verifyIdx = process.argv.indexOf('--verify');
const verifyDir = verifyIdx !== -1 ? process.argv[verifyIdx + 1] : null;

function sha(text) { return crypto.createHash('sha1').update(text).digest('hex'); }
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }

function listFunctions() {
  return fs.readdirSync(FUNCS_DIR).filter((name) => {
    if (SKIP.indexOf(name) !== -1) return false;
    const idx = path.join(FUNCS_DIR, name, 'index.js');
    return fs.existsSync(idx);
  });
}

/** 提取 index.js 里的版本戳（const VERSION = '...'） */
function versionOf(code) {
  const m = /const VERSION = '([^']+)'/.exec(code);
  return m ? m[1] : null;
}

/** 本地相对 require 是否都能落到真实文件 */
function localRequireCheck(name) {
  const dir = path.join(FUNCS_DIR, name);
  const code = read(path.join(dir, 'index.js'));
  const fails = [];
  const re = /require\(['"]\.\/([\w-]+)['"]\)/g;
  let m;
  while ((m = re.exec(code))) {
    const p = path.join(dir, m[1] + '.js');
    if (!fs.existsSync(p)) fails.push("require('./" + m[1] + "') 缺文件：" + m[1] + '.js');
  }
  const version = versionOf(code);
  if (!version) fails.push('index.js 没有 VERSION 版本戳');
  return { fails: fails, version: version };
}

/**
 * 指定的 IDE 服务端口。
 * 为什么必须显式指定：只认默认的 39749 会在"从没开过服务端口"的机器上连不上，
 * 而 IDE 真实的端口写在你本机配置里（形如 port:15717），跟默认值没关系。
 * 端口在哪看：%LOCALAPPDATA%\微信开发者工具\User Data\<hash>\WeappLocalData\
 * localstorage_b72d….json 里的 "security":{"enableServicePort":true,"port":15717}。
 * 好处是不需要 IDE 真的开着 GUI：CLI 会自己把 HTTP server 拉起来。
 */
const portIdx = process.argv.indexOf('--port');
const PORT = portIdx !== -1 ? process.argv[portIdx + 1] : null;

function runCli(args) {
  // shell:true 是必须的：新版 Node 出于安全（CVE-2024-27980）禁止直接 spawn .bat。
  // 但 spawnSync(file, args, {shell:true}) 会把带空格的路径原样拼接（"Program Files" 断开），
  // 导致 CLI 一个字都吐不出来 —— 所以这里自己拼整条命令并对含空格参数加引号。
  const all = PORT ? args.concat(['--port', PORT]) : args;
  const quoted = all.map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
  const cmd = '"' + CLI + '" ' + quoted;
  const r = spawnSync(cmd, { encoding: 'utf8', timeout: 10 * 60 * 1000, shell: true });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const ok = r.status === 0 && /√ deploy cloudfunctions|√ download cloudfunction|√ query/.test(out);
  return { ok: ok, out: out };
}

/* ---------------- 主流程 ---------------- */

const results = [];
function report(name, step, ok, detail) {
  results.push({ name: name, step: step, ok: ok, detail: detail || '' });
  console.log('  ' + (ok ? '✓' : '✗') + ' [' + name + '] ' + step + (detail ? ' —— ' + detail : ''));
}

const functions = listFunctions();
console.log('云函数端到端自测' + (checkOnly ? '（仅本地结构校验）' : '') + '\n');

/* A. 本地结构 */
let localFail = 0;
console.log('A) 本地结构检查');
for (const name of functions) {
  const r = localRequireCheck(name);
  report(name, 'require 全部可解析 + 版本戳 ' + (r.version || '缺失'), r.fails.length === 0, r.fails.join('；'));
  if (r.fails.length) localFail++;
}
if (localFail) {
  console.error('\n本地结构就有问题，不部署，先修上面的 ✗');
  process.exit(1);
}

if (checkOnly) {
  console.log('\n本地校验全部通过（--check 模式，未触碰云端）');
  process.exit(0);
}

/* C'(--verify 模式)：只校验已下载到 verifyDir 的云端包 */
if (verifyDir) {
  console.log('\nC) 云端包回读校验（目录：' + verifyDir + '）');
  let fail = 0;
  for (const name of functions) {
    const dest = path.join(verifyDir, name);
    const localCode = read(path.join(FUNCS_DIR, name, 'index.js'));
    const cloudCode = read(path.join(dest, 'index.js'));
    if (cloudCode === null) { report(name, 'index.js 存在', false, '下载件里没有 index.js'); fail++; continue; }
    if (sha(cloudCode) !== sha(localCode)) { report(name, 'index.js 与本地一致', false, '云端和本地内容不同'); fail++; continue; }
    const version = versionOf(cloudCode);
    const requires = [];
    const re = /require\(['"]\.\/([\w-]+)['"]\)/g;
    let m;
    while ((m = re.exec(localCode))) requires.push(m[1]);
    const missing = [];
    for (const mod of requires) {
      const lp = read(path.join(FUNCS_DIR, name, mod + '.js'));
      const cp = read(path.join(dest, mod + '.js'));
      if (cp === null) missing.push(mod + '.js 不在云端包里');
      else if (lp !== null && sha(lp) !== sha(cp)) missing.push(mod + '.js 与本地不一致');
    }
    if (missing.length) { report(name, '依赖模块', false, missing.join('；')); fail++; continue; }
    const st = read(path.join(dest, 'state-store.js'));
    if (st !== null && st.indexOf('stateDocId') === -1) {
      report(name, 'state-store 新版', false, '云端副本没有 stateDocId（旧版写入器）'); fail++; continue;
    }
    report(name, '云端=本地，v' + version + '，依赖 ' + requires.length + ' 个模块全部就位', true);
  }
  const bad = results.filter((r) => !r.ok);
  console.log('\n结果：' + (results.length - bad.length) + ' 项通过，' + bad.length + ' 项失败');
  if (bad.length) process.exit(1);
  console.log('端到端全部通过 ✓ —— 模拟器重新编译后，Console 应打印每个函数的云端版本戳');
  process.exit(0);
}

if (!CLI) {
  console.error('\n找不到微信开发者工具 cli.bat，无法部署。路径候选：' + CLI_CANDIDATES.join(' ; '));
  process.exit(1);
}

/* B. 部署 */
console.log('\nB) CLI 部署（云端安装依赖）');
const deploy = runCli(['cloud', 'functions', 'deploy', '--project', ROOT, '--env', ENV_ID,
  '--names'].concat(functions).concat(['--remote-npm-install']));
for (const name of functions) {
  const m = new RegExp('\\| ' + name + '\\s+\\| (\\w+)').exec(deploy.out);
  const ok = deploy.ok && m && m[1] === 'true';
  report(name, '部署', !!ok, ok ? '' : 'CLI 输出未见 success（见下）');
}
if (!deploy.ok) {
  console.log('---- CLI 输出 ----\n' + deploy.out.slice(-2000));
  process.exit(1);
}

/* C. 云端回读 */
console.log('\nC) 云端包下载回读（以云端实际内容为准）');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let cloudFail = 0;
for (const name of functions) {
  const dest = path.join(TMP, name);
  const dl = runCli(['cloud', 'functions', 'download', '--project', ROOT, '--env', ENV_ID,
    '--name', name, '--path', dest]);
  if (!dl.ok) {
    report(name, '下载', false, 'CLI 下载失败');
    cloudFail++;
    continue;
  }
  const localCode = read(path.join(FUNCS_DIR, name, 'index.js'));
  const cloudCode = read(path.join(dest, 'index.js'));
  if (cloudCode === null) {
    report(name, 'index.js 存在', false, '云端包里没有 index.js');
    cloudFail++;
    continue;
  }
  if (sha(cloudCode) !== sha(localCode)) {
    report(name, 'index.js 与本地一致', false, '云端和本地内容不同（部署没生效？）');
    cloudFail++;
    continue;
  }
  const cloudVersion = versionOf(cloudCode);
  if (!cloudVersion) {
    report(name, '版本戳', false, '云端 index.js 没有 VERSION');
    cloudFail++;
    continue;
  }
  // 每一个本地相对依赖文件，云端包里都必须存在且一致
  const requires = [];
  const re = /require\(['"]\.\/([\w-]+)['"]\)/g;
  let m;
  while ((m = re.exec(localCode))) requires.push(m[1]);

  const missing = [];
  for (const mod of requires) {
    const lp = read(path.join(FUNCS_DIR, name, mod + '.js'));
    const cp = read(path.join(dest, mod + '.js'));
    if (cp === null) missing.push(mod + '.js 不在云端包里');
    else if (lp !== null && sha(lp) !== sha(cp)) missing.push(mod + '.js 与本地不一致');
  }
  if (missing.length) {
    report(name, '依赖模块', false, missing.join('；'));
    cloudFail++;
    continue;
  }
  // state-store 必须是"确定性 _id"新版（脏数据挡道的根治手段）
  const st = read(path.join(dest, 'state-store.js'));
  if (st !== null && st.indexOf('stateDocId') === -1) {
    report(name, 'state-store 新版', false, '云端副本没有 stateDocId（还是旧版写入器）');
    cloudFail++;
    continue;
  }
  report(name, '云端=本地，v' + cloudVersion + '，依赖 ' + requires.length + ' 个模块全部就位', true);
}

const bad = results.filter((r) => !r.ok);
console.log('\n结果：' + (results.length - bad.length) + ' 项通过，' + bad.length + ' 项失败');
if (bad.length) process.exit(1);
console.log('端到端全部通过 ✓ —— 模拟器重新编译后，Console 应打印每个函数的云端版本戳');
