import { CONFIG } from './settings.js';

/**
 * HTTP client for the pdf-triage-pdf2w Go service's POST /clean-text (see
 * docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md). Required, not
 * optional-with-fallback: the caller (pdf-extractor.ts) treats any rejection as a hard failure
 * for that file, matching the design's "no in-process TypeScript fallback" decision.
 */
export async function cleanExtractedTextRemote(text: string): Promise<string> {
  if (!CONFIG.PDF_TRIAGE_PDF2W_SERVICE_URL) {
    throw new Error('PDF_TRIAGE_PDF2W_SERVICE_URL is not configured');
  }
  const baseUrl = CONFIG.PDF_TRIAGE_PDF2W_SERVICE_URL.replace(/\/+$/, '');
  const timeoutMs = CONFIG.PDF_TRIAGE_PDF2W_SERVICE_TIMEOUT_MS;

  const res = await fetch(`${baseUrl}/clean-text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!res.ok) {
    throw new Error(`pdf-triage-pdf2w service returned ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();
  if (typeof data?.text !== 'string') {
    throw new Error('pdf-triage-pdf2w service returned an unexpected response shape (missing text)');
  }
  return data.text;
}
