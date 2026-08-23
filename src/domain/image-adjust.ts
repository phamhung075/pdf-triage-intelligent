// Ported from pdf-awesome's js/domain/auto-adjust.js and js/domain/adjust.js — both are
// already pure/framework-agnostic functions with no DOM or canvas dependency, so they carry
// over unchanged. See pdf-awesome/tests/test.js for the original validated test cases.

export const AUTO_ADJUST_SHARPNESS = 25;

// Fraction of pixels clipped as outliers at each end of the histogram before picking the
// black/white points, so a few stray dark/bright specks (shadows, glare) don't skew the stretch.
export const AUTO_LEVELS_CLIP_PCT = 0.01;

// Black/white points closer than this (0..1 normalized) mean the image is close to a single
// flat tone — nothing safe to stretch, so bail out rather than amplifying noise.
export const AUTO_LEVELS_MIN_RANGE = 0.05;

// Scans a grayscale histogram from both ends and returns the value where the running pixel
// count first exceeds clipPct of the total — the darkest/lightest points once the tiny
// outlier tails are ignored.
export function findBlackWhitePoints(gray: Uint8ClampedArray, clipPct: number): { black: number; white: number } {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  const clipCount = total * clipPct;

  let cum = 0, black = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum > clipCount) { black = v; break; }
  }
  cum = 0;
  let white = 255;
  for (let v = 255; v >= 0; v--) {
    cum += hist[v];
    if (cum > clipCount) { white = v; break; }
  }
  return { black, white };
}

// Solves for CSS brightness()/contrast() multipliers k1/k2 such that the composed transform
// contrast(brightness(x)) maps black->0 and white->1, then converts those multipliers into
// +/-50 delta sliders (brightness(1 + b/100) / contrast(1 + c/100)).
export function autoLevelsFromBlackWhite(black: number, white: number): { brightness: number; contrast: number } {
  const l = black / 255, h = white / 255;
  if (h - l < AUTO_LEVELS_MIN_RANGE) return { brightness: 0, contrast: 0 };

  const sum = l + h;
  const range = h - l;
  const k1 = sum > 0.01 ? 1 / sum : 1;
  const k2 = sum > 0.01 ? sum / range : 1;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  return {
    brightness: Math.round(clamp((k1 - 1) * 100, -50, 50)),
    contrast: Math.round(clamp((k2 - 1) * 100, -50, 50)),
  };
}

// Blended 3x3 Laplacian/unsharp kernel: identity at amount=0, full sharpen at amount=100.
export function sharpenPixel(center: number, n: number, s: number, w: number, e: number, amount: number): number {
  const t = amount / 100;
  const v = (1 + 4 * t) * center - t * (n + s + w + e);
  return Math.max(0, Math.min(255, v));
}
