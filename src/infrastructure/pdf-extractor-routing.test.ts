import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createExtractServiceApp } from '../extract-service/app.js';

// Remote-routing tests for extractPDFContent() — the seam where the Dockerized extraction
// microservice plugs into the main app. Each case re-imports the module graph under its own
// PDF_EXTRACT_SERVICE_* env snapshot (CONFIG is captured at import time, so vi.resetModules() is
// required between cases). Content is .txt so no OCR tier ever runs.

const EXTRACT_ENV_KEYS = [
  'PDF_EXTRACT_SERVICE_URL',
  'PDF_EXTRACT_SERVICE_REQUIRED',
  'PDF_EXTRACT_SERVICE_TIMEOUT_MS',
];

function applyEnv(env: Record<string, string>): void {
  for (const key of EXTRACT_ENV_KEYS) {
    if (key in env) process.env[key] = env[key];
    else delete process.env[key];
  }
}

async function freshExtractor(env: Record<string, string>): Promise<{
  extractPDFContent: (filePath: string) => Promise<any>;
  recentLogs: () => { message: string }[];
}> {
  applyEnv(env);
  try {
    vi.resetModules();
    const extractor = await import('./pdf-extractor.js');
    const logger = await import('./logger.js');
    return {
      extractPDFContent: extractor.extractPDFContent,
      recentLogs: () => logger.getRecentLogs(),
    };
  } catch (err) {
    // Leave the environment clean even when the import fails.
    applyEnv({});
    throw err;
  }
}

function writeTmpTxt(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-extract-route-'));
  const file = path.join(dir, 'note-route.txt');
  fs.writeFileSync(file, content);
  return file;
}

afterEach(() => {
  applyEnv({});
});

describe('extractPDFContent remote routing', () => {
  it('extracts in-process when no PDF_EXTRACT_SERVICE_URL is set (default behavior)', async () => {
    const { extractPDFContent, recentLogs } = await freshExtractor({ PDF_EXTRACT_SERVICE_URL: '' });
    const file = writeTmpTxt('Extraction locale par défaut — facture 42');

    try {
      const result = await extractPDFContent(file);
      expect(result.raw_text).toContain('facture 42');
      expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
      // No delegation log line → the local extractor really ran.
      expect(recentLogs().some(e => e.message.includes('delegated'))).toBe(false);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('delegates to the extraction service over HTTP when PDF_EXTRACT_SERVICE_URL is set', async () => {
    // Live service on an ephemeral port, in-process (supertest-free real listener).
    const server = createExtractServiceApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const file = writeTmpTxt('Extraction déléguée au microservice Docker — relevé bancaire 2026');

    try {
      const { extractPDFContent, recentLogs } = await freshExtractor({
        PDF_EXTRACT_SERVICE_URL: `http://127.0.0.1:${port}`,
      });
      const result = await extractPDFContent(file);
      expect(result.raw_text).toContain('relevé bancaire 2026');
      expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(recentLogs().some(e => e.message.includes('Extraction delegated to'))).toBe(true);
    } finally {
      server.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('falls back to in-process extraction with a WARN when the service is unreachable', async () => {
    const { extractPDFContent, recentLogs } = await freshExtractor({
      PDF_EXTRACT_SERVICE_URL: 'http://127.0.0.1:1', // nothing listens on port 1
    });
    const file = writeTmpTxt('Service indisponible — bascule extraction locale, avis d’imposition 2025');

    try {
      const result = await extractPDFContent(file);
      // The document is still extracted — never stranded by a dead Docker daemon.
      expect(result.raw_text).toContain('bascule extraction locale');
      expect(recentLogs().some(e => e.message.includes('unreachable — falling back to in-process'))).toBe(true);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('fails hard instead of falling back when PDF_EXTRACT_SERVICE_REQUIRED=1', async () => {
    const { extractPDFContent } = await freshExtractor({
      PDF_EXTRACT_SERVICE_URL: 'http://127.0.0.1:1',
      PDF_EXTRACT_SERVICE_REQUIRED: '1',
    });
    const file = writeTmpTxt('Ne doit jamais être extrait localement');

    try {
      await expect(extractPDFContent(file)).rejects.toThrow(/PDF extract service unreachable/);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
