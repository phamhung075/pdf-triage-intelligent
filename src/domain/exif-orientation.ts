// Manually parses the EXIF Orientation tag (0x0112) from a JPEG's APP1 segment — no
// dependency needed for this one value. Returns the raw EXIF orientation tag (1-8), or
// null if the file isn't a JPEG, has no APP1/EXIF segment, or the segment has no
// Orientation entry.
export function parseExifOrientation(buffer: Buffer): number | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null; // not a JPEG (SOI marker)

  let offset = 2;
  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) break; // Start of Scan — no more metadata markers follow
    if (offset + 4 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset + 2);

    if (marker === 0xe1) {
      const exifStart = offset + 4;
      if (buffer.toString('ascii', exifStart, exifStart + 4) !== 'Exif') {
        offset += 2 + segmentLength;
        continue;
      }
      const tiffStart = exifStart + 6; // skip 'Exif\0\0'
      if (tiffStart + 8 > buffer.length) return null;
      const byteOrder = buffer.toString('ascii', tiffStart, tiffStart + 2);
      const isLittleEndian = byteOrder === 'II';
      if (!isLittleEndian && byteOrder !== 'MM') return null;
      const readU16 = (o: number) => (isLittleEndian ? buffer.readUInt16LE(o) : buffer.readUInt16BE(o));
      const readU32 = (o: number) => (isLittleEndian ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));

      const ifd0Offset = readU32(tiffStart + 4);
      const ifd0Start = tiffStart + ifd0Offset;
      if (ifd0Start + 2 > buffer.length) return null;
      const numEntries = readU16(ifd0Start);

      for (let i = 0; i < numEntries; i++) {
        const entryOffset = ifd0Start + 2 + i * 12;
        if (entryOffset + 12 > buffer.length) break;
        const tag = readU16(entryOffset);
        if (tag === 0x0112) {
          return readU16(entryOffset + 8);
        }
      }
      return null;
    }

    offset += 2 + segmentLength;
  }
  return null;
}

// Maps the raw EXIF Orientation tag to the clockwise rotation (matching image-processor.ts's
// rotateImage semantics) needed to correct the image. Tags 2/4/5/7 involve a mirror flip
// (rare for camera photos) that isn't representable as a pure rotation, so they map to null
// rather than silently dropping the mirror.
export function exifOrientationToDegrees(tag: number | null): 0 | 90 | 180 | 270 | null {
  switch (tag) {
    case 1:
      return 0;
    case 3:
      return 180;
    case 6:
      return 90;
    case 8:
      return 270;
    default:
      return null;
  }
}
