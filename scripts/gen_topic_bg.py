# -*- coding: utf-8 -*-
"""
生成贴图话题背景图（4:3，1200x900，mp 后台「贴图话题 → 背景图」用）

设计原则：
- 浅色底 + 白色单词卡，公域场景里亮色不压抑
- 右上/中部分散单词卡，左下留干净 —— 话题页会在左下叠加 #话题名称 和简介
- 不写品牌大字：背景是氛围图，话题名由页面自己渲染，叠字会打架

用法：python scripts/gen_topic_bg.py  →  assets/topic-bg.png
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 900
BG = (234, 244, 252)          # 浅蓝底
CARD = (255, 255, 255)
CARD_SHADOW = (205, 224, 240)
WORD = (55, 138, 221)         # 单词（蓝 400）
CN = (120, 132, 148)          # 中文释义（灰）
DOT = (151, 196, 89)          # 绿点（已掌握）
PILL = (255, 255, 255)

FONT_PATHS = [
    r"C:\Windows\Fonts\msyhbd.ttc",   # 微软雅黑 Bold
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def font(size, bold=False):
    paths = [FONT_PATHS[0]] if bold else FONT_PATHS
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def text_center(draw, xy, s, f, fill):
    l, t, r, b = draw.textbbox((0, 0), s, font=f)
    draw.text((xy[0] - (r - l) / 2 - l, xy[1] - (b - t) / 2 - t), s, font=f, fill=fill)


def make_card(word, cn, w=210, h=150, angle=0):
    """一张白底单词卡：绿点 + 单词 + 中文，带一点点角度更像'贴'上去的"""
    card = Image.new("RGBA", (w * 2, h * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    # 阴影层（偏移 8px，无模糊 —— 保持扁平）
    d.rounded_rectangle([24, 40, 24 + w, 40 + h], radius=36, fill=CARD_SHADOW + (255,))
    d.rounded_rectangle([16, 16, 16 + w, 16 + h], radius=36, fill=CARD + (255,))
    x0, y0 = 16, 16
    d.ellipse([x0 + w - 52, y0 + 26, x0 + w - 28, y0 + 50], fill=DOT + (255,))
    f_word = font(56, bold=True)
    f_cn = font(34)
    text_center(d, (x0 + w / 2, y0 + 70), word, f_word, WORD + (255,))
    text_center(d, (x0 + w / 2, y0 + 120), cn, f_cn, CN + (255,))
    return card.rotate(angle, expand=True, resample=Image.BICUBIC)


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # 底部一条更浅的带，压一下构图
    d.rounded_rectangle([-60, H - 150, W + 60, H + 80], radius=80, fill=(226, 239, 250))

    cards = [
        ("apple", "苹果", 60, 80, -8),
        ("happy", "开心", 340, 170, 6),
        ("milk", "牛奶", 150, 360, 5),
        ("sun", "太阳", 520, 390, -7),
        ("tiger", "老虎", 700, 190, -5),
        ("book", "书", 930, 180, 8),
        ("rain", "雨", 870, 440, 4),
        ("star", "星星", 920, 585, -6),
    ]
    for word, cn, x, y, a in cards:
        img.paste(make_card(word, cn, angle=a), (x, y), make_card(word, cn, angle=a))

    # 右上角小徽标：产品一句话（y<160 区域除它之外留空，卡片不许闯进来）
    pill_w, pill_h = 460, 88
    d.rounded_rectangle([W - pill_w - 50, 40, W - 50, 40 + pill_h], radius=44, fill=PILL)
    text_center(d, (W - 50 - pill_w / 2, 40 + pill_h / 2),
                "一天十个词 · 两分钟", font(40, bold=True), (84, 110, 140))

    out = os.path.join(os.path.dirname(__file__), "..", "assets", "topic-bg.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out)
    print("saved:", os.path.normpath(out), img.size)


if __name__ == "__main__":
    main()
