# Image to PDF Vision Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a server-side pipeline that takes a phone photo of a document, auto-detects and corrects its orientation and crop boundary via the local `minicpm-v4.6` Ollama vision model, auto-enhances brightness/contrast/sharpness (ported from `pdf-awesome`), and exposes it through a standalone diagnostic "Vision Lab" test page on port 3179 showing every intermediate step.

**Architecture:** Pure math lives in `src/domain/image-adjust.ts` (ported verbatim from `pdf-awesome/js/domain/auto-adjust.js` and `adjust.js` — already framework-agnostic). Ollama vision calls live in `src/infrastructure/vision-client.ts`. Canvas pixel operations (rotate/crop/enhance) live in `src/infrastructure/image-processor.ts`, using `@napi-rs/canvas` (already a dependency). `src/application/image-to-pdf.ts` orchestrates the 4-step pipeline (original → oriented → cropped → enhanced). `src/vision-lab-server.ts` is a standalone Express entrypoint (independent of the main triage app) serving one API route and the static test page.

**Tech Stack:** TypeScript, Express, `@napi-rs/canvas`, `ollama` npm client, Vitest, `supertest`.

**Spec:** `docs/superpowers/specs/2026-08-13-image-to-pdf-vision-lab-design.md`

## Global Constraints

- Vision model is pinned to `minicpm-v4.6:latest` — any other value falls back to it with a `console.warn`, mirroring the existing Golden Rule #14 pattern for `OLLAMA_MODEL` (see `src/infrastructure/settings.ts:44-51`).
- All new backend source files use `.js`-suffixed relative imports (ESM/NodeNext convention already used throughout `src/`, e.g. `src/infrastructure/ollama-client.ts:2`).
- Orientation/crop detection are two separate `ollama.generate()` calls, not one combined prompt (per approved spec).
- The diagnostic route/pipeline does not swallow real (unparseable-JSON) errors from the vision model — a failing step carries an `error` field and the pipeline stops at that step. A parseable-but-semantically-invalid value (e.g. an out-of-range rotation, a degenerate crop box) is a different case: it degrades to a safe default (0° rotation / no crop) while still surfacing the model's raw response for diagnosis — never thrown.
- `vision-lab-server.ts` is fully decoupled from `src/infrastructure/http/web-server.ts` — separate Express app, separate port (`CONFIG.VISION_LAB_PORT`, default 3179), can run alongside `npm run dev` at the same time.
- No PDF assembly, no `__raws` writing, no MCP tool, no UI button in this plan — diagnostic pipeline + test page only (see spec's "out of scope").

---

## Task 1: Pin the vision model and Vision Lab port in settings

**Files:**
- Modify: `src/infrastructure/settings.ts`
- Modify: `src/infrastructure/settings.test.ts`

**Interfaces:**
- Produces: `CONFIG.OLLAMA_VISION_MODEL: string` (always `'minicpm-v4.6:latest'`), `CONFIG.VISION_LAB_PORT: number` (default `3179`, overridable via `process.env.VISION_LAB_PORT`).

- [ ] **Step 1: Write the failing tests**

Add to `src/infrastructure/settings.test.ts`, inside the existing `describe('CONFIG derivation at module load', ...)` block (after the existing Golden Rule #14 test, so it sits next to the pattern it mirrors):

```typescript
    it('defaults OLLAMA_VISION_MODEL to minicpm-v4.6:latest with no env override', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.OLLAMA_VISION_MODEL).toBe('minicpm-v4.6:latest');
    });

    it('rejects an unsupported OLLAMA_VISION_MODEL env override and falls back', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const original = process.env.OLLAMA_VISION_MODEL;
      process.env.OLLAMA_VISION_MODEL = 'llava:7b';
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.OLLAMA_VISION_MODEL).toBe('minicpm-v4.6:latest');
      consoleWarnSpy.mockRestore();
      if (original === undefined) delete process.env.OLLAMA_VISION_MODEL;
      else process.env.OLLAMA_VISION_MODEL = original;
    });

    it('defaults VISION_LAB_PORT to 3179 with no env override', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const original = process.env.VISION_LAB_PORT;
      delete process.env.VISION_LAB_PORT;
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.VISION_LAB_PORT).toBe(3179);
      if (original !== undefined) process.env.VISION_LAB_PORT = original;
    });

    it('reads VISION_LAB_PORT from an env override', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const original = process.env.VISION_LAB_PORT;
      process.env.VISION_LAB_PORT = '4000';
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.VISION_LAB_PORT).toBe(4000);
      if (original === undefined) delete process.env.VISION_LAB_PORT;
      else process.env.VISION_LAB_PORT = original;
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/infrastructure/settings.test.ts`
Expected: FAIL — `CONFIG.OLLAMA_VISION_MODEL` / `CONFIG.VISION_LAB_PORT` are `undefined`.

- [ ] **Step 3: Implement**

In `src/infrastructure/settings.ts`, add right after the existing `sanitizeOllamaModel` function (after line 51):

```typescript
// Same lock-down pattern as ALLOWED_OLLAMA_MODEL above, but for the separate vision model
// used by the Vision Lab image-to-PDF pipeline (orientation/crop detection) — a distinct
// concern from text classification, so it gets its own pinned value rather than overloading
// OLLAMA_MODEL / Golden Rule #14.
const ALLOWED_OLLAMA_VISION_MODEL = 'minicpm-v4.6:latest';
function sanitizeOllamaVisionModel(model: unknown): string {
  if (model === ALLOWED_OLLAMA_VISION_MODEL) return ALLOWED_OLLAMA_VISION_MODEL;
  if (model) {
    console.warn(`Ignoring unsupported ollama_vision_model '${model}' (only '${ALLOWED_OLLAMA_VISION_MODEL}' is supported by the Vision Lab pipeline) — falling back to '${ALLOWED_OLLAMA_VISION_MODEL}'.`);
  }
  return ALLOWED_OLLAMA_VISION_MODEL;
}
```

Then add two fields to the `CONFIG` object (after the existing `OLLAMA_EMBED_MODEL` line):

```typescript
  OLLAMA_VISION_MODEL: sanitizeOllamaVisionModel(process.env.OLLAMA_VISION_MODEL),
  VISION_LAB_PORT: parseInt(process.env.VISION_LAB_PORT || '3179', 10),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/infrastructure/settings.test.ts`
Expected: PASS, all tests including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/settings.ts src/infrastructure/settings.test.ts
git commit -m "feat(vision-lab): pin OLLAMA_VISION_MODEL and add VISION_LAB_PORT config"
```

---

## Task 2: Port pure auto-levels/sharpen math from pdf-awesome

**Files:**
- Create: `src/domain/image-adjust.ts`
- Create: `src/domain/image-adjust.test.ts`

**Interfaces:**
- Produces:
  - `AUTO_LEVELS_CLIP_PCT: number` (`0.01`)
  - `AUTO_LEVELS_MIN_RANGE: number` (`0.05`)
  - `AUTO_ADJUST_SHARPNESS: number` (`25`)
  - `findBlackWhitePoints(gray: Uint8ClampedArray, clipPct: number): { black: number; white: number }`
  - `autoLevelsFromBlackWhite(black: number, white: number): { brightness: number; contrast: number }`
  - `sharpenPixel(center: number, n: number, s: number, w: number, e: number, amount: number): number`
- Consumes: nothing (pure, zero I/O, zero dependencies).

- [ ] **Step 1: Write the failing tests**

Create `src/domain/image-adjust.test.ts` (test values ported verbatim from `pdf-awesome/tests/test.js`, already validated against that implementation):

```typescript
import { describe, it, expect } from 'vitest';
import { findBlackWhitePoints, autoLevelsFromBlackWhite, sharpenPixel, AUTO_ADJUST_SHARPNESS } from './image-adjust.js';

describe('findBlackWhitePoints', () => {
  it('clips outlier pixels and lands the black/white points on the real tonal extremes', () => {
    // 3px each at 0/255 (outliers), 88 midtone at 128, 3px each at 10/245 (the "real" extremes)
    const gray = new Uint8ClampedArray(100);
    let i = 0;
    for (let k = 0; k < 3; k++) gray[i++] = 0;
    for (let k = 0; k < 3; k++) gray[i++] = 10;
    for (let k = 0; k < 88; k++) gray[i++] = 128;
    for (let k = 0; k < 3; k++) gray[i++] = 245;
    for (let k = 0; k < 3; k++) gray[i++] = 255;
    const { black, white } = findBlackWhitePoints(gray, 0.03);
    expect(black).toBe(10);
    expect(white).toBe(245);
  });

  it('a perfectly flat image has black point = white point', () => {
    const gray = new Uint8ClampedArray(50).fill(128);
    const { black, white } = findBlackWhitePoints(gray, 0.01);
    expect(black).toBe(128);
    expect(white).toBe(128);
  });
});

describe('autoLevelsFromBlackWhite', () => {
  it('already full-range (0..255) needs no adjustment', () => {
    expect(autoLevelsFromBlackWhite(0, 255)).toEqual({ brightness: 0, contrast: 0 });
  });

  it('underexposed/low-contrast range brightens and boosts contrast to fill 0..255', () => {
    expect(autoLevelsFromBlackWhite(26, 204)).toEqual({ brightness: 11, contrast: 29 });
  });

  it('near-flat range (black ≈ white) bails out rather than amplifying noise', () => {
    expect(autoLevelsFromBlackWhite(120, 124)).toEqual({ brightness: 0, contrast: 0 });
  });

  it('an extreme stretch clamps brightness at +50', () => {
    const extreme = autoLevelsFromBlackWhite(0, 26);
    expect(extreme.brightness).toBe(50);
    expect(extreme.contrast).toBe(0);
  });
});

describe('sharpenPixel', () => {
  it('amount=0 leaves the pixel unchanged', () => {
    expect(sharpenPixel(100, 90, 90, 90, 90, 0)).toBe(100);
  });

  it('amount=100 boosts a brighter-than-neighbors pixel', () => {
    expect(sharpenPixel(100, 90, 90, 90, 90, 100)).toBe(140);
  });

  it('amount=100 darkens a dimmer-than-neighbors pixel', () => {
    expect(sharpenPixel(100, 110, 110, 110, 110, 100)).toBe(60);
  });

  it('result clamps at 255', () => {
    expect(sharpenPixel(250, 0, 0, 0, 0, 100)).toBe(255);
  });

  it('result clamps at 0', () => {
    expect(sharpenPixel(5, 255, 255, 255, 255, 100)).toBe(0);
  });
});

describe('AUTO_ADJUST_SHARPNESS', () => {
  it('is the fixed default of 25 (no reliable single-photo blur measurement, same as pdf-awesome)', () => {
    expect(AUTO_ADJUST_SHARPNESS).toBe(25);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/image-adjust.test.ts`
Expected: FAIL — `./image-adjust.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/domain/image-adjust.ts`:

```typescript
// Ported from pdf-awesome's js/domain/auto-adjust.js and js/domain/adjust.js — both are
// already pure/framework-agnostic functions with no DOM or canvas dependency, so they carry
// over unchanged. See pdf-awesome/tests/test.js for the original validated test cases.

export const AUTO_ADJUST_SHARPNESS = 25;

// Fraction of pixels clipped as outliers at each end of the histogram before picking the
// black/white points, so a few stray dark/bright specks (shadows, glare) don't skew the stretch.
export const AUTO_LEVELS_CLIP_PCT = 0.01;

// Black/white points closer than this (0..1 normalized) mean the image is close to a single
// flat tone — nothing safe to stretch, so bail out rather than amplifying noise.
export const AUTO_LEVELS_MIN_RANGE = 0.05;

// Scans a grayscale histogram from both ends and returns the value where the running pixel
// count first exceeds clipPct of the total — the darkest/lightest points once the tiny
// outlier tails are ignored.
export function findBlackWhitePoints(gray: Uint8ClampedArray, clipPct: number): { black: number; white: number } {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  const clipCount = total * clipPct;

  let cum = 0, black = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum > clipCount) { black = v; break; }
  }
  cum = 0;
  let white = 255;
  for (let v = 255; v >= 0; v--) {
    cum += hist[v];
    if (cum > clipCount) { white = v; break; }
  }
  return { black, white };
}

// Solves for CSS brightness()/contrast() multipliers k1/k2 such that the composed transform
// contrast(brightness(x)) maps black->0 and white->1, then converts those multipliers into
// +/-50 delta sliders (brightness(1 + b/100) / contrast(1 + c/100)).
export function autoLevelsFromBlackWhite(black: number, white: number): { brightness: number; contrast: number } {
  const l = black / 255, h = white / 255;
  if (h - l < AUTO_LEVELS_MIN_RANGE) return { brightness: 0, contrast: 0 };

  const sum = l + h;
  const range = h - l;
  const k1 = sum > 0.01 ? 1 / sum : 1;
  const k2 = sum > 0.01 ? sum / range : 1;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  return {
    brightness: Math.round(clamp((k1 - 1) * 100, -50, 50)),
    contrast: Math.round(clamp((k2 - 1) * 100, -50, 50)),
  };
}

// Blended 3x3 Laplacian/unsharp kernel: identity at amount=0, full sharpen at amount=100.
export function sharpenPixel(center: number, n: number, s: number, w: number, e: number, amount: number): number {
  const t = amount / 100;
  const v = (1 + 4 * t) * center - t * (n + s + w + e);
  return Math.max(0, Math.min(255, v));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/image-adjust.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/image-adjust.ts src/domain/image-adjust.test.ts
git commit -m "feat(vision-lab): port auto-levels and sharpen math from pdf-awesome"
```

---

## Task 3: Vision-model client (orientation + crop detection)

**Files:**
- Create: `src/infrastructure/vision-client.ts`
- Create: `src/infrastructure/vision-client.test.ts`

**Interfaces:**
- Consumes: `CONFIG.OLLAMA_HOST`, `CONFIG.OLLAMA_VISION_MODEL` (Task 1); `cleanAndParseJSON(rawStr: string): any` from `src/domain/classification.ts` (existing).
- Produces:
  - `interface CropBox { x: number; y: number; width: number; height: number }`
  - `interface OrientationResult { rotationDegrees: 0 | 90 | 180 | 270; raw: string }`
  - `interface CropResult { cropBox: CropBox | null; raw: string }`
  - `detectOrientation(imageBuffer: Buffer): Promise<OrientationResult>`
  - `detectCropBox(imageBuffer: Buffer): Promise<CropResult>`

- [ ] **Step 1: Write the failing tests**

Create `src/infrastructure/vision-client.test.ts` (mocking pattern copied from `src/infrastructure/ollama-client.test.ts`, plus mocking `@napi-rs/canvas`'s `loadImage` for the crop-box prompt's image dimensions):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Ollama } from 'ollama';

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(function () {
    return { generate: generateMock };
  }),
}));

const { loadImageMock } = vi.hoisted(() => ({ loadImageMock: vi.fn() }));
vi.mock('@napi-rs/canvas', () => ({ loadImage: loadImageMock }));

afterEach(() => {
  vi.resetAllMocks();
});

beforeEach(() => {
  vi.resetModules();
  generateMock.mockReset();
  loadImageMock.mockReset();
  vi.mocked(Ollama).mockImplementation(function () {
    return { generate: generateMock } as any;
  } as any);
});

describe('detectOrientation', () => {
  it('calls Ollama with the vision model, the image, and format:json/think:false', async () => {
    generateMock.mockResolvedValue({ response: '{"rotationDegrees": 90}' });
    const { detectOrientation } = await import('./vision-client.js');
    const buf = Buffer.from('fake-image-bytes');
    await detectOrientation(buf);

    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'minicpm-v4.6:latest',
        images: [buf.toString('base64')],
        format: 'json',
        think: false,
      })
    );
  });

  it('parses a valid rotationDegrees value', async () => {
    generateMock.mockResolvedValue({ response: '{"rotationDegrees": 270}' });
    const { detectOrientation } = await import('./vision-client.js');
    const result = await detectOrientation(Buffer.from('x'));
    expect(result.rotationDegrees).toBe(270);
    expect(result.raw).toBe('{"rotationDegrees": 270}');
  });

  it('falls back to 0 for an out-of-set rotationDegrees value without throwing', async () => {
    generateMock.mockResolvedValue({ response: '{"rotationDegrees": 45}' });
    const { detectOrientation } = await import('./vision-client.js');
    const result = await detectOrientation(Buffer.from('x'));
    expect(result.rotationDegrees).toBe(0);
    expect(result.raw).toBe('{"rotationDegrees": 45}');
  });

  it('propagates an error when the model response is not parseable JSON at all', async () => {
    generateMock.mockResolvedValue({ response: 'sorry, I cannot help with that' });
    const { detectOrientation } = await import('./vision-client.js');
    await expect(detectOrientation(Buffer.from('x'))).rejects.toThrow();
  });
});

describe('detectCropBox', () => {
  it('includes the image dimensions (from loadImage) in the prompt', async () => {
    loadImageMock.mockResolvedValue({ width: 800, height: 600 });
    generateMock.mockResolvedValue({ response: '{"cropBox": {"x": 10, "y": 20, "width": 700, "height": 500}}' });
    const { detectCropBox } = await import('./vision-client.js');
    await detectCropBox(Buffer.from('x'));

    const call = generateMock.mock.calls[0][0];
    expect(call.prompt).toContain('800x600');
  });

  it('parses a valid cropBox', async () => {
    loadImageMock.mockResolvedValue({ width: 800, height: 600 });
    generateMock.mockResolvedValue({ response: '{"cropBox": {"x": 10, "y": 20, "width": 700, "height": 500}}' });
    const { detectCropBox } = await import('./vision-client.js');
    const result = await detectCropBox(Buffer.from('x'));
    expect(result.cropBox).toEqual({ x: 10, y: 20, width: 700, height: 500 });
  });

  it('returns cropBox:null (not a throw) for a degenerate box (zero/negative width)', async () => {
    loadImageMock.mockResolvedValue({ width: 800, height: 600 });
    generateMock.mockResolvedValue({ response: '{"cropBox": {"x": 0, "y": 0, "width": 0, "height": 500}}' });
    const { detectCropBox } = await import('./vision-client.js');
    const result = await detectCropBox(Buffer.from('x'));
    expect(result.cropBox).toBeNull();
    expect(result.raw).toContain('"width": 0');
  });

  it('propagates an error when the model response is not parseable JSON at all', async () => {
    loadImageMock.mockResolvedValue({ width: 800, height: 600 });
    generateMock.mockResolvedValue({ response: 'not json' });
    const { detectCropBox } = await import('./vision-client.js');
    await expect(detectCropBox(Buffer.from('x'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/infrastructure/vision-client.test.ts`
Expected: FAIL — `./vision-client.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/infrastructure/vision-client.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/infrastructure/vision-client.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/vision-client.ts src/infrastructure/vision-client.test.ts
git commit -m "feat(vision-lab): add minicpm-v4.6 orientation and crop-box detection client"
```

---

## Task 4: Canvas image processor (rotate, crop, enhance)

**Files:**
- Create: `src/infrastructure/image-processor.ts`
- Create: `src/infrastructure/image-processor.test.ts`

**Interfaces:**
- Consumes: `CropBox` (Task 3, re-exported from here — see note below), `findBlackWhitePoints`, `autoLevelsFromBlackWhite`, `AUTO_LEVELS_CLIP_PCT`, `sharpenPixel` (Task 2).
- Produces:
  - `rotateImage(imageBuffer: Buffer, degrees: 0 | 90 | 180 | 270): Promise<Buffer>`
  - `cropImage(imageBuffer: Buffer, box: CropBox): Promise<Buffer>`
  - `computeAutoLevelsForImage(imageBuffer: Buffer): Promise<{ brightness: number; contrast: number }>`
  - `applyBrightnessContrast(imageBuffer: Buffer, adjust: { brightness: number; contrast: number }): Promise<Buffer>`
  - `applySharpen(imageBuffer: Buffer, amount: number): Promise<Buffer>`

Note: `CropBox` is defined in `vision-client.ts` (Task 3) since it's the vision model's output shape; `image-processor.ts` imports the type from there (`import type { CropBox } from './vision-client.js'`) rather than redefining it.

These tests use the real `@napi-rs/canvas` (fast, deterministic, fully offline — no mocking needed) to build tiny synthetic images and check geometry/dimension/no-op-shortcut properties. They deliberately do NOT assert exact post-rotation/post-enhance pixel values (that would require hand-derived transform math prone to being subtly wrong) — visual/content correctness against real photos is verified live via the Vision Lab test page (Task 8), per the spec.

- [ ] **Step 1: Write the failing tests**

Create `src/infrastructure/image-processor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { rotateImage, cropImage, computeAutoLevelsForImage, applyBrightnessContrast, applySharpen } from './image-processor.js';

async function makeTestPng(w: number, h: number): Promise<Buffer> {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(200,200,200)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgb(20,20,20)';
  ctx.fillRect(0, 0, Math.max(1, Math.floor(w / 4)), Math.max(1, Math.floor(h / 4)));
  return canvas.toBuffer('image/png');
}

describe('rotateImage', () => {
  it('returns the input unchanged for degrees=0', async () => {
    const buf = await makeTestPng(10, 6);
    const result = await rotateImage(buf, 0);
    expect(result).toBe(buf);
  });

  it('swaps width/height for a 90 degree rotation', async () => {
    const buf = await makeTestPng(10, 6);
    const result = await rotateImage(buf, 90);
    const img = await loadImage(result);
    expect(img.width).toBe(6);
    expect(img.height).toBe(10);
  });

  it('swaps width/height for a 270 degree rotation', async () => {
    const buf = await makeTestPng(10, 6);
    const result = await rotateImage(buf, 270);
    const img = await loadImage(result);
    expect(img.width).toBe(6);
    expect(img.height).toBe(10);
  });

  it('keeps the same width/height for a 180 degree rotation', async () => {
    const buf = await makeTestPng(10, 6);
    const result = await rotateImage(buf, 180);
    const img = await loadImage(result);
    expect(img.width).toBe(10);
    expect(img.height).toBe(6);
  });
});

describe('cropImage', () => {
  it('produces exactly the requested dimensions when the box is fully inside bounds', async () => {
    const buf = await makeTestPng(100, 80);
    const result = await cropImage(buf, { x: 10, y: 10, width: 50, height: 40 });
    const img = await loadImage(result);
    expect(img.width).toBe(50);
    expect(img.height).toBe(40);
  });

  it('clamps a box that extends past the image bounds', async () => {
    const buf = await makeTestPng(100, 80);
    const result = await cropImage(buf, { x: 90, y: 70, width: 50, height: 40 });
    const img = await loadImage(result);
    expect(img.width).toBeLessThanOrEqual(10);
    expect(img.height).toBeLessThanOrEqual(10);
  });
});

describe('computeAutoLevelsForImage', () => {
  it('boosts contrast for a low-contrast synthetic document', async () => {
    const canvas = createCanvas(100, 100);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(200,200,200)';
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = 'rgb(60,60,60)';
    ctx.fillRect(0, 0, 15, 15);
    const buf = canvas.toBuffer('image/png');

    const levels = await computeAutoLevelsForImage(buf);
    expect(levels.contrast).toBeGreaterThan(20);
    expect(Math.abs(levels.brightness)).toBeLessThan(20);
  });
});

describe('applyBrightnessContrast', () => {
  it('returns the input unchanged when both deltas are zero', async () => {
    const buf = await makeTestPng(10, 10);
    const result = await applyBrightnessContrast(buf, { brightness: 0, contrast: 0 });
    expect(result).toBe(buf);
  });

  it('preserves dimensions and returns a valid decodable PNG when adjusting', async () => {
    const buf = await makeTestPng(10, 10);
    const result = await applyBrightnessContrast(buf, { brightness: 20, contrast: 15 });
    const img = await loadImage(result);
    expect(img.width).toBe(10);
    expect(img.height).toBe(10);
  });
});

describe('applySharpen', () => {
  it('returns the input unchanged when amount is 0', async () => {
    const buf = await makeTestPng(10, 10);
    const result = await applySharpen(buf, 0);
    expect(result).toBe(buf);
  });

  it('changes pixel data for a synthetic image with a hard edge', async () => {
    const buf = await makeTestPng(10, 10);
    const result = await applySharpen(buf, 25);
    expect(Buffer.compare(result, buf)).not.toBe(0);
  });

  it('preserves dimensions after sharpening', async () => {
    const buf = await makeTestPng(10, 10);
    const result = await applySharpen(buf, 25);
    const img = await loadImage(result);
    expect(img.width).toBe(10);
    expect(img.height).toBe(10);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/infrastructure/image-processor.test.ts`
Expected: FAIL — `./image-processor.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/infrastructure/image-processor.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/infrastructure/image-processor.test.ts`
Expected: PASS, all 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/image-processor.ts src/infrastructure/image-processor.test.ts
git commit -m "feat(vision-lab): add napi-rs/canvas rotate/crop/enhance image processor"
```

---

## Task 5: Pipeline orchestrator

**Files:**
- Create: `src/application/image-to-pdf.ts`
- Create: `src/application/image-to-pdf.test.ts`

**Interfaces:**
- Consumes: `detectOrientation`, `detectCropBox` (Task 3); `rotateImage`, `cropImage`, `computeAutoLevelsForImage`, `applyBrightnessContrast`, `applySharpen` (Task 4); `AUTO_ADJUST_SHARPNESS` (Task 2).
- Produces:
  - `interface PipelineStep { step: number; label: 'original' | 'oriented' | 'cropped' | 'enhanced'; imageBase64: string; modelRaw?: string; meta?: Record<string, unknown>; error?: string }`
  - `runVisionPipeline(imageBuffer: Buffer): Promise<PipelineStep[]>`

- [ ] **Step 1: Write the failing tests**

Create `src/application/image-to-pdf.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { detectOrientationMock, detectCropBoxMock } = vi.hoisted(() => ({
  detectOrientationMock: vi.fn(),
  detectCropBoxMock: vi.fn(),
}));
vi.mock('../infrastructure/vision-client.js', () => ({
  detectOrientation: detectOrientationMock,
  detectCropBox: detectCropBoxMock,
}));

const {
  rotateImageMock, cropImageMock, computeAutoLevelsForImageMock,
  applyBrightnessContrastMock, applySharpenMock,
} = vi.hoisted(() => ({
  rotateImageMock: vi.fn(),
  cropImageMock: vi.fn(),
  computeAutoLevelsForImageMock: vi.fn(),
  applyBrightnessContrastMock: vi.fn(),
  applySharpenMock: vi.fn(),
}));
vi.mock('../infrastructure/image-processor.js', () => ({
  rotateImage: rotateImageMock,
  cropImage: cropImageMock,
  computeAutoLevelsForImage: computeAutoLevelsForImageMock,
  applyBrightnessContrast: applyBrightnessContrastMock,
  applySharpen: applySharpenMock,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

const originalBuf = Buffer.from('original');
const orientedBuf = Buffer.from('oriented');
const croppedBuf = Buffer.from('cropped');
const leveledBuf = Buffer.from('leveled');
const finalBuf = Buffer.from('final');

function mockHappyPath() {
  detectOrientationMock.mockResolvedValue({ rotationDegrees: 90, raw: '{"rotationDegrees":90}' });
  rotateImageMock.mockResolvedValue(orientedBuf);
  detectCropBoxMock.mockResolvedValue({ cropBox: { x: 1, y: 2, width: 3, height: 4 }, raw: '{"cropBox":{}}' });
  cropImageMock.mockResolvedValue(croppedBuf);
  computeAutoLevelsForImageMock.mockResolvedValue({ brightness: 5, contrast: 6 });
  applyBrightnessContrastMock.mockResolvedValue(leveledBuf);
  applySharpenMock.mockResolvedValue(finalBuf);
}

describe('runVisionPipeline', () => {
  it('runs all 4 steps in order on the happy path', async () => {
    mockHappyPath();
    const { runVisionPipeline } = await import('./image-to-pdf.js');
    const steps = await runVisionPipeline(originalBuf);

    expect(steps.map(s => s.label)).toEqual(['original', 'oriented', 'cropped', 'enhanced']);
    expect(steps[0].imageBase64).toBe(originalBuf.toString('base64'));
    expect(steps[1].imageBase64).toBe(orientedBuf.toString('base64'));
    expect(steps[1].modelRaw).toBe('{"rotationDegrees":90}');
    expect(steps[1].meta).toEqual({ rotationDegrees: 90 });
    expect(steps[2].imageBase64).toBe(croppedBuf.toString('base64'));
    expect(steps[2].meta).toEqual({ cropBox: { x: 1, y: 2, width: 3, height: 4 } });
    expect(steps[3].imageBase64).toBe(finalBuf.toString('base64'));
    expect(steps[3].meta).toEqual({ brightness: 5, contrast: 6, sharpness: 25 });

    expect(rotateImageMock).toHaveBeenCalledWith(originalBuf, 90);
    expect(detectCropBoxMock).toHaveBeenCalledWith(orientedBuf);
    expect(cropImageMock).toHaveBeenCalledWith(orientedBuf, { x: 1, y: 2, width: 3, height: 4 });
    expect(applyBrightnessContrastMock).toHaveBeenCalledWith(croppedBuf, { brightness: 5, contrast: 6 });
    expect(applySharpenMock).toHaveBeenCalledWith(leveledBuf, 25);
  });

  it('uses the oriented image as-is when crop detection returns cropBox:null', async () => {
    mockHappyPath();
    detectCropBoxMock.mockResolvedValue({ cropBox: null, raw: '{"cropBox":null}' });
    computeAutoLevelsForImageMock.mockResolvedValue({ brightness: 0, contrast: 0 });
    const { runVisionPipeline } = await import('./image-to-pdf.js');
    const steps = await runVisionPipeline(originalBuf);

    expect(cropImageMock).not.toHaveBeenCalled();
    expect(steps[2].imageBase64).toBe(orientedBuf.toString('base64'));
    expect(steps[2].meta).toEqual({ cropBox: null });
  });

  it('stops after step 1 with an error field when orientation detection fails', async () => {
    detectOrientationMock.mockRejectedValue(new Error('vision model unreachable'));
    const { runVisionPipeline } = await import('./image-to-pdf.js');
    const steps = await runVisionPipeline(originalBuf);

    expect(steps).toHaveLength(2);
    expect(steps[1].label).toBe('oriented');
    expect(steps[1].error).toBe('vision model unreachable');
  });

  it('stops after step 2 with an error field when crop detection fails', async () => {
    mockHappyPath();
    detectCropBoxMock.mockRejectedValue(new Error('malformed JSON from model'));
    const { runVisionPipeline } = await import('./image-to-pdf.js');
    const steps = await runVisionPipeline(originalBuf);

    expect(steps).toHaveLength(3);
    expect(steps[2].label).toBe('cropped');
    expect(steps[2].error).toBe('malformed JSON from model');
  });

  it('carries an error field on the final step when enhancement fails, without dropping earlier steps', async () => {
    mockHappyPath();
    applySharpenMock.mockRejectedValue(new Error('canvas encode failed'));
    const { runVisionPipeline } = await import('./image-to-pdf.js');
    const steps = await runVisionPipeline(originalBuf);

    expect(steps).toHaveLength(4);
    expect(steps[3].label).toBe('enhanced');
    expect(steps[3].error).toBe('canvas encode failed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/application/image-to-pdf.test.ts`
Expected: FAIL — `./image-to-pdf.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/application/image-to-pdf.ts`:

```typescript
import { detectOrientation, detectCropBox } from '../infrastructure/vision-client.js';
import { rotateImage, cropImage, computeAutoLevelsForImage, applyBrightnessContrast, applySharpen } from '../infrastructure/image-processor.js';
import { AUTO_ADJUST_SHARPNESS } from '../domain/image-adjust.js';

export interface PipelineStep {
  step: number;
  label: 'original' | 'oriented' | 'cropped' | 'enhanced';
  imageBase64: string;
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
    { step: 0, label: 'original', imageBase64: imageBuffer.toString('base64') },
  ];

  let orientedBuffer: Buffer;
  try {
    const { rotationDegrees, raw } = await detectOrientation(imageBuffer);
    orientedBuffer = await rotateImage(imageBuffer, rotationDegrees);
    steps.push({ step: 1, label: 'oriented', imageBase64: orientedBuffer.toString('base64'), modelRaw: raw, meta: { rotationDegrees } });
  } catch (err) {
    steps.push({ step: 1, label: 'oriented', imageBase64: '', error: errorMessage(err) });
    return steps;
  }

  let croppedBuffer: Buffer;
  try {
    const { cropBox, raw } = await detectCropBox(orientedBuffer);
    croppedBuffer = cropBox ? await cropImage(orientedBuffer, cropBox) : orientedBuffer;
    steps.push({ step: 2, label: 'cropped', imageBase64: croppedBuffer.toString('base64'), modelRaw: raw, meta: { cropBox } });
  } catch (err) {
    steps.push({ step: 2, label: 'cropped', imageBase64: '', error: errorMessage(err) });
    return steps;
  }

  try {
    const { brightness, contrast } = await computeAutoLevelsForImage(croppedBuffer);
    const leveledBuffer = await applyBrightnessContrast(croppedBuffer, { brightness, contrast });
    const finalBuffer = await applySharpen(leveledBuffer, AUTO_ADJUST_SHARPNESS);
    steps.push({ step: 3, label: 'enhanced', imageBase64: finalBuffer.toString('base64'), meta: { brightness, contrast, sharpness: AUTO_ADJUST_SHARPNESS } });
  } catch (err) {
    steps.push({ step: 3, label: 'enhanced', imageBase64: '', error: errorMessage(err) });
  }

  return steps;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/application/image-to-pdf.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/application/image-to-pdf.ts src/application/image-to-pdf.test.ts
git commit -m "feat(vision-lab): add runVisionPipeline orchestrator"
```

---

## Task 6: Standalone Vision Lab server

**Files:**
- Create: `src/vision-lab-server.ts`
- Create: `src/vision-lab-server.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `runVisionPipeline` (Task 5); `CONFIG.VISION_LAB_PORT`, `CONFIG.HOST`, `BASE_DIR` (existing/Task 1).
- Produces: `createVisionLabApp(): express.Express`, `startVisionLabServer(port?: number): void`.

- [ ] **Step 1: Write the failing tests**

Create `src/vision-lab-server.test.ts` (supertest pattern copied from `src/infrastructure/http/web-server.test.ts`):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';

vi.mock('fs');

const { runVisionPipelineMock } = vi.hoisted(() => ({ runVisionPipelineMock: vi.fn() }));
vi.mock('./application/image-to-pdf.js', () => ({ runVisionPipeline: runVisionPipelineMock }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

describe('POST /api/vision/diagnose-image', () => {
  it('returns 400 when imageBase64 is missing', async () => {
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-image').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(runVisionPipelineMock).not.toHaveBeenCalled();
  });

  it('returns 400 when imageBase64 is not a string', async () => {
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-image').send({ imageBase64: 123 });
    expect(res.status).toBe(400);
  });

  it('runs the pipeline and returns its steps on success', async () => {
    const fakeSteps = [{ step: 0, label: 'original', imageBase64: 'abc' }];
    runVisionPipelineMock.mockResolvedValue(fakeSteps);
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-image').send({ imageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ steps: fakeSteps });
    expect(runVisionPipelineMock).toHaveBeenCalledWith(Buffer.from('ZmFrZQ==', 'base64'));
  });

  it('returns 500 with the error message when the pipeline throws', async () => {
    runVisionPipelineMock.mockRejectedValue(new Error('ollama unreachable'));
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-image').send({ imageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('ollama unreachable');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/vision-lab-server.test.ts`
Expected: FAIL — `./vision-lab-server.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/vision-lab-server.ts`:

```typescript
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { CONFIG, BASE_DIR } from './infrastructure/settings.js';
import { runVisionPipeline } from './application/image-to-pdf.js';

const THIS_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function createVisionLabApp(): express.Express {
  const app = express();

  // Phone photos as base64 run several MB — well past Express's 100kb JSON default.
  app.use(express.json({ limit: '25mb' }));

  const publicDir = path.join(BASE_DIR, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, {
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    }));
  }

  app.post('/api/vision/diagnose-image', async (req, res) => {
    const { imageBase64 } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      res.status(400).json({ error: 'imageBase64 (string) is required' });
      return;
    }
    try {
      const buffer = Buffer.from(imageBase64, 'base64');
      const steps = await runVisionPipeline(buffer);
      res.json({ steps });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

export function startVisionLabServer(port: number = CONFIG.VISION_LAB_PORT): void {
  const app = createVisionLabApp();
  const server = app.listen(port, CONFIG.HOST, () => {
    console.log(`Vision Lab server running at http://${CONFIG.HOST}:${port}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use — another process may already be bound to it.`);
    } else {
      console.error('Vision Lab server failed to start:', err.message);
    }
    process.exit(1);
  });
}

startVisionLabServer();
```

Note: unlike `src/index.ts` (the composition root dispatching `scan`/`mcp`/web from one entrypoint), this file is always run directly via its own npm script (`tsx src/vision-lab-server.ts`), never imported elsewhere as a library — so it starts the server unconditionally at the bottom, same pattern as how `src/index.ts` unconditionally calls `main()`.

Add to `package.json`'s `"scripts"` block (after `"mcp"`):

```json
    "vision:dev": "tsx src/vision-lab-server.ts",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/vision-lab-server.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vision-lab-server.ts src/vision-lab-server.test.ts package.json
git commit -m "feat(vision-lab): add standalone Vision Lab server on port 3179"
```

---

## Task 7: Vision Lab diagnostic test page

**Files:**
- Create: `public/test-image-to-pdf.html`

**Interfaces:**
- Consumes: `POST /api/vision/diagnose-image` (Task 6) — request `{ imageBase64: string }`, response `{ steps: PipelineStep[] }` or `{ error: string }`.

No automated test for this task (static HTML/JS page, not part of the `public/ts/` build pipeline — same convention as the existing `public/test-render.html`). Verification is the manual checklist in Step 2 below.

- [ ] **Step 1: Write the page**

Create `public/test-image-to-pdf.html`:

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Vision Lab — Image to PDF Diagnostic</title>
<style>
  body { font-family: sans-serif; padding: 2rem; background: #1e293b; color: #f8fafc; max-width: 900px; margin: 0 auto; }
  h1 { margin-bottom: 0.25rem; }
  p.sub { color: #94a3b8; margin-top: 0; }
  input[type="file"] { margin: 1rem 0; }
  button { padding: 0.7rem 1.4rem; font-size: 1rem; cursor: pointer; background: #2563eb; color: white; border: none; border-radius: 6px; }
  button:disabled { background: #475569; cursor: not-allowed; }
  #status { margin: 1rem 0; color: #4ade80; white-space: pre-wrap; font-family: monospace; }
  #status.error { color: #f87171; }
  .step { background: #0f172a; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; }
  .step h2 { margin-top: 0; font-size: 1.1rem; }
  .step img { max-width: 100%; border-radius: 4px; border: 1px solid #334155; }
  .step pre { background: #020617; padding: 0.75rem; border-radius: 4px; overflow-x: auto; font-size: 0.85rem; color: #94a3b8; }
  .step .error { color: #f87171; font-weight: bold; }
</style>
</head>
<body>
<h1>Vision Lab — Image to PDF Diagnostic</h1>
<p class="sub">Upload one phone photo of a document, run the pipeline, inspect every step.</p>

<input type="file" id="fileInput" accept="image/*">
<br>
<button id="runBtn" disabled>Run Pipeline</button>

<div id="status"></div>
<div id="steps"></div>

<script>
const fileInput = document.getElementById('fileInput');
const runBtn = document.getElementById('runBtn');
const statusEl = document.getElementById('status');
const stepsEl = document.getElementById('steps');
let selectedFile = null;

fileInput.addEventListener('change', () => {
  selectedFile = fileInput.files[0] || null;
  runBtn.disabled = !selectedFile;
  statusEl.textContent = '';
  statusEl.classList.remove('error');
  stepsEl.innerHTML = '';
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const commaIdx = result.indexOf(',');
      resolve(result.substring(commaIdx + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderSteps(steps) {
  stepsEl.innerHTML = '';
  for (const step of steps) {
    const div = document.createElement('div');
    div.className = 'step';

    const title = document.createElement('h2');
    title.textContent = `Step ${step.step}: ${step.label}`;
    div.appendChild(title);

    if (step.error) {
      const errEl = document.createElement('div');
      errEl.className = 'error';
      errEl.textContent = `Error: ${step.error}`;
      div.appendChild(errEl);
    }

    if (step.imageBase64) {
      const img = document.createElement('img');
      img.src = `data:image/png;base64,${step.imageBase64}`;
      div.appendChild(img);
    }

    if (step.modelRaw) {
      const pre = document.createElement('pre');
      pre.textContent = `Model response:\n${step.modelRaw}`;
      div.appendChild(pre);
    }

    if (step.meta) {
      const pre = document.createElement('pre');
      pre.textContent = `Meta: ${JSON.stringify(step.meta, null, 2)}`;
      div.appendChild(pre);
    }

    stepsEl.appendChild(div);
  }
}

runBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  runBtn.disabled = true;
  statusEl.classList.remove('error');
  statusEl.textContent = 'Running pipeline...';
  stepsEl.innerHTML = '';

  try {
    const imageBase64 = await fileToBase64(selectedFile);
    const res = await fetch('/api/vision/diagnose-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64 }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    statusEl.textContent = `Done — ${data.steps.length} steps.`;
    renderSteps(data.steps);
  } catch (err) {
    statusEl.classList.add('error');
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    runBtn.disabled = false;
  }
});
</script>
</body>
</html>
```

- [ ] **Step 2: Manually verify (this is this task's test)**

Prerequisite: `ollama pull minicpm-v4.6:latest` (already present per the design spec's investigation — confirm with `ollama list`).

1. Run: `npm run vision:dev`
2. Open `http://localhost:3179/test-image-to-pdf.html` in a browser.
3. Pick a real phone-captured document photo (sideways or upside down, with visible desk/background around it) and click "Run Pipeline".
4. Confirm:
   - Step 0 (original) shows the unmodified photo.
   - Step 1 (oriented) shows it rotated upright, with the model's raw JSON and `rotationDegrees` visible.
   - Step 2 (cropped) shows it cropped to just the document, with the model's raw JSON and `cropBox` visible.
   - Step 3 (enhanced) shows visibly better contrast/brightness than the original, with `brightness`/`contrast`/`sharpness` values visible.
5. Repeat with an already-upright photo and a photo with a heavily cluttered background — note how detection degrades (expected in this diagnostic-only phase; no fallback heuristics were added, per the spec).
6. Confirm the main triage app still runs independently: `npm run dev` in another terminal, verify both `http://localhost:3971` (or configured `PORT`) and `http://localhost:3179` respond at the same time.

- [ ] **Step 3: Commit**

```bash
git add public/test-image-to-pdf.html
git commit -m "feat(vision-lab): add Vision Lab diagnostic test page"
```

---

## Task 8: Full-suite regression check

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all pre-existing tests plus the ~40 new tests from Tasks 1-6.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no type errors, including the new `@napi-rs/canvas` usages in `vision-client.ts` and `image-processor.ts`.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: no errors. (Vision Lab is a separate entrypoint, not part of `src/index.ts`, so this confirms `tsc` compiles it cleanly alongside the rest of `src/`.)

No commit for this task — it's a checkpoint. If anything fails, fix it in the relevant task's files and re-run the commands above before considering the plan complete.
