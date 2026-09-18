import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const { extractPdf2wContentMock } = vi.hoisted(() => ({ extractPdf2wContentMock: vi.fn() }));
vi.mock('./pdf2w-remote.js', () => ({ extractPdf2wContent: extractPdf2wContentMock }));

function tempFile(bytes: string): string {
  const filePath = path.join(os.tmpdir(), `pdf-extractor-test-${Date.now()}-${Math.random()}.pdf`);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

// pdf-extractor.ts is now a thin wrapper: all extraction lives in pdf2w-remote.ts (covered by its
// own test). These tests pin only the wrapper's own contract — result mapping, the local checksum
// fallback, and the absence of any in-process fallback.
describe('extractPDFContent', () => {
  beforeEach(() => {
    extractPdf2wContentMock.mockReset();
  });

  it('maps the pdf2w result onto the ExtractedPDF contract', async () => {
    extractPdf2wContentMock.mockResolvedValue({
      checksum: 'remote-checksum',
      raw_text: 'line one\n\n\n\nline two',
      numpages: 3,
      info: { title: 'Facture' },
      pdf2w_markdown: '# Facture',
    });
    const { extractPDFContent } = await import('./pdf-extractor.js');
    const filePath = tempFile('actual bytes on disk');
    try {
      const result = await extractPDFContent(filePath);
      expect(result.checksum).toBe('remote-checksum');
      expect(result.raw_text).toBe('line one\n\nline two');
      expect(result.numpages).toBe(3);
      expect(result.info).toEqual({ title: 'Facture' });
      expect(result.pdf2w_markdown).toBe('# Facture');
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('recomputes the sha256 locally when the service reports no checksum', async () => {
    extractPdf2wContentMock.mockResolvedValue({
      checksum: '',
      raw_text: 'some extracted text',
      numpages: 1,
      info: {},
      pdf2w_markdown: '',
    });
    const { extractPDFContent } = await import('./pdf-extractor.js');
    const filePath = tempFile('bytes-to-hash');
    try {
      const result = await extractPDFContent(filePath);
      const expected = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
      expect(result.checksum).toBe(expected);
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('propagates a pdf2w failure unchanged — there is no in-process fallback', async () => {
    extractPdf2wContentMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { extractPDFContent } = await import('./pdf-extractor.js');
    const filePath = tempFile('bytes');
    try {
      await expect(extractPDFContent(filePath)).rejects.toThrow('ECONNREFUSED');
    } finally {
      fs.unlinkSync(filePath);
    }
  });
});
