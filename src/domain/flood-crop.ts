// ===============================================================================================
// WHAT THIS FILE REPLACED, AND WHY — READ THIS BEFORE CHANGING ANYTHING BELOW
// ===============================================================================================
//
// This file used to hold a border-seeded flood fill (floodDocumentBox) gated by three tests: a
// local per-step colour tolerance, a global distance-from-border-average tolerance, and a TEXTURE
// gate built on box-blurred Sobel gradient magnitude. All of it is gone. The whole of it —
// FLOODCROP_LOCAL_TOL, FLOODCROP_GLOBAL_TOL, FLOODCROP_TEXTURE_K, FLOODCROP_TEXTURE_FLOOR,
// FLOODCROP_TEXTURE_BLUR_RADIUS, FLOODCROP_MIN_BLOB, FLOODCROP_MERGE_SIZE_RATIO,
// FLOODCROP_MERGE_X_OVERLAP, computeTextureMap, boxBlurFloat and floodDocumentBox — has been
// deleted and replaced by the edge-snap detector documented under PIPELINE below.
//
// THE BUG. The texture gate's threshold was `max(FLOODCROP_TEXTURE_FLOOR, mean + K*stddev)` of the
// border pixels' gradient magnitude, and FLOODCROP_TEXTURE_FLOOR was an ABSOLUTE gradient value: 6.
// Six sits BELOW the JPEG noise floor of an ordinarily flat region in a real phone photo. On such a
// photo the floor, not the adaptive term, is what binds — and it declares ordinary compression
// noise in the background to be "printed structural detail". The background therefore fails the
// gate immediately, the flood never leaves the frame border, almost nothing is marked background,
// and the "largest unreached component" is nearly the entire frame. Measured against hand-labelled
// ground truth this returned a near-full-frame box on 16 of 16 real photos: no crop at all, dressed
// up as a successful detection.
//
// WHY NO RE-CALIBRATION COULD EVER HAVE FIXED IT. The gate's premise was that the document is MORE
// textured than the background ("a printed page almost always has some structural detail; a
// legitimate background stays flat"). Direct measurement of the same 16-photo corpus says otherwise:
// on 9 of those 16 photos the document INTERIOR is LESS textured than the background it sits on —
// desk grain, wood, fabric, carpet and cloth are all busier than a mostly-white page. On more than
// half the corpus the gate's signal is therefore INVERTED IN SIGN, and a signal that points the
// wrong way on half its inputs cannot be rescued by moving its threshold: any value tight enough to
// catch the photos where it points the right way blocks the background on the photos where it
// points the wrong way, and vice versa. That is exactly the "either missed the passport's faint
// text page, or treated the payslip's textured desk as document" oscillation the old comments
// recorded as a tuning difficulty. It was not a tuning difficulty. It was the wrong feature.
//
// DO NOT REINTRODUCE A TEXTURE GATE. Not with a better blur, not with a percentile instead of a
// stddev, not with a per-photo adaptive floor. Texture does not separate document from background
// in this corpus, in either direction, and the detector below does not need it to: it never asks
// how busy a region is, only whether a path from the frame border to it has to cross a strong
// colour step (stage 3), and whether the two sides of a proposed edge are made of different
// material (stage 7's colour check and admissibility test B).
//
// DOMAIN CONTRACT (unchanged): pure logic, zero I/O, no canvas import. The decode / resample /
// pack half of the original detector's `prepare()` lives in src/infrastructure/image-processor.ts;
// this file exports WORK_MAX_DIM, BLUR_FRAC and boxBlurRGB so infrastructure can build exactly the
// working image the detector expects, and exports detectDocumentBox / isAdmissibleCrop as the two
// halves of the decision. Coordinates in and out are WORKING pixels; mapping back to original
// image pixels is infrastructure's job.
//
// ===============================================================================================
// "edge-snap" document crop detector.
//
// DESIGN CONTRACT: every value that decides "background vs document" is measured on the image
// being processed. The only literals in this file are (a) resource caps and structural constants
// that never participate in a classification, and (b) DIMENSIONLESS conventions - fractions of an
// image dimension, fractions of a population, or a rise-point convention. There is no absolute
// intensity, no absolute gradient magnitude and no absolute pixel count in any decision.
//
// PIPELINE (each stage calibrates itself from what the previous stage measured):
//
//   1. NORMALISE  Decode and resample so every image is analysed at one common working scale.
//                 This is what makes the "fraction of a dimension" radii below mean the same
//                 physical thing on a 12 MP phone photo and on a 0.5 MP scan.
//
//   2. SMOOTH     Box blur at a radius that is a fraction of the working dimension. Print, JPEG
//                 noise and desk grain are sub-radius and collapse into their local surface
//                 colour; a page boundary is a long discontinuity and survives.
//
//   3. BARRIER    The core measurement, and the reason no colour threshold is needed. For every
//                 pixel compute the MINIMAX BARRIER COST: the smallest possible value of "the
//                 largest colour step you must cross" over all paths from a seed border to that
//                 pixel (a priority flood with a bucket queue, popping in non-decreasing cost).
//                 Background - however textured, however gradient-lit, however multi-material,
//                 as long as it reaches the frame border - is reachable without crossing any
//                 strong step, so its cost is low. Anything enclosed by a real boundary has a
//                 cost equal to that boundary's strength. This turns "is it background" into a
//                 single scalar whose scale is set by the photo itself.
//
//   4. LEAK       Where the flood breaks OUT of the background is read off that cost map's own
//                 histogram: sweeping the cost upward, area is absorbed slowly while the flood is
//                 still wandering inside the background, and then the entire document arrives at
//                 once, at the strength of the boundary enclosing it. The threshold sits just
//                 below that arrival. The arrival is measured in a window one octave of cost wide,
//                 which is what makes the reading survive a tone change: brightening or flattening
//                 a photo multiplies every cost by roughly a constant.
//
//   5. ISOLATE    Reduce the above-threshold pixels to the single connected component that best
//                 covers the frame centre - the photographic fact that the subject is at frame
//                 centre, not brightness, hue, or size. This discards speckle, a pen beside the
//                 page, a bright patch of floor, before any of it can pollute a profile.
//
//   6. ARBITRATE  Steps 3-5 are run FIVE times over independent samples of the same photo: one
//                 flood seeded from the whole frame border, and one from each border line alone.
//                 No single seed is always right - a whole-frame seed is spoiled when the document
//                 itself runs off the frame, a single-side seed is spoiled when some other object
//                 covers that border - so the samples compete rather than being chosen by rule.
//
//   7. EDGE SNAP  Each of the four sides is refined independently. For a side, and for each of the
//                 five samples, build a profile of "what fraction of this row/column, across the
//                 current box's span, is document", scan inward from the frame border, and find
//                 the largest SUSTAINED step. Because that filter compares two equally deep bands,
//                 a thin printed rule - which has paper on both sides - produces no step at all,
//                 while a page boundary produces close to a full flip of the composition. The
//                 filter is run at successive octaves of depth, finest first, so a knife-edge and
//                 a long skew ramp are both resolvable without giving up localisation on the easy
//                 case. The side keeps the strongest reading over the five samples, then extends
//                 it outward by hysteresis to the extreme corner of a skewed sheet. A side whose
//                 profile never flips from majority-background to majority-document has no visible
//                 boundary - the document runs off frame there - and is left where it was.
//
//   8. RE-SNAP    Repeat step 7, now measuring each side's profile over the snapped extent rather
//                 than the coarse over-inclusion.
//
// Returns a null box only when no sample found anything covering the middle of the photograph.
// ===============================================================================================

// --- Resource cap. Never appears in a comparison that classifies a pixel. It bounds run time
// regardless of camera megapixels AND normalises every image to one working scale, which is what
// makes the dimensionless fractions below resolution-independent rather than resolution-dependent.
export const WORK_MAX_DIM = 768;

// --- Structural constants describing the numeric domain of the barrier cost, not thresholds.
// Colour steps are measured on the SMOOTHED image, whose values are real-valued averages, so they
// are carried at sub-unit precision: COST_QUANT steps per unit of 8-bit intensity. Without this
// the whole low-contrast end of the scale - a pale page on a pale desk, or any photo whose
// contrast has been compressed - collapses into one or two integer levels and stops being
// measurable at all. MAX_COST is the resulting domain size (3 x 255 units, quantised).
const COST_QUANT = 16;
const MAX_COST = 765 * COST_QUANT;

// --- DIMENSIONLESS: smoothing radius as a fraction of the shorter working dimension. Sets the
// spatial scale below which detail is "surface texture" rather than "geometry".
export const BLUR_FRAC = 0.005;

// --- DIMENSIONLESS: side of the central patch used for the "the subject is at frame centre"
// vote, as a fraction of each axis.
const CENTER_FRAC = 1 / 3;

// --- DIMENSIONLESS: radius of the step-response matched filter, as a fraction of the axis being
// scanned. A boundary must separate two bands each this deep to count; anything thinner (printed
// rules, staple shadows, fold seams) averages out.
const STEP_FRAC = 0.02;

// --- DIMENSIONLESS: coarsest comparison depth in the scale-space search above, as a fraction of
// the axis. A quarter of the axis: beyond that the two bands can no longer both fit between the
// frame border and the middle of the frame, so a deeper filter would be measuring the frame
// rather than the boundary.
const MAX_STEP_FRAC = 0.25;

// --- DIMENSIONLESS: a side is only snapped when its profile step crosses the midpoint of the
// profile's own 0..1 range - i.e. when the row/column genuinely flips from majority-background to
// majority-document. The natural midpoint of a fraction, not a tuned level.
const MIN_STEP = 0.5;

// --- DIMENSIONLESS: the ratio that defines "one octave", used both for the cost window that
// locates the leak and for the successive depths of the scale-space edge search. A doubling is
// the standard scale-space step; being a pure ratio, it is what carries the multiplicative
// invariance those two searches rely on.
const OCTAVE = 2;

// --- DIMENSIONLESS: rise-point convention for extending the detected step outward to the extreme
// corner of a skewed sheet, as a fraction of this side's own measured low-to-high profile span.
// The standard 10% rise point.
const RISE_FRAC = 0.1;

// A box in WORKING pixel coordinates, inclusive on all four edges.
export interface Rect { left: number; top: number; right: number; bottom: number }

// The prepared working image: blurred RGB, 3 values/px, kept real-valued (see COST_QUANT).
// Built by infrastructure from WORK_MAX_DIM + BLUR_FRAC + boxBlurRGB.
export interface Work {
  rgb: Float32Array;
  w: number;
  h: number;
}

type Side = 'top' | 'bottom' | 'left' | 'right';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------------------- smooth

export function boxBlurRGB(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h * 3);
  const out = new Float32Array(w * h * 3);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += src[(row + clamp(x, 0, w - 1)) * 3 + c];
      tmp[row * 3 + c] = sum / win;
      for (let x = 1; x < w; x++) {
        sum += src[(row + clamp(x + r, 0, w - 1)) * 3 + c] - src[(row + clamp(x - r - 1, 0, w - 1)) * 3 + c];
        tmp[(row + x) * 3 + c] = sum / win;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[(clamp(y, 0, h - 1) * w + x) * 3 + c];
      out[x * 3 + c] = sum / win;
      for (let y = 1; y < h; y++) {
        sum += tmp[(clamp(y + r, 0, h - 1) * w + x) * 3 + c] - tmp[(clamp(y - r - 1, 0, h - 1) * w + x) * 3 + c];
        out[(y * w + x) * 3 + c] = sum / win;
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------------- minimax barrier map

// For every pixel: the smallest achievable "largest single colour step crossed" over all paths
// from the seeded border(s). Implemented as a priority flood with a bucket queue over the integer
// L1 colour-step domain, so pixels are settled in non-decreasing cost order in O(n) time.
//
// This is the whole background model. It needs no threshold, no reference colour and no texture
// statistic: whatever the background is made of, if it connects to the seeded border without
// crossing a strong colour step it settles cheaply; whatever is enclosed by a real boundary
// settles at that boundary's own strength, expressed in the same units as the image.
function barrierMap(work: Work, sides: Side[]): Int32Array {
  const { rgb, w, h } = work;
  const n = w * h;
  const cost = new Int32Array(n).fill(MAX_COST + 1);
  const buckets: Int32Array[] = new Array(MAX_COST + 1);
  const bucketLen = new Int32Array(MAX_COST + 1);

  const push = (c: number, i: number) => {
    let b = buckets[c];
    if (!b) { b = buckets[c] = new Int32Array(64); }
    if (bucketLen[c] === b.length) {
      const nb = new Int32Array(b.length * 2);
      nb.set(b); b = buckets[c] = nb;
    }
    b[bucketLen[c]++] = i;
  };

  const seed = (i: number) => { if (cost[i] !== 0) { cost[i] = 0; push(0, i); } };
  if (sides.includes('top')) for (let x = 0; x < w; x++) seed(x);
  if (sides.includes('bottom')) for (let x = 0; x < w; x++) seed((h - 1) * w + x);
  if (sides.includes('left')) for (let y = 0; y < h; y++) seed(y * w);
  if (sides.includes('right')) for (let y = 0; y < h; y++) seed(y * w + w - 1);

  const step = (a: number, b: number) =>
    Math.round(COST_QUANT * (Math.abs(rgb[a * 3] - rgb[b * 3]) + Math.abs(rgb[a * 3 + 1] - rgb[b * 3 + 1]) + Math.abs(rgb[a * 3 + 2] - rgb[b * 3 + 2])));

  for (let c = 0; c <= MAX_COST; c++) {
    for (let k = 0; k < bucketLen[c]; k++) {
      const i = buckets[c]![k];
      if (cost[i] !== c) continue;
      const x = i % w, y = (i / w) | 0;
      if (x > 0) relax(i, i - 1);
      if (x < w - 1) relax(i, i + 1);
      if (y > 0) relax(i, i - w);
      if (y < h - 1) relax(i, i + w);
    }
    buckets[c] = undefined as any;

    function relax(i: number, j: number) {
      const nc = Math.max(c, step(i, j));
      if (nc < cost[j]) { cost[j] = nc; push(nc, j); }
    }
  }
  return cost;
}

// Where does the flood LEAK out of the background and into the document?
//
// Sweeping the barrier cost from zero, area is absorbed slowly while the flood is still wandering
// around inside the background, and then, the instant the cost reaches the strength of the page
// boundary, the ENTIRE document arrives at once - its interior is uniform, so every one of its
// pixels has the same barrier cost as the boundary that encloses it. That single largest arrival
// is the leak, and the threshold sits immediately below it. Nothing here is supplied by the
// author: the operating point is whatever cost this photo happens to leak at.
//
// The arrival is measured in a window that is one OCTAVE OF COST wide - [s, 2s) - slid over every
// possible start s, and the leak is the start whose window catches the most area. The octave width
// is the correct invariance: brightening, darkening or flattening a photo multiplies every colour
// step, and therefore every barrier cost, by roughly a constant. A window defined multiplicatively
// scales with the photo; a window defined in raw cost levels does not. Sliding it, rather than
// snapping it to fixed powers of two, keeps that invariance exact instead of letting a tone change
// shunt an arrival across a bin edge. The octave width also stops a noisy background, whose mass is
// smeared thinly over many adjacent low cost levels, from out-voting a document that arrives
// concentrated at one higher level.
//
// Ties resolve to the LARGEST qualifying start, which is the tightest background consistent with
// the evidence: the threshold ends up immediately below the arrival rather than a long way beneath
// it with empty cost levels in between.
//
// Cost zero is background by definition - reachable from the border across no colour step at all -
// and is therefore never a candidate leak.
function leakThreshold(cost: Int32Array): number {
  const hist = new Float64Array(MAX_COST + 2);
  for (let i = 0; i < cost.length; i++) hist[cost[i]]++;
  const cum = new Float64Array(MAX_COST + 3);
  for (let c = 0; c <= MAX_COST + 1; c++) cum[c + 1] = cum[c] + hist[c];
  const upTo = (c: number) => cum[Math.min(MAX_COST + 2, Math.max(0, c))];

  let bestMass = -1, bestStart = 1;
  for (let s = 1; s <= MAX_COST; s++) {
    const mass = upTo(OCTAVE * s) - upTo(s);
    if (mass >= bestMass) { bestMass = mass; bestStart = s; }
  }
  return bestStart - 1;
}

function maskFromCost(cost: Int32Array, threshold: number): Uint8Array {
  const m = new Uint8Array(cost.length);
  for (let i = 0; i < cost.length; i++) m[i] = cost[i] > threshold ? 1 : 0;
  return m;
}

// ------------------------------------------------------------------------------ coarse anchoring

function centreWindow(w: number, h: number) {
  return {
    x0: Math.floor(w * (0.5 - CENTER_FRAC / 2)), x1: Math.ceil(w * (0.5 + CENTER_FRAC / 2)),
    y0: Math.floor(h * (0.5 - CENTER_FRAC / 2)), y1: Math.ceil(h * (0.5 + CENTER_FRAC / 2)),
  };
}

// The document is ONE connected thing that covers the middle of the photograph. Reducing each
// mask to the single component that best covers the frame centre discards everything else the
// leak threshold happened to pick up - speckle on a near-blank desk, a pen lying beside the page,
// a bright patch of floor - before any of it can pollute a row/column profile. It is also the
// only place the "subject is at frame centre" assumption is used, and it is used as a vote over
// an area rather than as a test on a single pixel.
//
// Returns the isolated component and its bounding box, or null when nothing covers the centre at
// all (which is the correct outcome for a seed line that started on the document itself: that
// sample simply has no opinion, and contributes nothing).
function centreComponent(mask: Uint8Array, w: number, h: number): { mask: Uint8Array; box: Rect } | null {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const label = new Int32Array(n).fill(-1);
  const { x0, x1, y0, y1 } = centreWindow(w, h);

  let best = -1, bestCentre = 0;
  let bestBox: Rect | null = null;
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue;
    let hd = 0, tl = 0;
    stack[tl++] = s; seen[s] = 1;
    let ax = w, ay = h, bx = -1, by = -1, centre = 0;
    while (hd < tl) {
      const i = stack[hd++];
      label[i] = id;
      const x = i % w, y = (i / w) | 0;
      if (x < ax) ax = x; if (x > bx) bx = x;
      if (y < ay) ay = y; if (y > by) by = y;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) centre++;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[tl++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[tl++] = i + 1; }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[tl++] = i - w; }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[tl++] = i + w; }
    }
    if (centre > bestCentre) { bestCentre = centre; best = id; bestBox = { left: ax, top: ay, right: bx, bottom: by }; }
    id++;
  }
  if (best < 0 || !bestBox) return null;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (label[i] === best) out[i] = 1;
  return { mask: out, box: bestBox };
}

// ------------------------------------------------------------------------------------ edge snap

interface SnapResult { pos: number; confident: boolean; strength: number; depth: number; stepPos: number }

// Scans a 0..1 profile inward from index 0 and returns the boundary index. See stage 7 in the
// file header for why each part is shaped the way it is.
function snapSide(profile: Float64Array, limit: number, axisLen: number): SnapResult {
  const nProf = profile.length;
  const prefix = new Float64Array(nProf + 1);
  for (let i = 0; i < nProf; i++) prefix[i + 1] = prefix[i] + profile[i];
  const bandMean = (lo: number, hi: number) => (hi <= lo ? 0 : (prefix[hi] - prefix[lo]) / (hi - lo));

  // Scale space, searched FINEST FIRST. A boundary can present as a knife edge (a sheet lying flat,
  // sharply photographed) or as a long ramp (a sheet skewed in plane, a rounded corner, a page
  // fading into a desk of nearly its own colour). One fixed comparison depth answers only one of
  // those. So the same matched filter is run at successive octaves of depth and the search stops
  // at the FIRST - shallowest - depth that resolves the boundary. Coarsening buys sensitivity at
  // the cost of localisation, so it is spent only when the finer scales found nothing, never as a
  // free upgrade on a case that was already sharp.
  let bestPos = -1, bestStep = -Infinity, bestR = Math.max(1, Math.round(STEP_FRAC * axisLen));
  for (let r = Math.max(1, Math.round(STEP_FRAC * axisLen)); r <= axisLen * MAX_STEP_FRAC; r *= OCTAVE) {
    const hardLimit = Math.min(limit, nProf - r);
    let pos = -1, step = -Infinity;
    for (let i = r; i <= hardLimit; i++) {
      const s = bandMean(i, i + r) - bandMean(i - r, i);
      if (s > step) { step = s; pos = i; }
    }
    if (step > bestStep) { bestStep = step; bestPos = pos; bestR = r; }
    if (step >= MIN_STEP) { bestStep = step; bestPos = pos; bestR = r; break; }
  }
  if (bestPos < 0 || bestStep < MIN_STEP) return { pos: 0, confident: false, strength: bestStep, depth: bestR, stepPos: 0 };

  const lo = median(profile, 0, bestPos);
  const hi = median(profile, bestPos, Math.max(bestPos + 1, Math.min(nProf, limit)));
  const thr = lo + RISE_FRAC * (hi - lo);

  let pos = bestPos;
  while (pos > 0 && profile[pos - 1] >= thr) pos--;
  return { pos, confident: true, strength: bestStep, depth: bestR, stepPos: bestPos };
}

function median(arr: Float64Array, lo: number, hi: number): number {
  if (hi <= lo) return 0;
  const s = Float64Array.prototype.slice.call(arr, lo, hi).sort();
  return s[s.length >> 1];
}

function rowProfile(mask: Uint8Array, w: number, h: number, x0: number, x1: number): Float64Array {
  const out = new Float64Array(h);
  const span = Math.max(1, x1 - x0 + 1);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = x0; x <= x1; x++) c += mask[y * w + x];
    out[y] = c / span;
  }
  return out;
}

function colProfile(mask: Uint8Array, w: number, h: number, y0: number, y1: number): Float64Array {
  const out = new Float64Array(w);
  const span = Math.max(1, y1 - y0 + 1);
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = y0; y <= y1; y++) c += mask[y * w + x];
    out[x] = c / span;
  }
  return out;
}

function reversed(a: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[a.length - 1 - i];
  return out;
}

// Does a proposed boundary actually separate two DIFFERENT MATERIALS?
//
// Everything upstream of here reasons about the barrier MASK, and the mask can flip strongly at a
// feature that is not a page edge at all: when the sheet runs off the frame, the sample seeded
// from that side starts on the PAPER, floods up through the paper, and halts at the first strong
// barrier it meets - a stamp, a signature, a band of print. The mask flip there is near-total, so
// the profile filter accepts it, and the honest samples cannot outvote it because they abstain
// (their own profiles never flip at all). That is the bottom edge of 20260727_181149, 11.8% of the
// frame height inside the sheet, cutting through the municipal stamp and the registrar's signature.
//
// Colour is what tells the two apart, and it is the one thing the pipeline never re-checks. Across
// a real page edge the material changes - paper to desk - so the colour step is large. Across a
// phantom interior edge it is paper on both sides, so the colour step is near zero however
// decisively the mask flips.
//
// The scale to compare against is already measured and costs no new constant: leakThreshold is
// literally "the barrier strength of the boundary enclosing this document" in this photo's own
// units. A boundary that is genuinely the page edge steps by about that much; one inside uniform
// paper does not. Both sides of the comparison are in the same COST_QUANT units, so the test is a
// pure ratio and carries the same multiplicative tone-invariance as the leak reading itself.
//
// The step is summarised over the side's span with a MEDIAN, because that population is exactly
// the contaminated kind - part page edge, part whatever else lies along that line.
function boundaryColourStep(
  work: Work, side: Side, box: Rect, pos: number, depth: number,
): number {
  const { rgb, w, h } = work;
  const vertical = side === 'top' || side === 'bottom';
  const spanLo = vertical ? box.left : box.top;
  const spanHi = vertical ? box.right : box.bottom;
  const axisLen = vertical ? h : w;
  const inward = side === 'top' || side === 'left' ? 1 : -1;
  const at = side === 'top' || side === 'left' ? pos : axisLen - 1 - pos;

  const px = (line: number, k: number): number => {
    const c = at + inward * k;
    if (c < 0 || c >= axisLen) return -1;
    return vertical ? c * w + line : line * w + c;
  };

  const steps: number[] = [];
  for (let line = spanLo; line <= spanHi; line++) {
    let ir = 0, ig = 0, ib = 0, iN = 0, o0 = 0, o1 = 0, o2 = 0, oN = 0;
    for (let k = 0; k < depth; k++) {
      const i = px(line, k);
      if (i >= 0) { ir += rgb[i * 3]; ig += rgb[i * 3 + 1]; ib += rgb[i * 3 + 2]; iN++; }
      const o = px(line, -1 - k);
      if (o >= 0) { o0 += rgb[o * 3]; o1 += rgb[o * 3 + 1]; o2 += rgb[o * 3 + 2]; oN++; }
    }
    if (!iN || !oN) continue;
    steps.push(Math.abs(ir / iN - o0 / oN) + Math.abs(ig / iN - o1 / oN) + Math.abs(ib / iN - o2 / oN));
  }
  if (steps.length === 0) return 0;
  steps.sort((a, b) => a - b);
  return COST_QUANT * steps[steps.length >> 1];
}


// One refinement pass.
//
// Every side is snapped against EVERY available background sample and keeps the reading with the
// strongest step. There is no single seed that is always right: a whole-frame seed is spoiled
// when the document itself runs off the frame (the flood then starts on the paper), and a
// single-side seed is spoiled when some other object happens to cover that border (a desk mat
// along the bottom of the frame). Both failures show up the same way - a weak, ambiguous step -
// while a sample that genuinely sees background right up to the page produces a near-total flip
// of the row/column composition. So the sides arbitrate on evidence rather than on a rule about
// which seed to trust, and each side may end up trusting a different sample.
function refine(work: Work, masks: Uint8Array[], leaks: number[], box: Rect): Rect {
  const { w, h } = work;
  const scale = leaks.reduce((a, b) => (b > a ? b : a), 0);
  const midY = Math.floor((box.top + box.bottom) / 2);
  const midX = Math.floor((box.left + box.right) / 2);

  // A side keeps the strongest reading among the samples, but only among readings that actually
  // separate two different materials - see boundaryColourStep. A reading whose colour step falls
  // short of the barrier strength enclosing this document is an interior feature, not a page edge.
  const best = (side: Side, profileOf: (m: Uint8Array) => Float64Array, limit: number, axisLen: number): SnapResult => {
    let out: SnapResult | null = null;
    masks.forEach((m) => {
      const r = snapSide(profileOf(m), limit, axisLen);
      if (r.confident && boundaryColourStep(work, side, box, r.stepPos, r.depth) < scale) return;
      if (!out || r.strength > out.strength) out = r;
    });
    return out ?? { pos: 0, confident: false, strength: -Infinity, depth: 1, stepPos: 0 };
  };

  const top = best('top', (m) => rowProfile(m, w, h, box.left, box.right), midY, h);
  const bottom = best('bottom', (m) => reversed(rowProfile(m, w, h, box.left, box.right)), h - 1 - midY, h);
  const left = best('left', (m) => colProfile(m, w, h, box.top, box.bottom), midX, w);
  const right = best('right', (m) => reversed(colProfile(m, w, h, box.top, box.bottom)), w - 1 - midX, w);

  return {
    top: top.confident ? top.pos : box.top,
    bottom: bottom.confident ? h - 1 - bottom.pos : box.bottom,
    left: left.confident ? left.pos : box.left,
    right: right.confident ? w - 1 - right.pos : box.right,
  };
}

// -------------------------------------------------------------- boundary-evidence admissibility
//
// THE FAILURE THIS GUARDS AGAINST
//
// Everything above assumes the photograph contains background. When it does not - a scan, a
// close-up capture, a PDF page render, a screenshot, or simply a second pass over this detector's
// own output - the frame is document edge to edge. The flood is then seeded ON THE PAPER, the page
// interior settles at zero cost, and the only thing left that costs anything to reach is the
// PRINTED CONTENT. The leak reading, the centre component and the per-side profile flips all still
// produce confident, well-formed answers; they are simply answering a different question, and the
// box comes back around an interior text block. That destroys content, and it is not idempotent:
// running the detector over its own output eats the page.
//
// The pipeline cannot see this from the inside, because every quantity it uses is self-scaling.
// When print becomes the boundary, the leak threshold becomes print strength, and every ratio
// measured against it looks exactly as healthy as it did on a real page edge. The evidence has to
// come from the two things the pipeline never asks about: what lies OUTSIDE the proposed box, and
// whether the material out there is actually different from the material inside.
//
// TWO ADMISSIBILITY TESTS. Both are ratios of quantities this photograph has already measured.
// Neither introduces an absolute intensity, an absolute gradient or a pixel count.
//
//   A. BACKGROUND PURITY. If the region outside the box is background then, by the definition of
//      the barrier map, it is what the flood reached CHEAPLY - so almost none of it may sit above
//      that sample's own leak threshold. Whatever is up there is a second enclosed object, and when
//      the frame is full of document that is exactly what the annulus is full of: more print.
//      Read off the RAW above-threshold masks, before centre-component isolation, which exists to
//      throw the annulus away and would destroy this evidence.
//
//   B. MATERIAL DISTINCTNESS. A page edge separates two materials; a printed rule has paper on both
//      sides. So the BULK colour difference between the inside and the annulus must exceed the
//      barrier strength that supposedly separates them. Both sides of that comparison already
//      exist, in the same units, so this test costs no constant at all: `scale` is the leak
//      strength in COST_QUANT units and the bulk difference is a difference of medians in raw
//      intensity, which COST_QUANT converts. A boundary STRONGER than the material difference it
//      claims to divide is not an edge, it is print. Medians on both sides, because both
//      populations are contaminated - the inside by its own print, the outside by whatever else
//      happens to be lying on the desk.
//
// Failing either test means this photograph offers no evidence of a document sitting on anything.
// The honest answer is then no crop at all.

// --- DIMENSIONLESS: the only constant this guard adds. The largest fraction of the region outside
// the box that may sit above the leak threshold and still be called background. A fraction of a
// population, so it is invariant to resolution, tone, exposure and camera; it is not a pixel count,
// an intensity or a gradient.
//
// Calibrated against the STRESSED populations, not the identity ones: measured over a 12-point
// photometric/scale grid (gamma 0.80-0.95, gain 0.85-1.08, downscale 0.4x/0.6x) across both the
// genuine and the fills-frame corpora. Genuine documents-on-a-desk peak at 0.1490 (one photo with a
// second sheet and its shadow left in frame, at gamma 0.85); frames that are entirely document and
// that test B does not already catch bottom out at 0.1850. This value is the geometric centre of
// that window.
//
// Calibrating on the identity images alone gives 0.125, which sits BELOW the genuine population's
// own exposure excursion - at gamma 0.90 or gain 0.85 the guard then fires on a real photo and the
// crop benchmark falls from 0.968/16 to 0.949/15. A threshold must clear the spread the statistic
// shows under ordinary exposure variation, not merely the spread one fixed set of exposures shows.
export const MAX_ANNULUS_IMPURITY = 0.165;

const ALL_SIDES: Side[] = ['top', 'bottom', 'left', 'right'];

// The ungated box in WORKING pixel coordinates, plus the two admissibility statistics. Kept
// separate from the decision (isAdmissibleCrop) so the operating point can be swept on the crop and
// fills-frame benches without editing the detector.
export interface DocumentBoxResult {
  box: Rect | null;
  impurity: number;
  distinctness: number;
}

// The detector proper. `rgb` is the already-prepared working image: decoded, resampled to at most
// WORK_MAX_DIM on its longer side, packed 3 real-valued channels per pixel, and box-blurred at
// radius max(1, round(BLUR_FRAC * min(w, h))). Infrastructure builds that; see image-processor.ts.
export function detectDocumentBox(rgb: Float32Array, w: number, h: number): DocumentBoxResult {
  const none: DocumentBoxResult = { box: null, impurity: 0, distinctness: 0 };
  if (w < 1 || h < 1) return none;
  const work: Work = { rgb, w, h };

  // Five independent background samples of the same photo: one seeded from the whole frame border,
  // and one from each border line on its own. Each is thresholded at its OWN measured leak point
  // and reduced to its own centre-covering component. The RAW above-threshold masks are kept as
  // well - see test A.
  const masks: Uint8Array[] = [];
  const raws: Uint8Array[] = [];
  const boxes: Rect[] = [];
  const leaks: number[] = [];
  for (const seeds of [ALL_SIDES, ...ALL_SIDES.map((s) => [s])]) {
    const c = barrierMap(work, seeds);
    const t = leakThreshold(c);
    const raw = maskFromCost(c, t);
    const cc = centreComponent(raw, w, h);
    if (cc) { masks.push(cc.mask); raws.push(raw); boxes.push(cc.box); leaks.push(t); }
  }
  if (masks.length === 0) return none; // nothing covers the middle of the photograph: no crop

  // Anchor: the tightest of the samples' boxes. Each box already contains the frame centre, so the
  // smallest of them is the sample that resolved the most boundary; the sides then refine from
  // there and are free to push any side back out to the frame border.
  const coarse = boxes.reduce((a, b) =>
    (b.right - b.left) * (b.bottom - b.top) < (a.right - a.left) * (a.bottom - a.top) ? b : a);

  let box = refine(work, masks, leaks, coarse);
  box = refine(work, masks, leaks, box);

  const left = clamp(box.left, 0, w - 1);
  const top = clamp(box.top, 0, h - 1);
  const right = clamp(box.right, left, w - 1);
  const bottom = clamp(box.bottom, top, h - 1);
  const rect: Rect = { left, top, right, bottom };

  // Both admissibility tests read the same interior/annulus partition; building it once halves the
  // guard's cost (it walks the whole frame).
  const split = splitFrame(work, rect);

  return {
    box: rect,
    impurity: annulusImpurity(split, raws),
    distinctness: materialDistinctness(work, split, leaks),
  };
}

// The admissibility decision, kept in one place so production and the unit tests apply exactly the
// same rule. A false verdict on a NON-null box is not "I found nothing" — it is the much stronger
// "this frame IS the document, cropping it would destroy content". Callers must not treat the two
// the same way; see infrastructure/crop-detector.ts.
export function isAdmissibleCrop(r: DocumentBoxResult): boolean {
  if (!r.box) return false;
  if (r.impurity > MAX_ANNULUS_IMPURITY) return false; // the annulus is not background
  if (r.distinctness <= 1) return false;               // the annulus is the same material as the box
  return true;
}

// Split the frame into the box interior and the annulus outside it, both eroded by the matched
// filter's own radius so the boundary transition belongs to neither.
export function splitFrame(work: Work, box: Rect): { inside: number[]; outside: number[] } {
  const { w, h } = work;
  const band = Math.max(1, Math.round(STEP_FRAC * Math.min(w, h)));
  const inside: number[] = [];
  const outside: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBand =
        x >= box.left - band && x <= box.right + band && y >= box.top - band && y <= box.bottom + band &&
        Math.min(Math.abs(x - box.left), Math.abs(x - box.right), Math.abs(y - box.top), Math.abs(y - box.bottom)) < band;
      if (inBand) continue;
      const isIn = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      (isIn ? inside : outside).push(y * w + x);
    }
  }
  return { inside, outside };
}

// TEST A. What fraction of the annulus is NOT background?
//
// Every sample is a background hypothesis and they disagree - a seed line that started on the
// document produces a mask that is above threshold nearly everywhere. So the annulus is read off
// the sample that best supports the proposed box: the one whose above-threshold mask most cleanly
// fills the inside and vacates the outside. That is the same evidence-not-rule arbitration the side
// snapping already uses, applied once more to the box as a whole. A single spoiled seed therefore
// cannot condemn a good photograph - and no seed can rescue a bad one, because in a frame that is
// entirely document EVERY seed starts on the paper and every annulus is full of print.
export function annulusImpurity(split: { inside: number[]; outside: number[] }, raws: Uint8Array[]): number {
  const { inside, outside } = split;
  if (outside.length === 0) return 0; // the box is the whole frame: cropping is already a no-op
  let impurity = 1;
  let bestSupport = -Infinity;
  for (const m of raws) {
    let a = 0, b = 0;
    for (const i of inside) a += m[i];
    for (const i of outside) b += m[i];
    const rIn = inside.length ? a / inside.length : 0;
    const rOut = b / outside.length;
    if (rIn - rOut > bestSupport) { bestSupport = rIn - rOut; impurity = rOut; }
  }
  return impurity;
}

// TEST B. How many barrier strengths apart are the two materials?
//
// The bulk colour difference between the inside and the annulus, expressed as a multiple of this
// photograph's own leak strength. Above 1 the two regions differ by more than the boundary that
// divides them - a page on a desk. Below 1 the "boundary" is stronger than the difference it claims
// to separate, which is what a printed line on uniform paper looks like.
export function materialDistinctness(work: Work, split: { inside: number[]; outside: number[] }, leaks: number[]): number {
  const scale = leaks.reduce((a, b) => (b > a ? b : a), 0);
  if (scale <= 0) return Infinity;
  const { inside, outside } = split;
  // Fail CLOSED on an empty interior and OPEN on an empty annulus. These two degeneracies are not
  // symmetric: an empty annulus means the box is the whole frame, so cropping is already a no-op and
  // there is nothing to veto; an empty interior means the box collapsed to nothing, the most
  // destructive answer available, and a test that returned Infinity there would wave it through.
  if (!inside.length) return 0;
  if (!outside.length) return Infinity;
  const medianColour = (idx: number[]): number[] => {
    const out: number[] = [];
    for (let c = 0; c < 3; c++) {
      const a = Float64Array.from(idx, (i) => work.rgb[i * 3 + c]).sort();
      out.push(a[a.length >> 1]);
    }
    return out;
  };
  const mi = medianColour(inside);
  const mo = medianColour(outside);
  const sep = Math.abs(mi[0] - mo[0]) + Math.abs(mi[1] - mo[1]) + Math.abs(mi[2] - mo[2]);
  return (COST_QUANT * sep) / scale;
}
