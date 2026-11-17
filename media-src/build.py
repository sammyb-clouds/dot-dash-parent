import os, sys, math, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import png, anim, gifout

T0 = time.time()
def say(*a): print("[%5.1fs]" % (time.time()-T0), *a, flush=True)

# One device, the hero photograph:
#   python3 build.py [SENDER] [HOLD_CS] [WORD] [OUT] [BASE]
#   device.gif:  python3 build.py "DOT DASH" 180 HELLO ../site/media/device.gif
#   drop.gif:    python3 build.py "DOT DASH" 180 'DROP!' ../site/media/drop.gif
#
# Several devices in one photograph, playing one after the other:
#   python3 build.py --scene NAME SENDER HOLD_CS WORD,WORD,... OUT [BASE]
#   buy-us.gif:  python3 build.py --scene pair "DOT DASH" 180 BUY,US ../site/media/buy-us.gif
# NAME is a key of scenes.SCENES; one word per device, left to right in the
# order the scene lists them.
A = sys.argv[1:]
SCENE = None
if A[:1] == ['--scene']:
    import scenes
    SCENE = scenes.SCENES[A[1]]
    A = A[2:]
SENDER  = A[0] if len(A) > 0 else 'SAM'
HOLD_CS = int(A[1]) if len(A) > 1 else 180                   # end hold, 1/100s
WORDS   = (A[2] if len(A) > 2 else 'HELLO').split(',') if SCENE else \
          [A[2] if len(A) > 2 else 'HELLO']
OUT     = A[3] if len(A) > 3 else os.path.join(HERE, 'hero.gif')
SRC     = A[4] if len(A) > 4 else os.path.join(HERE, 'base960.png' if not SCENE
                                               else 'base-%s.png' % sys.argv[2])
if SCENE and len(WORDS) != len(SCENE['devices']):
    sys.exit("%d words for %d devices" % (len(WORDS), len(SCENE['devices'])))
# The firmware right-anchors (scrolls) a big line wider than the screen; this
# template draws it flush left from INSET, so refuse rather than misdraw.
for WORD in WORDS:
    if anim.INSET + len(WORD)*12 - 2 > anim.SW: # last glyph column ends 2 short of its 12
        sys.exit("%r is %d px at size 2 -- wider than the screen" % (WORD, len(WORD)*12))

w, h, nch, buf, stride = png.load(SRC)
FL, FW_, FT, FH = 0.0208, 0.9315, 0.0292, 0.6696   # active area / window, clip-1

def corner(fx, fy, y0):
    y = y0
    for _ in range(4): x = fx(y); y = fy(x)
    return (x, y)

class Device:
    """One screen and one LED in the base image.

    TL..BR are the window's corners in base-image pixels; the active area is
    the same fraction of that window for every enclosure (see README)."""
    def __init__(self, TL, TR, BL, BR, led, word):
        self.word = word
        def Wq(s, t):
            return ((1-s)*(1-t)*TL[0] + s*(1-t)*TR[0] + (1-s)*t*BL[0] + s*t*BR[0],
                    (1-s)*(1-t)*TL[1] + s*(1-t)*TR[1] + (1-s)*t*BL[1] + s*t*BR[1])
        aTL, aTR, aBL = Wq(FL, FT), Wq(FL+FW_, FT), Wq(FL, FT+FH)
        self.aTL = aTL
        self.ex = ((aTR[0]-aTL[0])/anim.SW, (aTR[1]-aTL[1])/anim.SW)
        self.ey = ((aBL[0]-aTL[0])/anim.SH, (aBL[1]-aTL[1])/anim.SH)
        self.det = self.ex[0]*self.ey[1] - self.ex[1]*self.ey[0]
        say("one device pixel = %.2f px" % abs(self.ex[0]))
        self.SB = (int(min(TL[0],BL[0]))-4, int(min(TL[1],TR[1]))-4,
                   int(max(TR[0],BR[0]))+5, int(max(BL[1],BR[1]))+5)
        self.led = led
        # the rectangle that can ever change for this device
        self.R = (min(self.SB[0], led.B[0]), min(self.SB[1], led.B[1]),
                  max(self.SB[2], led.B[2]), max(self.SB[3], led.B[3]))

class Led:
    """A dome of x-radius LR (y-radius LR/k) centred on (LCX, LCY), cut off
    below the row CLIP, glowing out to GLOW."""
    def __init__(self, LCX, LCY, LR, CLIP, LIT, CORE, SPILL, k=1.0):
        self.LCX, self.LCY, self.LR, self.CLIP, self.k = LCX, LCY, LR, CLIP, k
        self.LIT, self.CORE, self.SPILL = LIT, CORE, SPILL
        GLOW = self.GLOW = LR * 3.1
        LBX0, LBY0 = int(LCX-GLOW)-1, int(LCY-GLOW)-1
        LBX1, LBY1 = int(LCX+GLOW)+2, int(LCY+GLOW*0.75)+2
        self.B = (max(0,LBX0), max(0,LBY0), min(w,LBX1), min(h,LBY1))
    def px(self, x, y, r, g, b):
        LCX, LCY, LR, GLOW, LIT, CORE = self.LCX, self.LCY, self.LR, self.GLOW, self.LIT, self.CORE
        dx, dy = x-LCX, y-LCY
        d = math.hypot(dx, dy)
        if d > GLOW: return r, g, b
        dd = math.hypot(dx, dy*self.k)                         # == d for a round dome
        if dd <= LR and y < self.CLIP:                         # inside the dome
            f = 1 - (dd/LR)**2
            a = 0.62 + 0.33*f
            r = r + (LIT[0]-r)*a; g = g + (LIT[1]-g)*a; b = b + (LIT[2]-b)*a
            c = max(0.0, 1 - (dd/(LR*0.62))**2) * 0.75
            r = r + (CORE[0]-r)*c; g = g + (CORE[1]-g)*c; b = b + (CORE[2]-b)*c
            return r, g, b
        t = max(0.0, 1 - (d-LR)/(GLOW-LR)) ** 2.3              # spill onto the case
        a = t * 0.42
        sr, sg, sb = self.SPILL
        return r + (LIT[0]-r)*a*sr, g + (LIT[1]-g)*a*sg, b + (LIT[2]-b)*a*sb

if not SCENE:
    # ---- the hero: screen geometry, the same fits screen.py uses, scaled ---
    W0 = 1600.0
    K = w / W0
    say("base %dx%d  scale %.4f" % (w, h, K))
    def L_top(x):   return ( 545.59 - 0.01152 * (x/K)) * K
    def L_bot(x):   return ( 676.01 - 0.00813 * (x/K)) * K
    def L_left(y):  return ( 854.48 - 0.00016 * (y/K)) * K
    def L_right(y): return (1241.35 - 0.00262 * (y/K)) * K
    TL = corner(L_left, L_top, 536*K); TR = corner(L_right, L_top, 531*K)
    BL = corner(L_left, L_bot, 669*K); BR = corner(L_right, L_bot, 666*K)
    LCX, LCY, LR = 783*K, 161*K, 37*K      # dome, measured off the photograph
    # The 0.75 and 0.80 are the green LED's own spill weights, kept as the
    # literal multipliers they always were so device.gif rebuilds byte-exact.
    led = Led(LCX, LCY, LR, LCY + LR*0.42, (150, 255, 170), (235, 255, 240),
              (0.75, 1, 0.80))
    DEVS = [Device(TL, TR, BL, BR, led, WORDS[0])]
else:
    # ---- a scene: measured in the original photograph, mapped to the base --
    cx0, cy0, cw, ch = SCENE['crop']
    K = w / float(cw)
    say("base %dx%d  scale %.4f from %s" % (w, h, K, SCENE['photo']))
    if abs(h - ch*K) > 1.5:
        sys.exit("base is %dx%d; the scene's crop at that width is %.0f tall -- "
                 "wrong base?" % (w, h, ch*K))
    # pixel centres to pixel centres through the crop and the resample.  A
    # re-fit of the windows on base-pair.png lands within 0.4 px of this.
    def P(x, y): return ((x-cx0+0.5)*K-0.5, (y-cy0+0.5)*K-0.5)
    DEVS = []
    for dv, word in zip(SCENE['devices'], WORDS):
        wn = dv['win']
        top  = lambda x, a=wn['top']:   a[0] + a[1]*x
        bot  = lambda x, a=wn['bot']:   a[0] + a[1]*x
        left = lambda y, a=wn['left']:  a[0] + a[1]*y
        rght = lambda y, a=wn['right']: a[0] + a[1]*y
        yt, yb = top(left(0)), bot(left(0))
        c = [P(*corner(left, top, yt)), P(*corner(rght, top, yt)),
             P(*corner(left, bot, yb)), P(*corner(rght, bot, yb))]
        l = dv['led']
        cx, cy = P(l['cx'], l['cy'])
        led = Led(cx, cy, l['rx']*K, P(0, l['base'])[1], l['lit'], l['core'],
                  l['spill'], k=l['rx']/l['ry'])
        DEVS.append(Device(c[0], c[1], c[2], c[3], led, word))

# ---- the screen ------------------------------------------------------------
WHITE = (246, 252, 254)
SS = 4
def screen_rgb(dev, grid, out, ox, oy, ow, oh):
    """Paint the lit marks into `out` (a bytearray of ow*oh*3) with bloom."""
    aTL, ex, ey, det = dev.aTL, dev.ex, dev.ey, dev.det
    cov = [[0.0]*ow for _ in range(oh)]
    inv = 1.0/(SS*SS)
    for py in range(oh):
        for px in range(ow):
            hit = 0
            for sy in range(SS):
                for sx in range(SS):
                    dx = ox+px+(sx+0.5)/SS - aTL[0]
                    dy = oy+py+(sy+0.5)/SS - aTL[1]
                    u = ( dx*ey[1] - dy*ey[0]) / det
                    v = (-dx*ex[1] + dy*ex[0]) / det
                    if 0 <= u < anim.SW and 0 <= v < anim.SH and grid[int(v)][int(u)]:
                        hit += 1
            if hit: cov[py][px] = hit*inv
    def bb(src, r):
        t=[[0.0]*ow for _ in range(oh)]; o=[[0.0]*ow for _ in range(oh)]
        for y in range(oh):
            row=src[y]
            for x in range(ow):
                a,b2=max(0,x-r),min(ow,x+r+1); t[y][x]=sum(row[a:b2])/(b2-a)
        for x in range(ow):
            col=[t[y][x] for y in range(oh)]
            for y in range(oh):
                a,b2=max(0,y-r),min(oh,y+r+1); o[y][x]=sum(col[a:b2])/(b2-a)
        return o
    g1 = bb(bb(cov,1),1); g2 = bb(bb(cov,3),3)
    for py in range(oh):
        for px in range(ow):
            a = cov[py][px]
            tot = a + (1-a)*(g1[py][px]*0.55 + g2[py][px]*0.30)
            if tot <= 0.003: continue
            tot = min(1.0, tot); i = (py*ow+px)*3
            for c in range(3):
                out[i+c] = int(round(out[i+c] + (WHITE[c]-out[i+c])*tot))

def crop(x0, y0, cw, ch):
    o = bytearray(cw*ch*3)
    for y in range(ch):
        s = (y0+y)*stride + x0*nch
        o[y*cw*3:(y+1)*cw*3] = buf[s:s+cw*3]
    return o

def box(B): return B[0], B[1], B[2]-B[0], B[3]-B[1]

# ---- states ----------------------------------------------------------------
# One state = (one screen per device, the device whose LED is lit or None,
# delay).  A screen is (marks, revealed) or None for a screen not yet used --
# left exactly as the photograph has it, switched off.  Devices play in turn;
# the one before keeps its word.  Between them, the hand-off is what the
# firmware waits between the words of a message: the 300ms letter gap that
# ends every word, then the 700ms a space waits (anim.timeline), so "BUY" on
# one device and "US" on the next keep the rhythm of "BUY US" on one.
HANDOFF_CS = 70
N = len(DEVS)
states = []
for d, dev in enumerate(DEVS):
    tl, total = anim.timeline(dev.word)
    for i, (t, seq, rev, ledon) in enumerate(tl):
        nt = tl[i+1][0] if i+1 < len(tl) else total
        if nt > t:
            scr = [("", DEVS[j].word) if j < d else (seq, rev) if j == d else None
                   for j in range(N)]
            states.append((scr, d if ledon else None, (nt-t)//10))
    states[-1] = (states[-1][0], states[-1][1],
                  states[-1][2] + (HOLD_CS if d == N-1 else HANDOFF_CS))
say("%d frames, %.2fs loop" % (len(states), sum(s[2] for s in states)/100))

# ---- palette ---------------------------------------------------------------
say("palette...")
samp = []
for y in range(0, h, 3):
    for x in range(0, w, 3):
        i = y*stride + x*nch; samp.append((buf[i], buf[i+1], buf[i+2]))
for dev in DEVS:
    SBX0, SBY0, SBW, SBH = box(dev.SB)
    lit = crop(SBX0, SBY0, SBW, SBH)
    # A representative lit screen for the palette: the second-to-last letter's
    # full marks over everything before the last letter (for HELLO, '.-..' / HELL).
    WORD = dev.word
    _pc = WORD[-2] if len(WORD) > 1 and WORD[-2] in anim.MORSE else WORD[-1]
    screen_rgb(dev, anim.screen(anim.MORSE.get(_pc, ''), WORD[:-1], SENDER), lit, SBX0, SBY0, SBW, SBH)
    for p in range(0, SBW*SBH, 2):
        samp.append((lit[p*3], lit[p*3+1], lit[p*3+2]))
for dev in DEVS:
    LBX0, LBY0, LBW, LBH = box(dev.led.B)
    ledc = crop(LBX0, LBY0, LBW, LBH)
    if SCENE:
        # The hero's dome is big enough that the every-third-pixel sample of
        # the base keeps its colour.  A scene's domes are a few hundred pixels
        # each, and the unlit green one came out grey; sample the unlit LED
        # boxes in full so an LED that is off looks as it does in the photo.
        # (Not done for the hero, so device.gif still rebuilds byte-exact.)
        for p in range(LBW*LBH):
            samp.append((ledc[p*3], ledc[p*3+1], ledc[p*3+2]))
    for y in range(LBH):
        for x in range(LBW):
            i = (y*LBW+x)*3
            r,g,b = dev.led.px(LBX0+x, LBY0+y, ledc[i], ledc[i+1], ledc[i+2])
            samp.append((int(r), int(g), int(b)))
pal = gifout.median_cut(samp, 255)
pal = pal[:255] + [(255, 0, 255)]            # 255 = transparent
TRANSP = len(pal) - 1
say("palette %d colours" % len(pal))
lut = gifout.build_lut(pal)
say("lut built")

def index(rgb, n):
    o = bytearray(n)
    for p in range(n):
        i = p*3
        o[p] = lut[((rgb[i]>>3)<<10) | ((rgb[i+1]>>3)<<5) | (rgb[i+2]>>3)]
    return o

# ---- frame 0: the whole picture -------------------------------------------
full = bytearray(w*h*3)
for y in range(h):
    s = y*stride; full[y*w*3:(y+1)*w*3] = buf[s:s+w*3]
base_idx = index(full, w*h)
say("base indexed")

gif = gifout.Gif(w, h, pal, TRANSP)

def compose(dev, scr, led):
    """indices for one device's two live rectangles in one state"""
    SBX0, SBY0, SBW, SBH = box(dev.SB)
    s = crop(SBX0, SBY0, SBW, SBH)
    if scr is not None:
        screen_rgb(dev, anim.screen(scr[0], scr[1], SENDER), s, SBX0, SBY0, SBW, SBH)
    si = index(s, SBW*SBH)
    LBX0, LBY0, LBW, LBH = box(dev.led.B)
    l = crop(LBX0, LBY0, LBW, LBH)
    if led:
        for y in range(LBH):
            for x in range(LBW):
                i = (y*LBW+x)*3
                r,g,b = dev.led.px(LBX0+x, LBY0+y, l[i], l[i+1], l[i+2])
                l[i], l[i+1], l[i+2] = int(r), int(g), int(b)
    li = index(l, LBW*LBH)
    return si, li

cur = bytearray(base_idx)
def paste(dst, src, x0, y0, cw, ch):
    for y in range(ch):
        dst[(y0+y)*w + x0:(y0+y)*w + x0 + cw] = src[y*cw:(y+1)*cw]

memo = {}
first = True
for n, (scr, ledi, delay) in enumerate(states):
    nxt = bytearray(cur)
    for d, dev in enumerate(DEVS):
        key = (d, scr[d], ledi == d)
        if key not in memo:
            memo[key] = compose(dev, scr[d], ledi == d)
        si, li = memo[key]
        paste(nxt, si, *box(dev.SB))
        paste(nxt, li, *box(dev.led.B))
    if first:
        gif.frame(0, 0, w, h, nxt, delay, transparent=False)
        first = False
    else:
        x0, y0, x1, y1 = w, h, -1, -1
        for dev in DEVS:
            RX0, RY0, RX1, RY1 = dev.R
            for y in range(RY0, RY1):
                row = y*w
                for x in range(RX0, RX1):
                    if nxt[row+x] != cur[row+x]:
                        if x < x0: x0 = x
                        if x > x1: x1 = x
                        if y < y0: y0 = y
                        if y > y1: y1 = y
        if x1 < 0:
            x0, y0, x1, y1 = DEVS[0].SB[0], DEVS[0].SB[1], DEVS[0].SB[0]+1, DEVS[0].SB[1]+1
        bw, bh = x1-x0+1, y1-y0+1
        sub = bytearray(bw*bh)
        for y in range(bh):
            rs = (y0+y)*w
            for x in range(bw):
                v = nxt[rs+x0+x]
                sub[y*bw+x] = v if v != cur[rs+x0+x] else TRANSP
        gif.frame(x0, y0, bw, bh, sub, delay)
    cur = nxt
    say("frame %2d/%d  %s  led=%s  %dcs" % (n+1, len(states),
        "  ".join("%-4s %-5s" % (s[0] or '-', s[1] or '-') if s else "(off)     "
                  for s in scr), '-' if ledi is None else ledi, delay))

size = gif.done(OUT)
say("wrote %s  %.0f KB" % (OUT, size/1024))
