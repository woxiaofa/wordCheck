# -*- coding: utf-8 -*-
"""
体验课「短句 / 小段」示范音离线合成（Piper，MIT 协议）。

  C:/Python312/python.exe scripts/gen_lesson_audio.py
  C:/Python312/python.exe scripts/gen_lesson_audio.py --check     # 只校验，不合成

为什么单独一个脚本，不复用 gen_audio_piper.py：
  · 那个脚本的输入是「词表 JSON」，输出固定写进 pkg-media/assets/audio；
    pkg-media 已被 454 个词级 mp3 占到 2026KB / 2048KB，只剩 22KB，
    句段音频一律不能往里塞（2026-11-08 实锤）。
  · 这里是**句子**级合成，文本更长、语速与静音处理不同，且必须和小程序的
    data/oral-lesson.js 是同一份素材，否则会出现"页面显示 A、音频读 B"。

单一真相源：素材文本不在这份 py 里复制一份，而是用 node 现场从
miniprogram/data/oral-lesson.js 的 buildItems() 抽出来。改句子只需改 JS，重跑本脚本。

依赖（与词级脚本同一套，Python 3.12 + onnxruntime==1.19.2）：
  piper-tts / lameenc / onnxruntime==1.19.2
模型：scripts/piper-models/en_US-amy-medium.onnx
产物：miniprogram/pkg-oral/assets/lesson/{s1..s4,p1}.mp3（16kHz 单声道 32kbps）
"""

import subprocess
import sys
from pathlib import Path

from piper import PiperVoice, SynthesisConfig
from gen_audio_piper import MODEL, TARGET_RATE, synth_word, encode_mp3

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "miniprogram" / "pkg-oral" / "assets" / "lesson"

# 只取有 audio 的条目（词级走已有的 454 个 mp3，不在这里重复合成）
EXTRACT_JS = (
    "console.log(JSON.stringify("
    "require('./miniprogram/data/oral-lesson.js').buildItems()"
    ".filter(function(x){return !!x.audio;})"
    ".map(function(x){return {file:x.audio.split('/').pop(), text:x.refText};})"
    "))"
)

MAX_DUR_SEC = 20.0   # 小段有 3 句，比单词长得多；超过 20s 才算会话劣化


def lesson_items():
    raw = subprocess.check_output(
        ["node", "-e", EXTRACT_JS], cwd=str(ROOT), text=True, encoding="utf-8"
    )
    items = json_loads(raw)
    if not items:
        raise RuntimeError("没从 oral-lesson.js 抽到任何句 / 段素材")
    seen = set()
    for it in items:
        if not it.get("file") or not it.get("text"):
            raise RuntimeError("素材缺 file / text：" + repr(it))
        if it["file"] in seen:
            raise RuntimeError("音频文件名重复：" + it["file"])
        seen.add(it["file"])
    return items


def json_loads(raw):
    import json
    return json.loads(raw)


def main() -> int:
    check_only = "--check" in sys.argv[1:]
    items = lesson_items()
    OUT.mkdir(parents=True, exist_ok=True)

    if check_only:
        missing = [it["file"] for it in items
                   if not (OUT / it["file"]).exists() or (OUT / it["file"]).stat().st_size == 0]
        print("校验 %d 条句 / 段音频：%s" % (len(items), "全在" if not missing else "缺 " + ", ".join(missing)))
        return 1 if missing else 0

    voice = PiperVoice.load(MODEL)
    # 句子语速比单词稍慢，孩子跟得上；length_scale 越大越慢
    cfg = SynthesisConfig(length_scale=1.05)

    done = skipped = failed = 0
    total = 0
    for it in items:
        out = OUT / it["file"]
        if out.exists() and out.stat().st_size > 0:
            skipped += 1
            continue
        ok = False
        for attempt in (1, 2):
            try:
                pcm = synth_word(voice, cfg, it["text"])
                dur = len(pcm) / 2 / TARGET_RATE
                if dur > MAX_DUR_SEC:
                    raise RuntimeError("合成时长异常 %.1fs" % dur)
                mp3 = encode_mp3(pcm)
                out.write_bytes(mp3)
                done += 1
                total += len(mp3)
                print("  [生成] %-8s %5.1fs  %5.1f KB  %s" %
                      (it["file"], dur, len(mp3) / 1024, it["text"]))
                ok = True
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    failed += 1
                    print("  [失败] %s: %s" % (it["file"], e))
                voice = PiperVoice.load(MODEL)   # 会话劣化时重载再试一次
        if not ok:
            continue

    all_size = sum(f.stat().st_size for f in OUT.glob("*.mp3"))
    print("完成：生成 %d，跳过 %d，失败 %d；本次新增 %.1f KB，目录合计 %.1f KB" %
          (done, skipped, failed, total / 1024, all_size / 1024))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
