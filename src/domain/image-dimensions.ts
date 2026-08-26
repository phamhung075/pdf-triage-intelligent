export interface ImageDimensions {
  width: number;
  height: number;
}

// Reads pixel dimensions straight out of an encoded image's header — no decode, no canvas, no I/O.
//
// Used to size the OCR timeout budget: PaddleOCR's runtime tracks how much there is to read on the
// page, and a page rendered at twice the area holds roughly twice as much to find. Byte length is
// NOT a usable proxy for that (a photo of a blank wall is large and instant; a dense text scan
// compresses well and is slow), so this reads the real geometry instead.
//
// Returns null for anything it does not recognize. Callers must treat null as "no information" and
// fall back to their floor budget rather than guessing — a wrong guess here silently changes how
// long a document is allowed to take.
export function readImageDimensions(buffer: Buffer): ImageDimensions | null {
  return readPng(buffer) ?? readJpeg(buffer);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(buffer: Buffer): ImageDimensions | null {
  // IHDR is mandated to be the first chunk, so width/height sit at fixed offsets 16 and 20.
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return sane(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

// Markers that carry no payload at all, so there is no length field to skip past.
const JPEG_STANDALONE = new Set([0xd8, 0xd9, 0x01]);

function readJpeg(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++; // fill byte or padding between segments
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset++; // 0xFF is a legal pad byte before the real marker
      continue;
    }
    if (JPEG_STANDALONE.has(marker)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    // SOFn carries the frame geometry. 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC) sit inside the same
    // numeric range but are NOT frame headers — excluding them is what keeps this from reading
    // a Huffman table as a picture size.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (offset + 9 > buffer.length) return null;
      return sane(buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5));
    }
    if (length < 2) return null; // malformed: a segment cannot be shorter than its own length field
    offset += 2 + length;
  }
  return null;
}

function sane(width: number, height: number): ImageDimensions | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}
