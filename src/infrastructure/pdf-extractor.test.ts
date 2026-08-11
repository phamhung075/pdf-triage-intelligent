import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { extractPDFContent, safePdfParse, parseWithPdfjs, ocrPdfImages, encodeToBMP } from './pdf-extractor.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

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
