import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { extractPdf2wContent } from './pdf2w-remote.js';
import { CONFIG } from './settings.js';

describe('extractPdf2wContent', () => {
  const originalUrl = CONFIG.PDF2W_SERVICE_URL;
  const originalFetch = global.fetch;
  const tmpFile = 'test-fixture-pdf2w.pdf';

  beforeEach(() => {
    CONFIG.PDF2W_SERVICE_URL = 'http://127.0.0.1:3984';
    fs.writeFileSync(tmpFile, '%PDF-1.4 fake content for hashing');
  });

  afterEach(() => {
    CONFIG.PDF2W_SERVICE_URL = originalUrl;
    global.fetch = originalFetch;
    fs.unlinkSync(tmpFile);
  });

  it('posts the file and returns the extraction result', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ markdown: '# Facture', text: 'Facture SFR', numpages: 1, checksum: 'abc' }),
    }) as any;

    const result = await extractPdf2wContent(tmpFile);

    expect(result.raw_text).toBe('Facture SFR');
    expect(result.pdf2w_markdown).toBe('# Facture');
    expect(result.numpages).toBe(1);
  });

  it('throws when the service is unreachable (no fallback)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
    await expect(extractPdf2wContent(tmpFile)).rejects.toThrow('ECONNREFUSED');
  });

  it('throws when PDF2W_SERVICE_URL is not configured', async () => {
    CONFIG.PDF2W_SERVICE_URL = '';
    await expect(extractPdf2wContent(tmpFile)).rejects.toThrow('PDF2W_SERVICE_URL is not configured');
  });
});
