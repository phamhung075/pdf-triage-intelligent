import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeCanonicalPathRemote } from './canonical-path-remote.js';
import { CONFIG } from './settings.js';

describe('computeCanonicalPathRemote', () => {
  const originalUrl = CONFIG.CANONICAL_PATH_SERVICE_URL;
  const originalFetch = global.fetch;

  beforeEach(() => {
    CONFIG.CANONICAL_PATH_SERVICE_URL = 'http://127.0.0.1:3985';
  });

  afterEach(() => {
    CONFIG.CANONICAL_PATH_SERVICE_URL = originalUrl;
    global.fetch = originalFetch;
  });

  it('posts the parameters and returns canonicalPath from the response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ canonicalPath: 'C:\\archive\\invoices\\sfr\\2024\\facture.pdf' }),
    }) as any;

    const result = await computeCanonicalPathRemote('C:\\raws\\facture.pdf', 'invoices', 'C:\\archive', 'sfr', '2024-05-12');

    expect(result).toBe('C:\\archive\\invoices\\sfr\\2024\\facture.pdf');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3985/canonical-path',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws when the service is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
    await expect(
      computeCanonicalPathRemote('C:\\raws\\facture.pdf', 'invoices', 'C:\\archive')
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('throws when CANONICAL_PATH_SERVICE_URL is not configured', async () => {
    CONFIG.CANONICAL_PATH_SERVICE_URL = '';
    await expect(
      computeCanonicalPathRemote('C:\\raws\\facture.pdf', 'invoices', 'C:\\archive')
    ).rejects.toThrow('CANONICAL_PATH_SERVICE_URL is not configured');
  });
});
