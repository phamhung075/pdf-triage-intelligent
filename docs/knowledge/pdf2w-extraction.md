# 📄 PDF/Photo Text Extraction (pdf2w)

> **One-line summary**: PDF/photo text extraction and OCR happen exclusively via the external,
> self-hosted `markdown-extract-service` (**pdf2w**), reached through `PDF2W_SERVICE_URL` from the
> `infra/pdf2w` package. It is **required, not optional-with-fallback**: an unreachable service is
> `FILE_FAILED` for that document — there is no in-process extraction tier and no local OCR left.
> Canonical-path resolution and extracted-text cleaning are **not** services: the Go binary does
> both in-process, through the `canonicalpath` and `cleantext` packages. This replaces the removed
> `paddleocr-server/`, the Docling sidecar, the in-repo `pdf-extract` Docker microservice split,
> and the former `pdf-triage-pdf2w` canonical-path helper service that the TypeScript backend
> called over HTTP.

Full design record: [`docs/superpowers/specs/2026-09-18-go-backend-migration-design.md`](../superpowers/specs/2026-09-18-go-backend-migration-design.md)
and, for the extraction swap itself,
[`docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md`](../superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md).

## Why this exists

`paddleocr-server/` (Python/FastAPI), the never-fully-wired Docling sidecar, and the in-repo
`pdf-extract` Docker microservice split were three separate, partially-overlapping extraction
paths. All three are now replaced by one dependency: **pdf2w** (`markdown-extract-service`,
run self-hosted and unmodified — pdf-triage vendors none of its extraction code and never calls
`app.pdf2w.com`). pdf2w does native PDF→Markdown/text extraction plus its own
Gemini→DeepSeek vision-rescue OCR fallback for scanned/image-only pages — one dependency now
covers what PaddleOCR, Tesseract, and the Docling sidecar covered separately before.

When the backend moved to Go, the two remaining HTTP hops around the pipeline were also removed:
`computeCanonicalPath` (taxonomy resolution → on-disk archive path) and `cleanExtractedText`
(normalize raw extracted text) were already ported into the `canonicalpath` and `cleantext`
packages, and the Go binary calls them **in-process** instead of over a loopback network call.

## Architecture

```
pdf-triage (one Go binary)
   │
   ├─ 1. extraction: POST /convert  (raw file bytes + X-File-Name header)
   │     ▼
   │  infra/pdf2w ──► self-hosted markdown-extract-service (pdf2w)
   │     EXTERNAL repo, run unmodified via its own docker-compose on :3984.
   │     Handles native PDF text/table extraction and vision-rescue OCR
   │     (Gemini → DeepSeek) for scanned pages and image-only/photo-derived PDFs.
   │
   └─ 2. canonical path + text cleaning: in-process, no network
        canonicalpath.computeCanonicalPath(...)   ← ported from the retired TypeScript taxonomy module
        cleantext.cleanExtractedText(...)         ← ported from the retired TypeScript pdf-text module
```

| Piece | Location | Role |
| --- | --- | --- |
| Extraction client | `infra/pdf2w` (`services/pdf-triage-pdf2w/infra/pdf2w`) | POSTs raw bytes to pdf2w's `POST /convert`, returns `{ checksum, raw_text, numpages, info, pdf2w_markdown }` |
| Extraction routing seam | `infra/pdfextractor` | `extractPDFContent()` — the entry point triage/repair/relocalize/convertimage use — delegates every call to `infra/pdf2w`, no branching |
| Canonical-path logic | `canonicalpath` package | `computeCanonicalPath` ported from the retired TypeScript taxonomy module; called in-process by `app/relocalize` |
| Text cleaning | `cleantext` package | `CleanExtractedText` ported from the retired TypeScript pdf-text module; called in-process before text enters the pipeline |
| Config | `infra/settings` | `PDF2W_SERVICE_URL` / `PDF2W_SERVICE_TIMEOUT_MS` — see [Environment & Config](./environment.md) |
| Compose | `docker-compose.yml` (repo root) | Declares **no** service after the cutover: pdf2w runs from its own repo's compose on `:3984`, and the former canonical-path service is gone |

## Required, not optional — no fallback

pdf2w is a **hard dependency**, matching the "no local extraction / no local OCR" decision in the
design doc:

- pdf2w unreachable or misconfigured `PDF2W_SERVICE_URL` → the `infra/pdf2w` call throws →
  `extractPDFContent()` surfaces the error → that file is `FILE_FAILED`, same posture as an
  unreachable Ollama today. There is no in-process extraction left to fall back to.

Canonical-path resolution and text cleaning are **local function calls**, not network calls: there
is no `_SERVICE_URL` for either and nothing to be unreachable. If they fail it is an ordinary code
error, not a transport failure.

pdf2w's `markdown-extract-service` must be up, on top of Ollama, for a scan to complete a file.

## Photo pipeline change — no local OCR

`convertImageToPdf()` (`app/convertimage`) used to run OCR (PaddleOCR/Tesseract) between
enhance and PDF assembly, carrying the OCR'd text out in memory. It no longer does:

```
orient → crop → enhance → assemble the image-only A4 PDF (pure geometry, no OCR dependency)
  → extractPDFContent(pdfPath)   ← same call every other PDF makes
```

pdf2w's native extraction finds no text layer on an image-only PDF, triggers its own
vision-rescue, and returns the text — so photos and scanned PDFs now get their text from the exact
same place. The orientation detector lost its OCR-verified orientation
tiebreaker (previously PaddleOCR, with Tesseract OSD as its availability fallback) as an accepted
side effect — pdf2w exposes no orientation-classification API — the cascade now falls back to EXIF,
the vision model, and flood-fill crop without it.

**Photo-pipeline invariants that still apply** (see the one-line anchors in `AGENTS.md` and the
package docs of `floodcrop` / `app/convertimage`): never re-apply EXIF orientation, never
reintroduce the inverted crop-detector texture gate, never delete a source image. These govern the
geometry stages, which are unchanged by this swap.

## What was removed

- `paddleocr-server/` (Python/FastAPI OCR sidecar) and the TypeScript PaddleOCR client.
- The Docling sidecar client and its TypeScript quality gate — pdf2w has its own quality gate
  server-side.
- The in-repo `pdf-extract` Docker microservice split.
- The TypeScript canonical-path and clean-text HTTP clients, and the loopback
  `pdf-triage-pdf2w` helper service that served `POST /canonical-path` and `POST /clean-text` on
  `:3985`. Both calls are in-process Go now; `docker-compose.yml` declares no service.
- Config: `PADDLEOCR_HOST`, `PADDLEOCR_SPAWN_CMD`, `DOCLING_SERVICE_URL`, `DOCLING_SERVICE_REQUIRED`,
  `DOCLING_SERVICE_TIMEOUT_MS`, `PDF_EXTRACT_SERVICE_*`, `PDF_EXTRACT_PORT`, `PDF_EXTRACT_HOST`,
  `PDF_EXTRACT_MAX_BYTES`, `OCR_MAX_PAGES`, `OCR_RENDER_SCALE`, `CANONICAL_PATH_SERVICE_URL`,
  `CANONICAL_PATH_SERVICE_TIMEOUT_MS`.
- The local OCR reading-order reconstruction and the `npm run extract:dev` script.

`ocr_degraded` remains on the extracted result as a legacy field — `app/relocalize` still reads it —
but `extractPDFContent()` never sets it anymore: pdf2w performs its own vision-rescue server-side
and reports no per-page engine-degradation signal back. Treat it as always `false` going forward;
see [relocalize.md](../workflows/relocalize.md#which-text-a-re-analysis-uses).

## Running it

pdf2w (`markdown-extract-service`) is a **separate project** with its own repo and compose file —
run it there, then point pdf-triage's `.env` at it:

```bash
# in the markdown-extract-service repository
docker compose up -d --build          # listens on 127.0.0.1:3984
curl http://127.0.0.1:3984/health
```

```dotenv
# pdf-triage's .env
PDF2W_SERVICE_URL=http://127.0.0.1:3984
```

There is no canonical-path service to start and no `_REQUIRED` toggle — pdf2w is always required.
See [Environment & Config](./environment.md) for the full variable table.

## Verification

- `infra/pdf2w/pdf2w_test.go` — extraction client: success path (adopts `markdown`/`text`),
  unreachable → hard error (no fallback branch to test since none exists), unconfigured → clear
  config error.
- `canonicalpath/canonicalpath_test.go` — the Go port's own test suite, ported case-for-case from
  the deleted `computeCanonicalPath` block in the former TypeScript test suite (same inputs, same
  expected outputs — the acceptance bar for the port, per the design doc's Testing section).
- `app/relocalize` tests cover the in-process call site; `infra/pdfextractor` tests cover the
  extraction seam.
