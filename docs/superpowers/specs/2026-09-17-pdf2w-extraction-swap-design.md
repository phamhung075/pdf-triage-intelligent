# Design: Replace paddleocr-server with pdf2w extraction + a Go organize-files service

> Status: design approved pending user review of this file. First slice of the user's stated
> Go/Rust migration direction for pdf-triage (see project memory `project_go_rust_migration.md`).
>
> **2026-09-18 correction:** the new submodule does NOT reimplement extraction. pdf-triage's
> TypeScript app calls the existing, unmodified, self-hosted `markdown-extract-service` (pdf2w)
> directly for extraction — same as it already knows how to do for `pdf-extract`/Docling today.
> The new Go submodule's job is the **organize-files** logic (taxonomy resolution, canonical path
> computation, archive move), migrated from TypeScript and adapted to this pipeline. This is the
> first slice of the full-backend Go/Rust migration (see project memory), chosen because it is
> pure/deterministic domain logic with no native dependencies — the natural first cut.

## Scope

**In scope:**
1. How pdf-triage turns a PDF or a photo into raw text and Markdown — replacing PaddleOCR/the
   Docling sidecar with the existing, unmodified, self-hosted pdf2w (`markdown-extract-service`).
2. Migrating the **organize-files** step (taxonomy resolution + canonical path + archive move) —
   currently TypeScript in `src/domain/taxonomy.ts` / `triage-scan.ts` — to a new Go service,
   called by the still-TypeScript orchestrator over HTTP.

**Explicitly out of scope (separate, later specs):**
- Adding DeepSeek API / Google API as selectable classification-LLM providers alongside local
  Ollama (a config-driven provider switch). This was the user's second original ask; it is
  unrelated to extraction and will be brainstormed separately.
- Classification itself (the Ollama call), the scan orchestration loop, SSE broadcast, and
  SQLite/registry persistence all **stay TypeScript** in this slice. Only extraction (now an
  external call to pdf2w) and organize-files (now a Go service call) move out of the TS in-process
  path. The rest of the full-backend Go/Rust migration is tracked separately, one scoped slice at
  a time — this spec does not commit to their order or timeline.

## Why

- `paddleocr-server/` (Python/FastAPI) and the never-fully-wired Python Docling sidecar
  (`DOCLING_SERVICE_URL`) are both being replaced by one dependency: **pdf2w**
  (`markdown-extract-service`, Rust `pdf2md-core` + Go `server-go` gateway), run **self-hosted and
  unmodified** — reusing its existing extraction engine rather than rebuilding one. pdf-triage
  does not vendor or reimplement any of its extraction code.
- pdf2w's Go gateway already implements native PDF→Markdown extraction plus a Gemini→DeepSeek
  vision-rescue fallback for scanned/image-only PDFs — one dependency now covers what PaddleOCR,
  Tesseract, and the Docling sidecar covered separately before.
- Separately, the organize-files step is being ported to a **new** Go repo
  (`https://github.com/pdf-triage-org/pdf-triage-pdf2w`, added as a git submodule) — this is where
  new code is actually written for this slice, and it is the first Go/Rust code to live inside
  pdf-triage, per the user's stated direction to move the backend to Go/Rust over time, taken one
  scoped slice at a time.

## Target architecture

```
main pdf-triage app (TypeScript orchestrator: scan loop, classification/Ollama, SSE, SQLite —
                      unchanged 3-layer architecture, Golden Rule 16 still governs it)
   │
   ├─ 1. extraction: POST /convert  (plain HTTP, same seam shape as today's
   │     PDF_EXTRACT_SERVICE_URL / DOCLING_SERVICE_URL clients)
   │     ▼
   │  self-hosted markdown-extract-service (pdf2w) — EXISTING repo, run unmodified via its own
   │     docker-compose (/home/daihu/__projects__/markdown-extract-service), no calls to
   │     app.pdf2w.com, no per-document billing, no new code written for it. Handles native
   │     PDF text/table extraction and vision-rescue OCR (Gemini → DeepSeek) for scanned pages
   │     and image-only PDFs. pdf-triage only ever points a URL at it.
   │
   └─ 2. organize-files: POST /canonical-path  (plain HTTP, new seam)
        ▼
     services/pdf-triage-pdf2w/   ← git submodule → https://github.com/pdf-triage-org/pdf-triage-pdf2w
        NEW Go code: ONLY computeCanonicalPath (+ its private helpers
        generateIntelligentFilename/formatEntitySlug/isGenericFilename/sanitizePathSegment) ported
        from src/domain/taxonomy.ts. This is the one taxonomy.ts function actually in the
        organize-a-just-classified-file path (called from relocalize-document.ts's
        relocalizeFileIfNeeded, itself used by both triage-scan's post-classification move and the
        manual Relocalize UI flow) — a single call per file, tolerant of network latency the same
        way Golden Rule 9's per-file yield already is.
```

**Scoping note — why not port all of `taxonomy.ts`:** the module is imported synchronously in 10
files, several of them hot paths: `categories-store.ts` runs every subcategory through
`isForbiddenSubcategory` on every config read, `pdf-scanner.ts` calls `isPathInsideDir` while
walking directories, `database.ts` calls `detectFileType` per row. Turning those into HTTP round
trips would be a real performance/complexity regression for no benefit. `isForbiddenSubcategory`,
`isPathInsideDir`, `isYearString`, `detectFileType`, `findCanonicalCategoryForSubcategory`, and
`mergeSubcategoryInTaxonomy` **all stay TypeScript, unchanged, in this slice** — a future slice can
revisit them individually if a concrete reason to move one appears. The pre-move category
auto-creation (`ensureCategoryAndSubcategoryExist` in `relocalize-document.ts`,
`saveCategoriesConfig` writes in `classify-document.ts`) also stays TypeScript — it does I/O
against `.categories.private.json`, which is not pure logic and was never actually proposed to
move; the earlier draft of this spec listed it under the Go service's job by mistake.

- pdf2w (extraction) is **required, not optional-with-fallback**. Unreachable → `FILE_FAILED` for
  that file, it stays in `__raws`, same posture as an unreachable Ollama today. There is no local
  OCR fallback left once this ships.
- The organize-files Go service is likewise required for the scan to complete a file: unreachable
  → `FILE_FAILED`, no in-process TypeScript fallback path is kept once this ships (keeping two
  parallel implementations of the same logic would defeat the point of migrating it).

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
| `services/pdf-triage-pdf2w/` | Git submodule → NEW `pdf-triage-pdf2w` repo; the organize-files Go service (taxonomy resolution, canonical path, archive move) — no extraction code |
| `.gitmodules` entry | Registers the submodule |
| `src/infrastructure/pdf2w-remote.ts` | New TS HTTP client to the **self-hosted, unmodified** `markdown-extract-service`: `POST /convert`, raw bytes + filename header, returns `{ markdown, text, numpages, checksum, engine }` — replaces every call site that used `pdf-extract-remote.ts` or `docling-remote.ts` |
| `src/infrastructure/canonical-path-remote.ts` | New TS HTTP client to the new Go service: `POST /canonical-path` with `{ originalPath, category, outputRootDir, subcategory?, dateStr?, title? }` (the exact `computeCanonicalPath` parameter list) → `{ canonicalPath: string }`. Pure request/response, no filesystem access on the Go side. |
| New config in `settings.ts` / `.env.example` | `PDF2W_SERVICE_URL` / `PDF2W_SERVICE_TIMEOUT_MS` for extraction; `CANONICAL_PATH_SERVICE_URL` / `CANONICAL_PATH_SERVICE_TIMEOUT_MS` for the new Go service. Neither has a `_REQUIRED` toggle — both are always required, no optional/fallback mode. |

Nothing is added to pdf-triage's own `docker-compose.yml` for extraction: `markdown-extract-service`
runs from its own repo's own compose file, exactly as the current (never-fully-wired) Docling
sidecar docs already describe. `docker-compose.yml` only gains a new block for
`services/pdf-triage-pdf2w/` (the organize-files service), mirroring today's `pdf-extract` block
shape.

## Routing changes

- `pdf-extractor.ts`: `extractPDFContent()` currently tries Docling first (optional), then the
  in-process/remote extract-service chain. New shape: a single call to `pdf2w-remote.ts` for every
  PDF and every photo-derived PDF; no fallback branch, no `tryDoclingExtraction`-style optional
  layer. Unreachable service is a hard error surfaced as `FILE_FAILED`.
- `relocalize-document.ts`: `relocalizeFileIfNeeded()` currently imports `computeCanonicalPath`
  directly from `domain/taxonomy.ts`. It becomes `async` and calls `canonical-path-remote.ts`
  instead — its only change is where the target path comes from; the atomic-rename logic
  (`renameAtomicNoOverwrite`), logging, and its two callers (`triage-scan.ts`'s
  post-classification move, the manual Relocalize HTTP route) are otherwise unchanged, except that
  callers now need to `await` it. Unreachable service is a hard error — no in-process TypeScript
  fallback (and no local copy of `computeCanonicalPath` kept "just in case") once this ships.
- `domain/taxonomy.ts`: `computeCanonicalPath`, `generateIntelligentFilename`, `formatEntitySlug`,
  `isGenericFilename`, and the private `sanitizePathSegment` are deleted from this file (moved to
  the Go submodule) once `canonical-path-remote.ts` is wired in and its test parity is confirmed.
  Every other export in the file (`isForbiddenSubcategory`, `isPathInsideDir`, `isYearString`,
  `detectFileType`, `findCanonicalCategoryForSubcategory`, `mergeSubcategoryInTaxonomy`) is
  untouched.

## Testing

- Delete: `paddleocr-client.test.ts`, `docling-quality.test.ts`, `pdf-extractor-docling-routing.test.ts`,
  `pdf-extractor-routing.test.ts` (extract-service specific), `src/extract-service/app.test.ts`.
- Add: `pdf2w-remote.test.ts` — success path (adopt markdown/text), unreachable → hard error
  (`FILE_FAILED`, no silent fallback branch to test since none exists).
- Add: `canonical-path-remote.test.ts` — success path (adopt `canonicalPath`), unreachable → hard
  error. The Go submodule owns its own test suite for the ported `computeCanonicalPath` logic;
  the existing TS cases for it in `taxonomy.test.ts` are the acceptance reference during the port
  (same inputs, same outputs, ported not redesigned) and are deleted from `taxonomy.test.ts` only
  once the Go tests reproduce them and `relocalize-document.ts` is wired to the remote call.
- Update: `convert-image-document.test.ts`, `image-to-pdf.test.ts`, `image-to-pdf.integration.test.ts`
  for the no-local-OCR photo path (assert OCR is no longer called before assembly, and that the
  assembled PDF is handed to the same `extractPDFContent()` path as any other PDF).
- Full `npm test` + `npm run typecheck` must stay green with `PDF2W_SERVICE_URL` /
  `ORGANIZE_SERVICE_URL` unset in test env raising a clear config error (no silent no-op, since
  neither has a fallback mode to silently take).

## Risks / accepted trade-offs

- **No local fallback, two new required dependencies.** A stopped `markdown-extract-service` or a
  stopped `pdf-triage-pdf2w` organize-files service each independently block all triage (by
  design, per the "hard-required" decision) — same operational posture as Ollama being down today,
  but now three external processes must all be up for a scan to complete a file (Ollama,
  markdown-extract-service, pdf-triage-pdf2w).
- **Vision-rescue depends on pdf2w's own Gemini/DeepSeek keys**, configured inside
  `markdown-extract-service`'s own environment (its own repo, its own `.env`), not pdf-triage's.
  Documenting that boundary clearly is part of implementation, so a misconfigured key surfaces as
  a clear pdf2w error, not a silent pdf-triage bug.
- **New submodule maintenance burden**: pdf-triage now owns a new repo's release/versioning
  (pinned submodule commit for `pdf-triage-pdf2w`), on top of depending on the already-separate
  `markdown-extract-service` project's own deployment.
- **Porting risk on `computeCanonicalPath`**: it is security/correctness-sensitive (Golden Rules
  4, 7, 8 — the path-sanitization comment in `taxonomy.ts` documents a real prior incident where an
  unsanitized category escaped `OUTPUT_ROOT_DIR`). A Go port must reproduce its behavior exactly,
  not just approximately. The existing TS test suite (`taxonomy.test.ts`) is the acceptance bar;
  this is real re-implementation risk, not a mechanical transliteration.
- **Narrow scope, by design**: only `computeCanonicalPath` (+ private helpers) moves to Go in this
  slice. `isForbiddenSubcategory`, `isPathInsideDir`, `isYearString`, `detectFileType`,
  `findCanonicalCategoryForSubcategory`, `mergeSubcategoryInTaxonomy`, and all category
  auto-creation/persistence stay TypeScript — they are either hot-path (called per file during a
  directory walk or per DB row) or do I/O against `.categories.private.json`, neither of which
  benefits from a network hop. A future slice can revisit any of them individually.
