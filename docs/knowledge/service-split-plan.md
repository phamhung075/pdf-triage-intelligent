# 🔀 Service Split Plan — img→PDF packaging + file→Markdown extraction

> **Status: Service B DEPLOYED as its own project (step 1), Service A DESIGNED + SPIKED only.**
> Service B now lives in a **separate git repo**: `/home/daihu/__projects__/markdown-extract-service`
> (code + Dockerfile + own docker-compose.yml on :3984, models baked at build). App-side PDF
> routing is unchanged from the already-measured Docling wiring (the app only ever sent `.pdf`);
> office-file routing is step 2 below, not yet wired. Service A was spike-proven (7/7 byte parity)
> but is intentionally NOT wired — see decision 1. The working spikes are recorded in
> `.spike/split-spike-report.md`.

## One-line summary

Two optional services behind the same opt-in/fallback philosophy as `pdf-extract`:
a **thin raster→A4 PDF packaging** service (Service A) and a **Docling file→Markdown** service
(Service B). Service B is the high-value one — it already exists in prototype form as the Docling
sidecar (`DOCLING_SERVICE_URL` seam); this plan extends it to office files and formalises it.
Service A is deliberately thin (pure assembly) and only pays off if more of the vision pipeline
later moves out too.

## Why these two, in the user's words

> "I want to split to microservices: one to convert img to pdf, another one for extraction of pdf
> or other files to markdown."

Decisions confirmed with the user (2026-09-04):

| Question | Decision |
| --- | --- |
| Scope now | **Design doc + spike both seams** — no full wiring yet |
| Where Markdown comes from | **Docling inside the service**; when Docling fails the gate, fall back to the existing flat-text chain and let the app's Step C LLM pass rebuild Markdown (today's behavior) |
| What the image service owns | **Pure raster→A4 packaging only** — no vision/OCR; the app keeps orient/crop/enhance/OCR because those steps produce the page text that must come back with the PDF |
| Fallback model | **Same as `pdf-extract`**: env-gated, in-process fallback on unreachable service, `_REQUIRED=1` hard-fail, unconfigured = byte-identical behavior |

## Target architecture

```
                          ┌─────────────────────────────────────────────────────────────┐
                          │  main pdf-triage app (web, watcher, classify, DB, SSE)      │
                          │                                                             │
  photo in __raws ──────► │  vision pipeline: orient → crop → enhance → OCR (stays here)│
                          │   produces pageJpeg (per page) + rawText (in memory)        │
                          │        │                                                     │
                          │        ▼  POST /pdf-from-pages (N JPEG pages, doc order)     │
                          │   Service A: raster→A4 packaging  ───────────────► A4 PDF    │
                          │        │  (pure pdf-lib assembly, fitImageToA4)              │
                          │        ▼  PDF archived; text already in hand                 │
                          │                                                             │
  pdf / docx / xlsx ... ─► │  extractPDFContent() routing seam                           │
   in __raws               │    DOCLING_SERVICE_URL set ──► Service B: Docling file→Markdown
                          │        │  POST /to-markdown (any supported file)             │
                          │        ▼  { markdown, text, raw_text, numpages }             │
                          │   app-side gate assessDoclingMarkdown()                      │
                          │    pass ──► raw_text + markdown adopted (Step C skipped)     │
                          │    fail / down ──► existing chain: pdf-extract HTTP or       │
                          │                  in-process flat text → Step C LLM markdown  │
                          └─────────────────────────────────────────────────────────────┘
```

All three extraction transports (in-process, `pdf-extract` HTTP, Docling HTTP) already funnel
through the single `extractPDFContent()` seam (`infrastructure/pdf-extractor.ts`). Service B
reuses that seam unchanged for PDFs; the only *new* wiring (later, if approved) is letting
office files (docx/xlsx…) route to B too, and pointing the photo pipeline's assembly call at A.

## Service A — raster→A4 PDF packaging (`raster-pdf`)

### Ownership (deliberately narrow)

Assemble N already-processed JPEG page rasters into ONE A4 PDF: embed → `fitImageToA4`
(`domain/pdf-page-fit.ts`) → page → draw. That is the entire current job of
`buildPdfFromPages()` in `application/convert-image-document.ts` — ~15 lines of pdf-lib.

Everything heavier stays app-side **on purpose** (user decision): orientation/crop/enhance and OCR
run *before* assembly and their output (the page text) must travel back with the PDF — the app
skips re-extraction because the text is already in hand. Moving those steps out would require the
service to return text per page and the app to trust a second OCR engine's output; that is a
bigger, quality-sensitive change, parked in [Roadmap](#roadmap).

### HTTP contract (spike-verified shape)

| Endpoint | Method | Body | Response |
| --- | --- | --- | --- |
| `/health` | GET | — | `{ status, service, pid, uptimeSec }` |
| `/pdf-from-pages` | POST | JSON `{ pages: [{ name?, dataBase64 }] }` — array order = page order; every page a JPEG (the same `pageJpeg` the pipeline produces today) | `200 application/pdf` |

Production notes (from the spike, not yet applied): use `multipart/form-data` (one part per page,
matching the app's PaddleOCR client style) instead of JSON+base64 to avoid the 33 % bloat and a
512 MB JSON parse; keep a body-size cap and an `X-Pages` response header.

### Spike evidence (real photos, `.spike/raster-pdf-spike.ts`)

All 6 real source photos parked in `__raws/.delete_files/img_converted/`, re-encoded the way the
pipeline does (`encodeJpeg` q85), assembled in-process **and** via the service:

- **7/7 byte-identical** — 6 single-photo PDFs and the 6-photo multi-page bundle (natural order)
  came back with exactly the in-process bytes.
- pdf-lib output is deterministic (double in-process build check passed), so byte parity is a
  sound gate. A golden byte test is therefore viable as CI parity protection.
- A4 orientation follows the raster (portrait photo → `595.28×841.89`, landscape → `841.89×595.28`).
- Service latency 7–38 ms/call; bundle (1.15 MB PDF) in 38 ms — the seam is negligible cost.

### Deployment / risks

- Image is tiny (node + pdf-lib only — no tesseract, no canvas). Must **pin the same pdf-lib
  version** as the app or byte parity silently breaks; the parity test catches it.
- The current Docker pattern (`COPY src ./src` + whole-tree `tsc`) ships far more than the ~15
  assembly lines need — for a service this small, either bundle just the packaging graph or accept
  the fat image. See the [shared codebase trade-off](#shared-codebase-slice-vs-standalone-package).
- **Honest value call**: alone, Service A buys isolation and a reusable endpoint for other
  consumers, but its real payoff comes with the roadmap step that also moves the vision steps.

## Service B — Docling file→Markdown (`docling-markdown`)

### Ownership

Deterministic, layout-aware **Markdown** for PDFs **and native office formats**, produced by a
Docling service. Two deliberate boundaries:

1. **The quality gate stays app-side.** `assessDoclingMarkdown()` (`domain/docling-quality.ts`) is
   pure TypeScript calibrated on this repo's failure classes (whole-page-picture, mojibake, ragged
   tables, content loss). It runs in the app after the service responds — the service never decides
   whether its own output is acceptable, and no gate logic is duplicated in Python.
2. **The LLM Step C pass stays app-side.** When Docling is rejected or unreachable, the app falls
   back to the current chain (flat text → qwen3.5:9b chunked zero-loss Markdown). Service B is
   therefore deterministic and cheap; the LLM remains the safety net, not the primary path.

This is the existing Docling sidecar (`.spike/docling_http_service.py`, PDF-only, `POST /extract`)
grown into the file→Markdown service: extension routing for office files and a contract whose
headline field is `markdown`.

### HTTP contract (spike-verified shape)

| Endpoint | Method | Body | Response |
| --- | --- | --- | --- |
| `/health` | GET | — | `{ status, service }` |
| `/to-markdown` | POST | raw file bytes + `X-File-Name` (URI-encoded; extension routes the pipeline) | `200` → `{ checksum, markdown, text, raw_text, numpages, info?, engine }` |

Extension routing (spike scope): `.pdf` → Docling PDF pipeline (Heron layout + TableFormer + RapidOCR
PP-OCRv6 fr, identical to today's sidecar); `.docx .xlsx .pptx .html .md .txt` → Docling native
readers (no OCR, no layout models — reads the file's own structure). Anything else → `415`.

Note: `numpages` is only meaningful for PDFs — Docling native conversions reported `0`
(`doc.num_pages()`); the app must not treat 0 as an error for office files.

### Spike evidence (real docs, `.spike/markdown-service-check.ts`)

| File | Engine | Gate | Docling recall* | Stored Step C recall* | Docling tables | Stored tables | Time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Contrat PROTEK SAS.docx (archived) | docling-native | ✅ | **0.976** | 0.926 | 0 | 1 (false) | 127 ms |
| DC_ARCESI_Agence_trigramme.docx (archived) | docling-native | ✅ | 0.984 | 0.988 | 0 | 0 | 696 ms |
| AISF papier scan (6 pp, scanned) | docling-pdf | ✅ | 0.974 | 1.000 | **5 blocks / 64 rows** | 0 | 36 s |

\* `measureContentRecall` vs the same flat-text baseline the app used (fresh in-process docx
extraction for the docx; stored OCR text for the scanned PDF). Recall ≈ the distinct-content tokens
present in the Markdown vs the baseline.

Readings:

- **Docx native is fast and faithful.** 127–696 ms, no model download, gate pass. Recall equal or
  better than the stored Step C output on the same source.
- **Docling does not hallucinate structure.** Neither docx contains a real Word table (0 `w:tbl`
  in the XML), and Docling exported zero — while the stored Step C markdown for the contract
  *invented* a 2-row table from tab-looking prose. This is the same class of silent fabrication the
  docling gate was built to keep out; Docling itself doesn't do it on native formats.
- **Scanned PDFs still cost real time** (36 s / 6 pages) and Docling's OCR differs from PaddleOCR
  (recall 0.974 vs Step C 1.0 against the *PaddleOCR-derived* baseline — token drift between OCR
  engines, not loss), but the output carries genuine tables (5 blocks/64 rows) where the stored
  markdown has none, and the gate passes. The existing fallback logic already handles this class:
  PDFs where Docling's OCR reads worse get caught by the app-side recall floor.
- xlsx/pptx/html paths are supported by the same native reader but **untested on real files** (no
  such file exists in the archive) — flagged as a gap before production wiring.

### Deployment / risks

- Python image; models are large (~500 MB, HF hub + RapidOCR onnx). Reuse the model-load and
  cache-layout learnings from `.spike/docling_http_service.py` (warm-up before serving,
  writable `HF_HOME`/`XDG_CACHE_HOME`, onnx bundled in the venv). A Docker image should bake or
  volume the cache, mirroring how the extract image bakes tesseract data at build time.
- Personal-data hygiene: the contract is raw bytes over loopback, temp files unlinked after each
  request, nothing persisted server-side — same trust model as `pdf-extract`/PaddleOCR.
- Contract drift between the Python service and the TS client is guarded only by tests; consider a
  shared contract test (`docling-remote.ts` shape asserted against a live service) before wiring.

## Routing / fallback design (unchanged philosophy)

| Condition | Behavior |
| --- | --- |
| `DOCLING_SERVICE_URL` unset | Everything as today — byte-identical. |
| B set, PDF, gate passes | Docling text + `docling_markdown` adopted; Step C skipped (already wired today). |
| B set, PDF, gate fails / B down | Throttled WARN → existing chain (pdf-extract remote or in-process → Step C). `_REQUIRED=1` → hard error. |
| **B set, office file (new)** | Route docx/xlsx through B first; gate decides; fallback = today's flat-text docx/xlsx branch → Step C. |
| A set (photo pipeline) | `buildPdfFromPages` call replaced by `POST /pdf-from-pages`; on failure, fall back to in-process assembly (never strand the photo). |
| A/B unreachable | WARN once/30 s + in-process fallback; `_REQUIRED=1` per service turns fallback into hard error. |

## Ports / compose

| Service | Port | Env (app side) | Image | Status |
| --- | --- | --- | --- | --- |
| pdf-extract (existing) | 3981 | `PDF_EXTRACT_SERVICE_URL` | `pdf-triage/pdf-extract` (Dockerfile.extract-service) | live (in-repo compose) |
| markdown-extract (B) | 3984 | `DOCLING_SERVICE_URL` (existing seam) | `markdown-extract-service:latest` | shipped — separate repo `/home/daihu/__projects__/markdown-extract-service`, own compose there |
| raster-pdf (A) | 3983 | `IMAGE_PDF_SERVICE_URL` (name fixed by decision 3) | `Dockerfile.raster-pdf` (not written) | deferred to roadmap step 3/4 |

Service B reuses the already-shipped `DOCLING_SERVICE_URL`/`DOCLING_SERVICE_REQUIRED`/`_TIMEOUT_MS`
config (`infrastructure/settings.ts`, `.env.example`) — extending it to office files is a routing
decision in `extractPDFContent()`, not new configuration. Service A needs a new config block
mirroring the pattern.

## Shared codebase: slice vs standalone package

Today `extract-service` is compiled from the whole `src/` tree (`COPY src ./src` + `tsc`), so its
image carries code it never runs, and any edit anywhere rebuilds it. For two *more* services this
question becomes material:

- **Slice (current pattern)** — service imports `domain/pdf-page-fit.ts` etc. from the same tree.
  Cheapest, keeps one source of truth for geometry, but fat images and full-tree rebuilds.
- **Standalone package/bundle** — each service ships only its own graph (esbuild/tsup), pinned
  deps, with a parity/golden test proving equivalence (the spike proved byte-parity is achievable
  and deterministic, which makes this safe). Cleaner long-term; more plumbing now.

Recommendation: **bundle Service A** (it is ~15 lines — a fat image is absurd for it) and keep
Service B as its own Python image; revisit the extract-service image separately.

## Roadmap

1. **Ship B as-is — DONE (2026-09-04), since extracted to its own repo (2026-09-04).** The service
   started as `docling-markdown-server/` in this repo, then moved to the standalone project
   `/home/daihu/__projects__/markdown-extract-service` for independent development. It answers
   `POST /extract` (what `docling-remote.ts` calls) and `POST /to-markdown`; extension-routed:
   `.pdf` → layout + table + RapidOCR pipeline, `.docx/.xlsx/.pptx/.html/.md/.txt/.asciidoc` →
   Docling native readers, anything else → `415`. Its Dockerfile bakes the models at build; its own
   compose publishes :3984 with a healthcheck. App behavior byte-identical: the app still only
   offers `.pdf`, gate app-side. Smoke-tested on the `.spike` venv (docling 2.125.0) on a real docx
   (native, 8793 chars — deterministic) and a real PDF (pdf pipeline).
2. **Route office files through B** (opt-in) — the spike shows docx native is fast and more
   faithful than flat-text → Step C for docx. Env `DOCLING_ROUTE_OFFICE=1`; only `.docx` is routed
   first (decision 4); legacy `.doc` is unsupported by Docling and stays flat. Wire in
   `extractPDFContent()`/`tryDoclingExtraction` (currently PDF-only) + routing tests.
3. **Export `buildPdfFromPages` and add Service A** with a golden byte-parity CI test; wire
   `convertImageToPdf`/`convertImageFolderToPdf` behind `IMAGE_PDF_SERVICE_URL` with in-process
   fallback.
4. **Optional later: move the vision steps (orient/crop/enhance/OCR) next to A** — the only change
   that makes A genuinely valuable. Requires extending the contract so page text returns with the
   PDF, and re-validating quality across the photo corpus (the photo→text quality invariants in
   `convert-image-document.ts` headers must survive the move).

## Decisions (positions taken 2026-09-04)

1. **Service A: fold into step 4 — do NOT wire it alone.** Spike-proven (7/7 byte parity, ~17 ms)
   but with the vision pipeline app-side it would move ~15 lines of pdf-lib across a network hop
   for no quality or isolation gain. The spike code stays in `.spike/` and step 3 is dormant until
   step 4 makes it worthwhile.
2. **Office routing: opt-in, not the default.** Enabling `DOCLING_SERVICE_URL` today must not
   silently change how docx/xlsx are handled — those currently produce stable, registered output.
   Step 2 sits behind `DOCLING_ROUTE_OFFICE=1`.
3. **Service A payload (when built): `multipart/form-data`** (one part per page — matches the app's
   PaddleOCR client style and avoids the 33 % base64 bloat and giant JSON parse of the spike);
   env name `IMAGE_PDF_SERVICE_URL` (+ `_REQUIRED` / `_TIMEOUT_MS` mirroring `pdf-extract`).
4. **Ship xlsx/pptx/html support in the service, restrict app-side routing to `.docx`.** The
   service already accepts the full native set (cheap, no OCR) — but the app must not route a
   format to Docling until a real corpus sample proves the gate + recall behave (no xlsx/pptx/html
   exists in the archive today). `.doc` (legacy binary) is never routed — Docling cannot read it.
5. **B's models: baked at build time** (the service project's Dockerfile runs the pipeline warm-up
   before COPYing `main.py`, so edits never re-download the ~500 MB; runtime offline — same rule as
   the tesseract data in `Dockerfile.extract-service`). A volume mount remains the documented dev
   alternative for iterating on `docling_pipeline.py` itself.

## Verification for the eventual wiring

- `raster-pdf` — golden byte-parity test (in-process `buildPdfFromPages` vs service output over the
  real photo set), page-dimension assertions, unreachable → fallback, `_REQUIRED=1` hard error.
- `docling-markdown` — extend `pdf-extractor-docling-routing.test.ts` to office files; live-service
  contract test asserting the `docling-remote.ts` response shape; keep the full `npm test` +
  typecheck green with every service env unset.
