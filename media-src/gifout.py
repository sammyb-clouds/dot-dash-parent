"""A GIF89a writer with inter-frame deltas. Stdlib only (no PIL here)."""
import struct

# ------------------------------------------------------------------- palette
def median_cut(samples, n):
    """samples: list of (r,g,b). Returns up to n representative colours."""
    boxes = [samples]
    while len(boxes) < n:
        boxes.sort(key=lambda b: (0 if len(b) < 2 else
            max(max(c[i] for c in b) - min(c[i] for c in b) for i in range(3)) * len(b)**0.25))
        big = boxes.pop()
        if len(big) < 2: boxes.append(big); break
        ch = max(range(3), key=lambda i: max(c[i] for c in big) - min(c[i] for c in big))
        big.sort(key=lambda c: c[ch])
        m = len(big)//2
        boxes += [big[:m], big[m:]]
    out = []
    for b in boxes:
        if not b: continue
        out.append(tuple(sum(c[i] for c in b)//len(b) for i in range(3)))
    return out

def build_lut(pal):
    """5-bit-per-channel nearest-colour table, so indexing a frame is a lookup."""
    lut = bytearray(32768)
    for r5 in range(32):
        r = r5*8+4
        for g5 in range(32):
            g = g5*8+4
            base = (r5<<10)|(g5<<5)
            for b5 in range(32):
                b = b5*8+4
                best, bd = 0, 1<<30
                for i, (pr,pg,pb) in enumerate(pal):
                    d = (pr-r)*(pr-r)*2 + (pg-g)*(pg-g)*4 + (pb-b)*(pb-b)
                    if d < bd: bd, best = d, i
                lut[base|b5] = best
    return lut

# ----------------------------------------------------------------------- LZW
class Bits:
    def __init__(self): self.buf = bytearray(); self.cur = 0; self.n = 0
    def put(self, code, size):
        self.cur |= code << self.n; self.n += size
        while self.n >= 8:
            self.buf.append(self.cur & 0xff); self.cur >>= 8; self.n -= 8
    def done(self):
        if self.n: self.buf.append(self.cur & 0xff)
        return bytes(self.buf)

def lzw(data, mcs=8):
    """Matches compress(1)/giflib: write the code at the CURRENT size, then
    widen if the next table slot no longer fits.  Widening one code early --
    the obvious-looking `if nxt == 1<<size` after the insert -- desynchronises
    the decoder at code 255 and the image comes out blank."""
    clear, eoi = 1 << mcs, (1 << mcs) + 1
    out = Bits()
    size = mcs + 1
    table = {bytes([i]): i for i in range(clear)}
    nxt = eoi + 1
    def emit(code):
        nonlocal size
        out.put(code, size)
        if nxt > (1 << size) - 1 and size < 12:
            size += 1
    out.put(clear, size)
    pre = b''
    for px in data:
        cur = pre + bytes([px])
        if cur in table:
            pre = cur
            continue
        emit(table[pre])
        pre = bytes([px])
        if nxt < 4096:
            table[cur] = nxt
            nxt += 1
        else:
            out.put(clear, size)
            table = {bytes([i]): i for i in range(clear)}
            size = mcs + 1
            nxt = eoi + 1
    if pre:
        emit(table[pre])
    out.put(eoi, size)
    return out.done()

def blocks(data):
    o = bytearray()
    for i in range(0, len(data), 255):
        c = data[i:i+255]; o.append(len(c)); o += c
    o.append(0)
    return bytes(o)

# ----------------------------------------------------------------------- GIF
class Gif:
    def __init__(self, w, h, pal, transparent):
        self.w, self.h, self.t = w, h, transparent
        n = 1
        while (1 << n) < len(pal): n += 1
        self.out = bytearray(b'GIF89a')
        self.out += struct.pack('<HHBBB', w, h, 0xF0 | (n-1), 0, 0)
        for i in range(1 << n):
            self.out += bytes(pal[i] if i < len(pal) else (0,0,0))
        self.out += b'\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00'
    def frame(self, x, y, w, h, idx, delay_cs, transparent=True):
        self.out += b'\x21\xF9\x04' + bytes([0x04 | (0x01 if transparent else 0)])
        self.out += struct.pack('<HB', delay_cs, self.t if transparent else 0) + b'\x00'
        self.out += b'\x2C' + struct.pack('<HHHHB', x, y, w, h, 0)
        self.out += b'\x08' + blocks(lzw(idx, 8))
    def done(self, path):
        self.out += b'\x3B'
        open(path, 'wb').write(bytes(self.out))
        return len(self.out)
