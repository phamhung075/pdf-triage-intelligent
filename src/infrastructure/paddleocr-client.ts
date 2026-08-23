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

// Text recognition is the slow one and it scales with how much text is on the page, not with the
// file size: a dense French payslip measured 215s end-to-end on a CPU-only machine (192 text lines,
// PP-OCRv5 detection + per-line recognition). The previous 120s budget was therefore shorter than a
// normal result on ordinary hardware — PaddleOCR was aborted mid-inference on every dense document
// and the caller silently fell back to Tesseract, so the better engine's output was never seen.
// 300s leaves headroom above that measurement; Tesseract still backstops anything slower.
const OCR_TIMEOUT_MS = 300_000;

// Orientation runs a single small classifier over one downscaled image and returns in a couple of
// seconds, so it keeps a much tighter budget — a slow answer here means the service is wedged, and
// failing fast lets the caller fall back to Tesseract OSD instead of stalling the pipeline.
const ORIENTATION_TIMEOUT_MS = 120_000;

let serverReadyPromise: Promise<boolean> | null = null; // memoized only on success
let spawnAttempted = false; // whether the exec+poll sequence has been tried this process lifetime

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${CONFIG.PADDLEOCR_HOST}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function attemptEnsure(): Promise<boolean> {
  if (await checkHealth()) return true;
  if (spawnAttempted) {
    // Already tried to auto-spawn once this process lifetime — don't repeat exec+poll
    // (which costs ~15s and, on Windows with no Python installed, repeatedly hits the
    // python.exe App Execution Alias stub). Just report not-ready from the fresh health
    // check above; a later call will notice quickly and cheaply once the service is up.
    return false;
  }
  spawnAttempted = true;
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
}

function buildImageForm(imageBuffer: Buffer): FormData {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(imageBuffer)]), 'image.png');
  return form;
}

// Mirrors ensureOllamaModel()'s health-check-then-spawn-then-retry shape in ollama-client.ts.
// Memoized per process lifetime once confirmed ready (later calls skip the health check
// entirely — see the "memoizes a successful result" test). A failure is NOT memoized (so a
// service that comes up later is noticed on the next call), but the exec+poll spawn attempt
// itself only ever runs once (see `spawnAttempted` above) — later calls after a failure just
// do one cheap health re-check instead of repeating the full ~15s sequence.
export async function ensurePaddleOcrServer(): Promise<boolean> {
  if (serverReadyPromise) return serverReadyPromise;
  const promise = attemptEnsure();
  serverReadyPromise = promise; // shared by concurrent callers while this attempt is in flight
  const ready = await promise;
  if (!ready) serverReadyPromise = null;
  return ready;
}

export async function paddleOcrRecognize(imageBuffer: Buffer): Promise<string> {
  const ready = await ensurePaddleOcrServer();
  if (!ready) throw new Error('PaddleOCR server is unavailable');

  const form = buildImageForm(imageBuffer);

  const res = await fetch(`${CONFIG.PADDLEOCR_HOST}/ocr`, { method: 'POST', body: form, signal: AbortSignal.timeout(OCR_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`PaddleOCR /ocr returned ${res.status}`);
  const data: any = await res.json();
  if (typeof data.text !== 'string') {
    throw new Error('PaddleOCR /ocr returned an unexpected response shape (missing text field)');
  }
  return data.text;
}

export async function paddleOcrDetectOrientation(imageBuffer: Buffer): Promise<PaddleOcrOrientationResult> {
  const ready = await ensurePaddleOcrServer();
  if (!ready) throw new Error('PaddleOCR server is unavailable');

  const form = buildImageForm(imageBuffer);

  const res = await fetch(`${CONFIG.PADDLEOCR_HOST}/orientation`, { method: 'POST', body: form, signal: AbortSignal.timeout(ORIENTATION_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`PaddleOCR /orientation returned ${res.status}`);
  const data: any = await res.json();
  if (!VALID_ROTATIONS.includes(data.rotation_degrees)) {
    throw new Error(`PaddleOCR /orientation returned invalid rotation_degrees: ${data.rotation_degrees}`);
  }
  const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
  return { rotationDegrees: data.rotation_degrees, confidence };
}
