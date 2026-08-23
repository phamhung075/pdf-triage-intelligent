import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { CropBox } from './vision-client.js';
import { findBlackWhitePoints, autoLevelsFromBlackWhite, sharpenPixel, AUTO_LEVELS_CLIP_PCT } from '../domain/image-adjust.js';
import { detectDocumentBox, isAdmissibleCrop, boxBlurRGB, WORK_MAX_DIM, BLUR_FRAC } from '../domain/flood-crop.js';

// Bake the decoder's EXIF handling into the pixels and drop the metadata, producing one canonical
// buffer that every later stage is guaranteed to read the same way.
//
// WHY THIS EXISTS. A JPEG's EXIF Orientation tag is an instruction to the decoder, and decoders
// disagree about whether to honour it. Measured in this stack: @napi-rs/canvas DOES apply it (a
// photo stored 2051x1154 with tag 6 decodes as 1154x2051), and so does OpenCV, which is what the
// PaddleOCR service decodes with. So by the time any of our stages sees pixels, the EXIF rotation
// has ALREADY been applied — while parseExifOrientation, reading the raw bytes, still reports the
// tag as a rotation waiting to be performed. Treating that tag as a correction therefore rotates an
// already-upright image a second time.
//
// Rather than teach each stage which decoders auto-rotate — a fact that can change with a library
// version and is invisible when it does — this normalizes once, at the pipeline entry. The PNG it
// returns carries no orientation metadata at all, so there is nothing left for anything downstream
// to interpret differently, and the orientation cascade that follows measures only the rotation the
// PHOTOGRAPH genuinely needs.
export async function normalizeOrientation(imageBuffer: Buffer): Promise<Buffer> {
  const img = await loadImage(imageBuffer);
  const canvas = createCanvas(img.width, img.height);
  canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas.toBuffer('image/png');
}

export async function rotateImage(imageBuffer: Buffer, degrees: 0 | 90 | 180 | 270): Promise<Buffer> {
  if (degrees === 0) return imageBuffer;
  const img = await loadImage(imageBuffer);
  const swap = degrees === 90 || degrees === 270;
  const w = swap ? img.height : img.width;
  const h = swap ? img.width : img.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.translate(w / 2, h / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  return canvas.toBuffer('image/png');
}

// The three possible answers the local, model-free detector can give. Two of them are NOT the
// same thing, and collapsing them into one `null` is what made the fills-frame guard inert:
//
//   'box'       a document with real background around it — crop here.
//   'no-signal' nothing covered the middle of the frame; the detector has no opinion, and some
//               other signal (the vision model) may still be trusted.
//   'vetoed'    a box WAS found, and the admissibility evidence says the frame IS the document:
//               there is no background to crop away, so cropping would destroy content. This is
//               the detector's most confident possible statement, not an absence of one.
export type LocalCropResult =
  | { kind: 'box'; box: CropBox }
  | { kind: 'no-signal' }
  | { kind: 'vetoed' };

// Local, model-free crop-boundary detection. Everything that decides "background vs document"
// lives in domain/flood-crop.ts (pure, zero I/O); this function is decode + prepare + map-back
// only:
//   1. decode and resample to the domain's common working scale (WORK_MAX_DIM),
//   2. pack RGBA into the 3-channel real-valued buffer the detector expects and box-blur it,
//   3. run detectDocumentBox / isAdmissibleCrop in WORKING pixel coordinates,
//   4. map the accepted box back to ORIGINAL image pixels.
export async function detectDocumentBoxLocally(imageBuffer: Buffer): Promise<LocalCropResult> {
  const img = await loadImage(imageBuffer);
  if (!img.width || !img.height) return { kind: 'no-signal' };
  const ds = Math.min(WORK_MAX_DIM / img.width, WORK_MAX_DIM / img.height, 1);
  const w = Math.max(1, Math.round(img.width * ds));
  const h = Math.max(1, Math.round(img.height * ds));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  // The working buffer MUST stay Float32 all the way into the detector. Quantising the blurred
  // image back to 8-bit here collapses a contrast-compressed photo's page boundary into a single
  // integer level, so the barrier cost that boundary should carry rounds away and stops being
  // measurable at all. Measured cost of doing it: mean IoU 0.951 instead of 0.968, plus two
  // outright failures on the re-lit (gamma/gain) variants of the corpus.
  const packed = new Float32Array(w * h * 3);
  for (let i = 0, p = 0, q = 0; i < w * h; i++, p += 4, q += 3) {
    packed[q] = data[p]; packed[q + 1] = data[p + 1]; packed[q + 2] = data[p + 2];
  }
  const radius = Math.max(1, Math.round(BLUR_FRAC * Math.min(w, h)));
  const rgb = boxBlurRGB(packed, w, h, radius);

  const r = detectDocumentBox(rgb, w, h);
  if (!r.box) return { kind: 'no-signal' };
  if (!isAdmissibleCrop(r)) return { kind: 'vetoed' };

  // Working -> original pixels. No outward padding is applied: the 0.968 mean IoU this detector
  // was measured at was measured with none, and a pad is an unmeasured bias on every box.
  //
  // There is deliberately NO minimum-area check here either. The old detector rejected any box
  // under 25% of the frame (FLOODCROP_MIN_AREA_RATIO). Every ground-truth box in the benchmark
  // corpus is 57-86% of frame, so that check never once bound on the bench and was entirely
  // untested — while in production it would silently impose a small-document cliff on receipts,
  // ID cards and business cards. The isolation it was standing in for (a leak into an interior
  // fragment) is already done properly by the domain's centreComponent stage.
  const scaleX = img.width / w;
  const scaleY = img.height / h;
  return {
    kind: 'box',
    box: {
      x: Math.round(r.box.left * scaleX),
      y: Math.round(r.box.top * scaleY),
      width: Math.round((r.box.right - r.box.left + 1) * scaleX),
      height: Math.round((r.box.bottom - r.box.top + 1) * scaleY),
    },
  };
}

// Two-valued convenience wrapper for callers that only want "a box or nothing" — the benchmark
// scripts (scripts/crop-score.ts, crop-bench.ts, crop-fillsframe-check.ts), which score a null as
// "no crop applied". Production must use detectDocumentBoxLocally instead: a veto and a shrug are
// very different answers and the cascade has to tell them apart.
export async function detectCropBoxLocally(imageBuffer: Buffer): Promise<CropBox | null> {
  const r = await detectDocumentBoxLocally(imageBuffer);
  return r.kind === 'box' ? r.box : null;
}

export async function cropImage(imageBuffer: Buffer, box: CropBox): Promise<Buffer> {
  const img = await loadImage(imageBuffer);
  const x = Math.max(0, Math.min(Math.round(box.x), img.width - 1));
  const y = Math.max(0, Math.min(Math.round(box.y), img.height - 1));
  const width = Math.max(1, Math.min(Math.round(box.width), img.width - x));
  const height = Math.max(1, Math.min(Math.round(box.height), img.height - y));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
  return canvas.toBuffer('image/png');
}

// A coarse downsampled view is plenty for a global histogram — mirrors pdf-awesome's
// auto-adjust.js maxDim=400 approach.
export async function computeAutoLevelsForImage(imageBuffer: Buffer): Promise<{ brightness: number; contrast: number }> {
  const img = await loadImage(imageBuffer);
  const maxDim = 400;
  const ds = Math.min(maxDim / img.width, maxDim / img.height, 1);
  const w = Math.max(1, Math.round(img.width * ds));
  const h = Math.max(1, Math.round(img.height * ds));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  const pixels = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    gray[i] = (pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114) | 0;
  }

  const { black, white } = findBlackWhitePoints(gray, AUTO_LEVELS_CLIP_PCT);
  return autoLevelsFromBlackWhite(black, white);
}

export async function applyBrightnessContrast(imageBuffer: Buffer, adjust: { brightness: number; contrast: number }): Promise<Buffer> {
  if (!adjust.brightness && !adjust.contrast) return imageBuffer;
  const img = await loadImage(imageBuffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  const parts: string[] = [];
  if (adjust.brightness) parts.push(`brightness(${1 + adjust.brightness / 100})`);
  if (adjust.contrast) parts.push(`contrast(${1 + adjust.contrast / 100})`);
  ctx.filter = parts.join(' ');
  ctx.drawImage(img, 0, 0);
  return canvas.toBuffer('image/png');
}

// Runs on raw canvas pixels since CSS/canvas filters have no sharpen primitive — same approach
// as pdf-awesome's js/domain/adjust.js applySharpen, ported to operate on a Buffer in/out.
export async function applySharpen(imageBuffer: Buffer, amount: number): Promise<Buffer> {
  if (!amount) return imageBuffer;
  const img = await loadImage(imageBuffer);
  const w = img.width, h = img.height;
  if (w < 3 || h < 3) return imageBuffer;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const src = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  const sd = src.data, od = out.data;

  for (let y = 0; y < h; y++) {
    const yUp = Math.max(y - 1, 0) * w, yDown = Math.min(y + 1, h - 1) * w, yRow = y * w;
    for (let x = 0; x < w; x++) {
      const xLeft = Math.max(x - 1, 0), xRight = Math.min(x + 1, w - 1);
      const i = (yRow + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        od[i + ch] = sharpenPixel(
          sd[i + ch],
          sd[(yUp + x) * 4 + ch], sd[(yDown + x) * 4 + ch],
          sd[(yRow + xLeft) * 4 + ch], sd[(yRow + xRight) * 4 + ch],
          amount
        );
      }
      od[i + 3] = sd[i + 3];
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toBuffer('image/png');
}
