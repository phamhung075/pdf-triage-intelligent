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
| App processes (RAM) | ~1.5 GB — PaddleOCR service ~780 MB, Node dev server ~540 MB, watcher + `ollama serve` ~130 MB |
| `qwen3.5:9b` | 6.6 GB resident at `num_ctx: 16384`. On GPU that is **VRAM**, so 8 GB is the floor — on an 8 GB card it loads at 100% GPU with ~580 MB to spare. Without a GPU it is system RAM instead. |
| Disk | ~9.8 GB installed, plus **≈158 KB per archived document** in SQLite |
| Throughput | ~2 min/document overall: 30-60s for a digital text layer (GPU-bound), 120-230s when OCR is needed (**CPU**-bound — the GPU does not accelerate PaddleOCR) |

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

## PaddleOCR

| Key                    | Source          | Default                              |
| ---------------------- | ---------------- | ------------------------------------ |
| `PADDLEOCR_HOST`       | env › default    | `http://127.0.0.1:8871`              |
| `PADDLEOCR_SPAWN_CMD`  | env › default    | `python paddleocr-server/main.py`    |

Standalone local OCR service (`paddleocr-server/`, Python/FastAPI), auto-spawned by
`ensurePaddleOcrServer()` in `src/infrastructure/paddleocr-client.ts` if unreachable. Used as
the primary OCR engine in `pdf-extractor.ts` and the orientation tiebreaker in
`orientation-detector.ts`, with Tesseract kept as an availability fallback if this service
isn't reachable. See `paddleocr-server/README.md` for one-time setup.

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

`PDF_INPUT_DIR`, `PDF_OUTPUT_DIR`, `PDF_REGISTRY_PATH`, `PDF_DB_PATH`, `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_EMBED_MODEL`, `OLLAMA_VISION_MODEL`, `PORT`, `PDF_TRIAGE_HOST`, `VISION_LAB_PORT`, `PADDLEOCR_HOST`, `PADDLEOCR_SPAWN_CMD`, `MCP_HTTP_PORT`, `MCP_HTTP_HOST`.

Loaded from `.env` via `dotenv` when the process starts.

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
