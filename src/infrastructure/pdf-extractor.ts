import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';
import { extractPdf2wContent } from './pdf2w-remote.js';
import { cleanExtractedTextRemote } from './clean-text-remote.js';

export interface ExtractedPDF {
  checksum: string;
  raw_text: string;
  numpages: number;
  info: any;
  // Legacy provenance flag from the deleted in-process PaddleOCR/Tesseract chain. Kept because
  // relocalize-document.ts still reads it; extractPDFContent() never sets it — pdf2w performs its
  // own vision-rescue server-side and reports no engine-degradation signal.
  ocr_degraded?: boolean;
  // Present when the pdf2w extraction service (markdown-extract-service) returned its structured
  // Markdown. A caller that converts raw text to Markdown (the Step C pass in classify-document)
  // can use this directly instead of asking the LLM to rebuild structure it already has.
  pdf2w_markdown?: string;
}

// Strips the litter a browser PDF viewer / scanner leaves behind in extracted text. Kept exported
// for the callers and tests that still use it; the pdf2w service does its own path.
export function sanitizeDocumentNoise(text: string): string {
  if (!text) return '';
  return text
    .replace(/^\[Propriétés Document:[^\]]+\]/gim, '')
    .replace(/^\[OCR Extracted Text\]/gim, '')
    .replace(/^QPtmp\d+/gim, '')
    .replace(/chrome-extension___[a-z0-9_]+/gim, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- pdf2w extraction -------------------------------------------------------------------------
//
// extractPDFContent() is the seam triage-scan, relocalize-document and repair-registry import.
// Every file — PDF, photo-derived PDF, office document — is delegated over HTTP to the required
// self-hosted markdown-extract-service (pdf2w) via pdf2w-remote.ts. There is no in-process
// fallback: an unreachable service is a hard error for that file (FILE_FAILED), by design (see
// docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md).
export async function extractPDFContent(filePath: string): Promise<ExtractedPDF> {
  const filename = path.basename(filePath);
  const pdf2w = await extractPdf2wContent(filePath);
  logger.info('PDF_PARSER', `Extraction delegated to pdf2w (${pdf2w.raw_text.length} chars)`, { filename });
  return {
    // Checksum computed locally, not trusted from the service: it is the dedupe key, and every
    // transport must produce the SAME sha256 over the file bytes or the same physical file would
    // be registered as different documents depending on transport.
    checksum: pdf2w.checksum || crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    raw_text: await cleanExtractedTextRemote(pdf2w.raw_text),
    numpages: pdf2w.numpages,
    info: pdf2w.info,
    pdf2w_markdown: pdf2w.pdf2w_markdown,
  };
}
