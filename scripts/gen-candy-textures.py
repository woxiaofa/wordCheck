# -*- coding: utf-8 -*-
"""
生成糖果皮肤的贴图（一次性工具，产物入仓库）

为什么要贴图而不是纯 CSS：
    参考图的「糖果拟物」质感来自**纹理**——细颗粒让白色卡片不发死、
    顶部高光让卡片有厚度。纯 CSS 渐变只能做出光滑的塑料感，
    在真机上就是"一块白底"，看着没质感。
    但全图切图每套 +2~3MB 不可接受，所以只做三张小图：
      底纹颗粒 96×96（平铺）、卡片高光 256×256（拉伸）、按钮光泽 256×128（拉伸）。
    RGBA PNG，控制在单张几十 KB 以内。

用法：python scripts/gen-candy-textures.py
"""

import math
import os
import random

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "miniprogram", "assets", "candy")

random.seed(20261023)


def grain(size=96, peak=13):
    """
    细颗粒底纹：低幅度的亮/暗斑点，必须**半透明**——
    不透明的话整张图会把粉色底盖成一块灰，本末倒置。
    """
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            n = random.randint(-peak, peak)
            # 大尺度柔波：让颗粒有疏密，不机械（纯噪点看着像脏屏）
            n += int(
                3.0 * math.sin((x / size) * math.pi * 2)
                + 3.0 * math.sin((y / size) * math.pi * 2)
            )
            if n >= 0:
                px[x, y] = (255, 255, 255, min(255, n * 2))
            else:
                px[x, y] = (0, 0, 0, min(255, -n * 2))
    return img


def card_gloss(size=256):
    """卡片：上方宽高光 + 底部一圈极淡的暗边（模拟厚度）"""
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        t = y / float(size - 1)
        # 高光：顶部 0.55 → 45% 处衰减到 0
        gloss = max(0.0, 0.55 * (1.0 - t / 0.45)) if t < 0.45 else 0.0
        # 底部内收暗边：最后 18% 渐起
        shade = 0.0 if t < 0.82 else 0.10 * ((t - 0.82) / 0.18)
        for x in range(size):
            # 高光略偏左上，中心更亮
            cx = (x - size * 0.42) / (size * 0.55)
            fall = max(0.0, 1.0 - cx * cx * 0.55)
            a = gloss * fall
            r = g = b = 255
            if shade:
                a = max(a, shade)
                r, g, b = 224, 140, 168
            px[x, y] = (r, g, b, int(a * 255))
    return img


def btn_gloss(w=256, h=128):
    """按钮：上半部柔光 + 底部压暗，做出「凸起软糖」"""
    img = Image.new("RGBA", (w, h))
    px = img.load()
    for y in range(h):
        t = y / float(h - 1)
        top = max(0.0, 0.42 * (1.0 - t / 0.5)) if t < 0.5 else 0.0
        bottom = 0.0 if t < 0.6 else 0.22 * ((t - 0.6) / 0.4)
        for x in range(w):
            a = top
            r = g = b = 255
            if bottom > a:
                a = bottom
                r, g, b = 120, 8, 44
            px[x, y] = (r, g, b, int(a * 255))
    return img


def main():
    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    files = [
        ("candy-bg-grain.png", grain(96, 13)),
        ("candy-card-gloss.png", card_gloss(256)),
        ("candy-btn-gloss.png", btn_gloss(256, 128))
    ]
    total = 0
    for name, img in files:
        p = os.path.join(OUT, name)
        img.save(p, "PNG", optimize=True)
        size = os.path.getsize(p)
        total += size
        print("  → %s  %dx%d  %.1f KB" % (name, img.width, img.height, size / 1024.0))
    print("\n三张贴图合计 %.1f KB" % (total / 1024.0))


if __name__ == "__main__":
    main()
