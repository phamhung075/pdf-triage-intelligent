# Vision Lab — "extract text" step

Date: 2026-08-15
Owner: none yet — same unowned Vision Lab area as
`2026-08-13-image-to-pdf-vision-lab-design.md`.

## Problem

The Vision Lab diagnostic pipeline (`runVisionPipeline` in
`src/application/image-to-pdf.ts`) currently stops after image processing:
`original → oriented → cropped → enhanced`. There's no way to see, from the
diagnostic page, what text a real triage scan would actually extract from
the final processed image — the whole point of running this pipeline in
the first place is to feed a clean image into the real app. A developer
debugging a bad crop/orientation result today has to manually drop the
photo into `__raws` and watch the real scan to see the OCR outcome.

## Goal (this spec's scope)

Add a 5th pipeline step, `extracted`, that:

1. Runs OCR on the final `enhanced` image buffer, using the exact same
   PaddleOCR-with-Tesseract-fallback behavior the real triage pipeline uses
   (added this session in the PaddleOCR integration plan).
2. Converts the raw OCR text into GFM Markdown using the main app's
   existing Step C conversion (`convertRawTextToZeroLossMarkdown` in
   `classify-document.ts`) — the same chunk-by-chunk Qwen-formatting logic
   real scanned documents go through, not a new/parallel implementation.
3. Displays the resulting markdown, rendered (not raw), on the diagnostic
   page (`public/test-image-to-pdf.html`).

Explicitly **out of scope**:

- Full classification (`classifyPDFText`'s Step A entity extraction / Step
  D classification + category resolution) — this step only needs Step C's
  markdown conversion, not the rest of the classification pipeline.
- Writing the extracted markdown anywhere persistent, or wiring this into
  the real triage scan — this is a diagnostic-page-only addition, same
  scope boundary as the rest of the Vision Lab feature.
- Any change to steps 0-3 (`original`/`oriented`/`cropped`/`enhanced`) or
  their detection logic.

## Design

### Reuse `ocrPageBuffer`, don't duplicate it

`src/infrastructure/pdf-extractor.ts` already has a private helper,
`ocrPageBuffer(pngBuf: Buffer): Promise<string>`, that does exactly what
this step needs: try `paddleOcrRecognize()`, catch, fall back to the
shared Tesseract worker. It's currently unexported and named for its one
existing caller (`ocrPdfPagesWithCanvas`). Export it under a more general
name, `ocrImageBuffer`, since it's no longer PDF-page-specific once
`image-to-pdf.ts` also calls it — one shared implementation instead of a
third copy of the same try/catch (the second copy already exists inline in
`extractPDFContent`'s image-file branch, which is left as-is since
touching it isn't needed here).

### Pipeline step

In `runVisionPipeline` (`src/application/image-to-pdf.ts`), after step 3
(`enhanced`) succeeds, add:

```ts
const step4Start = Date.now();
try {
  const rawText = await ocrImageBuffer(finalBuffer);
  const markdown = await convertRawTextToZeroLossMarkdown(rawText, 'vision-lab-diagnostic');
  const durationMs = Date.now() - step4Start;
  steps.push({ step: 4, label: 'extracted', imageBase64: '', durationMs, markdown, meta: { rawTextLength: rawText.length } });
} catch (err) {
  const durationMs = Date.now() - step4Start;
  steps.push({ step: 4, label: 'extracted', imageBase64: '', durationMs, error: errorMessage(err) });
}
```

Matching the existing step-3 pattern: a failure here is recorded on the
step (not thrown/rethrown to the caller), and — since this is the last
step — there's no "stop the pipeline" behavior to worry about, unlike
steps 1/2 whose failure means every later step's input doesn't exist.

`PipelineStep`'s `label` union type gains `'extracted'`, and the interface
gains an optional `markdown?: string` field.

`finalBuffer` is step 3's own local variable in the existing function —
this step reads it after step 3's try block, so it only runs when step 3
actually produced a final buffer (if step 3 itself failed, `finalBuffer`
was never assigned; step 4 must only run when step 3 succeeded — guard
this the same way the existing code already structures steps 1→2's
dependency, e.g. by placing step 4 inside step 3's own `try` block, right
after `finalBuffer` is computed, rather than as a separate top-level block
that would reference a possibly-unassigned variable).

### Diagnostic page rendering

`public/test-image-to-pdf.html` currently renders each step's `imageBase64`
(as an `<img>`), `modelRaw` and `meta` (as `<pre>` JSON dumps). Add:

- A `<script src="js/vendor/marked.js"></script>` include (same vendored
  file the main app already ships, no new dependency).
- In `renderSteps()`, when `step.markdown` is present, render it via
  `window.marked.parse(step.markdown)` into a new `.markdown-preview` div
  (styled distinctly from the existing `<pre>` blocks — readable prose,
  not monospace), instead of/in addition to the existing panels for that
  step.

## Testing

- `image-to-pdf.test.ts` / `image-to-pdf.integration.test.ts`: add a case
  covering step 4's success path (mocking `ocrImageBuffer` and
  `convertRawTextToZeroLossMarkdown`) and its failure path (one of them
  throwing → step 4 records an error, pipeline still returns all steps
  rather than throwing).
- `pdf-extractor.test.ts`: the export/rename of `ocrPageBuffer` →
  `ocrImageBuffer` needs its existing call site
  (`ocrPdfPagesWithCanvas`) and tests to keep passing unchanged — this is
  a rename, not a behavior change, so no new test is needed there beyond
  confirming the existing suite still passes.
- No test needed for `convertRawTextToZeroLossMarkdown` itself — it's
  existing, already-tested logic in `classify-document.test.ts`, reused
  as-is.
