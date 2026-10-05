# -*- coding: utf-8 -*-
"""
生成小程序头像「功课抽查」
- 1024x1024 源图 + 144x144 上传版（微信建议 144px，png，<=2M）
- 设计：品牌渐变底(与 app.wxss 主按钮一致) + 白色粗体"查" + 右下角对勾徽章
  重要内容都在中心 80% 安全区内（头像会被裁圆角/圆形展示）
"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 1024
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"

BLUE = (62, 166, 255)    # #3EA6FF
PURPLE = (124, 92, 255)  # #7C5CFF
GREEN = (30, 200, 120)   # 对勾徽章
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_gradient(size):
    """135° 对角渐变（左上蓝 → 右下紫），与小程序主按钮一致"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            px[x, y] = lerp(BLUE, PURPLE, t)
    return img


def build(size):
    img = make_gradient(size).convert("RGBA")

    # 装饰：右上大圆 + 左下小圆（半透明白，增加层次但保持干净）
    deco = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(deco)
    r1 = int(size * 0.42)
    d.ellipse([size - r1 * 1.35, -r1 * 0.55, size + r1 * 0.35, r1 * 0.85],
              fill=(255, 255, 255, 26))
    r2 = int(size * 0.30)
    d.ellipse([-r2 * 0.5, size - r2 * 1.1, r2 * 0.7, size + r2 * 0.3],
              fill=(255, 255, 255, 18))
    img = Image.alpha_composite(img, deco)

    # 中央大字「查」（白色粗体，带轻微投影）
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_BOLD, int(size * 0.52))
    bbox = draw.textbbox((0, 0), "查", font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    cx, cy = size / 2, size * 0.47  # 视觉中心略上移，给徽章留位
    ox, oy = int(size * 0.006), int(size * 0.008)
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).text(
        (cx - w / 2 - bbox[0] + ox, cy - h / 2 - bbox[1] + oy),
        "查", font=font, fill=(0, 0, 0, 70))
    img = Image.alpha_composite(img, shadow)
    draw = ImageDraw.Draw(img)
    draw.text((cx - w / 2 - bbox[0], cy - h / 2 - bbox[1]),
              "查", font=font, fill=WHITE)

    # 右下角对勾徽章（绿底白勾），中心安全区内
    br = int(size * 0.145)            # 徽章半径
    bx, by = int(size * 0.72), int(size * 0.72)
    badge = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(badge)
    bd.ellipse([bx - br, by - br, bx + br, by + br], fill=GREEN + (255,))
    bd.ellipse([bx - br, by - br, bx + br, by + br],
               outline=(255, 255, 255, 230), width=int(size * 0.016))
    # 手绘对勾（粗线、圆头）
    lw = max(3, int(size * 0.035))
    pts = [(bx - br * 0.45, by + br * 0.02),
           (bx - br * 0.10, by + br * 0.38),
           (bx + br * 0.50, by - br * 0.36)]
    bd.line(pts, fill=WHITE, width=lw, joint="curve")
    for p in (pts[0], pts[-1]):
        r = lw / 2
        bd.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=WHITE)
    img = Image.alpha_composite(img, badge)

    return img.convert("RGB")


def rounded(img, radius_ratio=0.22):
    """输出圆角方形版本（微信展示时会再裁，圆角版用于预览）"""
    size = img.size[0]
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size, size], radius=int(size * radius_ratio), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


out_dir = os.path.join(os.path.dirname(__file__), "..", "assets")
os.makedirs(out_dir, exist_ok=True)
src = build(SIZE)

src.save(os.path.join(out_dir, "avatar.png"))                     # 方形原图
rounded(src).save(os.path.join(out_dir, "avatar-rounded.png"))    # 圆角预览
src.resize((144, 144), Image.LANCZOS).save(
    os.path.join(out_dir, "avatar-144.png"))                      # 微信建议尺寸

kb = os.path.getsize(os.path.join(out_dir, "avatar-144.png")) / 1024
print("生成完成: assets/avatar.png(1024) / avatar-rounded.png / avatar-144.png(%.0fKB)" % kb)
