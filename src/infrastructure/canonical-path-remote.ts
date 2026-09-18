import { CONFIG } from './settings.js';

/**
 * HTTP client for the pdf-triage-pdf2w Go service's POST /canonical-path (see
 * docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md). Required, not
 * optional-with-fallback: the caller (relocalize-document.ts) treats any rejection as a hard
 * failure for that file, matching the design's "no in-process TypeScript fallback" decision.
 */
export async function computeCanonicalPathRemote(
  originalPath: string,
  category: string,
  outputRootDir: string,
  subcategory?: string,
  dateStr?: string,
  title?: string
): Promise<string> {
  if (!CONFIG.PDF_TRIAGE_PDF2W_SERVICE_URL) {
    throw new Error('PDF_TRIAGE_PDF2W_SERVICE_URL is not configured');
  }
  const baseUrl = CONFIG.PDF_TRIAGE_PDF2W_SERVICE_URL.replace(/\/+$/, '');
  const timeoutMs = CONFIG.PDF_TRIAGE_PDF2W_SERVICE_TIMEOUT_MS;

  const res = await fetch(`${baseUrl}/canonical-path`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      originalPath,
      category,
      outputRootDir,
      subcategory: subcategory ?? null,
      dateStr: dateStr ?? null,
      title: title ?? null,
    }),
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!res.ok) {
    throw new Error(`pdf-triage-pdf2w service returned ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();
  if (typeof data?.canonicalPath !== 'string') {
    throw new Error('pdf-triage-pdf2w service returned an unexpected response shape (missing canonicalPath)');
  }
  return data.canonicalPath;
}
