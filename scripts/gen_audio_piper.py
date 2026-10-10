# -*- coding: utf-8 -*-
"""
用 Piper（MIT 协议，本地离线推理）为词库批量生成单词发音 mp3。

为什么是它：
  - MIT 许可，模型可自由分发，生成的音频无版权风险（对比 Windows SAPI / edge-tts）
  - 完全本地推理，不依赖网络与第三方服务，结果可复现
  - 生成的 mp3 打进小程序包，真机零依赖——不依赖"同声传译"插件是否授权

用法（在 3.12 venv 里，onnxruntime 必须 ==1.19.2：
  1.18.1 跑 Reshape/GatherElements 会算错 shape（特定词必挂）；
  1.20+ 在本机 DLL 初始化失败；只有 1.19.2 既稳定又算得对）：
  node -e "console.log(JSON.stringify(require('./miniprogram/data/words.js')))" > scripts/words.json
  python scripts/gen_audio_piper.py scripts/words.json miniprogram/pkg-media/assets/audio

模型：scripts/piper-models/en_US-amy-medium.onnx（+ .onnx.json）
  下载：https://hf-mirror.com/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/

产物：miniprogram/pkg-media/assets/audio/<word>.mp3（16kHz 单声道 48kbps，去首尾静音）
  已存在的文件跳过（增量生成），删掉某个 mp3 重跑即可单独重生成。
  文件名净化：词里的空格统一转成连字符（"ice cream" → ice-cream.mp3）——
  2026-10-10 新版词库收录了短语，包内文件名带空格容易在真机/工具上出幺蛾子；
  合成文本仍用原样（Piper 读短语没问题）。tts.js 查表时做同样的净化。
"""
import json
import math
import re
import struct
import sys
import wave
from pathlib import Path

import lameenc
from piper import PiperVoice, SynthesisConfig

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "scripts" / "piper-models" / "en_US-amy-medium.onnx"

# 静音阈值（int16 半振幅），低于它视为静音
SILENCE_AMP = 120
# 目标采样率：16kHz 对"听清单个单词"绰绰有余，体积比 22.05k 小 27%
TARGET_RATE = 16000
# mp3 比特率：16kHz 单声道人声 32kbps 依旧清晰。
# 曾经 48kbps：300 词 ≈1.4MB；外研四上再加 100 词就顶穿 pkg-media 分包 2MB 红线，
# 新增词一律 32kbps（旧文件是 48kbps 的，增量生成时不重编码，两档混用无感）
BITRATE = 32
# 保险起见每合成 N 个词重载一次模型会话（1.19.2 下连续 300 词也稳，但开销仅几秒）
RELOAD_EVERY = 20


def resample_int16(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    if src_rate == dst_rate:
        return pcm
    import audioop  # Python 3.12 仍在标准库
    converted, _ = audioop.ratecv(pcm, 2, 1, src_rate, dst_rate, None)
    return converted


def trim_silence(samples: list) -> list:
    first, last = 0, len(samples) - 1
    while first < len(samples) and abs(samples[first]) < SILENCE_AMP:
        first += 1
    while last > first and abs(samples[last]) < SILENCE_AMP:
        last -= 1
    # 前后各留 30ms 缓冲，避免削字头字尾
    pad = int(TARGET_RATE * 0.03)
    return samples[max(0, first - pad): min(len(samples), last + 1 + pad)]


def synth_word(voice: PiperVoice, cfg: SynthesisConfig, word: str) -> bytes:
    """合成一个词 → (裁静音 + 重采样) 的 int16 PCM bytes"""
    raw = b""
    src_rate = voice.config.sample_rate if hasattr(voice, "config") else voice.sample_rate
    for chunk in voice.synthesize(word, syn_config=cfg):
        raw += chunk.audio_int16_bytes
        if chunk.sample_rate:
            src_rate = chunk.sample_rate
    n = len(raw) // 2
    samples = list(struct.unpack("<%dh" % n, raw[: n * 2]))
    trimmed = trim_silence(samples)
    if len(trimmed) < TARGET_RATE // 10:  # 不足 0.1s 视为异常，用未裁剪版本
        trimmed = samples
    pcm = struct.pack("<%dh" % len(trimmed), *trimmed)
    return resample_int16(pcm, src_rate, TARGET_RATE)


def encode_mp3(pcm: bytes) -> bytes:
    enc = lameenc.Encoder()
    enc.set_bit_rate(BITRATE)
    enc.set_in_sample_rate(TARGET_RATE)
    enc.set_channels(1)
    enc.set_quality(2)  # 2=高
    data = enc.encode(pcm) + enc.flush()
    return bytes(data)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    words_file, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    words = [it["word"] for it in json.loads(words_file.read_text(encoding="utf-8"))]
    print("词数:", len(words))

    voice = PiperVoice.load(MODEL)
    # 单词播报：语速稍慢一点更清晰
    cfg = SynthesisConfig(length_scale=1.1)

    # 防垃圾音频：单次合成的 PCM 时长异常（>8s）视为会话已劣化，直接报错走重试
    def synth_checked(word):
        pcm = synth_word(voice, cfg, word)
        dur = len(pcm) / 2 / TARGET_RATE
        if dur > 8.0:
            raise RuntimeError("合成时长异常 %.1fs（会话劣化）" % dur)
        return pcm

    def reload():
        nonlocal voice
        voice = PiperVoice.load(MODEL)

    done = skipped = failed = 0
    total = 0
    since_reload = 0
    for i, word in enumerate(words, 1):
        # 文件名净化：空格→连字符（短语词条）；合成文本用原样
        fname = re.sub(r"\s+", "-", word)
        out = out_dir / ("%s.mp3" % fname)
        if out.exists() and out.stat().st_size > 0:
            skipped += 1
            continue
        ok_flag = False
        for attempt in (1, 2):
            try:
                mp3 = encode_mp3(synth_checked(word))
                out.write_bytes(mp3)
                done += 1
                total += out.stat().st_size
                ok_flag = True
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    failed += 1
                    print("  [失败] %s: %s" % (word, e))
                reload()  # 会话可能已劣化，重载后重试
                since_reload = 0
        if ok_flag:
            since_reload += 1
            if since_reload >= RELOAD_EVERY:
                reload()
                since_reload = 0
        if i % 50 == 0:
            print("  进度 %d/%d" % (i, len(words)))

    print("完成：生成 %d，跳过 %d，失败 %d" % (done, skipped, failed))
    print("本次新增体积: %.1f KB" % (total / 1024))
    if out_dir.exists():
        all_size = sum(f.stat().st_size for f in out_dir.glob("*.mp3"))
        print("目录总体积: %.1f KB（%d 个文件）" % (all_size / 1024, len(list(out_dir.glob('*.mp3')))))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
