import fs from 'fs';
import path from 'path';
import { CONFIG } from './settings.js';

export interface Pdf2wExtractResult {
  checksum: string;
  raw_text: string;
  numpages: number;
  info: any;
  pdf2w_markdown: string;
}

/**
 * HTTP client for the self-hosted markdown-extract-service (pdf2w). Required, not
 * optional-with-fallback: the caller (extractPDFContent in pdf-extractor.ts) treats any failure
 * as a hard error for that file — there is no in-process extraction left to fall back to. See
 * docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md.
 */
export async function extractPdf2wContent(filePath: string): Promise<Pdf2wExtractResult> {
  if (!CONFIG.PDF2W_SERVICE_URL) {
    throw new Error('PDF2W_SERVICE_URL is not configured');
  }
  const baseUrl = CONFIG.PDF2W_SERVICE_URL.replace(/\/+$/, '');
  const fileBuffer = fs.readFileSync(filePath);
  const filename = encodeURIComponent(path.basename(filePath));
  const timeoutMs = CONFIG.PDF2W_SERVICE_TIMEOUT_MS;

  const res = await fetch(`${baseUrl}/convert`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': filename,
    },
    body: fileBuffer as unknown as BodyInit,
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!res.ok) {
    throw new Error(`pdf2w service returned ${res.status} ${res.statusText} for '${path.basename(filePath)}'`);
  }

  const data: any = await res.json();
  if (typeof data?.markdown !== 'string') {
    throw new Error('pdf2w service returned an unexpected response shape (missing markdown)');
  }

  return {
    checksum: typeof data.checksum === 'string' ? data.checksum : '',
    raw_text: typeof data.text === 'string' ? data.text : data.markdown,
    numpages: typeof data.numpages === 'number' && data.numpages >= 1 ? data.numpages : 1,
    info: data.info && typeof data.info === 'object' ? data.info : {},
    pdf2w_markdown: data.markdown,
  };
}
