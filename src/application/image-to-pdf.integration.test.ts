import { describe, it, expect, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// Unlike image-to-pdf.test.ts (which mocks every neighbor), this file mocks ONLY the things
// that themselves wrap real Ollama/PaddleOCR/Tesseract calls (the two cascades, the both-engines
// OCR function, and the markdown conversion) and lets the REAL image-processor.ts run against a
// real synthetic PNG, to prove the step functions actually compose with real canvas operations
// (rotate/crop/enhance), not just with mocks that happen to satisfy the interface.
const { detectOrientationCascadeMock } = vi.hoisted(() => ({ detectOrientationCascadeMock: vi.fn() }));
vi.mock('../infrastructure/orientation-detector.js', () => ({ detectOrientationCascade: detectOrientationCascadeMock }));

const { detectCropBoxCascadeMock } = vi.hoisted(() => ({ detectCropBoxCascadeMock: vi.fn() }));
vi.mock('../infrastructure/crop-detector.js', () => ({ detectCropBoxCascade: detectCropBoxCascadeMock }));

const { ocrImageBufferBothEnginesMock } = vi.hoisted(() => ({ ocrImageBufferBothEnginesMock: vi.fn() }));
vi.mock('../infrastructure/pdf-extractor.js', () => ({ ocrImageBufferBothEngines: ocrImageBufferBothEnginesMock }));

const { convertRawTextToZeroLossMarkdownMock } = vi.hoisted(() => ({ convertRawTextToZeroLossMarkdownMock: vi.fn() }));
vi.mock('./classify-document.js', () => ({ convertRawTextToZeroLossMarkdown: convertRawTextToZeroLossMarkdownMock }));

async function makeTestPng(w: number, h: number): Promise<Buffer> {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(200,200,200)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgb(20,20,20)';
  ctx.fillRect(0, 0, Math.max(1, Math.floor(w / 4)), Math.max(1, Math.floor(h / 4)));
  return canvas.toBuffer('image/png');
}

describe('vision-lab step functions (real image-processor)', () => {
  it('compose with real rotate/crop/enhance operations end-to-end and produce decodable images at every step', async () => {
    detectOrientationCascadeMock.mockResolvedValue({
      rotationDegrees: 90,
      exifDegrees: null,
      modelDegrees: 90,
      modelRaw: '{"rotationDegrees":90}',
      ocrDegrees: null,
      ocrConfidence: null,
      source: 'exif+model-agree',
    });
    detectCropBoxCascadeMock.mockResolvedValue({
      cropBox: { x: 5, y: 5, width: 50, height: 40 },
      modelCropBox: { x: 5, y: 5, width: 50, height: 40 },
      modelRaw: '{"cropBox":{"x":5,"y":5,"width":50,"height":40}}',
      floodCropBox: null,
      source: 'model-flood-agree',
    });
    ocrImageBufferBothEnginesMock.mockResolvedValue({
      paddleOcr: { text: 'mock extracted text' },
      tesseract: { text: 'mock extracted text' },
    });
    convertRawTextToZeroLossMarkdownMock.mockResolvedValue('# Mock Markdown');

    const buf = await makeTestPng(100, 80);
    const { runOrientStep, runCropStep, runEnhanceStep, runExtractStep } = await import('./image-to-pdf.js');

    const orientResult = await runOrientStep(buf);
    expect(orientResult.error).toBeUndefined();
    const orientedImg = await loadImage(Buffer.from(orientResult.imageBase64, 'base64'));
    expect(orientedImg.width).toBe(80);
    expect(orientedImg.height).toBe(100);

    const cropResult = await runCropStep(Buffer.from(orientResult.imageBase64, 'base64'));
    expect(cropResult.error).toBeUndefined();
    const croppedImg = await loadImage(Buffer.from(cropResult.imageBase64, 'base64'));
    expect(croppedImg.width).toBe(50);
    expect(croppedImg.height).toBe(40);

    const enhanceResult = await runEnhanceStep(Buffer.from(cropResult.imageBase64, 'base64'));
    expect(enhanceResult.error).toBeUndefined();
    expect(enhanceResult.imageBase64.length).toBeGreaterThan(0);
    const enhancedImg = await loadImage(Buffer.from(enhanceResult.imageBase64, 'base64'));
    expect(enhancedImg.width).toBeGreaterThan(0);
    expect(enhancedImg.height).toBeGreaterThan(0);

    const extractResult = await runExtractStep(Buffer.from(enhanceResult.imageBase64, 'base64'));
    expect(extractResult.error).toBeUndefined();
    expect(extractResult.markdown).toBe('# Mock Markdown');
  });
});
