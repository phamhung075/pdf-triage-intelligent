# 📄 PDF/Photo Text Extraction & Canonical Paths (pdf2w + Go organize-files service)

> **One-line summary**: PDF/photo text extraction and OCR now happen exclusively via the external,
> self-hosted `markdown-extract-service` (**pdf2w**), reached through `PDF2W_SERVICE_URL`.
> Canonical-path computation (taxonomy → on-disk archive path) now happens in a separate Go
> microservice, `services/pdf-triage-pdf2w/` (a git submodule), reached through
> `CANONICAL_PATH_SERVICE_URL`. Both are **required, not optional-with-fallback**: an unreachable
> service is `FILE_FAILED` for that document — there is no in-process TypeScript fallback and no
> local OCR left. This replaces the removed `paddleocr-server/`, the Docling sidecar, and the
> in-repo `pdf-extract` Docker microservice split.

Full design record: [`docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md`](../superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md).
Implementation plan: [`docs/superpowers/plans/2026-09-18-pdf2w-extraction-swap.md`](../superpowers/plans/2026-09-18-pdf2w-extraction-swap.md).

## Why this exists

`paddleocr-server/` (Python/FastAPI), the never-fully-wired Docling sidecar, and the in-repo
`pdf-extract` Docker microservice split were three separate, partially-overlapping extraction
paths. All three are now replaced by one dependency: **pdf2w** (`markdown-extract-service`,
run self-hosted and unmodified — pdf-triage vendors none of its extraction code and never calls
`app.pdf2w.com`). pdf2w's Go gateway does native PDF→Markdown/text extraction plus its own
Gemini→DeepSeek vision-rescue OCR fallback for scanned/image-only pages — one dependency now
covers what PaddleOCR, Tesseract, and the Docling sidecar covered separately before.

Separately, `computeCanonicalPath` (taxonomy resolution → on-disk archive path) was ported out of
`src/domain/taxonomy.ts` into a new Go service, the first slice of the user's stated Go/Rust
backend-migration direction (see project memory `project_go_rust_migration.md`) — chosen because
it is pure/deterministic domain logic with no native dependencies, the natural first cut. This is
unrelated to pdf2w's own codebase; it's a brand-new repo pdf-triage owns as a submodule.

## Architecture

```
main pdf-triage app (TypeScript orchestrator: scan loop, classification/Ollama, SSE, SQLite —
                      unchanged 3-layer architecture, Golden Rule 16 still governs it)
   │
   ├─ 1. extraction: POST /convert  (raw file bytes + X-File-Name header)
   │     ▼
   │  src/infrastructure/pdf2w-remote.ts ──► self-hosted markdown-extract-service (pdf2w)
   │     EXISTING repo, run unmodified via its own docker-compose
   │     (/home/daihu/__projects__/markdown-extract-service). Handles native PDF text/table
   │     extraction and vision-rescue OCR (Gemini → DeepSeek) for scanned pages and
   │     image-only/photo-derived PDFs.
   │
   └─ 2. organize-files: POST /canonical-path  (originalPath, category, outputRootDir,
        │  subcategory?, dateStr?, title?)
        ▼
     src/infrastructure/canonical-path-remote.ts ──► services/pdf-triage-pdf2w/  (git submodule
        → https://github.com/phamhung075/pdf-triage-pdf2w) — a small Go net/http service exposing
        ONLY `computeCanonicalPath` (+ its private helpers generateIntelligentFilename/
        formatEntitySlug/isGenericFilename/sanitizePathSegment), ported function-for-function from
        `src/domain/taxonomy.ts`.
```

| Piece | Location | Role |
| --- | --- | --- |
| Extraction client | `src/infrastructure/pdf2w-remote.ts` | `extractPdf2wContent(filePath)` — POSTs raw bytes to pdf2w's `POST /convert`, returns `{ checksum, raw_text, numpages, info, pdf2w_markdown }` |
| Extraction routing seam | `src/infrastructure/pdf-extractor.ts` | `extractPDFContent()` — the export triage/repair/relocalize/convert-image-document already import — delegates every call straight to `pdf2w-remote.ts`, no branching |
| Canonical-path client | `src/infrastructure/canonical-path-remote.ts` | `computeCanonicalPathRemote(originalPath, category, outputRootDir, subcategory?, dateStr?, title?)` — POSTs to the Go service's `POST /canonical-path`, returns the resolved path string |
| Canonical-path caller | `src/application/relocalize-document.ts` | `relocalizeFileIfNeeded()` is `async` and awaits `computeCanonicalPathRemote()` instead of calling `computeCanonicalPath()` in-process |
| Go service | `services/pdf-triage-pdf2w/` (submodule) | `canonicalpath/canonicalpath.go` (ported logic) + `cmd/server/main.go` (`GET /health`, `POST /canonical-path`) |
| Config | `src/infrastructure/settings.ts` | `PDF2W_SERVICE_URL` / `_TIMEOUT_MS`, `CANONICAL_PATH_SERVICE_URL` / `_TIMEOUT_MS` — see [Environment & Config](./environment.md) |
| Compose | `docker-compose.yml` | Only the `pdf-triage-pdf2w` (Go) service is defined here; `markdown-extract-service` runs from its own repo's own compose on `:3984` |

## Required, not optional — no fallback

Both services are **hard dependencies**, matching the "no local OCR / no local canonical-path
fallback" decision in the design doc:

- pdf2w unreachable or misconfigured `PDF2W_SERVICE_URL` → `extractPdf2wContent()` throws →
  `extractPDFContent()` rejects → that file is `FILE_FAILED`, same posture as an unreachable Ollama
  today. There is no in-process extraction left to fall back to.
- The Go canonical-path service unreachable or misconfigured `CANONICAL_PATH_SERVICE_URL` →
  `computeCanonicalPathRemote()` throws → `relocalizeFileIfNeeded()` rejects → that file is
  `FILE_FAILED`. `domain/taxonomy.ts` no longer contains a local `computeCanonicalPath` to fall
  back to — it was deleted, not merely bypassed.

Both external processes (pdf2w's `markdown-extract-service` and this repo's
`pdf-triage-pdf2w`) must be up, on top of Ollama, for a scan to complete a file.

## Photo pipeline change — no local OCR

`convert-image-document.ts`'s `convertImageToPdf()` used to run OCR (PaddleOCR/Tesseract) between
enhance and PDF assembly, carrying the OCR'd text out in memory. It no longer does:

```
orient → crop → enhance → assemble the image-only A4 PDF (pure geometry, no OCR dependency)
  → extractPDFContent(pdfPath)   ← same call every other PDF makes
```

pdf2w's native extraction finds no text layer on an image-only PDF, triggers its own
vision-rescue, and returns the text — so photos and scanned PDFs now get their text from the exact
same place. `src/infrastructure/orientation-detector.ts` lost its OCR-verified orientation
tiebreaker (previously PaddleOCR, with Tesseract OSD as its availability fallback) as an accepted
side effect — pdf2w exposes no orientation-classification API — the cascade now falls back to EXIF,
the vision model, and flood-fill crop without it.

**Photo-pipeline invariants that still apply** (see the one-line anchors in `AGENTS.md` and the
headers of `flood-crop.ts` / `convert-image-document.ts`): never re-apply EXIF orientation, never
reintroduce the inverted crop-detector texture gate, never delete a source image. These govern the
geometry stages, which are unchanged by this swap.

## What was removed

- `paddleocr-server/` (Python/FastAPI OCR sidecar) and `src/infrastructure/paddleocr-client.ts`.
- The Docling sidecar client (`src/infrastructure/docling-remote.ts`) and its quality gate
  (`src/domain/docling-quality.ts`) — pdf2w has its own quality gate server-side.
- The in-repo `pdf-extract` Docker microservice split: `src/extract-service/`,
  `Dockerfile.extract-service`, `src/infrastructure/pdf-extract-remote.ts`.
- Config: `PADDLEOCR_HOST`, `PADDLEOCR_SPAWN_CMD`, `DOCLING_SERVICE_URL`, `DOCLING_SERVICE_REQUIRED`,
  `DOCLING_SERVICE_TIMEOUT_MS`, `PDF_EXTRACT_SERVICE_*`, `PDF_EXTRACT_PORT`, `PDF_EXTRACT_HOST`,
  `PDF_EXTRACT_MAX_BYTES`, `OCR_MAX_PAGES`, `OCR_RENDER_SCALE`.
- `src/domain/ocr-layout.ts` (OCR reading-order reconstruction — no local OCR left to reorder).
- The `npm run extract:dev` script.

`ocr_degraded` remains on the `ExtractedPDF` interface (`src/infrastructure/pdf-extractor.ts`) as
a legacy field — `relocalize-document.ts` still reads it — but `extractPDFContent()` never sets it
anymore: pdf2w performs its own vision-rescue server-side and reports no per-page
engine-degradation signal back. Treat it as always `false` going forward; see
[relocalize.md](../workflows/relocalize.md#which-text-a-re-analysis-uses).

## Running it

pdf2w (`markdown-extract-service`) is a **separate project** with its own repo and compose file —
run it there, then point pdf-triage's `.env` at it:

```bash
cd /home/daihu/__projects__/markdown-extract-service
docker compose up -d --build          # listens on 127.0.0.1:3984
curl http://127.0.0.1:3984/health
```

```dotenv
# pdf-triage's .env
PDF2W_SERVICE_URL=http://127.0.0.1:3984
CANONICAL_PATH_SERVICE_URL=http://127.0.0.1:3985
```

The Go canonical-path service builds from this repo's own `docker-compose.yml`:

```bash
docker compose up -d --build          # builds services/pdf-triage-pdf2w, listens on :3985
curl http://127.0.0.1:3985/health
```

Neither has a `_REQUIRED` toggle — both are always required. See
[Environment & Config](./environment.md) for the full variable table.

## Verification

- `src/infrastructure/pdf2w-remote.test.ts` — success path (adopts `markdown`/`text`), unreachable
  → hard error (no fallback branch to test since none exists), unconfigured → clear config error.
- `src/infrastructure/canonical-path-remote.test.ts` — same shape, against
  `computeCanonicalPathRemote()`.
- `services/pdf-triage-pdf2w/canonicalpath/canonicalpath_test.go` — the Go port's own test suite;
  ported case-for-case from the deleted `computeCanonicalPath` describe block in
  `src/domain/taxonomy.test.ts` (same inputs, same expected outputs — the acceptance bar for the
  port, per the design doc's Testing section).
- `cmd/server/main_test.go` (Go) — HTTP contract test for `POST /canonical-path` / `GET /health`.
