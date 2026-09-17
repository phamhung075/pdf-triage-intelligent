import fs from 'fs';
import path from 'path';
import { CONFIG } from './settings.js';

/**
 * HTTP client for the Dockerized PDF text-extraction microservice (src/extract-service).
 *
 * The service is an alternative *transport* for the exact same ExtractedPDF contract that
 * extractPDFContentLocal() returns in-process: send the raw file bytes, get back
 * { checksum, raw_text, numpages, info, ocr_degraded }. Nothing here imports pdf-extractor.ts on
 * purpose — the extraction module imports this client for its remote-routing wrapper, so a runtime
 * import cycle would be created if this module imported back. The result type is therefore
 * declared structurally (it must stay identical to ExtractedPDF in pdf-extractor.ts).
 */
export interface RemoteExtractResult {
  checksum: string;
  raw_text: string;
  numpages: number;
  info: any;
  ocr_degraded?: boolean;
}

export function isRemoteExtractionConfigured(): boolean {
  return CONFIG.PDF_EXTRACT_SERVICE_URL.length > 0;
}

export function isRemoteExtractionRequired(): boolean {
  return CONFIG.PDF_EXTRACT_SERVICE_REQUIRED;
}

/**
 * POSTs the file to the configured service and returns the extraction result.
 *
 * Throws on transport failure (service down, refused, timeout), non-2xx status, or an unexpected
 * response shape — the caller (extractPDFContent in pdf-extractor.ts) decides between falling back
 * to in-process extraction and failing hard. Deliberately NO default timeout: OCR of a scanned
 * page takes minutes and the triage pipeline is 1-by-1 sequential, so a client timeout would
 * abort healthy work. Set PDF_EXTRACT_SERVICE_TIMEOUT_MS to impose one anyway.
 */
export async function extractPDFContentRemote(filePath: string): Promise<RemoteExtractResult> {
  const baseUrl = CONFIG.PDF_EXTRACT_SERVICE_URL.replace(/\/+$/, '');
  const fileBuffer = fs.readFileSync(filePath);
  const filename = encodeURIComponent(path.basename(filePath));
  const timeoutMs = CONFIG.PDF_EXTRACT_SERVICE_TIMEOUT_MS;

  const res = await fetch(`${baseUrl}/extract`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      // The service stores the upload under this exact basename, so its per-extension routing
      // (.pdf / .docx / .xlsx / image / .txt) and its filename-based text cleaning behave exactly
      // as if the file sat in __raws. URI-encoded because HTTP headers must be ASCII.
      'x-file-name': filename,
    },
    // Buffer is a Uint8Array subclass: pass the buffer directly (no copy).
    body: fileBuffer as unknown as BodyInit,
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!res.ok) {
    throw new Error(
      `PDF extract service returned ${res.status} ${res.statusText} for '${path.basename(filePath)}'`
    );
  }

  const data: any = await res.json();
  if (
    typeof data !== 'object' || data === null ||
    typeof data.raw_text !== 'string' ||
    typeof data.checksum !== 'string'
  ) {
    throw new Error('PDF extract service returned an unexpected response shape (missing checksum/raw_text)');
  }

  return {
    checksum: data.checksum,
    raw_text: data.raw_text,
    numpages: typeof data.numpages === 'number' && data.numpages >= 1 ? data.numpages : 1,
    info: data.info && typeof data.info === 'object' ? data.info : {},
    ocr_degraded: data.ocr_degraded === true,
  };
}
