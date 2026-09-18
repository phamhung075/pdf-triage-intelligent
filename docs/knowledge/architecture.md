# 🏛️ Architecture

## Document flow

How one file moves from `__raws` to `__archive`, verified against `application/triage-scan.ts`, `application/convert-image-document.ts`, `application/classify-document.ts`, `domain/classification-resolution.ts`, and `domain/taxonomy.ts`. See [triage-pipeline](../workflows/triage-pipeline.md) for the numbered step-by-step version this diagram summarizes.

```mermaid
flowchart TD
    A["File dropped into <code>__raws</code>"] --> B{"10s auto-watcher tick,<br/>manual Scan button, or <code>npm run scan</code>"}
    B --> C["runTriageScan walks __raws,<br/>one file at a time"]
    C --> D{"Image file?<br/>.jpg/.png/.webp/.bmp/.tiff"}

    D -- yes --> V1["Vision pipeline (convertImageToPdf):<br/>orient → crop → enhance → assemble A4 PDF"]
    V1 --> E["extractPDFContent"]

    D -- "no (PDF)" --> E

    E --> E1["pdf2w-remote.ts POST /convert<br/>self-hosted markdown-extract-service (pdf2w)<br/>native extraction + Gemini→DeepSeek vision-rescue OCR<br/>REQUIRED — unreachable = FILE_FAILED, no fallback"]
    E1 --> G{"clean text ≥ 10 chars?"}

    G -- no --> BLOCK1["BLOCK — NO_TEXT_EXTRACTED<br/>upsertBlockedFile, kept in __raws"]
    G -- yes --> H{"checksum already<br/>in SQLite?"}
    H -- yes --> SKIP["SKIPPED_DUPLICATE"]
    H -- no --> I["Step A — entity + doc-type extraction (Qwen)"]
    I --> J["Step C — chunked raw text →<br/>zero-loss GFM markdown (Qwen)"]
    J --> K["Step D — classify + summary +<br/>metadata, Step A entity as hint (Qwen)"]
    K -- "Ollama unhealthy / request failed /<br/>invalid JSON" --> RB["ruleBasedClassify —<br/>regex + entity_dictionary.json fallback"]
    K -- success --> L
    RB --> L["refineClassification"]
    L --> M["resolveCategory —<br/>match or auto-create category"]
    M --> N["resolveSubcategory —<br/>match or auto-create subcategory"]
    N --> O{"subcategory empty /<br/>general / other / divers /<br/>year-string?"}
    O -- yes --> BLOCK2["BLOCK — NO_SUBCATEGORY<br/>upsertBlockedFile, kept in __raws"]
    O -- no --> P["Auto-create category/subcategory in<br/>.categories.private.json BEFORE move"]
    P --> Q["insertDocumentRecord —<br/>SQLite + FTS5, status PENDING"]
    Q --> R["relocalizeFileIfNeeded (async) — canonical path from<br/>services/pdf-triage-pdf2w (Go, POST /canonical-path,<br/>REQUIRED), then move file to<br/>__archive/&lt;category&gt;/&lt;subcategory&gt;/&lt;YYYY&gt;/"]
    R --> S["updateDocumentRecord —<br/>new_path, status MOVED"]
    S --> T["syncJSONRegistry —<br/>mirror SQLite → registry.json"]

    BLOCK1 --> SSE["SSE broadcast:<br/>FILE_FAILED / FILE_COMPLETED / SCAN_COMPLETED"]
    BLOCK2 --> SSE
    SKIP --> SSE
    T --> SSE
    SSE --> DASH["Dashboard live-updates<br/>via /api/triage/events"]
```

Notes:
- The image branch (orient → crop → enhance → assemble, `application/image-to-pdf.ts`) feeds into the **same** classification path as PDFs from `E` onward — a photo is never classified or OCR'd differently from a scanned document, only assembled into a PDF first. Text for both comes from the same `extractPDFContent()` → pdf2w call; there is no separate OCR step for photos anymore. See [pdf2w-extraction.md](./pdf2w-extraction.md#photo-pipeline-change--no-local-ocr).
- `BLOCK1`/`BLOCK2` are terminal: no DB row, no move, no auto-create. The file stays in `__raws` and is skipped on future ticks via the `blocked_files` skip-cache until it changes (see [triage-pipeline](../workflows/triage-pipeline.md)).
- Golden Rule #4 is enforced at node `O`.

## Module map

```
src/
├── index.ts                              # Dispatcher: default web, `scan`, `mcp` (composition root)
├── domain/
│   ├── document.schema.ts                # Zod contracts (validation only)
│   ├── classification.ts                 # ruleBasedClassify + fallback classifier logic
│   ├── prompt.ts                         # Qwen system/user prompt building
│   ├── classification-resolution.ts      # refineClassification, resolveCategory, resolveSubcategory
│   ├── taxonomy.ts                       # isYearString, isForbiddenSubcategory, isPathInsideDir, detectFileType, findCanonicalCategoryForSubcategory, mergeSubcategoryInTaxonomy (computeCanonicalPath moved to services/pdf-triage-pdf2w/, see pdf2w-extraction.md)
│   ├── pdf-text.ts                       # cleanExtractedText
│   ├── pdf-page-fit.ts                   # fitImageToA4 — pure page geometry for photo→PDF pages
│   ├── flood-crop.ts                     # barrier-map document-boundary detector + crop admissibility (pure)
│   ├── image-adjust.ts                   # auto-levels / sharpen math
│   ├── exif-orientation.ts               # EXIF Orientation tag parsing
│   └── path-conversion.ts                # windowsToWslPath / wslToWindowsPath / isWslMountPath (pure)
├── application/
│   ├── classify-document.ts              # classifyPDFText (orchestrator)
│   ├── triage-scan.ts                    # runTriageScan
│   ├── convert-image-document.ts         # convertImageToPdf — photo → archivable A4 PDF + its OCR text
│   ├── image-to-pdf.ts                   # Vision Lab steps: runOrientStep/runCropStep/runEnhanceStep/runExtractStep
│   ├── repair-registry.ts                # repairRegistry
│   ├── relocalize-document.ts            # relocalizeFileIfNeeded, moveBackToRaws, reclassifyAndRelocalizeDocument
│   ├── clear-registry.ts                 # clearRegistryAndMoveArchiveToRaws
│   └── scan-lock.ts                      # acquireScanLock (cross-process lock)
├── infrastructure/
│   ├── settings.ts                       # CONFIG + settings.json load/save
│   ├── os-open.ts                        # the ONLY module allowed to launch Explorer/Chrome (WSL-safe)
│   ├── logger.ts                         # Color terminal + file logs
│   ├── categories-store.ts               # getCategoriesConfig / saveCategoriesConfig
│   ├── entity-dictionary-store.ts        # getEntityDictionary
│   ├── ollama-client.ts                  # ensureOllamaModel, checkModelCanGenerate, generateEmbedding
│   ├── pdf2w-remote.ts                   # extractPdf2wContent — HTTP client for the required, self-hosted markdown-extract-service (pdf2w)
│   ├── canonical-path-remote.ts          # computeCanonicalPathRemote — HTTP client for the required services/pdf-triage-pdf2w Go service
│   ├── pdf-extractor.ts                  # extractPDFContent() — delegates to pdf2w-remote.ts, plus SHA-256 checksum
│   ├── pdf-scanner.ts                    # getPDFsRecursively, getAllFilesRecursively
│   ├── pid-lock.ts                       # shared PID-lock-file helper + killProcessOnPort (cross-directory port takeover)
│   ├── json-registry.ts                  # SQLite → registry.json mirror
│   ├── db/database.ts                    # SQLite open, schema init, CRUD, FTS5
│   ├── http/web-server.ts                # Express + SSE + REST + 10s watcher
│   └── mcp/mcp-server.ts                 # MCP tools over stdio
public/                                   # UI (index.html, app.js, style.css)
```

## Ownership boundaries

| Module                                                                                                              | Owner agent                                                  | May write to                              |
| --------------------------------------------------------------------------------------------------------------------| ---------------------------------------------------------------| -------------------------------------------|
| `domain/classification.ts`, `domain/prompt.ts`, `domain/classification-resolution.ts`                              | classification-expert                                          | itself                                     |
| `application/classify-document.ts`                                                                                  | classification-expert                                          | itself, categories.json                    |
| `infrastructure/categories-store.ts`                                                                                | classification-expert                                          | itself, categories.json                    |
| `infrastructure/entity-dictionary-store.ts`                                                                         | classification-expert                                          | itself, entity_dictionary.json             |
| `infrastructure/pdf-extractor.ts`                                                                                   | pipeline-engineer                                               | itself                                     |
| `domain/taxonomy.ts`, `domain/pdf-text.ts`                                                                          | pipeline-engineer                                               | itself                                     |
| `application/triage-scan.ts`, `application/repair-registry.ts`, `application/relocalize-document.ts`, `application/clear-registry.ts`, `application/scan-lock.ts` | pipeline-engineer | itself, uses DB + AI |
| `infrastructure/json-registry.ts`                                                                                   | db-registry-keeper                                              | itself, registry.json                      |
| `infrastructure/db/database.ts`                                                                                     | db-registry-keeper                                              | itself, pdf_triage.db                      |
| `domain/document.schema.ts`                                                                                         | classification-expert (data) + db-registry-keeper (records)    | itself                                     |
| `infrastructure/http/web-server.ts`                                                                                 | pipeline-engineer                                               | itself                                     |
| `infrastructure/mcp/mcp-server.ts`                                                                                  | mcp-integrator                                                  | itself                                     |
| `public/*`                                                                                                          | ui-frontend                                                     | itself                                     |
| Ollama connectivity                                                                                                 | ollama-ops                                                      | infrastructure/ollama-client.ts (limited)  |

Cross-module edits: do them, but ping [qa-reviewer](../agents/qa-reviewer.md) via a review pass.

## Layering (domain / application / infrastructure)

`src/` is organized into three layers, each with a one-way dependency rule:

- **`src/domain/`** — pure logic, zero I/O. No `fs`, no network calls, no reading
  `CONFIG` or environment variables. Functions take data as parameters and return
  data. Includes classification rules (`classification.ts`), Qwen prompt building
  (`prompt.ts`), category/subcategory resolution (`classification-resolution.ts`),
  taxonomy/path helpers (`taxonomy.ts`), text cleanup (`pdf-text.ts`), and the Zod
  schemas (`document.schema.ts`).
- **`src/application/`** — orchestration ("use cases"). Fetches data via
  infrastructure, calls domain functions to decide what to do, calls infrastructure
  again to persist or act. This is where `classifyPDFText`, `runTriageScan`,
  `repairRegistry`, the relocalize/clear-registry flows, and the cross-process
  scan lock live.
- **`src/infrastructure/`** — all I/O adapters: SQLite (`db/database.ts`), the
  filesystem-backed settings/categories/entity-dictionary/JSON-registry stores,
  the Ollama client, the PDF extractor/scanner, the shared PID-lock helper, the
  Express HTTP server (`http/web-server.ts`), and the MCP stdio server
  (`mcp/mcp-server.ts`).

Dependency direction: `infrastructure/` and `application/` may import from
`domain/`; `domain/` never imports from the other two. `application/` may
import from `infrastructure/`. The two inbound adapters —
`infrastructure/http/web-server.ts` and `infrastructure/mcp/mcp-server.ts` —
import application use-cases to serve requests; no other infrastructure
module imports from `application/`. `src/index.ts` is the composition root
that wires everything together at startup.

This structure exists so the pure decision logic (which category, which
subcategory, is this slug grounded, what canonical path) can be unit-tested
without mocking `fs`/`CONFIG`/Ollama — see
`docs/superpowers/specs/2026-07-31-test-harness-design.md` (Phase 1) and
`docs/superpowers/specs/2026-07-31-ddd-restructure-design.md` (Phase 2, this
restructuring).

## Server startup and port takeover

Two independent layers guard `startWebServer` (`http/web-server.ts`) and `startVisionLabServer` (`vision-lab-server.ts`) against colliding with another running instance. They catch two different failure modes and are not redundant with each other:

1. **Same-directory single-instance lock** — `acquireSingleInstanceLock()` in `web-server.ts`, built on `readActiveLockHolder`/`acquireProcessLock` from `infrastructure/pid-lock.ts`. Writes this process's PID to `<BASE_DIR>/.server.lock` and refuses to start a second instance from the *same* `BASE_DIR` (e.g. a stale `tsx watch` child that hasn't exited yet, still running alongside a freshly spawned one). Each directory has its own `.server.lock`, so this lock is blind to a stale instance running from a *different* directory (e.g. a git worktree) — even one still squatting on the same TCP port. Unchanged by the port-takeover work; still Vision-Lab-agnostic (`startVisionLabServer` doesn't call it).
2. **Cross-directory / OS-level port takeover** — `killProcessOnPort(port)`, new in `infrastructure/pid-lock.ts`. `startWebServer`/`startVisionLabServer` each split into a `startXServer` + `attemptListen(port, allowTakeover)` pair. On `EADDRINUSE`, `attemptListen` calls `killProcessOnPort(port)` — which shells out to `netstat -ano -p tcp` to find the PID `LISTENING` on the port and force-kills it via `taskkill /PID <pid> /F` (Windows only) — waits ~500ms for the OS to release the socket, then retries binding exactly once, with takeover disabled on that retry so a port that genuinely can't be freed fails fast instead of looping. This layer always kills whatever holds the port, with **no check** that it's a previous instance of this same app — a deliberate simplicity tradeoff, not an oversight (see `docs/superpowers/specs/2026-08-24-dev-server-port-takeover-design.md`).

> A third layer used to live here — a takeover routine for the local PaddleOCR sidecar Python
> process. It was removed along with `paddleocr-server/` and `infrastructure/paddleocr-client.ts`
> (see [pdf2w-extraction.md](./pdf2w-extraction.md)): extraction and OCR are now both external HTTP
> calls to pdf2w, not a local process `startWebServer` needs to manage or restart.

Why both layers exist: a worktree-launched instance kept running and squatted on the dev port; every later `npm run dev` from `main` silently failed to start (layer 1 can't see the cross-directory conflict) while a user unknowingly kept looking at the stale instance's dashboard — wrong `BASE_DIR`, near-empty data, looked like "all documents lost" when nothing had actually been touched. Layer 2 closes that gap by making the newer `npm run dev` win automatically instead of requiring a manual PID hunt.

## Data flow (steady state)

1. `infrastructure/http/web-server.ts` boots, static-serves `public/`, opens SSE endpoints, starts the 10 s auto-watcher.
2. Auto-watcher calls `runTriageScan(broadcast, () => scanAbortRequested)` (`application/triage-scan.ts`)
   when `__raws` has PDFs.

   **Serialization.** `acquireScanLock()` (`application/scan-lock.ts`) guards the whole run. It
   tracks in-process ownership *separately* from the `.scan.lock` file, because `readActiveLockHolder`
   deliberately reports "free" when the file holds this same PID — so the file alone could never
   stop a second scan starting inside one process. That is exactly what happened when the user
   pressed Stop (which cleared the in-memory flag without cancelling the running loop) and then
   Scan again: two loops walked the same `__raws` listing, one moved a file to `__archive` between
   the other's directory read and its `statSync`, and the loser of a classify race hit
   `UNIQUE constraint failed: documents.checksum` and shunted an already-archived document into
   `.duplicates_files`. The release function is idempotent for the same reason — a stale handle
   must not delete a lock a later run now owns.

   **Cancellation.** `runTriageScan` polls `shouldAbort` once per file. `POST /api/triage/unlock`
   ("Stop") sets that flag; before it existed, Stop only dropped the re-entry guard and the loop
   ran to completion underneath the user.
3. `runTriageScan` walks `__raws`, for each PDF **or photo**:
   - **Photos only** — `convertImageToPdf()` (`application/convert-image-document.ts`) runs the vision pipeline
     (orient → crop → enhance → assemble), writes an image-only A4 PDF beside the photo, moves the photo to
     `__raws/.delete_files/img_converted/` once that PDF is on disk (it is never deleted — the PDF holds a cropped,
     re-encoded rendition), and calls `extractPDFContent()` on the assembled PDF for its text — the same call
     every other PDF makes below. `originalPath` is re-pointed at the PDF.
   - `extractPDFContent()` (`infrastructure/pdf-extractor.ts`) → `{checksum, raw_text, numpages, info}`.
     A single required HTTP call (`infrastructure/pdf2w-remote.ts`, `POST /convert`) to the self-hosted
     `markdown-extract-service` (pdf2w): native PDF text/table extraction, with pdf2w's own
     Gemini→DeepSeek vision-rescue OCR firing server-side for scanned or image-only pages. There is no
     in-process extraction tier, no local OCR engine, and no fallback — an unreachable or misconfigured
     `PDF2W_SERVICE_URL` throws, and that file is `FILE_FAILED`. See
     [pdf2w-extraction.md](./pdf2w-extraction.md).
   - Dedup check via `getDocumentByChecksum(checksum)`.
   - `classifyPDFText()` (`application/classify-document.ts`) → validated `DocumentMetadata`.
   - `insertDocumentRecord()` → SQLite + FTS5.
   - `relocalizeFileIfNeeded()` (`application/relocalize-document.ts`, `async`) → computes the canonical path
     via the required Go service (`infrastructure/canonical-path-remote.ts`, `POST /canonical-path`) and moves
     the file there. Unreachable or misconfigured `CANONICAL_PATH_SERVICE_URL` throws, and that file is
     `FILE_FAILED` — see [pdf2w-extraction.md](./pdf2w-extraction.md).
   - `updateDocumentRecord(id, { new_path, status: 'MOVED' })`.
   - `syncJSONRegistry()`.
4. SSE clients receive `FILE_PROGRESS`, `FILE_COMPLETED`/`FAILED`, then `SCAN_COMPLETED`.
5. UI subscribes to `/api/triage/events` and repaints pills + cards live.

## MCP path

`src/infrastructure/mcp/mcp-server.ts` exposes tools (`search_documents`, `get_full_document_text`, `update_document_metadata`, `trigger_triage`, `list_categories`) over stdio. Runs as a separate process (`npm run mcp`); shares the SQLite DB and categories.json but does NOT bring up the web server.

## SQLite tables

- `documents` — the record of truth (see [data-model](./data-model.md)).
- `documents_fts` — FTS5 virtual mirror for search. May not exist if the SQLite build lacks FTS5; all writes are wrapped in try/catch.
- `categories_db` — legacy scaffold table; the taxonomy source of truth is the JSON file `categories.json`, not this table.

## Config resolution order (highest wins)

1. `settings.json` (project-local, editable via Settings modal or `PUT /api/config`).
2. Environment variables (`PDF_INPUT_DIR`, `PDF_OUTPUT_DIR`, `PDF_REGISTRY_PATH`, `PDF_DB_PATH`, `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_EMBED_MODEL`, `PORT`).
3. Defaults in `src/infrastructure/settings.ts`.

## WSL path policy (Golden Rule #21)

This app runs on native Windows AND under WSL, and the two hosts need different path forms:

| Direction | Form | Where |
| --- | --- | --- |
| Config paths the app's fs reads/writes on WSL | `/mnt/<drive>/...` | normalized at load by `windowsToWslPath` (re-exported from `settings.ts`) |
| Paths handed to Windows programs (Explorer, Chrome) | `X:\...` | converted by `wslToWindowsPath` |

The two rules that caused real bugs before they were centralised:

1. A Windows-form path in `settings.json` (`\mnt\C:\Users\...`) made Node create literal backslash-named
   folders in the project root and scan empty stubs — "config cannot see files on Windows".
2. A POSIX `/mnt/...` path handed to `explorer.exe` made it silently open `C:\Users\<user>\Documents`.

**All OS launching** (file manager reveal/open, Chrome) goes through `src/infrastructure/os-open.ts`
— platform branching and the WSL→Windows conversion live there and only there. The hygiene test
`os-open.hygiene.test.ts` fails the build if an `explorer.exe` / `chrome.exe` / `xdg-open` literal
appears in any other source file. If you need a new "open X" button or tool, call
`revealInFileManager` / `openDirectory` / `openInChrome` from `os-open.ts` and spawn the returned
`{ cmd, args }` yourself.


## Threading model

Single-process Node event loop. No worker threads. Long tasks (Ollama call, PDF parse) are async I/O — the 50 ms yield between files keeps SSE and HTTP responsive.

## OCR engine fallback (removed — now pdf2w's responsibility)

Before the 2026-09-18 pdf2w extraction swap, `ocrPageBuffer` (`infrastructure/pdf-extractor.ts`)
tried **PaddleOCR** and dropped to **Tesseract** only when that call failed, with a `threading.RLock`
guarding the Python service's shared model global, a retry-once-on-5xx policy, a `/ready`-gated
warm-up wait, and a page-area-scaled timeout — see git history (`docs/superpowers/specs/2026-08-15-paddleocr-integration-design.md`)
for the full account, kept for archaeology rather than because any of it is still true.

**None of this exists anymore.** `paddleocr-server/`, `infrastructure/paddleocr-client.ts`, and
`domain/ocr-layout.ts` are deleted. OCR — for scanned PDFs and for photo-derived image-only PDFs
alike — happens entirely inside the external, self-hosted `markdown-extract-service` (pdf2w) via
its own Gemini→DeepSeek vision-rescue, invisible to pdf-triage beyond the `POST /convert` call in
`infrastructure/pdf2w-remote.ts`. There is no local engine to fall back between, no local lock to
manage, and no local timeout budget to tune — an unreachable pdf2w is simply `FILE_FAILED` for
that file. See [pdf2w-extraction.md](./pdf2w-extraction.md).

`ExtractedPDF.ocr_degraded` remains on the interface for backward compatibility (`relocalize-document.ts`
still reads it) but `extractPDFContent()` never sets it now — treat it as always `false`. See
[Which text a re-analysis uses](../workflows/relocalize.md#which-text-a-re-analysis-uses).

**Why the old lesson still matters, generally.** The overlapping-request/silent-downgrade failure
mode this section used to document (a scan mid-OCR on one document racing a user-triggered
re-analysis on another, with the loser silently getting worse text than what was already stored) is
a real class of bug in any pipeline with more than one text-quality tier. It just no longer lives in
this codebase, because there is only one extraction path left.
