import { loadImage } from '@napi-rs/canvas';
import { detectCropBox, type CropBox } from './vision-client.js';
import { detectDocumentBoxLocally } from './image-processor.js';

export interface CropDetectionResult {
  cropBox: CropBox | null;
  modelCropBox: CropBox | null;
  modelRaw: string;
  floodCropBox: CropBox | null;
  source: 'model-flood-agree' | 'flood-override' | 'model-only' | 'flood-veto' | 'none';
}

// Matches pdf-awesome's own quadRectIoU disagreement threshold (js/domain/autocrop.js) — its
// combination logic overrides its primary (global-threshold) detector with flood-fill whenever
// they disagree by more than this, because real-photo testing there found flood-fill the more
// trustworthy signal on low-contrast backgrounds, not the other way around.
const IOU_AGREEMENT_THRESHOLD = 0.5;

// A few pixels of slack for rounding — the model rarely echoes the exact image dimensions back.
const FULL_BOUNDS_TOLERANCE = 3;

function isFullBoundsOrMissing(box: CropBox | null, imgWidth: number, imgHeight: number): boolean {
  if (!box) return true;
  return (
    box.x <= FULL_BOUNDS_TOLERANCE &&
    box.y <= FULL_BOUNDS_TOLERANCE &&
    Math.abs(box.x + box.width - imgWidth) <= FULL_BOUNDS_TOLERANCE &&
    Math.abs(box.y + box.height - imgHeight) <= FULL_BOUNDS_TOLERANCE
  );
}

function rectIoU(a: CropBox, b: CropBox): number {
  const ax2 = a.x + a.width, ay2 = a.y + a.height;
  const bx2 = b.x + b.width, by2 = b.y + b.height;
  const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

// Cascades two independent crop-boundary signals: the minicpm-v4.6 vision model, and the local,
// deterministic edge-snap detector (detectDocumentBoxLocally) that measures how strong a colour
// barrier separates the frame border from each pixel — see domain/flood-crop.ts for why it
// tolerates a document photographed on a background close in brightness to the paper itself, a
// case the model has been observed to default to a lazy "the document fills the whole photo"
// answer on.
//
// The local detector is THREE-valued, and the distinction is load-bearing:
//
// - 'vetoed' SHORT-CIRCUITS THE WHOLE CASCADE to no crop, whatever the model said. A veto is not
//   "I found nothing"; it is "I examined this image and there is NO BACKGROUND to crop — the frame
//   IS the document, so any crop destroys content". That happens on scans, close-up captures, PDF
//   page renders, screenshots, and on a second pass over this pipeline's own already-cropped
//   output. The model has no defence against exactly that input: it is where it most reliably
//   invents a box around an interior text block or echoes a lazy full-frame answer. Deferring to
//   it here would hand back the destructive crop the guard exists to prevent, on precisely the
//   inputs where the local detector's evidence is strongest — so the veto outranks the model
//   rather than competing with it.
// - 'no-signal' means the detector genuinely has no opinion (nothing covered the middle of the
//   frame). Then, and only then, the model is the sole signal and the pre-existing behaviour
//   applies: trust a real, non-degenerate model box ('model-only'), or report no crop when the
//   model's box is also degenerate (full-image-bounds echo, or missing) rather than silently
//   passing through a no-op answer mislabeled as a successful detection.
// - 'box' arbitrates against the model as before: if the model's box is degenerate, or disagrees
//   by IoU below IOU_AGREEMENT_THRESHOLD, the local box overrides it — matching pdf-awesome's own
//   tested preference for the local detector over threshold-based detection on disagreement.
//   Otherwise the two corroborate each other and the model's box is used, since it can draw on
//   semantic context (e.g. "this looks like a stamped document") the local detector can't.
export async function detectCropBoxCascade(imageBuffer: Buffer): Promise<CropDetectionResult> {
  const { cropBox: modelCropBox, raw: modelRaw } = await detectCropBox(imageBuffer);
  const local = await detectDocumentBoxLocally(imageBuffer);
  const img = await loadImage(imageBuffer);
  const modelDegenerate = isFullBoundsOrMissing(modelCropBox, img.width, img.height);

  if (local.kind === 'vetoed') {
    return { cropBox: null, modelCropBox, modelRaw, floodCropBox: null, source: 'flood-veto' };
  }

  const floodCropBox = local.kind === 'box' ? local.box : null;

  if (!floodCropBox) {
    return {
      cropBox: modelDegenerate ? null : modelCropBox,
      modelCropBox,
      modelRaw,
      floodCropBox: null,
      source: modelDegenerate ? 'none' : 'model-only',
    };
  }

  const iou = modelCropBox ? rectIoU(modelCropBox, floodCropBox) : 0;

  if (modelDegenerate || iou < IOU_AGREEMENT_THRESHOLD) {
    return { cropBox: floodCropBox, modelCropBox, modelRaw, floodCropBox, source: 'flood-override' };
  }
  return { cropBox: modelCropBox, modelCropBox, modelRaw, floodCropBox, source: 'model-flood-agree' };
}
