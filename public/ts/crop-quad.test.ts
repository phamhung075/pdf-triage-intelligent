import { describe, it, expect } from 'vitest';
import {
  fullFrameQuad,
  rotateQuad90,
  quadIsFullFrame,
  pointInQuad,
  hitTest,
  dragQuadMove,
  dragQuadCorner,
  dragQuadEdge,
  quadBounds,
  type Quad,
} from './crop-quad.js';

const W = 400;
const H = 300;

describe('fullFrameQuad', () => {
  it('returns the image corners in TL, TR, BR, BL order', () => {
    expect(fullFrameQuad(W, H)).toEqual([
      { x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H },
    ]);
  });
});

describe('rotateQuad90', () => {
  it('maps a full frame onto the full frame of the rotated image', () => {
    // A rotation must not silently discard the crop, and a full frame must stay a full frame.
    const rotated = rotateQuad90(fullFrameQuad(W, H), W, H);
    expect(quadIsFullFrame(rotated, H, W)).toBe(true);
  });

  it('keeps a corner crop on the same physical part of the page', () => {
    // Top-left quarter of a landscape image becomes the TOP-RIGHT quarter once rotated clockwise.
    const topLeft: Quad = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 150 }, { x: 0, y: 150 }];
    const rotated = rotateQuad90(topLeft, W, H);
    const b = quadBounds(rotated, H, W);
    expect(b.x).toBe(150);          // right half of the new 300-wide frame
    expect(b.y).toBe(0);            // still at the top
    expect(b.width).toBe(150);
    expect(b.height).toBe(200);
  });

  it('is identity after four rotations', () => {
    const start: Quad = [{ x: 10, y: 20 }, { x: 300, y: 15 }, { x: 310, y: 250 }, { x: 5, y: 260 }];
    let q = start;
    let w = W, h = H;
    for (let i = 0; i < 4; i++) {
      q = rotateQuad90(q, w, h);
      [w, h] = [h, w];
    }
    q.forEach((p, i) => {
      expect(p.x).toBeCloseTo(start[i].x, 6);
      expect(p.y).toBeCloseTo(start[i].y, 6);
    });
  });
});

describe('quadIsFullFrame', () => {
  it('tolerates a sub-pixel drag rather than calling it a crop', () => {
    const nudged: Quad = [{ x: 0.4, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    expect(quadIsFullFrame(nudged, W, H)).toBe(true);
  });

  it('detects a real crop', () => {
    const cropped: Quad = [{ x: 40, y: 30 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    expect(quadIsFullFrame(cropped, W, H)).toBe(false);
  });
});

describe('pointInQuad', () => {
  const q = fullFrameQuad(W, H);

  it('accepts an interior point and rejects an exterior one', () => {
    expect(pointInQuad(200, 150, q)).toBe(true);
    expect(pointInQuad(-5, 150, q)).toBe(false);
    expect(pointInQuad(200, H + 5, q)).toBe(false);
  });

  it('works on a skewed trapezoid, not just rectangles', () => {
    const skewed: Quad = [{ x: 50, y: 0 }, { x: 350, y: 20 }, { x: 380, y: 280 }, { x: 20, y: 260 }];
    expect(pointInQuad(200, 150, skewed)).toBe(true);
    expect(pointInQuad(5, 5, skewed)).toBe(false);
  });
});

describe('hitTest', () => {
  const q = fullFrameQuad(W, H);

  it('prefers a corner over the edge midpoint that sits near it', () => {
    // Corners must win, or a small quad becomes impossible to resize precisely.
    expect(hitTest({ x: 0, y: 0 }, q, 1)).toBe('c0');
    expect(hitTest({ x: W, y: H }, q, 1)).toBe('c2');
  });

  it('finds an edge midpoint away from any corner', () => {
    expect(hitTest({ x: W / 2, y: 0 }, q, 1)).toBe('e0');
    expect(hitTest({ x: W, y: H / 2 }, q, 1)).toBe('e1');
  });

  it('reports move inside and none outside', () => {
    expect(hitTest({ x: W / 2, y: H / 2 }, q, 1)).toBe('move');
    expect(hitTest({ x: W + 60, y: H + 60 }, q, 1)).toBe('none');
  });

  it('accounts for the canvas scale', () => {
    // At half scale the bottom-right corner is drawn at (200,150), not (400,300).
    expect(hitTest({ x: 200, y: 150 }, q, 0.5)).toBe('c2');
  });

  it('returns none for a null quad', () => {
    expect(hitTest({ x: 10, y: 10 }, null, 1)).toBe('none');
  });
});

describe('dragQuadMove', () => {
  it('translates the quad', () => {
    const q: Quad = [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 110 }, { x: 10, y: 110 }];
    expect(dragQuadMove(q, 20, 30, W, H)[0]).toEqual({ x: 30, y: 40 });
  });

  it('clamps so no corner leaves the image', () => {
    const q: Quad = [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 110 }, { x: 10, y: 110 }];
    const far = dragQuadMove(q, -9999, -9999, W, H);
    expect(Math.min(...far.map(p => p.x))).toBe(0);
    expect(Math.min(...far.map(p => p.y))).toBe(0);

    const farOther = dragQuadMove(q, 9999, 9999, W, H);
    expect(Math.max(...farOther.map(p => p.x))).toBe(W);
    expect(Math.max(...farOther.map(p => p.y))).toBe(H);
  });

  it('preserves the quad shape while moving', () => {
    const skewed: Quad = [{ x: 50, y: 0 }, { x: 350, y: 20 }, { x: 380, y: 280 }, { x: 20, y: 260 }];
    const moved = dragQuadMove(skewed, 5, 5, W, H);
    // Every corner shifts by the same clamped delta, so relative geometry is untouched.
    const dx = moved[0].x - skewed[0].x;
    const dy = moved[0].y - skewed[0].y;
    moved.forEach((p, i) => {
      expect(p.x - skewed[i].x).toBeCloseTo(dx, 9);
      expect(p.y - skewed[i].y).toBeCloseTo(dy, 9);
    });
  });
});

describe('dragQuadCorner', () => {
  it('moves only the grabbed corner', () => {
    const q = fullFrameQuad(W, H);
    const dragged = dragQuadCorner(q, 0, 30, 40, W, H);
    expect(dragged[0]).toEqual({ x: 30, y: 40 });
    expect(dragged[1]).toEqual(q[1]);
    expect(dragged[2]).toEqual(q[2]);
    expect(dragged[3]).toEqual(q[3]);
  });

  it('clamps the corner to the image', () => {
    const q = fullFrameQuad(W, H);
    expect(dragQuadCorner(q, 0, -50, -50, W, H)[0]).toEqual({ x: 0, y: 0 });
    expect(dragQuadCorner(q, 2, 50, 50, W, H)[2]).toEqual({ x: W, y: H });
  });
});

describe('dragQuadEdge', () => {
  it('moves a horizontal edge vertically only', () => {
    const q = fullFrameQuad(W, H);
    const dragged = dragQuadEdge(q, 0, 25, 40, W, H); // edge 0 = TL->TR
    expect(dragged[0]).toEqual({ x: 0, y: 40 });
    expect(dragged[1]).toEqual({ x: W, y: 40 });
    expect(dragged[2]).toEqual(q[2]);
  });

  it('moves a vertical edge horizontally only', () => {
    // Start inset from the right edge so the drag has somewhere to go and is not just clamped.
    const inset: Quad = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: H }, { x: 0, y: H }];
    const dragged = dragQuadEdge(inset, 1, 40, 25, W, H); // edge 1 = TR->BR

    expect(dragged[1]).toEqual({ x: 340, y: 0 });   // moved on x, y untouched despite dy=25
    expect(dragged[2]).toEqual({ x: 340, y: H });
    expect(dragged[0]).toEqual(inset[0]);           // the other edge is unaffected
    expect(dragged[3]).toEqual(inset[3]);
  });

  it('preserves skew between the two corners instead of flattening it', () => {
    // The whole reason edges clamp independently: a perspective-corrected trapezoid must survive.
    const skewed: Quad = [{ x: 0, y: 10 }, { x: W, y: 40 }, { x: W, y: H }, { x: 0, y: H }];
    const dragged = dragQuadEdge(skewed, 0, 0, 20, W, H);
    expect(dragged[0].y).toBe(30);
    expect(dragged[1].y).toBe(60);
    expect(dragged[1].y - dragged[0].y).toBe(skewed[1].y - skewed[0].y);
  });
});

describe('quadBounds', () => {
  it('returns the axis-aligned box of a skewed quad', () => {
    const skewed: Quad = [{ x: 50, y: 10 }, { x: 350, y: 20 }, { x: 380, y: 280 }, { x: 20, y: 260 }];
    expect(quadBounds(skewed, W, H)).toEqual({ x: 20, y: 10, width: 360, height: 270 });
  });

  it('never returns a zero-sized box', () => {
    const degenerate: Quad = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
    const b = quadBounds(degenerate, W, H);
    expect(b.width).toBeGreaterThan(0);
    expect(b.height).toBeGreaterThan(0);
  });
});
