import { describe, it, expect, vi, beforeEach } from 'vitest';

const { detectOrientationCascadeMock } = vi.hoisted(() => ({ detectOrientationCascadeMock: vi.fn() }));
vi.mock('../infrastructure/orientation-detector.js', () => ({
  detectOrientationCascade: detectOrientationCascadeMock,
}));

const { detectCropBoxCascadeMock } = vi.hoisted(() => ({ detectCropBoxCascadeMock: vi.fn() }));
vi.mock('../infrastructure/crop-detector.js', () => ({
  detectCropBoxCascade: detectCropBoxCascadeMock,
}));

const {
  rotateImageMock, cropImageMock, computeAutoLevelsForImageMock,
  applyBrightnessContrastMock, applySharpenMock,
} = vi.hoisted(() => ({
  rotateImageMock: vi.fn(),
  cropImageMock: vi.fn(),
  computeAutoLevelsForImageMock: vi.fn(),
  applyBrightnessContrastMock: vi.fn(),
  applySharpenMock: vi.fn(),
}));
vi.mock('../infrastructure/image-processor.js', () => ({
  rotateImage: rotateImageMock,
  cropImage: cropImageMock,
  computeAutoLevelsForImage: computeAutoLevelsForImageMock,
  applyBrightnessContrast: applyBrightnessContrastMock,
  applySharpen: applySharpenMock,
}));

const { ocrImageBufferBothEnginesMock } = vi.hoisted(() => ({ ocrImageBufferBothEnginesMock: vi.fn() }));
vi.mock('../infrastructure/pdf-extractor.js', () => ({
  ocrImageBufferBothEngines: ocrImageBufferBothEnginesMock,
}));

const { convertRawTextToZeroLossMarkdownMock } = vi.hoisted(() => ({ convertRawTextToZeroLossMarkdownMock: vi.fn() }));
vi.mock('./classify-document.js', () => ({
  convertRawTextToZeroLossMarkdown: convertRawTextToZeroLossMarkdownMock,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

const originalBuf = Buffer.from('original');
const orientedBuf = Buffer.from('oriented');
const croppedBuf = Buffer.from('cropped');
const leveledBuf = Buffer.from('leveled');
const finalBuf = Buffer.from('final');

describe('runOrientStep', () => {
  it('rotates by the cascade-chosen degrees and includes every non-null candidate', async () => {
    detectOrientationCascadeMock.mockResolvedValue({
      rotationDegrees: 90,
      exifDegrees: 90,
      modelDegrees: 0,
      modelRaw: '{"rotationDegrees":0}',
      ocrDegrees: 90,
      ocrConfidence: 5.2,
      source: 'ocr-tiebreaker',
    });
    rotateImageMock.mockImplementation(async (_buf, degrees) =>
      degrees === 90 ? orientedBuf : Buffer.from(`rotated-${degrees}`)
    );

    const { runOrientStep } = await import('./image-to-pdf.js');
    const result = await runOrientStep(originalBuf);

    expect(result.step).toBe(1);
    expect(result.label).toBe('oriented');
    expect(result.imageBase64).toBe(orientedBuf.toString('base64'));
    expect(result.modelRaw).toBe('{"rotationDegrees":0}');
    expect(result.meta).toEqual({ rotationDegrees: 90, exifDegrees: 90, modelDegrees: 0, ocrDegrees: 90, ocrConfidence: 5.2, source: 'ocr-tiebreaker' });

    expect(result.candidates).toHaveLength(3);
    const exif = result.candidates!.find(c => c.label === 'exif');
    const model = result.candidates!.find(c => c.label === 'model');
    const ocr = result.candidates!.find(c => c.label === 'ocr');
    expect(exif).toEqual({ label: 'exif', chosen: true, imageBase64: orientedBuf.toString('base64'), meta: { rotationDegrees: 90 } });
    expect(ocr).toEqual({ label: 'ocr', chosen: true, imageBase64: orientedBuf.toString('base64'), meta: { rotationDegrees: 90 } });
    expect(model).toEqual({ label: 'model', chosen: false, imageBase64: Buffer.from('rotated-0').toString('base64'), meta: { rotationDegrees: 0 } });
  });

  it('omits the EXIF and OCR candidates when their degrees are null', async () => {
    detectOrientationCascadeMock.mockResolvedValue({
      rotationDegrees: 0,
      exifDegrees: null,
      modelDegrees: 0,
      modelRaw: '{"rotationDegrees":0}',
      ocrDegrees: null,
      ocrConfidence: null,
      source: 'exif+model-agree',
    });
    rotateImageMock.mockResolvedValue(orientedBuf);

    const { runOrientStep } = await import('./image-to-pdf.js');
    const result = await runOrientStep(originalBuf);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates![0]).toEqual({ label: 'model', chosen: true, imageBase64: orientedBuf.toString('base64'), meta: { rotationDegrees: 0 } });
  });

  it('records an error and no candidates when orientation detection fails', async () => {
    detectOrientationCascadeMock.mockRejectedValue(new Error('vision model unreachable'));
    const { runOrientStep } = await import('./image-to-pdf.js');
    const result = await runOrientStep(originalBuf);

    expect(result.step).toBe(1);
    expect(result.error).toBe('vision model unreachable');
    expect(result.candidates).toBeUndefined();
    expect(typeof result.durationMs).toBe('number');
  });

  it('isolates a failing candidate render to that candidate, keeping the chosen result intact', async () => {
    detectOrientationCascadeMock.mockResolvedValue({
      rotationDegrees: 90,
      exifDegrees: 90,
      modelDegrees: 0,
      modelRaw: '{"rotationDegrees":0}',
      ocrDegrees: null,
      ocrConfidence: null,
      source: 'exif+model-agree',
    });
    rotateImageMock.mockImplementation(async (_buf, degrees) => {
      if (degrees === 90) return orientedBuf;
      throw new Error('rotate failed for candidate');
    });

    const { runOrientStep } = await import('./image-to-pdf.js');
    const result = await runOrientStep(originalBuf);

    expect(result.error).toBeUndefined();
    expect(result.imageBase64).toBe(orientedBuf.toString('base64'));
    expect(result.candidates).toHaveLength(2);
    const exif = result.candidates!.find(c => c.label === 'exif');
    const model = result.candidates!.find(c => c.label === 'model');
    expect(exif).toEqual({ label: 'exif', chosen: true, imageBase64: orientedBuf.toString('base64'), meta: { rotationDegrees: 90 } });
    expect(model).toEqual({ label: 'model', chosen: false, meta: { rotationDegrees: 0 }, error: 'rotate failed for candidate' });
  });
});

describe('runCropStep', () => {
  it('crops by the cascade-chosen box and includes every non-null candidate', async () => {
    detectCropBoxCascadeMock.mockResolvedValue({
      cropBox: { x: 1, y: 2, width: 3, height: 4 },
      modelCropBox: { x: 1, y: 2, width: 3, height: 4 },
      modelRaw: '{"cropBox":{}}',
      floodCropBox: { x: 9, y: 9, width: 9, height: 9 },
      source: 'model-flood-agree',
    });
    cropImageMock.mockImplementation(async (_buf, box) =>
      box.x === 1 ? croppedBuf : Buffer.from(`cropped-${box.x}`)
    );

    const { runCropStep } = await import('./image-to-pdf.js');
    const result = await runCropStep(orientedBuf);

    expect(result.step).toBe(2);
    expect(result.imageBase64).toBe(croppedBuf.toString('base64'));
    expect(result.candidates).toHaveLength(2);
    const model = result.candidates!.find(c => c.label === 'model');
    const flood = result.candidates!.find(c => c.label === 'flood');
    expect(model).toEqual({ label: 'model', chosen: true, imageBase64: croppedBuf.toString('base64'), meta: { box: { x: 1, y: 2, width: 3, height: 4 } } });
    expect(flood).toEqual({ label: 'flood', chosen: false, imageBase64: Buffer.from('cropped-9').toString('base64'), meta: { box: { x: 9, y: 9, width: 9, height: 9 } } });
  });

  it('uses the oriented image as-is and has no candidates when both boxes are null', async () => {
    detectCropBoxCascadeMock.mockResolvedValue({
      cropBox: null,
      modelCropBox: null,
      modelRaw: '{"cropBox":null}',
      floodCropBox: null,
      source: 'none',
    });
    const { runCropStep } = await import('./image-to-pdf.js');
    const result = await runCropStep(orientedBuf);

    expect(cropImageMock).not.toHaveBeenCalled();
    expect(result.imageBase64).toBe(orientedBuf.toString('base64'));
    expect(result.candidates).toEqual([]);
  });

  it('records an error when crop detection fails', async () => {
    detectCropBoxCascadeMock.mockRejectedValue(new Error('malformed JSON from model'));
    const { runCropStep } = await import('./image-to-pdf.js');
    const result = await runCropStep(orientedBuf);

    expect(result.error).toBe('malformed JSON from model');
  });

  it('isolates a failing candidate render to that candidate, keeping the chosen result intact', async () => {
    detectCropBoxCascadeMock.mockResolvedValue({
      cropBox: { x: 1, y: 2, width: 3, height: 4 },
      modelCropBox: { x: 1, y: 2, width: 3, height: 4 },
      modelRaw: '{"cropBox":{}}',
      floodCropBox: { x: 9, y: 9, width: 9, height: 9 },
      source: 'model-flood-agree',
    });
    cropImageMock.mockImplementation(async (_buf, box) => {
      if (box.x === 1) return croppedBuf;
      throw new Error('crop failed for candidate');
    });

    const { runCropStep } = await import('./image-to-pdf.js');
    const result = await runCropStep(orientedBuf);

    expect(result.error).toBeUndefined();
    expect(result.imageBase64).toBe(croppedBuf.toString('base64'));
    expect(result.candidates).toHaveLength(2);
    const model = result.candidates!.find(c => c.label === 'model');
    const flood = result.candidates!.find(c => c.label === 'flood');
    expect(model).toEqual({ label: 'model', chosen: true, imageBase64: croppedBuf.toString('base64'), meta: { box: { x: 1, y: 2, width: 3, height: 4 } } });
    expect(flood).toEqual({ label: 'flood', chosen: false, meta: { box: { x: 9, y: 9, width: 9, height: 9 } }, error: 'crop failed for candidate' });
  });
});

describe('runEnhanceStep', () => {
  it('applies auto-levels and sharpen, with no candidates field', async () => {
    computeAutoLevelsForImageMock.mockResolvedValue({ brightness: 5, contrast: 6 });
    applyBrightnessContrastMock.mockResolvedValue(leveledBuf);
    applySharpenMock.mockResolvedValue(finalBuf);

    const { runEnhanceStep } = await import('./image-to-pdf.js');
    const result = await runEnhanceStep(croppedBuf);

    expect(result.step).toBe(3);
    expect(result.imageBase64).toBe(finalBuf.toString('base64'));
    expect(result.meta).toEqual({ brightness: 5, contrast: 6, sharpness: 25 });
    expect(result.candidates).toBeUndefined();
    expect(applyBrightnessContrastMock).toHaveBeenCalledWith(croppedBuf, { brightness: 5, contrast: 6 });
    expect(applySharpenMock).toHaveBeenCalledWith(leveledBuf, 25);
  });

  it('records an error when enhancement fails', async () => {
    computeAutoLevelsForImageMock.mockResolvedValue({ brightness: 0, contrast: 0 });
    applyBrightnessContrastMock.mockResolvedValue(leveledBuf);
    applySharpenMock.mockRejectedValue(new Error('canvas encode failed'));

    const { runEnhanceStep } = await import('./image-to-pdf.js');
    const result = await runEnhanceStep(croppedBuf);

    expect(result.error).toBe('canvas encode failed');
  });
});

describe('runExtractStep', () => {
  it('prefers PaddleOCR text and returns all 3 candidates with markdown chosen by default', async () => {
    ocrImageBufferBothEnginesMock.mockResolvedValue({
      paddleOcr: { text: 'paddle raw text' },
      tesseract: { text: 'tesseract raw text' },
    });
    convertRawTextToZeroLossMarkdownMock.mockResolvedValue('# Extracted\n\npaddle raw text');

    const { runExtractStep } = await import('./image-to-pdf.js');
    const result = await runExtractStep(finalBuf);

    expect(result.step).toBe(4);
    expect(result.label).toBe('extracted');
    expect(result.imageBase64).toBe('');
    expect(result.markdown).toBe('# Extracted\n\npaddle raw text');
    expect(result.meta).toEqual({ rawTextLength: 'paddle raw text'.length });
    expect(convertRawTextToZeroLossMarkdownMock).toHaveBeenCalledWith('paddle raw text', 'vision-lab-diagnostic');

    expect(result.candidates).toEqual([
      { label: 'markdown', chosen: true, text: '# Extracted\n\npaddle raw text' },
      { label: 'paddleocr', chosen: false, text: 'paddle raw text', error: undefined },
      { label: 'tesseract', chosen: false, text: 'tesseract raw text', error: undefined },
    ]);
  });

  it('falls back to Tesseract text for markdown when PaddleOCR failed, and surfaces its error as a candidate', async () => {
    ocrImageBufferBothEnginesMock.mockResolvedValue({
      paddleOcr: { error: 'PaddleOCR server is unavailable' },
      tesseract: { text: 'tesseract raw text' },
    });
    convertRawTextToZeroLossMarkdownMock.mockResolvedValue('# Extracted\n\ntesseract raw text');

    const { runExtractStep } = await import('./image-to-pdf.js');
    const result = await runExtractStep(finalBuf);

    expect(convertRawTextToZeroLossMarkdownMock).toHaveBeenCalledWith('tesseract raw text', 'vision-lab-diagnostic');
    expect(result.candidates).toEqual([
      { label: 'markdown', chosen: true, text: '# Extracted\n\ntesseract raw text' },
      { label: 'paddleocr', chosen: false, text: undefined, error: 'PaddleOCR server is unavailable' },
      { label: 'tesseract', chosen: false, text: 'tesseract raw text', error: undefined },
    ]);
  });

  it('records no step-level error when both engines fail — the failures surface on the candidates instead', async () => {
    ocrImageBufferBothEnginesMock.mockResolvedValue({
      paddleOcr: { error: 'PaddleOCR server is unavailable' },
      tesseract: { error: 'Tesseract worker crashed' },
    });
    convertRawTextToZeroLossMarkdownMock.mockResolvedValue('');

    const { runExtractStep } = await import('./image-to-pdf.js');
    const result = await runExtractStep(finalBuf);

    expect(result.error).toBeUndefined();
    expect(result.meta).toEqual({ rawTextLength: 0 });
    expect(result.candidates?.find(c => c.label === 'paddleocr')?.error).toBe('PaddleOCR server is unavailable');
    expect(result.candidates?.find(c => c.label === 'tesseract')?.error).toBe('Tesseract worker crashed');
  });

  it('records a step-level error when the markdown conversion itself throws', async () => {
    ocrImageBufferBothEnginesMock.mockResolvedValue({
      paddleOcr: { text: 'paddle raw text' },
      tesseract: { text: 'tesseract raw text' },
    });
    convertRawTextToZeroLossMarkdownMock.mockRejectedValue(new Error('ollama unreachable'));

    const { runExtractStep } = await import('./image-to-pdf.js');
    const result = await runExtractStep(finalBuf);

    expect(result.error).toBe('ollama unreachable');
    expect(result.candidates).toBeUndefined();
  });
});
