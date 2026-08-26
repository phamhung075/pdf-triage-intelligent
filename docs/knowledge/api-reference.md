# 🔌 API Reference

Source: `src/infrastructure/http/web-server.ts`. Default port `3000`.

## System

| Method | Route                     | Description                                            |
| ------ | ------------------------- | ------------------------------------------------------ |
| GET    | `/api/dev/livereload`     | SSE stream. Emits `reload` on any `public/` change     |
| POST   | `/api/open-location`      | Body `{ targetPath }` → opens Windows Explorer         |
| POST   | `/api/server/restart`     | Exits the process (nodemon / tsx watch restarts it)    |

## Ollama

| Method | Route                | Description                                     |
| ------ | -------------------- | ----------------------------------------------- |
| GET    | `/api/ollama/status` | `{ online, model, host, modelsCount, modelExists }` |
| POST   | `/api/ollama/start`  | Auto-spawn `ollama serve`                       |

## Config

| Method | Route         | Description                                            |
| ------ | ------------- | ------------------------------------------------------ |
| GET    | `/api/config` | Returns current `input_dir`, `output_root_dir`, `ollama_model`, `ollama_host` |
| PUT    | `/api/config` | Body validated by `SystemSettingsSchema`; persists to `settings.json` |

## Categories

| Method | Route                          | Description                                       |
| ------ | ------------------------------ | ------------------------------------------------- |
| GET    | `/api/categories`              | Returns categories with live doc counts from DB (dynamically appends DB-only subcategories missing from `categories.json`) |
| PUT    | `/api/categories`              | Body validated by `CategoriesConfigSchema`; broadcasts `CATEGORIES_UPDATED` |
| POST   | `/api/subcategories/rename`    | `{ category, oldSubcategory, newSubcategory }` — renames slug + relocalizes every matching file on disk |

## Documents

| Method | Route                              | Description                                         |
| ------ | ---------------------------------- | --------------------------------------------------- |
| GET    | `/api/documents?q=&category=&subcategory=` | Filtered list                                |
| GET    | `/api/documents/:id`               | Single doc with full `raw_text`                     |
| PUT    | `/api/documents/:id`               | Update metadata (validated by `UpdateDocumentSchema`); auto-relocalizes on category/subcategory change |
| POST   | `/api/documents/:id/relocalize`    | Body `{ category?, subcategory?, reason? }` — re-classify (with feedback) and move |
| DELETE | `/api/documents`                   | **Clear Registry**: move `__archive` → `__raws`, purge DB (see [clear-registry](../workflows/clear-registry.md)) |

## Triage

| Method | Route                    | Description                                    |
| ------ | ------------------------ | ---------------------------------------------- |
| GET    | `/api/triage/events`     | **SSE stream** — see [sse-broadcast](../workflows/sse-broadcast.md) for event schema |
| POST   | `/api/triage/scan`       | Run a scan; broadcasts progress; returns final counts |
| POST   | `/api/triage/unlock`     | **Stop**: sets the abort flag the scan loop polls per file, clears the re-entry guard, and suppresses the auto-watcher for 60 s |
| POST   | `/api/registry/repair`   | Ghost purge + re-classify + relocalize + move-back |

`/api/triage/unlock` does not kill the run mid-file — `runTriageScan` checks the flag at each file
boundary and breaks, leaving the remaining files in `__raws` for the next scan. A second scan
started while one is still running is refused by `acquireScanLock()` (`ScanInProgressError`), not
silently allowed; see [architecture](architecture.md).

## PDF tools

| Method | Route             | Description                                                        |
| ------ | ----------------- | ------------------------------------------------------------------ |
| POST   | `/api/pdf/merge`  | Body `{ filepaths: string[] (≥2), outputFilename? }` — merges PDFs into one, written to `__raws` |
| POST   | `/api/pdf/split`  | Body `{ filepath }` — splits a multi-page PDF into single-page PDFs in `__raws` |

Both accept **PDF paths only** (images are not accepted — photos become PDFs through the vision
pipeline instead; see [triage-pipeline](../workflows/triage-pipeline.md)).

**Every caller-supplied path is resolved through `resolveManagedPath()`** and must land inside
`CONFIG.INPUT_DIR` or `CONFIG.OUTPUT_ROOT_DIR`; anything else is `403`. Without that guard these
routes read any file the Node process can — an SSH key, another app's `.env` — and then write a
derivative of it into `__raws`, where the auto-watcher classifies and archives it into the
searchable registry. `GET /api/documents/file-by-path` uses the same helper.

## Auto-watcher

Not a route — a `setInterval(…, 10000)` in `createWebServer()`. When `__raws` has PDFs and no scan is running, runs `runTriageScan(broadcast)`.

## MCP tools (`src/infrastructure/mcp/mcp-server.ts`)

`npm run mcp` starts **two transports on the same tool set, in one process**:

- **stdio** — for clients that spawn the process locally (Claude Desktop/Code config). No auth (the process spawn itself is the access boundary). One long-lived `Server` instance for the process lifetime.
- **Streamable HTTP** — `POST http://<host>:<CONFIG.MCP_HTTP_PORT>/mcp` (default port `3972`) — for any MCP-capable agent that can't spawn a local process (OpenAI Agents SDK, another machine on the LAN, etc.). Stateless: every request gets a fresh `Server` + `StreamableHTTPServerTransport` pair, torn down when the response completes. Requires `Authorization: Bearer <token>`; the token is auto-generated into the gitignored `.mcp-api-token` file on first start and printed to the console. `CONFIG.MCP_HTTP_HOST` defaults to `0.0.0.0` (LAN-reachable by design, guarded by the token — not by binding); set `MCP_HTTP_HOST=127.0.0.1` to restrict to this machine only.

Same DB as the web server; do not run both in dev without confirming that's what you want.

| Tool                       | Args                                                              | Purpose                          |
| -------------------------- | ------------------------------------------------------------------| -------------------------------- |
| `search_documents`         | `{ query?, category?, subcategory?, fileType?, limit? }`          | Keyword search across DB         |
| `get_full_document_text`   | `{ docId }`                                                       | Return raw_text + metadata       |
| `get_document_markdown`    | `{ docId }`                                                       | Return markdown_content, summary, amounts, contacts |
| `update_document_metadata` | `{ docId, title?, registre?, date?, category?, subcategory?, summary?, tags? }` | Mutate a doc, relocalizing the file if category/subcategory changed |
| `trigger_triage`           | `{}`                                                              | Run a scan (no SSE — MCP is stdio) |
| `list_categories`          | `{}`                                                              | Return full `categories.json`    |
| `prepare_dossier`          | `{ dossierType, limit? }`                                         | Free-text relevance search for a dossier's documents (reuses `searchRelevantDocuments`, the chat assistant's ranker) |
| `open_document_folder`     | `{ docId }`                                                       | Open OS file manager at the doc's file (local machine only — meaningless over a LAN-reached HTTP call from another device) |
| `package_documents`        | `{ docIds?, dossierType?, zipName? }`                             | Build a `.zip` of resolved documents under `__packages/`, return its path + which requested docs had no file on disk. Provide `docIds` directly or a `dossierType` free-text query (same resolution as `prepare_dossier`). |

## Vision Lab (standalone server, separate port)

Source: `src/vision-lab-server.ts`. Not part of the main app — its own Express process, own port (`CONFIG.VISION_LAB_PORT`, default `3179`), started independently via `npm run vision:dev`. Serves the diagnostic page `public/test-image-to-pdf.html` and this one route.

| Method | Route                        | Description                                                        |
| ------ | ---------------------------- | -------------------------------------------------------------------|
| POST   | `/api/vision/diagnose-image` | Body `{ imageBase64: string }` → `{ steps: PipelineStep[] }` or `{ error: string }` |

Runs the 4-step diagnostic pipeline (`src/application/image-to-pdf.ts`, `runVisionPipeline`) against the local `minicpm-v4.6` Ollama vision model: `original` (input as-is) → `oriented` (rotation detected + applied) → `cropped` (document bounds detected + applied) → `enhanced` (auto brightness/contrast + sharpen). A step that throws records an `error` and the pipeline stops there.

## CORS

**No route sets `Access-Control-Allow-Origin`.** The frontend is served from this same Express
instance (same-origin), so it never needs it, and this server has no authentication layer — a
wildcard would let any page open in another browser tab read the entire API cross-origin
(documents, summaries, raw text) via `fetch()`.

This is easy to reintroduce by accident: `/api/logs/stream` carried an
`Access-Control-Allow-Origin: '*'` for a long time, ~390 lines below the comment forbidding it,
exposing original filenames, resolved entity categories and decision traces. If you add an SSE
route, copy `/api/triage/events`, which sets no CORS header and works fine.

## Error contract

All routes return JSON. Errors: `4xx` with `{ error: string }`. Zod validation failures surface as 400 with the Zod message.
