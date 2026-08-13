import { describe, it, expect, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// Unlike image-to-pdf.test.ts (which mocks both neighbors), this file mocks ONLY vision-client
// — the one making real Ollama network calls — and lets the REAL image-processor.ts run against
// a real synthetic PNG, to prove runVisionPipeline actually composes with real canvas operations
// (rotate/crop/enhance), not just with mocks that happen to satisfy the interface.
const { detectOrientationMock, detectCropBoxMock } = vi.hoisted(() => ({
  detectOrientationMock: vi.fn(),
  detectCropBoxMock: vi.fn(),
}));
vi.mock('../infrastructure/vision-client.js', () => ({
  detectOrientation: detectOrientationMock,
  detectCropBox: detectCropBoxMock,
}));

async function makeTestPng(w: number, h: number): Promise<Buffer> {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(200,200,200)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgb(20,20,20)';
  ctx.fillRect(0, 0, Math.max(1, Math.floor(w / 4)), Math.max(1, Math.floor(h / 4)));
  return canvas.toBuffer('image/png');
}

describe('runVisionPipeline (real image-processor)', () => {
  it('composes with real rotate/crop/enhance operations end-to-end and produces decodable images at every step', async () => {
    detectOrientationMock.mockResolvedValue({ rotationDegrees: 90, raw: '{"rotationDegrees":90}' });
    detectCropBoxMock.mockResolvedValue({ cropBox: { x: 5, y: 5, width: 50, height: 40 }, raw: '{"cropBox":{"x":5,"y":5,"width":50,"height":40}}' });

    const buf = await makeTestPng(100, 80);
    const { runVisionPipeline } = await import('./image-to-pdf.js');
    const steps = await runVisionPipeline(buf);

    expect(steps.map(s => s.label)).toEqual(['original', 'oriented', 'cropped', 'enhanced']);

    for (const step of steps) {
      expect(step.error).toBeUndefined();
      expect(step.imageBase64.length).toBeGreaterThan(0);
      const img = await loadImage(Buffer.from(step.imageBase64, 'base64'));
      expect(img.width).toBeGreaterThan(0);
      expect(img.height).toBeGreaterThan(0);
    }

    // Rotation swaps width/height (90 deg on 100x80), crop narrows it further.
    const orientedImg = await loadImage(Buffer.from(steps[1].imageBase64, 'base64'));
    expect(orientedImg.width).toBe(80);
    expect(orientedImg.height).toBe(100);

    const croppedImg = await loadImage(Buffer.from(steps[2].imageBase64, 'base64'));
    expect(croppedImg.width).toBe(50);
    expect(croppedImg.height).toBe(40);
  });
});
