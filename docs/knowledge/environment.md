# ⚙️ Environment & Config

## Paths (defaults)

| Key                | Source                             | Default                                              |
| ------------------ | ---------------------------------- | ---------------------------------------------------- |
| `BASE_DIR`         | `PDF_TRIAGE_BASE_DIR` env var › process working directory in `infra/settings` | the directory the binary is run from (run from the repo root) |
| `DATA_DIR`         | `PDF_TRIAGE_DATA_DIR` env › `BASE_DIR` | writable state root — `settings.json`, `registry.json`, `pdf_triage.db`, runtime state files |
| `INPUT_DIR`        | `settings.json` › env › default    | `<BASE_DIR>/input` (default) — point this at your own incoming-documents folder via `settings.json` or `PDF_INPUT_DIR` |
| `OUTPUT_ROOT_DIR`  | `settings.json` › env › default    | `<BASE_DIR>/organized` (default) — point this at your own archive folder via `settings.json` or `PDF_OUTPUT_DIR` |
| `REGISTRY_PATH`    | env › default                      | `<DATA_DIR>/registry.json`                           |
| `DB_PATH`          | env › default                      | `<DATA_DIR>/pdf_triage.db`                           |
| `CATEGORIES_FILE`  | hard-coded, committed (generic starter taxonomy) | `<BASE_DIR>/categories.json`           |
| `CATEGORIES_PRIVATE_FILE` | hard-coded, gitignored (your real, auto-created taxonomy) | `<BASE_DIR>/.categories.private.json` |
| `SETTINGS_FILE`    | hard-coded                         | `DATA_DIR/settings.json` (a `.env` is loaded from `DATA_DIR`, falling back to `BASE_DIR`) |
| `PORT`             | env › default                      | `3971`                                               |

`SYSTEM_LANGUAGE` selects the UI/prompt language: `FR` (default) or `EN`.

## Resource requirements

Measured, not estimated — see [README → System Requirements](../../README.md#-system-requirements)
for the full tables and the storage breakdown. The short version:

| | |
| --- | --- |
| App processes (RAM) | The pre-cutover Node dev server measured ~540 MB; the Go binary's footprint is not separately re-measured here. Watcher + `ollama serve` ~130 MB (2026-09-04 measurement, predates the pdf2w swap — no local OCR process runs in this app anymore; `markdown-extract-service` runs as a separate external process with its own footprint, not measured here) |
| `qwen3.5:9b` | 6.6 GB resident at `num_ctx: 16384`. On GPU that is **VRAM**, so 8 GB is the floor — on an 8 GB card it loads at 100% GPU with ~580 MB to spare. Without a GPU it is system RAM instead. |
| Disk | ~9.8 GB installed, plus **≈158 KB per archived document** in SQLite |
| Throughput | ~2 min/document overall (2026-09-04 measurement, predates the pdf2w swap): 30-60s for a digital text layer (GPU-bound, classification), 120-230s when OCR was needed via the since-removed local PaddleOCR path. OCR now happens inside the external pdf2w service — its throughput is not measured from this repo. |

Two things that grow without bound and nothing prunes: the log file (see [Logs](#logs)) and
`__raws/.delete_files/img_converted/`.

## Ollama

| Key                | Source                             | Default                    |
| ------------------ | ---------------------------------- | -------------------------- |
| `OLLAMA_HOST`      | `settings.json` › env › default    | `http://127.0.0.1:11434`   |
| `OLLAMA_MODEL`     | `settings.json` › env › default    | `qwen3.5:9b`               |
| `OLLAMA_EMBED_MODEL` | env › default                    | `nomic-embed-text`         |
| `OLLAMA_VISION_MODEL` | env only › default (no `settings.json` key) | `minicpm-v4.6:latest`      |

Only `qwen3.5:9b` is supported for `OLLAMA_MODEL`. Legacy models are purged; do not reintroduce. `OLLAMA_VISION_MODEL` is separately pinned to `minicpm-v4.6:latest` for the Vision Lab image-to-PDF pipeline (orientation/crop detection) — any other value is rejected and falls back, same lock-down pattern as `OLLAMA_MODEL`.

Cloud providers are opt-in and read as env fallbacks behind `settings.json`: `AI_PROVIDER` (`local`/`cloud`), `CLOUD_PROVIDER` (`google`/`claude`/`deepseek`/`openai`), the key vars `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, and matching `GEMINI_MODEL`/`GOOGLE_MODEL`, `ANTHROPIC_MODEL`/`CLAUDE_MODEL`, `DEEPSEEK_MODEL`, `OPENAI_MODEL` plus `GOOGLE_BASE_URL`, `ANTHROPIC_BASE_URL`, `DEEPSEEK_BASE_URL`, `OPENAI_BASE_URL`; local Ollama remains the default.

## Vision Lab

| Key                | Source                             | Default |
| ------------------ | ----------------------------------- | ------- |
| `VISION_LAB_PORT`  | env › default                       | `3179`  |

Standalone diagnostic server (`pdf-triage vision-lab` subcommand, `visionlab` package), separate process and port from the main app.

## pdf2w extraction service (required, no fallback)

| Key                                  | Source          | Default        |
| ------------------------------------- | --------------- | -------------- |
| `PDF2W_SERVICE_URL`                   | env › default    | *(unset)*      |
| `PDF2W_SERVICE_TIMEOUT_MS`            | env › default    | `0` (none)     |

`PDF2W_SERVICE_URL` is **required, not optional-with-fallback** — see
[pdf2w-extraction.md](./pdf2w-extraction.md) for the full picture. It points the
`infra/pdf2w` package (`services/pdf-triage-pdf2w/infra/pdf2w`) at the self-hosted
`markdown-extract-service` (pdf2w, its own repo with its own compose on `:3984`) for ALL
PDF/photo-derived-PDF text extraction and OCR. The service
unreachable, or its URL unset, is a hard error — `FILE_FAILED` for that file, no in-process
fallback.

Canonical-path resolution is **not** a service anymore: `computeCanonicalPath` is called
in-process through the `canonicalpath` package (`services/pdf-triage-pdf2w/canonicalpath`), and
text cleaning runs in-process through the `cleantext` package. The former
`CANONICAL_PATH_SERVICE_URL` / `CANONICAL_PATH_SERVICE_TIMEOUT_MS` variables, the in-repo Go
helper service on `:3985`, and the HTTP clients that called them are gone.

This replaces `paddleocr-server/` (Python/FastAPI local OCR, `PADDLEOCR_HOST` /
`PADDLEOCR_SPAWN_CMD`), the Docling sidecar (`DOCLING_SERVICE_URL` / `_REQUIRED` / `_TIMEOUT_MS`),
and the in-repo `pdf-extract` Docker microservice split (`PDF_EXTRACT_SERVICE_*`,
`PDF_EXTRACT_PORT` / `_HOST` / `_MAX_BYTES`, `OCR_MAX_PAGES`, `OCR_RENDER_SCALE`) — all removed,
none of these variables are read by `infra/settings` anymore.

## MCP HTTP transport

| Key               | Source        | Default   |
| ------------------ | ------------- | --------- |
| `MCP_HTTP_PORT`    | env › default | `3972`    |
| `MCP_HTTP_HOST`    | env › default | `0.0.0.0` |

`pdf-triage mcp` serves stdio (unauthenticated, local process-spawn only) and Streamable HTTP
(bearer-token authenticated) at the same time from one process — see the [API
reference](./api-reference.md#mcp-tools-mcpserver) and
[mcp-integrator](../agents/mcp-integrator.md). The HTTP port defaults to LAN-reachable
(`0.0.0.0`), guarded by the token in the gitignored `.mcp-api-token` file (auto-generated on
first start, printed to console); set `MCP_HTTP_HOST=127.0.0.1` to restrict it to this
machine only.

## `settings.json` shape

```json
{
  "language": "FR",
  "input_dir": "…",
  "output_root_dir": "…",
  "ollama_model": "qwen3.5:9b",
  "ollama_host": "http://127.0.0.1:11434",
  "personal_name_denylist": []
}
```

Written by the config update path in the `infra/settings` store and the `httpapi` `PUT /api/config`
route; reloaded on every scan.

## Environment variables

`PDF_TRIAGE_BASE_DIR`, `PDF_TRIAGE_DATA_DIR`, `PDF_INPUT_DIR`, `PDF_OUTPUT_DIR`, `PDF_DB_PATH`, `PDF_REGISTRY_PATH`, `SYSTEM_LANGUAGE`, `PORT`, `PDF_TRIAGE_HOST`, `VISION_LAB_PORT`, `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_EMBED_MODEL`, `OLLAMA_VISION_MODEL`, `PDF2W_SERVICE_URL`, `PDF2W_SERVICE_TIMEOUT_MS`, `MCP_HTTP_PORT`, `MCP_HTTP_HOST`, `PDF_TRIAGE_LOG_DIR`, `PDF_TRIAGE_LOG_MAX_BYTES`, `PDF_TRIAGE_LOG_RETAIN`.

This is the exact set read by `infra/settings` and listed in the configuration table of
[`services/pdf-triage-pdf2w/README.md`](../../services/pdf-triage-pdf2w/README.md). A `.env` in
`DATA_DIR` (falling back to `BASE_DIR`) is loaded without overriding already-set process
variables.

### Retired extraction variables

`PADDLEOCR_HOST`, `PADDLEOCR_SPAWN_CMD`, `DOCLING_SERVICE_URL`/`_REQUIRED`/`_TIMEOUT_MS`,
`PDF_EXTRACT_SERVICE_*`, `PDF_EXTRACT_PORT`/`_HOST`/`_MAX_BYTES`, `TESSERACT_LANG_PATH`,
`OCR_MAX_PAGES`, `OCR_RENDER_SCALE`, and `CANONICAL_PATH_SERVICE_URL`/`_TIMEOUT_MS` are all
deleted and no longer read.

## Logs

- Terminal: color-coded prefixes `[PDF_PARSER]`, `[OLLAMA_AI]`, `[RELOCALIZE]`, `[TRIAGE]`, `[SERVER]`, `[AUTO_WATCHER]`.
- File: `PDF_TRIAGE_LOG_DIR` (default `<DATA_DIR>/logs`) `/triage_debug.log`, ISO-timestamped; rotates at `PDF_TRIAGE_LOG_MAX_BYTES`, keeping `PDF_TRIAGE_LOG_RETAIN` generations (0 bytes disables rotation).

## Windows specifics

- Explorer open: `explorer "<path>"` for directories, `explorer /select,"<path>"` for files.
- `ollama serve` auto-spawn is handled inside the `infra/ollama` package.
- Path separators: canonical paths are built with the OS path package, so `/` and `\` are normalized. Lookups are case-insensitive.

## Server ports

Web/API/SSE all on `PORT` (`3971` default, bound to `PDF_TRIAGE_HOST`, default `127.0.0.1`). Vision Lab on `VISION_LAB_PORT` (`3179`). MCP stdio has no port; MCP's Streamable HTTP transport listens on `MCP_HTTP_PORT` (`3972`, bound to `MCP_HTTP_HOST`, default `0.0.0.0` — see [MCP HTTP transport](#mcp-http-transport) above).

## `.gitignore` awareness

`node_modules/`, `pdf_triage.db`, `logs/`, `settings.json` (personal), `.mcp-api-token` (MCP HTTP bearer token), `__packages/` (zips built by `package_documents`), and `dist/` are ignored. `categories.json` is committed because it's the taxonomy source of truth.
