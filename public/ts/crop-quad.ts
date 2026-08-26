/**
 * Pure crop-quad geometry — four corners in image space, ordered TL, TR, BR, BL.
 *
 * Ported from pdf-awesome's `js/domain/crop-geometry.js`, the same source `flood-crop.ts` and
 * `image-adjust.ts` came from. No DOM and no canvas: scale and pointer positions are passed in
 * explicitly, so the drag maths is unit-testable without a browser. The editor UI owns the
 * pointer events and the rendering; everything here is a pure function of its inputs.
 *
 * A quad rather than a rectangle because a photographed page is rarely axis-aligned — the corners
 * can form a trapezoid, and the edge-drag below deliberately preserves that skew instead of
 * flattening it back to a rectangle.
 */

export interface Point {
  x: number;
  y: number;
}

/** TL, TR, BR, BL. */
export type Quad = [Point, Point, Point, Point];

/**
 * What a pointer at `pos` is grabbing:
 *   'c0'..'c3'  a corner (index into the quad)
 *   'e0'..'e3'  an edge midpoint (edge i runs from corner i to corner i+1)
 *   'move'      inside the quad
 *   'none'      outside
 */
export type CropHandle = `c${0 | 1 | 2 | 3}` | `e${0 | 1 | 2 | 3}` | 'move' | 'none';

const DEFAULT_HIT_MARGIN_PX = 18;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function copy(quad: Quad): Quad {
  return quad.map(p => ({ x: p.x, y: p.y })) as Quad;
}

export function fullFrameQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

/**
 * Re-expresses a quad defined in an oldW x oldH frame into the oldH x oldW frame produced by
 * rotating the image 90° clockwise.
 *
 * Without this, rotating after drawing a crop would throw the crop away (or worse, silently leave
 * it pointing at a different part of the page). old[TL,TR,BR,BL] becomes new[TR,BR,BL,TL], each
 * point mapped by (x, y) -> (oldH - y, x).
 */
export function rotateQuad90(quad: Quad, _oldWidth: number, oldHeight: number): Quad {
  const rotatePoint = (p: Point): Point => ({ x: oldHeight - p.y, y: p.x });
  return [quad[3], quad[0], quad[1], quad[2]].map(rotatePoint) as Quad;
}

/**
 * True when the quad still matches the image corners, i.e. the user has not actually cropped.
 * Tolerance scales with the image so a stray sub-pixel drag does not count as a crop.
 */
export function quadIsFullFrame(quad: Quad, width: number, height: number): boolean {
  const corners = [[0, 0], [width, 0], [width, height], [0, height]];
  const tolerance = Math.max(2, Math.min(width, height) * 0.01);
  for (let i = 0; i < 4; i++) {
    if (Math.abs(quad[i].x - corners[i][0]) > tolerance) return false;
    if (Math.abs(quad[i].y - corners[i][1]) > tolerance) return false;
  }
  return true;
}

/** Ray-casting point-in-polygon over the four corners. */
export function pointInQuad(px: number, py: number, quad: Quad): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = quad[i].x, yi = quad[i].y;
    const xj = quad[j].x, yj = quad[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Corners take priority over edge midpoints, so a small quad — where the two are only a few
 * pixels apart — stays unambiguous to grab.
 *
 * `pos` is in canvas pixels; `scale` converts image space to canvas space.
 */
export function hitTest(pos: Point, quad: Quad | null, scale: number, margin = DEFAULT_HIT_MARGIN_PX): CropHandle {
  if (!quad) return 'none';

  let best = -1;
  let bestDistance = margin;
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(pos.x - quad[i].x * scale, pos.y - quad[i].y * scale);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  if (best >= 0) return `c${best}` as CropHandle;

  const scaled = quad.map(p => ({ x: p.x * scale, y: p.y * scale })) as Quad;
  best = -1;
  bestDistance = margin;
  for (let i = 0; i < 4; i++) {
    const a = scaled[i];
    const b = scaled[(i + 1) % 4];
    const d = Math.hypot(pos.x - (a.x + b.x) / 2, pos.y - (a.y + b.y) / 2);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  if (best >= 0) return `e${best}` as CropHandle;

  return pointInQuad(pos.x, pos.y, scaled) ? 'move' : 'none';
}

/** Translates the whole quad, clamped so every corner stays inside the image. */
export function dragQuadMove(start: Quad, dx: number, dy: number, imgWidth: number, imgHeight: number): Quad {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of start) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const tdx = clamp(dx, -minX, imgWidth - maxX);
  const tdy = clamp(dy, -minY, imgHeight - maxY);
  return start.map(p => ({ x: p.x + tdx, y: p.y + tdy })) as Quad;
}

/** Drags one corner, clamped to the image. */
export function dragQuadCorner(start: Quad, index: number, dx: number, dy: number, imgWidth: number, imgHeight: number): Quad {
  const quad = copy(start);
  quad[index] = {
    x: clamp(start[index].x + dx, 0, imgWidth),
    y: clamp(start[index].y + dy, 0, imgHeight),
  };
  return quad;
}

/**
 * Drags an edge midpoint: both of its corners move along one axis only.
 *
 * Each corner is clamped independently so an existing skew between them — a perspective-corrected
 * trapezoid — survives the drag rather than being flattened into a rectangle.
 */
export function dragQuadEdge(start: Quad, edgeIndex: number, dx: number, dy: number, imgWidth: number, imgHeight: number): Quad {
  const other = (edgeIndex + 1) % 4;
  const quad = copy(start);

  if (edgeIndex % 2 === 0) {
    // Even index: a horizontal edge (top/bottom), dragged vertically.
    quad[edgeIndex] = { x: start[edgeIndex].x, y: clamp(start[edgeIndex].y + dy, 0, imgHeight) };
    quad[other] = { x: start[other].x, y: clamp(start[other].y + dy, 0, imgHeight) };
  } else {
    // Odd index: a vertical edge (left/right), dragged horizontally.
    quad[edgeIndex] = { x: clamp(start[edgeIndex].x + dx, 0, imgWidth), y: start[edgeIndex].y };
    quad[other] = { x: clamp(start[other].x + dx, 0, imgWidth), y: start[other].y };
  }
  return quad;
}

/** Axis-aligned bounding box of a quad, clamped to the image and never zero-sized. */
export function quadBounds(quad: Quad, imgWidth: number, imgHeight: number): { x: number; y: number; width: number; height: number } {
  const xs = quad.map(p => p.x);
  const ys = quad.map(p => p.y);
  const x = clamp(Math.min(...xs), 0, imgWidth);
  const y = clamp(Math.min(...ys), 0, imgHeight);
  const right = clamp(Math.max(...xs), 0, imgWidth);
  const bottom = clamp(Math.max(...ys), 0, imgHeight);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}
