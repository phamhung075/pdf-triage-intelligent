# 📄 Docling Structured Extraction (Optional Quality Layer)

> **One-line summary**: Docling (layout-aware PDF → Markdown with real tables) can run as a second,
> optional extractor in front of the normal chain. When `DOCLING_SERVICE_URL` is set and Docling's
> output passes a dedicated quality gate, its deterministic Markdown becomes `markdown_content`
> directly (the Step C LLM chunk-by-chunk conversion is skipped for that file) and its text becomes
> `raw_text`. Any Docling failure — service down, empty output, a whole page classified as one
> picture, a garbage text-layer decode — falls back to the normal chain unchanged.

## Why this exists

The normal extractor produces flat raw text: text-layer PDFs are read in content-stream order
(no reading order, no layout, headers/footers interleave, two-column pages scramble), and scanned
PDFs are OCR'd page-by-page into a flat line stream. All *structure* — headings, real GFM tables —
is then reconstructed later by the Step C LLM pass, which is lossy and slow.

Docling does the structure extraction **deterministically at extraction time** (ML layout analysis +
reading order + table-structure recognition), so on documents it handles well its Markdown is both
cleaner than raw text *and* already structured: Step C has nothing left to rebuild. Measured on the
real archive (18-doc spike, 2026-09-03): Docling produced **more** Markdown than the current
`raw_text` on 73 % of the sample, with real GFM tables on bank statements, pay slips and invoices
that the current flat text destroys.

## Architecture

```
PDF file
   │
   ▼  DOCLING_SERVICE_URL set + .pdf
┌──────────────────────┐   POST /extract (bytes + X-File-Name)
│ docling-remote.ts    │ ───────────────────────────────►  Docling service (Python/HTTP)
│ (HTTP client)        │ ◄───────────────────────────────  { checksum, markdown, text, numpages }
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ docling-quality.ts   │  assessDoclingMarkdown(markdown): PASS / FAIL
│ (pure gate)          │  - empty / whole-page-picture output        (photo-derived PDF class)
│                      │  - non-Latin mojibake decode                (broken ToUnicode CMap class)
│                      │  - OCR/decoration noise, corruption, ragged tables (reuses pdf-text/markdown-tables)
└──────────┬───────────┘
           ▼
   gate PASS ───────────────► raw_text = Docling text · docling_markdown = Docling Markdown
        │                        (Step C skipped downstream — markdown_content = docling_markdown)
        ▼
   gate FAIL / service down ──► normal chain unchanged (in-process or PDF_EXTRACT_SERVICE_URL)
```

| Piece | Location | Role |
| --- | --- | --- |
| Docling service | `/home/daihu/__projects__/markdown-extract-service` (own repo + compose, :3984) | extension-routed Python service: `POST /extract` (and `/to-markdown`) → `{ checksum, markdown, text, numpages, engine }` |
| Pure quality gate | `src/domain/docling-quality.ts` | `assessDoclingMarkdown` / `projectDoclingMarkdownToText` |
| HTTP client | `src/infrastructure/docling-remote.ts` | POST /extract → `{ checksum, markdown, text, numpages }` |
| Routing seam | `src/infrastructure/pdf-extractor.ts` | `tryDoclingExtraction()` runs first for `.pdf` when configured; fallback on any failure |
| Step C skip | `src/application/classify-document.ts` | `classifyPDFText(..., doclingMarkdown?)` uses pre-made Markdown as `markdown_content` |
| Config | `src/infrastructure/settings.ts` | `DOCLING_SERVICE_URL` / `_REQUIRED` / `_TIMEOUT_MS` |

## The quality gate (why it exists, what it rejects)

Docling's failures are **silent**. Measured on real archive documents, two failure classes return
plausible-looking output with no error:

1. **Whole-page-picture output.** A photo-derived single-image PDF (their own vision pipeline's
   A4 output, or a phone scan) can be classified by the layout model as one giant `picture`; OCR
   runs, but its text is nested inside the picture item and the Markdown exporter drops it —
   leaving `<!-- image -->` (14 chars). Non-empty, so the global `< 10 chars` guard does not catch it.
2. **Wrong-script decode.** Some native-text PDFs (BNP 2018 statements in the archive) have a text
   layer whose ToUnicode CMap is broken; Docling's decode came back as Hangul syllables while
   pypdfium reads the same file cleanly. Non-empty and prose-*scored* poorly only by accident, so
   neither the empty guard nor the mid-word-capitalization detector catches it — a script check does.

The gate also reuses the corpus-calibrated prose/corruption signals (`scoreTextQuality`,
`isLikelyCorruptedText`), audits tables (`auditMarkdownTables` — a majority-ragged table is
mis-reconstructed), and when the normal chain's raw text is already in hand (measurement harness)
applies a content-recall floor so Docling cannot *lose* tokens the existing extraction found.

Every threshold is deliberately conservative: a false rejection just falls back to the normal
chain (correct output, one wasted HTTP call); a false acceptance would silently overwrite good text
with Docling garbage.

## Running it

The client expects an HTTP endpoint implementing `POST /extract` (raw file bytes +
`X-File-Name` header → `{ markdown, text?, numpages, checksum?, engine? }`). Docling is a Python
stack, so it runs out of process — the same way `paddleocr-server` or the Dockerized extract
service do. The service is its own **separate project**: `/home/daihu/__projects__/markdown-extract-service`
(own git repo; `docling_pipeline.py` = converter factory shared with the Docker build warm-up,
`main.py` = HTTP server, docling 2.125.0 pinned). It is extension-routed — `.pdf` gets the layout +
tableformer + RapidOCR PP-OCRv6 `fr` pipeline, office formats get Docling's native readers (no
OCR) — and serves the same handler under both `POST /extract` (what `docling-remote.ts` calls) and
`POST /to-markdown` (the cleaner name from the service-split plan).

### Docker (recommended) — from the service project

```bash
cd /home/daihu/__projects__/markdown-extract-service
docker compose up -d --build                   # listens on 127.0.0.1:3984
curl http://127.0.0.1:3984/health
```

Its `Dockerfile` bakes the ~500 MB layout/table models at **build time** (the pipeline warm-up runs
before `main.py` is COPYed), so runtime never touches the network and editing `main.py` does not
re-download models. Dev iterations instead run the server against the same venv that produced the
`.spike` measurements:

```bash
cd /home/daihu/__projects__/markdown-extract-service
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export HF_HOME=/writable/cache/hf XDG_CACHE_HOME=/writable/cache   # first run only
python main.py                                                      # 127.0.0.1:3984
```

Then point the app at it (`.env`):

```dotenv
DOCLING_SERVICE_URL=http://127.0.0.1:3984
```

- **Env unset** → Docling never runs; extraction is byte-identical to before.
- **Service down / gate rejects** → throttled WARN (once / 30 s), normal chain runs unchanged —
  documents never strand.
- **`DOCLING_SERVICE_REQUIRED=1`** → a Docling failure (down OR gate-rejected) is a hard error per
  file instead of a fallback.
- **Office files**: the service accepts `.docx/.xlsx/.pptx/.html/.md/.txt`, but the app only sends
  `.pdf` today. Routing office files through Docling is roadmap step 2 of
  [service-split-plan.md](service-split-plan.md) (opt-in behind `DOCLING_ROUTE_OFFICE=1`); legacy
  `.doc` is unsupported by Docling and stays on the flat branch.

## Verification

- `src/domain/docling-quality.test.ts` — gate accept/reject incl. both silent-failure classes,
  the content-recall floor, and the Markdown→text projection.
- `src/infrastructure/pdf-extractor-docling-routing.test.ts` — adopt on gate pass, fall back on
  gate reject / unreachable service, `DOCLING_SERVICE_REQUIRED=1` hard errors, and non-PDF files
  bypassing the layer. (These tests pin `PDF_EXTRACT_SERVICE_URL=''` explicitly: `settings.ts` runs
  `dotenv.config()` against the gitignored `.env`, which sets the live service URL — merely deleting
  the key would let dotenv re-inject it and silently turn every "in-process fallback" assertion into
  a remote call.)
- End-to-end Step C comparison harness (spike): `.spike/run-e2e.ts` runs the real pipeline both
  ways (Step C LLM over Docling text vs Docling Markdown as `markdown_content`) on archived PDFs
  and compares content recall, the pre-registration quality gate and the resulting category.
