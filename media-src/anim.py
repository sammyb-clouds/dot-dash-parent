"""The hero photograph, animated: a message playing out as Morse.

Timing and drawing are both lifted from the firmware's STATE_PLAY_MORSE, not
invented -- dot 100ms, dash 300ms, 100ms between marks, 300ms between letters,
LED HIGH on the same line as tone().  Every event lands on a 100ms boundary,
so a 10fps grid loses nothing.
"""
import os, re, sys, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import png

# ------------------------------------------------------------------ firmware
# Read the code table out of the firmware rather than retyping it, so the GIF
# plays exactly what encodeMorse() would: MORSE_ALPHA, MORSE_NUM and the
# MORSE_PUNCT pairs in Helpers.ino.  A character the firmware cannot encode
# is refused, not guessed.
_FW = os.path.expanduser('~/Documents/Arduino/Dot Dash/dot_dash_7_3/Helpers.ino')
_hs = open(_FW).read()
def _codes(name):
    body = _hs[_hs.index(name):]
    body = body[body.index('{')+1:body.index('};')]
    return re.findall(r'"([.-]+)"', body)
MORSE = dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", _codes('MORSE_ALPHA[26]')))
MORSE.update(zip("0123456789", _codes('MORSE_NUM[10]')))
_pb = _hs[_hs.index('MORSE_PUNCT[] = {'):]
_pb = _pb[:_pb.index('};')]
for c, m in re.findall(r"\{'(\\?.)',\s*\"([.-]+)\"\}", _pb):
    MORSE[c.replace('\\', '')] = m
assert len(MORSE) == 26 + 10 + 17 and MORSE['A'] == '.-' and MORSE['!'] == '-.-.--', MORSE
DOT_MS, DASH_MS, GAP_MS, LETTER_MS = 100, 300, 100, 300

def timeline(text):
    """(t_ms, shown_symbols, revealed_text, led) at every state change.

    Mirrors STATE_PLAY_MORSE: a mark shows as its tone starts, the letter lands
    100ms after its last mark, then 300ms before the next; a space lands at
    once and waits 700ms."""
    out, t = [], 0
    for i, ch in enumerate(text):
        if ch == ' ':
            out.append((t, "", text[:i+1], False))
            t += 700
            continue
        if ch not in MORSE:
            raise SystemExit("firmware has no Morse for %r -- encodeMorse() "
                             "returns \"\" and the device would skip it" % ch)
        sym = MORSE[ch]
        for k, s in enumerate(sym):
            out.append((t, sym[:k+1], text[:i], True))
            t += DOT_MS if s == '.' else DASH_MS
            out.append((t, sym[:k+1], text[:i], False))
            t += GAP_MS
        out.append((t, "", text[:i+1], False))      # letter lands, strip clears
        t += LETTER_MS
    out.append((t, "", text, False))
    return out, t

# ------------------------------------------------------- the device's screen
_src = open(os.path.expanduser(
    '~/Documents/Arduino/libraries/Adafruit_GFX_Library/glcdfont.c')).read()
FONT = [int(v, 16) for v in re.findall(r'0[xX]([0-9a-fA-F]{2})',
        _src[_src.index('{', _src.index('font[]')):])]
SW, SH, INSET = 128, 32, 2

def blit(grid, text, size, cx, cy):
    for k, ch in enumerate(text):
        o = ord(ch) * 5
        for col in range(5):
            bits = FONT[o + col]
            for row in range(8):
                if (bits >> row) & 1:
                    for dy in range(size):
                        for dx in range(size):
                            x, y = cx + (k*6+col)*size + dx, cy + row*size + dy
                            if 0 <= x < SW and 0 <= y < SH: grid[y][x] = 1

def marks(grid, seq, ox, oy):
    """drawMorseSymbols(): dot = fillCircle(sx+2, oy, 2), dash = fillRect(sx, oy-1, 9, 3)."""
    sx = ox
    for s in seq:
        dot = (s == '.')
        if sx + (5 if dot else 9) > SW: break
        if dot:
            # Adafruit fillCircle(r=2) rasterises to this exact 5x5:
            #   .###.  /  #####  /  #####  /  #####  /  .###.
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    if abs(dx) > 1 and abs(dy) > 1: continue
                    x, y = sx+2+dx, oy+dy
                    if 0 <= x < SW and 0 <= y < SH: grid[y][x] = 1
        else:
            for dy in range(3):
                for dx in range(9):
                    x, y = sx+dx, oy-1+dy
                    if 0 <= x < SW and 0 <= y < SH: grid[y][x] = 1
        sx += 8 if dot else 13

def screen(seq, revealed, sender):
    g = [[0]*SW for _ in range(SH)]
    blit(g, sender, 1, INSET, INSET)
    marks(g, seq, 62 + INSET, 4 + INSET)
    blit(g, revealed, 2, INSET, 16 + INSET)
    return g
