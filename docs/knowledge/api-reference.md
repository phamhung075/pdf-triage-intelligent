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
| POST   | `/api/registry/repair`   | Ghost purge + re-classify + relocalize + move-back |

## Auto-watcher

Not a route — a `setInterval(…, 10000)` in `createWebServer()`. When `__raws` has PDFs and no scan is running, runs `runTriageScan(broadcast)`.

## MCP tools (`src/infrastructure/mcp/mcp-server.ts`)

Exposed over stdio when `npm run mcp`. Same DB as the web server; do not run both in dev without confirming that's what you want.

| Tool                       | Args                                     | Purpose                          |
| -------------------------- | ---------------------------------------- | -------------------------------- |
| `search_documents`         | `{ query?, category?, limit? }`          | Keyword search across DB         |
| `get_full_document_text`   | `{ docId }`                              | Return raw_text + metadata       |
| `update_document_metadata` | `{ docId, title?, registre?, date?, category?, summary?, tags? }` | Mutate a doc |
| `trigger_triage`           | `{}`                                     | Run a scan (no SSE — MCP is stdio) |
| `list_categories`          | `{}`                                     | Return full `categories.json`    |

## Vision Lab (standalone server, separate port)

Source: `src/vision-lab-server.ts`. Not part of the main app — its own Express process, own port (`CONFIG.VISION_LAB_PORT`, default `3179`), started independently via `npm run vision:dev`. Serves the diagnostic page `public/test-image-to-pdf.html` and this one route.

| Method | Route                        | Description                                                        |
| ------ | ---------------------------- | -------------------------------------------------------------------|
| POST   | `/api/vision/diagnose-image` | Body `{ imageBase64: string }` → `{ steps: PipelineStep[] }` or `{ error: string }` |

Runs the 4-step diagnostic pipeline (`src/application/image-to-pdf.ts`, `runVisionPipeline`) against the local `minicpm-v4.6` Ollama vision model: `original` (input as-is) → `oriented` (rotation detected + applied) → `cropped` (document bounds detected + applied) → `enhanced` (auto brightness/contrast + sharpen). A step that throws records an `error` and the pipeline stops there.

## Error contract

All routes return JSON. Errors: `4xx` with `{ error: string }`. Zod validation failures surface as 400 with the Zod message.
