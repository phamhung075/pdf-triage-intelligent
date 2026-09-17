import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { AddressInfo } from 'net';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

// Docling-routing tests for extractPDFContent() — the optional structured-extraction layer that
// sits in front of the normal chain when DOCLING_SERVICE_URL is set. Each case re-imports the
// module graph under its own DOCLING_SERVICE_* env snapshot (CONFIG is captured at import time,
// so vi.resetModules() is required between cases). Fixtures are REAL tiny PDFs built with pdf-lib,
// so whenever Docling is rejected/unreachable the fallback (in-process extraction) still yields
// text and the document is never stranded.
//
// ENV-SHIELDING (critical): settings.ts runs dotenv.config() against the repo's gitignored .env,
// which sets PDF_EXTRACT_SERVICE_URL to the live Docker service. dotenv re-injects any key that is
// merely ABSENT from process.env, so tests must set PDF_EXTRACT_SERVICE_URL='' EXPLICITLY (never
// delete it) or every "in-process fallback" assertion silently becomes a remote call against the
// user's running pdf-extract container. applyEnv() below always assigns ''.
//
// RAW-TEXT ASSERTIONS (deliberately loose): two near-identical pdf-lib fixtures parsed in one
// vitest worker trip a pre-existing pdf.js v1.10.100 state artifact (the second healthy PDF's
// in-process text can come back as the first's; reproducible on pristine HEAD, absent under the
// tsx production runner). This file owns the ROUTING decision — docling adopted / rejected /
// unreachable — which is asserted via `docling_markdown` presence and the exact WARN/INFO log
// lines. The in-process chain's text quality is pdf-extractor.test.ts's job.

const DOCLING_ENV_KEYS = [
  'DOCLING_SERVICE_URL',
  'DOCLING_SERVICE_REQUIRED',
  'DOCLING_SERVICE_TIMEOUT_MS',
  // The normal remote layer must be OFF for these tests to exercise in-process fallback. Setting
  // it to '' (never deleting the key) matters: settings.ts runs dotenv.config() against the repo's
  // gitignored .env, and dotenv re-injects any key that is merely absent — a live local
  // PDF_EXTRACT_SERVICE_URL would silently turn every "in-process fallback" assertion into a
  // remote call against the user's running Docker service.
  'PDF_EXTRACT_SERVICE_URL',
];

function applyEnv(env: Record<string, string>): void {
  for (const key of DOCLING_ENV_KEYS) {
    process.env[key] = key in env ? env[key] : '';
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
    applyEnv({});
    throw err;
  }
}

/** Stands up a fake Docling endpoint whose /extract answers with a fixed JSON body. */
async function fakeDoclingServer(body: () => any, status = 200): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/extract')) {
      res.writeHead(404).end('not found');
      return;
    }
    // Drain the request body (the real service hashes it; the fake ignores content).
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body()));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function buildPdf(text: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-docling-route-'));
  const file = path.join(dir, 'releve-docling.pdf');
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([400, 300]);
  const font = await pdfDoc.embedFont('Helvetica');
  page.drawText(text, { x: 20, y: 150, size: 14, font });
  fs.writeFileSync(file, await pdfDoc.save({ useObjectStreams: false }));
  return file;
}

afterEach(() => {
  applyEnv({});
});

describe('extractPDFContent Docling routing', () => {
  it('never invokes Docling and never attaches docling_markdown when DOCLING_SERVICE_URL is unset', async () => {
    const { extractPDFContent, recentLogs } = await freshExtractor({ DOCLING_SERVICE_URL: '' });
    const file = await buildPdf('Relevé de compte local — virement SFR 2026');

    try {
      const result = await extractPDFContent(file);
      expect(result.raw_text).toContain('virement SFR 2026');
      expect(result.docling_markdown).toBeUndefined();
      expect(recentLogs().some(e => e.message.includes('Docling structured extraction adopted'))).toBe(false);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('adopts Docling output (text + docling_markdown) when the gate passes', async () => {
    const md = [
      '# Relevé de compte Crédit Mutuel',
      '',
      '| Date | Opération | Débit |',
      '| --- | --- | --- |',
      '| 03/10/2023 | PRLV SEPA PAYPAL | -2,00 EUR |',
      '| 28/09/2023 | VIR DE MME DUPONT MARIE | +1 000,00 EUR |',
    ].join('\n');
    const server = await fakeDoclingServer(() => ({
      checksum: 'ignored-by-caller',
      raw_text: 'Relevé de compte Crédit Mutuel. PRLV SEPA PAYPAL -2,00 EUR. VIR DE MME DUPONT MARIE +1 000,00 EUR.',
      markdown: md,
      numpages: 1,
    }));
    const { port } = server.address() as AddressInfo;
    const file = await buildPdf('contenu quelconque ignoré par le faux service');

    try {
      const { extractPDFContent, recentLogs } = await freshExtractor({
        DOCLING_SERVICE_URL: `http://127.0.0.1:${port}`,
      });
      const result = await extractPDFContent(file);
      expect(result.docling_markdown).toBe(md);
      expect(result.raw_text).toContain('Crédit Mutuel');
      expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(recentLogs().some(e => e.message.includes('Docling structured extraction adopted'))).toBe(true);
    } finally {
      server.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('falls back to in-process extraction when Docling returns a whole-page picture (gate rejects)', async () => {
    const server = await fakeDoclingServer(() => ({
      raw_text: '',
      markdown: '<!-- image -->', // the photo-derived PDF failure class
      numpages: 1,
    }));
    const { port } = server.address() as AddressInfo;
    const file = await buildPdf('Fallback local après rejet Docling — facture 42');

    try {
      const { extractPDFContent, recentLogs } = await freshExtractor({
        DOCLING_SERVICE_URL: `http://127.0.0.1:${port}`,
      });
      const result = await extractPDFContent(file);
      // Gate rejected the picture-only output → no docling markdown adopted, and the fallback log
      // names the rejection. (raw_text content is deliberately NOT asserted: the in-process chain's
      // exact text is covered by pdf-extractor.test.ts, and parsing a second pdf-lib fixture in the
      // same vitest worker trips a pre-existing pdf.js v1.10.100 state artifact — see the test
      // header comment. The routing decision is what this file owns.)
      expect(result.docling_markdown).toBeUndefined();
      expect((result.raw_text || '').trim().length).toBeGreaterThan(0);
      expect(recentLogs().some(e => e.message.includes('Docling output rejected by the quality gate'))).toBe(true);
    } finally {
      server.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('falls back to in-process extraction when Docling is unreachable', async () => {
    const file = await buildPdf('Service Docling indisponible — bascule extraction locale');
    try {
      const { extractPDFContent, recentLogs } = await freshExtractor({
        DOCLING_SERVICE_URL: 'http://127.0.0.1:1', // nothing listens on port 1
      });
      const result = await extractPDFContent(file);
      expect(result.docling_markdown).toBeUndefined();
      expect((result.raw_text || '').trim().length).toBeGreaterThan(0);
      expect(recentLogs().some(e => e.message.includes('Docling service') && e.message.includes('unreachable'))).toBe(true);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('fails hard when DOCLING_SERVICE_REQUIRED=1 and Docling is unreachable', async () => {
    const file = await buildPdf('Ne doit jamais être extrait sans Docling');
    try {
      const { extractPDFContent } = await freshExtractor({
        DOCLING_SERVICE_URL: 'http://127.0.0.1:1',
        DOCLING_SERVICE_REQUIRED: '1',
      });
      await expect(extractPDFContent(file)).rejects.toThrow(/Docling service unreachable/);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('fails hard when DOCLING_SERVICE_REQUIRED=1 and the gate rejects Docling output', async () => {
    const server = await fakeDoclingServer(() => ({
      raw_text: '',
      markdown: '<!-- image -->',
      numpages: 1,
    }));
    const { port } = server.address() as AddressInfo;
    const file = await buildPdf('Ne doit jamais être extrait sans Docling');

    try {
      const { extractPDFContent } = await freshExtractor({
        DOCLING_SERVICE_URL: `http://127.0.0.1:${port}`,
        DOCLING_SERVICE_REQUIRED: '1',
      });
      await expect(extractPDFContent(file)).rejects.toThrow(/Docling output rejected by the quality gate/);
    } finally {
      server.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('only routes PDF files to Docling (a .txt file bypasses the layer)', async () => {
    const server = await fakeDoclingServer(() => ({ raw_text: '', markdown: '<!-- image -->', numpages: 1 }));
    const { port } = server.address() as AddressInfo;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-docling-route-'));
    const txtFile = path.join(dir, 'note.txt');
    fs.writeFileSync(txtFile, 'Fichier texte — Docling ne doit pas être consulté');

    try {
      const { extractPDFContent, recentLogs } = await freshExtractor({
        DOCLING_SERVICE_URL: `http://127.0.0.1:${port}`,
      });
      const result = await extractPDFContent(txtFile);
      expect(result.raw_text).toContain('Fichier texte');
      // Even a deliberately garbage Docling response must not have been consulted for a .txt.
      expect(recentLogs().some(e => e.message.includes('Docling output rejected'))).toBe(false);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
