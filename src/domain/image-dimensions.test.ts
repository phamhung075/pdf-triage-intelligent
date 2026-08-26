import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { readImageDimensions } from './image-dimensions.js';

function render(width: number, height: number) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.font = '40px sans-serif';
  ctx.fillText('SAMPLE TEXT', 20, height / 2);
  return canvas;
}

describe('readImageDimensions', () => {
  it('reads the geometry of a real PNG', () => {
    // The production path: ocrPageBuffer hands over canvas.toBuffer('image/png').
    const buf = render(1190, 1684).toBuffer('image/png');
    expect(readImageDimensions(buf)).toEqual({ width: 1190, height: 1684 });
  });

  it('reads the geometry of a real JPEG', () => {
    // extractPDFContent's image branch hands over the original photo, usually a JPEG.
    const buf = render(800, 600).toBuffer('image/jpeg');
    expect(readImageDimensions(buf)).toEqual({ width: 800, height: 600 });
  });

  it('reads a non-square JPEG the right way round', () => {
    // JPEG stores height BEFORE width in SOFn — transposing them is the classic bug here, and a
    // square fixture cannot catch it.
    const buf = render(1000, 400).toBuffer('image/jpeg');
    expect(readImageDimensions(buf)).toEqual({ width: 1000, height: 400 });
  });

  it('returns null for a format it does not understand', () => {
    expect(readImageDimensions(Buffer.from('GIF89a and then some bytes'))).toBeNull();
  });

  it('returns null rather than throwing on a truncated PNG header', () => {
    const buf = render(100, 100).toBuffer('image/png').subarray(0, 12);
    expect(readImageDimensions(buf)).toBeNull();
  });

  it('returns null rather than throwing on a JPEG that is only its start-of-image marker', () => {
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
  });

  it('returns null on an empty buffer', () => {
    expect(readImageDimensions(Buffer.alloc(0))).toBeNull();
  });
});
