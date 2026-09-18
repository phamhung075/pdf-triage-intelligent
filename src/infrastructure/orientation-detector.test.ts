import { describe, it, expect, vi } from 'vitest';

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

describe('detectOrientationCascade', () => {
  it('uses the agreed value when EXIF and the model agree', async () => {
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
  });

  it('takes the model result with no tiebreaker when EXIF and the model disagree', async () => {
    parseExifOrientationMock.mockReturnValue(3);
    exifOrientationToDegreesMock.mockReturnValue(180);
    detectOrientationMock.mockResolvedValue({ rotationDegrees: 0, raw: '{"rotationDegrees":0}' });

    const { detectOrientationCascade } = await import('./orientation-detector.js');
    const result = await detectOrientationCascade(Buffer.from('x'));

    expect(result.source).toBe('model-only');
    expect(result.rotationDegrees).toBe(0);
    expect(result.exifDegrees).toBe(180);
    expect(result.modelDegrees).toBe(0);
  });

  it('takes the model result when EXIF is absent (nothing to agree with)', async () => {
    parseExifOrientationMock.mockReturnValue(null);
    exifOrientationToDegreesMock.mockReturnValue(null);
    detectOrientationMock.mockResolvedValue({ rotationDegrees: 180, raw: '{"rotationDegrees":180}' });

    const { detectOrientationCascade } = await import('./orientation-detector.js');
    const result = await detectOrientationCascade(Buffer.from('x'));

    expect(result.source).toBe('model-only');
    expect(result.rotationDegrees).toBe(180);
    expect(result.exifDegrees).toBeNull();
  });
});
