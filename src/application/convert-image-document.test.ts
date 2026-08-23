import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';

const { runOrientStepMock, runCropStepMock, runEnhanceStepMock, runExtractStepMock } = vi.hoisted(() => ({
  runOrientStepMock: vi.fn(),
  runCropStepMock: vi.fn(),
  runEnhanceStepMock: vi.fn(),
  runExtractStepMock: vi.fn(),
}));
vi.mock('./image-to-pdf.js', () => ({
  runOrientStep: runOrientStepMock,
  runCropStep: runCropStepMock,
  runEnhanceStep: runEnhanceStepMock,
  runExtractStep: runExtractStepMock,
}));

// The real encoder needs a decodable image; the converter only cares that it returns JPEG bytes,
// and pdf-lib needs a real JPEG to embed, so a fixed minimal JPEG is substituted.
const { encodeJpegMock } = vi.hoisted(() => ({ encodeJpegMock: vi.fn() }));
vi.mock('../infrastructure/image-processor.js', () => ({ encodeJpeg: encodeJpegMock }));

// A real, decodable JPEG generated at load time. Hand-written JPEG bytes are easy to get subtly
// wrong, and pdf-lib rejects anything malformed with "SOI not found in JPEG".
const TINY_JPEG: Buffer = (() => {
  const c = createCanvas(8, 8);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 8, 8);
  ctx.fillStyle = '#000000';
  ctx.fillRect(1, 1, 3, 3);
  return c.toBuffer('image/jpeg', 90);
})();

const step = (label: string, buf: Buffer) => ({ step: 1, label, imageBase64: buf.toString('base64'), durationMs: 1 });

let tmpDir: string;

beforeEach(() => {
  vi.resetAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img2pdf-'));
  encodeJpegMock.mockResolvedValue(TINY_JPEG);
  runOrientStepMock.mockImplementation(async (b: Buffer) => step('oriented', b));
  runCropStepMock.mockImplementation(async (b: Buffer) => step('cropped', b));
  runEnhanceStepMock.mockImplementation(async (b: Buffer) => step('enhanced', b));
  runExtractStepMock.mockResolvedValue({ step: 4, label: 'extracted', imageBase64: '', durationMs: 1, markdown: '# Invoice\n\ntotal 42', candidates: [] });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePhoto(name = 'photo.jpg'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, TINY_JPEG);
  return p;
}

describe('isImageFile', () => {
  it('recognises the photo extensions the scanner accepts, case-insensitively', async () => {
    const { isImageFile } = await import('./convert-image-document.js');
    for (const f of ['a.jpg', 'a.JPEG', 'a.png', 'a.webp', 'a.bmp', 'a.tiff']) {
      expect(isImageFile(f)).toBe(true);
    }
  });

  it('does not claim PDFs or other documents', async () => {
    const { isImageFile } = await import('./convert-image-document.js');
    for (const f of ['a.pdf', 'a.docx', 'a.txt', 'a.xlsx', 'noext']) {
      expect(isImageFile(f)).toBe(false);
    }
  });
});

describe('convertImageToPdf', () => {
  it('writes a PDF beside the photo and removes the photo', async () => {
    const { convertImageToPdf } = await import('./convert-image-document.js');
    const photo = writePhoto();

    const result = await convertImageToPdf(photo);

    expect(result.pdfPath).toBe(path.join(tmpDir, 'photo.pdf'));
    expect(fs.existsSync(result.pdfPath)).toBe(true);
    expect(fs.existsSync(photo)).toBe(false);
    expect(fs.readFileSync(result.pdfPath).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('returns the OCR text so the caller never has to OCR the document a second time', async () => {
    const { convertImageToPdf } = await import('./convert-image-document.js');
    const result = await convertImageToPdf(writePhoto());
    expect(result.rawText).toBe('# Invoice\n\ntotal 42');
  });

  it('checksums the PDF, not the discarded photo', async () => {
    const { convertImageToPdf } = await import('./convert-image-document.js');
    const result = await convertImageToPdf(writePhoto());
    const crypto = await import('crypto');
    const pdfHash = crypto.createHash('sha256').update(fs.readFileSync(result.pdfPath)).digest('hex');
    expect(result.checksum).toBe(pdfHash);
  });

  it('archives the CROPPED page but reads the ENHANCED one', async () => {
    const { convertImageToPdf } = await import('./convert-image-document.js');
    const croppedBuf = Buffer.from('cropped-page');
    const enhancedBuf = Buffer.from('enhanced-for-ocr');
    runCropStepMock.mockResolvedValue(step('cropped', croppedBuf));
    runEnhanceStepMock.mockResolvedValue(step('enhanced', enhancedBuf));

    await convertImageToPdf(writePhoto());

    // The page that gets encoded for the PDF is the cropped one...
    expect(encodeJpegMock).toHaveBeenCalledWith(croppedBuf, expect.any(Number));
    // ...while OCR reads the enhanced one.
    expect(runExtractStepMock).toHaveBeenCalledWith(enhancedBuf);
  });

  it('still produces a PDF when the crop step fails, using the oriented page', async () => {
    const { convertImageToPdf } = await import('./convert-image-document.js');
    const orientedBuf = Buffer.from('oriented-only');
    runOrientStepMock.mockResolvedValue(step('oriented', orientedBuf));
    runCropStepMock.mockResolvedValue({ step: 2, label: 'cropped', imageBase64: '', durationMs: 1, error: 'crop blew up' });

    const result = await convertImageToPdf(writePhoto());

    expect(fs.existsSync(result.pdfPath)).toBe(true);
    expect(encodeJpegMock).toHaveBeenCalledWith(orientedBuf, expect.any(Number));
  });

  it('still produces a PDF when orientation fails, using the original photo', async () => {
    const { convertImageToPdf } = await import('./convert-image-document.js');
    runOrientStepMock.mockResolvedValue({ step: 1, label: 'oriented', imageBase64: '', durationMs: 1, error: 'no orientation' });
    runCropStepMock.mockResolvedValue({ step: 2, label: 'cropped', imageBase64: '', durationMs: 1, error: 'no crop' });

    const photo = writePhoto();
    const result = await convertImageToPdf(photo);

    expect(fs.existsSync(result.pdfPath)).toBe(true);
    expect(encodeJpegMock).toHaveBeenCalledWith(TINY_JPEG, expect.any(Number));
  });

  it('archives the PDF even when OCR fails, rather than losing the document', async () => {
    const { convertImageToPdf } = await import('./convert-image-document.js');
    runExtractStepMock.mockResolvedValue({ step: 4, label: 'extracted', imageBase64: '', durationMs: 1, error: 'ocr down' });

    const result = await convertImageToPdf(writePhoto());

    expect(fs.existsSync(result.pdfPath)).toBe(true);
    expect(result.rawText).toBe('');
  });

  it('falls back to raw engine text when markdown conversion produced nothing', async () => {
    const { convertImageToPdf } = await import('./convert-image-document.js');
    runExtractStepMock.mockResolvedValue({
      step: 4, label: 'extracted', imageBase64: '', durationMs: 1, markdown: '',
      candidates: [
        { label: 'paddleocr', chosen: false, text: 'paddle raw text' },
        { label: 'tesseract', chosen: false, text: 'tesseract raw text' },
      ],
    });
    const result = await convertImageToPdf(writePhoto());
    expect(result.rawText).toBe('paddle raw text');
  });

  it('NEVER deletes the photo when the PDF cannot be written', async () => {
    const { convertImageToPdf } = await import('./convert-image-document.js');
    const photo = writePhoto();
    // Simulate an unwritable destination.
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('disk full'); });

    await expect(convertImageToPdf(photo)).rejects.toThrow('disk full');

    writeSpy.mockRestore();
    expect(fs.existsSync(photo)).toBe(true);
  });
});
