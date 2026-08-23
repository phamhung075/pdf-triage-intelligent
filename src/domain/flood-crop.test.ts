import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import {
  detectDocumentBox,
  isAdmissibleCrop,
  materialDistinctness,
  boxBlurRGB,
  WORK_MAX_DIM,
  BLUR_FRAC,
  MAX_ANNULUS_IMPURITY,
  type Work,
} from './flood-crop.js';

function within(a: number, b: number, tol: number) {
  return Math.abs(a - b) <= tol;
}

type Draw = (ctx: any, w: number, h: number) => void;

// Renders a scene and prepares it EXACTLY the way infrastructure/image-processor.ts does:
// resample so the longer side is at most WORK_MAX_DIM, pack RGBA into a 3-channel Float32 buffer,
// then box-blur at radius max(1, round(BLUR_FRAC * min(w, h))). Keeping this identical to
// production is the point — the detector is only ever fed images built this way, and the Float32
// buffer in particular is load-bearing (see the comment in image-processor.ts).
function prepare(nativeW: number, nativeH: number, draw: Draw): { rgb: Float32Array; w: number; h: number } {
  const src = createCanvas(nativeW, nativeH);
  draw(src.getContext('2d'), nativeW, nativeH);

  const ds = Math.min(WORK_MAX_DIM / nativeW, WORK_MAX_DIM / nativeH, 1);
  const w = Math.max(1, Math.round(nativeW * ds));
  const h = Math.max(1, Math.round(nativeH * ds));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const packed = new Float32Array(w * h * 3);
  for (let i = 0, p = 0, q = 0; i < w * h; i++, p += 4, q += 3) {
    packed[q] = data[p]; packed[q + 1] = data[p + 1]; packed[q + 2] = data[p + 2];
  }
  const radius = Math.max(1, Math.round(BLUR_FRAC * Math.min(w, h)));
  return { rgb: boxBlurRGB(packed, w, h, radius), w, h };
}

function detectScene(nativeW: number, nativeH: number, draw: Draw) {
  const { rgb, w, h } = prepare(nativeW, nativeH, draw);
  return { ...detectDocumentBox(rgb, w, h), w, h };
}

// The detected box as fractions of the frame, so results at different resolutions are comparable.
function normalized(r: ReturnType<typeof detectScene>) {
  const b = r.box!;
  return {
    x: b.left / r.w,
    y: b.top / r.h,
    w: (b.right - b.left + 1) / r.w,
    h: (b.bottom - b.top + 1) / r.h,
  };
}

// Grey level v put through an exposure change, for the intensity-invariance test.
const grey = (v: number, gain = 1, lift = 0) => {
  const c = Math.max(0, Math.min(255, Math.round(v * gain + lift)));
  return `rgb(${c},${c},${c})`;
};

// A pale page occupying the middle 60% of the frame on a near-black background, expressed in
// FRACTIONS of the frame so it can be rendered at any resolution and any exposure.
const pageOnDarkDesk = (gain = 1, lift = 0): Draw => (ctx, w, h) => {
  ctx.fillStyle = grey(15, gain, lift);
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = grey(250, gain, lift);
  ctx.fillRect(0.2 * w, 0.2 * h, 0.6 * w, 0.6 * h);
};

describe('detectDocumentBox', () => {
  it('finds a tight, admissible box for a document on a clearly different background', () => {
    const r = detectScene(400, 300, (ctx, w, h) => {
      ctx.fillStyle = 'rgb(15,15,15)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgb(250,250,250)';
      ctx.fillRect(80, 60, 240, 180);
    });

    expect(r.box).not.toBeNull();
    expect(isAdmissibleCrop(r)).toBe(true);
    expect(within(r.box!.left, 80, 5)).toBe(true);
    expect(within(r.box!.top, 60, 5)).toBe(true);
    expect(within(r.box!.right, 319, 5)).toBe(true);
    expect(within(r.box!.bottom, 239, 5)).toBe(true);
  });

  // The case a single global brightness threshold fails on: the page is barely lighter than the
  // desk, and the desk is not even one colour. The barrier map handles it because a smooth
  // lighting gradient can be crossed without ever taking a large step, while the page edge
  // cannot.
  it('finds the document on a gradient pale-on-pale background', () => {
    const r = detectScene(500, 400, (ctx, w, h) => {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, 'rgb(238,225,225)');
      grad.addColorStop(1, 'rgb(222,222,238)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgb(248,248,246)';
      ctx.fillRect(60, 50, 380, 300);
    });

    expect(r.box).not.toBeNull();
    expect(isAdmissibleCrop(r)).toBe(true);
    expect(within(r.box!.left, 60, 5)).toBe(true);
    expect(within(r.box!.top, 50, 5)).toBe(true);
    expect(within(r.box!.right, 439, 5)).toBe(true);
    expect(within(r.box!.bottom, 349, 5)).toBe(true);
  });

  it('is not admissible for a uniform image with no document at all', () => {
    const r = detectScene(200, 200, (ctx, w, h) => {
      ctx.fillStyle = 'rgb(200,200,200)';
      ctx.fillRect(0, 0, w, h);
    });

    expect(r.box).toBeNull();
    expect(isAdmissibleCrop(r)).toBe(false);
  });

  // A real phone photo had a pen lying on the desk beside the document. Anything that unioned
  // every non-background region would drag the box out to swallow it. The centre-covering
  // component vote discards it instead, because the pen does not cover the middle of the frame.
  it('excludes an unrelated object elsewhere in the frame via the centre vote', () => {
    const r = detectScene(400, 300, (ctx, w, h) => {
      ctx.fillStyle = 'rgb(15,15,15)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgb(250,250,250)';
      ctx.fillRect(80, 40, 240, 180); // the document
      ctx.fillStyle = 'rgb(200,30,30)';
      ctx.fillRect(20, 260, 15, 15); // a small red "pen" object down in the corner
    });

    expect(r.box).not.toBeNull();
    expect(isAdmissibleCrop(r)).toBe(true);
    // The document's own bounds — not stretched down/left toward the pen at (20,260).
    expect(within(r.box!.left, 80, 5)).toBe(true);
    expect(within(r.box!.top, 40, 5)).toBe(true);
    expect(within(r.box!.right, 319, 5)).toBe(true);
    expect(within(r.box!.bottom, 219, 5)).toBe(true);
  });

  // Recast of the scene that used to justify the deleted texture gate. A page whose paper is only
  // barely distinguishable from the desk (9 levels), carrying much stronger printed content
  // inside it. There is no texture gate any more, so the assertion is on the OUTCOME, and it has
  // two halves: the low-contrast page must not be swallowed into the background (the box must be
  // the page, not null and not the frame), and the box must not collapse onto the print block
  // inside it either.
  it('does not swallow a low-colour-contrast printed page, nor collapse onto its print', () => {
    const r = detectScene(300, 300, (ctx, w, h) => {
      ctx.fillStyle = 'rgb(205,205,205)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgb(196,196,196)';
      ctx.fillRect(100, 100, 100, 100); // the page: 9 levels off the desk
      ctx.fillStyle = 'rgb(120,120,120)';
      for (let i = 0; i < 8; i++) ctx.fillRect(110, 112 + i * 11, 80, 3); // printed lines
    });

    expect(r.box).not.toBeNull();
    expect(isAdmissibleCrop(r)).toBe(true);
    expect(within(r.box!.left, 100, 5)).toBe(true);
    expect(within(r.box!.top, 100, 5)).toBe(true);
    expect(within(r.box!.right, 199, 5)).toBe(true);
    expect(within(r.box!.bottom, 199, 5)).toBe(true);
  });

  // THE test that would have caught the original bug. The deleted texture gate compared a
  // gradient magnitude against an ABSOLUTE floor, which is a resolution-dependent quantity: the
  // same scene photographed larger has gentler per-pixel gradients. Every decision in this
  // detector is instead a fraction of a dimension or a fraction of a population, so the same
  // scene at 600x450 and at 1800x1350 must produce the same box in normalized coordinates.
  it('is scale invariant: the same scene at 600x450 and 1800x1350 gives the same normalized box', () => {
    const small = detectScene(600, 450, pageOnDarkDesk());
    const large = detectScene(1800, 1350, pageOnDarkDesk());

    expect(isAdmissibleCrop(small)).toBe(true);
    expect(isAdmissibleCrop(large)).toBe(true);
    const a = normalized(small);
    const b = normalized(large);
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.01);
    expect(Math.abs(a.y - b.y)).toBeLessThan(0.01);
    expect(Math.abs(a.w - b.w)).toBeLessThan(0.01);
    expect(Math.abs(a.h - b.h)).toBeLessThan(0.01);
  });

  // Every quantity the detector compares against is measured on the photo itself, and the two
  // searches that could drift under a tone change (the leak window and the scale-space edge
  // search) are defined multiplicatively. So flattening and lifting the whole image must not move
  // the box.
  it('is intensity invariant: gain 1.0 and gain 0.6 + lift 60 give the same normalized box', () => {
    const bright = detectScene(600, 450, pageOnDarkDesk(1.0, 0));
    const flat = detectScene(600, 450, pageOnDarkDesk(0.6, 60));

    expect(isAdmissibleCrop(bright)).toBe(true);
    expect(isAdmissibleCrop(flat)).toBe(true);
    const a = normalized(bright);
    const b = normalized(flat);
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.01);
    expect(Math.abs(a.y - b.y)).toBeLessThan(0.01);
    expect(Math.abs(a.w - b.w)).toBeLessThan(0.01);
    expect(Math.abs(a.h - b.h)).toBeLessThan(0.01);
  });

  // THE BLOCKING DEFECT the admissibility guard exists for. A scan, a close-up capture, a PDF page
  // render, or a second pass over this pipeline's own output: the frame IS the page, so there is
  // no background and the only thing enclosed by a strong barrier is the PRINT. The pipeline still
  // returns a confident, well-formed box — around a text block — and cropping to it destroys the
  // page. Only the outside-the-box evidence can tell: the annulus is full of more print, and the
  // material either side of the "edge" is the same paper.
  it('refuses a printed page that fills the entire frame edge to edge', () => {
    const fillsFrame: Draw = (ctx, w, h) => {
      ctx.fillStyle = 'rgb(246,246,244)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgb(30,30,30)';
      for (let i = 0; i < 14; i++) ctx.fillRect(0.12 * w, (0.1 + i * 0.055) * h, 0.72 * w, 0.02 * h);
    };

    const landscape = detectScene(400, 300, fillsFrame);
    // The detector DOES produce a box here — that is the whole problem, and why the guard cannot
    // be expressed as "did we find something".
    expect(landscape.box).not.toBeNull();
    expect(isAdmissibleCrop(landscape)).toBe(false);

    // Same verdict at a different aspect ratio and resolution, so this is not one lucky framing.
    const portrait = detectScene(900, 1200, fillsFrame);
    expect(portrait.box).not.toBeNull();
    expect(isAdmissibleCrop(portrait)).toBe(false);
  });

  // Guards against re-introducing the deleted FLOODCROP_MIN_AREA_RATIO = 0.25, which rejected any
  // document under a quarter of the frame. No ground-truth box in the benchmark corpus is that
  // small (they run 57-86% of frame), so such a rule is invisible to the bench while silently
  // imposing a cliff on receipts, ID cards and business cards.
  it('finds a small document occupying only ~8% of the frame', () => {
    const r = detectScene(600, 450, (ctx, w, h) => {
      ctx.fillStyle = 'rgb(20,22,28)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgb(248,248,246)';
      ctx.fillRect(0.35 * w, 0.367 * h, 0.3 * w, 0.267 * h); // 0.3 * 0.267 = 8.0% of frame area
    });

    expect(r.box).not.toBeNull();
    expect(isAdmissibleCrop(r)).toBe(true);
    const n = normalized(r);
    expect(n.w * n.h).toBeLessThan(0.12); // still small — not blown out to the frame
    expect(within(r.box!.left, 210, 5)).toBe(true);
    expect(within(r.box!.top, 165, 5)).toBe(true);
    expect(within(r.box!.right, 389, 5)).toBe(true);
    expect(within(r.box!.bottom, 285, 5)).toBe(true);
  });
});

describe('isAdmissibleCrop', () => {
  it('rejects a null box', () => {
    expect(isAdmissibleCrop({ box: null, impurity: 0, distinctness: 99 })).toBe(false);
  });

  it('rejects a box whose annulus is not background', () => {
    const box = { left: 10, top: 10, right: 90, bottom: 90 };
    expect(isAdmissibleCrop({ box, impurity: MAX_ANNULUS_IMPURITY + 0.001, distinctness: 99 })).toBe(false);
    expect(isAdmissibleCrop({ box, impurity: MAX_ANNULUS_IMPURITY, distinctness: 99 })).toBe(true);
  });

  it('rejects a box whose annulus is the same material as its interior', () => {
    const box = { left: 10, top: 10, right: 90, bottom: 90 };
    expect(isAdmissibleCrop({ box, impurity: 0, distinctness: 1 })).toBe(false);
    expect(isAdmissibleCrop({ box, impurity: 0, distinctness: 1.001 })).toBe(true);
  });
});

// The two degeneracies are deliberately asymmetric, and getting them the wrong way round waves
// through the most destructive answer the detector can give.
describe('materialDistinctness degeneracy', () => {
  const work: Work = { rgb: new Float32Array(4 * 3).fill(100), w: 2, h: 2 };

  it('fails CLOSED (returns 0) when the box interior is empty — a collapsed box must never pass', () => {
    expect(materialDistinctness(work, { inside: [], outside: [0, 1] }, [100])).toBe(0);
  });

  it('fails OPEN (returns Infinity) when the annulus is empty — the box is the whole frame, so cropping is already a no-op', () => {
    expect(materialDistinctness(work, { inside: [0, 1], outside: [] }, [100])).toBe(Infinity);
  });

  it('returns Infinity when no sample measured any barrier strength at all', () => {
    expect(materialDistinctness(work, { inside: [0], outside: [1] }, [0])).toBe(Infinity);
  });
});
