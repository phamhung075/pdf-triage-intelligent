import { describe, it, expect, vi, beforeEach } from 'vitest';

const { parseExifOrientationMock, exifOrientationToDegreesMock } = vi.hoisted(() => ({
  parseExifOrientationMock: vi.fn(),
  exifOrientationToDegreesMock: vi.fn(),
}));
vi.mock('../domain/exif-orientation.js', () => ({
  parseExifOrientation: parseExifOrientationMock,
  exifOrientationToDegrees: exifOrientationToDegreesMock,
}));

const { detectOrientationMock } = vi.hoisted(() => ({ detectOrientationMock: vi.fn() }));
vi.mock('./vision-client.js', () => ({ detectOrientation: detectOrientationMock }));

const { detectMock, createWorkerMock } = vi.hoisted(() => ({
  detectMock: vi.fn(),
  createWorkerMock: vi.fn(),
}));
vi.mock('tesseract.js', () => ({
  createWorker: createWorkerMock,
  OEM: { TESSERACT_ONLY: 0, LSTM_ONLY: 1, TESSERACT_LSTM_COMBINED: 2, DEFAULT: 3 },
}));

const { paddleOcrDetectOrientationMock } = vi.hoisted(() => ({ paddleOcrDetectOrientationMock: vi.fn() }));
vi.mock('./paddleocr-client.js', () => ({ paddleOcrDetectOrientation: paddleOcrDetectOrientationMock }));

beforeEach(() => {
  vi.resetAllMocks();
  createWorkerMock.mockResolvedValue({ detect: detectMock });
  // Default: simulate "no local PaddleOCR service running" — the existing tests below
  // continue exercising the Tesseract OSD fallback path exactly as before this mock was added.
  paddleOcrDetectOrientationMock.mockRejectedValue(new Error('PaddleOCR server is unavailable'));
});

describe('detectOrientationCascade', () => {
  it('uses the agreed value and skips OCR when EXIF and the model agree', async () => {
    parseExifOrientationMock.mockReturnValue(6);
    exifOrientationToDegreesMock.mockReturnValue(90);
    detectOrientationMock.mockResolvedValue({ rotationDegrees: 90, raw: '{"rotationDegrees":90}' });

    const { detectOrientationCascade } = await import('./orientation-detector.js');
    const result = await detectOrientationCascade(Buffer.from('x'));

    expect(result.rotationDegrees).toBe(90);
    expect(result.source).toBe('exif+model-agree');
    expect(result.exifDegrees).toBe(90);
    expect(result.modelDegrees).toBe(90);
    expect(result.modelRaw).toBe('{"rotationDegrees":90}');
    expect(result.ocrDegrees).toBeNull();
    expect(result.ocrConfidence).toBeNull();
    expect(detectMock).not.toHaveBeenCalled();
  });

  it('falls back to Tesseract OSD as tiebreaker when EXIF and the model disagree', async () => {
    parseExifOrientationMock.mockReturnValue(3);
    exifOrientationToDegreesMock.mockReturnValue(180);
    detectOrientationMock.mockResolvedValue({ rotationDegrees: 0, raw: '{"rotationDegrees":0}' });
    detectMock.mockResolvedValue({ data: { orientation_degrees: 90, orientation_confidence: 5.2 } });

    const { detectOrientationCascade } = await import('./orientation-detector.js');
    const result = await detectOrientationCascade(Buffer.from('x'));

    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('ocr-tiebreaker');
    expect(result.rotationDegrees).toBe(90);
    expect(result.exifDegrees).toBe(180);
    expect(result.modelDegrees).toBe(0);
    expect(result.ocrDegrees).toBe(90);
    expect(result.ocrConfidence).toBe(5.2);

    // Regression guard: worker.detect() throws "requires Legacy model, which was not loaded"
    // unless the worker was created with the Legacy engine (OEM.TESSERACT_ONLY = 0) and the
    // dedicated 'osd' trained-data pack — confirmed against a real photo during development.
    expect(createWorkerMock).toHaveBeenCalledWith(['osd'], 0);
  });

  it('runs OCR when EXIF is absent (nothing to agree with), even if the model returns a value', async () => {
    parseExifOrientationMock.mockReturnValue(null);
    exifOrientationToDegreesMock.mockReturnValue(null);
    detectOrientationMock.mockResolvedValue({ rotationDegrees: 0, raw: '{"rotationDegrees":0}' });
    detectMock.mockResolvedValue({ data: { orientation_degrees: 180, orientation_confidence: 8.1 } });

    const { detectOrientationCascade } = await import('./orientation-detector.js');
    const result = await detectOrientationCascade(Buffer.from('x'));

    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('ocr-tiebreaker');
    expect(result.rotationDegrees).toBe(180);
    expect(result.exifDegrees).toBeNull();
  });

  it('falls back to the model result when OCR is inconclusive (null orientation_degrees)', async () => {
    parseExifOrientationMock.mockReturnValue(null);
    exifOrientationToDegreesMock.mockReturnValue(null);
    detectOrientationMock.mockResolvedValue({ rotationDegrees: 270, raw: '{"rotationDegrees":270}' });
    detectMock.mockResolvedValue({ data: { orientation_degrees: null, orientation_confidence: null } });

    const { detectOrientationCascade } = await import('./orientation-detector.js');
    const result = await detectOrientationCascade(Buffer.from('x'));

    expect(result.source).toBe('ocr-tiebreaker');
    expect(result.rotationDegrees).toBe(270);
    expect(result.ocrDegrees).toBeNull();
  });

  it('uses PaddleOCR as the tiebreaker and skips Tesseract OSD when it succeeds', async () => {
    parseExifOrientationMock.mockReturnValue(3);
    exifOrientationToDegreesMock.mockReturnValue(180);
    detectOrientationMock.mockResolvedValue({ rotationDegrees: 0, raw: '{"rotationDegrees":0}' });
    paddleOcrDetectOrientationMock.mockResolvedValue({ rotationDegrees: 90, confidence: 0.97 });

    const { detectOrientationCascade } = await import('./orientation-detector.js');
    const result = await detectOrientationCascade(Buffer.from('x'));

    expect(result.source).toBe('ocr-tiebreaker');
    expect(result.rotationDegrees).toBe(90);
    expect(result.ocrDegrees).toBe(90);
    expect(result.ocrConfidence).toBe(0.97);
    expect(detectMock).not.toHaveBeenCalled();
  });
});
