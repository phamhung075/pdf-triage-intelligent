import fs from 'fs';
import path from 'path';
import { CONFIG } from './settings.js';

/**
 * HTTP client for the optional Docling structured-extraction service (see the DOCLING_SERVICE_*
 * settings and the routing in pdf-extractor.ts).
 *
 * Docling (layout-aware PDF → Markdown with real tables) runs OUT of process — it is a Python
 * stack, so it lives behind an HTTP endpoint the same way the Dockerized extraction microservice
 * does. The service contract is a strict superset of the extraction contract:
 *
 *   POST /extract   raw file bytes + X-File-Name header
 *   200 → { checksum, raw_text, numpages, info?, ocr_degraded?, markdown, text? }
 *
 * `markdown` is Docling's structured export; `text` (optional) is its own plain-text projection —
 * when absent the caller projects the Markdown (see domain/docling-quality.ts). The other fields
 * keep the ExtractedPDF contract so routing can substitute this result transparently.
 *
 * Nothing here imports pdf-extractor.ts on purpose (same import-cycle rule as pdf-extract-remote.ts):
 * the extraction module imports this client, so the result type is declared structurally and must
 * stay compatible with ExtractedPDF.
 */
export interface DoclingExtractResult {
  checksum: string;
  raw_text: string;
  numpages: number;
  info: any;
  ocr_degraded?: boolean;
  /** Docling's structured Markdown export (its reason to exist). */
  markdown: string;
  /** Docling's own plain-text projection of the same content, when the service provides one. */
  text?: string;
}

export function isDoclingExtractionConfigured(): boolean {
  return CONFIG.DOCLING_SERVICE_URL.length > 0;
}

export function isDoclingExtractionRequired(): boolean {
  return CONFIG.DOCLING_SERVICE_REQUIRED;
}

/**
 * POSTs a PDF to the Docling service and returns its structured extraction.
 *
 * Throws on transport failure, non-2xx status, or an unexpected response shape — the caller
 * (extractPDFContent in pdf-extractor.ts) decides between falling back to the normal chain and
 * failing hard. Deliberately NO default timeout, matching pdf-extract-remote.ts: Docling layout +
 * table + OCR of a scanned page legitimately takes tens of seconds, and triage is 1-by-1
 * sequential. Set DOCLING_SERVICE_TIMEOUT_MS to impose one anyway.
 */
export async function extractDoclingContent(filePath: string): Promise<DoclingExtractResult> {
  const baseUrl = CONFIG.DOCLING_SERVICE_URL.replace(/\/+$/, '');
  const fileBuffer = fs.readFileSync(filePath);
  const filename = encodeURIComponent(path.basename(filePath));
  const timeoutMs = CONFIG.DOCLING_SERVICE_TIMEOUT_MS;

  const res = await fetch(`${baseUrl}/extract`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': filename,
    },
    body: fileBuffer as unknown as BodyInit,
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!res.ok) {
    throw new Error(
      `Docling service returned ${res.status} ${res.statusText} for '${path.basename(filePath)}'`
    );
  }

  const data: any = await res.json();
  if (
    typeof data !== 'object' || data === null ||
    typeof data.markdown !== 'string'
  ) {
    throw new Error('Docling service returned an unexpected response shape (missing markdown)');
  }

  const rawText = typeof data.raw_text === 'string'
    ? data.raw_text
    : (typeof data.text === 'string' ? data.text : '');
  // The service may not project its own plain text — derive it client-side so routing always has
  // both (raw_text for the ExtractedPDF contract, markdown for the gate + Step C).
  const { projectDoclingMarkdownToText } = await import('../domain/docling-quality.js');

  return {
    // checksum echoed by the service (when present) — the caller must NOT rely on it for dedupe;
    // extractPDFContent recomputes the sha256 locally so every transport produces the same key.
    checksum: typeof data.checksum === 'string' ? data.checksum : '',
    raw_text: rawText || projectDoclingMarkdownToText(data.markdown),
    numpages: typeof data.numpages === 'number' && data.numpages >= 1 ? data.numpages : 1,
    info: data.info && typeof data.info === 'object' ? data.info : {},
    ocr_degraded: data.ocr_degraded === true,
    markdown: data.markdown,
    text: typeof data.text === 'string' ? data.text : undefined,
  };
}
