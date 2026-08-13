import { describe, it, expect } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { rotateImage, cropImage, computeAutoLevelsForImage, applyBrightnessContrast, applySharpen } from './image-processor.js';

async function makeTestPng(w: number, h: number): Promise<Buffer> {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(200,200,200)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgb(20,20,20)';
  ctx.fillRect(0, 0, Math.max(1, Math.floor(w / 4)), Math.max(1, Math.floor(h / 4)));
  return canvas.toBuffer('image/png');
}

describe('rotateImage', () => {
  it('returns the input unchanged for degrees=0', async () => {
    const buf = await makeTestPng(10, 6);
    const result = await rotateImage(buf, 0);
    expect(result).toBe(buf);
  });

  it('swaps width/height for a 90 degree rotation', async () => {
    const buf = await makeTestPng(10, 6);
    const result = await rotateImage(buf, 90);
    const img = await loadImage(result);
    expect(img.width).toBe(6);
    expect(img.height).toBe(10);
  });

  it('swaps width/height for a 270 degree rotation', async () => {
    const buf = await makeTestPng(10, 6);
    const result = await rotateImage(buf, 270);
    const img = await loadImage(result);
    expect(img.width).toBe(6);
    expect(img.height).toBe(10);
  });

  it('keeps the same width/height for a 180 degree rotation', async () => {
    const buf = await makeTestPng(10, 6);
    const result = await rotateImage(buf, 180);
    const img = await loadImage(result);
    expect(img.width).toBe(10);
    expect(img.height).toBe(6);
  });
});

describe('cropImage', () => {
  it('produces exactly the requested dimensions when the box is fully inside bounds', async () => {
    const buf = await makeTestPng(100, 80);
    const result = await cropImage(buf, { x: 10, y: 10, width: 50, height: 40 });
    const img = await loadImage(result);
    expect(img.width).toBe(50);
    expect(img.height).toBe(40);
  });

  it('clamps a box that extends past the image bounds', async () => {
    const buf = await makeTestPng(100, 80);
    const result = await cropImage(buf, { x: 90, y: 70, width: 50, height: 40 });
    const img = await loadImage(result);
    expect(img.width).toBeLessThanOrEqual(10);
    expect(img.height).toBeLessThanOrEqual(10);
  });
});

describe('computeAutoLevelsForImage', () => {
  it('boosts contrast for a low-contrast synthetic document', async () => {
    const canvas = createCanvas(100, 100);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(200,200,200)';
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = 'rgb(60,60,60)';
    ctx.fillRect(0, 0, 15, 15);
    const buf = canvas.toBuffer('image/png');

    const levels = await computeAutoLevelsForImage(buf);
    expect(levels.contrast).toBeGreaterThan(20);
    expect(Math.abs(levels.brightness)).toBeLessThan(20);
  });
});

describe('applyBrightnessContrast', () => {
  it('returns the input unchanged when both deltas are zero', async () => {
    const buf = await makeTestPng(10, 10);
    const result = await applyBrightnessContrast(buf, { brightness: 0, contrast: 0 });
    expect(result).toBe(buf);
  });

  it('preserves dimensions and returns a valid decodable PNG when adjusting', async () => {
    const buf = await makeTestPng(10, 10);
    const result = await applyBrightnessContrast(buf, { brightness: 20, contrast: 15 });
    const img = await loadImage(result);
    expect(img.width).toBe(10);
    expect(img.height).toBe(10);
    expect(Buffer.compare(result, buf)).not.toBe(0);
  });
});

describe('applySharpen', () => {
  it('returns the input unchanged when amount is 0', async () => {
    const buf = await makeTestPng(10, 10);
    const result = await applySharpen(buf, 0);
    expect(result).toBe(buf);
  });

  it('changes pixel data for a synthetic image with a hard edge', async () => {
    const buf = await makeTestPng(10, 10);
    const result = await applySharpen(buf, 25);
    expect(Buffer.compare(result, buf)).not.toBe(0);
  });

  it('preserves dimensions after sharpening', async () => {
    const buf = await makeTestPng(10, 10);
    const result = await applySharpen(buf, 25);
    const img = await loadImage(result);
    expect(img.width).toBe(10);
    expect(img.height).toBe(10);
  });
});
