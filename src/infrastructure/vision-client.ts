import { Ollama } from 'ollama';
import { loadImage } from '@napi-rs/canvas';
import { CONFIG } from './settings.js';
import { cleanAndParseJSON } from '../domain/classification.js';

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OrientationResult {
  rotationDegrees: 0 | 90 | 180 | 270;
  raw: string;
}

export interface CropResult {
  cropBox: CropBox | null;
  raw: string;
}

const VALID_ROTATIONS: readonly number[] = [0, 90, 180, 270];

// Two separate model calls (orientation, then crop) rather than one combined prompt — simpler,
// more focused prompt per sub-task. A JSON-unparseable response is a real failure and propagates
// (the diagnostic pipeline surfaces it and stops); a parseable-but-nonsensical value (invalid
// rotation, degenerate box) degrades to a safe default instead of throwing, so a single odd
// model answer doesn't kill the whole pipeline, while `raw` still carries what the model said.
export async function detectOrientation(imageBuffer: Buffer): Promise<OrientationResult> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  const prompt = `This photo shows a paper document (letter, receipt, or invoice) that may have been captured at any rotation. Determine the clockwise rotation in degrees needed to make its text upright and readable.
Respond with ONLY a JSON object, no other text: {"rotationDegrees": 0} where the value is exactly one of 0, 90, 180, or 270.`;

  const result: any = await ollama.generate({
    model: CONFIG.OLLAMA_VISION_MODEL,
    prompt,
    images: [imageBuffer.toString('base64')],
    format: 'json',
    think: false,
    options: { temperature: 0.1 },
  });
  const raw = result.response || '';
  const parsed = cleanAndParseJSON(raw);
  const value = Number(parsed.rotationDegrees);
  const rotationDegrees = (VALID_ROTATIONS.includes(value) ? value : 0) as 0 | 90 | 180 | 270;
  return { rotationDegrees, raw };
}

export async function detectCropBox(imageBuffer: Buffer): Promise<CropResult> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  const img = await loadImage(imageBuffer);
  const prompt = `This photo is ${img.width}x${img.height} pixels and shows a paper document lying on a background (desk, table, floor). Identify the bounding box of just the document, excluding the background around it.
Respond with ONLY a JSON object, no other text: {"cropBox": {"x": 0, "y": 0, "width": ${img.width}, "height": ${img.height}}} using pixel coordinates measured from the top-left corner. If the document already fills the whole photo, return the full image bounds.`;

  const result: any = await ollama.generate({
    model: CONFIG.OLLAMA_VISION_MODEL,
    prompt,
    images: [imageBuffer.toString('base64')],
    format: 'json',
    think: false,
    options: { temperature: 0.1 },
  });
  const raw = result.response || '';
  const parsed = cleanAndParseJSON(raw);
  const box = parsed.cropBox;
  const isValidBox = box
    && Number.isFinite(box.x) && Number.isFinite(box.y)
    && Number.isFinite(box.width) && Number.isFinite(box.height)
    && box.width > 0 && box.height > 0;
  return {
    cropBox: isValidBox ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
    raw,
  };
}
