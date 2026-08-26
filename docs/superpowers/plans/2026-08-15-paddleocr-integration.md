# PaddleOCR Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tesseract.js with PaddleOCR as the primary OCR engine for both text extraction (`pdf-extractor.ts`) and orientation classification (`orientation-detector.ts`), keeping Tesseract as an availability fallback.

**Architecture:** A standalone local Python/FastAPI service (`paddleocr-server/`) exposes `/health`, `/ocr`, `/orientation`. A new Node client (`src/infrastructure/paddleocr-client.ts`), structurally parallel to `ollama-client.ts`, calls it over HTTP and auto-spawns the process if unreachable. Both existing tesseract.js call sites try PaddleOCR first and fall back to their current Tesseract code only if the PaddleOCR call fails.

**Tech Stack:** Python 3 + FastAPI + uvicorn + PaddleOCR (server); Node/TypeScript + native `fetch`/`FormData`/`Blob` (client); Vitest (Node tests); pytest (Python tests).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-15-paddleocr-integration-design.md` — read it before starting; every task below implements one part of it.
- PaddleOCR is an **availability fallback, not a quality cascade** — Tesseract only runs when the PaddleOCR service call itself fails, never as a second opinion run every time.
- `paddleocr_engine.py` must lazy-import `paddleocr`/`paddlepaddle` (inside functions, not at module top-level) so `main.py` and its endpoint-shape unit tests stay importable/runnable without the heavy ML packages installed.
- Never throw out of a PaddleOCR call site in `pdf-extractor.ts`/`orientation-detector.ts` uncaught — always degrade to the existing Tesseract path, matching the pipeline's existing never-crash-the-scan philosophy.
- Node config additions follow the exact `CONFIG.OLLAMA_HOST`/`CONFIG.VISION_LAB_PORT` pattern in `src/infrastructure/settings.ts` (env override, sane default, no `settings.json` entry needed).
- Do not touch Vision Lab crop-detection code (`crop-detector.ts`, `flood-crop.ts`) — unrelated subsystem.
- Do not commit anything touching the user's personal test images in `<user-home>\Pictures\test` — not applicable to this feature (no such files are touched), noted here only because it's a standing constraint for this repo/session.

---

### Task 1: `paddleocr-server` — Python OCR service

**Files:**
- Create: `paddleocr-server/paddleocr_engine.py`
- Create: `paddleocr-server/main.py`
- Create: `paddleocr-server/requirements.txt`
- Create: `paddleocr-server/requirements-inference.txt`
- Create: `paddleocr-server/README.md`
- Create: `paddleocr-server/test_main.py`
- Create: `paddleocr-server/test_smoke.py`

**Interfaces:**
- Consumes: nothing from other tasks (first task).
- Produces: an HTTP service on `http://127.0.0.1:8871` (overridable via the `PORT` uvicorn is run with, see README) exposing:
  - `GET /health` → `{"status": "ok"}`
  - `POST /ocr` (multipart `file` field) → `{"text": "<recognized text>"}` or HTTP 500 `{"detail": "<error>"}`
  - `POST /orientation` (multipart `file` field) → `{"rotation_degrees": 0|90|180|270, "confidence": <float>}` or HTTP 500 `{"detail": "<error>"}`
  - Task 3's `paddleocr-client.ts` is the consumer of this HTTP surface.

- [ ] **Step 1: Write the failing tests**

Create `paddleocr-server/test_main.py`:

```python
import io
from unittest.mock import patch

from fastapi.testclient import TestClient

import main

client = TestClient(main.app)


def test_health_returns_ok():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_ocr_endpoint_returns_recognized_text():
    with patch("main.paddleocr_engine.recognize_text", return_value="Hello World"):
        resp = client.post(
            "/ocr", files={"file": ("test.png", io.BytesIO(b"fake-bytes"), "image/png")}
        )
    assert resp.status_code == 200
    assert resp.json() == {"text": "Hello World"}


def test_ocr_endpoint_returns_500_on_engine_error():
    with patch("main.paddleocr_engine.recognize_text", side_effect=ValueError("bad image")):
        resp = client.post(
            "/ocr", files={"file": ("test.png", io.BytesIO(b"fake-bytes"), "image/png")}
        )
    assert resp.status_code == 500
    assert resp.json()["detail"] == "bad image"


def test_orientation_endpoint_returns_rotation_and_confidence():
    with patch(
        "main.paddleocr_engine.detect_orientation",
        return_value={"rotation_degrees": 90, "confidence": 0.95},
    ):
        resp = client.post(
            "/orientation", files={"file": ("test.png", io.BytesIO(b"fake-bytes"), "image/png")}
        )
    assert resp.status_code == 200
    assert resp.json() == {"rotation_degrees": 90, "confidence": 0.95}


def test_orientation_endpoint_returns_500_on_engine_error():
    with patch(
        "main.paddleocr_engine.detect_orientation", side_effect=ValueError("no result")
    ):
        resp = client.post(
            "/orientation", files={"file": ("test.png", io.BytesIO(b"fake-bytes"), "image/png")}
        )
    assert resp.status_code == 500
    assert resp.json()["detail"] == "no result"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `paddleocr-server/`): `pytest test_main.py -v`
Expected: collection error — `ModuleNotFoundError: No module named 'main'` (neither `main.py` nor `paddleocr_engine.py` exist yet).

- [ ] **Step 3: Write the implementation**

Create `paddleocr-server/paddleocr_engine.py`:

```python
"""Thin wrapper around PaddleOCR's Python API.

Lazy-loads the heavy paddleocr/paddlepaddle packages only on first real use (inside
_get_ocr()/_get_orientation_model()), so this module — and main.py, which imports it — stays
importable and its endpoint-shape tests runnable with only the lightweight dependencies in
requirements.txt installed, without needing paddleocr's multi-GB model downloads.
"""
import numpy as np
import cv2

_ocr = None
_orientation_model = None


def _get_ocr():
    global _ocr
    if _ocr is None:
        from paddleocr import PaddleOCR

        _ocr = PaddleOCR(
            lang="fr",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    return _ocr


def _get_orientation_model():
    global _orientation_model
    if _orientation_model is None:
        from paddleocr import DocImgOrientationClassification

        _orientation_model = DocImgOrientationClassification(
            model_name="PP-LCNet_x1_0_doc_ori"
        )
    return _orientation_model


def _decode_image(image_bytes: bytes) -> np.ndarray:
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image bytes")
    return img


def recognize_text(image_bytes: bytes) -> str:
    img = _decode_image(image_bytes)
    results = _get_ocr().predict(img)
    lines = []
    for res in results:
        lines.extend(res.json["res"].get("rec_texts", []))
    return "\n".join(lines)


def detect_orientation(image_bytes: bytes) -> dict:
    img = _decode_image(image_bytes)
    results = _get_orientation_model().predict(img, batch_size=1)
    for res in results:
        data = res.json["res"]
        label = data["label_names"][0]
        score = float(data["scores"][0])
        return {"rotation_degrees": int(label), "confidence": score}
    raise ValueError("PaddleOCR orientation model returned no result")
```

Create `paddleocr-server/main.py`:

```python
"""Standalone local OCR service backing src/infrastructure/paddleocr-client.ts.

Run with: python main.py
See README.md for one-time dependency setup.
"""
from fastapi import FastAPI, UploadFile, File, HTTPException

import paddleocr_engine

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ocr")
async def ocr_endpoint(file: UploadFile = File(...)):
    image_bytes = await file.read()
    try:
        text = paddleocr_engine.recognize_text(image_bytes)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"text": text}


@app.post("/orientation")
async def orientation_endpoint(file: UploadFile = File(...)):
    image_bytes = await file.read()
    try:
        result = paddleocr_engine.detect_orientation(image_bytes)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return result


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8871)
```

Create `paddleocr-server/requirements.txt`:

```
fastapi==0.115.6
uvicorn[standard]==0.32.1
python-multipart==0.0.12
opencv-python-headless==4.10.0.84
numpy==1.26.4
pytest==8.3.4
httpx==0.28.1
Pillow==11.0.0
```

Create `paddleocr-server/requirements-inference.txt`:

```
paddlepaddle==3.0.0
paddleocr==3.5.0
```

Create `paddleocr-server/README.md`:

```markdown
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

## Testing

    pytest test_main.py -v

Endpoint-shape unit tests — the PaddleOCR engine calls are mocked, no real model needed.

    pytest test_smoke.py -v

Real end-to-end smoke test (one rendered image in, recognized text out). Skipped by default —
requires `requirements-inference.txt` installed and network access for the first model
download. Remove the `@pytest.mark.skip` decorator to run it locally.
```

- [ ] **Step 4: Install dependencies and run the tests to verify they pass**

Run (from `paddleocr-server/`):
```
pip install -r requirements.txt
pytest test_main.py -v
```
Expected: PASS (5 tests).

- [ ] **Step 5: Add the manual smoke test**

Create `paddleocr-server/test_smoke.py`:

```python
import io

import pytest
from PIL import Image, ImageDraw


@pytest.mark.skip(
    reason=(
        "Requires requirements-inference.txt installed and downloads PaddleOCR models on "
        "first run (network required) — slow. Run manually: comment out this skip decorator, "
        "then `pytest test_smoke.py -v`."
    )
)
def test_recognizes_real_text_from_a_rendered_image():
    import paddleocr_engine

    img = Image.new("RGB", (400, 150), color="white")
    draw = ImageDraw.Draw(img)
    draw.text((20, 50), "HELLO WORLD", fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")

    text = paddleocr_engine.recognize_text(buf.getvalue())
    assert "HELLO" in text.upper()
```

Run: `pytest test_smoke.py -v`
Expected: SKIPPED (1 skipped) — confirms it's wired up and collected, without running the heavy path.

- [ ] **Step 6: Commit**

```bash
git add paddleocr-server/
git commit -m "feat(paddleocr): add standalone PaddleOCR HTTP service"
```

---

### Task 2: Node config — `PADDLEOCR_HOST` / `PADDLEOCR_SPAWN_CMD`

**Files:**
- Modify: `src/infrastructure/settings.ts`
- Modify: `src/infrastructure/settings.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `CONFIG.PADDLEOCR_HOST: string`, `CONFIG.PADDLEOCR_SPAWN_CMD: string` — Task 3's `paddleocr-client.ts` consumes both.

- [ ] **Step 1: Write the failing tests**

In `src/infrastructure/settings.test.ts`, inside the existing `describe('CONFIG derivation at module load', ...)` block, add after the `'reads VISION_LAB_PORT from an env override'` test (before that describe block's closing `});`):

```ts
    it('defaults PADDLEOCR_HOST to http://127.0.0.1:8871 with no env override', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const original = process.env.PADDLEOCR_HOST;
      delete process.env.PADDLEOCR_HOST;
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.PADDLEOCR_HOST).toBe('http://127.0.0.1:8871');
      if (original !== undefined) process.env.PADDLEOCR_HOST = original;
    });

    it('reads PADDLEOCR_HOST from an env override', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const original = process.env.PADDLEOCR_HOST;
      process.env.PADDLEOCR_HOST = 'http://127.0.0.1:9999';
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.PADDLEOCR_HOST).toBe('http://127.0.0.1:9999');
      if (original === undefined) delete process.env.PADDLEOCR_HOST;
      else process.env.PADDLEOCR_HOST = original;
    });

    it('defaults PADDLEOCR_SPAWN_CMD to "python paddleocr-server/main.py" with no env override', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const original = process.env.PADDLEOCR_SPAWN_CMD;
      delete process.env.PADDLEOCR_SPAWN_CMD;
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.PADDLEOCR_SPAWN_CMD).toBe('python paddleocr-server/main.py');
      if (original !== undefined) process.env.PADDLEOCR_SPAWN_CMD = original;
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/infrastructure/settings.test.ts`
Expected: FAIL — 3 new tests fail with `expected undefined to be 'http://127.0.0.1:8871'` (etc.).

- [ ] **Step 3: Write the minimal implementation**

In `src/infrastructure/settings.ts`, in the `CONFIG` object, add after the `VISION_LAB_PORT` line:

```ts
  PADDLEOCR_HOST: process.env.PADDLEOCR_HOST || 'http://127.0.0.1:8871',
  PADDLEOCR_SPAWN_CMD: process.env.PADDLEOCR_SPAWN_CMD || 'python paddleocr-server/main.py',
```

In `.env.example`, add after the `VISION_LAB_PORT` block:

```
# PaddleOCR local service host. Defaults to http://127.0.0.1:8871. See paddleocr-server/README.md
# for one-time setup — Node auto-spawns this service if it isn't already running.
# PADDLEOCR_HOST=

# Command used to auto-spawn the PaddleOCR service if PADDLEOCR_HOST is unreachable. Override
# if your Python environment needs an explicit interpreter path (e.g. a venv).
# PADDLEOCR_SPAWN_CMD=python paddleocr-server/main.py
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/infrastructure/settings.test.ts`
Expected: PASS (all tests in the file, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/settings.ts src/infrastructure/settings.test.ts .env.example
git commit -m "feat(paddleocr): add PADDLEOCR_HOST/PADDLEOCR_SPAWN_CMD config"
```

---

### Task 3: `paddleocr-client.ts` — Node HTTP client

**Files:**
- Create: `src/infrastructure/paddleocr-client.ts`
- Create: `src/infrastructure/paddleocr-client.test.ts`

**Interfaces:**
- Consumes: `CONFIG.PADDLEOCR_HOST: string`, `CONFIG.PADDLEOCR_SPAWN_CMD: string` (Task 2).
- Produces:
  - `paddleOcrRecognize(imageBuffer: Buffer): Promise<string>` — Tasks 4 and 5 consume this.
  - `paddleOcrDetectOrientation(imageBuffer: Buffer): Promise<{ rotationDegrees: 0|90|180|270; confidence: number }>` — Task 6 consumes this.
  - `ensurePaddleOcrServer(): Promise<boolean>` — internal, used by the two functions above; not consumed directly by other tasks.

- [ ] **Step 1: Write the failing tests**

Create `src/infrastructure/paddleocr-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ensurePaddleOcrServer', () => {
  it('returns true immediately when /health already responds ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    const { ensurePaddleOcrServer } = await import('./paddleocr-client.js');
    const result = await ensurePaddleOcrServer();
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('auto-spawns the configured command and retries when /health first fails', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true });
    const execMock = vi.fn();
    vi.doMock('child_process', () => ({ exec: execMock }));

    const { ensurePaddleOcrServer } = await import('./paddleocr-client.js');
    const resultPromise = ensurePaddleOcrServer();
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('returns false when the server is still unreachable after every spawn retry', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    vi.doMock('child_process', () => ({ exec: vi.fn() }));

    const { ensurePaddleOcrServer } = await import('./paddleocr-client.js');
    const resultPromise = ensurePaddleOcrServer();
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe(false);
  });

  it('memoizes a successful result and does not re-check health on a second call', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    const { ensurePaddleOcrServer } = await import('./paddleocr-client.js');
    await ensurePaddleOcrServer();
    await ensurePaddleOcrServer();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('paddleOcrRecognize', () => {
  it('returns the recognized text when the server is already healthy', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true }) // /health
      .mockResolvedValueOnce({ ok: true, json: async () => ({ text: 'Hello World' }) }); // /ocr

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    const result = await paddleOcrRecognize(Buffer.from('fake-image'));

    expect(result).toBe('Hello World');
  });

  it('throws when the /ocr call fails after a healthy check', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true }) // /health
      .mockResolvedValueOnce({ ok: false, status: 500 }); // /ocr

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    await expect(paddleOcrRecognize(Buffer.from('x'))).rejects.toThrow('PaddleOCR /ocr returned 500');
  });

  it('throws without calling /ocr when the server cannot be reached or spawned', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED')); // every /health check fails
    vi.doMock('child_process', () => ({ exec: vi.fn() }));

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    const resultPromise = paddleOcrRecognize(Buffer.from('x'));
    await vi.runAllTimersAsync();
    await expect(resultPromise).rejects.toThrow('PaddleOCR server is unavailable');
  });
});

describe('paddleOcrDetectOrientation', () => {
  it('returns rotationDegrees and confidence when the server is healthy', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true }) // /health
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rotation_degrees: 90, confidence: 0.95 }) });

    const { paddleOcrDetectOrientation } = await import('./paddleocr-client.js');
    const result = await paddleOcrDetectOrientation(Buffer.from('x'));

    expect(result).toEqual({ rotationDegrees: 90, confidence: 0.95 });
  });

  it('throws when the server returns an invalid rotation value', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rotation_degrees: 45, confidence: 0.5 }) });

    const { paddleOcrDetectOrientation } = await import('./paddleocr-client.js');
    await expect(paddleOcrDetectOrientation(Buffer.from('x'))).rejects.toThrow(/invalid rotation_degrees/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/infrastructure/paddleocr-client.test.ts`
Expected: FAIL — `Cannot find module './paddleocr-client.js'` (file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/infrastructure/paddleocr-client.ts`:

```ts
import { CONFIG } from './settings.js';

export interface PaddleOcrOrientationResult {
  rotationDegrees: 0 | 90 | 180 | 270;
  confidence: number;
}

const VALID_ROTATIONS = [0, 90, 180, 270];

// Retry-poll delays after auto-spawning, in ms — PaddleOCR's model load is heavier than
// Ollama's (ensureOllamaModel uses a single flat 2000ms sleep), so this polls a few times
// with backoff instead, ~15s total before giving up.
const SPAWN_RETRY_DELAYS_MS = [2000, 3000, 5000, 5000];

let serverReadyPromise: Promise<boolean> | null = null;

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${CONFIG.PADDLEOCR_HOST}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

// Mirrors ensureOllamaModel()'s health-check-then-spawn-then-retry shape in ollama-client.ts.
// Memoized per process lifetime — once confirmed ready, later calls skip the health check
// entirely (see the "memoizes a successful result" test).
export async function ensurePaddleOcrServer(): Promise<boolean> {
  if (serverReadyPromise) return serverReadyPromise;
  serverReadyPromise = (async () => {
    if (await checkHealth()) return true;
    try {
      const { exec } = await import('child_process');
      exec(CONFIG.PADDLEOCR_SPAWN_CMD, { windowsHide: true });
    } catch (err: any) {
      console.error('Failed to auto-spawn PaddleOCR server:', err.message);
      return false;
    }
    for (const delay of SPAWN_RETRY_DELAYS_MS) {
      await new Promise(r => setTimeout(r, delay));
      if (await checkHealth()) return true;
    }
    return false;
  })();
  return serverReadyPromise;
}

export async function paddleOcrRecognize(imageBuffer: Buffer): Promise<string> {
  const ready = await ensurePaddleOcrServer();
  if (!ready) throw new Error('PaddleOCR server is unavailable');

  const form = new FormData();
  form.append('file', new Blob([imageBuffer]), 'image.png');

  const res = await fetch(`${CONFIG.PADDLEOCR_HOST}/ocr`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`PaddleOCR /ocr returned ${res.status}`);
  const data: any = await res.json();
  return typeof data.text === 'string' ? data.text : '';
}

export async function paddleOcrDetectOrientation(imageBuffer: Buffer): Promise<PaddleOcrOrientationResult> {
  const ready = await ensurePaddleOcrServer();
  if (!ready) throw new Error('PaddleOCR server is unavailable');

  const form = new FormData();
  form.append('file', new Blob([imageBuffer]), 'image.png');

  const res = await fetch(`${CONFIG.PADDLEOCR_HOST}/orientation`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`PaddleOCR /orientation returned ${res.status}`);
  const data: any = await res.json();
  if (!VALID_ROTATIONS.includes(data.rotation_degrees)) {
    throw new Error(`PaddleOCR /orientation returned invalid rotation_degrees: ${data.rotation_degrees}`);
  }
  const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
  return { rotationDegrees: data.rotation_degrees, confidence };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/infrastructure/paddleocr-client.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/paddleocr-client.ts src/infrastructure/paddleocr-client.test.ts
git commit -m "feat(paddleocr): add Node HTTP client with auto-spawn"
```

---

### Task 4: Swap `pdf-extractor.ts`'s scanned-PDF OCR path (`ocrPdfPagesWithCanvas`)

**Files:**
- Modify: `src/infrastructure/pdf-extractor.ts:148-185` (the `ocrPdfPagesWithCanvas` function)
- Modify: `src/infrastructure/pdf-extractor.test.ts`

**Interfaces:**
- Consumes: `paddleOcrRecognize(imageBuffer: Buffer): Promise<string>` (Task 3).
- Produces: nothing new consumed by later tasks — `ocrPdfPagesWithCanvas`'s public signature is unchanged.

- [ ] **Step 1: Write the failing test**

In `src/infrastructure/pdf-extractor.test.ts`, add `vi`, `beforeEach` to the existing `import { describe, it, expect } from 'vitest';` (making it `import { describe, it, expect, vi, beforeEach } from 'vitest';`), then add near the top of the file, after the imports:

```ts
const { paddleOcrRecognizeMock } = vi.hoisted(() => ({ paddleOcrRecognizeMock: vi.fn() }));
vi.mock('./paddleocr-client.js', () => ({ paddleOcrRecognize: paddleOcrRecognizeMock }));

beforeEach(() => {
  paddleOcrRecognizeMock.mockReset();
  // Default: simulate "no local PaddleOCR service running", which is also what actually
  // happens in this test environment — every existing OCR test below continues exercising
  // the real Tesseract fallback path exactly as before this mock was added.
  paddleOcrRecognizeMock.mockRejectedValue(new Error('PaddleOCR server is unavailable'));
});
```

Then, inside the `describe('extractPDFContent — 3-tier fallback pipeline', ...)` block, add this test after the existing `'falls through to offline Tesseract OCR for an image-only (scanned) PDF'` test:

```ts
  it('uses PaddleOCR text when the service succeeds for a scanned PDF (Tier 3)', async () => {
    paddleOcrRecognizeMock.mockResolvedValue('PADDLEOCR-PRIMARY-PATH-MARKER');

    const bytes = await buildImageOnlyPdf('HELLO WORLD');
    const filePath = writeTempPdf(bytes, 'scanned-paddleocr.pdf');
    try {
      const result = await extractPDFContent(filePath);
      expect(result.raw_text).toContain('PADDLEOCR-PRIMARY-PATH-MARKER');
    } finally {
      fs.unlinkSync(filePath);
    }
  }, 60_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/infrastructure/pdf-extractor.test.ts -t "uses PaddleOCR text when the service succeeds for a scanned PDF"`
Expected: FAIL — `result.raw_text` contains real Tesseract-recognized text ("HELLO WORLD"-ish), not `'PADDLEOCR-PRIMARY-PATH-MARKER'` (the code doesn't call `paddleOcrRecognize` yet).

- [ ] **Step 3: Write the minimal implementation**

In `src/infrastructure/pdf-extractor.ts`, add the import near the top (after the `cleanExtractedText` import):

```ts
import { paddleOcrRecognize } from './paddleocr-client.js';
```

Replace the body of `ocrPdfPagesWithCanvas` (lines 149-185) with:

```ts
// Tries PaddleOCR first (better accuracy on real scanned/photographed documents); falls back
// to the local Tesseract worker only if the PaddleOCR service call fails — an availability
// fallback, not a quality cascade (only one good text result is needed here).
async function ocrPageBuffer(pngBuf: Buffer): Promise<string> {
  try {
    return await paddleOcrRecognize(pngBuf);
  } catch (err: any) {
    logger.debug('PDF_PARSER', `PaddleOCR unavailable, falling back to Tesseract: ${err.message}`);
    const worker = await getSharedTesseractWorker();
    const res = await worker.recognize(pngBuf);
    return res?.data?.text || '';
  }
}

// Fallback 2: High-fidelity Canvas Page Rendering + OCR (for scanned photos, sliced images, & vector path PDFs)
export async function ocrPdfPagesWithCanvas(buffer: Buffer, maxPages = 3): Promise<string> {
  try {
    const loadingTask = (pdfjsLib as any).getDocument({
      data: new Uint8Array(buffer),
      ignoreErrors: true,
      useSystemFonts: true
    });
    const doc = await loadingTask.promise;
    const ocrTexts: string[] = [];
    const numPages = Math.min(doc.numPages, maxPages);

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      try {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');
        await page.render({ canvasContext: context, viewport }).promise;
        const pngBuf = canvas.toBuffer('image/png');

        const text = await ocrPageBuffer(pngBuf);
        if (text && text.trim().length > 10) {
          ocrTexts.push(text.trim());
        }
      } catch (pageErr: any) {
        logger.debug('PDF_PARSER', `Canvas OCR failed on page ${pageNum}: ${pageErr.message}`);
      }
    }

    return ocrTexts.join('\n\n');
  } catch (err: any) {
    logger.warn('PDF_PARSER', `Full-page canvas OCR failed: ${err.message}`);
    return '';
  }
}
```

Note: `getSharedTesseractWorker()` is unchanged and still used inside `ocrPageBuffer`'s catch branch.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/infrastructure/pdf-extractor.test.ts`
Expected: PASS — all existing tests in the file still pass (they exercise the Tesseract fallback via the default-rejecting mock), plus the new test.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/pdf-extractor.ts src/infrastructure/pdf-extractor.test.ts
git commit -m "feat(paddleocr): use PaddleOCR for scanned-PDF OCR, Tesseract as fallback"
```

---

### Task 5: Swap `pdf-extractor.ts`'s standalone image-file OCR branch

**Files:**
- Modify: `src/infrastructure/pdf-extractor.ts:333-352` (the image-file branch in `extractPDFContent`)
- Modify: `src/infrastructure/pdf-extractor.test.ts`

**Interfaces:**
- Consumes: `paddleOcrRecognize` (Task 3, already imported into this file by Task 4) and the `paddleOcrRecognizeMock` test harness (already set up in this test file by Task 4).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing test**

In `src/infrastructure/pdf-extractor.test.ts`, add this test in a new `describe` block (place it after the `describe('extractPDFContent — 3-tier fallback pipeline', ...)` block closes):

```ts
describe('extractPDFContent — standalone image files', () => {
  it('uses PaddleOCR text for a standalone image file when the service succeeds', async () => {
    paddleOcrRecognizeMock.mockResolvedValue('PADDLEOCR-IMAGE-MARKER');

    const canvas = createCanvas(200, 100);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 200, 100);
    const pngBytes = canvas.toBuffer('image/png');
    const filePath = writeTempPdf(pngBytes, 'standalone.png');
    try {
      const result = await extractPDFContent(filePath);
      expect(result.raw_text).toContain('PADDLEOCR-IMAGE-MARKER');
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('falls back to Tesseract for a standalone image file when the PaddleOCR service fails', async () => {
    paddleOcrRecognizeMock.mockRejectedValue(new Error('PaddleOCR server is unavailable'));

    const canvas = createCanvas(500, 260);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 500, 260);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 72px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('HELLO WORLD', 20, 90);
    const pngBytes = canvas.toBuffer('image/png');
    const filePath = writeTempPdf(pngBytes, 'standalone-fallback.png');
    try {
      const result = await extractPDFContent(filePath);
      expect(result.raw_text.toUpperCase()).toContain('HELLO');
    } finally {
      fs.unlinkSync(filePath);
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/infrastructure/pdf-extractor.test.ts -t "standalone image file"`
Expected: FAIL — the primary-path test fails because the current code always calls Tesseract directly, never `paddleOcrRecognize`, so `raw_text` never contains `'PADDLEOCR-IMAGE-MARKER'`. (The fallback test passes already since it already goes through real Tesseract — that's fine, it becomes a regression guard once the swap lands.)

- [ ] **Step 3: Write the minimal implementation**

In `src/infrastructure/pdf-extractor.ts`, replace the image-file branch inside `extractPDFContent` (the `if (['.png', '.jpg', ...` block):

```ts
  // Image files (.png, .jpg, .jpeg, .webp, .bmp, .tiff)
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'].includes(ext)) {
    logger.info('PDF_PARSER', `Running OCR for image file '${filename}'...`);
    let ocrText = '';
    try {
      ocrText = await paddleOcrRecognize(fileBuffer);
    } catch (paddleErr: any) {
      logger.debug('PDF_PARSER', `PaddleOCR unavailable for image ${filename}, falling back to Tesseract: ${paddleErr.message}`);
      try {
        const worker = await createWorker('fra+eng');
        const ret = await worker.recognize(fileBuffer);
        ocrText = ret.data.text || '';
        await worker.terminate();
      } catch (ocrErr: any) {
        logger.warn('PDF_PARSER', `Tesseract OCR failed for image ${filename}: ${ocrErr.message}`);
      }
    }
    const cleaned = cleanExtractedText(ocrText, filename);
    return {
      checksum,
      raw_text: cleaned ? `[OCR Extracted Text]\n\n${cleaned}` : `[Image file: ${filename}]`,
      numpages: 1,
      info: { title: filename }
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/infrastructure/pdf-extractor.test.ts`
Expected: PASS — full file, including both new tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/pdf-extractor.ts src/infrastructure/pdf-extractor.test.ts
git commit -m "feat(paddleocr): use PaddleOCR for standalone image-file OCR, Tesseract as fallback"
```

---

### Task 6: Swap `orientation-detector.ts`'s OSD tiebreaker

**Files:**
- Modify: `src/infrastructure/orientation-detector.ts`
- Modify: `src/infrastructure/orientation-detector.test.ts`

**Interfaces:**
- Consumes: `paddleOcrDetectOrientation(imageBuffer: Buffer): Promise<{ rotationDegrees: 0|90|180|270; confidence: number }>` (Task 3).
- Produces: `detectOrientationCascade`'s public return shape (`OrientationDetectionResult`) is unchanged — no other task consumes this.

- [ ] **Step 1: Write the failing test**

In `src/infrastructure/orientation-detector.test.ts`, add a mock for the new client module (after the existing `tesseract.js` mock block):

```ts
const { paddleOcrDetectOrientationMock } = vi.hoisted(() => ({ paddleOcrDetectOrientationMock: vi.fn() }));
vi.mock('./paddleocr-client.js', () => ({ paddleOcrDetectOrientation: paddleOcrDetectOrientationMock }));
```

Update the existing `beforeEach` to also reset/default this mock:

```ts
beforeEach(() => {
  vi.resetAllMocks();
  createWorkerMock.mockResolvedValue({ detect: detectMock });
  // Default: simulate "no local PaddleOCR service running" — the existing tests below
  // continue exercising the Tesseract OSD fallback path exactly as before this mock was added.
  paddleOcrDetectOrientationMock.mockRejectedValue(new Error('PaddleOCR server is unavailable'));
});
```

Then add a new test at the end of the `describe('detectOrientationCascade', ...)` block:

```ts
  it('uses PaddleOCR as the tiebreaker and skips Tesseract OSD when it succeeds', async () => {
    parseExifOrientationMock.mockReturnValue(3);
    exifOrientationToDegreesMock.mockReturnValue(180);
    detectOrientationMock.mockResolvedValue({ rotationDegrees: 0, raw: '{"rotationDegrees":0}' });
    paddleOcrDetectOrientationMock.mockResolvedValue({ rotationDegrees: 90, confidence: 0.97 });

    const { detectOrientationCascade } = await import('./orientation-detector.js');
    const result = await detectOrientationCascade(Buffer.from('x'));

    expect(result.source).toBe('ocr-tiebreaker');
    expect(result.rotationDegrees).toBe(90);
    expect(result.ocrDegrees).toBe(90);
    expect(result.ocrConfidence).toBe(0.97);
    expect(detectMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `npx vitest run src/infrastructure/orientation-detector.test.ts -t "uses PaddleOCR as the tiebreaker"`
Expected: FAIL — `detectMock` (Tesseract OSD) is called and its mocked value (unset, so `undefined`/inconclusive) drives the result, not PaddleOCR's `{rotationDegrees: 90}`.

- [ ] **Step 3: Write the minimal implementation**

In `src/infrastructure/orientation-detector.ts`, add the import (after the `vision-client.js` import):

```ts
import { paddleOcrDetectOrientation } from './paddleocr-client.js';
```

Add this helper function before `detectOrientationCascade`:

```ts
// Tries PaddleOCR's document-orientation classifier first (generally more robust on real
// phone photos); falls back to Tesseract OSD only if the PaddleOCR service call fails — an
// availability fallback, not a second opinion.
async function getOcrOrientationTiebreaker(
  imageBuffer: Buffer
): Promise<{ ocrDegrees: 0 | 90 | 180 | 270 | null; ocrConfidence: number | null }> {
  try {
    const { rotationDegrees, confidence } = await paddleOcrDetectOrientation(imageBuffer);
    return { ocrDegrees: rotationDegrees, ocrConfidence: confidence };
  } catch (err: any) {
    const worker = await getSharedOsdWorker();
    const { data } = await worker.detect(imageBuffer);
    const rawOcrDegrees = data.orientation_degrees;
    const ocrDegrees = (typeof rawOcrDegrees === 'number' && VALID_ROTATIONS.includes(rawOcrDegrees) ? rawOcrDegrees : null) as 0 | 90 | 180 | 270 | null;
    const ocrConfidence = typeof data.orientation_confidence === 'number' ? data.orientation_confidence : null;
    return { ocrDegrees, ocrConfidence };
  }
}
```

Replace this block inside `detectOrientationCascade`:

```ts
  const worker = await getSharedOsdWorker();
  const { data } = await worker.detect(imageBuffer);
  const rawOcrDegrees = data.orientation_degrees;
  const ocrDegrees = (typeof rawOcrDegrees === 'number' && VALID_ROTATIONS.includes(rawOcrDegrees) ? rawOcrDegrees : null) as 0 | 90 | 180 | 270 | null;
  const ocrConfidence = typeof data.orientation_confidence === 'number' ? data.orientation_confidence : null;
```

with:

```ts
  const { ocrDegrees, ocrConfidence } = await getOcrOrientationTiebreaker(imageBuffer);
```

(the `return { rotationDegrees: ocrDegrees !== null ? ocrDegrees : modelDegrees, ..., source: 'ocr-tiebreaker' };` statement immediately after stays unchanged, since it already just references `ocrDegrees`/`ocrConfidence`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/infrastructure/orientation-detector.test.ts`
Expected: PASS — all existing tests (still exercising the Tesseract OSD fallback via the default-rejecting mock) plus the new PaddleOCR-primary-path test.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/orientation-detector.ts src/infrastructure/orientation-detector.test.ts
git commit -m "feat(paddleocr): use PaddleOCR for orientation tiebreaker, Tesseract OSD as fallback"
```

---

### Task 7: Full verification pass

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing — this is the final gate.

- [ ] **Step 1: Run the full Node test suite**

Run: `npm test`
Expected: PASS — no regressions in any existing suite (crop-detector, flood-crop, classification, etc. are untouched by this plan).

- [ ] **Step 2: Run the typecheck**

Run: `npm run typecheck`
Expected: PASS — no new type errors from `paddleocr-client.ts` or the two modified files (pre-existing unrelated errors, if any, are out of scope for this plan).

- [ ] **Step 3: Run the Python endpoint tests**

Run (from `paddleocr-server/`): `pytest test_main.py -v`
Expected: PASS (5 tests, as in Task 1).

- [ ] **Step 4: Manual note for the user**

No commit needed for this step — report to the user that:
- `paddleocr-server/` needs `pip install -r requirements.txt` (and, for real OCR, `-r requirements-inference.txt`) run once before `npm run dev` will get real PaddleOCR results instead of falling back to Tesseract.
- Until that's done, the app behaves exactly as it does today (Tesseract), since every PaddleOCR call site degrades gracefully when the service is unreachable.
