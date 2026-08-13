import { detectCropBox } from '../infrastructure/vision-client.js';
import { detectOrientationCascade } from '../infrastructure/orientation-detector.js';
import { rotateImage, cropImage, computeAutoLevelsForImage, applyBrightnessContrast, applySharpen } from '../infrastructure/image-processor.js';
import { AUTO_ADJUST_SHARPNESS } from '../domain/image-adjust.js';
import { logger } from '../infrastructure/logger.js';

export interface PipelineStep {
  step: number;
  label: 'original' | 'oriented' | 'cropped' | 'enhanced';
  imageBase64: string;
  durationMs: number;
  modelRaw?: string;
  meta?: Record<string, unknown>;
  error?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Diagnostic pipeline: original -> oriented -> cropped -> enhanced. A step that throws records
// its error and the pipeline stops there (each later step needs the previous step's output) —
// see Global Constraints in the plan for why this doesn't swallow real failures.
export async function runVisionPipeline(imageBuffer: Buffer): Promise<PipelineStep[]> {
  logger.info('VISION_LAB', 'Pipeline started', { imageBytes: imageBuffer.length });

  const steps: PipelineStep[] = [
    { step: 0, label: 'original', imageBase64: imageBuffer.toString('base64'), durationMs: 0 },
  ];

  let orientedBuffer: Buffer;
  const step1Start = Date.now();
  try {
    const { rotationDegrees, exifDegrees, modelDegrees, modelRaw, ocrDegrees, ocrConfidence, source } = await detectOrientationCascade(imageBuffer);
    orientedBuffer = await rotateImage(imageBuffer, rotationDegrees);
    const durationMs = Date.now() - step1Start;
    const meta = { rotationDegrees, exifDegrees, modelDegrees, ocrDegrees, ocrConfidence, source };
    steps.push({ step: 1, label: 'oriented', imageBase64: orientedBuffer.toString('base64'), durationMs, modelRaw, meta });
    logger.info('VISION_LAB', 'Step 1 (oriented) succeeded', { ...meta, durationMs });
  } catch (err) {
    const durationMs = Date.now() - step1Start;
    steps.push({ step: 1, label: 'oriented', imageBase64: '', durationMs, error: errorMessage(err) });
    logger.error('VISION_LAB', 'Step 1 (oriented) failed', { error: errorMessage(err), durationMs });
    return steps;
  }

  let croppedBuffer: Buffer;
  const step2Start = Date.now();
  try {
    const { cropBox, raw } = await detectCropBox(orientedBuffer);
    croppedBuffer = cropBox ? await cropImage(orientedBuffer, cropBox) : orientedBuffer;
    const durationMs = Date.now() - step2Start;
    steps.push({ step: 2, label: 'cropped', imageBase64: croppedBuffer.toString('base64'), durationMs, modelRaw: raw, meta: { cropBox } });
    logger.info('VISION_LAB', 'Step 2 (cropped) succeeded', { cropBox, durationMs });
  } catch (err) {
    const durationMs = Date.now() - step2Start;
    steps.push({ step: 2, label: 'cropped', imageBase64: '', durationMs, error: errorMessage(err) });
    logger.error('VISION_LAB', 'Step 2 (cropped) failed', { error: errorMessage(err), durationMs });
    return steps;
  }

  const step3Start = Date.now();
  try {
    const { brightness, contrast } = await computeAutoLevelsForImage(croppedBuffer);
    const leveledBuffer = await applyBrightnessContrast(croppedBuffer, { brightness, contrast });
    const finalBuffer = await applySharpen(leveledBuffer, AUTO_ADJUST_SHARPNESS);
    const durationMs = Date.now() - step3Start;
    steps.push({ step: 3, label: 'enhanced', imageBase64: finalBuffer.toString('base64'), durationMs, meta: { brightness, contrast, sharpness: AUTO_ADJUST_SHARPNESS } });
    logger.info('VISION_LAB', 'Step 3 (enhanced) succeeded', { brightness, contrast, sharpness: AUTO_ADJUST_SHARPNESS, durationMs });
  } catch (err) {
    const durationMs = Date.now() - step3Start;
    steps.push({ step: 3, label: 'enhanced', imageBase64: '', durationMs, error: errorMessage(err) });
    logger.error('VISION_LAB', 'Step 3 (enhanced) failed', { error: errorMessage(err), durationMs });
  }

  logger.info('VISION_LAB', 'Pipeline finished', { totalSteps: steps.length, finalError: steps[steps.length - 1].error });
  return steps;
}
