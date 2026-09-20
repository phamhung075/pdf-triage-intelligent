# 🔌 API Reference

Source: the `httpapi` package (`services/pdf-triage-pdf2w/httpapi`) — a Go `net/http` server that
replaces the retired TypeScript web-server module. Default port `3971`.

The Go server registers the **same 46 REST routes** as the retired TypeScript server. The tables
below are the operator-facing contract; the full per-route table, with the Go handler file for each
route and the test that covers it, is
[`docs/superpowers/specs/2026-09-18-http-parity-audit.md`](../superpowers/specs/2026-09-18-http-parity-audit.md)
(§1). The SSE/MCP contracts are frozen the same way.

## System

| Method | Route                     | Description                                            |
| ------ | ------------------------- | ------------------------------------------------------ |
| GET    | `/api/dev/livereload`     | SSE stream. Emits `reload` on any `public/` change     |
| POST   | `/api/open-location`      | Body `{ targetPath }` → opens Windows Explorer         |
| POST   | `/api/server/restart`     | Exits the process (the operator's dev runner restarts it) |

## Ollama

| Method | Route                | Description                                     |
| ------ | -------------------- | ----------------------------------------------- |
| GET    | `/api/ollama/status` | `{ online, model, host, modelsCount, modelExists }` |
| POST   | `/api/ollama/start`  | Auto-spawn `ollama serve`                       |

## Config

| Method | Route         | Description                                            |
| ------ | ------------- | ------------------------------------------------------ |
| GET    | `/api/config` | Returns current `input_dir`, `output_root_dir`, `ollama_model`, `ollama_host` |
| PUT    | `/api/config` | Body validated by the settings parser; persists to `settings.json` |

## AI providers & system stats

`GET`/`PUT /api/config` carry the provider selection: `ai_provider` (`local` | `cloud`),
`cloud_provider` (`google` | `claude` | `deepseek` | `openai`, plus the case-insensitive aliases
`gemini` → `google` and `anthropic` → `claude`), and per provider the `google_*`, `anthropic_*`,
`deepseek_*` and `openai_*` `_model` / `_base_url` fields. An unknown non-empty `cloud_provider` is
rejected with `400`.

**API keys never leave the server.** `GET /api/config` and the `config` object in the `PUT` response
carry no `*_api_key` value — each provider has an always-present `P_api_key_set` boolean (true iff the
stored key is non-empty after trimming). On `PUT`, an omitted, `null`, empty or whitespace-only
`P_api_key` keeps the stored key and a non-empty value replaces it; there is deliberately no API way
to clear a key. Keys live in plain text in `settings.json` (written with mode `0600`).

| Method | Route                | Contract |
| ------ | -------------------- | -------- |
| POST   | `/api/ai/test`       | `{ provider, api_key?, model?, base_url? }` → `{ ok, message \| error, latency_ms }`. `provider` accepts `google`/`gemini`, `claude`/`anthropic`, `deepseek`, `openai`, `local`/`ollama`; an unknown provider is `400`. An omitted/empty `api_key`, `model` or `base_url` falls back to the stored setting. |
| GET    | `/api/ollama/status` | Local mode returns `{ online, model, host, modelsCount, models, modelExists, modelCanGenerate, modelError? }`; cloud mode adds `provider: "cloud"`, `cloud_provider`, the active `model` and `host: "Cloud API (<provider>)"`. |
| GET    | `/api/system/stats`  | `{ raws, archive, database, total, formatBreakdown }` — file counts/sizes plus DB size. |

The cloud health result behind `/api/ollama/status` is cached for **60 s** (failures included); a
forced refresh bypasses the cache. `/api/system/stats` caches its walk of the raws/archive trees for
**30 s** (keyed on the two directories); the database size is read fresh on every request.

## Categories

| Method | Route                          | Description                                       |
| ------ | ------------------------------ | ------------------------------------------------- |
| GET    | `/api/categories`              | Returns categories with live doc counts from DB (dynamically appends DB-only subcategories missing from `categories.json`) |
| PUT    | `/api/categories`              | Body validated by the categories parser; broadcasts `CATEGORIES_UPDATED` |
| POST   | `/api/subcategories/rename`    | `{ category, oldSubcategory, newSubcategory }` — renames slug + relocalizes every matching file on disk |

## Documents

| Method | Route                              | Description                                         |
| ------ | ---------------------------------- | --------------------------------------------------- |
| GET    | `/api/documents?q=&category=&subcategory=` | Filtered list                                |
| GET    | `/api/documents/:id`               | Single doc with full `raw_text`                     |
| PUT    | `/api/documents/:id`               | Update metadata (validated by the document schema parser); auto-relocalizes on category/subcategory change |
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
routes read any file the process can — an SSH key, another app's `.env` — and then write a
derivative of it into `__raws`, where the auto-watcher classifies and archives it into the
searchable registry. `GET /api/documents/file-by-path` uses the same helper.

## Auto-watcher

Not a route — a 10 s ticker started by `serve`. When `__raws` has PDFs and no scan is running, runs `runTriageScan(broadcast)`.

## MCP tools (`mcpserver`)

`pdf-triage mcp` starts **two transports on the same tool set, in one process**:

- **stdio** — for clients that spawn the process locally (Claude Desktop/Code config). No auth (the process spawn itself is the access boundary). One long-lived server instance for the process lifetime.
- **Streamable HTTP** — `POST http://<host>:<CONFIG.MCP_HTTP_PORT>/mcp` (default port `3972`) — for any MCP-capable agent that can't spawn a local process (OpenAI Agents SDK, another machine on the LAN, etc.). Stateless: every request gets a fresh server + transport pair, torn down when the response completes. Requires `Authorization: Bearer <token>`; the token is auto-generated into the gitignored `.mcp-api-token` file on first start and printed to the console. `CONFIG.MCP_HTTP_HOST` defaults to `0.0.0.0` (LAN-reachable by design, guarded by the token — not by binding); set `MCP_HTTP_HOST=127.0.0.1` to restrict to this machine only.

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

Source: the `visionlab` package (`services/pdf-triage-pdf2w/visionlab`) — the Go port of the retired
TypeScript Vision Lab server. Not part of the main app — its own process, own port
(`CONFIG.VISION_LAB_PORT`, default `3179`), started independently via `pdf-triage vision-lab`.
Serves the diagnostic page `public/test-image-to-pdf.html` and this one route.

| Method | Route                        | Description                                                        |
| ------ | ---------------------------- | -------------------------------------------------------------------|
| POST   | `/api/vision/diagnose-step`  | Body `{ step: 1 \| 2 \| 3, inputImageBase64: string }` → one pipeline-step result, or `{ error: string }`. Step 4 was retired: any other step returns 400 `step must be 1, 2, or 3 (step 4 is retired)` |

Runs the diagnostic step against the local `minicpm-v4.6` Ollama vision model: step 1 =
`orient` (rotation detected + applied), step 2 = `crop` (document bounds detected + applied),
step 3 = `enhance` (auto brightness/contrast + sharpen). A step that fails returns a 200 carrying
its `error`.

## CORS

**No route sets `Access-Control-Allow-Origin`.** The frontend is served from this same Go server
(same-origin), so it never needs it, and this server has no authentication layer — a
wildcard would let any page open in another browser tab read the entire API cross-origin
(documents, summaries, raw text) via `fetch()`.

This is easy to reintroduce by accident: `/api/logs/stream` carried an
`Access-Control-Allow-Origin: '*'` for a long time, ~390 lines below the comment forbidding it,
exposing original filenames, resolved entity categories and decision traces. If you add an SSE
route, copy `/api/triage/events`, which sets no CORS header and works fine.

## Error contract

All routes return JSON. Errors: `4xx` with `{ error: string }`.

## Documented deviations from the TypeScript server

The Go server is at parity behind the frozen contract, but it deliberately differs in a few
observable ways. Full evidence is in the
[HTTP parity audit](../superpowers/specs/2026-09-18-http-parity-audit.md) §3a/§3b.

- **`405` + `Allow`, not `404`, for a known path with an unknown method.** Go 1.22 `ServeMux`
  answers `405` where Express answered `404`. Considered a more informative response and kept.
- **Live-reload is a polling mtime/size watcher.** The change source behind
  `/api/dev/livereload` is a poll of the `public/` tree rather than `fs.watch(recursive: true)`;
  the wire format is unchanged (`data: reload`).
- **Body-error shape.** The request body is not parsed by a schema middleware; malformed input is
  answered as plain `{ error: <string> }` instead of the retired schema library's pretty-printed
  issue array (the `400`
  status is kept). `PUT /api/manual-decisions/:id` is a known case where a malformed JSON body
  proceeds instead of returning `400` (parity gap G3 — see the audit).

The audit also records **real gaps** (`G1`–`G7`) and **deliberate deviations** (`D3`–`D7`) that are
not re-listed here.
