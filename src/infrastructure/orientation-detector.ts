import { createWorker, OEM } from 'tesseract.js';
import { detectOrientation as detectOrientationViaVisionModel } from './vision-client.js';
import { parseExifOrientation, exifOrientationToDegrees } from '../domain/exif-orientation.js';
import { paddleOcrDetectOrientation } from './paddleocr-client.js';
import { logger } from './logger.js';

// worker.detect() (Tesseract's Orientation & Script Detection) requires the Legacy engine
// (OEM.TESSERACT_ONLY) plus the dedicated 'osd' trained-data pack — the default LSTM-only
// engine used by pdf-extractor.ts's shared 'fra'+'eng' worker cannot run it at all ("`worker.detect`
// requires Legacy model, which was not loaded", confirmed against a real photo during
// development). This is a separate, dedicated worker rather than reusing that shared one, so
// this module never changes the engine mode the main app's real OCR fallback depends on.
let sharedOsdWorkerPromise: Promise<any> | null = null;
async function getSharedOsdWorker(): Promise<any> {
  if (!sharedOsdWorkerPromise) {
    sharedOsdWorkerPromise = (async () => {
      try {
        return await createWorker(['osd'], OEM.TESSERACT_ONLY);
      } catch (err) {
        sharedOsdWorkerPromise = null;
        throw err;
      }
    })();
  }
  return sharedOsdWorkerPromise;
}

export interface OrientationDetectionResult {
  rotationDegrees: 0 | 90 | 180 | 270;
  exifDegrees: 0 | 90 | 180 | 270 | null;
  modelDegrees: 0 | 90 | 180 | 270;
  modelRaw: string;
  ocrDegrees: 0 | 90 | 180 | 270 | null;
  ocrConfidence: number | null;
  source: 'exif+model-agree' | 'ocr-tiebreaker';
}

const VALID_ROTATIONS = [0, 90, 180, 270];

// Tries PaddleOCR's document-orientation classifier first (generally more robust on real
// phone photos); falls back to Tesseract OSD only if the PaddleOCR service call fails — an
// availability fallback, not a second opinion.
async function getOcrOrientationTiebreaker(
  imageBuffer: Buffer
): Promise<{ ocrDegrees: 0 | 90 | 180 | 270 | null; ocrConfidence: number | null }> {
  try {
    const { rotationDegrees, confidence } = await paddleOcrDetectOrientation(imageBuffer);
    return { ocrDegrees: rotationDegrees, ocrConfidence: confidence };
  } catch (err: any) {
    logger.debug('ORIENTATION', `PaddleOCR unavailable, falling back to Tesseract OSD: ${err.message}`);
    const worker = await getSharedOsdWorker();
    const { data } = await worker.detect(imageBuffer);
    const rawOcrDegrees = data.orientation_degrees;
    const ocrDegrees = (typeof rawOcrDegrees === 'number' && VALID_ROTATIONS.includes(rawOcrDegrees) ? rawOcrDegrees : null) as 0 | 90 | 180 | 270 | null;
    const ocrConfidence = typeof data.orientation_confidence === 'number' ? data.orientation_confidence : null;
    return { ocrDegrees, ocrConfidence };
  }
}

// Cascades three independent orientation signals, cheapest/least-reliable first: EXIF metadata
// (instant, but sometimes wrong or absent — a real phone photo surfaced exactly this), the
// minicpm-v4.6 vision model (also sometimes wrong on its own, as the same photo proved), and
// PaddleOCR's document-orientation classifier (measures actual text-pixel orientation — the most
// reliable single signal here, but slower, so it only runs when needed; Tesseract OSD is its
// availability fallback if the PaddleOCR service call fails). When EXIF and the model agree, that
// shared answer is used directly with no OCR pass. Otherwise — including when EXIF is absent,
// since there's then nothing for the model to agree with — the OCR tiebreaker breaks the tie; if
// it's itself inconclusive, the model's answer is the final fallback.
export async function detectOrientationCascade(imageBuffer: Buffer): Promise<OrientationDetectionResult> {
  const exifTag = parseExifOrientation(imageBuffer);
  const exifDegrees = exifOrientationToDegrees(exifTag);
  const { rotationDegrees: modelDegrees, raw: modelRaw } = await detectOrientationViaVisionModel(imageBuffer);

  if (exifDegrees !== null && exifDegrees === modelDegrees) {
    return {
      rotationDegrees: modelDegrees,
      exifDegrees,
      modelDegrees,
      modelRaw,
      ocrDegrees: null,
      ocrConfidence: null,
      source: 'exif+model-agree',
    };
  }

  const { ocrDegrees, ocrConfidence } = await getOcrOrientationTiebreaker(imageBuffer);

  return {
    rotationDegrees: ocrDegrees !== null ? ocrDegrees : modelDegrees,
    exifDegrees,
    modelDegrees,
    modelRaw,
    ocrDegrees,
    ocrConfidence,
    source: 'ocr-tiebreaker',
  };
}
