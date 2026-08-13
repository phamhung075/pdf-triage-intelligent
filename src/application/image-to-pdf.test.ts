import { describe, it, expect, vi, beforeEach } from 'vitest';

const { detectOrientationMock, detectCropBoxMock } = vi.hoisted(() => ({
  detectOrientationMock: vi.fn(),
  detectCropBoxMock: vi.fn(),
}));
vi.mock('../infrastructure/vision-client.js', () => ({
  detectOrientation: detectOrientationMock,
  detectCropBox: detectCropBoxMock,
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

beforeEach(() => {
  vi.resetAllMocks();
});

const originalBuf = Buffer.from('original');
const orientedBuf = Buffer.from('oriented');
const croppedBuf = Buffer.from('cropped');
const leveledBuf = Buffer.from('leveled');
const finalBuf = Buffer.from('final');

function mockHappyPath() {
  detectOrientationMock.mockResolvedValue({ rotationDegrees: 90, raw: '{"rotationDegrees":90}' });
  rotateImageMock.mockResolvedValue(orientedBuf);
  detectCropBoxMock.mockResolvedValue({ cropBox: { x: 1, y: 2, width: 3, height: 4 }, raw: '{"cropBox":{}}' });
  cropImageMock.mockResolvedValue(croppedBuf);
  computeAutoLevelsForImageMock.mockResolvedValue({ brightness: 5, contrast: 6 });
  applyBrightnessContrastMock.mockResolvedValue(leveledBuf);
  applySharpenMock.mockResolvedValue(finalBuf);
}

describe('runVisionPipeline', () => {
  it('runs all 4 steps in order on the happy path', async () => {
    mockHappyPath();
    const { runVisionPipeline } = await import('./image-to-pdf.js');
    const steps = await runVisionPipeline(originalBuf);

    expect(steps.map(s => s.label)).toEqual(['original', 'oriented', 'cropped', 'enhanced']);
    expect(steps[0].imageBase64).toBe(originalBuf.toString('base64'));
    expect(steps[1].imageBase64).toBe(orientedBuf.toString('base64'));
    expect(steps[1].modelRaw).toBe('{"rotationDegrees":90}');
    expect(steps[1].meta).toEqual({ rotationDegrees: 90 });
    expect(steps[2].imageBase64).toBe(croppedBuf.toString('base64'));
    expect(steps[2].meta).toEqual({ cropBox: { x: 1, y: 2, width: 3, height: 4 } });
    expect(steps[3].imageBase64).toBe(finalBuf.toString('base64'));
    expect(steps[3].meta).toEqual({ brightness: 5, contrast: 6, sharpness: 25 });

    expect(rotateImageMock).toHaveBeenCalledWith(originalBuf, 90);
    expect(detectCropBoxMock).toHaveBeenCalledWith(orientedBuf);
    expect(cropImageMock).toHaveBeenCalledWith(orientedBuf, { x: 1, y: 2, width: 3, height: 4 });
    expect(applyBrightnessContrastMock).toHaveBeenCalledWith(croppedBuf, { brightness: 5, contrast: 6 });
    expect(applySharpenMock).toHaveBeenCalledWith(leveledBuf, 25);
  });

  it('uses the oriented image as-is when crop detection returns cropBox:null', async () => {
    mockHappyPath();
    detectCropBoxMock.mockResolvedValue({ cropBox: null, raw: '{"cropBox":null}' });
    computeAutoLevelsForImageMock.mockResolvedValue({ brightness: 0, contrast: 0 });
    const { runVisionPipeline } = await import('./image-to-pdf.js');
    const steps = await runVisionPipeline(originalBuf);

    expect(cropImageMock).not.toHaveBeenCalled();
    expect(steps[2].imageBase64).toBe(orientedBuf.toString('base64'));
    expect(steps[2].meta).toEqual({ cropBox: null });
  });

  it('stops after step 1 with an error field when orientation detection fails', async () => {
    detectOrientationMock.mockRejectedValue(new Error('vision model unreachable'));
    const { runVisionPipeline } = await import('./image-to-pdf.js');
    const steps = await runVisionPipeline(originalBuf);

    expect(steps).toHaveLength(2);
    expect(steps[1].label).toBe('oriented');
    expect(steps[1].error).toBe('vision model unreachable');
  });

  it('stops after step 2 with an error field when crop detection fails', async () => {
    mockHappyPath();
    detectCropBoxMock.mockRejectedValue(new Error('malformed JSON from model'));
    const { runVisionPipeline } = await import('./image-to-pdf.js');
    const steps = await runVisionPipeline(originalBuf);

    expect(steps).toHaveLength(3);
    expect(steps[2].label).toBe('cropped');
    expect(steps[2].error).toBe('malformed JSON from model');
  });

  it('carries an error field on the final step when enhancement fails, without dropping earlier steps', async () => {
    mockHappyPath();
    applySharpenMock.mockRejectedValue(new Error('canvas encode failed'));
    const { runVisionPipeline } = await import('./image-to-pdf.js');
    const steps = await runVisionPipeline(originalBuf);

    expect(steps).toHaveLength(4);
    expect(steps[3].label).toBe('enhanced');
    expect(steps[3].error).toBe('canvas encode failed');
  });
});
