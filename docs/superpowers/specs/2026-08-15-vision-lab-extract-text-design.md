# Vision Lab — step-by-step pipeline with compare views

Date: 2026-08-15
Owner: none yet — same unowned Vision Lab area as
`2026-08-13-image-to-pdf-vision-lab-design.md`.

> Supersedes the original version of this doc, which scoped a single
> always-batch "extracted" step appended to `runVisionPipeline`. That
> design is replaced entirely by the step-by-step architecture below —
> see "Why the redesign" for what changed and why.

## Problem

The Vision Lab diagnostic pipeline (`runVisionPipeline` in
`src/application/image-to-pdf.ts`) runs all steps in one batch call and
renders every result at once. Two gaps:

1. There's no way to see what text a real triage scan would actually
   extract from the final processed image — the pipeline stops after
   image processing (`original → oriented → cropped → enhanced`).
2. For steps that already compute multiple candidate answers internally
   (orientation: EXIF vs vision-model vs OCR-tiebreaker; crop: vision-model
   box vs flood-fill box), only the cascade's own auto-picked winner is
   ever visible. A developer debugging a bad rotation/crop can't see what
   the *other* signal would have produced, which is exactly the
   information needed to judge whether the cascade's tolerance/threshold
   values are well-tuned.

## Why the redesign

The original scope (append one more batch step, show its markdown) only
addressed the missing extraction step. Mid-review the requirement grew:
step through the pipeline one click at a time, and where a step already
has multiple candidate answers, see them side-by-side to judge quality —
not just the one the cascade picked. That's a different shape of feature
(a resumable, per-step API + compare UI), not an additive one, so this
doc replaces the original rather than layering on top of it.

## Goal (this spec's scope)

Replace the single `runVisionPipeline(imageBuffer)` batch function with
four independently callable step functions, each returning its chosen
result plus (where applicable) every candidate that went into the
decision, rendered as real comparable output — not just numbers:

1. `runOrientStep(imageBuffer)` — candidates: EXIF-rotated, model-rotated,
   OCR-tiebreaker-rotated (only for candidates whose degrees value is
   non-null).
2. `runCropStep(orientedBuffer)` — candidates: model-cropped,
   flood-fill-cropped (only for non-null boxes).
3. `runEnhanceStep(croppedBuffer)` — no candidates (auto-levels + fixed
   sharpen has no alternate signal to compare).
4. `runExtractStep(enhancedBuffer)` — runs PaddleOCR and Tesseract
   **independently** (not fallback-only, so both are always available to
   compare even when one fails), plus one AI-markdown conversion built
   from whichever engine's raw text would normally be chosen (PaddleOCR
   preferred, same priority as production). Three candidates: PaddleOCR
   raw text, Tesseract raw text, AI markdown (markdown is the default
   selected view).

The diagnostic page (`public/test-image-to-pdf.html`) gets a "Next"
button: each click calls one step's endpoint, appends a new panel
(previous panels stay visible — nothing is hidden or replaced), and for
steps 1/2/4 shows a radio-button selector that swaps which candidate's
image/text is displayed in that panel. **Selecting a candidate is purely
visual** — it never changes what feeds into the next step; the pipeline
always uses its own automatic choice downstream, exactly as today. This
keeps the tool a diagnostic, not an editor.

Explicitly **out of scope**:

- Any override mechanism where a selected candidate becomes the actual
  input to the next step (considered, explicitly rejected — see the
  brainstorming Q&A this spec is based on).
- Full classification (`classifyPDFText`'s Step A/D) — step 4 only needs
  Step C's markdown conversion.
- Writing extracted output anywhere persistent, or wiring any of this into
  the real triage scan.
- A "Back" button — since panels accumulate and are never hidden, all
  prior steps stay visible above/below without needing one.

## Architecture

### Backend: one endpoint per step call, stateless

`src/vision-lab-server.ts` replaces `POST /api/vision/diagnose-image`
(which called the now-removed batch `runVisionPipeline`) with:

```
POST /api/vision/diagnose-step
Body: { step: 1 | 2 | 3 | 4, inputImageBase64: string }
```

`inputImageBase64` is always "whatever this step should operate on": the
original uploaded image for step 1, step 1's *chosen* output for step 2,
step 2's chosen output for step 3, step 3's chosen output for step 4. The
client tracks and forwards the correct buffer on each click. The server
holds no session state between calls — same stateless-request style the
rest of this app already uses. Step 0 ("original") needs no server call
at all; the client already has the uploaded file locally and renders it
immediately on selection.

### Shared response shape

```ts
export interface StepCandidate {
  label: string;       // e.g. 'exif' | 'model' | 'ocr' (step 1); 'model' | 'flood' (step 2); 'markdown' | 'paddleocr' | 'tesseract' (step 4)
  chosen: boolean;      // which candidate is pre-selected/displayed by default
  imageBase64?: string; // step 1/2 candidates
  text?: string;        // step 4 candidates
  meta?: Record<string, unknown>;
  error?: string;       // set when this specific candidate failed (e.g. one OCR engine down) — others still shown
}

export interface PipelineStepResult {
  step: 1 | 2 | 3 | 4;
  label: 'oriented' | 'cropped' | 'enhanced' | 'extracted';
  durationMs: number;
  imageBase64: string;   // the chosen result (empty string for step 4, which has no image output)
  markdown?: string;     // step 4's chosen markdown
  modelRaw?: string;
  meta?: Record<string, unknown>;
  error?: string;        // set when the step itself failed outright (distinct from a single candidate failing)
  candidates?: StepCandidate[]; // present for steps 1, 2, 4; absent for step 3
}
```

### Candidate rendering — cheap, no extra AI calls

Steps 1 and 2's cascades (`detectOrientationCascade`,
`detectCropBoxCascade`) already compute and return every candidate's
*value* (`exifDegrees`/`modelDegrees`/`ocrDegrees`;
`modelCropBox`/`floodCropBox`) as part of their existing result — no new
AI/vision-model calls are needed. The new step functions just also
*render* each non-null candidate deterministically (`rotateImage`/
`cropImage`, already-existing pure functions) so the UI has a real image
to show, not just a number.

### `ocrImageBufferBothEngines` (new)

`src/infrastructure/pdf-extractor.ts` gains a new exported function,
alongside the existing fallback-only OCR path (used unchanged by
`ocrPdfPagesWithCanvas` and `extractPDFContent`'s image branch — neither
of those needs both engines, only step 4 does):

```ts
export async function ocrImageBufferBothEngines(pngBuf: Buffer): Promise<{
  paddleOcr: { text: string } | { error: string };
  tesseract: { text: string } | { error: string };
}>
```

Runs `paddleOcrRecognize(pngBuf)` and the shared Tesseract worker's
`recognize(pngBuf)` via `Promise.allSettled` — one engine failing never
prevents the other's result from being returned. `runExtractStep` derives
its "chosen" text as `paddleOcr.text` if present, else `tesseract.text`,
else `''` (same PaddleOCR-preferred priority as production), and only
that chosen text goes through `convertRawTextToZeroLossMarkdown`.

### Frontend

`public/test-image-to-pdf.html`: file selection renders step 0
immediately (no server call). A "Next" button becomes enabled once a file
is selected; each click POSTs the next step (tracking which `step`
number and `inputImageBase64` to send based on the *previously chosen*
result), appends a new panel, and disables itself after step 4 (nothing
left to run). For steps 1/2/4, each panel's candidates render as radio
buttons; selecting one swaps the panel's displayed image/text via local
DOM update only — no network call, since every candidate's full data
already arrived in that step's one response.

## Testing

- `pdf-extractor.test.ts`: new tests for `ocrImageBufferBothEngines` —
  both engines succeed, one fails, both fail (returns the error shape for
  each, doesn't throw).
- `image-to-pdf.test.ts`: `runVisionPipeline`'s existing tests are
  replaced with per-function tests for `runOrientStep`/`runCropStep`/
  `runEnhanceStep`/`runExtractStep` — success path (chosen result +
  correct candidates), failure path (step's own error field, matching the
  existing steps 1-4 error-handling philosophy), and for steps 1/2, a case
  where a candidate signal is null (e.g. no EXIF) and is correctly omitted
  from `candidates` rather than rendered as a spurious entry.
- `image-to-pdf.integration.test.ts`: updated to call the 4 functions in
  sequence against a real synthetic PNG (still mocking the two cascades,
  same rationale as today — proves real `image-processor.ts` composition,
  not cascade decision logic).
- `vision-lab-server.test.ts`: rewritten for the new
  `/api/vision/diagnose-step` endpoint — routes to the correct step
  function based on `step`, 400 on missing/invalid body, 500 with the
  error message when a step function throws.
- `public/test-image-to-pdf.html` has no automated test suite in this repo
  (confirmed — no test file references it) — verified manually.
