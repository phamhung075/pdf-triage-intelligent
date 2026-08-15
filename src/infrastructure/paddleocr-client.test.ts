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

  it('throws when the /ocr response is missing the text field', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true }) // /health
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // malformed /ocr response

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
