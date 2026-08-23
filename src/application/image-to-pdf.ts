import { detectOrientationCascade } from '../infrastructure/orientation-detector.js';
import { detectCropBoxCascade } from '../infrastructure/crop-detector.js';
import { normalizeOrientation, rotateImage, cropImage, computeAutoLevelsForImage, applyBrightnessContrast, applySharpen } from '../infrastructure/image-processor.js';
import { ocrImageBufferBothEngines } from '../infrastructure/pdf-extractor.js';
import { AUTO_ADJUST_SHARPNESS } from '../domain/image-adjust.js';
import { logger } from '../infrastructure/logger.js';
import { convertRawTextToZeroLossMarkdown } from './classify-document.js';

export interface StepCandidate {
  label: string;
  chosen: boolean;
  imageBase64?: string;
  text?: string;
  meta?: Record<string, unknown>;
  error?: string;
}

export interface PipelineStepResult {
  step: 1 | 2 | 3 | 4;
  label: 'oriented' | 'cropped' | 'enhanced' | 'extracted';
  durationMs: number;
  imageBase64: string;
  markdown?: string;
  modelRaw?: string;
  meta?: Record<string, unknown>;
  error?: string;
  candidates?: StepCandidate[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Step 1: orientation. Candidates cover every non-null signal the cascade considered (EXIF,
// vision model, OCR tiebreaker) — selecting one in the UI is purely visual; the cascade's own
// rotationDegrees always feeds step 2, regardless of what a developer looks at here.
//
// The `exif` candidate will normally be absent now: the buffer is EXIF-normalized before the
// cascade runs, so there is no orientation tag left to read and exifDegrees comes back null. That
// is deliberate, not a regression — see normalizeOrientation for why the tag must not be treated
// as a rotation still owed.
export async function runOrientStep(imageBuffer: Buffer): Promise<PipelineStepResult> {
  const start = Date.now();
  try {
    // Normalize BEFORE anything measures orientation. Our decoders (canvas here, OpenCV inside the
    // PaddleOCR service) already apply the EXIF Orientation tag, so the raw tag is not a rotation
    // still owed — re-applying it turns an upright photo sideways. Normalizing first strips the tag
    // and leaves every stage looking at identical pixels, so the cascade below measures only the
    // rotation the photograph itself needs. See normalizeOrientation.
    const normalizedBuffer = await normalizeOrientation(imageBuffer);
    const { rotationDegrees, exifDegrees, modelDegrees, modelRaw, ocrDegrees, ocrConfidence, source } = await detectOrientationCascade(normalizedBuffer);
    const orientedBuffer = await rotateImage(normalizedBuffer, rotationDegrees);

    const candidateDegrees: Array<{ label: string; degrees: 0 | 90 | 180 | 270 }> = [];
    if (exifDegrees !== null) candidateDegrees.push({ label: 'exif', degrees: exifDegrees });
    candidateDegrees.push({ label: 'model', degrees: modelDegrees });
    if (ocrDegrees !== null) candidateDegrees.push({ label: 'ocr', degrees: ocrDegrees });

    const candidates: StepCandidate[] = [];
    for (const { label, degrees } of candidateDegrees) {
      const isChosen = degrees === rotationDegrees;
      try {
        // Rotate the NORMALIZED buffer, not the raw upload — otherwise the comparison views sit in
        // a different pixel space than the chosen one and cannot be compared against it by eye.
        const buf = isChosen ? orientedBuffer : await rotateImage(normalizedBuffer, degrees);
        candidates.push({ label, chosen: isChosen, imageBase64: buf.toString('base64'), meta: { rotationDegrees: degrees } });
      } catch (candidateErr) {
        candidates.push({ label, chosen: isChosen, meta: { rotationDegrees: degrees }, error: errorMessage(candidateErr) });
      }
    }

    const durationMs = Date.now() - start;
    const meta = { rotationDegrees, exifDegrees, modelDegrees, ocrDegrees, ocrConfidence, source };
    logger.info('VISION_LAB', 'Step 1 (oriented) succeeded', { ...meta, durationMs });
    return { step: 1, label: 'oriented', imageBase64: orientedBuffer.toString('base64'), durationMs, modelRaw, meta, candidates };
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.error('VISION_LAB', 'Step 1 (oriented) failed', { error: errorMessage(err), durationMs });
    return { step: 1, label: 'oriented', imageBase64: '', durationMs, error: errorMessage(err) };
  }
}

// Step 2: crop. Candidates cover the model box and the flood-fill box when each is non-null —
// selecting one is purely visual; the cascade's own cropBox always feeds step 3.
export async function runCropStep(orientedBuffer: Buffer): Promise<PipelineStepResult> {
  const start = Date.now();
  try {
    const { cropBox, modelCropBox, modelRaw, floodCropBox, source } = await detectCropBoxCascade(orientedBuffer);
    const croppedBuffer = cropBox ? await cropImage(orientedBuffer, cropBox) : orientedBuffer;

    const candidateBoxes: Array<{ label: string; box: { x: number; y: number; width: number; height: number } }> = [];
    if (modelCropBox) candidateBoxes.push({ label: 'model', box: modelCropBox });
    if (floodCropBox) candidateBoxes.push({ label: 'flood', box: floodCropBox });

    const candidates: StepCandidate[] = [];
    for (const { label, box } of candidateBoxes) {
      const isChosen = !!cropBox && box.x === cropBox.x && box.y === cropBox.y && box.width === cropBox.width && box.height === cropBox.height;
      try {
        const buf = isChosen ? croppedBuffer : await cropImage(orientedBuffer, box);
        candidates.push({ label, chosen: isChosen, imageBase64: buf.toString('base64'), meta: { box } });
      } catch (candidateErr) {
        candidates.push({ label, chosen: isChosen, meta: { box }, error: errorMessage(candidateErr) });
      }
    }

    const durationMs = Date.now() - start;
    const meta = { cropBox, modelCropBox, floodCropBox, source };
    logger.info('VISION_LAB', 'Step 2 (cropped) succeeded', { ...meta, durationMs });
    return { step: 2, label: 'cropped', imageBase64: croppedBuffer.toString('base64'), durationMs, modelRaw, meta, candidates };
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.error('VISION_LAB', 'Step 2 (cropped) failed', { error: errorMessage(err), durationMs });
    return { step: 2, label: 'cropped', imageBase64: '', durationMs, error: errorMessage(err) };
  }
}

// Step 3: enhance. No alternate signal exists to compare (auto-levels + a fixed sharpen
// default), so this step never has a `candidates` field.
export async function runEnhanceStep(croppedBuffer: Buffer): Promise<PipelineStepResult> {
  const start = Date.now();
  try {
    const { brightness, contrast } = await computeAutoLevelsForImage(croppedBuffer);
    const leveledBuffer = await applyBrightnessContrast(croppedBuffer, { brightness, contrast });
    const finalBuffer = await applySharpen(leveledBuffer, AUTO_ADJUST_SHARPNESS);
    const durationMs = Date.now() - start;
    logger.info('VISION_LAB', 'Step 3 (enhanced) succeeded', { brightness, contrast, sharpness: AUTO_ADJUST_SHARPNESS, durationMs });
    return { step: 3, label: 'enhanced', imageBase64: finalBuffer.toString('base64'), durationMs, meta: { brightness, contrast, sharpness: AUTO_ADJUST_SHARPNESS } };
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.error('VISION_LAB', 'Step 3 (enhanced) failed', { error: errorMessage(err), durationMs });
    return { step: 3, label: 'enhanced', imageBase64: '', durationMs, error: errorMessage(err) };
  }
}

// Step 4: extract. Runs both OCR engines independently (not fallback-only) so both are always
// available to compare, even when one fails. The markdown conversion always uses PaddleOCR's
// text when it succeeded, Tesseract's otherwise — same priority production uses — but both raw
// texts are returned as candidates regardless of which one "won."
export async function runExtractStep(enhancedBuffer: Buffer): Promise<PipelineStepResult> {
  const start = Date.now();
  try {
    const { paddleOcr, tesseract } = await ocrImageBufferBothEngines(enhancedBuffer);
    const chosenText = 'text' in paddleOcr ? paddleOcr.text : ('text' in tesseract ? tesseract.text : '');
    const markdown = await convertRawTextToZeroLossMarkdown(chosenText, 'vision-lab-diagnostic');
    const durationMs = Date.now() - start;
    const candidates: StepCandidate[] = [
      { label: 'markdown', chosen: true, text: markdown },
      { label: 'paddleocr', chosen: false, text: 'text' in paddleOcr ? paddleOcr.text : undefined, error: 'error' in paddleOcr ? paddleOcr.error : undefined },
      { label: 'tesseract', chosen: false, text: 'text' in tesseract ? tesseract.text : undefined, error: 'error' in tesseract ? tesseract.error : undefined },
    ];
    logger.info('VISION_LAB', 'Step 4 (extracted) succeeded', { rawTextLength: chosenText.length, durationMs });
    return { step: 4, label: 'extracted', imageBase64: '', durationMs, markdown, meta: { rawTextLength: chosenText.length }, candidates };
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.error('VISION_LAB', 'Step 4 (extracted) failed', { error: errorMessage(err), durationMs });
    return { step: 4, label: 'extracted', imageBase64: '', durationMs, error: errorMessage(err) };
  }
}
