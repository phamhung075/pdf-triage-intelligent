# PaddleOCR integration (replace tesseract.js as OCR engine)

Date: 2026-08-15
Owner: none yet — cuts across `pipeline-engineer` (pdf-extractor.ts) and the
Vision Lab orientation cascade (orientation-detector.ts); see "Ownership"
below.

## Problem

`tesseract.js` is used in two places today:

- `src/infrastructure/pdf-extractor.ts` — the OCR fallback that extracts
  `raw_text` from scanned PDFs (no digital text layer) and standalone image
  files, feeding the classifier and FTS5 search index.
- `src/infrastructure/orientation-detector.ts` — a dedicated Orientation &
  Script Detection (OSD) worker used as the tiebreaker signal in
  `detectOrientationCascade` when EXIF metadata and the vision model
  disagree (or EXIF is absent).

PaddleOCR (`D:\<user>\__projet\__master\PADDLEOCR`, Apache 2.0, free)
produces materially more accurate detection+recognition than Tesseract,
especially on rotated text, dense layouts, and real phone-photographed
documents — the same category of input this project already struggles with
in the Vision Lab crop/orientation work. It also ships a dedicated document
orientation classifier (0/90/180/270), a direct functional replacement for
Tesseract's OSD.

## Goal (this spec's scope)

Introduce PaddleOCR as the primary OCR engine for **both** existing
tesseract.js call sites, with Tesseract retained as an availability
fallback (not a quality cascade — see "Fallback philosophy" below):

1. A standalone local Python service (`paddleocr-server/`) exposing OCR
   text extraction and document-orientation classification over HTTP.
2. A Node-side client (`src/infrastructure/paddleocr-client.ts`) that calls
   it, auto-spawning the process if unreachable (mirrors
   `ensureOllamaModel()` in `ollama-client.ts`).
3. `pdf-extractor.ts`'s two Tesseract call sites (scanned-PDF canvas OCR,
   standalone image-file OCR) swapped to call PaddleOCR first.
4. `orientation-detector.ts`'s OSD tiebreaker swapped to call PaddleOCR's
   orientation classifier first.

Explicitly **out of scope**:

- Any change to Vision Lab crop detection (`crop-detector.ts`,
  `flood-crop.ts`) — unrelated subsystem, already fixed this branch.
- Removing tesseract.js or its worker code — it stays as the fallback path.
- A JS/ONNX in-process alternative (`@paddleocr/paddleocr-js`) — evaluated
  and rejected for now; see "Alternatives considered."
- Auto-installing the Python environment/dependencies — a one-time manual
  setup step (documented, not automated).

## Alternatives considered

- **Python subprocess per document** (`child_process.exec('python -m
  paddleocr ...')` per call): simplest to wire up, no service to keep
  alive, but pays Python interpreter + model-load startup cost (multiple
  seconds) on every single document scanned. Rejected — too slow for a
  pipeline that OCRs routinely.
- **`@paddleocr/paddleocr-js`** (found at
  `PADDLEOCR/paddleocr-js`, published as `@paddleocr/paddleocr-js`,
  ONNX Runtime + OpenCV.js, no Python): would avoid a second language
  entirely. Rejected for now — its public API is built around browser
  inputs (`Blob`, `ImageBitmap`, `HTMLCanvasElement`, `cv.Mat`) and Worker
  mode with COOP/COEP header concerns; there's no documented Node-backend
  usage path, and confirming feasibility would need its own spike. Worth
  revisiting later if the Python service proves operationally annoying.
- **Local HTTP microservice** (chosen): matches the project's existing
  Ollama/vision-model pattern exactly — a local service Node calls over
  HTTP, with the model loaded once and kept warm rather than reloaded per
  call.

## Architecture

### `paddleocr-server/` (new, Python/FastAPI)

Two endpoints:

- `GET /health` — liveness check.
- `POST /ocr` — image bytes in, recognized text out. Backs
  `ocrPdfPagesWithCanvas`'s per-page OCR and the standalone image-file OCR
  branch in `extractPDFContent`.
- `POST /orientation` — image bytes in, `{ rotationDegrees: 0|90|180|270,
  confidence }` out, using PaddleOCR's document orientation classifier
  module. Backs the OSD tiebreaker in `detectOrientationCascade`.

Requires a one-time manual setup (`pip install -r
paddleocr-server/requirements.txt` — fastapi, uvicorn, paddleocr,
paddlepaddle), documented in the repo. Node cannot provision this itself.

### `src/infrastructure/paddleocr-client.ts` (new)

Thin `fetch()`-based client, structurally parallel to `ollama-client.ts` /
`vision-client.ts`:

- `paddleOcrRecognize(imageBuffer): Promise<string>`
- `paddleOcrDetectOrientation(imageBuffer): Promise<{ rotationDegrees, confidence }>`
- `ensurePaddleOcrServer(): Promise<boolean>` — checks `/health`; if
  unreachable, `exec()`s the configured spawn command, polls `/health` with
  backoff (PaddleOCR's model load is heavier than Ollama's — a single fixed
  2s sleep like `ensureOllamaModel()` uses may not be enough), then
  re-checks. Returns `false` (never throws) if still unreachable after
  spawn — callers degrade to the Tesseract fallback.

Called lazily on first use per process lifetime, not per document.

### Config (`src/infrastructure/settings.ts`)

New `CONFIG` entries, following the existing `OLLAMA_HOST` /
`VISION_LAB_PORT` pattern:

- `PADDLEOCR_HOST` — default `http://127.0.0.1:8871`, env override
  `PADDLEOCR_HOST`.
- `PADDLEOCR_SPAWN_CMD` — default launch command for the local dev setup,
  overridable via env for users running Python in a venv (e.g.
  `.venv\Scripts\python.exe paddleocr-server/main.py`).

### Fallback philosophy

This is an **availability fallback, not a quality cascade**. Unlike the
Vision Lab crop/orientation cascades — which deliberately combine multiple
independently-unreliable signals (EXIF, vision model, OCR) because no
single one is trustworthy enough alone — text extraction and orientation
classification each only need one good answer. Tesseract only runs when
PaddleOCR is genuinely unreachable (service down, spawn failed), never as a
second opinion on every document; running both every time would double OCR
cost for no accuracy benefit.

Every PaddleOCR call site wraps in the same `try/catch` +
`logger.warn` + fallback-or-degrade shape the current Tesseract call sites
already use — no new failure mode reaches the scan pipeline; a document
that fails all OCR paths still gets a `[Image file: ...]` / empty-text
placeholder exactly as it does today.

### Integration point A — `pdf-extractor.ts`

- `ocrPdfPagesWithCanvas`: per rendered page PNG, try
  `paddleOcrRecognize(pngBuf)` first (>10-char acceptance threshold,
  unchanged); on failure/unavailable, fall back to the existing
  `getSharedTesseractWorker().recognize(pngBuf)` path.
- Image-file branch in `extractPDFContent`: same swap — PaddleOCR first,
  Tesseract fallback on failure.

`getSharedTesseractWorker()` and its worker stay in the code unchanged as
the fallback implementation.

### Integration point B — `orientation-detector.ts`

`detectOrientationCascade`'s three-way structure (EXIF → model →
OCR-tiebreaker) is unchanged; only the OCR signal's implementation swaps.
The current:

```ts
const worker = await getSharedOsdWorker();
const { data } = await worker.detect(imageBuffer);
```

becomes a call to `paddleOcrDetectOrientation(imageBuffer)`, with the same
fallback rule: if PaddleOCR is unavailable, fall back to the existing
Tesseract OSD worker rather than skipping the tiebreaker (silently dropping
to the model's own answer would regress exactly the disagreement case this
tiebreaker exists to resolve).

## Testing

- `paddleocr-client.test.ts` (new): mocks `fetch` — successful response
  parsing for both endpoints; health-check-fails-then-spawns-then-succeeds;
  spawn-fails-returns-false.
- `pdf-extractor.test.ts` / `orientation-detector.test.ts`: extend existing
  suites with a "PaddleOCR unavailable → falls back to Tesseract" case per
  call site (mock the client to reject, assert the existing Tesseract-path
  behavior/assertions still hold).
- `paddleocr-server/` gets a minimal `pytest` smoke test (one real image
  in, text out) — not part of `npm test` (needs the Python env), documented
  as a separate manual step.
- No changes needed to Vision Lab crop-detection tests
  (`flood-crop.test.ts`, `crop-detector.test.ts`) — separate subsystem.

## Ownership

No existing roster agent (`docs/agents/README.md`) owns OCR-engine
integration. `pdf-extractor.ts` falls under `pipeline-engineer`;
`orientation-detector.ts` is part of the still-unowned Vision Lab area (see
`2026-08-13-image-to-pdf-vision-lab-design.md`'s own open ownership
question). Not resolved in this spec — `docs-curator` should decide after
implementation whether this becomes its own agent or folds into
`pipeline-engineer`.

## Rollout sequencing

Sized for its own implementation plan, done in three independently
testable/revertable steps:

1. `paddleocr-server/` + `paddleocr-client.ts` + config, unit-tested in
   isolation (no call-site changes yet).
2. Swap into `pdf-extractor.ts`.
3. Swap into `orientation-detector.ts`.
