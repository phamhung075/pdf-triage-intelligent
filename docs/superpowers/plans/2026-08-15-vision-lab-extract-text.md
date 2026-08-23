# Vision Lab Step-by-Step Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Vision Lab's single-batch `runVisionPipeline` with four independently callable step functions (orient/crop/enhance/extract), each returning its chosen result plus every candidate signal that went into steps 1/2/4's decision, and drive them from a "Next" button on the diagnostic page with a per-step compare selector.

**Architecture:** `image-to-pdf.ts` exports `runOrientStep`/`runCropStep`/`runEnhanceStep`/`runExtractStep` instead of one batch function. `pdf-extractor.ts` gains `ocrImageBufferBothEngines` (runs PaddleOCR and Tesseract independently via `Promise.allSettled`, for compare — distinct from the existing fallback-only path production code uses). `vision-lab-server.ts` exposes one stateless endpoint, `POST /api/vision/diagnose-step`, parameterized by step number; the client tracks which buffer to send next. The diagnostic HTML page gets a Next button and radio-button compare selectors.

**Tech Stack:** TypeScript/Node, Vitest, vanilla JS/HTML (no build step for the diagnostic page).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-15-vision-lab-extract-text-design.md` (the current version — it supersedes an earlier version of the same file; read the whole current file, not just a diff).
- Selecting a compare candidate is **purely visual** — it never changes what feeds into the next step. The pipeline's own automatic choice always flows forward, exactly as today.
- Step 3 (`enhanced`) has no `candidates` field at all (omitted, not an empty array) — nothing to compare there.
- Steps 1/2's candidate list only includes non-null signals (e.g., no EXIF candidate when `exifDegrees` is `null`).
- `runExtractStep` always uses PaddleOCR's text for the markdown conversion when it succeeded, falling back to Tesseract's only when PaddleOCR failed — matching production's PaddleOCR-preferred priority — but both raw texts are always returned as candidates regardless of which one "wins."
- A step function itself must never throw for a per-candidate or per-engine failure (e.g., one OCR engine down) — only a genuine step-level failure (the whole step's own try/catch) produces `error` on the `PipelineStepResult`; a single failed candidate/engine surfaces as `error` on that one `StepCandidate` instead.
- `public/test-image-to-pdf.html` has no automated test suite in this repo — its task is verified manually.

---

### Task 1: `ocrImageBufferBothEngines` in `pdf-extractor.ts`

**Files:**
- Modify: `src/infrastructure/pdf-extractor.ts` (add new exported function, after the existing private `ocrPageBuffer` helper, before `ocrPdfPagesWithCanvas`)
- Modify: `src/infrastructure/pdf-extractor.test.ts` (add new tests; reuses the existing `paddleOcrRecognizeMock` mock/beforeEach already in this file)

**Interfaces:**
- Consumes: `paddleOcrRecognize` (already imported in this file), `getSharedTesseractWorker` (already defined in this file).
- Produces: `export async function ocrImageBufferBothEngines(pngBuf: Buffer): Promise<{ paddleOcr: { text: string } | { error: string }; tesseract: { text: string } | { error: string } }>` — Task 2's `runExtractStep` imports and calls this.

- [ ] **Step 1: Write the failing tests**

Add this helper near the top of `src/infrastructure/pdf-extractor.test.ts`, right after the existing `buildImageOnlyPdf` function (it draws the same text-on-white-canvas scene but returns the raw PNG bytes directly, not wrapped in a PDF):

```ts
async function buildTextImagePng(word: string): Promise<Buffer> {
  const canvas = createCanvas(500, 260);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, 500, 260);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 72px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(word, 20, 90);
  return canvas.toBuffer('image/png');
}
```

Add this import to the top of the file, alongside the existing `import { extractPDFContent, safePdfParse, parseWithPdfjs, ocrPdfImages, encodeToBMP } from './pdf-extractor.js';` line (extend that same import list):

```ts
import { extractPDFContent, safePdfParse, parseWithPdfjs, ocrPdfImages, encodeToBMP, ocrImageBufferBothEngines } from './pdf-extractor.js';
```

Add this new `describe` block at the end of the file:

```ts
describe('ocrImageBufferBothEngines', () => {
  it("returns both engines' text when both succeed", async () => {
    paddleOcrRecognizeMock.mockResolvedValue('PADDLE-TEXT');
    const png = await buildTextImagePng('HELLO WORLD');

    const result = await ocrImageBufferBothEngines(png);

    expect(result.paddleOcr).toEqual({ text: 'PADDLE-TEXT' });
    expect('text' in result.tesseract).toBe(true);
    expect((result.tesseract as { text: string }).text.toUpperCase()).toContain('HELLO');
  }, 60_000);

  it("returns an error shape for PaddleOCR without blocking Tesseract's real result", async () => {
    paddleOcrRecognizeMock.mockRejectedValue(new Error('PaddleOCR server is unavailable'));
    const png = await buildTextImagePng('HELLO WORLD');

    const result = await ocrImageBufferBothEngines(png);

    expect(result.paddleOcr).toEqual({ error: 'PaddleOCR server is unavailable' });
    expect('text' in result.tesseract).toBe(true);
    expect((result.tesseract as { text: string }).text.toUpperCase()).toContain('HELLO');
  }, 60_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/infrastructure/pdf-extractor.test.ts -t "ocrImageBufferBothEngines"`
Expected: FAIL — `ocrImageBufferBothEngines` is not exported yet (`SyntaxError`/`undefined is not a function`).

- [ ] **Step 3: Write the minimal implementation**

In `src/infrastructure/pdf-extractor.ts`, add this function right after the existing `ocrPageBuffer` function (before the `// Fallback 2: High-fidelity Canvas Page Rendering...` comment and `ocrPdfPagesWithCanvas`):

```ts
// Runs PaddleOCR and Tesseract independently (via Promise.allSettled) rather than falling back
// from one to the other — used only by the Vision Lab diagnostic pipeline, which needs both
// engines' raw output to let a developer compare them side by side. Production OCR
// (ocrPdfPagesWithCanvas, extractPDFContent's image branch) doesn't use this: it only needs one
// good result, so it uses the fallback pattern above instead of paying for both engines on
// every real document.
export async function ocrImageBufferBothEngines(pngBuf: Buffer): Promise<{
  paddleOcr: { text: string } | { error: string };
  tesseract: { text: string } | { error: string };
}> {
  const [paddleResult, tesseractResult] = await Promise.allSettled([
    paddleOcrRecognize(pngBuf),
    (async () => {
      const worker = await getSharedTesseractWorker();
      const res = await worker.recognize(pngBuf);
      return res?.data?.text || '';
    })(),
  ]);
  const toOutcome = (result: PromiseSettledResult<string>): { text: string } | { error: string } =>
    result.status === 'fulfilled'
      ? { text: result.value }
      : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
  return {
    paddleOcr: toOutcome(paddleResult),
    tesseract: toOutcome(tesseractResult),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/infrastructure/pdf-extractor.test.ts`
Expected: PASS — full file, including the 2 new tests and all pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/pdf-extractor.ts src/infrastructure/pdf-extractor.test.ts
git commit -m "feat(vision-lab): add ocrImageBufferBothEngines for side-by-side OCR comparison"
```

---

### Task 2: Replace `runVisionPipeline` with 4 step functions

**Files:**
- Modify: `src/application/image-to-pdf.ts` (full restructure)
- Modify: `src/application/image-to-pdf.test.ts` (full rewrite)
- Modify: `src/application/image-to-pdf.integration.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `ocrImageBufferBothEngines` (Task 1); `detectOrientationCascade`, `detectCropBoxCascade`, `rotateImage`, `cropImage`, `computeAutoLevelsForImage`, `applyBrightnessContrast`, `applySharpen`, `convertRawTextToZeroLossMarkdown` (all pre-existing, unchanged).
- Produces: `export interface StepCandidate { label: string; chosen: boolean; imageBase64?: string; text?: string; meta?: Record<string, unknown>; error?: string; }`, `export interface PipelineStepResult { step: 1|2|3|4; label: 'oriented'|'cropped'|'enhanced'|'extracted'; durationMs: number; imageBase64: string; markdown?: string; modelRaw?: string; meta?: Record<string, unknown>; error?: string; candidates?: StepCandidate[]; }`, `export async function runOrientStep(imageBuffer: Buffer): Promise<PipelineStepResult>`, `export async function runCropStep(orientedBuffer: Buffer): Promise<PipelineStepResult>`, `export async function runEnhanceStep(croppedBuffer: Buffer): Promise<PipelineStepResult>`, `export async function runExtractStep(enhancedBuffer: Buffer): Promise<PipelineStepResult>` — Task 3's `vision-lab-server.ts` imports and calls all four.

- [ ] **Step 1: Write the failing tests — replace `image-to-pdf.test.ts` entirely**

Replace the full contents of `src/application/image-to-pdf.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { detectOrientationCascadeMock } = vi.hoisted(() => ({ detectOrientationCascadeMock: vi.fn() }));
vi.mock('../infrastructure/orientation-detector.js', () => ({
  detectOrientationCascade: detectOrientationCascadeMock,
}));

const { detectCropBoxCascadeMock } = vi.hoisted(() => ({ detectCropBoxCascadeMock: vi.fn() }));
vi.mock('../infrastructure/crop-detector.js', () => ({
  detectCropBoxCascade: detectCropBoxCascadeMock,
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

const { ocrImageBufferBothEnginesMock } = vi.hoisted(() => ({ ocrImageBufferBothEnginesMock: vi.fn() }));
vi.mock('../infrastructure/pdf-extractor.js', () => ({
  ocrImageBufferBothEngines: ocrImageBufferBothEnginesMock,
}));

const { convertRawTextToZeroLossMarkdownMock } = vi.hoisted(() => ({ convertRawTextToZeroLossMarkdownMock: vi.fn() }));
vi.mock('./classify-document.js', () => ({
  convertRawTextToZeroLossMarkdown: convertRawTextToZeroLossMarkdownMock,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

const originalBuf = Buffer.from('original');
const orientedBuf = Buffer.from('oriented');
const croppedBuf = Buffer.from('cropped');
const leveledBuf = Buffer.from('leveled');
const finalBuf = Buffer.from('final');

describe('runOrientStep', () => {
  it('rotates by the cascade-chosen degrees and includes every non-null candidate', async () => {
    detectOrientationCascadeMock.mockResolvedValue({
      rotationDegrees: 90,
      exifDegrees: 90,
      modelDegrees: 0,
      modelRaw: '{"rotationDegrees":0}',
      ocrDegrees: 90,
      ocrConfidence: 5.2,
      source: 'ocr-tiebreaker',
    });
    rotateImageMock.mockImplementation(async (_buf, degrees) =>
      degrees === 90 ? orientedBuf : Buffer.from(`rotated-${degrees}`)
    );

    const { runOrientStep } = await import('./image-to-pdf.js');
    const result = await runOrientStep(originalBuf);

    expect(result.step).toBe(1);
    expect(result.label).toBe('oriented');
    expect(result.imageBase64).toBe(orientedBuf.toString('base64'));
    expect(result.modelRaw).toBe('{"rotationDegrees":0}');
    expect(result.meta).toEqual({ rotationDegrees: 90, exifDegrees: 90, modelDegrees: 0, ocrDegrees: 90, ocrConfidence: 5.2, source: 'ocr-tiebreaker' });

    expect(result.candidates).toHaveLength(3);
    const exif = result.candidates.find(c => c.label === 'exif');
    const model = result.candidates.find(c => c.label === 'model');
    const ocr = result.candidates.find(c => c.label === 'ocr');
    expect(exif).toEqual({ label: 'exif', chosen: true, imageBase64: orientedBuf.toString('base64'), meta: { rotationDegrees: 90 } });
    expect(ocr).toEqual({ label: 'ocr', chosen: true, imageBase64: orientedBuf.toString('base64'), meta: { rotationDegrees: 90 } });
    expect(model).toEqual({ label: 'model', chosen: false, imageBase64: Buffer.from('rotated-0').toString('base64'), meta: { rotationDegrees: 0 } });
  });

  it('omits the EXIF and OCR candidates when their degrees are null', async () => {
    detectOrientationCascadeMock.mockResolvedValue({
      rotationDegrees: 0,
      exifDegrees: null,
      modelDegrees: 0,
      modelRaw: '{"rotationDegrees":0}',
      ocrDegrees: null,
      ocrConfidence: null,
      source: 'exif+model-agree',
    });
    rotateImageMock.mockResolvedValue(orientedBuf);

    const { runOrientStep } = await import('./image-to-pdf.js');
    const result = await runOrientStep(originalBuf);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual({ label: 'model', chosen: true, imageBase64: orientedBuf.toString('base64'), meta: { rotationDegrees: 0 } });
  });

  it('records an error and no candidates when orientation detection fails', async () => {
    detectOrientationCascadeMock.mockRejectedValue(new Error('vision model unreachable'));
    const { runOrientStep } = await import('./image-to-pdf.js');
    const result = await runOrientStep(originalBuf);

    expect(result.step).toBe(1);
    expect(result.error).toBe('vision model unreachable');
    expect(result.candidates).toBeUndefined();
    expect(typeof result.durationMs).toBe('number');
  });
});

describe('runCropStep', () => {
  it('crops by the cascade-chosen box and includes every non-null candidate', async () => {
    detectCropBoxCascadeMock.mockResolvedValue({
      cropBox: { x: 1, y: 2, width: 3, height: 4 },
      modelCropBox: { x: 1, y: 2, width: 3, height: 4 },
      modelRaw: '{"cropBox":{}}',
      floodCropBox: { x: 9, y: 9, width: 9, height: 9 },
      source: 'model-flood-agree',
    });
    cropImageMock.mockImplementation(async (_buf, box) =>
      box.x === 1 ? croppedBuf : Buffer.from(`cropped-${box.x}`)
    );

    const { runCropStep } = await import('./image-to-pdf.js');
    const result = await runCropStep(orientedBuf);

    expect(result.step).toBe(2);
    expect(result.imageBase64).toBe(croppedBuf.toString('base64'));
    expect(result.candidates).toHaveLength(2);
    const model = result.candidates.find(c => c.label === 'model');
    const flood = result.candidates.find(c => c.label === 'flood');
    expect(model).toEqual({ label: 'model', chosen: true, imageBase64: croppedBuf.toString('base64'), meta: { box: { x: 1, y: 2, width: 3, height: 4 } } });
    expect(flood).toEqual({ label: 'flood', chosen: false, imageBase64: Buffer.from('cropped-9').toString('base64'), meta: { box: { x: 9, y: 9, width: 9, height: 9 } } });
  });

  it('uses the oriented image as-is and has no candidates when both boxes are null', async () => {
    detectCropBoxCascadeMock.mockResolvedValue({
      cropBox: null,
      modelCropBox: null,
      modelRaw: '{"cropBox":null}',
      floodCropBox: null,
      source: 'none',
    });
    const { runCropStep } = await import('./image-to-pdf.js');
    const result = await runCropStep(orientedBuf);

    expect(cropImageMock).not.toHaveBeenCalled();
    expect(result.imageBase64).toBe(orientedBuf.toString('base64'));
    expect(result.candidates).toEqual([]);
  });

  it('records an error when crop detection fails', async () => {
    detectCropBoxCascadeMock.mockRejectedValue(new Error('malformed JSON from model'));
    const { runCropStep } = await import('./image-to-pdf.js');
    const result = await runCropStep(orientedBuf);

    expect(result.error).toBe('malformed JSON from model');
  });
});

describe('runEnhanceStep', () => {
  it('applies auto-levels and sharpen, with no candidates field', async () => {
    computeAutoLevelsForImageMock.mockResolvedValue({ brightness: 5, contrast: 6 });
    applyBrightnessContrastMock.mockResolvedValue(leveledBuf);
    applySharpenMock.mockResolvedValue(finalBuf);

    const { runEnhanceStep } = await import('./image-to-pdf.js');
    const result = await runEnhanceStep(croppedBuf);

    expect(result.step).toBe(3);
    expect(result.imageBase64).toBe(finalBuf.toString('base64'));
    expect(result.meta).toEqual({ brightness: 5, contrast: 6, sharpness: 25 });
    expect(result.candidates).toBeUndefined();
    expect(applyBrightnessContrastMock).toHaveBeenCalledWith(croppedBuf, { brightness: 5, contrast: 6 });
    expect(applySharpenMock).toHaveBeenCalledWith(leveledBuf, 25);
  });

  it('records an error when enhancement fails', async () => {
    computeAutoLevelsForImageMock.mockResolvedValue({ brightness: 0, contrast: 0 });
    applyBrightnessContrastMock.mockResolvedValue(leveledBuf);
    applySharpenMock.mockRejectedValue(new Error('canvas encode failed'));

    const { runEnhanceStep } = await import('./image-to-pdf.js');
    const result = await runEnhanceStep(croppedBuf);

    expect(result.error).toBe('canvas encode failed');
  });
});

describe('runExtractStep', () => {
  it('prefers PaddleOCR text and returns all 3 candidates with markdown chosen by default', async () => {
    ocrImageBufferBothEnginesMock.mockResolvedValue({
      paddleOcr: { text: 'paddle raw text' },
      tesseract: { text: 'tesseract raw text' },
    });
    convertRawTextToZeroLossMarkdownMock.mockResolvedValue('# Extracted\n\npaddle raw text');

    const { runExtractStep } = await import('./image-to-pdf.js');
    const result = await runExtractStep(finalBuf);

    expect(result.step).toBe(4);
    expect(result.label).toBe('extracted');
    expect(result.imageBase64).toBe('');
    expect(result.markdown).toBe('# Extracted\n\npaddle raw text');
    expect(result.meta).toEqual({ rawTextLength: 'paddle raw text'.length });
    expect(convertRawTextToZeroLossMarkdownMock).toHaveBeenCalledWith('paddle raw text', 'vision-lab-diagnostic');

    expect(result.candidates).toEqual([
      { label: 'markdown', chosen: true, text: '# Extracted\n\npaddle raw text' },
      { label: 'paddleocr', chosen: false, text: 'paddle raw text', error: undefined },
      { label: 'tesseract', chosen: false, text: 'tesseract raw text', error: undefined },
    ]);
  });

  it('falls back to Tesseract text for markdown when PaddleOCR failed, and surfaces its error as a candidate', async () => {
    ocrImageBufferBothEnginesMock.mockResolvedValue({
      paddleOcr: { error: 'PaddleOCR server is unavailable' },
      tesseract: { text: 'tesseract raw text' },
    });
    convertRawTextToZeroLossMarkdownMock.mockResolvedValue('# Extracted\n\ntesseract raw text');

    const { runExtractStep } = await import('./image-to-pdf.js');
    const result = await runExtractStep(finalBuf);

    expect(convertRawTextToZeroLossMarkdownMock).toHaveBeenCalledWith('tesseract raw text', 'vision-lab-diagnostic');
    expect(result.candidates).toEqual([
      { label: 'markdown', chosen: true, text: '# Extracted\n\ntesseract raw text' },
      { label: 'paddleocr', chosen: false, text: undefined, error: 'PaddleOCR server is unavailable' },
      { label: 'tesseract', chosen: false, text: 'tesseract raw text', error: undefined },
    ]);
  });

  it('records no step-level error when both engines fail — the failures surface on the candidates instead', async () => {
    ocrImageBufferBothEnginesMock.mockResolvedValue({
      paddleOcr: { error: 'PaddleOCR server is unavailable' },
      tesseract: { error: 'Tesseract worker crashed' },
    });
    convertRawTextToZeroLossMarkdownMock.mockResolvedValue('');

    const { runExtractStep } = await import('./image-to-pdf.js');
    const result = await runExtractStep(finalBuf);

    expect(result.error).toBeUndefined();
    expect(result.meta).toEqual({ rawTextLength: 0 });
    expect(result.candidates?.find(c => c.label === 'paddleocr')?.error).toBe('PaddleOCR server is unavailable');
    expect(result.candidates?.find(c => c.label === 'tesseract')?.error).toBe('Tesseract worker crashed');
  });

  it('records a step-level error when the markdown conversion itself throws', async () => {
    ocrImageBufferBothEnginesMock.mockResolvedValue({
      paddleOcr: { text: 'paddle raw text' },
      tesseract: { text: 'tesseract raw text' },
    });
    convertRawTextToZeroLossMarkdownMock.mockRejectedValue(new Error('ollama unreachable'));

    const { runExtractStep } = await import('./image-to-pdf.js');
    const result = await runExtractStep(finalBuf);

    expect(result.error).toBe('ollama unreachable');
    expect(result.candidates).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/application/image-to-pdf.test.ts`
Expected: FAIL — `runOrientStep`/`runCropStep`/`runEnhanceStep`/`runExtractStep` are not exported yet from `./image-to-pdf.js`.

- [ ] **Step 3: Replace `image-to-pdf.ts` entirely**

Replace the full contents of `src/application/image-to-pdf.ts` with:

```ts
import { detectOrientationCascade } from '../infrastructure/orientation-detector.js';
import { detectCropBoxCascade } from '../infrastructure/crop-detector.js';
import { rotateImage, cropImage, computeAutoLevelsForImage, applyBrightnessContrast, applySharpen } from '../infrastructure/image-processor.js';
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
export async function runOrientStep(imageBuffer: Buffer): Promise<PipelineStepResult> {
  const start = Date.now();
  try {
    const { rotationDegrees, exifDegrees, modelDegrees, modelRaw, ocrDegrees, ocrConfidence, source } = await detectOrientationCascade(imageBuffer);
    const orientedBuffer = await rotateImage(imageBuffer, rotationDegrees);

    const candidateDegrees: Array<{ label: string; degrees: 0 | 90 | 180 | 270 }> = [];
    if (exifDegrees !== null) candidateDegrees.push({ label: 'exif', degrees: exifDegrees });
    candidateDegrees.push({ label: 'model', degrees: modelDegrees });
    if (ocrDegrees !== null) candidateDegrees.push({ label: 'ocr', degrees: ocrDegrees });

    const candidates: StepCandidate[] = [];
    for (const { label, degrees } of candidateDegrees) {
      const buf = degrees === rotationDegrees ? orientedBuffer : await rotateImage(imageBuffer, degrees);
      candidates.push({ label, chosen: degrees === rotationDegrees, imageBase64: buf.toString('base64'), meta: { rotationDegrees: degrees } });
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
      const buf = isChosen ? croppedBuffer : await cropImage(orientedBuffer, box);
      candidates.push({ label, chosen: isChosen, imageBase64: buf.toString('base64'), meta: { box } });
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/application/image-to-pdf.test.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Replace `image-to-pdf.integration.test.ts` entirely**

Replace the full contents of `src/application/image-to-pdf.integration.test.ts` with:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// Unlike image-to-pdf.test.ts (which mocks every neighbor), this file mocks ONLY the things
// that themselves wrap real Ollama/PaddleOCR/Tesseract calls (the two cascades, the both-engines
// OCR function, and the markdown conversion) and lets the REAL image-processor.ts run against a
// real synthetic PNG, to prove the step functions actually compose with real canvas operations
// (rotate/crop/enhance), not just with mocks that happen to satisfy the interface.
const { detectOrientationCascadeMock } = vi.hoisted(() => ({ detectOrientationCascadeMock: vi.fn() }));
vi.mock('../infrastructure/orientation-detector.js', () => ({ detectOrientationCascade: detectOrientationCascadeMock }));

const { detectCropBoxCascadeMock } = vi.hoisted(() => ({ detectCropBoxCascadeMock: vi.fn() }));
vi.mock('../infrastructure/crop-detector.js', () => ({ detectCropBoxCascade: detectCropBoxCascadeMock }));

const { ocrImageBufferBothEnginesMock } = vi.hoisted(() => ({ ocrImageBufferBothEnginesMock: vi.fn() }));
vi.mock('../infrastructure/pdf-extractor.js', () => ({ ocrImageBufferBothEngines: ocrImageBufferBothEnginesMock }));

const { convertRawTextToZeroLossMarkdownMock } = vi.hoisted(() => ({ convertRawTextToZeroLossMarkdownMock: vi.fn() }));
vi.mock('./classify-document.js', () => ({ convertRawTextToZeroLossMarkdown: convertRawTextToZeroLossMarkdownMock }));

async function makeTestPng(w: number, h: number): Promise<Buffer> {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(200,200,200)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgb(20,20,20)';
  ctx.fillRect(0, 0, Math.max(1, Math.floor(w / 4)), Math.max(1, Math.floor(h / 4)));
  return canvas.toBuffer('image/png');
}

describe('vision-lab step functions (real image-processor)', () => {
  it('compose with real rotate/crop/enhance operations end-to-end and produce decodable images at every step', async () => {
    detectOrientationCascadeMock.mockResolvedValue({
      rotationDegrees: 90,
      exifDegrees: null,
      modelDegrees: 90,
      modelRaw: '{"rotationDegrees":90}',
      ocrDegrees: null,
      ocrConfidence: null,
      source: 'exif+model-agree',
    });
    detectCropBoxCascadeMock.mockResolvedValue({
      cropBox: { x: 5, y: 5, width: 50, height: 40 },
      modelCropBox: { x: 5, y: 5, width: 50, height: 40 },
      modelRaw: '{"cropBox":{"x":5,"y":5,"width":50,"height":40}}',
      floodCropBox: null,
      source: 'model-flood-agree',
    });
    ocrImageBufferBothEnginesMock.mockResolvedValue({
      paddleOcr: { text: 'mock extracted text' },
      tesseract: { text: 'mock extracted text' },
    });
    convertRawTextToZeroLossMarkdownMock.mockResolvedValue('# Mock Markdown');

    const buf = await makeTestPng(100, 80);
    const { runOrientStep, runCropStep, runEnhanceStep, runExtractStep } = await import('./image-to-pdf.js');

    const orientResult = await runOrientStep(buf);
    expect(orientResult.error).toBeUndefined();
    const orientedImg = await loadImage(Buffer.from(orientResult.imageBase64, 'base64'));
    expect(orientedImg.width).toBe(80);
    expect(orientedImg.height).toBe(100);

    const cropResult = await runCropStep(Buffer.from(orientResult.imageBase64, 'base64'));
    expect(cropResult.error).toBeUndefined();
    const croppedImg = await loadImage(Buffer.from(cropResult.imageBase64, 'base64'));
    expect(croppedImg.width).toBe(50);
    expect(croppedImg.height).toBe(40);

    const enhanceResult = await runEnhanceStep(Buffer.from(cropResult.imageBase64, 'base64'));
    expect(enhanceResult.error).toBeUndefined();
    expect(enhanceResult.imageBase64.length).toBeGreaterThan(0);
    const enhancedImg = await loadImage(Buffer.from(enhanceResult.imageBase64, 'base64'));
    expect(enhancedImg.width).toBeGreaterThan(0);
    expect(enhancedImg.height).toBeGreaterThan(0);

    const extractResult = await runExtractStep(Buffer.from(enhanceResult.imageBase64, 'base64'));
    expect(extractResult.error).toBeUndefined();
    expect(extractResult.markdown).toBe('# Mock Markdown');
  });
});
```

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `npx vitest run src/application/image-to-pdf.integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full test suite and typecheck**

Run: `npm test`
Expected: PASS, except `src/vision-lab-server.test.ts` and `src/vision-lab-server.ts` — those still reference the now-removed `runVisionPipeline` and will fail/not compile until Task 3 updates them. This is expected at this point in the plan; Task 3 fixes it.

Run: `npm run typecheck`
Expected: the 3 pre-existing unrelated errors, PLUS new errors from `src/vision-lab-server.ts` (still importing the removed `runVisionPipeline`) — also expected until Task 3.

- [ ] **Step 8: Commit**

```bash
git add src/application/image-to-pdf.ts src/application/image-to-pdf.test.ts src/application/image-to-pdf.integration.test.ts
git commit -m "feat(vision-lab): replace runVisionPipeline with 4 independently callable step functions"
```

---

### Task 3: `POST /api/vision/diagnose-step` endpoint

**Files:**
- Modify: `src/vision-lab-server.ts` (replace the single batch endpoint)
- Modify: `src/vision-lab-server.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `runOrientStep`, `runCropStep`, `runEnhanceStep`, `runExtractStep` from `./application/image-to-pdf.js` (Task 2).
- Produces: `POST /api/vision/diagnose-step` accepting `{ step: 1|2|3|4, inputImageBase64: string }`, responding `{ result: PipelineStepResult }` or `{ error: string }` — Task 4's HTML page calls this.

- [ ] **Step 1: Write the failing tests — replace `vision-lab-server.test.ts` entirely**

Replace the full contents of `src/vision-lab-server.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';

vi.mock('fs');

const { runOrientStepMock, runCropStepMock, runEnhanceStepMock, runExtractStepMock } = vi.hoisted(() => ({
  runOrientStepMock: vi.fn(),
  runCropStepMock: vi.fn(),
  runEnhanceStepMock: vi.fn(),
  runExtractStepMock: vi.fn(),
}));
vi.mock('./application/image-to-pdf.js', () => ({
  runOrientStep: runOrientStepMock,
  runCropStep: runCropStepMock,
  runEnhanceStep: runEnhanceStepMock,
  runExtractStep: runExtractStepMock,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

describe('POST /api/vision/diagnose-step', () => {
  it('returns 400 when step is missing', async () => {
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ inputImageBase64: 'ZmFrZQ==' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when step is not 1, 2, 3, or 4', async () => {
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 5, inputImageBase64: 'ZmFrZQ==' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when inputImageBase64 is missing', async () => {
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 1 });
    expect(res.status).toBe(400);
    expect(runOrientStepMock).not.toHaveBeenCalled();
  });

  it('routes step 1 to runOrientStep and returns its result', async () => {
    const fakeResult = { step: 1, label: 'oriented', imageBase64: 'abc', durationMs: 5 };
    runOrientStepMock.mockResolvedValue(fakeResult);
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 1, inputImageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: fakeResult });
    expect(runOrientStepMock).toHaveBeenCalledWith(Buffer.from('ZmFrZQ==', 'base64'));
  });

  it('routes step 2 to runCropStep', async () => {
    const fakeResult = { step: 2, label: 'cropped', imageBase64: 'abc', durationMs: 5 };
    runCropStepMock.mockResolvedValue(fakeResult);
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 2, inputImageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(200);
    expect(runCropStepMock).toHaveBeenCalledWith(Buffer.from('ZmFrZQ==', 'base64'));
    expect(runOrientStepMock).not.toHaveBeenCalled();
  });

  it('routes step 3 to runEnhanceStep', async () => {
    const fakeResult = { step: 3, label: 'enhanced', imageBase64: 'abc', durationMs: 5 };
    runEnhanceStepMock.mockResolvedValue(fakeResult);
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 3, inputImageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(200);
    expect(runEnhanceStepMock).toHaveBeenCalledWith(Buffer.from('ZmFrZQ==', 'base64'));
  });

  it('routes step 4 to runExtractStep', async () => {
    const fakeResult = { step: 4, label: 'extracted', imageBase64: '', durationMs: 5, markdown: '# Hi' };
    runExtractStepMock.mockResolvedValue(fakeResult);
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 4, inputImageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: fakeResult });
    expect(runExtractStepMock).toHaveBeenCalledWith(Buffer.from('ZmFrZQ==', 'base64'));
  });

  it('returns 500 with the error message when a step function throws', async () => {
    runOrientStepMock.mockRejectedValue(new Error('unexpected crash'));
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 1, inputImageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('unexpected crash');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/vision-lab-server.test.ts`
Expected: FAIL — the app still only has `POST /api/vision/diagnose-image` (404s on the new path), and the mock for `./application/image-to-pdf.js` no longer matches what `vision-lab-server.ts` actually imports.

- [ ] **Step 3: Replace the endpoint in `vision-lab-server.ts`**

Replace the full contents of `src/vision-lab-server.ts` with:

```ts
import express from 'express';
import path from 'path';
import fs from 'fs';
import { CONFIG, BASE_DIR } from './infrastructure/settings.js';
import { runOrientStep, runCropStep, runEnhanceStep, runExtractStep } from './application/image-to-pdf.js';
import { logger } from './infrastructure/logger.js';

const STEP_FUNCTIONS = {
  1: runOrientStep,
  2: runCropStep,
  3: runEnhanceStep,
  4: runExtractStep,
} as const;

export function createVisionLabApp(): express.Express {
  const app = express();

  // Phone photos as base64 run several MB — well past Express's 100kb JSON default.
  app.use(express.json({ limit: '25mb' }));

  const publicDir = path.join(BASE_DIR, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, {
      // This serves the ENTIRE public/ directory (shared with the main triage app). Without
      // index: false, Express's default index:'index.html' behavior would render the main
      // app's dashboard at this server's root — an unrelated page whose API calls all 404
      // here. The diagnostic page stays reachable at its explicit path, /test-image-to-pdf.html.
      index: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    }));
  }

  // One stateless endpoint per pipeline step, parameterized by `step` — the client tracks
  // which buffer to send as inputImageBase64 on each call (the original upload for step 1,
  // the previous step's chosen output for steps 2-4). No server-side session state.
  app.post('/api/vision/diagnose-step', async (req, res) => {
    const { step, inputImageBase64 } = req.body || {};
    if (![1, 2, 3, 4].includes(step)) {
      logger.warn('VISION_LAB', 'Rejected diagnose-step request: step must be 1, 2, 3, or 4', { step });
      res.status(400).json({ error: 'step must be 1, 2, 3, or 4' });
      return;
    }
    if (!inputImageBase64 || typeof inputImageBase64 !== 'string') {
      logger.warn('VISION_LAB', 'Rejected diagnose-step request: inputImageBase64 missing or not a string');
      res.status(400).json({ error: 'inputImageBase64 (string) is required' });
      return;
    }
    try {
      const buffer = Buffer.from(inputImageBase64, 'base64');
      const stepFn = STEP_FUNCTIONS[step as 1 | 2 | 3 | 4];
      const result = await stepFn(buffer);
      res.json({ result });
    } catch (err: any) {
      logger.error('VISION_LAB', 'diagnose-step request failed', { step, error: err.message });
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/vision-lab-server.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test`
Expected: PASS — full suite, no failures anywhere.

Run: `npm run typecheck`
Expected: only the 3 pre-existing unrelated errors remain (in `src/domain/classification-resolution.test.ts` and `src/infrastructure/http/web-server.test.ts`), no new ones.

- [ ] **Step 6: Commit**

```bash
git add src/vision-lab-server.ts src/vision-lab-server.test.ts
git commit -m "feat(vision-lab): replace batch diagnose-image endpoint with per-step diagnose-step endpoint"
```

---

### Task 4: Next button + compare selectors on the diagnostic page

**Files:**
- Modify: `public/test-image-to-pdf.html` (full rewrite)

**Interfaces:**
- Consumes: `POST /api/vision/diagnose-step` (Task 3), `PipelineStepResult`/`StepCandidate` JSON shape (Task 2).
- Produces: nothing consumed by other tasks (last task).

This page has no automated test suite in this repo — verify manually per Step 3 below, not via `npm test`.

- [ ] **Step 1: Replace the file entirely**

Replace the full contents of `public/test-image-to-pdf.html` with:

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
  .step .markdown-preview { background: #1e293b; padding: 1rem; border-radius: 4px; line-height: 1.6; }
  .step .markdown-preview :first-child { margin-top: 0; }
  .step .markdown-preview :last-child { margin-bottom: 0; }
  .step .candidates { margin: 0.75rem 0; display: flex; gap: 1rem; flex-wrap: wrap; }
  .step .candidates label { font-size: 0.9rem; cursor: pointer; }
  .step .candidate-error { color: #f87171; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>Vision Lab — Image to PDF Diagnostic</h1>
<p class="sub">Upload one phone photo of a document, step through the pipeline, inspect every step and compare candidates.</p>

<input type="file" id="fileInput" accept="image/*">
<br>
<button id="nextBtn" disabled>Next</button>

<div id="status"></div>
<div id="steps"></div>

<script src="js/vendor/marked.js"></script>
<script>
const fileInput = document.getElementById('fileInput');
const nextBtn = document.getElementById('nextBtn');
const statusEl = document.getElementById('status');
const stepsEl = document.getElementById('steps');

let currentStep = 0;         // last step number successfully run (0 = not started)
let inputForNextStep = null; // base64 to send as inputImageBase64 on the next click

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  statusEl.textContent = '';
  statusEl.classList.remove('error');
  stepsEl.innerHTML = '';
  currentStep = 0;
  inputForNextStep = null;
  nextBtn.disabled = true;
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const result = reader.result;
    const commaIdx = result.indexOf(',');
    const base64 = result.substring(commaIdx + 1);
    inputForNextStep = base64;
    renderOriginalStep(base64);
    nextBtn.disabled = false;
  };
  reader.readAsDataURL(file);
});

function renderOriginalStep(base64) {
  const div = document.createElement('div');
  div.className = 'step';
  const title = document.createElement('h2');
  title.textContent = 'Step 0: original';
  div.appendChild(title);
  const img = document.createElement('img');
  img.src = `data:image/png;base64,${base64}`;
  div.appendChild(img);
  stepsEl.appendChild(div);
}

function renderCandidateInto(container, candidate) {
  container.innerHTML = '';
  if (candidate.error) {
    const errEl = document.createElement('div');
    errEl.className = 'candidate-error';
    errEl.textContent = `Error: ${candidate.error}`;
    container.appendChild(errEl);
    return;
  }
  if (typeof candidate.imageBase64 === 'string') {
    const img = document.createElement('img');
    img.src = `data:image/png;base64,${candidate.imageBase64}`;
    container.appendChild(img);
    return;
  }
  if (typeof candidate.text === 'string') {
    if (candidate.label === 'markdown') {
      const mdDiv = document.createElement('div');
      mdDiv.className = 'markdown-preview';
      mdDiv.innerHTML = window.marked.parse(candidate.text);
      container.appendChild(mdDiv);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = candidate.text;
      container.appendChild(pre);
    }
  }
}

function renderStepResult(result) {
  const div = document.createElement('div');
  div.className = 'step';

  const title = document.createElement('h2');
  const durationText = typeof result.durationMs === 'number' ? ` — ${result.durationMs}ms` : '';
  title.textContent = `Step ${result.step}: ${result.label}${durationText}`;
  div.appendChild(title);

  if (result.error) {
    const errEl = document.createElement('div');
    errEl.className = 'error';
    errEl.textContent = `Error: ${result.error}`;
    div.appendChild(errEl);
    stepsEl.appendChild(div);
    return;
  }

  const contentContainer = document.createElement('div');

  if (result.candidates && result.candidates.length > 0) {
    const candidatesEl = document.createElement('div');
    candidatesEl.className = 'candidates';
    const groupName = `candidates-step-${result.step}`;
    let defaultCandidate = null;
    result.candidates.forEach((candidate) => {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = groupName;
      radio.checked = candidate.chosen;
      radio.addEventListener('change', () => renderCandidateInto(contentContainer, candidate));
      label.appendChild(radio);
      label.append(` ${candidate.label}${candidate.chosen ? ' (chosen)' : ''}`);
      candidatesEl.appendChild(label);
      if (candidate.chosen) defaultCandidate = candidate;
    });
    div.appendChild(candidatesEl);
    div.appendChild(contentContainer);
    if (defaultCandidate) renderCandidateInto(contentContainer, defaultCandidate);
  } else {
    div.appendChild(contentContainer);
    if (result.imageBase64) {
      const img = document.createElement('img');
      img.src = `data:image/png;base64,${result.imageBase64}`;
      contentContainer.appendChild(img);
    } else if (result.markdown) {
      const mdDiv = document.createElement('div');
      mdDiv.className = 'markdown-preview';
      mdDiv.innerHTML = window.marked.parse(result.markdown);
      contentContainer.appendChild(mdDiv);
    }
  }

  if (result.modelRaw) {
    const pre = document.createElement('pre');
    pre.textContent = `Model response:\n${result.modelRaw}`;
    div.appendChild(pre);
  }

  if (result.meta) {
    const pre = document.createElement('pre');
    pre.textContent = `Meta: ${JSON.stringify(result.meta, null, 2)}`;
    div.appendChild(pre);
  }

  stepsEl.appendChild(div);
}

nextBtn.addEventListener('click', async () => {
  if (currentStep >= 4 || inputForNextStep === null) return;
  const stepToRun = currentStep + 1;
  nextBtn.disabled = true;
  statusEl.classList.remove('error');
  statusEl.textContent = `Running step ${stepToRun}...`;

  try {
    const res = await fetch('/api/vision/diagnose-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: stepToRun, inputImageBase64: inputForNextStep }),
    });
    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    renderStepResult(data.result);
    currentStep = stepToRun;

    if (data.result.error) {
      statusEl.textContent = `Step ${stepToRun} failed — see panel above.`;
      nextBtn.disabled = true;
      return;
    }

    if (typeof data.result.imageBase64 === 'string' && data.result.imageBase64) {
      inputForNextStep = data.result.imageBase64;
    }

    statusEl.textContent = currentStep < 4 ? `Step ${stepToRun} done.` : 'Pipeline complete.';
    nextBtn.disabled = currentStep >= 4;
  } catch (err) {
    statusEl.classList.add('error');
    statusEl.textContent = `Error: ${err.message}`;
    nextBtn.disabled = false;
  }
});
</script>
</body>
</html>
```

- [ ] **Step 2: Run the full test suite one final time**

Run: `npm test`
Expected: PASS — full suite (this file has no automated coverage of its own, but confirms nothing else regressed).

- [ ] **Step 3: Manually verify**

Report to the user that this needs a manual check: run `npm run vision:dev` (the user runs this, not you), open `http://127.0.0.1:3179/test-image-to-pdf.html`, upload a document photo, and click "Next" four times. Confirm:
- Step 0 (original) appears immediately on file selection, before any click.
- Each click adds exactly one new panel below the previous ones (nothing disappears or gets replaced).
- Steps 1, 2, and 4 show radio buttons; switching them swaps the displayed image/text instantly with no network delay.
- Step 4's default selection is "markdown (chosen)", rendered as styled prose (headings/paragraphs), not a raw JSON/plaintext dump; switching to "paddleocr" or "tesseract" shows their raw text in a `<pre>` block.
- After step 4, the Next button stays disabled (nothing left to run).
- If a step fails (e.g., stop the PaddleOCR service mid-run to force a Tesseract-only or full-failure path), its panel shows the error and the Next button stays disabled.

- [ ] **Step 4: Commit**

```bash
git add public/test-image-to-pdf.html
git commit -m "feat(vision-lab): add Next-button step-by-step navigation with compare selectors"
```
