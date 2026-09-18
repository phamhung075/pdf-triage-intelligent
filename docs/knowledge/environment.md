# ⚙️ Environment & Config

## Paths (defaults)

| Key                | Source                             | Default                                              |
| ------------------ | ---------------------------------- | ---------------------------------------------------- |
| `BASE_DIR`         | `PDF_TRIAGE_BASE_DIR` env var › `process.cwd()` in `src/infrastructure/settings.ts` | the directory the app is run from |
| `INPUT_DIR`        | `settings.json` › env › default    | `<BASE_DIR>/input` (default) — point this at your own incoming-documents folder via `settings.json` or `PDF_INPUT_DIR` |
| `OUTPUT_ROOT_DIR`  | `settings.json` › env › default    | `<BASE_DIR>/organized` (default) — point this at your own archive folder via `settings.json` or `PDF_OUTPUT_DIR` |
| `JSON_REGISTRY_PATH` | env › default                    | `<BASE_DIR>/registry.json`                           |
| `DB_PATH`          | env › default                      | `<BASE_DIR>/pdf_triage.db`                           |
| `CATEGORIES_FILE`  | hard-coded, committed (generic starter taxonomy) | `<BASE_DIR>/categories.json`           |
| `CATEGORIES_PRIVATE_FILE` | hard-coded, gitignored (your real, auto-created taxonomy) | `<BASE_DIR>/.categories.private.json` |
| `SETTINGS_FILE`    | hard-coded                         | `<BASE_DIR>/settings.json`                           |
| `PORT`             | env › default                      | `3971`                                               |

## Resource requirements

Measured, not estimated — see [README → System Requirements](../../README.md#-system-requirements)
for the full tables and the storage breakdown. The short version:

| | |
| --- | --- |
| App processes (RAM) | Node dev server ~540 MB, watcher + `ollama serve` ~130 MB (2026-09-04 measurement, predates the pdf2w swap — no local OCR process runs in this app anymore; `markdown-extract-service` and `pdf-triage-pdf2w` run as separate external processes with their own footprint, not yet measured here) |
| `qwen3.5:9b` | 6.6 GB resident at `num_ctx: 16384`. On GPU that is **VRAM**, so 8 GB is the floor — on an 8 GB card it loads at 100% GPU with ~580 MB to spare. Without a GPU it is system RAM instead. |
| Disk | ~9.8 GB installed, plus **≈158 KB per archived document** in SQLite |
| Throughput | ~2 min/document overall (2026-09-04 measurement, predates the pdf2w swap): 30-60s for a digital text layer (GPU-bound, classification), 120-230s when OCR was needed via the since-removed local PaddleOCR path. OCR now happens inside the external pdf2w service — its throughput is not measured from this repo. |

Two things that grow without bound and nothing prunes: `logs/triage_debug.log` and
`__raws/.delete_files/img_converted/`.

## Ollama

| Key                | Source                             | Default                    |
| ------------------ | ---------------------------------- | -------------------------- |
| `OLLAMA_HOST`      | `settings.json` › env › default    | `http://127.0.0.1:11434`   |
| `OLLAMA_MODEL`     | `settings.json` › env › default    | `qwen3.5:9b`               |
| `OLLAMA_EMBED_MODEL` | env › default                    | `nomic-embed-text`         |
| `OLLAMA_VISION_MODEL` | env only › default (no `settings.json` key) | `minicpm-v4.6:latest`      |

Only `qwen3.5:9b` is supported for `OLLAMA_MODEL`. Legacy models are purged; do not reintroduce. `OLLAMA_VISION_MODEL` is separately pinned to `minicpm-v4.6:latest` for the Vision Lab image-to-PDF pipeline (orientation/crop detection) — any other value is rejected and falls back, same lock-down pattern as `OLLAMA_MODEL`.

## Vision Lab

| Key                | Source                             | Default |
| ------------------ | ----------------------------------- | ------- |
| `VISION_LAB_PORT`  | env › default                       | `3179`  |

Standalone diagnostic server (`src/vision-lab-server.ts`, `npm run vision:dev`), separate process and port from the main app.

## pdf2w extraction + canonical-path services (required, no fallback)

| Key                                  | Source          | Default        |
| ------------------------------------- | --------------- | -------------- |
| `PDF2W_SERVICE_URL`                   | env › default    | *(unset)*      |
| `PDF2W_SERVICE_TIMEOUT_MS`            | env › default    | `0` (none)     |
| `CANONICAL_PATH_SERVICE_URL`          | env › default    | *(unset)*      |
| `CANONICAL_PATH_SERVICE_TIMEOUT_MS`   | env › default    | `0` (none)     |

Both are **required, not optional-with-fallback** — see [pdf2w-extraction.md](./pdf2w-extraction.md)
for the full picture. `PDF2W_SERVICE_URL` points `extractPDFContent()`
(`src/infrastructure/pdf2w-remote.ts`) at the self-hosted `markdown-extract-service` (pdf2w,
own repo `/home/daihu/__projects__/markdown-extract-service`, own compose on `:3984`) for ALL
PDF/photo-derived-PDF text extraction and OCR. `CANONICAL_PATH_SERVICE_URL` points
`relocalizeFileIfNeeded()` (`src/infrastructure/canonical-path-remote.ts`) at the Go
`pdf-triage-pdf2w` service (git submodule `services/pdf-triage-pdf2w/`, this repo's own
`docker-compose.yml`, `:3985`) for canonical-path resolution. Either service unreachable, or its
URL unset, is a hard error — `FILE_FAILED` for that file, no in-process fallback.

This replaces `paddleocr-server/` (Python/FastAPI local OCR, `PADDLEOCR_HOST` /
`PADDLEOCR_SPAWN_CMD`), the Docling sidecar (`DOCLING_SERVICE_URL` / `_REQUIRED` / `_TIMEOUT_MS`),
and the in-repo `pdf-extract` Docker microservice split (`PDF_EXTRACT_SERVICE_*`,
`PDF_EXTRACT_PORT` / `_HOST` / `_MAX_BYTES`, `OCR_MAX_PAGES`, `OCR_RENDER_SCALE`) — all removed,
none of these variables are read by `settings.ts` anymore.

## MCP HTTP transport

| Key               | Source        | Default   |
| ------------------ | ------------- | --------- |
| `MCP_HTTP_PORT`    | env › default | `3972`    |
| `MCP_HTTP_HOST`    | env › default | `0.0.0.0` |

`npm run mcp` serves stdio (unauthenticated, local process-spawn only) and Streamable HTTP
(bearer-token authenticated) at the same time from one process — see the [API
reference](./api-reference.md#mcp-tools-srcinfrastructuremcpmcp-serverts) and
[mcp-integrator](../agents/mcp-integrator.md). The HTTP port defaults to LAN-reachable
(`0.0.0.0`), guarded by the token in the gitignored `.mcp-api-token` file (auto-generated on
first start, printed to console); set `MCP_HTTP_HOST=127.0.0.1` to restrict it to this
machine only.

## `settings.json` shape

```json
{
  "input_dir": "…",
  "output_root_dir": "…",
  "ollama_model": "qwen3.5:9b",
  "ollama_host": "http://127.0.0.1:11434"
}
```

Written by `updateConfig()`; reloaded on every scan via `reloadConfigFromDisk()`.

## Environment variables

`PDF_INPUT_DIR`, `PDF_OUTPUT_DIR`, `PDF_REGISTRY_PATH`, `PDF_DB_PATH`, `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_EMBED_MODEL`, `OLLAMA_VISION_MODEL`, `PORT`, `PDF_TRIAGE_HOST`, `VISION_LAB_PORT`, `PDF2W_SERVICE_URL`, `PDF2W_SERVICE_TIMEOUT_MS`, `CANONICAL_PATH_SERVICE_URL`, `CANONICAL_PATH_SERVICE_TIMEOUT_MS`, `MCP_HTTP_PORT`, `MCP_HTTP_HOST`.

Loaded from `.env` via `dotenv` when the process starts.

### pdf2w extraction and canonical-path service variables

See [pdf2w extraction + canonical-path services](#pdf2w-extraction--canonical-path-services-required-no-fallback)
above and [pdf2w-extraction.md](./pdf2w-extraction.md) for the full picture. `PADDLEOCR_HOST`,
`PADDLEOCR_SPAWN_CMD`, `DOCLING_SERVICE_URL`/`_REQUIRED`/`_TIMEOUT_MS`, `PDF_EXTRACT_SERVICE_*`,
`PDF_EXTRACT_PORT`/`_HOST`/`_MAX_BYTES`, `TESSERACT_LANG_PATH`, `OCR_MAX_PAGES`, and
`OCR_RENDER_SCALE` are all deleted from `settings.ts` and no longer read.

## Logs

- Terminal: color-coded prefixes `[PDF_PARSER]`, `[OLLAMA_AI]`, `[RELOCALIZE]`, `[TRIAGE]`, `[SERVER]`, `[AUTO_WATCHER]`.
- File: `<BASE_DIR>/logs/triage_debug.log`, ISO-timestamped.

## Windows specifics

- Explorer open: `explorer "<path>"` for directories, `explorer /select,"<path>"` for files.
- `ollama serve` auto-spawn: `exec('ollama serve')`.
- Path separators: canonical paths use `path.join`, so `/` and `\` are normalized. Lookups are case-insensitive via `.toLowerCase()`.

## Server ports

Web/API/SSE all on `PORT` (`3971` default, bound to `HOST`/`PDF_TRIAGE_HOST`, default `127.0.0.1`). Vision Lab on `VISION_LAB_PORT` (`3179`). MCP stdio has no port; MCP's Streamable HTTP transport listens on `MCP_HTTP_PORT` (`3972`, bound to `MCP_HTTP_HOST`, default `0.0.0.0` — see [MCP HTTP transport](#mcp-http-transport) above).

## `.gitignore` awareness

`node_modules/`, `pdf_triage.db`, `logs/`, `settings.json` (personal), `.mcp-api-token` (MCP HTTP bearer token), `__packages/` (zips built by `package_documents`) are ignored. `categories.json` is committed because it's the taxonomy source of truth.
