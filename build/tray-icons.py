# Draws the tray / menu-bar gauge icons into public/.
#   python build/tray-icons.py
# Windows: tray.png (16) + tray@2x.png (32), colour.
# macOS:   trayTemplate.png (22) + trayTemplate@2x.png (44), black + alpha
#          (a template image; macOS tints it for light/dark menu bars).
# Live needle: public/gauge/win-NNN.png and mac-NNN.png (+ @2x), one per 5%
# of 5-hour usage. The app swaps between them to sweep the needle.
#   task-NNN: Windows taskbar button (32 + @2x 64)
#   dock-NNN: macOS Dock / Cmd-Tab icon (128 + @2x 256), on a dark tile
# App icon: build/icon.png (1024, dark tile); electron-builder makes the
# .ico and .icns from it.
import math
import os
from PIL import Image, ImageDraw

SS = 2048  # supersampled canvas; scaled down with LANCZOS
OUT = os.path.join(os.path.dirname(__file__), '..', 'public')

# Arc runs from lower-left over the top to lower-right. Angles are PIL's:
# degrees clockwise from 3 o'clock, so 270 is straight up.
ARC = (150, 390)
GAP = 7
NEEDLE = 318  # static icon: up and to the right, "getting there"
GREEN, YELLOW, RED = (76, 201, 110), (242, 192, 55), (231, 84, 64)
NEEDLE_COLOR = (255, 255, 255)
OUTLINE = (30, 30, 30)


def pct_angle(pct):
    return ARC[0] + (ARC[1] - ARC[0]) * pct / 100


def gauge(template, pad, angle=NEEDLE):
    im = Image.new('RGBA', (SS, SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = SS - 2 * pad
    w = int(s * 0.17)
    r = s / 2  # outer radius; PIL strokes an arc inward from its box
    # Centre the gauge's height (top of the arc to the bottom of its ends).
    h = r + r * math.sin(math.radians(ARC[1] - 360))
    cx, cy = SS / 2, pad + (s - h) / 2 + r
    box = [cx - r, cy - r, cx + r, cy + r]
    a0, a1 = ARC
    step = (a1 - a0) / 3
    colors = [GREEN, YELLOW, RED]
    for i in range(3):
        start = a0 + i * step + (GAP / 2 if i else 0)
        end = a0 + (i + 1) * step - (GAP / 2 if i < 2 else 0)
        fill = (0, 0, 0, 255) if template else colors[i] + (255,)
        d.arc(box, start, end, fill=fill, width=w)
    # Needle with round ends, drawn over a dark outline so it reads on the
    # colour arc and on light taskbars (colour version only).
    L = r - w - s * 0.07  # stops short of the arc so they don't merge
    t = math.radians(angle)
    tip = (cx + L * math.cos(t), cy + L * math.sin(t))
    hub = s * 0.13

    def needle(width, fill):
        d.line([(cx, cy), tip], fill=fill, width=int(width))
        e = width / 2
        d.ellipse([tip[0] - e, tip[1] - e, tip[0] + e, tip[1] + e], fill=fill)
        d.ellipse([cx - hub - (width - s * 0.12) / 2, cy - hub - (width - s * 0.12) / 2,
                   cx + hub + (width - s * 0.12) / 2, cy + hub + (width - s * 0.12) / 2], fill=fill)

    if template:
        needle(s * 0.12, (0, 0, 0, 255))
    else:
        needle(s * 0.20, OUTLINE + (255,))
        needle(s * 0.12, NEEDLE_COLOR + (255,))
    return im


def save(template, size, name, angle=NEEDLE):
    pad = int(SS * (0.02 if not template else 0.10))
    img = gauge(template, pad, angle).resize((size, size), Image.LANCZOS)
    img.save(os.path.join(OUT, name))


TILE = (32, 33, 40)


def tile(size, path, angle=NEEDLE):
    # macOS-style app tile: a dark rounded square inset ~10%, gauge inside.
    im = Image.new('RGBA', (SS, SS), (0, 0, 0, 0))
    inset = SS * 0.10
    ImageDraw.Draw(im).rounded_rectangle([inset, inset, SS - inset, SS - inset],
                                         radius=SS * 0.18, fill=TILE + (255,))
    g = gauge(False, int(SS * 0.22), angle)
    im.alpha_composite(g)
    im.resize((size, size), Image.LANCZOS).save(path)


save(False, 16, 'tray.png')
save(False, 32, 'tray@2x.png')
save(True, 22, 'trayTemplate.png')
save(True, 44, 'trayTemplate@2x.png')
os.makedirs(os.path.join(OUT, 'gauge'), exist_ok=True)
for pct in range(0, 101, 5):
    a = pct_angle(pct)
    save(False, 16, f'gauge/win-{pct:03d}.png', a)
    save(False, 32, f'gauge/win-{pct:03d}@2x.png', a)
    save(True, 22, f'gauge/mac-{pct:03d}.png', a)
    save(True, 44, f'gauge/mac-{pct:03d}@2x.png', a)
    save(False, 32, f'gauge/task-{pct:03d}.png', a)
    save(False, 64, f'gauge/task-{pct:03d}@2x.png', a)
    tile(128, os.path.join(OUT, f'gauge/dock-{pct:03d}.png'), a)
    tile(256, os.path.join(OUT, f'gauge/dock-{pct:03d}@2x.png'), a)
tile(1024, os.path.join(os.path.dirname(__file__), 'icon.png'))
print('wrote tray icons to', os.path.abspath(OUT))
