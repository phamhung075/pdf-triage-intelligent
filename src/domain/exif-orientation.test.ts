import { describe, it, expect } from 'vitest';
import { parseExifOrientation, exifOrientationToDegrees } from './exif-orientation.js';

// Builds a minimal but valid JPEG (SOI + APP1/Exif with a single Orientation IFD0 entry + EOI)
// so parseExifOrientation can be tested without a real photo file.
function buildJpegWithExifOrientation(orientationTag: number, byteOrder: 'II' | 'MM' = 'II'): Buffer {
  const isLE = byteOrder === 'II';
  const writeU16 = (buf: Buffer, offset: number, val: number) => (isLE ? buf.writeUInt16LE(val, offset) : buf.writeUInt16BE(val, offset));
  const writeU32 = (buf: Buffer, offset: number, val: number) => (isLE ? buf.writeUInt32LE(val, offset) : buf.writeUInt32BE(val, offset));

  const ifd0 = Buffer.alloc(2 + 12 + 4);
  writeU16(ifd0, 0, 1); // numEntries = 1
  writeU16(ifd0, 2, 0x0112); // tag = Orientation
  writeU16(ifd0, 4, 3); // type = SHORT
  writeU32(ifd0, 6, 1); // count = 1
  writeU16(ifd0, 10, orientationTag); // value, left-justified in the 4-byte value field
  writeU32(ifd0, 12, 0); // next IFD offset = 0 (none)

  const tiffHeader = Buffer.alloc(8);
  tiffHeader.write(byteOrder, 0, 'ascii');
  writeU16(tiffHeader, 2, 0x002a); // TIFF magic
  writeU32(tiffHeader, 4, 8); // offset to IFD0, right after this header

  const exifBlock = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiffHeader, ifd0]);
  const app1LengthBuf = Buffer.alloc(2);
  app1LengthBuf.writeUInt16BE(exifBlock.length + 2, 0); // length field includes itself, always big-endian

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe1]), // APP1 marker
    app1LengthBuf,
    exifBlock,
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

function buildJpegWithoutExif(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI, no APP1
}

function buildJpegWithNonExifApp1(): Buffer {
  const payload = Buffer.from('JFIF\0test-payload', 'ascii');
  const lengthBuf = Buffer.alloc(2);
  lengthBuf.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1]),
    lengthBuf,
    payload,
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe('parseExifOrientation', () => {
  it('reads the Orientation tag from a little-endian (Intel/II) EXIF block', () => {
    const buf = buildJpegWithExifOrientation(6, 'II');
    expect(parseExifOrientation(buf)).toBe(6);
  });

  it('reads the Orientation tag from a big-endian (Motorola/MM) EXIF block', () => {
    const buf = buildJpegWithExifOrientation(3, 'MM');
    expect(parseExifOrientation(buf)).toBe(3);
  });

  it('reads orientation tag 1 (normal, no correction needed)', () => {
    const buf = buildJpegWithExifOrientation(1, 'II');
    expect(parseExifOrientation(buf)).toBe(1);
  });

  it('reads orientation tag 8', () => {
    const buf = buildJpegWithExifOrientation(8, 'II');
    expect(parseExifOrientation(buf)).toBe(8);
  });

  it('returns null when the JPEG has no APP1/EXIF segment at all', () => {
    expect(parseExifOrientation(buildJpegWithoutExif())).toBeNull();
  });

  it('returns null when APP1 is present but is not an EXIF block', () => {
    expect(parseExifOrientation(buildJpegWithNonExifApp1())).toBeNull();
  });

  it('returns null for a non-JPEG buffer', () => {
    expect(parseExifOrientation(Buffer.from('not a jpeg at all'))).toBeNull();
  });

  it('returns null for a buffer too short to contain a JPEG header', () => {
    expect(parseExifOrientation(Buffer.from([0xff]))).toBeNull();
  });
});

describe('exifOrientationToDegrees', () => {
  it('maps tag 1 to 0 degrees', () => {
    expect(exifOrientationToDegrees(1)).toBe(0);
  });

  it('maps tag 3 to 180 degrees', () => {
    expect(exifOrientationToDegrees(3)).toBe(180);
  });

  it('maps tag 6 to 90 degrees', () => {
    expect(exifOrientationToDegrees(6)).toBe(90);
  });

  it('maps tag 8 to 270 degrees', () => {
    expect(exifOrientationToDegrees(8)).toBe(270);
  });

  it('maps null (no EXIF) to null', () => {
    expect(exifOrientationToDegrees(null)).toBeNull();
  });

  it('maps a mirrored tag (2, 4, 5, 7) to null rather than guessing a rotation', () => {
    expect(exifOrientationToDegrees(2)).toBeNull();
    expect(exifOrientationToDegrees(4)).toBeNull();
    expect(exifOrientationToDegrees(5)).toBeNull();
    expect(exifOrientationToDegrees(7)).toBeNull();
  });
});
