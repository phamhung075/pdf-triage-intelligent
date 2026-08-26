import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import { CONFIG } from '../infrastructure/settings.js';

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
let realInputDir: string;

beforeEach(() => {
  vi.resetAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img2pdf-'));
  // convertImageToPdf parks the converted source under CONFIG.INPUT_DIR/.delete_files. CONFIG is a
  // mutable exported object (reloadConfigFromDisk mutates it in production), so redirecting it
  // here keeps these tests from writing into the developer's real __raws.
  realInputDir = CONFIG.INPUT_DIR;
  CONFIG.INPUT_DIR = tmpDir;
  encodeJpegMock.mockResolvedValue(TINY_JPEG);
  runOrientStepMock.mockImplementation(async (b: Buffer) => step('oriented', b));
  runCropStepMock.mockImplementation(async (b: Buffer) => step('cropped', b));
  runEnhanceStepMock.mockImplementation(async (b: Buffer) => step('enhanced', b));
  runExtractStepMock.mockResolvedValue({ step: 4, label: 'extracted', imageBase64: '', durationMs: 1, markdown: '# Invoice\n\ntotal 42', candidates: [] });
});

afterEach(() => {
  CONFIG.INPUT_DIR = realInputDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function trashDir(): string {
  return path.join(tmpDir, '.delete_files', 'img_converted');
}

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

  it('keeps the source photo in .delete_files/img_converted instead of deleting it', () => {
    // The archived PDF holds an oriented, CROPPED, re-encoded rendition. Orientation and OCR
    // failures degrade gracefully, but a bad crop silently clips the page — so the untouched
    // original is the only way back, and it used to be unlinked outright.
    return (async () => {
      const { convertImageToPdf } = await import('./convert-image-document.js');
      const photo = writePhoto();
      const originalBytes = fs.readFileSync(photo);

      await convertImageToPdf(photo);

      const kept = path.join(trashDir(), 'photo.jpg');
      expect(fs.existsSync(kept)).toBe(true);
      expect(fs.readFileSync(kept)).toEqual(originalBytes);
    })();
  });

  it('suffixes rather than overwriting when a photo of the same name was already converted', () => {
    return (async () => {
      const { convertImageToPdf } = await import('./convert-image-document.js');
      fs.mkdirSync(trashDir(), { recursive: true });
      fs.writeFileSync(path.join(trashDir(), 'photo.jpg'), 'an earlier photo from another camera');

      await convertImageToPdf(writePhoto());

      expect(fs.readFileSync(path.join(trashDir(), 'photo.jpg'), 'utf-8'))
        .toBe('an earlier photo from another camera');
      expect(fs.existsSync(path.join(trashDir(), 'photo_1.jpg'))).toBe(true);
    })();
  });

  it('parks the source under a dot-directory, which the scanner skips so it is never re-triaged', () => {
    return (async () => {
      const { convertImageToPdf } = await import('./convert-image-document.js');
      await convertImageToPdf(writePhoto());
      expect(trashDir().split(path.sep)).toContain('.delete_files');
    })();
  });

  it('never overwrites an unrelated PDF that already owns the .pdf name (document loss)', async () => {
    // The real scenario: the user drops contrat.jpg (a photo of page 2) and contrat.pdf (the
    // signed contract) into __raws. Both land in one scan batch and the image is processed
    // first. A plain writeFileSync would replace the contract's bytes with the photo, and there
    // is no copy in .duplicates_files, .delete_files or __archive to recover from.
    const { convertImageToPdf } = await import('./convert-image-document.js');
    const photo = writePhoto();
    const occupied = path.join(tmpDir, 'photo.pdf');
    const originalBytes = Buffer.from('%PDF-1.7 the pre-existing signed contract');
    fs.writeFileSync(occupied, originalBytes);

    const result = await convertImageToPdf(photo);

    // The pre-existing document is byte-for-byte intact...
    expect(fs.readFileSync(occupied)).toEqual(originalBytes);
    // ...and the conversion took a different, free name that the caller can follow.
    expect(result.pdfPath).not.toBe(occupied);
    expect(result.pdfPath).toBe(path.join(tmpDir, 'photo_1.pdf'));
    expect(fs.readFileSync(result.pdfPath).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('keeps suffixing past the first collision rather than giving up or clobbering', async () => {
    const { convertImageToPdf } = await import('./convert-image-document.js');
    const photo = writePhoto();
    fs.writeFileSync(path.join(tmpDir, 'photo.pdf'), 'first');
    fs.writeFileSync(path.join(tmpDir, 'photo_1.pdf'), 'second');

    const result = await convertImageToPdf(photo);

    expect(result.pdfPath).toBe(path.join(tmpDir, 'photo_2.pdf'));
    expect(fs.readFileSync(path.join(tmpDir, 'photo.pdf'), 'utf-8')).toBe('first');
    expect(fs.readFileSync(path.join(tmpDir, 'photo_1.pdf'), 'utf-8')).toBe('second');
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

describe('findImageBundleFolders', () => {
  function folderWith(name: string, files: Record<string, Buffer | string>): string {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), content as any);
    return dir;
  }

  it('treats a folder of two or more photos as one document', async () => {
    const { findImageBundleFolders } = await import('./convert-image-document.js');
    const dir = folderWith('contrat-bail', { 'IMG_1.jpg': TINY_JPEG, 'IMG_2.jpg': TINY_JPEG });
    expect(findImageBundleFolders(tmpDir)).toEqual([dir]);
  });

  it('does NOT bundle a folder holding a single photo', async () => {
    // One image is not a multi-page document; it should keep its own name via the ordinary path.
    const { findImageBundleFolders } = await import('./convert-image-document.js');
    folderWith('solo', { 'IMG_1.jpg': TINY_JPEG });
    expect(findImageBundleFolders(tmpDir)).toEqual([]);
  });

  it('does NOT bundle a folder that mixes photos with other files', async () => {
    // A folder the user keeps a PDF in is storage, not a document. Fusing its photos would be a
    // destructive guess, so it is left for per-file triage.
    const { findImageBundleFolders } = await import('./convert-image-document.js');
    folderWith('mixed', { 'IMG_1.jpg': TINY_JPEG, 'IMG_2.jpg': TINY_JPEG, 'notes.pdf': 'x' });
    expect(findImageBundleFolders(tmpDir)).toEqual([]);
  });

  it('ignores dot-directories, where blocked/duplicate/converted files live', async () => {
    const { findImageBundleFolders } = await import('./convert-image-document.js');
    folderWith('.delete_files', { 'IMG_1.jpg': TINY_JPEG, 'IMG_2.jpg': TINY_JPEG });
    expect(findImageBundleFolders(tmpDir)).toEqual([]);
  });

  it('ignores OS junk files when deciding whether a folder is image-only', async () => {
    const { findImageBundleFolders } = await import('./convert-image-document.js');
    const dir = folderWith('scan', { 'a.jpg': TINY_JPEG, 'b.jpg': TINY_JPEG, 'Thumbs.db': 'junk' });
    expect(findImageBundleFolders(tmpDir)).toEqual([dir]);
  });

  it('never treats the root itself as a bundle', async () => {
    const { findImageBundleFolders } = await import('./convert-image-document.js');
    fs.writeFileSync(path.join(tmpDir, 'a.jpg'), TINY_JPEG);
    fs.writeFileSync(path.join(tmpDir, 'b.jpg'), TINY_JPEG);
    expect(findImageBundleFolders(tmpDir)).toEqual([]);
  });
});

describe('sortImagePagesNaturally', () => {
  it('orders page 2 before page 10 (plain sort shuffles any 10+ page document)', async () => {
    const { sortImagePagesNaturally } = await import('./convert-image-document.js');
    expect(sortImagePagesNaturally(['IMG_10.jpg', 'IMG_2.jpg', 'IMG_1.jpg']))
      .toEqual(['IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg']);
  });
});

describe('convertImageFolderToPdf', () => {
  function bundle(name: string, files: string[]): string {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, f), TINY_JPEG);
    return dir;
  }

  it('produces ONE PDF named after the folder, with one page per photo', async () => {
    const { convertImageFolderToPdf } = await import('./convert-image-document.js');
    const dir = bundle('contrat-bail', ['IMG_1.jpg', 'IMG_2.jpg', 'IMG_3.jpg']);

    const result = await convertImageFolderToPdf(dir);

    expect(result.pdfPath).toBe(path.join(tmpDir, 'contrat-bail.pdf'));
    expect(result.pageCount).toBe(3);
    expect(fs.readFileSync(result.pdfPath).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('concatenates every page\'s OCR text so the classifier reads the whole document', async () => {
    const { convertImageFolderToPdf } = await import('./convert-image-document.js');
    let page = 0;
    runExtractStepMock.mockImplementation(async () => {
      page++;
      return { step: 4, label: 'extracted', imageBase64: '', durationMs: 1, markdown: `page ${page} text`, candidates: [] };
    });

    const result = await convertImageFolderToPdf(bundle('facture', ['a.jpg', 'b.jpg']));

    expect(result.rawText).toContain('page 1 text');
    expect(result.rawText).toContain('page 2 text');
  });

  it('keeps the source pages together under .delete_files/img_converted/<folder>/', async () => {
    const { convertImageFolderToPdf } = await import('./convert-image-document.js');
    const dir = bundle('releve', ['p1.jpg', 'p2.jpg']);

    await convertImageFolderToPdf(dir);

    const kept = path.join(tmpDir, '.delete_files', 'img_converted', 'releve');
    expect(fs.existsSync(path.join(kept, 'p1.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(kept, 'p2.jpg'))).toBe(true);
  });

  it('removes the folder once its pages are moved out', async () => {
    const { convertImageFolderToPdf } = await import('./convert-image-document.js');
    const dir = bundle('vide', ['a.jpg', 'b.jpg']);

    await convertImageFolderToPdf(dir);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('leaves the folder in place if anything else is still inside it', async () => {
    // Deleting a folder that still holds the user's files would be exactly the data loss the rest
    // of this module exists to prevent.
    const { convertImageFolderToPdf } = await import('./convert-image-document.js');
    const dir = bundle('reste', ['a.jpg', 'b.jpg']);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');

    await convertImageFolderToPdf(dir);

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf-8')).toBe('keep me');
  });

  it('does not overwrite a PDF that already owns the folder name', async () => {
    const { convertImageFolderToPdf } = await import('./convert-image-document.js');
    const dir = bundle('rapport', ['a.jpg', 'b.jpg']);
    const occupied = path.join(tmpDir, 'rapport.pdf');
    fs.writeFileSync(occupied, '%PDF-1.7 pre-existing');

    const result = await convertImageFolderToPdf(dir);

    expect(fs.readFileSync(occupied, 'utf-8')).toBe('%PDF-1.7 pre-existing');
    expect(result.pdfPath).toBe(path.join(tmpDir, 'rapport_1.pdf'));
  });
});
