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
| `PORT`             | env › default                      | `3000`                                               |

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

`PDF_INPUT_DIR`, `PDF_OUTPUT_DIR`, `PDF_REGISTRY_PATH`, `PDF_DB_PATH`, `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_EMBED_MODEL`, `OLLAMA_VISION_MODEL`, `PORT`, `VISION_LAB_PORT`.

Loaded from `.env` via `dotenv` when the process starts.

## Logs

- Terminal: color-coded prefixes `[PDF_PARSER]`, `[OLLAMA_AI]`, `[RELOCALIZE]`, `[TRIAGE]`, `[SERVER]`, `[AUTO_WATCHER]`.
- File: `<BASE_DIR>/logs/triage_debug.log`, ISO-timestamped.

## Windows specifics

- Explorer open: `explorer "<path>"` for directories, `explorer /select,"<path>"` for files.
- `ollama serve` auto-spawn: `exec('ollama serve')`.
- Path separators: canonical paths use `path.join`, so `/` and `\` are normalized. Lookups are case-insensitive via `.toLowerCase()`.

## Server ports

Web/API/SSE all on `PORT` (`3000` default). MCP is stdio-only, no port.

## `.gitignore` awareness

`node_modules/`, `pdf_triage.db`, `logs/`, `settings.json` (personal) are ignored. `categories.json` is committed because it's the taxonomy source of truth.
