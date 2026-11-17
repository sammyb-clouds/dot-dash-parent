# Source images, not deployed

The site is published with `scp site/* ...`, so nothing in this folder reaches
the server. It holds the uncropped originals the deployed images were made
from, because the crop and the JPEG step are both lossy and otherwise
unrepeatable.

## hero-device-original.jpg -> site/media/device.jpg

1883 x 1412. The home page hero. Remade with:

```
sips -c 1290 1883 --cropOffset 25 0 hero-device-original.jpg --out crop.jpg
sips -Z 1600 crop.jpg --out big.jpg
sips -s format png big.jpg --out big.png
python3 screen.py big.png lit.png                 # lights the screen
sips -s format jpeg -s formatOptions 45 lit.png --out ../site/media/device.jpg
```

The crop is off-centre on purpose: centred, it leaves about 25 px above the
green button, which reads as clipped. The offset gives it room and takes the
difference off the surface below the device instead.

Only `hero-device-original.jpg` and `screen.py` are kept; `crop`, `big` and
`lit` are intermediates and are not committed.

## screen.py -- why the text is where it is

The device in the photograph is switched off, so both the type and the lit
area had to come from somewhere else. Neither is drawn by eye.

**The glyphs are the firmware's own.** No `setFont()` call exists anywhere in
`dot_dash_7_3`, so every string on the device is the Adafruit GFX built-in
5x7, and the script reads those bitmaps straight out of
`Adafruit_GFX_Library/glcdfont.c` rather than imitating them.

**The layout is the firmware's own too.** A message is a header row at
`setTextSize(1)` -- `drawMenuFrame()` -- over a body at `setTextSize(2)`, 16
rows lower -- `drawMenuOption()`. Both flush left. The hero shows `DOT DASH`
over `HELLO`, which is exactly what `clip-1.jpg` shows.

`INSET` is the one deliberate departure. The firmware puts both cursors hard
against x=0 and the header against y=0; on the real screen that is fine, and
in a still photograph it reads as type jammed into the corner. Two device
pixels down and right is about a CSS pixel each way at the size the hero is
shown -- enough to breathe, and still a cursor position the firmware could
set. HELLO then ends on row 31, the last row there is.

**The lit area was measured off `site/media/clip-1.jpg`,** where the same
screen is photographed ON. This is the part that cannot be guessed: an OLED's
active area is smaller than the window cut for it, is **not centred** in that
window, and sits hard against its top. Filling the black rectangle would make
the type about half again too big and put it in the wrong place.

Finding the window edges in clip-1 is itself awkward -- a black window in a
black enclosure, so brightness gives a +/-2 px edge and the derived type size
swings 5% with it. They are found by local **texture** instead: the enclosure
is speckled (sd about 14), the glass is smooth (sd about 4), and the crossing
is sharp. Everything below follows from that.

| measured from clip-1 | value |
|---|---|
| glyph-stem pitch, HELLO at size 2 | 10.0 px per 12 units -> 0.8333 px/unit across |
| glyph-centre pitch, DOT DASH to HELLO | 16.5 px per 19 rows -> 0.868 px/unit down |
| window, by texture | 113.4 x 41.9 px |
| active width / window width | 0.9315, offset 0.0208 from the left |
| active height / window height | 0.6696, offset 0.0292 from the top |

Glyph *stem* and *centre* pitches are used rather than the outer extents of
the type because an overexposed stroke blooms by about a pixel on each side;
pitch between like features is immune to that, extent is not.

Two independent checks, neither of them built in:

- those fractions put the active area at **4.00 : 1**, and a 128 x 32 display
  is 4 : 1. Across and down were measured separately;
- HELLO spans **0.426** of the window width in clip-1 and **0.422** in the
  hero, and **0.290** of its height against **0.293**. Both within 1%.

In the hero the window is 385 px wide, which makes one device pixel 2.81 px.
The window's corners are fitted to subpixel accuracy (max residual 0.72 px)
and the type follows the 0.7-degree tilt of the real screen rather than
sitting square to the frame.

## build.py -> site/media/device.gif

The animated hero: the same photograph with the screen playing HELLO out as
Morse and the LED keyed to the marks. 960x657, 37 frames, a 7.5s loop with a
2.1s rest on the finished word, 471 KB.

```
sips -Z 960 big.png --out base960.png
python3 build.py "DOT DASH" 180        # sender, end-hold in 1/100s
```

**Nothing here is timed or drawn by eye either.** The sequence is the
firmware's `STATE_PLAY_MORSE` (`dot_dash_7_3.ino:1600`): dot 100 ms, dash
300 ms, 100 ms between marks, 300 ms between letters -- and
`digitalWrite(LED_PIN, HIGH)` sits on the same line as `tone(BUZZER_PIN, 700)`,
so the LED sync is simply what the device does. The marks are
`drawMorseSymbols()` (`Helpers.ino:122`): a dot is `fillCircle(sx+2, 4, 2)`,
which rasterises to a 5x5, a dash is `fillRect(sx, 3, 9, 3)`, origin x=62,
advancing 8 and 13. Checked against the reference video: at 3.33s the firmware
says *one dot, "HEL"*, the frame shows that, and the dot lands within 3 px of
where the geometry puts it.

Every event falls on a 100 ms boundary, so the 10fps grid loses nothing.

`gifout.py` is a GIF89a writer -- median-cut palette, a 5-bit-per-channel
nearest-colour table so indexing a frame is a lookup, and LZW. Only the first
frame is the whole picture; the rest are the changed rectangle with unchanged
pixels transparent under disposal method 1, which is why 37 frames of a
photograph cost 471 KB rather than ten times that.

**One trap worth recording.** The LZW code size must widen the way
`compress(1)` does it: write the code at the CURRENT size, *then* widen if the
next table slot no longer fits. The obvious-looking `if nxt == 1<<size` right
after the table insert widens one code early, desynchronises the decoder at
code 255, and the image renders blank with no error anywhere.

Verify a build by decoding it back rather than trusting the encoder:

```
swiftc -O -o readgif readgif.swift && ./readgif ../site/media/device.gif
```

## Any word -> build.py WORD OUT

```
python3 build.py "DOT DASH" 180 HELLO ../site/media/device.gif
python3 build.py "DOT DASH" 180 'DROP!' ../site/media/drop.gif
```

Arguments are sender, end-hold (1/100 s), word, output, and optionally the
base image (default `base960.png` here). The code table is read out of
`dot_dash_7_3/Helpers.ino` (`MORSE_ALPHA`, `MORSE_NUM`, `MORSE_PUNCT`), so the
GIF plays what `encodeMorse()` plays; a character the firmware cannot encode
(the comma, for one) stops the build instead of being guessed. A space waits
700 ms, as `STATE_PLAY_MORSE` does. A word wider than the screen at size 2 is
refused, because the firmware would scroll it and this template does not.

`png.py` re-exports `screen.py`'s PNG reader; `build.py` always imported it,
but it was not committed with it. With it back, the HELLO command above
rebuilds `device.gif` byte-for-byte (checked 2026-11-12), which is the proof
that a new word is drawn on exactly the same template.

Mind the strip: with `INSET` the marks start at x=64, so a six-mark letter
ending in a dash (`!` is `-.-.--`) ends on column 127, the last there is.

## Two devices -> build.py --scene pair -> site/media/buy-us.gif

Two devices side by side; the left one plays BUY, then the right one plays US!.
1600x685, 52 frames, about 10.6 s a loop, 707 KB.

```
sips -s format png pair-devices-original.jpg --out pfull.png
sips -c 850 1984 --cropOffset 400 18 pfull.png --out pcrop.png   # h w, then y x
sips -Z 1600 pcrop.png --out base-pair.png
python3 build.py --scene pair "DOT DASH" 180 'BUY,US!' ../site/media/buy-us.gif
```

Crop from the PNG, not the JPEG: `sips -c` on a `.jpg` re-encodes it.
`base-pair.png` is that derived base (deterministic from the commands above);
`pfull` and `pcrop` are intermediates.

**`--scene NAME`** takes the geometry from `scenes.py` instead of the hero's
built-in fits; the words are comma-separated, one per device, in the order the
scene lists them (left to right). Every number in a scene is in the original
photograph's pixels -- the window edges as four line fits, the LED as a
side-on dome (centre, x/y radii, the row it sits on), its lit colour, core and
spill weights -- and `build.py` maps them through the scene's `crop` and the
base's width, so the crop or output size can change without re-measuring. It
refuses a base whose height does not match the crop at that width.

**Why 1600 wide and not 960.** The windows in this photo are 240 px across
against the hero's 385; at 960 one device pixel would be 0.87 px and
`DOT DASH` at size 1 would be five pixels tall. At 1600 it is 1.42 / 1.45 px
(left / right), close to device.gif's 1.69, and the GIF is still 665 KB
because only the first frame is the whole picture.

**The windows** are fitted to the dark glass, not the cut's front edge: the
camera sees an inner wall of each cut (left and bottom on the left device,
right on the right one), and the OLED is behind that wall. Both windows are
2.95-2.98 : 1 against the hero's 2.97 : 1, so it is the same cut and clip-1's
active-area fractions are used unchanged. A re-fit on `base-pair.png` lands
within 0.4 px of the mapped photo fits (about 0.3 of a device pixel).

**The sequence.** Before its turn a screen is left exactly as photographed --
off -- rather than given an idle screen the firmware would not be showing.
Each device plays its word with the timing, marks and header described above,
its own LED keyed to its own marks. The hand-off is the firmware's own gap
between words: the 300 ms that ends every word plus the 700 ms a space waits,
so the pair keeps the rhythm one device would give "BUY US". The last word
holds for the same 2.1 s as device.gif, then the loop starts again.

**The LEDs** are the hero's recipe with an elliptical dome (the domes here are
side-on) and per-LED colours: green lit (150,255,170) as before, blue lit
(110,175,255) with core (225,238,255) and spill weights (0.70,0.85,1.0). In a
scene the unlit LED boxes are also sampled in full for the palette -- at the
hero's every-third-pixel rate the small green dome quantised to grey when off.
That extra sampling is scene-only, so device.gif and drop.gif still rebuild
byte-for-byte (both checked 2026-11-14 after the change).

A new two-device photo: copy the original here, add a `SCENES` entry with its
own measurements, derive a base with the crop you put in it, and run
`build.py --scene` with one word per device.
