"""Photographs other than the hero, measured, for build.py --scene NAME.

A scene is one base photograph with one or more devices in it.  Every number
here is in the coordinates of the ORIGINAL photograph (the *-original.jpg kept
in this folder), so the crop and the output size can change without
re-measuring: build.py maps them through CROP and the base image's width.

Per device:
  win    the dark window, as four least-squares line fits to subpixel 50%
         crossings (white case -> black glass), the same kind of fit screen.py
         uses for the hero.  top/bot are y = a + b*x, left/right are x = a + b*y.
         Measured on the dark glass seen through the cut, not on the cut's
         front edge: where the camera sees an inner wall of the cut, the glass
         (and the OLED behind it) starts where the wall ends.
  led    the dome on the top edge, seen from the side: centre, x and y radii,
         and the row the dome sits on (nothing below it is dome).  Measured
         off a chroma mask of the dome against the grey wall.
  lit / core / spill
         the lit dome colour, its blown-out centre, and the per-channel weight
         of the glow it spills onto the case.  The hero's green LED is
         lit (150,255,170) core (235,255,240) spill (0.75,1,0.80); the others
         are the same recipe in their own colour.
"""

GREEN = dict(lit=(150, 255, 170), core=(235, 255, 240), spill=(0.75, 1.0, 0.80))
BLUE  = dict(lit=(110, 175, 255), core=(225, 238, 255), spill=(0.70, 0.85, 1.0))

SCENES = {
    # Two devices side by side on a black table, both switched off.
    # pair-devices-original.jpg, 2016 x 1512.  Window fits: max residual
    # 0.43 / 0.32 / 0.36 / 0.33 px (left device), 0.52 / 0.92 / 0.27 / 0.44
    # (right).  Windows 240.6 x 81.5 and 245.8 x 82.5 px -- 2.95 and 2.98 : 1,
    # against 2.97 : 1 for the hero's, so it is the same cut and the hero's
    # active-area fractions apply unchanged.
    'pair': dict(
        photo='pair-devices-original.jpg',
        crop=(18, 400, 1984, 850),             # x, y, w, h in the photograph
        devices=[
            dict(win=dict(top=(814.70, -0.01263), bot=(898.20, -0.01553),
                          left=(532.18, +0.04582), right=(791.79, +0.02345)),
                 led=dict(cx=549.0, cy=574.0, rx=20.0, ry=14.0, base=580.0, **GREEN)),
            dict(win=dict(top=(800.19, +0.00063), bot=(881.56, +0.00111),
                          left=(1547.85, -0.05709), right=(1803.69, -0.06903)),
                 led=dict(cx=1440.0, cy=561.0, rx=22.5, ry=21.0, base=574.0, **BLUE)),
        ],
    ),
}
