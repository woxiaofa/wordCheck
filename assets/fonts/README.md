# 字体说明（重要：版权）

头像等对外发布的图片**一律不使用微软雅黑 / 黑体 / 宋体 / 楷体**——它们是 Windows 自带的
微软（及方正）授权字体，只授权在 Windows 内使用，把字形渲染进对外分发的图片属于再分发行为。

本项目使用：

- **思源黑体 Source Han Sans SC（Adobe，SIL Open Font License 1.1）**
  明确允许商用、修改、再分发，是 Logo / 宣传图最安全的中文黑体选择之一。
  授权全文：<https://github.com/adobe-fonts/source-han-sans/blob/master/LICENSE.txt>

## 首次使用：下载一次字体

字体文件 17MB，**不入库**（已在 .gitignore 排除），每台机器拉一次即可：

```bash
mkdir -p assets/fonts
curl -L -o assets/fonts/SourceHanSansSC-Heavy.otf \
  https://ghproxy.net/https://raw.githubusercontent.com/adobe-fonts/source-han-sans/release/OTF/SimplifiedChinese/SourceHanSansSC-Heavy.otf
```

（本机 GitHub 直连不通，走 ghproxy 镜像；通的话去掉代理前缀即可。Heavy 字重最适合头像，
也可用 Bold / Black。）

下载后重新生成头像：

```bash
python scripts/make-avatar.py
```

脚本找不到开源字体会直接报错退出，**不会静默回退到微软雅黑**（回退会悄悄引入版权风险）。

## 若将来要换成别的字体

必须是明确授权商用的，例如：思源黑体（OFL）、阿里巴巴普惠体（免费商用授权）、
OPPO Sans / MiSans（免费商用）、得意黑 Smiley Sans（OFL）、霞鹜文楷（OFL）。
把字体文件放进 `assets/fonts/` 并在 `scripts/make-avatar.py` 的 `FONT_CANDIDATES` 里加一行即可。
