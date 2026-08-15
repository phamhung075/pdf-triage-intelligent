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
  const promise = (async () => {
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
  serverReadyPromise = promise;
  const ready = await promise;
  if (!ready) serverReadyPromise = null; // don't permanently pin a transient failure — retry fresh on the next call
  return ready;
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
