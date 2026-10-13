# -*- coding: utf-8 -*-
"""
备案用身份证照片处理 —— 按微信小程序备案官方要求处理照片。

官方要求（developers.weixin.qq.com 小程序备案材料示例）：
  - 格式：JPG / JPEG / PNG（HEIC 不收）
  - 大小：不超过 2M；建议压到 300~600K，避免上传后被系统二次压糊
  - 分辨率：不低于 720*1280（长边 >= 1280 更稳）
  - 必须：证件原件拍照或彩色扫描、含完整边框、四周圆角清晰、彩色、有效期内
  - 禁止：复印件、黑白扫描、翻拍屏幕、电子证件、模糊、缺角
  - 水印：可选。加的话必须加在空白处不遮挡文字图像，内容须与备案相关
    （如"仅供小程序备案使用"），且不得写有效期
  - ⚠️ 大坑：备案上传时**人像面算"正面"**（与常识"国徽面为正"相反），
    两面传反会报"输入信息与图片信息不符"（官方社区已确认过此问题）

用法：
  python scripts/id-photo-for-beian.py <照片...> [--watermark 仅供小程序备案使用] [--out 目录]

输出默认到 C:/Users/w/Documents/备案材料/ —— 故意不放项目目录里：
身份证是最高敏的个人信息，本项目要开源，任何证件图绝不能进 git 仓库。

依赖：Pillow（隔离环境里已装）。iPhone 的 HEIC 需要先在手机里转 JPG（微信发送时
选"原图"出来的就是 JPG，最简单）。
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

MAX_BYTES = 2 * 1024 * 1024          # 官方上限 2M
TARGET_BYTES = 500 * 1024            # 实际目标 ~500K，留足余量防系统二次压缩
MIN_SHORT_SIDE = 720                 # 官方最低分辨率
MIN_LONG_SIDE = 1280
OUT_DEFAULT = os.path.join(os.path.expanduser('~'), 'Documents', '备案材料')


def load_image(path):
    img = Image.open(path)
    if img.mode not in ('RGB', 'L'):
        img = img.convert('RGB')
    return img


def check_size(img, src):
    w, h = img.size
    short, long_ = min(w, h), max(w, h)
    if short < MIN_SHORT_SIDE or long_ < MIN_LONG_SIDE:
        raise SystemExit(
            '✗ %s：分辨率 %dx%d 低于官方下限 720*1280。'
            '请重新拍照（离近一点、光线充足），别用缩过的图。' % (src, w, h))


def add_watermark(img, text):
    """浅色斜向平铺水印。alpha 很低（约 12%），保证不遮挡文字图像——官方硬要求。"""
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    font = None
    for cand in ('C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf',
                 'C:/Windows/Fonts/arial.ttf'):
        if os.path.exists(cand):
            font = ImageFont.truetype(cand, 36)
            break
    if font is None:
        font = ImageFont.load_default()
    step_x, step_y, angle = 420, 260, 30
    for y in range(-img.size[1], img.size[1] * 2, step_y):
        for x in range(-img.size[0], img.size[0] * 2, step_x):
            d.text((x, y), text, font=font, fill=(255, 255, 255, 40),
                   stroke_width=1, stroke_fill=(128, 128, 128, 40))
    layer = layer.rotate(angle, expand=False)
    return Image.alpha_composite(img.convert('RGBA'), layer).convert('RGB')


def save_compressed(img, out_path, keep_exif_bytes=b''):
    """JPEG 质量从 92 往下找，先满足 >=720*1280，再压到 TARGET 以下。"""
    for q in range(92, 39, -6):
        img.save(out_path, 'JPEG', quality=q, optimize=True, progressive=True)
        if os.path.getsize(out_path) <= TARGET_BYTES:
            break
    size = os.path.getsize(out_path)
    if size > MAX_BYTES:
        raise SystemExit('✗ 压到最低质量仍超过 2M，图片可能过大，请先裁剪再试。')
    return size


def process(path, watermark, out_dir):
    name = os.path.splitext(os.path.basename(path))[0]
    img = load_image(path)
    check_size(img, path)
    if watermark:
        img = add_watermark(img, watermark)
    out_path = os.path.join(out_dir, name + '-备案用.jpg')
    size = save_compressed(img, out_path)
    print('✓ %s -> %s (%d KB, %dx%d)'
          % (os.path.basename(path), out_path, size // 1024, img.size[0], img.size[1]))
    print('  上传时注意：人像面填「正面」，国徽面填「反面」（备案程序与常识相反）。')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('photos', nargs='+', help='身份证照片（人像面、国徽面各一张）')
    ap.add_argument('--watermark', default='', help='可选水印文字，留空则不加')
    ap.add_argument('--out', default=OUT_DEFAULT)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    for p in args.photos:
        if not os.path.exists(p):
            raise SystemExit('✗ 找不到文件：%s' % p)
        process(p, args.watermark, args.out)
    print('\n提醒：处理完把原件从微信传输记录里删掉；本项目要开源，证件图别放仓库目录。')


if __name__ == '__main__':
    main()
