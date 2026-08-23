import { describe, it, expect } from 'vitest';
import { fitImageToA4, A4_SHORT_SIDE, A4_LONG_SIDE } from './pdf-page-fit.js';

describe('fitImageToA4', () => {
  it('gives a portrait photo a portrait page', () => {
    const p = fitImageToA4(1154, 2051);
    expect(p.pageWidth).toBe(A4_SHORT_SIDE);
    expect(p.pageHeight).toBe(A4_LONG_SIDE);
  });

  it('gives a landscape photo a landscape page rather than letterboxing it', () => {
    const p = fitImageToA4(2227, 1253);
    expect(p.pageWidth).toBe(A4_LONG_SIDE);
    expect(p.pageHeight).toBe(A4_SHORT_SIDE);
  });

  it('preserves the aspect ratio', () => {
    const p = fitImageToA4(1000, 2000);
    expect(p.drawWidth / p.drawHeight).toBeCloseTo(1000 / 2000, 6);
  });

  it('fits inside the page without cropping or stretching', () => {
    for (const [w, h] of [[1154, 2051], [2227, 1253], [1000, 1000], [4000, 300]]) {
      const p = fitImageToA4(w, h);
      expect(p.drawWidth).toBeLessThanOrEqual(p.pageWidth + 1e-9);
      expect(p.drawHeight).toBeLessThanOrEqual(p.pageHeight + 1e-9);
    }
  });

  it('centres the image on the page', () => {
    const p = fitImageToA4(1000, 3000);
    expect(p.x).toBeCloseTo((p.pageWidth - p.drawWidth) / 2, 6);
    expect(p.y).toBeCloseTo((p.pageHeight - p.drawHeight) / 2, 6);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });

  it('touches the limiting edge exactly, so the page is actually filled in one dimension', () => {
    // A very wide image is width-limited: it should span the full page width.
    const wide = fitImageToA4(4000, 300);
    expect(wide.drawWidth).toBeCloseTo(wide.pageWidth, 6);
    // A very tall one is height-limited.
    const tall = fitImageToA4(300, 4000);
    expect(tall.drawHeight).toBeCloseTo(tall.pageHeight, 6);
  });

  it('is scale-invariant — the same photo at two resolutions lays out identically', () => {
    const small = fitImageToA4(1154, 2051);
    const large = fitImageToA4(2308, 4102);
    expect(large.drawWidth).toBeCloseTo(small.drawWidth, 6);
    expect(large.drawHeight).toBeCloseTo(small.drawHeight, 6);
  });

  it('falls back to a full portrait page on a degenerate size instead of producing NaN', () => {
    for (const [w, h] of [[0, 100], [100, 0], [-5, 10], [Number.NaN, 100]]) {
      const p = fitImageToA4(w, h);
      expect(Number.isFinite(p.drawWidth)).toBe(true);
      expect(Number.isFinite(p.drawHeight)).toBe(true);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.pageWidth).toBe(A4_SHORT_SIDE);
      expect(p.pageHeight).toBe(A4_LONG_SIDE);
    }
  });
});
