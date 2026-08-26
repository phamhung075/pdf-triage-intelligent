# Image → PDF Vision Lab (orientation + crop detection, auto-enhance)

Date: 2026-08-13
Owner: none yet — new capability, doesn't map to an existing roster agent (see "Ownership" below)

## Problem

Documents captured by phone camera (paper scans of admin letters, receipts,
etc.) arrive as photos, not PDFs: wrong orientation, background/desk visible
around the document edges, flat/dull lighting compared to a real scanner.
There's no way today to turn a batch of these photos into a clean,
upright, cropped, contrast-corrected PDF that's fit to drop into `__raws`
for the existing triage pipeline to classify.

A separate project, `pdf-awesome` (`<workspace>\pdf-awesome`),
already solves the crop/enhance problem client-side in the browser with
manual controls (autocrop/edgecrop/floodcrop pixel-based detection, an
auto-levels brightness/contrast algorithm, a fixed sharpening default,
perspective correction, and CSS-filter presets) but has **no automatic
orientation detection** — rotation is manual — and no AI involved.

## Goal (this spec's scope)

Build a **server-side** pipeline that, given a phone photo of a document:

1. Detects and corrects orientation (rotates to normal reading direction)
   using the local `minicpm-v4.6` vision model via Ollama.
2. Detects the document's crop boundary in the now-upright photo, also via
   `minicpm-v4.6`, and crops to it.
3. Auto-adjusts brightness/contrast (ported from pdf-awesome's auto-levels
   math) and applies a fixed-default sharpen (pdf-awesome couldn't reliably
   auto-measure blur either — same tradeoff carries over).

...and exposes this as a **standalone diagnostic test page** ("Vision Lab")
showing every intermediate image plus each vision-model call's raw JSON
response, so detection failures are visible and debuggable step by step.

Explicitly **out of scope for this spec** (deferred to follow-up specs):

- Wiring a "Convert to PDF" button into the main pdf_triage UI.
- Exposing this pipeline as an MCP tool for external agents.
- Multi-image batching / page reordering / splitting into multiple PDFs.
- Writing the final PDF into `__raws` for auto-triage (the orchestrator is
  built so this is a thin addition later, but this spec's HTTP surface only
  needs to return diagnostic step images, not assemble/write a PDF file).
- "Search by type" on the search page (unrelated feature, separate task).

These deferred items reuse the orchestrator and modules built here; nothing
in this design blocks them.

## Ownership

None of the existing roster agents (`docs/agents/README.md`) own image
processing or vision-model integration. This spec introduces a new
subsystem area; `docs-curator` should be invoked after implementation to
decide whether it becomes its own agent (e.g. `vision-lab-engineer`) or
folds into an existing one. Not resolved in this spec — implementation
proceeds under general engineering, not a named agent.

## Architecture

### Why server-side, not client-side (browser, like pdf-awesome)

pdf-awesome's canvas code (rotate/crop/enhance) is browser-only. Two
options were considered:

- **Client-side**: reuse pdf-awesome's tested browser code almost verbatim
  in the test page; only the two vision-model calls would proxy through a
  backend route to Ollama. Lowest porting risk, but this pipeline is meant
  to eventually run headless as an MCP tool for external agents — no
  browser available there.
- **Server-side (chosen)**: port the canvas-dependent logic to
  `@napi-rs/canvas` (already a dev dependency) so the exact same pipeline
  code serves the test page AND a future MCP tool AND a future "Convert to
  PDF" button, with one implementation instead of two diverging ones.

### New config

`src/infrastructure/settings.ts` gains `CONFIG.OLLAMA_VISION_MODEL`,
pinned to `'minicpm-v4.6:latest'` via the same sanitize-and-lock pattern
`OLLAMA_MODEL` already uses (Golden Rule #14 locks the *classification*
model to `qwen3.5:9b`; this is a separate field for a separate purpose —
vision detection, not classification — so it doesn't reintroduce a legacy
classification model, just pins a second, distinct model).

### New modules

- **`src/domain/image-adjust.ts`** (pure, no I/O — unit-testable directly)
  Ported from pdf-awesome's `js/domain/auto-adjust.js`:
  `findBlackWhitePoints(gray, clipPct)` and
  `autoLevelsFromBlackWhite(black, white)`. Both are already
  framework-agnostic pure functions operating on plain arrays — port as-is,
  no canvas dependency. Also carries `AUTO_ADJUST_SHARPNESS = 25` (the
  fixed default pdf-awesome uses, for the same "can't reliably auto-measure
  blur from one photo" reason documented in its source).

- **`src/infrastructure/vision-client.ts`**
  Two functions, each a separate `ollama.generate()` call (per the
  two-separate-calls decision below) against `CONFIG.OLLAMA_VISION_MODEL`
  with `images: [base64]`, `format: 'json'`, `think: false`:
  - `detectOrientation(imageBuffer): Promise<{ rotationDegrees: 0|90|180|270; raw: string }>`
  - `detectCropBox(imageBuffer): Promise<{ cropBox: {x,y,width,height} | null; raw: string }>`
  Both parse the model's JSON response with the existing
  `cleanAndParseJSON` helper (`src/domain/classification.ts`) — same
  tolerance for markdown-fenced/loosely-formatted JSON the classifier
  already handles.
  Rotation and crop detection are **two separate model calls**, not one
  combined prompt — simpler, more focused prompt per sub-task, at the cost
  of an extra round-trip.

- **`src/infrastructure/image-processor.ts`**
  Canvas-dependent operations ported from pdf-awesome to `@napi-rs/canvas`:
  `rotateImage(buffer, degrees)`, `cropImage(buffer, box)`,
  `applyBrightnessContrast(buffer, { brightness, contrast })`,
  `applySharpen(buffer, amount)`.

- **`src/application/image-to-pdf.ts`**
  Orchestrator, `runVisionPipeline(imageBuffer): Promise<PipelineStep[]>`,
  running steps in order:
  1. `original` — the input image, unchanged.
  2. `oriented` — `vision-client.detectOrientation` → rotation degrees →
     `image-processor.rotateImage`.
  3. `cropped` — `vision-client.detectCropBox` (on the oriented image) →
     `image-processor.cropImage`.
  4. `enhanced` (final) — `image-adjust.computeAutoLevels`-equivalent →
     `image-processor.applyBrightnessContrast` → `image-processor.applySharpen`
     with the fixed default.
  Each `PipelineStep` is `{ step: number; label: string; imageBase64: string; modelRaw?: string; meta?: object }`
  — `modelRaw`/`meta` present only on steps that called the vision model,
  so the test page can show exactly what minicpm returned for that step.

### HTTP surface

- **`POST /api/vision/diagnose-image`** — body `{ imageBase64: string }`,
  runs `runVisionPipeline` and returns the full `PipelineStep[]` array.
  This route needs its own JSON body-size limit (Express defaults to
  100kb; a phone photo as base64 is several MB) — scoped to this route/app
  rather than raising the limit globally.

- **`src/vision-lab-server.ts`** — new, minimal, standalone Express
  entrypoint (separate process from `web-server.ts`/the main triage app):
  serves `public/test-image-to-pdf.html` statically and mounts only the
  one route above. Listens on port **3179** (`process.env.VISION_LAB_PORT`
  overridable, matching the `PORT` env pattern in `settings.ts`).
  Deliberately decoupled from the main app so both can run at once during
  development.

- **New npm script**: `"vision:dev": "tsx src/vision-lab-server.ts"`.

### Test page

**`public/test-image-to-pdf.html`** — same standalone-diagnostic-page
convention as the existing `public/test-render.html`: single file picker
(one image at a time, matching this spec's diagnostic focus — not a batch
uploader), a "Run Pipeline" button, and a vertical list of the four
`PipelineStep` results, each rendered as `<img src="data:image/...;base64,...">`
with a caption showing the step label, timing, and (where present) the raw
model JSON response — so a bad rotation or a wildly wrong crop box is
immediately visible and attributable to a specific step.

### Error handling

This is explicitly a **diagnostic tool** — failures (malformed JSON from
the vision model, an out-of-bounds/degenerate crop box, an Ollama timeout)
are surfaced **raw** on the page for a given step rather than silently
falling back to a default. That's the point: seeing exactly where and how
detection breaks. `runVisionPipeline` does not swallow errors — a failed
step's `PipelineStep` carries an `error` field and the pipeline stops
there (later steps depend on earlier ones, e.g. crop detection needs the
oriented image). Graceful production fallbacks (e.g. "if crop detection
fails, skip cropping rather than aborting") belong to the future
"Convert to PDF" feature, not this diagnostic surface.

## Testing

- **`src/domain/image-adjust.test.ts`** — pure math, same Vitest pattern as
  the rest of `src/domain/*.test.ts`. Can port pdf-awesome's existing
  `tests/test_auto_adjust.js` cases directly since the math is unchanged.
- **`src/infrastructure/vision-client.test.ts`** — mocks the `ollama`
  package (same mocking pattern already used in
  `src/infrastructure/ollama-client.test.ts` /
  `src/application/classify-document.test.ts`) to verify prompt
  construction and JSON-parsing/error paths, without a real model call.
- The canvas pixel operations (`image-processor.ts`) and the actual
  minicpm-v4.6 model calls are **not** unit-tested — they're exercised
  live via the Vision Lab test page itself, per the diagnostic-first
  purpose of this feature.
- `npm run build` / `npm run typecheck` — no type errors.

## Verification

- `npm run vision:dev`, open `http://localhost:3179/test-image-to-pdf.html`,
  upload a real phone-captured document photo (sideways or upside down,
  with visible desk/background around it), click Run Pipeline, and confirm:
  - Step 2 shows the image rotated upright.
  - Step 3 shows it cropped to just the document.
  - Step 4 shows visibly better contrast/brightness than the original.
  - Each vision-model step's raw JSON is visible and matches what's drawn.
- Repeat with a photo that's already upright and a photo with a fully
  cluttered background, to see how detection degrades — expected, since
  this phase intentionally does not add fallback heuristics.
