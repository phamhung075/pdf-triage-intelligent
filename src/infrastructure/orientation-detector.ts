import { detectOrientation as detectOrientationViaVisionModel } from './vision-client.js';
import { parseExifOrientation, exifOrientationToDegrees } from '../domain/exif-orientation.js';

export interface OrientationDetectionResult {
  rotationDegrees: 0 | 90 | 180 | 270;
  exifDegrees: 0 | 90 | 180 | 270 | null;
  modelDegrees: 0 | 90 | 180 | 270;
  modelRaw: string;
  source: 'exif+model-agree' | 'model-only';
}

// Cascades two independent orientation signals: EXIF metadata (instant, but sometimes wrong or
// absent — a real phone photo surfaced exactly this) and the minicpm-v4.6 vision model (also
// sometimes wrong on its own, as the same photo proved). When they agree, that shared answer is
// used. Otherwise — including when EXIF is absent, since there's then nothing for the model to
// agree with — the vision model's answer is taken as final, with no independent tiebreaker: the
// app's only remaining OCR dependency is pdf2w, and pdf2w exposes no orientation-classification
// API. This is a deliberate, accepted loss of the OCR-verified tiebreaker this cascade used to
// have (previously PaddleOCR, with Tesseract OSD as its availability fallback).
export async function detectOrientationCascade(imageBuffer: Buffer): Promise<OrientationDetectionResult> {
  const exifTag = parseExifOrientation(imageBuffer);
  const exifDegrees = exifOrientationToDegrees(exifTag);
  const { rotationDegrees: modelDegrees, raw: modelRaw } = await detectOrientationViaVisionModel(imageBuffer);

  const agree = exifDegrees !== null && exifDegrees === modelDegrees;
  return {
    rotationDegrees: modelDegrees,
    exifDegrees,
    modelDegrees,
    modelRaw,
    source: agree ? 'exif+model-agree' : 'model-only',
  };
}
