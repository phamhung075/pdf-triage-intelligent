import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Ollama } from 'ollama';

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(function () {
    return { generate: generateMock };
  }),
}));

const { loadImageMock } = vi.hoisted(() => ({ loadImageMock: vi.fn() }));
vi.mock('@napi-rs/canvas', () => ({ loadImage: loadImageMock }));

afterEach(() => {
  vi.resetAllMocks();
});

beforeEach(() => {
  vi.resetModules();
  generateMock.mockReset();
  loadImageMock.mockReset();
  vi.mocked(Ollama).mockImplementation(function () {
    return { generate: generateMock } as any;
  } as any);
});

describe('detectOrientation', () => {
  it('calls Ollama with the vision model, the image, and format:json/think:false', async () => {
    generateMock.mockResolvedValue({ response: '{"rotationDegrees": 90}' });
    const { detectOrientation } = await import('./vision-client.js');
    const buf = Buffer.from('fake-image-bytes');
    await detectOrientation(buf);

    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'minicpm-v4.6:latest',
        images: [buf.toString('base64')],
        format: 'json',
        think: false,
      })
    );
  });

  it('parses a valid rotationDegrees value', async () => {
    generateMock.mockResolvedValue({ response: '{"rotationDegrees": 270}' });
    const { detectOrientation } = await import('./vision-client.js');
    const result = await detectOrientation(Buffer.from('x'));
    expect(result.rotationDegrees).toBe(270);
    expect(result.raw).toBe('{"rotationDegrees": 270}');
  });

  it('falls back to 0 for an out-of-set rotationDegrees value without throwing', async () => {
    generateMock.mockResolvedValue({ response: '{"rotationDegrees": 45}' });
    const { detectOrientation } = await import('./vision-client.js');
    const result = await detectOrientation(Buffer.from('x'));
    expect(result.rotationDegrees).toBe(0);
    expect(result.raw).toBe('{"rotationDegrees": 45}');
  });

  it('propagates an error when the model response is not parseable JSON at all', async () => {
    generateMock.mockResolvedValue({ response: 'sorry, I cannot help with that' });
    const { detectOrientation } = await import('./vision-client.js');
    await expect(detectOrientation(Buffer.from('x'))).rejects.toThrow();
  });
});

describe('detectCropBox', () => {
  it('includes the image dimensions (from loadImage) in the prompt', async () => {
    loadImageMock.mockResolvedValue({ width: 800, height: 600 });
    generateMock.mockResolvedValue({ response: '{"cropBox": {"x": 10, "y": 20, "width": 700, "height": 500}}' });
    const { detectCropBox } = await import('./vision-client.js');
    await detectCropBox(Buffer.from('x'));

    const call = generateMock.mock.calls[0][0];
    expect(call.prompt).toContain('800x600');
  });

  it('parses a valid cropBox', async () => {
    loadImageMock.mockResolvedValue({ width: 800, height: 600 });
    generateMock.mockResolvedValue({ response: '{"cropBox": {"x": 10, "y": 20, "width": 700, "height": 500}}' });
    const { detectCropBox } = await import('./vision-client.js');
    const result = await detectCropBox(Buffer.from('x'));
    expect(result.cropBox).toEqual({ x: 10, y: 20, width: 700, height: 500 });
  });

  it('returns cropBox:null (not a throw) for a degenerate box (zero/negative width)', async () => {
    loadImageMock.mockResolvedValue({ width: 800, height: 600 });
    generateMock.mockResolvedValue({ response: '{"cropBox": {"x": 0, "y": 0, "width": 0, "height": 500}}' });
    const { detectCropBox } = await import('./vision-client.js');
    const result = await detectCropBox(Buffer.from('x'));
    expect(result.cropBox).toBeNull();
    expect(result.raw).toContain('"width": 0');
  });

  it('propagates an error when the model response is not parseable JSON at all', async () => {
    loadImageMock.mockResolvedValue({ width: 800, height: 600 });
    generateMock.mockResolvedValue({ response: 'not json' });
    const { detectCropBox } = await import('./vision-client.js');
    await expect(detectCropBox(Buffer.from('x'))).rejects.toThrow();
  });
});
