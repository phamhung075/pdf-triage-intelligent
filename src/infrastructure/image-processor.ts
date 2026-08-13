import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { CropBox } from './vision-client.js';
import { findBlackWhitePoints, autoLevelsFromBlackWhite, sharpenPixel, AUTO_LEVELS_CLIP_PCT } from '../domain/image-adjust.js';

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
  const img = await loadImage(imageBuffer);
  const w = img.width, h = img.height;
  if (!amount || w < 3 || h < 3) return imageBuffer;

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
