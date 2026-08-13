import { describe, it, expect } from 'vitest';
import { findBlackWhitePoints, autoLevelsFromBlackWhite, sharpenPixel, AUTO_ADJUST_SHARPNESS } from './image-adjust.js';

describe('findBlackWhitePoints', () => {
  it('clips outlier pixels and lands the black/white points on the real tonal extremes', () => {
    // 3px each at 0/255 (outliers), 88 midtone at 128, 3px each at 10/245 (the "real" extremes)
    const gray = new Uint8ClampedArray(100);
    let i = 0;
    for (let k = 0; k < 3; k++) gray[i++] = 0;
    for (let k = 0; k < 3; k++) gray[i++] = 10;
    for (let k = 0; k < 88; k++) gray[i++] = 128;
    for (let k = 0; k < 3; k++) gray[i++] = 245;
    for (let k = 0; k < 3; k++) gray[i++] = 255;
    const { black, white } = findBlackWhitePoints(gray, 0.03);
    expect(black).toBe(10);
    expect(white).toBe(245);
  });

  it('a perfectly flat image has black point = white point', () => {
    const gray = new Uint8ClampedArray(50).fill(128);
    const { black, white } = findBlackWhitePoints(gray, 0.01);
    expect(black).toBe(128);
    expect(white).toBe(128);
  });
});

describe('autoLevelsFromBlackWhite', () => {
  it('already full-range (0..255) needs no adjustment', () => {
    expect(autoLevelsFromBlackWhite(0, 255)).toEqual({ brightness: 0, contrast: 0 });
  });

  it('underexposed/low-contrast range brightens and boosts contrast to fill 0..255', () => {
    expect(autoLevelsFromBlackWhite(26, 204)).toEqual({ brightness: 11, contrast: 29 });
  });

  it('near-flat range (black ≈ white) bails out rather than amplifying noise', () => {
    expect(autoLevelsFromBlackWhite(120, 124)).toEqual({ brightness: 0, contrast: 0 });
  });

  it('an extreme stretch clamps brightness at +50', () => {
    const extreme = autoLevelsFromBlackWhite(0, 26);
    expect(extreme.brightness).toBe(50);
    expect(extreme.contrast).toBe(0);
  });
});

describe('sharpenPixel', () => {
  it('amount=0 leaves the pixel unchanged', () => {
    expect(sharpenPixel(100, 90, 90, 90, 90, 0)).toBe(100);
  });

  it('amount=100 boosts a brighter-than-neighbors pixel', () => {
    expect(sharpenPixel(100, 90, 90, 90, 90, 100)).toBe(140);
  });

  it('amount=100 darkens a dimmer-than-neighbors pixel', () => {
    expect(sharpenPixel(100, 110, 110, 110, 110, 100)).toBe(60);
  });

  it('result clamps at 255', () => {
    expect(sharpenPixel(250, 0, 0, 0, 0, 100)).toBe(255);
  });

  it('result clamps at 0', () => {
    expect(sharpenPixel(5, 255, 255, 255, 255, 100)).toBe(0);
  });
});

describe('AUTO_ADJUST_SHARPNESS', () => {
  it('is the fixed default of 25 (no reliable single-photo blur measurement, same as pdf-awesome)', () => {
    expect(AUTO_ADJUST_SHARPNESS).toBe(25);
  });
});
