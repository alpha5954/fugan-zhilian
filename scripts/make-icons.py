"""从 logo.jpg 生成一套规范的 favicon。

【关键决策：怎么抠背景】
logo 是一个圆，圆外是白底、圆内鱼鳞之间也有白色负空间。
第一版用「从四角洪水填充」识别圆外 —— 结果填充率 62.9%（理论值应约 34%），
说明填充顺着圆形边缘渗进了鱼鳞缝隙，圆内 38.4% 变成了透明。
那样的 logo 在深色背景上会变成镂空的，与设计意图不符。

改成**几何方式**：非白像素的包围盒就是圆的直径，只抠这个圆之外的区域。
圆内一律保持不透明，白色负空间原样保留。
"""
import os

import numpy as np
from PIL import Image

SRC = 'design/logo-source.jpg'
OUT = 'public'

im = Image.open(SRC).convert('RGB')
w, h = im.size
arr = np.array(im)
gray = np.array(im.convert('L'))

# ---------------------------------------------------------------------------
# 1. 用非白像素的包围盒定出这个圆
# ---------------------------------------------------------------------------
not_white = gray < 235
ys, xs = np.where(not_white)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
# 横纵直径略有差异（1176 vs 1212），取平均更接近真实半径
radius = ((x1 - x0) + (y1 - y0)) / 4
print('  圆心 (%.0f, %.0f)  半径 %.1f' % (cx, cy, radius))

# ---------------------------------------------------------------------------
# 2. alpha：圆外透明，圆内不透明，边缘 2px 羽化
# ---------------------------------------------------------------------------
yy, xx = np.ogrid[:h, :w]
dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)

FEATHER = 2.0
alpha = np.clip((radius - dist) / FEATHER * 255, 0, 255).astype(np.uint8)

rgba = np.dstack([arr, alpha])
full = Image.fromarray(rgba, 'RGBA')

# ---------------------------------------------------------------------------
# 3. 裁掉四周空白，补成正方形
# ---------------------------------------------------------------------------
pad = 4
left = max(0, int(cx - radius) - pad)
top = max(0, int(cy - radius) - pad)
right = min(w, int(cx + radius) + pad)
bottom = min(h, int(cy + radius) + pad)
full = full.crop((left, top, right, bottom))

cw, ch = full.size
side = max(cw, ch)
square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
square.paste(full, ((side - cw) // 2, (side - ch) // 2))
print('  裁切 %d×%d → 正方形 %d×%d' % (cw, ch, side, side))

# ---------------------------------------------------------------------------
# 4. 导出
# ---------------------------------------------------------------------------
def save(img, name, size, background=None):
    out = img.resize((size, size), Image.LANCZOS)
    if background is not None:
        flat = Image.new('RGB', (size, size), background)
        flat.paste(out, (0, 0), out)
        out = flat
    path = os.path.join(OUT, name)
    out.save(path, optimize=True)
    print('  %-24s %3d×%-3d %6.1f KB' % (name, size, size, os.path.getsize(path) / 1024))


print()
save(square, 'favicon-32.png', 32)
save(square, 'favicon-16.png', 16)
save(square, 'logo.png', 512)
# iOS 不接受透明图标，会自行填黑 —— 显式给白底
save(square, 'apple-touch-icon.png', 180, background=(255, 255, 255))

ico = os.path.join(OUT, 'favicon.ico')
square.save(ico, format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])
print('  %-24s 16/32/48 %6.1f KB' % ('favicon.ico', os.path.getsize(ico) / 1024))
