import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { extractPDFContent, safePdfParse, parseWithPdfjs, ocrPdfImages, encodeToBMP, ocrImageBufferBothEngines } from './pdf-extractor.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { paddleOcrRecognizeMock } = vi.hoisted(() => ({ paddleOcrRecognizeMock: vi.fn() }));
vi.mock('./paddleocr-client.js', () => ({ paddleOcrRecognize: paddleOcrRecognizeMock }));

beforeEach(() => {
  paddleOcrRecognizeMock.mockReset();
  // Default: simulate "no local PaddleOCR service running", which is also what actually
  // happens in this test environment — every existing OCR test below continues exercising
  // the real Tesseract fallback path exactly as before this mock was added.
  paddleOcrRecognizeMock.mockRejectedValue(new Error('PaddleOCR server is unavailable'));
});

async function buildTextPdf(text: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([300, 150]);
  const font = await pdfDoc.embedFont('Helvetica');
  page.drawText(text, { x: 20, y: 80, size: 18, font });
  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
}

// Zeroes out every object offset in the classic xref table while leaving the
// object bodies intact, matching the real-world "bad XRef entry" corruption
// that Tier 1 (pdf-parse) chokes on but Tier 2 (pdfjs-dist, ignoreErrors) recovers from.
function corruptClassicXref(bytes: Buffer): Buffer {
  const str = bytes.toString('latin1');
  const xrefStart = str.indexOf('\nxref');
  const trailerStart = str.indexOf('trailer', xrefStart);
  if (xrefStart < 0 || trailerStart < 0) {
    throw new Error('Test fixture PDF does not have a classic xref table to corrupt');
  }
  const block = str.slice(xrefStart, trailerStart);
  const broken = block.replace(/\d{10} 00000 n/g, '0000000000 00000 n');
  return Buffer.from(str.slice(0, xrefStart) + broken + str.slice(trailerStart), 'latin1');
}

async function buildImageOnlyPdf(word: string): Promise<Buffer> {
  const canvas = createCanvas(500, 260);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, 500, 260);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 72px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(word, 20, 90);
  const pngBytes = canvas.toBuffer('image/png');

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([500, 260]);
  const img = await pdfDoc.embedPng(pngBytes);
  page.drawImage(img, { x: 0, y: 0, width: 500, height: 260 });
  return Buffer.from(await pdfDoc.save());
}

// A page with no text objects AND nothing legible drawn on it either — used to
// make Step 2 (pdfjs-dist text extraction) return '' (no text layer at all,
// same as buildImageOnlyPdf) AND Step 3 (Tesseract OCR) also fail to recognize
// anything usable (<10 chars), so both corruption-triggered fallbacks are
// exhausted.
async function buildBlankImagePdf(): Promise<Buffer> {
  const canvas = createCanvas(200, 120);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, 200, 120);
  const pngBytes = canvas.toBuffer('image/png');

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([200, 120]);
  const img = await pdfDoc.embedPng(pngBytes);
  page.drawImage(img, { x: 0, y: 0, width: 200, height: 120 });
  return Buffer.from(await pdfDoc.save());
}

// Real excerpt from doc id 2545 in pdf_triage.db (the confirmed bad-ToUnicode-CMap
// case that motivated this fix), reproduced synthetically here with the same
// calibrated shape as src/domain/pdf-text.test.ts's real-data fixture: short
// filler words interspersed with mid-word-capitalized tokens ("cAn", "roAN",
// "khAu", ...) at a density (12 matches / 100 words in one window) that clears
// isLikelyCorruptedText's threshold. Used to drive Step 1 (pdf-parse) output
// directly via mocking, since reproducing a genuinely broken embedded-font
// ToUnicode CMap through pdf-lib is impractical for a unit-test fixture.
function buildGarbledCorruptedText(): string {
  const FILLER_WORDS = ['tai', 'lieu', 'ngan', 'hang', 'von', 'gia', 'tri', 'chi', 'phi', 'doanh', 'thu', 'loi', 'nhuan', 'tien', 'mat', 'thue', 'suat', 'ky', 'han', 'so'];
  const CORRUPTED_TOKENS = ['cAn', 'roAN', 'khAu', 'hEu', 'liY', 'sAn', 'trA', 'tAi', 'vaY', 'dAu', 'ngiY', 'cAo'];
  const words: string[] = [];
  for (let i = 0; i < 100; i++) {
    words.push(i % 8 === 0 ? CORRUPTED_TOKENS[(i / 8) % CORRUPTED_TOKENS.length] : FILLER_WORDS[i % FILLER_WORDS.length]);
  }
  return words.join(' ');
}

// Large enough that the raw RGB buffer (width*height*3 bytes) trips tesseract.js's Node
// setImage() workaround (`{...image}` spreads the whole buffer into a plain object, one
// property per byte) past V8's own limit on object property counts — reproduced directly
// against the real tesseract.js package via a throwaway script before this fix, with the
// exact same "RangeError: Too many properties to enumerate" seen in production.
async function buildOversizedImageOnlyPdf(dimension: number): Promise<Buffer> {
  const canvas = createCanvas(dimension, dimension);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, dimension, dimension);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 80px sans-serif';
  ctx.fillText('OVERSIZED SCAN', 40, 200);
  const pngBytes = canvas.toBuffer('image/png');

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([dimension, dimension]);
  const img = await pdfDoc.embedPng(pngBytes);
  page.drawImage(img, { x: 0, y: 0, width: dimension, height: dimension });
  return Buffer.from(await pdfDoc.save());
}

function writeTempPdf(bytes: Buffer, name: string): string {
  const filePath = path.join(os.tmpdir(), `pdf-extractor-test-${Date.now()}-${name}`);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

describe('extractPDFContent — 3-tier fallback pipeline', () => {
  it('extracts text from a normal digital-text PDF without needing OCR', async () => {
    const bytes = await buildTextPdf('Hello Tier1 Extraction Test');
    const filePath = writeTempPdf(bytes, 'digital.pdf');
    try {
      const result = await extractPDFContent(filePath);
      expect(result.raw_text).toContain('Hello Tier1 Extraction Test');
      expect(result.raw_text.startsWith('[OCR Extracted Text]')).toBe(false);
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('recovers text via the pdfjs-dist fallback when the xref table is corrupted', async () => {
    const valid = await buildTextPdf('Recovered Via Tier2 Fallback');
    const corrupted = corruptClassicXref(valid);

    // Sanity: Tier 1 genuinely cannot handle this file on its own.
    await expect(safePdfParse(corrupted)).rejects.toThrow();

    const filePath = writeTempPdf(corrupted, 'corrupted.pdf');
    try {
      const result = await extractPDFContent(filePath);
      expect(result.raw_text).toContain('Recovered Via Tier2 Fallback');
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('falls through to offline Tesseract OCR for an image-only (scanned) PDF', async () => {
    // ocrPdfImages() only keeps OCR results longer than 10 chars (see pdf-extractor.ts),
    // so the fixture phrase must clear that bar.
    const bytes = await buildImageOnlyPdf('HELLO WORLD');
    const filePath = writeTempPdf(bytes, 'scanned.pdf');
    try {
      const result = await extractPDFContent(filePath);
      expect(result.raw_text.startsWith('[OCR Extracted Text]')).toBe(true);
      expect(result.raw_text.toUpperCase()).toContain('HELLO');
    } finally {
      fs.unlinkSync(filePath);
    }
  }, 60_000);

  it('does not crash the process when Tesseract fails on an oversized scanned image (regression: missing errorHandler crashed the whole server)', async () => {
    const bytes = await buildOversizedImageOnlyPdf(2600);
    const filePath = writeTempPdf(bytes, 'oversized-scan.pdf');
    try {
      // The real bug: without createWorker's errorHandler option, tesseract.js's Node
      // worker throws inside a raw message-event callback outside any promise chain we
      // await, which Node treats as an uncaught exception and crashes the whole process —
      // not just this call. There is no exception for this test to catch; the assertion is
      // that execution reaches this point at all, having resolved instead of the process dying.
      const result = await extractPDFContent(filePath);
      expect(typeof result.raw_text).toBe('string');
    } finally {
      fs.unlinkSync(filePath);
    }
  }, 60_000);
});

describe('extractPDFContent — corrupted-but-nonempty digital text (bad font ToUnicode CMap)', () => {
  // These tests drive Step 1 (pdf-parse) output directly via vi.doMock, since
  // reproducing a genuinely broken embedded-font ToUnicode CMap (the real
  // doc-2545 bug) through pdf-lib is impractical for a unit-test fixture. Each
  // test dynamically re-imports a fresh pdf-extractor module instance so the
  // mock does not leak into the other (unmocked) tests in this file.
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('pdf-parse');
    vi.resetModules();
  });

  it('falls through to OCR and recovers clean text when pdf-parse output is likely corrupted and pdfjs-dist has no text layer to offer', async () => {
    const garbledText = buildGarbledCorruptedText();
    vi.doMock('pdf-parse', () => ({
      // safePdfParse() first checks `(pdfPkg as any).PDFParse` before falling
      // back to a callable default export; Vitest's mock module proxy throws
      // on access to an export the factory didn't declare, so PDFParse must
      // be explicitly present (as undefined) to route through the intended
      // `handler = pdfPkg.default` fallback path.
      PDFParse: undefined,
      default: async () => ({ text: garbledText, numpages: 1, info: {} })
    }));
    const { extractPDFContent: extractPDFContentFresh } = await import('./pdf-extractor.js');

    // Image-only page: pdfjs-dist (Step 2) finds no text objects at all (empty,
    // not corrupted), so the chain must continue to Step 3 OCR, which should
    // recognize the clearly-rendered word. Reuses the exact phrase already
    // proven reliable for this Tesseract/canvas environment in the sibling
    // "falls through to offline Tesseract OCR" test above.
    const bytes = await buildImageOnlyPdf('HELLO WORLD');
    const filePath = writeTempPdf(bytes, 'corrupted-then-ocr.pdf');
    try {
      const result = await extractPDFContentFresh(filePath);
      expect(result.raw_text.startsWith('[OCR Extracted Text]')).toBe(true);
      expect(result.raw_text.toUpperCase()).toContain('HELLO');
      // The garbled Step 1 text must NOT have been kept once OCR recovered something usable.
      expect(result.raw_text).not.toContain('roAN');
    } finally {
      fs.unlinkSync(filePath);
    }
  }, 60_000);

  it('keeps the original corrupted-but-nonempty text when neither pdfjs-dist nor OCR can recover anything usable', async () => {
    const garbledText = buildGarbledCorruptedText();
    vi.doMock('pdf-parse', () => ({
      // safePdfParse() first checks `(pdfPkg as any).PDFParse` before falling
      // back to a callable default export; Vitest's mock module proxy throws
      // on access to an export the factory didn't declare, so PDFParse must
      // be explicitly present (as undefined) to route through the intended
      // `handler = pdfPkg.default` fallback path.
      PDFParse: undefined,
      default: async () => ({ text: garbledText, numpages: 1, info: {} })
    }));
    const { extractPDFContent: extractPDFContentFresh } = await import('./pdf-extractor.js');

    // Blank page: pdfjs-dist (Step 2) finds nothing, and OCR (Step 3) has
    // nothing legible to recognize either — both fallbacks come up empty.
    const bytes = await buildBlankImagePdf();
    const filePath = writeTempPdf(bytes, 'corrupted-unrecoverable.pdf');
    try {
      const result = await extractPDFContentFresh(filePath);
      // Golden Rule 3 ("< 10 clean chars -> block") must NOT have been
      // triggered here: real (if garbled) content exists and must be kept,
      // not discarded, when recovery fails.
      expect(result.raw_text.length).toBeGreaterThanOrEqual(10);
      expect(result.raw_text.startsWith('[OCR Extracted Text]')).toBe(false);
      expect(result.raw_text).toContain('roAN');
      expect(result.raw_text).toBe(garbledText);
    } finally {
      fs.unlinkSync(filePath);
    }
  }, 60_000);
});

describe('parseWithPdfjs', () => {
  it('returns an empty string instead of throwing on a non-PDF buffer', async () => {
    const text = await parseWithPdfjs(Buffer.from('not a pdf at all'));
    expect(text).toBe('');
  });
});

describe('ocrPdfImages', () => {
  it('returns an empty string instead of throwing on a non-PDF buffer', async () => {
    const text = await ocrPdfImages(Buffer.from('not a pdf at all'));
    expect(text).toBe('');
  });
});

describe('encodeToBMP', () => {
  it('produces a valid 24-bit top-down BMP header and BGR pixel order for a 2x2 RGB image', () => {
    // 2x2 RGB pixels: red, green / blue, white
    const rgb = Uint8Array.from([
      255, 0, 0, 0, 255, 0,
      0, 0, 255, 255, 255, 255,
    ]);
    const bmp = encodeToBMP(rgb, 2, 2, 2 /* kind 2 = RGB */);

    // File header
    expect(bmp.toString('latin1', 0, 2)).toBe('BM');
    expect(bmp.readUInt32LE(2)).toBe(bmp.length);
    const pixelDataOffset = bmp.readUInt32LE(10);
    expect(pixelDataOffset).toBe(54);

    // DIB header
    expect(bmp.readUInt32LE(14)).toBe(40);
    expect(bmp.readInt32LE(18)).toBe(2); // width
    expect(bmp.readInt32LE(22)).toBe(-2); // negative height = top-down
    expect(bmp.readUInt16LE(28)).toBe(24); // bits per pixel

    // 2px * 3 bytes = 6 bytes/row of pixel data, padded to 8 bytes (multiple of 4).
    const rowStride = 8;
    const row0 = bmp.subarray(pixelDataOffset, pixelDataOffset + 6);
    expect([...row0]).toEqual([0, 0, 255, 0, 255, 0]); // BGR(red), BGR(green)
    expect([...bmp.subarray(pixelDataOffset + 6, pixelDataOffset + rowStride)]).toEqual([0, 0]); // row0 padding

    const row1Start = pixelDataOffset + rowStride;
    const row1 = bmp.subarray(row1Start, row1Start + 6);
    expect([...row1]).toEqual([255, 0, 0, 255, 255, 255]); // BGR(blue), BGR(white)
  });

  it('pads each row to a multiple of 4 bytes for widths not divisible by 4', () => {
    // width=1 => row is 3 bytes of pixel data, needs 1 byte of padding to reach 4
    const rgb = Uint8Array.from([10, 20, 30]);
    const bmp = encodeToBMP(rgb, 1, 1, 2);
    const pixelDataOffset = bmp.readUInt32LE(10);
    expect(bmp.length - pixelDataOffset).toBe(4);
  });
});

async function buildTextImagePng(word: string): Promise<Buffer> {
  const canvas = createCanvas(500, 260);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, 500, 260);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 72px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(word, 20, 90);
  return canvas.toBuffer('image/png');
}

describe('extractPDFContent — standalone image files', () => {
  it('uses PaddleOCR text for a standalone image file when the service succeeds', async () => {
    paddleOcrRecognizeMock.mockResolvedValue('PADDLEOCR-IMAGE-MARKER');

    const canvas = createCanvas(200, 100);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 200, 100);
    const pngBytes = canvas.toBuffer('image/png');
    const filePath = writeTempPdf(pngBytes, 'standalone.png');
    try {
      const result = await extractPDFContent(filePath);
      expect(result.raw_text).toContain('PADDLEOCR-IMAGE-MARKER');
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('falls back to Tesseract for a standalone image file when the PaddleOCR service fails', async () => {
    paddleOcrRecognizeMock.mockRejectedValue(new Error('PaddleOCR server is unavailable'));

    const canvas = createCanvas(500, 260);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 500, 260);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 72px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('HELLO WORLD', 20, 90);
    const pngBytes = canvas.toBuffer('image/png');
    const filePath = writeTempPdf(pngBytes, 'standalone-fallback.png');
    try {
      const result = await extractPDFContent(filePath);
      expect(result.raw_text.toUpperCase()).toContain('HELLO');
    } finally {
      fs.unlinkSync(filePath);
    }
  }, 60_000);
});

describe('ocrImageBufferBothEngines', () => {
  it("returns both engines' text when both succeed", async () => {
    paddleOcrRecognizeMock.mockResolvedValue('PADDLE-TEXT');
    const png = await buildTextImagePng('HELLO WORLD');

    const result = await ocrImageBufferBothEngines(png);

    expect(result.paddleOcr).toEqual({ text: 'PADDLE-TEXT' });
    expect('text' in result.tesseract).toBe(true);
    expect((result.tesseract as { text: string }).text.toUpperCase()).toContain('HELLO');
  }, 60_000);

  it("returns an error shape for PaddleOCR without blocking Tesseract's real result", async () => {
    paddleOcrRecognizeMock.mockRejectedValue(new Error('PaddleOCR server is unavailable'));
    const png = await buildTextImagePng('HELLO WORLD');

    const result = await ocrImageBufferBothEngines(png);

    expect(result.paddleOcr).toEqual({ error: 'PaddleOCR server is unavailable' });
    expect('text' in result.tesseract).toBe(true);
    expect((result.tesseract as { text: string }).text.toUpperCase()).toContain('HELLO');
  }, 60_000);
});
