/**
 * The device's own menu artwork, as pixels, for the web and the iOS app.
 *
 * Every grid below is transcribed from the firmware, not redrawn: five of them
 * are the 24x24 arrays in dot_dash_7_3/Icons.h (Adafruit GFX drawBitmap
 * format, 3 bytes per row, MSB first) decoded bit for bit, and the sixth is
 * reproduced from the code that draws it. What a parent sees beside "Arcade"
 * in Settings is now the same joystick the child sees on the 128x32 panel when
 * they scroll past ARCADE, down to the pixel.
 *
 * Same contract as Mark.jsx, and for the same reasons: inline SVG,
 * fill="currentColor" so one drawing serves any ink it is dropped into
 * (these sit on --accent circles and take --accent-ink), shapeRendering
 * "crispEdges" so the renderer never antialiases a pixel edge, and rects
 * coalesced into runs rather than one per lit pixel.
 *
 * ---------------------------------------------------------------------------
 * THE SIZE RULE, which is the whole reason this file is careful:
 *
 * The grid is 24 units. Draw it at a WHOLE MULTIPLE of 24 -- 24px, 48px, 72px
 * -- and never anything else. At 24px one unit is one CSS pixel, which is 1, 2
 * or 3 whole device pixels at 1x, 2x and 3x, so every edge lands on a device
 * pixel boundary and every row of the original survives.
 *
 * The failure mode is worth being precise about, because it is NOT blurring.
 * `shapeRendering="crispEdges"` tells the renderer never to antialias, so at a
 * bad size it does not go soft -- it SNAPS, dropping whole rows and columns of
 * the artwork while still looking sharp. The icons in this slot were w-5 h-5
 * (20px): 24 units in 20px is 0.833, so every sixth row and column of the
 * drawing is simply thrown away. Rasterised and counted, against the exact
 * nearest-neighbour expectation:
 *
 *            20px    24px     40px    48px     60px    72px
 *   friends  -5.2%   exact    +0.1%   exact    -0.6%   exact
 *   quick   -21.2%   exact    -7.9%   exact    -0.1%   exact
 *   wifi     +3.6%   exact    -1.8%   exact    exact   exact
 *   arcade   +6.7%   exact    +3.0%   exact    +1.5%   exact
 *   dotDash  -1.5%   exact    -2.6%   exact    -2.6%   exact
 *   tools    -7.8%   exact    -1.7%   exact    exact   exact
 *
 * (20/40/60 are what a 20px icon resolves to at 1x/2x/3x.) A fifth of the
 * speech bubble gone, and the dot in dotDash loses the row through its centre
 * and stops being round. brand/marks/README.md sets the same rule for the
 * mark. `px` is asserted against it in development below.
 * ---------------------------------------------------------------------------
 */
import React from 'react';

const GRID = 24;

// Each entry: [x, y, w, h] in grid units, straight from the decoded bitmaps.
const ICONS = {
  // Icons.h icon_friends -- two figures side by side, head and shoulders. The
  // device's own FRIENDS menu icon, which is why this section is called
  // Friends and not Contacts.
  friends: [[4,2,5,1],[15,2,5,1],[3,3,7,3],[14,3,7,3],[4,6,5,1],[15,6,5,1],
            [4,9,5,1],[15,9,5,1],[3,10,7,1],[14,10,7,1],[2,11,9,9],[13,11,9,9]],

  // Icons.h icon_msg_quick -- the speech bubble with three dots and a tail,
  // from the send menu's carousel.
  quickMessages: [[3,3,18,1],[2,4,20,1],[1,5,2,10],[21,5,2,10],[6,9,2,2],[11,9,2,2],
                  [16,9,2,2],[2,15,20,1],[3,16,18,1],[4,17,5,1],[4,18,4,1],[4,19,3,1],
                  [4,20,2,1]],

  // The one that is NOT a bitmap. There is no icon_wifi: the clock screen
  // draws the online glyph procedurally in Helpers.ino, drawConnIcon() --
  //     display.fillCircle(115, 10, 1, WHITE);
  //     display.drawCircleHelper(115, 10, 4, 0x2, WHITE);
  //     display.drawCircleHelper(115, 10, 8, 0x2, WHITE);
  // -- which is a dot and two arcs sweeping up and right, and which Adafruit's
  // Bresenham resolves to exactly 20 pixels in a 10x10 box. Those 20 pixels
  // were reproduced by running that algorithm, then DOUBLED: one device pixel
  // becomes a 2x2 block, 10x10 becomes 20x20, and it is centred in the 24 box.
  //
  // Doubling rather than redrawing is the decision. The device glyph is drawn
  // with 1px strokes and the five bitmaps above are 2-3px, so dropped in at
  // its own weight it would look spindly beside them and the set would not
  // read as one family. Redrawing it at family weight would have meant
  // inventing a glyph the device does not draw. Doubling thickens the stroke
  // to 2px -- the same weight as the speech bubble -- using only pixels the
  // firmware actually lights. It is a dot and TWO arcs, not three.
  wifi: [[6,2,4,2],[10,4,4,2],[14,6,2,2],[16,8,2,2],[6,10,2,2],[18,10,2,4],
         [8,12,4,2],[10,14,2,2],[20,14,2,4],[4,16,2,2],[12,16,2,2],[2,18,6,2],
         [4,20,2,2]],

  // Icons.h icon_arcade -- the joystick: ball, shaft, base.
  arcade: [[10,2,4,1],[9,3,6,1],[8,4,8,5],[9,9,6,1],[11,10,2,6],[7,16,10,1],
           [6,17,12,2],[5,19,14,2]],

  // Icons.h icon_msg_dotdash -- a dot and a dash from the compose menu. The
  // file's own comment says it is deliberately NOT the product logo, so it is
  // used here for the Dot Dash Mode row and nowhere near the mark.
  dotDash: [[3,8,3,1],[2,9,5,1],[11,9,12,5],[1,10,7,3],[2,13,5,1],[3,14,3,1]],

  // Icons.h icon_tools -- the gear, from TOOLS.
  tools: [[8,1,3,1],[13,1,3,1],[6,2,5,1],[13,2,5,1],[5,3,6,1],[13,3,6,1],
          [6,4,12,1],[3,5,1,1],[7,5,10,1],[20,5,1,1],[2,6,3,1],[6,6,12,1],
          [19,6,3,1],[2,7,20,1],[1,8,22,1],[1,9,9,1],[14,9,9,1],[1,10,8,1],
          [15,10,8,1],[4,11,5,2],[15,11,5,2],[1,13,8,1],[15,13,8,1],[1,14,9,1],
          [14,14,9,1],[1,15,22,1],[2,16,20,1],[2,17,3,1],[6,17,12,1],[19,17,3,1],
          [3,18,1,1],[7,18,10,1],[20,18,1,1],[6,19,12,1],[5,20,6,1],[13,20,6,1],
          [6,21,5,1],[13,21,5,1],[8,22,3,1],[13,22,3,1]],
};

/**
 * name:  friends | quickMessages | wifi | arcade | dotDash | tools
 * px:    rendered size. A whole multiple of 24. See THE SIZE RULE above.
 * title: the accessible name. These icons label a row that already carries
 *        its own text, so the default is aria-hidden -- a screen reader
 *        announcing "gear, Advanced settings" is reading the decoration.
 */
export default function DeviceIcon({ name, px = GRID, className = '', title = null }) {
  const rects = ICONS[name];
  if (!rects) return null;
  if (import.meta.env.DEV && px % GRID !== 0) {
    // Loud on purpose: this is the failure that looks like nothing is wrong.
    console.warn(`DeviceIcon "${name}" drawn at ${px}px, which is not a whole multiple of ${GRID} -- it will fringe.`);
  }
  return (
    <svg viewBox={`0 0 ${GRID} ${GRID}`} width={px} height={px}
      shapeRendering="crispEdges" fill="currentColor" className={className}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': 'true' })}>
      {rects.map(([x, y, w, h]) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} />)}
    </svg>
  );
}

export const DEVICE_ICON_NAMES = Object.keys(ICONS);
