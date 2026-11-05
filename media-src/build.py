import os, sys, math, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import png, anim, gifout

T0 = time.time()
def say(*a): print("[%5.1fs]" % (time.time()-T0), *a, flush=True)

SRC   = os.path.join(HERE, 'base960.png')
OUT   = os.path.join(HERE, 'hero.gif')
SENDER = sys.argv[1] if len(sys.argv) > 1 else 'SAM'
HOLD_CS = int(sys.argv[2]) if len(sys.argv) > 2 else 180     # end hold, 1/100s

W0 = 1600.0
w, h, nch, buf, stride = png.load(SRC)
K = w / W0
say("base %dx%d  scale %.4f" % (w, h, K))

# ---- screen geometry, the same fits screen.py uses, scaled -----------------
def L_top(x):   return ( 545.59 - 0.01152 * (x/K)) * K
def L_bot(x):   return ( 676.01 - 0.00813 * (x/K)) * K
def L_left(y):  return ( 854.48 - 0.00016 * (y/K)) * K
def L_right(y): return (1241.35 - 0.00262 * (y/K)) * K
def corner(fx, fy, y0):
    y = y0 * K
    for _ in range(4): x = fx(y); y = fy(x)
    return (x, y)
TL = corner(L_left, L_top, 536); TR = corner(L_right, L_top, 531)
BL = corner(L_left, L_bot, 669); BR = corner(L_right, L_bot, 666)
FL, FW_, FT, FH = 0.0208, 0.9315, 0.0292, 0.6696
def Wq(s, t):
    return ((1-s)*(1-t)*TL[0] + s*(1-t)*TR[0] + (1-s)*t*BL[0] + s*t*BR[0],
            (1-s)*(1-t)*TL[1] + s*(1-t)*TR[1] + (1-s)*t*BL[1] + s*t*BR[1])
aTL, aTR, aBL = Wq(FL, FT), Wq(FL+FW_, FT), Wq(FL, FT+FH)
ex = ((aTR[0]-aTL[0])/anim.SW, (aTR[1]-aTL[1])/anim.SW)
ey = ((aBL[0]-aTL[0])/anim.SH, (aBL[1]-aTL[1])/anim.SH)
det = ex[0]*ey[1] - ex[1]*ey[0]
say("one device pixel = %.2f px" % abs(ex[0]))

SBX0, SBY0 = int(min(TL[0],BL[0]))-4, int(min(TL[1],TR[1]))-4
SBX1, SBY1 = int(max(TR[0],BR[0]))+5, int(max(BL[1],BR[1]))+5
SBW, SBH = SBX1-SBX0, SBY1-SBY0

# ---- the LED ---------------------------------------------------------------
LCX, LCY, LR = 783*K, 161*K, 37*K          # dome, measured off the photograph
GLOW = LR * 3.1
LBX0, LBY0 = int(LCX-GLOW)-1, int(LCY-GLOW)-1
LBX1, LBY1 = int(LCX+GLOW)+2, int(LCY+GLOW*0.75)+2
LBX0, LBY0 = max(0,LBX0), max(0,LBY0); LBX1, LBY1 = min(w,LBX1), min(h,LBY1)
LBW, LBH = LBX1-LBX0, LBY1-LBY0
LIT  = (150, 255, 170)      # the dome, lit
CORE = (235, 255, 240)      # its blown-out centre

def led_px(x, y, r, g, b):
    dx, dy = x-LCX, y-LCY
    d = math.hypot(dx, dy)
    if d > GLOW: return r, g, b
    if d <= LR and y < LCY + LR*0.42:                  # inside the dome
        f = 1 - (d/LR)**2
        a = 0.62 + 0.33*f
        r = r + (LIT[0]-r)*a; g = g + (LIT[1]-g)*a; b = b + (LIT[2]-b)*a
        c = max(0.0, 1 - (d/(LR*0.62))**2) * 0.75
        r = r + (CORE[0]-r)*c; g = g + (CORE[1]-g)*c; b = b + (CORE[2]-b)*c
        return r, g, b
    t = max(0.0, 1 - (d-LR)/(GLOW-LR)) ** 2.3          # spill onto the case
    a = t * 0.42
    return r + (LIT[0]-r)*a*0.75, g + (LIT[1]-g)*a, b + (LIT[2]-b)*a*0.80

# ---- the screen ------------------------------------------------------------
WHITE = (246, 252, 254)
SS = 4
def screen_rgb(grid, out, ox, oy, ow, oh):
    """Paint the lit marks into `out` (a bytearray of ow*oh*3) with bloom."""
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

# ---- states ----------------------------------------------------------------
tl, total = anim.timeline('HELLO')
states = []
for i, (t, seq, rev, led) in enumerate(tl):
    nt = tl[i+1][0] if i+1 < len(tl) else total
    if nt > t: states.append((seq, rev, led, (nt-t)//10))
states[-1] = (states[-1][0], states[-1][1], states[-1][2], states[-1][3] + HOLD_CS)
say("%d frames, %.2fs loop" % (len(states), sum(s[3] for s in states)/100))

# ---- palette ---------------------------------------------------------------
say("palette...")
samp = []
for y in range(0, h, 3):
    for x in range(0, w, 3):
        i = y*stride + x*nch; samp.append((buf[i], buf[i+1], buf[i+2]))
lit = crop(SBX0, SBY0, SBW, SBH)
screen_rgb(anim.screen('.-..', 'HELL', SENDER), lit, SBX0, SBY0, SBW, SBH)
for p in range(0, SBW*SBH, 2):
    samp.append((lit[p*3], lit[p*3+1], lit[p*3+2]))
ledc = crop(LBX0, LBY0, LBW, LBH)
for y in range(LBH):
    for x in range(LBW):
        i = (y*LBW+x)*3
        r,g,b = led_px(LBX0+x, LBY0+y, ledc[i], ledc[i+1], ledc[i+2])
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

def compose(seq, rev, led):
    """indices for the two live rectangles of one state"""
    s = crop(SBX0, SBY0, SBW, SBH)
    screen_rgb(anim.screen(seq, rev, SENDER), s, SBX0, SBY0, SBW, SBH)
    si = index(s, SBW*SBH)
    l = crop(LBX0, LBY0, LBW, LBH)
    if led:
        for y in range(LBH):
            for x in range(LBW):
                i = (y*LBW+x)*3
                r,g,b = led_px(LBX0+x, LBY0+y, l[i], l[i+1], l[i+2])
                l[i], l[i+1], l[i+2] = int(r), int(g), int(b)
    li = index(l, LBW*LBH)
    return si, li

cur = bytearray(base_idx)
def paste(dst, src, x0, y0, cw, ch):
    for y in range(ch):
        dst[(y0+y)*w + x0:(y0+y)*w + x0 + cw] = src[y*cw:(y+1)*cw]

first = True
for n, (seq, rev, led, delay) in enumerate(states):
    si, li = compose(seq, rev, led)
    nxt = bytearray(cur)
    paste(nxt, si, SBX0, SBY0, SBW, SBH)
    paste(nxt, li, LBX0, LBY0, LBW, LBH)
    if first:
        gif.frame(0, 0, w, h, nxt, delay, transparent=False)
        first = False
    else:
        x0, y0, x1, y1 = w, h, -1, -1
        for y in range(min(SBY0,LBY0), max(SBY1,LBY1)):
            row = y*w
            for x in range(min(SBX0,LBX0), max(SBX1,LBX1)):
                if nxt[row+x] != cur[row+x]:
                    if x < x0: x0 = x
                    if x > x1: x1 = x
                    if y < y0: y0 = y
                    if y > y1: y1 = y
        if x1 < 0:
            x0, y0, x1, y1 = SBX0, SBY0, SBX0+1, SBY0+1
        bw, bh = x1-x0+1, y1-y0+1
        sub = bytearray(bw*bh)
        for y in range(bh):
            rs = (y0+y)*w
            for x in range(bw):
                v = nxt[rs+x0+x]
                sub[y*bw+x] = v if v != cur[rs+x0+x] else TRANSP
        gif.frame(x0, y0, bw, bh, sub, delay)
    cur = nxt
    say("frame %2d/%d  %-4s %-5s led=%d  %dcs" % (n+1, len(states), seq or '-', rev or '-', led, delay))

size = gif.done(OUT)
say("wrote %s  %.0f KB" % (OUT, size/1024))
