import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanExtractedTextRemote } from './clean-text-remote.js';
import { CONFIG } from './settings.js';

describe('cleanExtractedTextRemote', () => {
  const originalUrl = CONFIG.PDF_TRIAGE_PDF2W_SERVICE_URL;
  const originalFetch = global.fetch;

  beforeEach(() => {
    CONFIG.PDF_TRIAGE_PDF2W_SERVICE_URL = 'http://127.0.0.1:3985';
  });

  afterEach(() => {
    CONFIG.PDF_TRIAGE_PDF2W_SERVICE_URL = originalUrl;
    global.fetch = originalFetch;
  });

  it('posts the text and returns the cleaned text from the response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'HelloWorld\n\nMore text here' }),
    }) as any;

    const result = await cleanExtractedTextRemote('Hello\0World\r\n\r\n\r\n\r\nMore text here');

    expect(result).toBe('HelloWorld\n\nMore text here');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3985/clean-text',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws when the service is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
    await expect(cleanExtractedTextRemote('some text')).rejects.toThrow('ECONNREFUSED');
  });

  it('throws when PDF_TRIAGE_PDF2W_SERVICE_URL is not configured', async () => {
    CONFIG.PDF_TRIAGE_PDF2W_SERVICE_URL = '';
    await expect(cleanExtractedTextRemote('some text')).rejects.toThrow('PDF_TRIAGE_PDF2W_SERVICE_URL is not configured');
  });
});
