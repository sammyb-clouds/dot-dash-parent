#!/usr/bin/env python3
"""Light the screen in the home page hero photograph.

    python3 screen.py big.png lit.png

The device in hero-device-original.jpg is switched OFF, so neither the type nor
the lit rectangle could be drawn by eye.  Both are measured; see README.md for
the numbers and the check that they are right.  Stdlib only -- there is no PIL
on the machine this was written on.
"""
import os, re, sys, zlib, struct

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- PNG in/out
def load_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n', path + ' is not a PNG'
    i, idat = 8, b''
    while i < len(d):
        ln = struct.unpack('>I', d[i:i+4])[0]
        typ, data = d[i+4:i+8], d[i+8:i+8+ln]; i += 12 + ln
        if   typ == b'IHDR': w, h, bd, ct, _, _, il = struct.unpack('>IIBBBBB', data)
        elif typ == b'IDAT': idat += data
        elif typ == b'IEND': break
    assert bd == 8 and il == 0, 'need an 8-bit non-interlaced PNG'
    raw = zlib.decompress(idat)
    nch = {0: 1, 2: 3, 4: 2, 6: 4}[ct]
    stride = w * nch
    out = bytearray(h * stride); prev = bytearray(stride); p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p+stride]); p += stride
        if f == 1:
            for x in range(nch, stride): line[x] = (line[x] + line[x-nch]) & 255
        elif f == 2:
            for x in range(stride): line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x-nch] if x >= nch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x-nch] if x >= nch else 0
                c = prev[x-nch] if x >= nch else 0
                b = prev[x]
                pa, pb, pc = abs(b-c), abs(a-c), abs(a+b-2*c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out[y*stride:(y+1)*stride] = line; prev = line
    return w, h, nch, out, stride

def save_png(path, w, h, data, stride, nch):
    raw = bytearray()
    for y in range(h):
        raw.append(0); raw += data[y*stride:y*stride + w*nch]
    def ck(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t+d) & 0xffffffff)
    open(path, 'wb').write(
        b'\x89PNG\r\n\x1a\n'
        + ck(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2 if nch == 3 else 6, 0, 0, 0))
        + ck(b'IDAT', zlib.compress(bytes(raw), 6)) + ck(b'IEND', b''))

# ------------------------------------------------- the firmware's own glyphs
# dot_dash_7_3 never calls setFont(), so every string on the device is drawn
# with the Adafruit GFX built-in 5x7.  Read it, don't imitate it.
GLCD = [os.path.expanduser(p) for p in (
    '~/Documents/Arduino/libraries/Adafruit_GFX_Library/glcdfont.c',
    '~/Arduino/libraries/Adafruit_GFX_Library/glcdfont.c')]
def font_table():
    for p in GLCD:
        if os.path.exists(p):
            src = open(p).read()
            body = src[src.index('{', src.index('font[]')):]
            return [int(v, 16) for v in re.findall(r'0[xX]([0-9a-fA-F]{2})', body)]
    sys.exit('glcdfont.c not found; looked in:\n  ' + '\n  '.join(GLCD))

SW, SH = 128, 32                       # the SSD1306 the device carries

# A message as the device lays one out: the sender on the header row at
# setTextSize(1) -- drawMenuFrame() -- and the body under it at setTextSize(2),
# 16 rows lower -- drawMenuOption().  Both flush left; nothing here is centred,
# because the firmware does not centre them.
#
# INSET is the one deliberate departure.  The firmware puts both cursors hard
# against x=0 and the header against y=0, which on the real screen is fine and
# in a still photograph reads as type jammed into the corner.  Two device
# pixels down and right is about a CSS pixel each way at the size the hero is
# shown -- enough to breathe, small enough that it is still a cursor position
# the firmware could set.  HELLO then ends on row 31, the last row there is.
INSET = 2
MESSAGE = [("DOT DASH", 1, INSET, INSET), ("HELLO", 2, INSET, 16 + INSET)]

def render(lines, font):
    """A 128x32 grid, drawn the way Adafruit GFX draws: 6*size pitch, cursor
    at the glyph's top-left, glyph 5 wide and 7 tall inside that cell."""
    grid = [[0]*SW for _ in range(SH)]
    for text, size, cx, cy in lines:
        for k, ch in enumerate(text):
            o = ord(ch) * 5
            for col in range(5):
                bits = font[o + col]
                for row in range(8):
                    if (bits >> row) & 1:
                        x0, y0 = cx + (k*6 + col)*size, cy + row*size
                        for dy in range(size):
                            for dx in range(size):
                                if 0 <= y0+dy < SH and 0 <= x0+dx < SW:
                                    grid[y0+dy][x0+dx] = 1
    return grid

# --------------------------------------------- where the screen is, and the
#                                                lit area inside it
# Window edges, least-squares fits to subpixel crossings in big.png
# (max residual 0.72 px).  Remeasure these if the crop ever changes.
def L_top(x):   return  545.59 - 0.01152 * x
def L_bot(x):   return  676.01 - 0.00813 * x
def L_left(y):  return  854.48 - 0.00016 * y
def L_right(y): return 1241.35 - 0.00262 * y

# Active area as a fraction of that window, measured off site/media/clip-1.jpg
# where the same screen is photographed LIT.  An OLED's active area is smaller
# than the window cut for it, is not centred in it, and sits hard against the
# top; these four numbers are the whole reason the type is the size it is.
# The window edges in clip-1 are black-on-black, so they were found by local
# TEXTURE (the enclosure is speckled, the glass is smooth), not by brightness.
FRAC_LEFT, FRAC_W = 0.0208, 0.9315
FRAC_TOP,  FRAC_H = 0.0292, 0.6696

WHITE = (246, 252, 254)                # sampled off the lit pixels in clip-1
BLOOM_TIGHT, BLOOM_WIDE = 0.55, 0.30

def corner(fx, fy, y0):
    y = y0
    for _ in range(4):
        x = fx(y); y = fy(x)
    return (x, y)

def boxblur(src, w, h, r):
    tmp = [[0.0]*w for _ in range(h)]; out = [[0.0]*w for _ in range(h)]
    for y in range(h):
        row = src[y]
        for x in range(w):
            a, b = max(0, x-r), min(w, x+r+1)
            tmp[y][x] = sum(row[a:b]) / (b-a)
    for x in range(w):
        col = [tmp[y][x] for y in range(h)]
        for y in range(h):
            a, b = max(0, y-r), min(h, y+r+1)
            out[y][x] = sum(col[a:b]) / (b-a)
    return out

def main(src, dst, lines=MESSAGE):
    font = font_table()
    grid = render(lines, font)
    for t, sz, cx, cy in lines:
        print("%-10r setTextSize(%d) cursor (%d,%d)" % (t, sz, cx, cy))

    TL = corner(L_left,  L_top, 536); TR = corner(L_right, L_top, 531)
    BL = corner(L_left,  L_bot, 669); BR = corner(L_right, L_bot, 666)
    s0, s1 = FRAC_LEFT, FRAC_LEFT + FRAC_W
    t0, t1 = FRAC_TOP,  FRAC_TOP  + FRAC_H
    def Wq(s, t):
        return ((1-s)*(1-t)*TL[0] + s*(1-t)*TR[0] + (1-s)*t*BL[0] + s*t*BR[0],
                (1-s)*(1-t)*TL[1] + s*(1-t)*TR[1] + (1-s)*t*BL[1] + s*t*BR[1])
    aTL, aTR, aBL = Wq(s0, t0), Wq(s1, t0), Wq(s0, t1)
    ex = ((aTR[0]-aTL[0])/SW, (aTR[1]-aTL[1])/SW)   # one device pixel, across
    ey = ((aBL[0]-aTL[0])/SH, (aBL[1]-aTL[1])/SH)   # one device pixel, down
    det = ex[0]*ey[1] - ex[1]*ey[0]
    print("active area %.1f x %.1f px -> %.3f px per device pixel"
          % (abs(ex[0])*SW, abs(ey[1])*SH, abs(ex[0])))

    w, h, nch, buf, stride = load_png(src)
    cor = [aTL, aTR, aBL, (aTL[0]+ex[0]*SW+ey[0]*SH, aTL[1]+ex[1]*SW+ey[1]*SH)]
    M = 14                                          # room for the bloom
    BX0, BY0 = int(min(c[0] for c in cor)) - M, int(min(c[1] for c in cor)) - M
    BX1, BY1 = int(max(c[0] for c in cor)) + M + 1, int(max(c[1] for c in cor)) + M + 1
    BW, BH = BX1-BX0, BY1-BY0

    SS = 3
    cov = [[0.0]*BW for _ in range(BH)]
    for py in range(BH):
        for px in range(BW):
            hit = 0
            for sy in range(SS):
                for sx in range(SS):
                    dx = BX0+px + (sx+0.5)/SS - aTL[0]
                    dy = BY0+py + (sy+0.5)/SS - aTL[1]
                    u = ( dx*ey[1] - dy*ey[0]) / det
                    v = (-dx*ex[1] + dy*ex[0]) / det
                    if 0 <= u < SW and 0 <= v < SH and grid[int(v)][int(u)]:
                        hit += 1
            if hit: cov[py][px] = hit / (SS*SS)
    g1 = boxblur(boxblur(cov, BW, BH, 1), BW, BH, 1)
    g2 = boxblur(boxblur(cov, BW, BH, 4), BW, BH, 4)

    out = bytearray(buf)
    for py in range(BH):
        y = BY0 + py
        if not (0 <= y < h): continue
        for px in range(BW):
            x = BX0 + px
            if not (0 <= x < w): continue
            a = cov[py][px]
            tot = a + (1-a) * (g1[py][px]*BLOOM_TIGHT + g2[py][px]*BLOOM_WIDE)
            if tot <= 0.002: continue
            tot = min(1.0, tot)
            i = y*stride + x*nch
            for c in range(3):
                out[i+c] = int(round(buf[i+c] + (WHITE[c]-buf[i+c])*tot))
    save_png(dst, w, h, out, stride, nch)
    print("wrote", dst)

if __name__ == '__main__':
    a = sys.argv[1:]
    main(a[0] if a else os.path.join(HERE, 'big.png'),
         a[1] if len(a) > 1 else os.path.join(HERE, 'lit.png'))
