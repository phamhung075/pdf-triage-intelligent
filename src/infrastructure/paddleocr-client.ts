import { CONFIG } from './settings.js';
import { killProcessOnPort } from './pid-lock.js';
import { readImageDimensions } from '../domain/image-dimensions.js';

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
// PP-OCRv5 detection + per-line recognition). A 120s budget was shorter than a normal result on
// ordinary hardware — PaddleOCR was aborted mid-inference on every dense document and the caller
// silently fell back to Tesseract, so the better engine's output was never seen.
//
// This budget must cover INFERENCE ONLY. Two other things used to be spent inside it, and both are
// now excluded:
//   - model loading, gated by waitForPaddleOcrModel() against /ready;
//   - queue time, because runExclusive() serializes inference in this process, so a request is only
//     sent once the previous one has finished.
// That mattered: observed successful passes run 100-230s against a 300s budget, so one request
// waiting behind another was on its own enough to blow it.
//
// What remains is scaled by the page's own geometry — a page rendered at twice the area holds
// roughly twice as much to read, so it gets twice the budget. The floor is the measured dense-A4
// case; the cap stops a wedged server from stalling a scan indefinitely, with Tesseract backstopping.
const OCR_TIMEOUT_FLOOR_MS = 300_000;
// A4 at the scale 2.0 that ocrPdfPagesWithCanvas renders with is ~1190x1684 ≈ 2.0 megapixels.
const OCR_REFERENCE_MEGAPIXELS = 2.0;
const OCR_TIMEOUT_CAP_MS = 1_200_000;

export function ocrTimeoutFor(imageBuffer: Buffer): number {
  const dimensions = readImageDimensions(imageBuffer);
  // No geometry means no information. Falling back to the floor is the honest choice — deriving a
  // budget from byte length instead would silently change how long a document is allowed to take,
  // and file size is a poor proxy for OCR time (a photo of a blank wall is large and instant).
  if (!dimensions) return OCR_TIMEOUT_FLOOR_MS;
  const megapixels = (dimensions.width * dimensions.height) / 1_000_000;
  const scaled = Math.round(OCR_TIMEOUT_FLOOR_MS * (megapixels / OCR_REFERENCE_MEGAPIXELS));
  return Math.min(OCR_TIMEOUT_CAP_MS, Math.max(OCR_TIMEOUT_FLOOR_MS, scaled));
}

// Orientation runs a single small classifier over one downscaled image and returns in a couple of
// seconds, so it keeps a much tighter budget — a slow answer here means the service is wedged, and
// failing fast lets the caller fall back to Tesseract OSD instead of stalling the pipeline.
const ORIENTATION_TIMEOUT_MS = 120_000;

// Readiness polling. /health answers the instant the process is up — deliberately, so the ~15s
// spawn poll below succeeds — but the models are still loading behind it, and a request landing in
// that window simply waits on the same lazy getter. Starting the inference timer at that moment is
// what made a cold start after a dev-server restart spend its entire budget on model loading and
// then fall back to Tesseract.
const READY_POLL_INTERVAL_MS = 2000;
const READY_MAX_WAIT_MS = 900_000;

// A 5xx from /ocr means the service is UP but that one inference failed — historically a
// concurrent predict() on the shared, non-thread-safe PaddleOCR model (now serialized
// server-side, see paddleocr-server/paddleocr_engine.py). Treating that first blip as final
// silently downgraded the page to Tesseract, and nothing in the result said so: on a
// photographed ID card PaddleOCR returned the clean numbered form fields where Tesseract returned
// line noise ('3 > U NI NV me'), so a re-analysis came back worse than the original triage with no
// error anywhere. One cheap retry keeps the better engine.
//
// Deliberately NOT retried: 4xx (a rejected request fails identically the second time) and
// timeouts (the budget above is already generous — retrying would double the worst case before the
// caller ever gets to fall back to Tesseract).
const OCR_RETRY_DELAY_MS = 1500;

class TransientPaddleOcrError extends Error {}

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

// Serializes the inference work issued by THIS process, so queue time is spent outside a request's
// own timeout instead of inside it. The server's per-model lock is the correctness backstop (it has
// to hold against any client, including a second Node process); this is what keeps the client's
// budget honest about what it is actually measuring.
let inferenceQueue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  // Chained off BOTH outcomes: one failed request must not wedge the queue for every later one.
  const run = inferenceQueue.then(task, task);
  inferenceQueue = run.then(() => undefined, () => undefined);
  return run;
}

// Returns null when the server cannot tell us — no /ready (an older build), unreachable, or an
// unexpected shape — so the caller proceeds ungated instead of stalling against a service that
// simply predates this endpoint.
async function probeReady(model: 'ocr' | 'orientation'): Promise<{ loaded: boolean; warming: boolean } | null> {
  try {
    const res = await fetch(`${CONFIG.PADDLEOCR_HOST}/ready`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (typeof data?.warming !== 'boolean') return null;
    return { loaded: data[model] === true, warming: data.warming };
  } catch {
    return null;
  }
}

// Waits for `model` to finish loading. True means it confirmed the model is ready; false means
// "proceed anyway". Callers must never treat this as a hard gate — a server whose warm-up failed
// would then block OCR forever instead of letting the request attempt its own lazy load.
export async function waitForPaddleOcrModel(
  model: 'ocr' | 'orientation',
  maxWaitMs: number = READY_MAX_WAIT_MS
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const state = await probeReady(model);
    if (state === null) return false;
    if (state.loaded) return true;
    // warming:false with the model still unloaded means nothing more is coming — the warm-up
    // finished or failed. Waiting past that point would burn the budget for no reason.
    if (!state.warming) return false;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
}

// Restarts the local PaddleOCR service so it re-loads paddleocr-server/ from disk.
//
// Why this is needed at all: the service is a SEPARATE, long-lived Python process that survives a
// dev-server restart, and a stale one answers /health perfectly well — so ensurePaddleOcrServer()
// reuses it and any edit under paddleocr-server/ silently never takes effect. Restarting `npm run
// dev` alone was therefore not enough to pick up the inference lock that fixes concurrent /ocr
// 500s; the process had to be killed by hand first. This is the same reasoning as the HTTP port
// takeover in web-server.ts: a restart must mean current code.
//
// Only ever touches a LOOPBACK host. killProcessOnPort kills whatever local PID holds that port
// number, so if PADDLEOCR_HOST points at another machine the local process on 8871 is some
// unrelated program and killing it would be pure collateral damage.
export async function takeOverPaddleOcrServer(): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(CONFIG.PADDLEOCR_HOST);
  } catch {
    return false;
  }
  const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];
  if (!LOOPBACK.includes(url.hostname)) return false;

  const port = parseInt(url.port, 10);
  if (!Number.isInteger(port)) return false;

  const killed = await killProcessOnPort(port);

  // Clear BOTH guards, not just the readiness memo: spawnAttempted is a once-per-process latch, so
  // leaving it set would stop the next OCR call from spawning the replacement we just made room for.
  serverReadyPromise = null;
  spawnAttempted = false;

  return killed;
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

// Builds a fresh FormData per attempt on purpose — a request body is consumed by the fetch that
// sends it and cannot be replayed on the retry.
async function requestOcr(imageBuffer: Buffer): Promise<string> {
  const form = buildImageForm(imageBuffer);

  // The abort signal is created HERE, as the request actually goes out — not when it was queued —
  // so time spent waiting behind another page never counts against this page's budget.
  const res = await fetch(`${CONFIG.PADDLEOCR_HOST}/ocr`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(ocrTimeoutFor(imageBuffer)),
  });
  if (!res.ok) {
    const message = `PaddleOCR /ocr returned ${res.status}`;
    throw res.status >= 500 ? new TransientPaddleOcrError(message) : new Error(message);
  }
  const data: any = await res.json();
  if (typeof data.text !== 'string') {
    throw new Error('PaddleOCR /ocr returned an unexpected response shape (missing text field)');
  }
  return data.text;
}

export async function paddleOcrRecognize(imageBuffer: Buffer): Promise<string> {
  const ready = await ensurePaddleOcrServer();
  if (!ready) throw new Error('PaddleOCR server is unavailable');

  // Outside the queue: this is polling, not inference, and holding the queue while every caller
  // waits on the same warm-up would serialize the wait for no reason.
  await waitForPaddleOcrModel('ocr');

  return runExclusive(async () => {
    try {
      return await requestOcr(imageBuffer);
    } catch (err) {
      if (!(err instanceof TransientPaddleOcrError)) throw err;
      await new Promise(r => setTimeout(r, OCR_RETRY_DELAY_MS));
      return requestOcr(imageBuffer);
    }
  });
}

export async function paddleOcrDetectOrientation(imageBuffer: Buffer): Promise<PaddleOcrOrientationResult> {
  const ready = await ensurePaddleOcrServer();
  if (!ready) throw new Error('PaddleOCR server is unavailable');

  await waitForPaddleOcrModel('orientation');

  const res = await runExclusive(() => fetch(`${CONFIG.PADDLEOCR_HOST}/orientation`, {
    method: 'POST',
    body: buildImageForm(imageBuffer),
    signal: AbortSignal.timeout(ORIENTATION_TIMEOUT_MS),
  }));
  if (!res.ok) throw new Error(`PaddleOCR /orientation returned ${res.status}`);
  const data: any = await res.json();
  if (!VALID_ROTATIONS.includes(data.rotation_degrees)) {
    throw new Error(`PaddleOCR /orientation returned invalid rotation_degrees: ${data.rotation_degrees}`);
  }
  const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
  return { rotationDegrees: data.rotation_degrees, confidence };
}
