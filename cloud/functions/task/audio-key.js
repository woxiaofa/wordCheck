/**
 * 词 → 云端音频缓存键（唯一真相，客户端与云端共用）
 *
 * 用途：云端 TTS 合成结果在云存储里的命名（tts-cache/<key>.mp3）
 *       与客户端本地缓存的文件名（tts-<key>.mp3）。两端必须同键，
 *       否则就是"存了找不到"的经典坑。
 *
 * 规则（与内置音频文件名 gen_audio_piper.py 同向）：小写、空格转连字符、
 * 只保留 a-z 0-9 连字符。撇号、点等剥掉："don't" → "dont"、"Ice Cream" → "ice-cream"。
 *
 * 注意与 utils/tts.js 的 fileKey() 区分：fileKey 只做 小写+空格转连字符，
 * 用于查内置清单（清单键可能带撇号/保留大写）；这里更狠一层，专管云端与本地缓存命名。
 */
function key(word) {
  return String(word || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

module.exports = { key: key };
