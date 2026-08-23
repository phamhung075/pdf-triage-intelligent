import { describe, it, expect, vi, beforeEach } from 'vitest';

const { detectCropBoxMock } = vi.hoisted(() => ({ detectCropBoxMock: vi.fn() }));
vi.mock('./vision-client.js', () => ({ detectCropBox: detectCropBoxMock }));

const { detectDocumentBoxLocallyMock } = vi.hoisted(() => ({ detectDocumentBoxLocallyMock: vi.fn() }));
vi.mock('./image-processor.js', () => ({ detectDocumentBoxLocally: detectDocumentBoxLocallyMock }));

// The local detector is three-valued. These two helpers keep the distinction visible in every
// test: a box, versus "no opinion", versus "there is nothing here to crop".
const localBox = (box: { x: number; y: number; width: number; height: number }) => ({ kind: 'box' as const, box });
const localNoSignal = { kind: 'no-signal' as const };
const localVetoed = { kind: 'vetoed' as const };

const { loadImageMock } = vi.hoisted(() => ({ loadImageMock: vi.fn() }));
vi.mock('@napi-rs/canvas', () => ({ loadImage: loadImageMock }));

beforeEach(() => {
  vi.resetAllMocks();
  loadImageMock.mockResolvedValue({ width: 1000, height: 800 });
});

describe('detectCropBoxCascade', () => {
  it('uses the model box when it is not degenerate and agrees with flood (IoU >= 0.5)', async () => {
    detectCropBoxMock.mockResolvedValue({ cropBox: { x: 100, y: 100, width: 700, height: 500 }, raw: '{"cropBox":{}}' });
    detectDocumentBoxLocallyMock.mockResolvedValue(localBox({ x: 110, y: 110, width: 690, height: 490 })); // near-identical box, high IoU

    const { detectCropBoxCascade } = await import('./crop-detector.js');
    const result = await detectCropBoxCascade(Buffer.from('x'));

    expect(result.source).toBe('model-flood-agree');
    expect(result.cropBox).toEqual({ x: 100, y: 100, width: 700, height: 500 });
  });

  it('overrides with flood when the model returns the full image bounds (degenerate answer)', async () => {
    detectCropBoxMock.mockResolvedValue({ cropBox: { x: 0, y: 0, width: 1000, height: 800 }, raw: '{"cropBox":{"x":0,"y":0,"width":1000,"height":800}}' });
    detectDocumentBoxLocallyMock.mockResolvedValue(localBox({ x: 80, y: 60, width: 800, height: 600 }));

    const { detectCropBoxCascade } = await import('./crop-detector.js');
    const result = await detectCropBoxCascade(Buffer.from('x'));

    expect(result.source).toBe('flood-override');
    expect(result.cropBox).toEqual({ x: 80, y: 60, width: 800, height: 600 });
  });

  it('overrides with flood when the model returns null (also treated as degenerate)', async () => {
    detectCropBoxMock.mockResolvedValue({ cropBox: null, raw: '{"cropBox":null}' });
    detectDocumentBoxLocallyMock.mockResolvedValue(localBox({ x: 80, y: 60, width: 800, height: 600 }));

    const { detectCropBoxCascade } = await import('./crop-detector.js');
    const result = await detectCropBoxCascade(Buffer.from('x'));

    expect(result.source).toBe('flood-override');
    expect(result.cropBox).toEqual({ x: 80, y: 60, width: 800, height: 600 });
  });

  it('overrides with flood when the model box strongly disagrees with flood (IoU < 0.5), matching pdf-awesome\'s own combination rule', async () => {
    detectCropBoxMock.mockResolvedValue({ cropBox: { x: 0, y: 0, width: 400, height: 300 }, raw: '{"cropBox":{}}' });
    detectDocumentBoxLocallyMock.mockResolvedValue(localBox({ x: 600, y: 500, width: 400, height: 300 })); // disjoint from model's box -> IoU 0

    const { detectCropBoxCascade } = await import('./crop-detector.js');
    const result = await detectCropBoxCascade(Buffer.from('x'));

    expect(result.source).toBe('flood-override');
    expect(result.cropBox).toEqual({ x: 600, y: 500, width: 400, height: 300 });
  });

  it('falls back to the model box when flood is inconclusive and the model box is a real, non-degenerate answer', async () => {
    detectCropBoxMock.mockResolvedValue({ cropBox: { x: 50, y: 50, width: 900, height: 700 }, raw: '{"cropBox":{}}' });
    detectDocumentBoxLocallyMock.mockResolvedValue(localNoSignal);

    const { detectCropBoxCascade } = await import('./crop-detector.js');
    const result = await detectCropBoxCascade(Buffer.from('x'));

    expect(result.source).toBe('model-only');
    expect(result.cropBox).toEqual({ x: 50, y: 50, width: 900, height: 700 });
  });

  it('returns cropBox:null when both the model and flood find nothing', async () => {
    detectCropBoxMock.mockResolvedValue({ cropBox: null, raw: '{"cropBox":null}' });
    detectDocumentBoxLocallyMock.mockResolvedValue(localNoSignal);

    const { detectCropBoxCascade } = await import('./crop-detector.js');
    const result = await detectCropBoxCascade(Buffer.from('x'));

    expect(result.source).toBe('none');
    expect(result.cropBox).toBeNull();
  });

  // Regression test for a real phone photo: the local detector had no opinion (nothing covered the
  // middle of the frame) while the model separately echoed back the full image bounds — its known
  // degenerate "give up" answer. Before this fix the cascade fell through to `model-only` and
  // silently returned the model's no-op box, reporting a successful crop that was actually just
  // the uncropped original image.
  it('reports no crop (not a false model-only success) when flood is inconclusive and the model box is also degenerate', async () => {
    detectCropBoxMock.mockResolvedValue({ cropBox: { x: 0, y: 0, width: 1000, height: 800 }, raw: '{"cropBox":{"x":0,"y":0,"width":1000,"height":800}}' });
    detectDocumentBoxLocallyMock.mockResolvedValue(localNoSignal);

    const { detectCropBoxCascade } = await import('./crop-detector.js');
    const result = await detectCropBoxCascade(Buffer.from('x'));

    expect(result.source).toBe('none');
    expect(result.cropBox).toBeNull();
  });

  // THE cascade defect this three-valued result exists to fix. A veto says "I examined this image
  // and there is NO BACKGROUND to crop — the frame IS the document". A scan, a close-up capture or
  // a second pass over this pipeline's own output all land here, and they are exactly the inputs
  // on which the unguarded model invents a box around an interior text block. If a veto were
  // treated as "flood found nothing", the cascade would hand back that destructive box on the
  // inputs where the local detector's evidence is strongest. It must short-circuit instead.
  it('short-circuits to no crop when the local detector VETOES, even though the model offered a real box', async () => {
    detectCropBoxMock.mockResolvedValue({ cropBox: { x: 120, y: 90, width: 500, height: 400 }, raw: '{"cropBox":{}}' });
    detectDocumentBoxLocallyMock.mockResolvedValue(localVetoed);

    const { detectCropBoxCascade } = await import('./crop-detector.js');
    const result = await detectCropBoxCascade(Buffer.from('x'));

    expect(result.source).toBe('flood-veto');
    expect(result.cropBox).toBeNull();
    // The model's answer is still reported for diagnostics — it is just not acted on.
    expect(result.modelCropBox).toEqual({ x: 120, y: 90, width: 500, height: 400 });
    expect(result.floodCropBox).toBeNull();
  });

  it('vetoes regardless of the model, including when the model box is degenerate', async () => {
    detectCropBoxMock.mockResolvedValue({ cropBox: { x: 0, y: 0, width: 1000, height: 800 }, raw: '{"cropBox":{}}' });
    detectDocumentBoxLocallyMock.mockResolvedValue(localVetoed);

    const { detectCropBoxCascade } = await import('./crop-detector.js');
    const result = await detectCropBoxCascade(Buffer.from('x'));

    expect(result.source).toBe('flood-veto');
    expect(result.cropBox).toBeNull();
  });
});
