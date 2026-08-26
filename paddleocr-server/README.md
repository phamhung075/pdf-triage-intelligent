# paddleocr-server

Standalone local OCR service used by `src/infrastructure/paddleocr-client.ts`. Mirrors how
Ollama runs as a separate local process this project talks to over HTTP.

## One-time setup

    pip install -r requirements.txt

This installs only the lightweight web-service dependencies (FastAPI, OpenCV, pytest) — enough
to run `python main.py` and the unit tests in `test_main.py`. It does NOT install PaddleOCR
itself; `paddleocr_engine.py` imports `paddleocr`/`paddlepaddle` lazily, only when an `/ocr` or
`/orientation` request actually needs the model. Before running the server for real (or the
manual smoke test below), also run:

    pip install -r requirements-inference.txt

This pulls in `paddlepaddle` + `paddleocr` and, on first real request, downloads the OCR and
orientation-classification models (network access required, one-time).

## Running

    python main.py

Serves on `http://127.0.0.1:8871` by default — matches `CONFIG.PADDLEOCR_HOST` in
`src/infrastructure/settings.ts`. `src/infrastructure/paddleocr-client.ts` auto-spawns this
exact command (`CONFIG.PADDLEOCR_SPAWN_CMD`) if the service isn't already reachable — see
`ensurePaddleOcrServer()`.

`startWebServer` also *kills* this process on boot (`takeOverPaddleOcrServer()`) so a `npm run dev`
restart always reloads the code in this directory — a stale service answers `/health` perfectly
well and would otherwise be reused indefinitely.

## Endpoints

| | |
| --- | --- |
| `GET /health` | Answers as soon as the process is up, **before** the models are warm. This is what the client's ~15s spawn poll waits on, so it must never block on model loading. |
| `GET /ready` | `{ready, ocr, orientation, warming}` — whether the heavy models are actually loaded. Read lock-free, so it still answers during a multi-minute OCR pass. The client waits on this before starting its inference timeout, so a cold start no longer spends that budget on loading. `warming: false` with `ocr: false` means the warm-up finished or failed and nothing more is coming. |
| `POST /ocr` | Text recognition. Serialized behind a per-model lock. |
| `POST /orientation` | Document rotation. Serialized behind its own lock, so it never queues behind an OCR pass. |

Both inference endpoints are sync `def`, not `async def`, so Starlette runs them in its threadpool
and `/health` stays answerable while inference is running. See the comments in `main.py`.

## Testing

    pytest test_main.py -v

Endpoint-shape unit tests — the PaddleOCR engine calls are mocked, no real model needed.

    pytest test_smoke.py -v

Real end-to-end smoke test (one rendered image in, recognized text out). Skipped by default —
requires `requirements-inference.txt` installed and network access for the first model
download. Remove the `@pytest.mark.skip` decorator to run it locally.
