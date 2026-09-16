# Design: Replace paddleocr-server with a self-hosted pdf2w (Go/Rust) extraction service

> Status: design approved pending user review of this file. First slice of the user's stated
> Go/Rust migration direction for pdf-triage (see project memory `project_go_rust_migration.md`).

## Scope

**In scope:** the extraction/OCR subsystem — how pdf-triage turns a PDF or a photo into raw text
and Markdown.

**Explicitly out of scope (separate, later specs):**
- Adding DeepSeek API / Google API as selectable classification-LLM providers alongside local
  Ollama (a config-driven provider switch). This was the user's second original ask; it is
  unrelated to extraction and will be brainstormed separately.
- The rest of the Go/Rust migration beyond this slice. This spec does not commit to a timeline
  or plan for converting the remaining TypeScript app.

## Why

- `paddleocr-server/` (Python/FastAPI) and the never-fully-wired Python Docling sidecar
  (`DOCLING_SERVICE_URL`) are both being replaced by one dependency: **pdf2w**, a self-hosted
  Go gateway + Rust extraction core, built as new code in a dedicated submodule repo
  (`https://github.com/phamhung075/pdf-triage-pdf2w`), following the same architecture family as
  the sibling project `/home/daihu/__projects__/markdown-extract-service` (Rust `pdf2md-core` +
  Go `server-go` gateway) but owned and versioned independently by pdf-triage.
- pdf2w's Go gateway already implements native PDF→Markdown extraction plus a Gemini→DeepSeek
  vision-rescue fallback for scanned/image-only PDFs — one dependency now covers what PaddleOCR,
  Tesseract, and the Docling sidecar covered separately before.
- This is the first Go/Rust code to live inside pdf-triage, per the user's stated direction to
  move the project to Go/Rust over time, taken one scoped slice at a time.

## Target architecture

```
main pdf-triage app (TypeScript, unchanged 3-layer architecture — Golden Rule 16 still governs it)
   │
   │  POST /convert  (plain HTTP — same seam shape as today's PDF_EXTRACT_SERVICE_URL /
   │                   DOCLING_SERVICE_URL clients; no MCP client embedded in the running app)
   ▼
services/pdf2w-extract/   ← git submodule → https://github.com/phamhung075/pdf-triage-pdf2w
   Go gateway + Rust extraction core, self-hosted via docker-compose, no calls to app.pdf2w.com,
   no per-document billing. Handles: native PDF text/table extraction, and vision-rescue OCR
   (Gemini → DeepSeek) for scanned pages and image-only PDFs.
```

- The submodule is a **separate GitHub repo** (already created:
  `https://github.com/phamhung075/pdf-triage-pdf2w`), checked out at `services/pdf2w-extract/`
  via `.gitmodules`. New Go/Rust code is written there, not copy-pasted from
  `markdown-extract-service` — though depending on the public `pdf2md-core` Rust crate
  (`public/crates/pdf2md-core`, BSL-1.1, from the sibling repo) as a build dependency instead of
  reimplementing PDF parsing from scratch is an implementation-time decision, not fixed here.
- pdf2w is **required, not optional-with-fallback**. Unreachable → `FILE_FAILED` for that file, it
  stays in `__raws`, same posture as an unreachable Ollama today (Golden Rule: no silent
  degraded classification/extraction). There is no local OCR fallback left once this ships.

## Photo pipeline change

`convert-image-document.ts` currently: orient → crop → enhance → **OCR (PaddleOCR/Tesseract)** →
assemble PDF, returning the OCR'd text alongside the PDF so `extractPDFContent()` never re-reads
it (see the file's own header comment on why the text travels out in memory).

New flow: orient → crop → enhance → assemble the image-only A4 PDF (pure geometry, no OCR
dependency) → run it through the **same** `extractPDFContent()` / pdf2w path as any other PDF.
pdf2w's native extraction will find no text layer, trigger its own vision-rescue, and return the
text. This removes the special "OCR happens before assembly, text carried in memory" case
entirely — photos and scanned PDFs now get their text from the same place, at the cost of an
extra HTTP round-trip per photo (accepted: pdf2w's engine benchmarks show single-digit-ms native
extraction and the vision-rescue path was already the fallback quality bar for hard scans).

**Photo-pipeline invariants that still apply** (Golden Rule 17, headers of `flood-crop.ts` /
`convert-image-document.ts`): never re-apply EXIF orientation, never reintroduce the inverted
crop-detector texture gate, never delete a source image — these govern the geometry stages, which
are unchanged by this design.

## Deletions

| Path | Reason |
| --- | --- |
| `paddleocr-server/` (whole dir) | Replaced by pdf2w's vision-rescue |
| `src/infrastructure/paddleocr-client.ts` + `.test.ts` | No PaddleOCR client needed |
| `src/infrastructure/docling-remote.ts` | Python-Docling-shaped client, superseded |
| `src/domain/docling-quality.ts` + `.test.ts` | Docling-specific gate; pdf2w has its own quality gate server-side |
| `src/extract-service/` (the whole in-process/Docker extract split: `pdfjs-dist`, `@napi-rs/canvas`, `tesseract.js` path) + `Dockerfile.extract-service` | pdf2w's Rust core covers PDF text/table extraction; its vision-rescue covers scanned pages. This microservice's job is now redundant. |
| `src/infrastructure/pdf-extract-remote.ts` | Client for the deleted extract-service |
| `src/infrastructure/orientation-detector.ts` OCR-dependent bits, `ocr-layout.ts` (audit before deleting — confirm no non-OCR consumers) | To be verified during implementation, not assumed here |
| `PADDLEOCR_HOST` / `PADDLEOCR_SPAWN_CMD` / `DOCLING_SERVICE_URL` / `DOCLING_SERVICE_REQUIRED` / `DOCLING_SERVICE_TIMEOUT_MS` / `PDF_EXTRACT_SERVICE_*` / `PDF_EXTRACT_PORT` / `PDF_EXTRACT_HOST` / `PDF_EXTRACT_MAX_BYTES` config in `settings.ts` and `.env.example` | Superseded config surface |
| `docs/knowledge/docling-extract-layer.md`, `docs/knowledge/pdf-extract-service.md`, and the now-stale parts of `docs/knowledge/service-split-plan.md` | Describe the removed Python/old-split architecture — flagged for docs-curator rewrite, not hand-edited in this spec |

## Additions

| Path | Role |
| --- | --- |
| `services/pdf2w-extract/` | Git submodule → `pdf-triage-pdf2w` repo; new Go/Rust code |
| `.gitmodules` entry | Registers the submodule |
| `src/infrastructure/pdf2w-remote.ts` | New TS HTTP client: `POST /convert`, raw bytes + filename header, returns `{ markdown, text, numpages, checksum, engine }` — replaces every call site that used `pdf-extract-remote.ts` or `docling-remote.ts` |
| `docker-compose.yml` new service block | Builds `services/pdf2w-extract/`, publishes the gateway port, healthcheck — mirrors today's `pdf-extract` block shape |
| New config in `settings.ts` / `.env.example` | `PDF2W_SERVICE_URL`, `PDF2W_SERVICE_TIMEOUT_MS`. No `_REQUIRED` toggle — always required, no optional/fallback mode. |

## Routing change in `pdf-extractor.ts`

`extractPDFContent()` currently tries Docling first (optional), then the in-process/remote
extract-service chain. New shape: a single call to `pdf2w-remote.ts` for every PDF and every
photo-derived PDF; no fallback branch, no `tryDoclingExtraction`-style optional layer. Unreachable
service is a hard error surfaced as `FILE_FAILED`, matching the "hard-required" decision above.

## Testing

- Delete: `paddleocr-client.test.ts`, `docling-quality.test.ts`, `pdf-extractor-docling-routing.test.ts`,
  `pdf-extractor-routing.test.ts` (extract-service specific), `src/extract-service/app.test.ts`.
- Add: `pdf2w-remote.test.ts` — success path (adopt markdown/text), unreachable → hard error
  (`FILE_FAILED`, no silent fallback branch to test since none exists).
- Update: `convert-image-document.test.ts`, `image-to-pdf.test.ts`, `image-to-pdf.integration.test.ts`
  for the no-local-OCR photo path (assert OCR is no longer called before assembly, and that the
  assembled PDF is handed to the same `extractPDFContent()` path as any other PDF).
- Full `npm test` + `npm run typecheck` must stay green with `PDF2W_SERVICE_URL` unset in test env
  raising a clear config error (no silent no-op, since there is no fallback mode to silently take).

## Risks / accepted trade-offs

- **No local fallback.** A stopped `pdf2w-extract` container blocks all triage (by design, per the
  "hard-required" decision) — same operational posture as Ollama being down today.
- **Vision-rescue depends on pdf2w's own Gemini/DeepSeek keys**, configured inside the
  `pdf2w-extract` submodule's own environment, not pdf-triage's `.env`. Documenting that
  boundary clearly is part of implementation, so a misconfigured key surfaces as a clear pdf2w
  error, not a silent pdf-triage bug.
- **New submodule maintenance burden**: pdf-triage now owns a second repo's release/versioning
  (pinned submodule commit), on top of the already-separate `markdown-extract-service` project.
