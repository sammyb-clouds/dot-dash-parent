/**
 * The Dot Dash mark, as pixels.
 *
 * These are the grids from brand/marks (`smile.py`), transcribed rather than
 * re-derived: the 48, 24 and 16 unit drawings, each measured off the object --
 * the enclosure outline as the frame, the round SELECT cap as the dot, the
 * screen window as a true rectangle for the dash, and the engraved smile
 * centred on the frame. brand/marks/README.md has the measurements and says
 * why the smile disappears at 16 and why the dot stops being a circle at 3px.
 *
 * Why not the <img src="icon.jpg"> this page used before: that file is an
 * opaque Display-P3 photograph of a drawing with no alpha channel, so it
 * cannot sit on a dark ground at all. This page now has a dark mode, so it had
 * to become line art on nothing. `fill="currentColor"` means one component
 * serves both themes and inherits whatever the surrounding text colour is.
 * icon.jpg is untouched and is still the favicon, the manifest icon and the
 * Home Screen icon -- replacing those is a separate decision.
 *
 * Pick the grid by the size you are drawing at, not by taste: a 48-unit grid
 * shown at 96px is 2 units per CSS pixel, so every edge lands on a whole
 * device pixel at 1x, 2x and 3x. 72px would be 1.5 units per pixel and fringe.
 */
import React from 'react';

// Each entry: [x, y, w, h] in grid units. Straight from the exported SVGs.
const GRIDS = {
  48: [[6,10,36,1],[5,11,38,1],[4,12,2,1],[42,12,2,1],[3,13,2,1],[43,13,2,1],
       [2,14,2,19],[44,14,2,19],[13,19,3,1],[12,20,5,1],[26,20,12,5],[11,21,7,3],
       [12,24,5,1],[13,25,3,1],[22,30,1,1],[25,30,1,1],[23,31,2,1],[3,33,2,1],
       [43,33,2,1],[4,34,2,1],[42,34,2,1],[5,35,38,1],[6,36,36,1]],
  24: [[3,5,18,1],[2,6,1,1],[21,6,1,1],[1,7,1,9],[22,7,1,9],[7,10,2,1],[6,11,4,2],
       [13,11,6,2],[7,13,2,1],[10,15,4,1],[2,16,1,1],[21,16,1,1],[3,17,18,1]],
  16: [[2,4,12,1],[1,5,1,6],[14,5,1,6],[4,7,3,3],[9,8,4,1],[2,11,12,1]],
};

/**
 * grid: 48 | 24 | 16 -- which drawing. px: the rendered size; keep it a whole
 * multiple of the grid. className takes the colour (the mark is currentColor).
 */
export default function Mark({ grid = 48, px = 96, className = '', title = 'Dot Dash' }) {
  const rects = GRIDS[grid] || GRIDS[48];
  return (
    <svg viewBox={`0 0 ${grid} ${grid}`} width={px} height={px}
      shapeRendering="crispEdges" fill="currentColor" role="img"
      aria-label={title} className={className}>
      {rects.map(([x, y, w, h]) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} />)}
    </svg>
  );
}
