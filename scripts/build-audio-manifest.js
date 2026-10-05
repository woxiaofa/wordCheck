/**
 * 生成 miniprogram/data/audio-manifest.js（本地发音音频清单）
 *
 * 用法：node scripts/build-audio-manifest.js
 * 在跑完 scripts/gen_audio_piper.py 之后执行；tts.js 据此判断词是否有本地发音。
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'miniprogram', 'assets', 'audio');
const outFile = path.join(__dirname, '..', 'miniprogram', 'data', 'audio-manifest.js');

if (!fs.existsSync(dir)) {
  console.error('目录不存在：' + dir + '（先跑 gen_audio_piper.py）');
  process.exit(1);
}
const words = fs.readdirSync(dir)
  .filter(f => f.endsWith('.mp3') && fs.statSync(path.join(dir, f)).size > 0)
  .map(f => f.slice(0, -4))
  .sort();

const lines = words.map(w => '  ' + JSON.stringify(w) + ': 1,');
const body = '/**\n'
  + ' * 本地发音音频清单 —— 由构建脚本生成，请勿手改。\n'
  + ' * 重新生成：node scripts/build-audio-manifest.js\n'
  + ' * 来源：scripts/gen_audio_piper.py 产出的 miniprogram/assets/audio/*.mp3\n'
  + ' * tts.js 据此判断某个词有没有本地发音，避免运行时探测文件。\n'
  + ' */\n'
  + 'module.exports = {\n' + lines.join('\n') + '\n};\n';

fs.writeFileSync(outFile, body);
console.log('audio-manifest.js 已生成，词数:', words.length);
