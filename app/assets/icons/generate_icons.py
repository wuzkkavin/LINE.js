#!/usr/bin/env python3
# AI寶 側欄圖示產生器 (自繪, 規格見 design/icons.md 定稿)
#
# 做法: 本腳本內含九顆圖示的 SVG 源稿 (單一事實來源), 先寫出 src/*.svg,
# 再用 Playwright (chromium) 以透明底光柵化 256px, 最後以 PIL 降階出
# 128/64/48/32px。圖示本體只畫白色符號 + 透明底, 底色由 App 依主題主色
# 即時填繪 (LINE 登入除外: 全彩定版, 底色固定 LINE 綠 #06C755)。
#
# 設計座標: 1024 畫布; 符號置中、線寬一致 (描邊約 58-66px 圓頭),
# 在側欄實際顯示約 20-26px 時仍可辨識。不得改用任何未授權圖檔;
# macosicons.com 僅作風格參考 (icons.md 授權查證結論)。
#
# 重跑: ~/workspace/.tools/sshot-venv/bin/python generate_icons.py
# 相依: 該 venv 的 playwright + PIL (Pillow)。

import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(HERE, "src")
SIZES = [256, 128, 64, 48, 32]
MAIN_SIZE = 256

W = 'fill="#fff"'
S = 'stroke="#fff" fill="none" stroke-linecap="round" stroke-linejoin="round"'


def gear_path(cx=512, cy=512, r_out=252, r_root=198, r_hole=94, teeth=8):
    """八齒齒輪實心剪影 (偶奇填充挖中心孔), 以多邊形近似圓弧。"""
    pitch = 360.0 / teeth
    pts = []
    for i in range(teeth):
        c = i * pitch  # 齒中心角
        seq = [
            (c - pitch / 2 + 2.5, r_root),
            (c - 20.0, r_root),
            (c - 8.5, r_out),
            (c + 8.5, r_out),
            (c + 20.0, r_root),
        ]
        for ang, rad in seq:
            r = math.radians(ang)
            pts.append((cx + rad * math.cos(r), cy + rad * math.sin(r)))
        # 齒根弧到下一齒
        a0 = c + 20.0
        a1 = c + pitch - 20.0
        t = a0 + 5.0
        while t < a1:
            r = math.radians(t)
            pts.append((cx + r_root * math.cos(r), cy + r_root * math.sin(r)))
            t += 5.0
    d = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + " Z"
    # 中心孔 (反向繞): 兩段圓弧
    hole = (
        f"M {cx - r_hole} {cy} "
        f"a {r_hole} {r_hole} 0 1 0 {2 * r_hole} 0 "
        f"a {r_hole} {r_hole} 0 1 0 {-2 * r_hole} 0 Z"
    )
    return d + " " + hole


SVG = {}

SVG["nav-overview"] = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<path d="M272 512 L512 282 L752 512" {S} stroke-width="66"/>
<path d="M352 470 V742 H672 V470" {S} stroke-width="66"/>
<circle cx="512" cy="622" r="54" {W}/>
</svg>"""

SVG["nav-line-login"] = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#1ED373"/>
<stop offset=".55" stop-color="#06C755"/>
<stop offset="1" stop-color="#04A244"/>
</linearGradient>
<radialGradient id="hl" cx=".5" cy=".5" r=".5">
<stop offset="0" stop-color="#fff" stop-opacity=".28"/>
<stop offset="1" stop-color="#fff" stop-opacity="0"/>
</radialGradient>
<filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
<feGaussianBlur stdDeviation="16"/>
</filter>
</defs>
<rect x="100" y="116" width="824" height="824" rx="196" fill="#000" opacity=".16" filter="url(#soft)"/>
<rect x="100" y="100" width="824" height="824" rx="196" fill="url(#g)"/>
<ellipse cx="512" cy="252" rx="336" ry="128" fill="url(#hl)"/>
<path d="M398 590 L390 716 L508 628 Z" fill="#fff"/>
<rect x="302" y="336" width="420" height="292" rx="84" fill="#fff"/>
<circle cx="512" cy="452" r="48" fill="#06C755"/>
<rect x="494" y="478" width="36" height="104" rx="18" fill="#06C755"/>
</svg>"""

SVG["nav-ai-settings"] = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<path d="M748 182 C760 226 780 246 824 262 C780 278 760 298 748 342 C736 298 716 278 672 262 C716 246 736 226 748 182 Z" {W}/>
<line x1="282" y1="428" x2="742" y2="428" {S} stroke-width="58"/>
<circle cx="606" cy="428" r="64" {W}/>
<line x1="282" y1="612" x2="742" y2="612" {S} stroke-width="58"/>
<circle cx="424" cy="612" r="64" {W}/>
</svg>"""

SVG["nav-bot"] = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<rect x="226" y="352" width="430" height="296" rx="76" {S} stroke-width="62"/>
<path d="M330 636 L318 740 L448 654" {S} stroke-width="62"/>
<path d="M742 150 L628 352 L696 352 L656 478 L816 262 L732 262 Z" {W}/>
</svg>"""

SVG["nav-kb"] = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<rect x="316" y="250" width="392" height="524" rx="30" {S} stroke-width="60"/>
<line x1="398" y1="252" x2="398" y2="772" {S} stroke-width="44"/>
<path d="M472 392 Q566 360 652 392" {S} stroke-width="42"/>
<path d="M472 500 Q566 468 652 500" {S} stroke-width="42"/>
<path d="M556 250 H646 V448 L601 402 L556 448 Z" {W}/>
</svg>"""

SVG["nav-scam"] = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<path d="M512 226 C582 272 652 290 730 290 V498 C730 644 634 740 512 798 C390 740 294 644 294 498 V290 C372 290 442 272 512 226 Z" {S} stroke-width="58"/>
<path d="M418 514 L490 586 L622 424" {S} stroke-width="66"/>
</svg>"""

SVG["nav-logs"] = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<path d="M348 238 H600 L704 342 V786 H348 Z" {S} stroke-width="58"/>
<path d="M600 238 V342 H704" {S} stroke-width="58"/>
<line x1="406" y1="462" x2="646" y2="462" {S} stroke-width="46"/>
<line x1="406" y1="552" x2="646" y2="552" {S} stroke-width="46"/>
<line x1="406" y1="642" x2="556" y2="642" {S} stroke-width="46"/>
<circle cx="652" cy="676" r="66" {S} stroke-width="42"/>
<path d="M652 676 V626 M652 676 L690 692" {S} stroke-width="36"/>
</svg>"""

SVG["nav-app-settings"] = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
    f'<path d="{gear_path()}" fill="#fff" fill-rule="evenodd"/>'
    "</svg>"
)

SVG["nav-about"] = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<circle cx="512" cy="512" r="252" {S} stroke-width="58"/>
<circle cx="512" cy="388" r="42" {W}/>
<rect x="478" y="486" width="68" height="168" rx="34" {W}/>
</svg>"""

# 聊天室畫面 (2026-10-21 新增頁): 視窗外框 + 標題列 + 三行對話行, 意象為「聊天視窗」。
SVG["nav-chat"] = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<rect x="212" y="252" width="600" height="520" rx="40" {S} stroke-width="62"/>
<line x1="212" y1="384" x2="812" y2="384" {S} stroke-width="52"/>
<circle cx="300" cy="318" r="24" {W}/>
<line x1="300" y1="492" x2="664" y2="492" {S} stroke-width="48"/>
<line x1="300" y1="592" x2="576" y2="592" {S} stroke-width="48"/>
<line x1="300" y1="692" x2="624" y2="692" {S} stroke-width="48"/>
</svg>"""


def main():
    os.makedirs(SRC_DIR, exist_ok=True)
    for name, svg in SVG.items():
        with open(os.path.join(SRC_DIR, name + ".svg"), "w", encoding="utf-8") as f:
            f.write(svg + "\n")

    # 組一頁, 每顆圖示一個 div, 逐顆截圖 (透明底)
    cells = "\n".join(
        f'<div class="cell" id="{name}">{svg}</div>' for name, svg in SVG.items()
    )
    html = (
        "<html><head><meta charset='utf-8'><style>"
        "body{margin:0;background:transparent}"
        f".cell{{width:{MAIN_SIZE}px;height:{MAIN_SIZE}px}}"
        ".cell svg{width:100%;height:100%;display:block}"
        "</style></head><body>" + cells + "</body></html>"
    )
    html_path = os.path.join(SRC_DIR, "_render.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": MAIN_SIZE + 40, "height": (MAIN_SIZE + 8) * len(SVG)})
        pg.goto("file://" + html_path)
        pg.wait_for_timeout(600)
        for name in SVG:
            pg.locator("#" + name).screenshot(
                path=os.path.join(HERE, f"{name}-{MAIN_SIZE}.png"), omit_background=True
            )
        b.close()
    os.remove(html_path)

    from PIL import Image

    for name in SVG:
        src = Image.open(os.path.join(HERE, f"{name}-{MAIN_SIZE}.png"))
        assert src.size == (MAIN_SIZE, MAIN_SIZE), (name, src.size)
        for size in SIZES:
            if size == MAIN_SIZE:
                continue
            out = src.resize((size, size), Image.LANCZOS)
            out.save(os.path.join(HERE, f"{name}-{size}.png"))
    print("generated:", ", ".join(sorted(SVG)))


if __name__ == "__main__":
    sys.exit(main())
