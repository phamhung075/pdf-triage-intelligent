import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { CONFIG } from '../infrastructure/settings.js';
import { logger } from '../infrastructure/logger.js';
// The service ALWAYS extracts locally (extractPDFContentLocal), never through the remote-routing
// wrapper — extractPDFContent() would look at PDF_EXTRACT_SERVICE_URL and, when this service is
// the configured URL, recursively call itself over HTTP.
import { extractPDFContentLocal } from '../infrastructure/pdf-extractor.js';

export const SERVICE_NAME = 'pdf-extract';

// The upload lands on disk under the exact original basename, inside a private mkdtemp dir, so
// extractPDFContentLocal()'s per-extension routing (.pdf / .docx / .xlsx / images / .txt) and its
// filename-based text cleaning behave exactly as if the file sat in __raws. The basename arrives
// URI-encoded in X-File-Name (headers must be ASCII); decode defensively and never trust it with
// path separators or null bytes.
function decodeFilenameHeader(value: unknown): string {
  let raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'upload.bin';
  let decoded = raw.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Not valid percent-encoding — use the raw header value as-is.
  }
  decoded = path.basename(decoded).replace(/\0/g, '');
  // Linux NAME_MAX is 255 bytes; a long basename would make writeFileSync throw ENAMETOOLONG.
  if (decoded.length > 200) {
    const ext = path.extname(decoded);
    decoded = `${decoded.slice(0, 200 - ext.length)}${ext}`;
  }
  return decoded || 'upload.bin';
}

/**
 * Express app for the extraction microservice, without .listen() so tests can drive it through
 * supertest. Endpoints:
 *
 *   GET  /health   → { status: 'ok', service: 'pdf-extract', ... }
 *   POST /extract  → body: raw file bytes (any supported type); header X-File-Name: the original,
 *                    URI-encoded basename (extension matters). Responds 200 with the ExtractedPDF
 *                    contract { checksum, raw_text, numpages, info, ocr_degraded? }.
 *
 * No auth and no network exposure by default (EXTRACT_SERVICE_HOST defaults to 127.0.0.1; the
 * Docker image overrides it to 0.0.0.0) — same trust model as the local PaddleOCR/Ollama services.
 */
export function createExtractServiceApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/', (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      health: '/health',
      extract: 'POST /extract — raw file bytes as application/octet-stream + X-File-Name header',
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: SERVICE_NAME, pid: process.pid, uptimeSec: Math.round(process.uptime()) });
  });

  app.post(
    '/extract',
    express.raw({ type: '*/*', limit: CONFIG.EXTRACT_SERVICE_MAX_BYTES }),
    async (req, res) => {
      const startedAt = Date.now();
      const filename = decodeFilenameHeader(req.headers['x-file-name']);
      const body: Buffer | undefined = req.body;

      if (!body || body.length === 0) {
        res.status(400).json({ error: 'Empty request body — send the file bytes with an X-File-Name header.' });
        return;
      }

      let tmpDir: string | null = null;
      try {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-extract-'));
        const filePath = path.join(tmpDir, filename);
        fs.writeFileSync(filePath, body);

        const result = await extractPDFContentLocal(filePath);
        logger.info(
          'EXTRACT_SERVICE',
          `Extracted '${filename}': ${result.raw_text.length} chars, ${result.numpages} page(s) in ${Date.now() - startedAt}ms`,
          { filename, numpages: result.numpages, checksum: result.checksum.substring(0, 10) }
        );
        res.json(result);
      } catch (err: any) {
        logger.error('EXTRACT_SERVICE', `Extraction failed for '${filename}': ${err.message}`);
        res.status(500).json({ error: err.message || 'Extraction failed' });
      } finally {
        if (tmpDir) {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            // Best-effort temp cleanup — a leftover dir under os.tmpdir() is harmless.
          }
        }
      }
    }
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err && err.type === 'entity.too.large') {
      res.status(413).json({ error: `Payload too large (limit ${CONFIG.EXTRACT_SERVICE_MAX_BYTES} bytes)` });
      return;
    }
    logger.error('EXTRACT_SERVICE', `Unhandled error: ${err?.message || err}`);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
