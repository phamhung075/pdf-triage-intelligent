# 📄 PDF Text-Extraction Microservice (Docker)

> **One-line summary**: the heavy document-extraction stack — PDF text layer parsing, scanned-page
> Canvas rendering + OCR, image OCR, DOCX/XLSX/TXT reading — can run as a **separate Dockerized
> microservice** (`src/extract-service/`) instead of inside the main pdf-triage process. The main
> app switches to it with one env var and **falls back to in-process extraction automatically**
> when the service is unreachable, so documents never strand.

## Why this exists

Text extraction is the one pipeline stage with heavy, slow-moving native dependencies
(`pdfjs-dist`, `@napi-rs/canvas`, `tesseract.js`, and — optionally — the Python PaddleOCR
sidecar). Running it as its own container gives you:

- **Isolation** — a PDF that makes the extractor thrash cannot take the web server / SSE / watcher
  down with it (the extraction now fails or times out on its own side of the wire).
- **Scalability / long scans** — `OCR_MAX_PAGES` is per-service; raise it for the container without
  touching the desktop app, and the container can be restarted/rebuilt independently.
- **A clean HTTP seam** — every other process (a second scan worker, a future CLI, a CI job) can
  extract the exact same way the triage pipeline does, by POSTing bytes to one endpoint.

The split is **transport-only**: the service runs the *same* extraction code
(`extractPDFContentLocal`, the historical `extractPDFContent` body) and returns the *same*
`ExtractedPDF` contract `{ checksum, raw_text, numpages, info, ocr_degraded? }`, so checksums,
dedupe keys, text cleaning, corruption guards and the `< 10 chars` semantics are byte-identical
to in-process extraction.

## Architecture

```
┌─────────────────────────────┐        HTTP POST /extract (raw bytes + X-File-Name)
│  main pdf-triage app        │ ───────────────────────────────────────────────┐
│  (web server, watcher, ...) │                                               ▼
│                             │                                     ┌──────────────────────┐
│  extractPDFContent()        │  PDF_EXTRACT_SERVICE_URL unset ───► │  extractPDFContent   │
│  (pdf-extractor.ts wrapper) │                                     │  Local (in-process)  │
│                             │  service unreachable + fallback ───►│  (same code)         │
└─────────────────────────────┘                                     └──────────────────────┘
```

| Piece | Location | Role |
| --- | --- | --- |
| Extraction microservice | `src/extract-service/app.ts` + `main.ts` | Express app: `GET /health`, `POST /extract` |
| Image | `Dockerfile.extract-service` (repo root) | Multi-stage `node:22-bookworm-slim` build |
| Orchestration | `docker-compose.yml` (repo root) | `docker compose up -d --build` |
| HTTP client (main app) | `src/infrastructure/pdf-extract-remote.ts` | Raw-bytes POST, returns the same contract |
| Routing seam | `src/infrastructure/pdf-extractor.ts` | `extractPDFContent()` wrapper → remote or `extractPDFContentLocal()` |
| Config | `src/infrastructure/settings.ts` | `PDF_EXTRACT_SERVICE_URL` / `_REQUIRED` / `_TIMEOUT_MS`; `PDF_EXTRACT_PORT` / `_HOST` / `_MAX_BYTES` |

## Running it

### 1. Start the service (Docker, recommended)

```bash
docker compose up -d --build
curl http://127.0.0.1:3981/health        # → {"status":"ok","service":"pdf-extract",...}
```

### 2. Point the main app at it

Add to the app's `.env` (same folder the app already reads) and restart the app:

```dotenv
PDF_EXTRACT_SERVICE_URL=http://127.0.0.1:3981
```

That's it. Every scan, relocalize re-extraction and repair-registry re-extraction now travels
through the container.

- **No env var** → in-process extraction, exactly as before (`npm run dev`, the desktop `.exe`,
  `npm run scan`, `npm run mcp` and the whole test suite are unchanged).
- **Service down while URL is set** → the app logs one WARN (`PDF extract service … unreachable —
  falling back to in-process extraction`, throttled to once per 30 s) and extracts locally, so a
  triage run is never blocked by Docker being off.
- **`PDF_EXTRACT_SERVICE_REQUIRED=1`** → a dead service becomes a hard error per file
  (`FILE_FAILED`), no silent fallback. Use it when you want extraction to *prove* it happened in
  the container.

### Local (no Docker) run of the service, for development

```bash
npm run extract:dev        # tsx src/extract-service/main.ts — listens on 127.0.0.1:3981
```

## HTTP contract

| Endpoint | Method | Body | Response |
| --- | --- | --- | --- |
| `/health` | GET | — | `{ status, service, pid, uptimeSec }` |
| `/extract` | POST | raw file bytes, `Content-Type: application/octet-stream` | `200` → `{ checksum, raw_text, numpages, info, ocr_degraded? }` |

The original **basename (extension included) must travel in the `X-File-Name` header**, URI-encoded.
The service stores the upload under that exact name before extracting, so its per-extension routing
(`.pdf` / `.docx` / `.xlsx` / image / `.txt`) and filename-based text cleaning behave exactly as if
the file sat in `__raws`. Missing extension → the file falls through the extractor's PDF branch,
which is almost certainly not what you want.

```bash
curl -sS -X POST \
  -H 'Content-Type: application/octet-stream' \
  -H "X-File-Name: $(basename ~/Documents/facture.pdf | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip()))')" \
  --data-binary @~/Documents/facture.pdf \
  http://127.0.0.1:3981/extract
```

Errors: `400` empty body · `413` payload over `PDF_EXTRACT_MAX_BYTES` (default 512 MB) · `404`
unknown route · `500` extraction failure (JSON `{ error }`).

## OCR inside the container

- **Tesseract.js (fra + eng + vie) is bundled** — the image downloads the three `@tesseract.js-data`
  language files **once at `docker build` time** into `/app/tessdata` and serves them from disk via
  `TESSERACT_LANG_PATH`, so **no CDN download ever happens at runtime**. (New
  `tesseractWorkerOptions()` in `pdf-extractor.ts` reads that env var; unset keeps the stock
  CDN/cache behavior for local/dev installs.) Note the loader reads local files named
  `<lang>.traineddata.gz` (gzip defaults on and is auto-detected by magic bytes, so raw files under
  that name work too) — to reuse the gitignored repo-root `*.traineddata` instead of the
  build-time download, bind-mount each one to the `.gz` name:
  `-v "$PWD/eng.traineddata:/app/tessdata/eng.traineddata.gz"` etc.
- **PaddleOCR is optional and host-side by default.** The container sets `PADDLEOCR_SPAWN_CMD=/bin/false`
  (there is no python in the image and the host auto-spawn dance must not run). To use your
  existing `paddleocr-server` for better quality, point `PADDLEOCR_HOST` at it — see the commented
  lines in `docker-compose.yml` (Windows/Docker Desktop: `http://host.docker.internal:8871`; if the
  sidecar runs inside this WSL distro instead, use the distro's IP). Unreachable → per-page WARN +
  Tesseract fallback, exactly like the in-process path.

## Container notes

- **Debian `bookworm-slim`, not alpine**: `@napi-rs/canvas` ships a prebuilt `linux-x64-gnu`
  binary; musl would need a source build with a full toolchain.
- Both `npm ci` stages run `--ignore-scripts`: the image never imports native addons that need a
  compiler (`sqlite3`, `electron`), and `@napi-rs/canvas` loads its prebuilt optional dependency
  without an install script.
- Defaults inside the image: `PDF_EXTRACT_PORT=3981`, `PDF_EXTRACT_HOST=0.0.0.0` (the host-safe
  default `127.0.0.1` only applies when the service runs directly on a machine). Raise
  `OCR_MAX_PAGES` / tune `OCR_RENDER_SCALE` via `docker-compose.yml` `environment` for very long
  scans.
- Logs go to stdout (→ `docker logs`) *and* to `/app/logs/triage_debug.log` (rotation enabled,
  `PDF_TRIAGE_LOG_MAX_BYTES`/`PDF_TRIAGE_LOG_RETAIN` respected).

## Verification

- `src/extract-service/app.test.ts` — endpoint contract through supertest (`.txt`, real
  pdf-lib PDF, extension routing, 400/404).
- `src/infrastructure/pdf-extractor-routing.test.ts` — default in-process path, real
  HTTP round-trip against a live in-process listener, unreachable → fallback WARN,
  `PDF_EXTRACT_SERVICE_REQUIRED=1` → hard error.
- The whole `npm test` suite stays green because the routing seam is the same
  `extractPDFContent` export every test already mocks or exercises with the env var unset.
