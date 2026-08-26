import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';

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

  it('does not memoize a failed result — retries fresh on the next call', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED')); // every /health check fails, for both calls
    vi.doMock('child_process', () => ({ exec: vi.fn() }));

    const { ensurePaddleOcrServer } = await import('./paddleocr-client.js');
    const first = ensurePaddleOcrServer();
    await vi.runAllTimersAsync();
    expect(await first).toBe(false);

    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = ensurePaddleOcrServer();
    await vi.runAllTimersAsync();
    expect(await second).toBe(false);

    // A second /health attempt happened on the second call — proves the failure wasn't
    // memoized (a memoized failure would resolve immediately with zero new fetch calls).
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('does not repeat the spawn attempt on a second call after a failed first attempt', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const execMock = vi.fn();
    vi.doMock('child_process', () => ({ exec: execMock }));

    const { ensurePaddleOcrServer } = await import('./paddleocr-client.js');
    const first = ensurePaddleOcrServer();
    await vi.runAllTimersAsync();
    expect(await first).toBe(false);
    expect(execMock).toHaveBeenCalledTimes(1);

    const second = ensurePaddleOcrServer();
    await vi.runAllTimersAsync();
    expect(await second).toBe(false);

    // The second call must NOT trigger another spawn attempt.
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});

// fetch is stubbed globally, so responses are routed by URL rather than by call order. Order-based
// mocking broke the moment a /ready probe was added ahead of /ocr: the probe silently consumed the
// response queued for the next endpoint, and the failure looked like a bug in the code under test.
function route(handlers: {
  health?: () => any;
  ready?: () => any;
  ocr?: () => any;
  orientation?: () => any;
}) {
  fetchMock.mockImplementation(async (url: any) => {
    const target = String(url);
    // Default: healthy, and no /ready endpoint at all — which is the ungated path, so every test
    // that says nothing about readiness keeps testing exactly what it did before.
    if (target.endsWith('/health')) return (handlers.health ?? (() => ({ ok: true })))();
    if (target.endsWith('/ready')) return (handlers.ready ?? (() => ({ ok: false, status: 404 })))();
    if (target.endsWith('/ocr')) {
      if (!handlers.ocr) throw new Error('unexpected /ocr call');
      return handlers.ocr();
    }
    if (target.endsWith('/orientation')) {
      if (!handlers.orientation) throw new Error('unexpected /orientation call');
      return handlers.orientation();
    }
    throw new Error('unexpected fetch to ' + target);
  });
}

// Responses returned in order; the last one repeats, mirroring mockResolvedValue's tail behaviour.
function sequence(...responses: any[]) {
  let index = 0;
  return () => responses[Math.min(index++, responses.length - 1)];
}

function callsTo(suffix: string): any[] {
  return fetchMock.mock.calls.filter((call: any[]) => String(call[0]).endsWith(suffix));
}

describe('paddleOcrRecognize', () => {
  it('returns the recognized text when the server is already healthy', async () => {
    route({ ocr: () => ({ ok: true, json: async () => ({ text: 'Hello World' }) }) });

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    const result = await paddleOcrRecognize(Buffer.from('fake-image'));

    expect(result).toBe('Hello World');
  });

  it('retries once and succeeds when /ocr returns a transient 5xx', async () => {
    // A 5xx used to drop the page straight to Tesseract. Same file, same bytes, visibly worse
    // text — which is how a re-analysis came back worse than the original triage.
    vi.useFakeTimers();
    route({
      ocr: sequence(
        { ok: false, status: 500 },
        { ok: true, json: async () => ({ text: 'Hello World' }) },
      ),
    });

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    const resultPromise = paddleOcrRecognize(Buffer.from('x'));
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toBe('Hello World');
    expect(callsTo('/ocr')).toHaveLength(2);
  });

  it('throws after one retry when /ocr keeps returning 5xx', async () => {
    vi.useFakeTimers();
    route({ ocr: () => ({ ok: false, status: 500 }) });

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    const resultPromise = paddleOcrRecognize(Buffer.from('x'));
    const assertion = expect(resultPromise).rejects.toThrow('PaddleOCR /ocr returned 500');
    await vi.runAllTimersAsync();
    await assertion;

    expect(callsTo('/ocr')).toHaveLength(2); // retried exactly once, then gave up
  });

  it('does not retry a 4xx — a rejected request fails identically the second time', async () => {
    route({ ocr: () => ({ ok: false, status: 413 }) });

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    await expect(paddleOcrRecognize(Buffer.from('x'))).rejects.toThrow('PaddleOCR /ocr returned 413');
    expect(callsTo('/ocr')).toHaveLength(1);
  });

  it('throws when the /ocr response is missing the text field', async () => {
    route({ ocr: () => ({ ok: true, json: async () => ({}) }) });

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    await expect(paddleOcrRecognize(Buffer.from('x'))).rejects.toThrow('unexpected response shape');
  });

  it('throws without calling /ocr when the server cannot be reached or spawned', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED')); // every /health check fails
    vi.doMock('child_process', () => ({ exec: vi.fn() }));

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    const resultPromise = paddleOcrRecognize(Buffer.from('x'));
    const assertion = expect(resultPromise).rejects.toThrow('PaddleOCR server is unavailable');
    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe('paddleOcrRecognize — readiness gate', () => {
  it('waits for the models to load before starting the OCR request', async () => {
    // /health answers the instant the process is up, while the models are still loading behind it.
    // Starting the inference timer there is what made a cold start after a dev-server restart spend
    // its whole 300s budget on model loading and then fall back to Tesseract.
    vi.useFakeTimers();
    route({
      ready: sequence(
        { ok: true, json: async () => ({ ready: false, ocr: false, warming: true }) },
        { ok: true, json: async () => ({ ready: false, ocr: false, warming: true }) },
        { ok: true, json: async () => ({ ready: true, ocr: true, warming: false }) },
      ),
      ocr: () => ({ ok: true, json: async () => ({ text: 'warm result' }) }),
    });

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    const resultPromise = paddleOcrRecognize(Buffer.from('x'));
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toBe('warm result');
    expect(callsTo('/ready').length).toBeGreaterThanOrEqual(3);
    expect(callsTo('/ocr')).toHaveLength(1);
  });

  it('stops waiting once warm-up has finished without loading the model', async () => {
    // warm_models() swallows load errors, so warming:false with ocr:false means nothing more is
    // coming. Waiting past that point would block OCR forever on a server that failed to warm.
    route({
      ready: () => ({ ok: true, json: async () => ({ ready: false, ocr: false, warming: false }) }),
      ocr: () => ({ ok: true, json: async () => ({ text: 'lazy loaded' }) }),
    });

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    await expect(paddleOcrRecognize(Buffer.from('x'))).resolves.toBe('lazy loaded');
    expect(callsTo('/ready')).toHaveLength(1);
  });

  it('proceeds ungated against a server that has no /ready endpoint', async () => {
    route({
      ready: () => ({ ok: false, status: 404 }),
      ocr: () => ({ ok: true, json: async () => ({ text: 'ungated' }) }),
    });

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    await expect(paddleOcrRecognize(Buffer.from('x'))).resolves.toBe('ungated');
  });

  it('gives up waiting at its own budget rather than blocking forever', async () => {
    vi.useFakeTimers();
    route({
      ready: () => ({ ok: true, json: async () => ({ ready: false, ocr: false, warming: true }) }),
    });

    const { waitForPaddleOcrModel } = await import('./paddleocr-client.js');
    const waitPromise = waitForPaddleOcrModel('ocr', 10_000);
    await vi.runAllTimersAsync();

    await expect(waitPromise).resolves.toBe(false);
  });
});

describe('paddleOcrRecognize — queueing', () => {
  it('sends one /ocr at a time so waiting never counts against a page budget', async () => {
    // Successful passes measured 100-230s against a 300s budget, so one request sitting behind
    // another was on its own enough to blow it. The server serializes inference anyway; queueing
    // here is what keeps the client's timer measuring inference instead of inference plus waiting.
    let inFlight = 0;
    let peak = 0;
    route({
      ocr: () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return {
          ok: true,
          json: async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
            inFlight--;
            return { text: 'page' };
          },
        };
      },
    });

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    await Promise.all([
      paddleOcrRecognize(Buffer.from('a')),
      paddleOcrRecognize(Buffer.from('b')),
      paddleOcrRecognize(Buffer.from('c')),
    ]);

    expect(callsTo('/ocr')).toHaveLength(3);
    expect(peak).toBe(1);
  });

  it('does not wedge the queue when one request fails', async () => {
    route({
      ocr: sequence(
        { ok: false, status: 413 },
        { ok: true, json: async () => ({ text: 'second still runs' }) },
      ),
    });

    const { paddleOcrRecognize } = await import('./paddleocr-client.js');
    const first = paddleOcrRecognize(Buffer.from('a'));
    const second = paddleOcrRecognize(Buffer.from('b'));

    await expect(first).rejects.toThrow('413');
    await expect(second).resolves.toBe('second still runs');
  });
});

describe('ocrTimeoutFor', () => {
  const png = (width: number, height: number) => {
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').fillRect(0, 0, width, height);
    return canvas.toBuffer('image/png');
  };

  it('gives a real A4 page render essentially the floor budget', async () => {
    const { ocrTimeoutFor } = await import('./paddleocr-client.js');
    // What ocrPdfPagesWithCanvas actually produces at scale 2.0: 1190x1684 = 2.004 MP, a hair over
    // the 2.0 MP reference — so the budget should land just above the floor, not on it exactly.
    const budget = ocrTimeoutFor(png(1190, 1684));
    expect(budget).toBeGreaterThanOrEqual(300_000);
    expect(budget).toBeLessThan(303_000);
  });

  it('extends the budget in proportion to a larger page', async () => {
    const { ocrTimeoutFor } = await import('./paddleocr-client.js');
    // Exact areas so the ratio is unambiguous: 2.0 MP is the reference, 4.0 MP is twice the page
    // and gets twice the budget — twice the area holds roughly twice as much to read.
    expect(ocrTimeoutFor(png(1000, 2000))).toBe(300_000);
    expect(ocrTimeoutFor(png(2000, 2000))).toBe(600_000);
  });

  it('never drops below the floor for a small image', async () => {
    const { ocrTimeoutFor } = await import('./paddleocr-client.js');
    expect(ocrTimeoutFor(png(200, 200))).toBe(300_000);
  });

  it('caps the budget so a wedged server cannot stall a scan indefinitely', async () => {
    const { ocrTimeoutFor } = await import('./paddleocr-client.js');
    expect(ocrTimeoutFor(png(6000, 6000))).toBe(1_200_000);
  });

  it('falls back to the floor when the geometry cannot be read', async () => {
    const { ocrTimeoutFor } = await import('./paddleocr-client.js');
    expect(ocrTimeoutFor(Buffer.from('not an image'))).toBe(300_000);
  });
});

describe('paddleOcrDetectOrientation', () => {
  it('returns rotationDegrees and confidence when the server is healthy', async () => {
    route({
      orientation: () => ({ ok: true, json: async () => ({ rotation_degrees: 90, confidence: 0.95 }) }),
    });

    const { paddleOcrDetectOrientation } = await import('./paddleocr-client.js');
    const result = await paddleOcrDetectOrientation(Buffer.from('x'));

    expect(result).toEqual({ rotationDegrees: 90, confidence: 0.95 });
  });

  it('throws when the server returns an invalid rotation value', async () => {
    route({
      orientation: () => ({ ok: true, json: async () => ({ rotation_degrees: 45, confidence: 0.5 }) }),
    });

    const { paddleOcrDetectOrientation } = await import('./paddleocr-client.js');
    await expect(paddleOcrDetectOrientation(Buffer.from('x'))).rejects.toThrow(/invalid rotation_degrees/);
  });
});


describe('takeOverPaddleOcrServer', () => {
  afterEach(() => {
    vi.doUnmock('./pid-lock.js');
    vi.doUnmock('./settings.js');
    vi.resetModules();
  });

  it('kills the process holding the local PaddleOCR port and forces the next call to respawn', async () => {
    // The PaddleOCR service is a separate Python process that outlives a dev-server restart, and a
    // STALE one answers /health perfectly well — so ensurePaddleOcrServer() reuses it and any change
    // under paddleocr-server/ silently never loads. That is why the concurrency fix had to be
    // applied by hand-killing the process before it took effect.
    const killMock = vi.fn(async () => true);
    vi.doMock('./pid-lock.js', () => ({ killProcessOnPort: killMock }));
    fetchMock.mockResolvedValue({ ok: true }); // a stale server is up and answering

    const { takeOverPaddleOcrServer, ensurePaddleOcrServer } = await import('./paddleocr-client.js');

    await ensurePaddleOcrServer();
    await ensurePaddleOcrServer();
    expect(fetchMock).toHaveBeenCalledTimes(1); // readiness is memoized after the first success

    const killed = await takeOverPaddleOcrServer();

    expect(killed).toBe(true);
    expect(killMock).toHaveBeenCalledWith(8871);

    // Memoization must be cleared too, or the next OCR call trusts a server that is now dead.
    await ensurePaddleOcrServer();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports false when nothing was listening on the port', async () => {
    vi.doMock('./pid-lock.js', () => ({ killProcessOnPort: vi.fn(async () => false) }));

    const { takeOverPaddleOcrServer } = await import('./paddleocr-client.js');
    expect(await takeOverPaddleOcrServer()).toBe(false);
  });

  it('never kills anything when PADDLEOCR_HOST points at another machine', async () => {
    // killProcessOnPort kills whatever local PID holds that port number. If the service is remote,
    // the local process on 8871 is some unrelated program and killing it would be pure collateral.
    const killMock = vi.fn(async () => true);
    vi.doMock('./pid-lock.js', () => ({ killProcessOnPort: killMock }));
    vi.doMock('./settings.js', () => ({
      CONFIG: { PADDLEOCR_HOST: 'http://10.0.0.5:8871', PADDLEOCR_SPAWN_CMD: 'noop' },
    }));

    const { takeOverPaddleOcrServer } = await import('./paddleocr-client.js');

    expect(await takeOverPaddleOcrServer()).toBe(false);
    expect(killMock).not.toHaveBeenCalled();
  });
});
