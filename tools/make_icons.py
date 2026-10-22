#!/usr/bin/env python3
"""生成 P2P 安全通信 PWA 图标（生成时需要 cairosvg / PIL，运行时零依赖）。

用法:
    python3 tools/make_icons.py

产出:
    icons/icon-192.png            普通图标 (any)
    icons/icon-512.png            普通图标 (any)
    icons/icon-maskable-192.png   自适应图标 (maskable, 内容置于安全区)
    icons/icon-maskable-512.png   自适应图标 (maskable, 内容置于安全区)
    icons/icon-180.png            iOS apple-touch-icon (不透明)
    icons/favicon-32.png          浏览器标签页图标
    icons/favicon-16.png          浏览器标签页图标
    icons/favicon.ico             多尺寸 favicon (16/32/48)
    icons/icon.svg                矢量源文件

设计: 深绿渐变底 + 两个重叠的对话气泡 + 中央挂锁，表达“点对点直连 + 加密”。
"""

import os
import io

import cairosvg
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "icons")

# ---------- 调色板（与 index.html 的 --primary: #07C160 一致） ----------
BG_TOP = "#13D473"
BG_BOTTOM = "#047C42"
GLOW = "#EAFFF3"
BUBBLE_BACK = "#CFF7DF"
BUBBLE_FRONT = "#FFFFFF"
LOCK_BADGE = "#075E36"
LOCK_FG = "#FFFFFF"

BASE = 512.0


def _bubble(x, y, w, h, rx, fill, tail, opacity=1.0):
    """圆角矩形气泡 + 三角尾巴，tail = (x1, y1, x2, y2, x3, y3)"""
    tx1, ty1, tx2, ty2, tx3, ty3 = tail
    return (
        f'<path d="M {x + rx} {y} H {x + w - rx} '
        f'A {rx} {rx} 0 0 1 {x + w} {y + rx} '
        f'V {y + h - rx} A {rx} {rx} 0 0 1 {x + w - rx} {y + h} '
        f'H {x + rx} A {rx} {rx} 0 0 1 {x} {y + h - rx} '
        f'V {y + rx} A {rx} {rx} 0 0 1 {x + rx} {y} Z" '
        f'fill="{fill}" fill-opacity="{opacity}"/>'
        f'<path d="M {tx1} {ty1} L {tx2} {ty2} L {tx3} {ty3} Z" '
        f'fill="{fill}" fill-opacity="{opacity}"/>'
    )


def _lock(cx, cy, scale=1.0, fg=LOCK_FG, keyhole=LOCK_BADGE):
    """挂锁：锁梁 + 圆角锁体 + 锁孔"""
    bw, bh = 70 * scale, 56 * scale
    body_y = cy + 6 * scale
    r = 21 * scale
    sw = 11 * scale
    top = body_y - 16 * scale
    return (
        f'<path d="M {cx - r} {top} V {top - 2 * scale} '
        f'a {r} {r} 0 0 1 {2 * r} 0 V {top}" '
        f'fill="none" stroke="{fg}" stroke-width="{sw}" stroke-linecap="round"/>'
        f'<rect x="{cx - bw / 2}" y="{body_y}" width="{bw}" height="{bh}" '
        f'rx="{12 * scale}" fill="{fg}"/>'
        f'<circle cx="{cx}" cy="{body_y + bh * 0.38}" r="{7 * scale}" fill="{keyhole}"/>'
        f'<rect x="{cx - 3.5 * scale}" y="{body_y + bh * 0.38}" '
        f'width="{7 * scale}" height="{15 * scale}" rx="{3.5 * scale}" fill="{keyhole}"/>'
    )


def _scene():
    """完整图标内容：两个对话气泡 + 中央加密徽标"""
    out = []
    out.append(
        _bubble(68, 106, 218, 164, 56, BUBBLE_BACK,
                (108, 266, 84, 322, 174, 272), 0.95)
    )
    out.append(
        _bubble(226, 196, 218, 164, 56, BUBBLE_FRONT,
                (404, 356, 430, 412, 338, 360))
    )
    out.append(
        f'<circle cx="256" cy="256" r="66" fill="{LOCK_BADGE}" '
        f'stroke="{LOCK_FG}" stroke-opacity="0.35" stroke-width="6"/>'
    )
    out.append(_lock(256, 252, 0.94))
    return "".join(out)


def _scene_small():
    """小尺寸（16/32px）简化版：单气泡 + 挂锁，保证可辨识"""
    return (
        _bubble(86, 96, 340, 268, 84, BUBBLE_FRONT,
                (150, 360, 118, 430, 226, 366))
        + _lock(256, 207, 1.5, LOCK_BADGE, LOCK_FG)
    )


def build_svg(variant="any"):
    """variant: any | maskable | small"""
    if variant == "maskable":
        bg = (
            f'<rect width="{BASE}" height="{BASE}" fill="url(#bg)"/>'
            f'<rect width="{BASE}" height="{BASE}" fill="url(#glow)"/>'
        )
        content = (
            f'<g transform="translate({BASE / 2} {BASE / 2}) scale(0.74) '
            f'translate({-BASE / 2} {-BASE / 2})">{_scene()}</g>'
        )
    else:
        bg = (
            f'<rect width="{BASE}" height="{BASE}" rx="{BASE * 0.219}" fill="url(#bg)"/>'
            f'<rect width="{BASE}" height="{BASE}" rx="{BASE * 0.219}" fill="url(#glow)"/>'
        )
        content = _scene_small() if variant == "small" else _scene()

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{BASE}" height="{BASE}" viewBox="0 0 {BASE} {BASE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.45" y2="1">
      <stop offset="0" stop-color="{BG_TOP}"/>
      <stop offset="1" stop-color="{BG_BOTTOM}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.3" cy="0.22" r="0.72">
      <stop offset="0" stop-color="{GLOW}" stop-opacity="0.30"/>
      <stop offset="1" stop-color="{GLOW}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  {bg}
  {content}
</svg>
"""


def render(svg, size):
    png = cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=size, output_height=size)
    if png is None:
        raise RuntimeError(f"SVG 渲染失败: {size}px")
    return Image.open(io.BytesIO(png)).convert("RGBA")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    any_svg = build_svg("any")
    mask_svg = build_svg("maskable")
    small_svg = build_svg("small")

    with open(os.path.join(OUT_DIR, "icon.svg"), "w", encoding="utf-8") as f:
        f.write(any_svg)

    render(any_svg, 192).save(os.path.join(OUT_DIR, "icon-192.png"))
    render(any_svg, 512).save(os.path.join(OUT_DIR, "icon-512.png"))
    render(mask_svg, 192).save(os.path.join(OUT_DIR, "icon-maskable-192.png"))
    render(mask_svg, 512).save(os.path.join(OUT_DIR, "icon-maskable-512.png"))
    render(small_svg, 32).save(os.path.join(OUT_DIR, "favicon-32.png"))
    render(small_svg, 16).save(os.path.join(OUT_DIR, "favicon-16.png"))

    # iOS apple-touch-icon：不支持透明通道，压平背景
    render(any_svg, 180).convert("RGB").save(os.path.join(OUT_DIR, "icon-180.png"))

    # 多尺寸 favicon（源图需 >= 最大目标尺寸）
    ico = render(small_svg, 48)
    ico.save(
        os.path.join(OUT_DIR, "favicon.ico"),
        sizes=[(16, 16), (32, 32), (48, 48)],
    )

    for name in sorted(os.listdir(OUT_DIR)):
        path = os.path.join(OUT_DIR, name)
        print(f"{name:28s} {os.path.getsize(path):>8d} B")


if __name__ == "__main__":
    main()
