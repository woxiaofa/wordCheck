# -*- coding: utf-8 -*-
"""
生成糖果皮肤的贴图（一次性工具，产物入仓库）

为什么要贴图而不是纯 CSS：
    参考图的「糖果拟物」质感来自**纹理**——细颗粒让白色卡片不发死、
    顶部高光让卡片有厚度。纯 CSS 渐变只能做出光滑的塑料感。

为什么产物是 base64 内嵌的 wxss，而不是图片文件：
    WXSS 的 url() **不认本地文件**——控制台实锤报错
    「本地资源图片 xxx.png 无法通过 WXSS 获取，可以使用网络图片，
    或者 base64，或使用 <image> 标签」（2026-10-23）。
    贴图总共 ~14KB，base64 后 ~20KB，直接内嵌进 theme-candy-textures.wxss
    （生成文件，CSS 变量 + data URI），theme-candy.wxss 用 var() 引用。
    预览 PNG 落在 scripts/candy-preview/（不在小程序包里，纯给人眼看的）。

用法：python scripts/gen-candy-textures.py
"""

import base64
import math
import os
import random

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_WXSS = os.path.join(ROOT, "miniprogram", "theme-candy-textures.wxss")
PREVIEW_DIR = os.path.join(ROOT, "scripts", "candy-preview")

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


def data_uri(img):
    """RGBA PNG → base64 data URI（WXSS 里唯一能用的本地形态）"""
    tmp = os.path.join(PREVIEW_DIR, "_tmp.png")
    img.save(tmp, "PNG", optimize=True)
    with open(tmp, "rb") as f:
        raw = f.read()
    os.remove(tmp)
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii"), len(raw)


def main():
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    textures = [
        ("candy-bg-grain", grain(96, 13)),
        ("candy-card-gloss", card_gloss(256)),
        ("candy-btn-gloss", btn_gloss(256, 128))
    ]

    lines = [
        "/**",
        " * 糖果皮肤贴图（生成文件，由 scripts/gen-candy-textures.py 产出 —— 不要手改）",
        " *",
        " * 为什么是 base64：WXSS 的 url() 不认本地文件（控制台实锤：",
        " * 「本地资源图片无法通过 WXSS 获取」），只认网络图或 base64。",
        " * 贴图定义成 CSS 变量，theme-candy.wxss 用 var(--candy-xxx) 引用。",
        " */",
        "page {"
    ]
    total = 0
    for name, img in textures:
        uri, raw_size = data_uri(img)
        total += raw_size
        img.save(os.path.join(PREVIEW_DIR, name + ".png"), "PNG", optimize=True)
        print("  → %s  %dx%d  %.1f KB（base64 后 %.1f KB）"
              % (name, img.width, img.height, raw_size / 1024.0, len(uri) / 1024.0))
        lines.append("  --%s: url(\"%s\");" % (name, uri))
    lines.append("}")

    with open(OUT_WXSS, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")

    print("\n三张贴图原始合计 %.1f KB；已生成 %s"
          % (total / 1024.0, os.path.relpath(OUT_WXSS, ROOT)))
    print("预览图落在 scripts/candy-preview/（不在小程序包里）")


if __name__ == "__main__":
    main()
