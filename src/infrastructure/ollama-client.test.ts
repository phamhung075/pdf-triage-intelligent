import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Ollama } from 'ollama';

const { generateMock, listMock, pullMock, embeddingsMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  listMock: vi.fn(),
  pullMock: vi.fn(),
  embeddingsMock: vi.fn(),
}));

// See classify-document.test.ts for why this must be a `function`, not an arrow function:
// ollama-client.ts calls `new Ollama(...)`, and arrow functions can't be constructors.
vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(function () {
    return {
      generate: generateMock,
      list: listMock,
      pull: pullMock,
      embeddings: embeddingsMock,
    };
  }),
}));

afterEach(() => {
  vi.resetAllMocks();
});

beforeEach(() => {
  vi.resetModules();
  generateMock.mockReset();
  listMock.mockReset();
  pullMock.mockReset();
  embeddingsMock.mockReset();
  // resetAllMocks() (afterEach above) also wipes the hoisted Ollama constructor's
  // mockImplementation — re-establish it every test, same as classify-document.test.ts.
  vi.mocked(Ollama).mockImplementation(function () {
    return {
      generate: generateMock,
      list: listMock,
      pull: pullMock,
      embeddings: embeddingsMock,
    } as any;
  } as any);
});

describe('checkModelCanGenerate', () => {
  it('returns ok:true when the model successfully generates', async () => {
    generateMock.mockResolvedValueOnce({ response: 'ok' });
    const { checkModelCanGenerate } = await import('./ollama-client.js');
    const result = await checkModelCanGenerate('qwen3.5:9b');
    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false with the error message when generate rejects', async () => {
    generateMock.mockRejectedValueOnce(new Error('model is subscription-gated'));
    const { checkModelCanGenerate } = await import('./ollama-client.js');
    const result = await checkModelCanGenerate('some-cloud-model');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('model is subscription-gated');
  });

  it('caches a passing result and does not call generate() again within the TTL', async () => {
    generateMock.mockResolvedValueOnce({ response: 'ok' });
    const { checkModelCanGenerate } = await import('./ollama-client.js');
    await checkModelCanGenerate('qwen3.5:9b');
    await checkModelCanGenerate('qwen3.5:9b');
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache when forceRefresh is true', async () => {
    generateMock.mockResolvedValueOnce({ response: 'ok' }).mockResolvedValueOnce({ response: 'ok' });
    const { checkModelCanGenerate } = await import('./ollama-client.js');
    await checkModelCanGenerate('qwen3.5:9b');
    await checkModelCanGenerate('qwen3.5:9b', undefined, true);
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it('re-checks when the model name differs from the cached entry', async () => {
    generateMock.mockResolvedValueOnce({ response: 'ok' }).mockResolvedValueOnce({ response: 'ok' });
    const { checkModelCanGenerate } = await import('./ollama-client.js');
    await checkModelCanGenerate('qwen3.5:9b');
    await checkModelCanGenerate('a-different-model');
    expect(generateMock).toHaveBeenCalledTimes(2);
  });
});

describe('ensureOllamaModel', () => {
  it('returns true when the model already exists locally and can generate', async () => {
    listMock.mockResolvedValue({ models: [{ name: 'qwen3.5:9b' }] });
    generateMock.mockResolvedValue({ response: 'ok' });
    const { ensureOllamaModel } = await import('./ollama-client.js');
    const result = await ensureOllamaModel('qwen3.5:9b');
    expect(result).toBe(true);
    expect(pullMock).not.toHaveBeenCalled();
  });

  it('pulls the model when it is not found locally', async () => {
    listMock.mockResolvedValue({ models: [] });
    pullMock.mockResolvedValue(undefined);
    generateMock.mockResolvedValue({ response: 'ok' });
    const { ensureOllamaModel } = await import('./ollama-client.js');
    const result = await ensureOllamaModel('qwen3.5:9b');
    expect(pullMock).toHaveBeenCalledWith({ model: 'qwen3.5:9b' });
    expect(result).toBe(true);
  });

  it('returns false when the model exists but cannot generate (subscription-gated)', async () => {
    listMock.mockResolvedValue({ models: [{ name: 'qwen3.5:9b' }] });
    generateMock.mockRejectedValue(new Error('gated'));
    const { ensureOllamaModel } = await import('./ollama-client.js');
    const result = await ensureOllamaModel('qwen3.5:9b');
    expect(result).toBe(false);
  });

  it('attempts to auto-spawn "ollama serve" when list() fails, then retries', async () => {
    listMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ models: [{ name: 'qwen3.5:9b' }] });
    generateMock.mockResolvedValue({ response: 'ok' });

    const execMock = vi.fn();
    vi.doMock('child_process', () => ({ exec: execMock }));

    const { ensureOllamaModel } = await import('./ollama-client.js');
    const result = await ensureOllamaModel('qwen3.5:9b');

    expect(execMock).toHaveBeenCalledWith('ollama serve', { windowsHide: true });
    expect(result).toBe(true);
  }, 10_000);

  it('returns false when auto-spawn retry still cannot find the model', async () => {
    listMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ models: [] });
    vi.doMock('child_process', () => ({ exec: vi.fn() }));

    const { ensureOllamaModel } = await import('./ollama-client.js');
    const result = await ensureOllamaModel('qwen3.5:9b');
    expect(result).toBe(false);
  }, 10_000);
});

describe('requestClassificationCompletion', () => {
  it('always sends think:false (qwen3.5:9b routes JSON into .thinking otherwise)', async () => {
    generateMock.mockResolvedValue({ response: '{"ok":true}', thinking: '' });
    const { requestClassificationCompletion } = await import('./ollama-client.js');
    await requestClassificationCompletion('system prompt', 'user prompt');

    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({ think: false, format: 'json', system: 'system prompt', prompt: 'user prompt' })
    );
  });

  it('returns the response and thinking fields from the Ollama result', async () => {
    generateMock.mockResolvedValue({ response: '{"a":1}', thinking: 'some internal reasoning' });
    const { requestClassificationCompletion } = await import('./ollama-client.js');
    const result = await requestClassificationCompletion('sys', 'usr');
    expect(result).toEqual({ response: '{"a":1}', thinking: 'some internal reasoning' });
  });
});

describe('generateEmbedding', () => {
  it('returns the embedding vector on success', async () => {
    embeddingsMock.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
    const { generateEmbedding } = await import('./ollama-client.js');
    const result = await generateEmbedding('some text to embed');
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it('truncates the prompt to 1000 characters', async () => {
    embeddingsMock.mockResolvedValue({ embedding: [] });
    const { generateEmbedding } = await import('./ollama-client.js');
    const longText = 'x'.repeat(2000);
    await generateEmbedding(longText);
    expect(embeddingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'x'.repeat(1000) })
    );
  });

  it('returns an empty array instead of throwing when the embeddings call fails', async () => {
    embeddingsMock.mockRejectedValue(new Error('embed model not found'));
    const { generateEmbedding } = await import('./ollama-client.js');
    const result = await generateEmbedding('text');
    expect(result).toEqual([]);
  });
});
