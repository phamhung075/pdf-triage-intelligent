import { detectOrientation, detectCropBox } from '../infrastructure/vision-client.js';
import { rotateImage, cropImage, computeAutoLevelsForImage, applyBrightnessContrast, applySharpen } from '../infrastructure/image-processor.js';
import { AUTO_ADJUST_SHARPNESS } from '../domain/image-adjust.js';

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
  const steps: PipelineStep[] = [
    { step: 0, label: 'original', imageBase64: imageBuffer.toString('base64'), durationMs: 0 },
  ];

  let orientedBuffer: Buffer;
  const step1Start = Date.now();
  try {
    const { rotationDegrees, raw } = await detectOrientation(imageBuffer);
    orientedBuffer = await rotateImage(imageBuffer, rotationDegrees);
    steps.push({ step: 1, label: 'oriented', imageBase64: orientedBuffer.toString('base64'), durationMs: Date.now() - step1Start, modelRaw: raw, meta: { rotationDegrees } });
  } catch (err) {
    steps.push({ step: 1, label: 'oriented', imageBase64: '', durationMs: Date.now() - step1Start, error: errorMessage(err) });
    return steps;
  }

  let croppedBuffer: Buffer;
  const step2Start = Date.now();
  try {
    const { cropBox, raw } = await detectCropBox(orientedBuffer);
    croppedBuffer = cropBox ? await cropImage(orientedBuffer, cropBox) : orientedBuffer;
    steps.push({ step: 2, label: 'cropped', imageBase64: croppedBuffer.toString('base64'), durationMs: Date.now() - step2Start, modelRaw: raw, meta: { cropBox } });
  } catch (err) {
    steps.push({ step: 2, label: 'cropped', imageBase64: '', durationMs: Date.now() - step2Start, error: errorMessage(err) });
    return steps;
  }

  const step3Start = Date.now();
  try {
    const { brightness, contrast } = await computeAutoLevelsForImage(croppedBuffer);
    const leveledBuffer = await applyBrightnessContrast(croppedBuffer, { brightness, contrast });
    const finalBuffer = await applySharpen(leveledBuffer, AUTO_ADJUST_SHARPNESS);
    steps.push({ step: 3, label: 'enhanced', imageBase64: finalBuffer.toString('base64'), durationMs: Date.now() - step3Start, meta: { brightness, contrast, sharpness: AUTO_ADJUST_SHARPNESS } });
  } catch (err) {
    steps.push({ step: 3, label: 'enhanced', imageBase64: '', durationMs: Date.now() - step3Start, error: errorMessage(err) });
  }

  return steps;
}
