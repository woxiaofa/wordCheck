# -*- coding: utf-8 -*-
"""
生成短视频口播音频（7 天 × 6~7 句）+ 一段合成 BGM（免版权）。

用法：
  python scripts/gen-video-narration.py

产物：
  assets/video/audio/d{n}_{i}.mp3   逐句口播
  assets/video/audio/manifest.json  每句音频清单（供网页按句播放）
  assets/video/bgm.wav              40 秒柔和循环 BGM
"""
import json
import math
import os
import struct
import wave

import pyttsx3  # Windows SAPI：本机中文音色 Microsoft Huihui

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'assets', 'video', 'audio')

# 每条视频的口播词（画面/字幕见 docs/短视频宣传-7天脚本.md 与 assets/video/成片合集.html）
LINES = {
    1: ['你家孩子是不是也这样：单词背得滚瓜烂熟，一听写就废？',
        '认识，不代表写得出来。',
        '所以我没让他背，我让他写。只给中文，一个字母一个字母敲。',
        '写错了不用我记，它自己进错词本，明天再考一遍。',
        '一天十个词，两分钟，我只看这张表。',
        '背单词最怕的不是记不住，是以为记住了。',
        '想试的，评论区回一，我把词库发你。'],
    2: ['四十个孩子的单词听写，你改多久？',
        '我以前三十八分钟。',
        '现在我只做一件事：选单元，点布置。',
        '孩子自己写完，这边实时出结果：谁对、谁错、错哪个词。',
        '没交的直接催，家长点开就是作业，不用我解释第二遍。',
        '三十八分钟，变三十秒。',
        '带班的评论区回作业，我拉你进体验群。'],
    3: ['别让孩子背单词。',
        '让他被抽查。',
        '背是主动回忆，孩子会自己骗自己。抽查是被动提取，会就是会，不会当场现形。',
        '选义、拼写、听写，三种题型轮着来，专治看着眼熟。',
        '错一个字母就是错，别跟我说差一点。',
        '错的词它替我记着，明天、后天继续考，考到会为止。',
        '同款在评论区，回抽查我发你。'],
    4: ['这种题你刷到过吧？给中文、给图，把句子补完整。',
        '看着简单，孩子一写就露馅。',
        '我把它做进去了：图在下，句子在上，空出来的词自己敲。',
        '填完点确认，读一遍，对是绿勾，错就当场标红。',
        '从背单词，变成会用单词。',
        '想要这种题型的，评论区回句子。'],
    5: ['第二单元一共四十二个词，我不会一天全丢给孩子。',
        '选单元，打开分几天自动布置，选四天。',
        '今天这份当场发出，剩下三天，每天早上八点自动发。',
        '我一周只需要点一次。',
        '布置完我就只看报告，谁没交，点一下催办。',
        '带班的回作业，我拉你进体验群。'],
    6: ['早上送完孩子，我先看的不是群消息，是这张表。',
        '昨天十个词，写对七个，错三个。',
        'Wednesday 错两次，library 错一次。',
        '不用问孩子你背了吗。他还没开口，我已经知道了。',
        '错的词它替我记着，明天继续考。',
        '想看的回报告。'],
    7: ['这一周，我发了六条视频。',
        '后台多了几十个家长、几个班在试用。',
        '反馈最多的一句是：能不能加上我们学校的教材。',
        '所以下一步我就做一件事：拍照上传课本词表，自动生成词库。',
        '还没做好的我不吹，做完再发给你看。',
        '想跟的评论区回一。'],
}

# 语速（词/分钟）：默认约 180，短视频口播偏快一点
RATE = {1: 195, 2: 190, 3: 190, 4: 195, 5: 195, 6: 185, 7: 190}
VOICE_ZH = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens\\TTS_MS_ZH-CN_HUIHUI_11.0'


def tts(text, path, rate):
    e = pyttsx3.init()
    e.setProperty('voice', VOICE_ZH)
    e.setProperty('rate', rate)
    e.setProperty('volume', 1.0)
    e.save_to_file(text, path)
    e.runAndWait()
    e.stop()


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {}
    for day in sorted(LINES):
        items = []
        for i, line in enumerate(LINES[day], start=1):
            name = 'd%d_%d.wav' % (day, i)
            path = os.path.join(OUT, name)
            if not os.path.exists(path):
                tts(line, path, RATE.get(day, 190))
            items.append({'file': 'audio/' + name, 'text': line})
            print('OK', name, line[:18])
        manifest[str(day)] = items
    with open(os.path.join(ROOT, 'assets', 'video', 'audio', 'manifest.json'),
              'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print('manifest written')


def synth_bgm(path, seconds=40, sr=44100):
    """合成一段柔和循环 BGM：低音铺底 + 八分音符琶音 + 轻踩镲。无版权风险。"""
    bpm = 96.0
    beat = 60.0 / bpm
    n = int(seconds * sr)
    buf = [0.0] * n
    # C - G - Am - F 四小节循环
    chords = [[261.63, 329.63, 392.00], [196.00, 246.94, 392.00],
              [220.00, 261.63, 329.63], [174.61, 220.00, 261.63]]
    for i in range(n):
        t = i / sr
        pos = t % (4 * beat * 4)          # 4 小节一大循环
        bar = int(pos / (beat * 4)) % 4
        env_pad = 0.5 + 0.5 * math.sin(2 * math.pi * (t / (beat * 8)))
        v = 0.0
        # 铺底 pad
        for f0 in chords[bar]:
            v += 0.045 * env_pad * math.sin(2 * math.pi * f0 * t)
        # 八分音符琶音（短促衰减）
        step = int(pos / (beat / 2))
        local = pos - step * (beat / 2)
        if local < 0.22:
            note = chords[bar][step % 3] * (2 if step % 6 == 3 else 1)
            v += 0.10 * math.exp(-local * 14) * math.sin(2 * math.pi * note * t)
        # 轻踩镲（噪声衰减）
        if local < 0.05 and step % 2 == 1:
            v += 0.02 * math.exp(-local * 90) * ((i * 2654435761 % 1000) / 1000.0 - 0.5)
        buf[i] = max(-0.9, min(0.9, v))
    with wave.open(path, 'w') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h', int(x * 26000)) for x in buf))
    print('bgm written', path)


if __name__ == '__main__':
    main()
    synth_bgm(os.path.join(ROOT, 'assets', 'video', 'bgm.wav'))
