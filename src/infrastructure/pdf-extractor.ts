import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as pdfPkg from 'pdf-parse';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';
import { logger } from './logger.js';
import { CONFIG } from './settings.js';
import { cleanExtractedText, detectMidWordCapitalizationCorruption, detectThinTextLayer, chooseBestExtraction, type CorruptionSignal } from '../domain/pdf-text.js';
import { paddleOcrRecognize } from './paddleocr-client.js';
import { extractPDFContentRemote } from './pdf-extract-remote.js';
import { isDoclingExtractionConfigured, isDoclingExtractionRequired, extractDoclingContent } from './docling-remote.js';
import { assessDoclingMarkdown } from '../domain/docling-quality.js';

export interface ExtractedPDF {
  checksum: string;
  raw_text: string;
  numpages: number;
  info: any;
  // True when this text came out of the Tesseract availability fallback instead of PaddleOCR.
  // The two engines are NOT interchangeable in quality — on a photographed ID card PaddleOCR
  // returned the clean numbered form fields where Tesseract returned line noise — so a caller
  // that already holds text
  // for this file (re-analysis) needs to know the new extraction is the degraded one BEFORE it
  // overwrites anything with it. Undefined/false means no OCR ran, or PaddleOCR handled it.
  ocr_degraded?: boolean;
  // Present only when the Docling structured extractor (DOCLING_SERVICE_URL) ran and its output
  // passed the quality gate: the layout-aware Markdown with real tables. A caller that converts
  // raw text to Markdown (the Step C pass in classify-document) can use this directly instead of
  // asking the LLM to rebuild structure it already has. Undefined = normal extraction, unchanged.
  docling_markdown?: string;
}

export interface CanvasOcrResult {
  text: string;
  degraded: boolean;
}

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

export async function safePdfParse(buffer: Buffer): Promise<{ text: string; numpages: number; info: any }> {
  const originalWarn = console.warn;
  try {
    console.warn = (...args: any[]) => {
      const msg = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
      if (msg.includes('Warning: TT:') || msg.includes('TT: undefined function') || msg.includes('TT: invalid function')) {
        return;
      }
      originalWarn(...args);
    };

    if ((pdfPkg as any).PDFParse) {
      try {
        const instance = new (pdfPkg as any).PDFParse({ data: buffer });
        const res = await instance.getText();
        if (res && typeof res.text === 'string') {
          return {
            text: res.text,
            numpages: res.numpages || res.total || 1,
            info: res.info || {}
          };
        }
      } catch (err: any) {
        logger.debug('PDF_PARSER', `Class PDFParse constructor failed: ${err.message}`);
      }
    }

    const handler = typeof pdfPkg === 'function' ? pdfPkg : ((pdfPkg as any).default || pdfPkg);
    if (typeof handler === 'function') {
      const res = await handler(buffer, { max: 0 });
      return {
        text: res.text || '',
        numpages: res.numpages || 1,
        info: res.info || {}
      };
    }

    throw new Error('Unable to find valid pdf-parse function or class constructor.');
  } finally {
    console.warn = originalWarn;
  }
}

// Ceiling for the pdfjs recovery parser. Previously a bare `Math.min(doc.numPages, 10)`, which
// quietly dropped everything past page 10 of any document that reached this fallback — 10 of the
// 273 archived documents are longer than that. Pure text extraction costs milliseconds per page,
// so the ceiling is high enough to be a runaway guard rather than a quality trade-off.
const PDFJS_MAX_PAGES = 200;

// Fallback 1: Robust text extraction via pdfjs-dist legacy (recovers text from corrupted XRef tables)
export async function parseWithPdfjs(buffer: Buffer): Promise<string> {
  try {
    const loadingTask = (pdfjsLib as any).getDocument({ data: new Uint8Array(buffer), ignoreErrors: true, useSystemFonts: true });
    const doc = await loadingTask.promise;
    let fullText = '';
    // Same rule as the canvas OCR path: cap if we must, but never silently. This one is cheap
    // (text extraction, no rendering and no OCR round-trip), so it gets a much higher ceiling —
    // it exists to bound a pathological document, not to trade quality for speed.
    const numPages = Math.min(doc.numPages, PDFJS_MAX_PAGES);
    if (doc.numPages > numPages) {
      logger.warn(
        'PDF_PARSER',
        `pdfjs-dist recovery parser truncated: reading only ${numPages} of ${doc.numPages} pages — ` +
        `text from pages ${numPages + 1}-${doc.numPages} will be MISSING.`,
        { totalPages: doc.numPages, parsedPages: numPages, skippedPages: doc.numPages - numPages }
      );
    }
    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(' ');
      fullText += pageText + '\n';
    }
    return fullText.trim();
  } catch (err: any) {
    logger.debug('PDF_PARSER', `pdfjs-dist fallback text parse failed: ${err.message}`);
    return '';
  }
}


// Helper to convert raw pixel data into BMP buffer
export function encodeToBMP(dataBuffer: Uint8Array, width: number, height: number, kind: number): Buffer {
  const isRGBA = kind === 3;
  const bytesPerPixel = isRGBA ? 4 : 3;
  const fileHeaderSize = 14;
  const bihSize = 40;
  const padding = (4 - ((width * 3) % 4)) % 4;
  const imageSize = (width * 3 + padding) * height;
  const fileSize = fileHeaderSize + bihSize + imageSize;

  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(fileHeaderSize + bihSize, 10);
  buf.writeUInt32LE(bihSize, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(-height, 22); // Top-down
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28); // 24 bits
  buf.writeUInt32LE(imageSize, 34);

  let offset = fileHeaderSize + bihSize;
  const rowSize = width * bytesPerPixel;
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    for (let x = 0; x < width; x++) {
      const p = rowStart + x * bytesPerPixel;
      buf[offset++] = dataBuffer[p + 2]; // B
      buf[offset++] = dataBuffer[p + 1]; // G
      buf[offset++] = dataBuffer[p];     // R
    }
    for (let p = 0; p < padding; p++) {
      buf[offset++] = 0;
    }
  }
  return buf;
}

let sharedTesseractWorkerPromise: Promise<any> | null = null;

// tesseract.js downloads each language's .traineddata from a CDN the first time a worker loads.
// In the Dockerized extraction image (and any air-gapped install) that network dependency must
// not exist: when TESSERACT_LANG_PATH points at a folder holding fra/eng/vie.traineddata, the
// worker reads them straight from disk instead (tesseract.js loadLanguage accepts a local
// directory on Node). Unset = stock behavior, so local/dev environments are untouched. The repo
// ships eng.traineddata / fra.traineddata / vie.traineddata at its root, and the image COPYs them
// into /app/tessdata for exactly this purpose.
function tesseractWorkerOptions(): { langPath: string; cacheMethod: 'none' } | undefined {
  const langPath = (process.env.TESSERACT_LANG_PATH || '').trim();
  return langPath ? { langPath, cacheMethod: 'none' } : undefined;
}

export async function getSharedTesseractWorker(): Promise<any> {
  if (!sharedTesseractWorkerPromise) {
    sharedTesseractWorkerPromise = (async () => {
      try {
        const opts = tesseractWorkerOptions();
        const worker = opts
          ? await createWorker(['fra', 'eng', 'vie'], undefined, opts)
          : await createWorker(['fra', 'eng', 'vie']);
        return worker;
      } catch (err: any) {
        sharedTesseractWorkerPromise = null;
        throw err;
      }
    })();
  }
  return sharedTesseractWorkerPromise;
}

// Tries PaddleOCR first (better accuracy on real scanned/photographed documents); falls back
// to the local Tesseract worker only if the PaddleOCR service call fails — an availability
// fallback, not a quality cascade (only one good text result is needed here).
async function ocrPageBuffer(pngBuf: Buffer): Promise<CanvasOcrResult> {
  try {
    return { text: await paddleOcrRecognize(pngBuf), degraded: false };
  } catch (err: any) {
    // warn, not debug: this is a silent quality downgrade, not routine noise. It produced a
    // re-analysis that came back visibly worse than the original triage of the very same bytes,
    // and the only trace of it in an 11 MB debug log was a single DEBUG line.
    logger.warn('PDF_PARSER', `PaddleOCR unavailable, falling back to Tesseract — OCR quality for this page will be lower: ${err.message}`);
    const worker = await getSharedTesseractWorker();
    const res = await worker.recognize(pngBuf);
    return { text: res?.data?.text || '', degraded: true };
  }
}

// Runs PaddleOCR and Tesseract independently (via Promise.allSettled) rather than falling back
// from one to the other — used only by the Vision Lab diagnostic pipeline, which needs both
// engines' raw output to let a developer compare them side by side. Production OCR
// (ocrPdfPagesWithCanvas, extractPDFContent's image branch) doesn't use this: it only needs one
// good result, so it uses the fallback pattern above instead of paying for both engines on
// every real document.
export async function ocrImageBufferBothEngines(pngBuf: Buffer): Promise<{
  paddleOcr: { text: string } | { error: string };
  tesseract: { text: string } | { error: string };
}> {
  const [paddleResult, tesseractResult] = await Promise.allSettled([
    paddleOcrRecognize(pngBuf),
    (async () => {
      const worker = await getSharedTesseractWorker();
      const res = await worker.recognize(pngBuf);
      return res?.data?.text || '';
    })(),
  ]);
  const toOutcome = (result: PromiseSettledResult<string>): { text: string } | { error: string } =>
    result.status === 'fulfilled'
      ? { text: result.value }
      : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
  return {
    paddleOcr: toOutcome(paddleResult),
    tesseract: toOutcome(tesseractResult),
  };
}

// Fallback 2: High-fidelity Canvas Page Rendering + OCR (for scanned photos, sliced images, & vector path PDFs)
export async function ocrPdfPagesWithCanvas(buffer: Buffer, maxPages = CONFIG.OCR_MAX_PAGES): Promise<CanvasOcrResult> {
  try {
    const loadingTask = (pdfjsLib as any).getDocument({
      data: new Uint8Array(buffer),
      ignoreErrors: true,
      useSystemFonts: true
    });
    const doc = await loadingTask.promise;
    const ocrTexts: string[] = [];
    // Tracked per PAGE, not per document: the fallback is decided one page at a time, so a
    // two-page scan can genuinely come back half PaddleOCR and half Tesseract — which is exactly
    // what happened to the permis de conduire whose page 2 was byte-identical across two runs
    // while page 1 was not.
    let degraded = false;
    const numPages = Math.min(doc.numPages, maxPages);

    // Never truncate silently. The cap used to be a hardcoded 3 with no log line at all, so a
    // 19-page scanned policy contributed 3 pages to raw_text and nothing anywhere said the other 16
    // had been dropped — the registry, the classifier and the Markdown all just saw a short
    // document. Raise CONFIG.OCR_MAX_PAGES (env OCR_MAX_PAGES) to cover longer scans, at the cost
    // of one OCR round-trip per extra page.
    if (doc.numPages > numPages) {
      logger.warn(
        'PDF_PARSER',
        `Canvas OCR truncated: rendering only ${numPages} of ${doc.numPages} pages — ` +
        `text from pages ${numPages + 1}-${doc.numPages} will be MISSING from raw_text and markdown. ` +
        `Raise OCR_MAX_PAGES to capture them.`,
        { totalPages: doc.numPages, ocrPages: numPages, skippedPages: doc.numPages - numPages }
      );
    }

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      try {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: CONFIG.OCR_RENDER_SCALE });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');
        await page.render({ canvasContext: context, viewport }).promise;
        const pngBuf = canvas.toBuffer('image/png');

        const pageOcr = await ocrPageBuffer(pngBuf);
        if (pageOcr.degraded) degraded = true;
        if (pageOcr.text && pageOcr.text.trim().length > 10) {
          ocrTexts.push(pageOcr.text.trim());
        }
      } catch (pageErr: any) {
        logger.debug('PDF_PARSER', `Canvas OCR failed on page ${pageNum}: ${pageErr.message}`);
      }
    }

    return { text: ocrTexts.join('\n\n'), degraded };
  } catch (err: any) {
    logger.warn('PDF_PARSER', `Full-page canvas OCR failed: ${err.message}`);
    return { text: '', degraded: false };
  }
}

// Text-only adapter, for callers that have no use for the engine provenance.
export const ocrPdfImages = async (buffer: Buffer, maxPages = CONFIG.OCR_MAX_PAGES): Promise<string> =>
  (await ocrPdfPagesWithCanvas(buffer, maxPages)).text;

import zlib from 'zlib';

function extractDocxTextBuffer(buf: Buffer): string {
  const textMatches: string[] = [];
  let offset = 0;
  while (offset < buf.length - 30) {
    if (buf.readUInt32LE(offset) === 0x04034b50) {
      const compression = buf.readUInt16LE(offset + 8);
      const compressedSize = buf.readUInt32LE(offset + 18);
      const fileNameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      const fileName = buf.toString('utf8', offset + 30, offset + 30 + fileNameLen);
      const dataOffset = offset + 30 + fileNameLen + extraLen;

      if (fileName === 'word/document.xml' || fileName.startsWith('word/document')) {
        try {
          let xmlText = '';
          if (compression === 8) {
            const compressedBuf = buf.subarray(dataOffset, dataOffset + compressedSize);
            xmlText = zlib.inflateRawSync(compressedBuf).toString('utf8');
          } else if (compression === 0) {
            xmlText = buf.toString('utf8', dataOffset, dataOffset + compressedSize);
          }
          xmlText = xmlText
            .replace(/<\/w:tc>/gi, ' | ')
            .replace(/<\/w:tr>/gi, ' |\n| ')
            .replace(/<\/w:p>/gi, '\n');
          const matches = xmlText.match(/<w:t[^>]*>([^<]*)<\/w:t>| \| |\n/g);
          if (matches) {
            let lineAcc = '';
            matches.forEach(m => {
              if (m === '\n') {
                if (lineAcc.trim()) textMatches.push(lineAcc.trim());
                lineAcc = '';
              } else if (m === ' | ') {
                lineAcc += ' | ';
              } else {
                const clean = m.replace(/<[^>]+>/g, '').trim();
                if (clean) lineAcc += (lineAcc.endsWith('| ') || !lineAcc ? '' : ' ') + clean;
              }
            });
            if (lineAcc.trim()) textMatches.push(lineAcc.trim());
          }
        } catch {}
      }
      offset += 30 + fileNameLen + extraLen + Math.max(0, compressedSize);
    } else {
      offset++;
    }
  }
  return sanitizeDocumentNoise(textMatches.join('\n'));
}

function extractXlsxTextBuffer(buf: Buffer): string {
  const textMatches: string[] = [];
  let offset = 0;
  while (offset < buf.length - 30) {
    if (buf.readUInt32LE(offset) === 0x04034b50) {
      const compression = buf.readUInt16LE(offset + 8);
      const compressedSize = buf.readUInt32LE(offset + 18);
      const fileNameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      const fileName = buf.toString('utf8', offset + 30, offset + 30 + fileNameLen);
      const dataOffset = offset + 30 + fileNameLen + extraLen;

      if (fileName.includes('sharedStrings.xml') || fileName.includes('worksheets/sheet')) {
        try {
          let xmlText = '';
          if (compression === 8) {
            const compressedBuf = buf.subarray(dataOffset, dataOffset + compressedSize);
            xmlText = zlib.inflateRawSync(compressedBuf).toString('utf8');
          } else if (compression === 0) {
            xmlText = buf.toString('utf8', dataOffset, dataOffset + compressedSize);
          }
          xmlText = xmlText
            .replace(/<\/row>/gi, ' |\n| ')
            .replace(/<\/c>/gi, ' | ');
          const matches = xmlText.match(/<t[^>]*>([^<]*)<\/t>|<v[^>]*>([^<]*)<\/v>| \| |\n/g);
          if (matches) {
            let lineAcc = '';
            matches.forEach(m => {
              if (m === '\n') {
                if (lineAcc.trim()) textMatches.push(lineAcc.trim());
                lineAcc = '';
              } else if (m === ' | ') {
                lineAcc += ' | ';
              } else {
                const clean = m.replace(/<[^>]+>/g, '').trim();
                if (clean) lineAcc += (lineAcc.endsWith('| ') || !lineAcc ? '' : ' ') + clean;
              }
            });
            if (lineAcc.trim()) textMatches.push(lineAcc.trim());
          }
        } catch {}
      }
      offset += 30 + fileNameLen + extraLen + Math.max(0, compressedSize);
    } else {
      offset++;
    }
  }
  return sanitizeDocumentNoise(textMatches.join('\n'));
}

/**
 * In-process document extraction: PDF text layer → pdfjs-dist recovery → full-page Canvas render
 * + OCR (PaddleOCR first, Tesseract availability fallback), plus image OCR and DOCX/XLSX/TXT
 * reading. This is the historical extractPDFContent body, kept exported so the Dockerized
 * extraction service (src/extract-service) and any direct caller can invoke it explicitly.
 *
 * Production callers (triage-scan, relocalize-document, repair-registry) import extractPDFContent
 * — the wrapper below — which delegates here over HTTP when PDF_EXTRACT_SERVICE_URL is set and
 * falls back to this implementation when the service is unreachable.
 */
export async function extractPDFContentLocal(filePath: string): Promise<ExtractedPDF> {
  logger.debug('PDF_PARSER', `Reading file & parsing text content`, { filePath });
  const fileBuffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // Text / Markdown / CSV / Log / JSON
  if (['.txt', '.md', '.csv', '.log', '.json'].includes(ext)) {
    const rawText = fileBuffer.toString('utf-8');
    const cleaned = cleanExtractedText(sanitizeDocumentNoise(rawText), filename);
    return {
      checksum,
      raw_text: cleaned || rawText || filename,
      numpages: 1,
      info: { title: filename }
    };
  }

  // DOCX / XLSX
  if (ext === '.docx') {
    const docxText = extractDocxTextBuffer(fileBuffer);
    const cleaned = cleanExtractedText(docxText, filename);
    return {
      checksum,
      raw_text: cleaned || docxText || `[Document Word: ${filename}]`,
      numpages: 1,
      info: { title: filename }
    };
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const xlsxText = extractXlsxTextBuffer(fileBuffer);
    const cleaned = cleanExtractedText(xlsxText, filename);
    return {
      checksum,
      raw_text: cleaned || xlsxText || `[Tableau Excel: ${filename}]`,
      numpages: 1,
      info: { title: filename }
    };
  }

  // Image files (.png, .jpg, .jpeg, .webp, .bmp, .tiff)
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'].includes(ext)) {
    logger.info('PDF_PARSER', `Running OCR for image file '${filename}'...`);
    let ocrText = '';
    let imageOcrDegraded = false;
    try {
      ocrText = await paddleOcrRecognize(fileBuffer);
    } catch (paddleErr: any) {
      imageOcrDegraded = true;
      logger.warn('PDF_PARSER', `PaddleOCR unavailable for image ${filename}, falling back to Tesseract — OCR quality will be lower: ${paddleErr.message}`);
      try {
        // Keeps the fra+eng+vie language set: the fallback must not be able to read FEWER
        // languages than it did before PaddleOCR was put in front of it.
        const opts = tesseractWorkerOptions();
        const worker = opts
          ? await createWorker('fra+eng+vie', undefined, opts)
          : await createWorker('fra+eng+vie');
        const ret = await worker.recognize(fileBuffer);
        ocrText = ret.data.text || '';
        await worker.terminate();
      } catch (ocrErr: any) {
        logger.warn('PDF_PARSER', `Tesseract OCR failed for image ${filename}: ${ocrErr.message}`);
      }
    }
    const cleaned = cleanExtractedText(ocrText, filename);
    return {
      checksum,
      raw_text: cleaned ? `[OCR Extracted Text]\n\n${cleaned}` : `[Image file: ${filename}]`,
      numpages: 1,
      info: { title: filename },
      ocr_degraded: imageOcrDegraded
    };
  }

  let raw_text = '';
  let numpages = 1;
  let info: any = {};
  // Set only if the OCR tier below actually runs AND has to drop to Tesseract. A PDF whose digital
  // text layer parses cleanly never reaches OCR, so this stays false for the common case.
  let ocrDegraded = false;

  // Step 1: Fast standard pdf-parse
  try {
    const data = await safePdfParse(fileBuffer);
    numpages = data.numpages || 1;
    info = data.info || {};
    const extracted = data.text || '';
    raw_text = cleanExtractedText(extracted, filename);
  } catch (err: any) {
    logger.warn('PDF_PARSER', `pdf-parse failed on ${filename}: ${err.message}`);
  }

  // Corruption guard: pdf-parse can silently return non-empty text from a PDF
  // whose embedded font has no valid ToUnicode CMap — individual characters
  // get substituted, producing garbled-but-nonempty text (e.g. "BANG cAN oor
  // xf roAN" instead of "BẢNG CÂN ĐỐI KẾ TOÁN") that sails straight past the
  // "< 10 clean chars" guard below because it isn't empty or short, it's just
  // wrong. Detect that symptom here and treat it as an ADDITIONAL trigger for
  // the same Step 2 / Step 3 fallback chain used for empty/short text — this
  // is a separate trigger path alongside the existing guard, not a
  // replacement for it. See src/domain/pdf-text.ts for the calibration notes.
  let corruptionSignal: CorruptionSignal | null = null;
  if (raw_text && raw_text.length >= 10) {
    const signal = detectMidWordCapitalizationCorruption(raw_text);
    if (signal.corrupted) {
      corruptionSignal = signal;
      logger.info(
        'PDF_PARSER',
        `Likely font/CMap corruption detected in pdf-parse output for '${filename}' — ` +
        `window ratio ${signal.ratio.toFixed(2)} (${signal.matchCount} mid-word-capitalized tokens), ` +
        `e.g. [${signal.sampleWords.join(', ')}]. Falling through to pdfjs-dist / OCR to try to recover clean text.`,
        { filename }
      );
    }
  }
  const corruptedDigitalText = corruptionSignal ? raw_text : '';

  // Thin-text-layer guard: a scanned PDF frequently carries a token digital text layer — the
  // scanner app's watermark, a page number — which the "< 10 chars" test happily accepts, so OCR
  // never runs and the document's real content never enters the registry at all. An 8-page
  // attestation in the archive extracted as "Scanned with AnyScanner" x8 (198 chars) this way.
  // Treated as an additional trigger for the same Step 2 / Step 3 fallback chain, exactly like the
  // corruption signal above.
  let thinSignal = detectThinTextLayer(raw_text, numpages);
  if (thinSignal.thin) {
    logger.warn(
      'PDF_PARSER',
      `Thin digital text layer for '${filename}' (${thinSignal.reason}): ` +
      `${raw_text.length} chars over ${numpages} page(s) = ${thinSignal.charsPerPage.toFixed(0)}/page, ` +
      `${thinSignal.distinctLines} distinct line(s). Treating as un-extracted and falling through to OCR.`,
      { filename, charsPerPage: Math.round(thinSignal.charsPerPage), distinctLines: thinSignal.distinctLines, numpages, reason: thinSignal.reason }
    );
  }
  // Preserved so a failed OCR attempt can fall back to it rather than losing the watermark text.
  const thinDigitalText = thinSignal.thin ? raw_text : '';

  // Step 2: Robust pdfjs-dist fallback parser for corrupted XRef tables (also
  // triggered when Step 1 produced non-empty but likely-corrupted text).
  if (!raw_text || raw_text.length < 10 || corruptionSignal || thinSignal.thin) {
    const pdfjsText = await parseWithPdfjs(fileBuffer);
    const cleanedPdfjs = cleanExtractedText(pdfjsText, filename);
    // Only apply the extra corruption re-check when we're on the
    // corruption-triggered path — the plain empty/short-text path keeps its
    // original, simpler acceptance criteria (length >= 10).
    const pdfjsStillCorrupted = corruptionSignal ? detectMidWordCapitalizationCorruption(cleanedPdfjs).corrupted : false;
    if (cleanedPdfjs && cleanedPdfjs.length >= 10 && !pdfjsStillCorrupted) {
      logger.info('PDF_PARSER', `Recovered ${cleanedPdfjs.length} chars using pdfjs-dist fallback parser`, { filename });
      raw_text = cleanedPdfjs;
      corruptionSignal = null; // recovered clean text — no longer need to protect the original
      // pdfjs reads the same text layer pdf-parse did, so on a scanned page it usually recovers the
      // same watermark. Re-check rather than assume the recovery resolved anything — otherwise this
      // branch would "recover" 198 chars of watermark and suppress the OCR tier below.
      thinSignal = detectThinTextLayer(raw_text, numpages);
    } else if (corruptionSignal) {
      logger.debug(
        'PDF_PARSER',
        `pdfjs-dist fallback for '${filename}' (corruption-triggered) produced ` +
        `${cleanedPdfjs ? (pdfjsStillCorrupted ? 'still-corrupted' : 'too-short') : 'empty'} text ` +
        `(${cleanedPdfjs.length} chars). Trying OCR next.`,
        { filename }
      );
    }
  }

  // Step 3: High-fidelity Canvas page rendering, then OCR via ocrPageBuffer — PaddleOCR first,
  // Tesseract only as an availability fallback (see ocrPageBuffer). Also runs when the digital
  // text layer parsed but looks corrupted, not only when it is missing.
  if (!raw_text || raw_text.length < 10 || corruptionSignal || thinSignal.thin) {
    logger.info('PDF_PARSER', `No usable digital text layer for '${filename}'. Running full-page Canvas render & OCR (PaddleOCR, Tesseract fallback)...`, { filename });
    const canvasOcr = await ocrPdfPagesWithCanvas(fileBuffer);
    if (canvasOcr.degraded) ocrDegraded = true;
    const cleanedOcr = cleanExtractedText(canvasOcr.text, filename);
    if (cleanedOcr && cleanedOcr.length >= 10) {
      const recoveredFromCorruption = !!corruptionSignal;
      logger.info('PDF_PARSER', `Successfully extracted ${cleanedOcr.length} chars via Canvas OCR`, { filename });
      raw_text = `[OCR Extracted Text]\n\n${cleanedOcr}`;
      corruptionSignal = null;
      if (recoveredFromCorruption) {
        // The corruption guard can misfire (doc id 5009: a clean EDF layer dense with SI units was
        // flagged and OCR'd into "MIe PALMA BRI G TTE"). Never let OCR blindly overwrite the layer
        // it was called in to replace — arbitrate, and keep the layer whenever OCR did not clearly
        // beat it. See chooseBestExtraction in domain/pdf-text.ts for the decision rules.
        const choice = chooseBestExtraction(corruptedDigitalText, cleanedOcr);
        if (choice.source === 'digital') {
          raw_text = choice.text;
          logger.warn(
            'PDF_PARSER',
            `Corruption-triggered OCR did NOT beat the existing digital layer for '${filename}' ` +
            `(${choice.reason}) — keeping the layer's ${raw_text.length} chars instead of the OCR output.`,
            { filename, reason: choice.reason }
          );
        } else {
          logger.info('PDF_PARSER', `Corruption-triggered fallback chain chose OCR text for '${filename}' (${choice.reason}).`, { filename, reason: choice.reason });
        }
      }
    } else if (corruptionSignal) {
      // OCR also failed to produce usable text — keep the original
      // corrupted-but-nonempty digital-layer text rather than discarding real
      // content (do NOT weaken the "< 10 chars → block" guard: this text is
      // non-empty, it just may render poorly downstream).
      raw_text = corruptedDigitalText;
      logger.warn(
        'PDF_PARSER',
        `Corruption-triggered fallback chain did NOT recover clean text for '${filename}' ` +
        `(pdfjs-dist and OCR both failed/too-short). Keeping original corrupted-but-nonempty ` +
        `pdf-parse text (${raw_text.length} chars) — downstream classification/markdown quality ` +
        `may be degraded for this file.`,
        { filename }
      );
      corruptionSignal = null;
    } else if (thinSignal.thin && thinDigitalText) {
      // OCR could not do better than the watermark. Keep the thin text rather than dropping to
      // empty — an empty raw_text would trip the "< 10 chars" block and strand the file in __raws,
      // which is worse than archiving it with a known-poor text layer. The warning above already
      // recorded that this document's content was never really extracted.
      raw_text = thinDigitalText;
      logger.warn(
        'PDF_PARSER',
        `OCR did not improve on the thin text layer for '${filename}'. Keeping the original ` +
        `${raw_text.length}-char layer — this document's real content is NOT in the registry.`,
        { filename, numpages }
      );
    }
  }

  if (raw_text && info && (info.Title || info.Author || info.Subject)) {
    const metaArr = [info.Title, info.Author, info.Subject].filter(b => typeof b === 'string' && b.trim().length > 0);
    if (metaArr.length > 0) {
      const metaHeader = `[Propriétés Document: ${metaArr.join(' | ')}]`;
      if (!raw_text.includes(metaHeader)) {
        raw_text = `${metaHeader}\n\n${raw_text}`;
      }
    }
  }

  logger.info('PDF_PARSER', `Parsed PDF text: ${raw_text.length} chars`, { filename, numpages, checksum: checksum.substring(0, 10) });

  return {
    checksum,
    raw_text,
    numpages,
    info,
    ocr_degraded: ocrDegraded
  };
}

// ---- Remote-extraction routing --------------------------------------------------------------
//
// extractPDFContent() is the seam triage-scan, relocalize-document and repair-registry import, so
// the microservice split lands here and nowhere else:
//
//   - DOCLING_SERVICE_URL set      → PDFs are first offered to the optional Docling structured
//     extractor (layout-aware Markdown, see src/domain/docling-quality.ts for the gate). When
//     Docling answers AND its output passes the gate, its text becomes raw_text and its Markdown
//     rides along as `docling_markdown` (a caller that converts text to Markdown can use it
//     directly instead of re-running the LLM Step C pass). When Docling is unreachable, errors,
//     or its output fails the gate (empty/whole-page-picture/garbage), extraction falls through
//     to the normal chain below — unchanged. DOCLING_SERVICE_REQUIRED=1 turns a Docling
//     failure into a hard error instead of a fallback.
//   - PDF_EXTRACT_SERVICE_URL unset  → in-process extraction (unchanged behavior; desktop .exe and
//     the test suite never notice the split).
//   - PDF_EXTRACT_SERVICE_URL set    → the whole extraction is delegated over HTTP to the
//     Dockerized service. If the service is unreachable or errors, the app falls back to
//     extractPDFContentLocal() with a WARN (throttled to once per 30s — a dead Docker daemon would
//     otherwise spam one identical warning per file) so documents never strand just because Docker
//     is down. PDF_EXTRACT_SERVICE_REQUIRED=1 turns that fallback into a hard error instead.
//
// The HTTP result is the SAME ExtractedPDF contract, produced by the same code on the other side
// of the wire, so checksums, dedupe keys, cleaning and ocr_degraded semantics are identical.
let lastRemoteFallbackWarnAt = 0;
const REMOTE_FALLBACK_WARN_INTERVAL_MS = 30_000;
let lastDoclingFallbackWarnAt = 0;

export function isRemoteExtractionConfigured(): boolean {
  return CONFIG.PDF_EXTRACT_SERVICE_URL.length > 0;
}

const DOCLING_PDF_EXTENSIONS = new Set(['.pdf']);

/**
 * Tries the optional Docling structured extractor for a PDF. Returns an ExtractedPDF when Docling
 * answered and its output passed the quality gate; null when Docling is not configured, the file
 * is not a PDF, the service is unreachable, or the gate rejected the output — the caller then
 * falls back to the normal chain, byte-for-byte as before.
 */
async function tryDoclingExtraction(filePath: string): Promise<ExtractedPDF | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (!isDoclingExtractionConfigured() || !DOCLING_PDF_EXTENSIONS.has(ext)) return null;

  const filename = path.basename(filePath);
  let docling;
  try {
    docling = await extractDoclingContent(filePath);
  } catch (err: any) {
    if (CONFIG.DOCLING_SERVICE_REQUIRED) {
      throw new Error(`Docling service unreachable (DOCLING_SERVICE_REQUIRED=1) for '${filename}': ${err.message}`);
    }
    const now = Date.now();
    if (now - lastDoclingFallbackWarnAt > REMOTE_FALLBACK_WARN_INTERVAL_MS) {
      lastDoclingFallbackWarnAt = now;
      logger.warn(
        'PDF_PARSER',
        `Docling service (${CONFIG.DOCLING_SERVICE_URL}) unreachable — falling back to the normal extraction chain: ${err.message}`,
        { filename }
      );
    }
    return null;
  }

  const report = assessDoclingMarkdown(docling.markdown);
  if (!report.pass) {
    const reasons = report.failures.map(f => f.id).join(', ');
    if (CONFIG.DOCLING_SERVICE_REQUIRED) {
      throw new Error(
        `Docling output rejected by the quality gate (DOCLING_SERVICE_REQUIRED=1) for '${filename}': ${reasons}`
      );
    }
    const now = Date.now();
    if (now - lastDoclingFallbackWarnAt > REMOTE_FALLBACK_WARN_INTERVAL_MS) {
      lastDoclingFallbackWarnAt = now;
      logger.warn(
        'PDF_PARSER',
        `Docling output rejected by the quality gate for '${filename}' (${reasons}) — falling back to the normal extraction chain.`,
        { filename, failures: report.failures.map(f => ({ id: f.id, message: f.message })) }
      );
    }
    return null;
  }

  logger.info('PDF_PARSER', `Docling structured extraction adopted for '${filename}' (${docling.raw_text.length} chars text, ${docling.markdown.length} chars Markdown)`, {
    filename,
    textChars: docling.raw_text.length,
    markdownChars: docling.markdown.length,
    numpages: docling.numpages,
  });
  return {
    // Checksum computed locally, not trusted from the service: it is the dedupe key, and local /
    // remote / docling extraction must all produce the SAME sha256 over the file bytes or the
    // same physical file would be registered as different documents depending on transport.
    checksum: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    raw_text: docling.raw_text,
    numpages: docling.numpages,
    info: docling.info || {},
    ocr_degraded: docling.ocr_degraded,
    docling_markdown: docling.markdown,
  };
}

export async function extractPDFContent(filePath: string): Promise<ExtractedPDF> {
  // Optional Docling layer first (PDFs only). On pass its structured output replaces the normal
  // extraction; on any failure the chain below runs exactly as if Docling were not configured.
  const doclingResult = await tryDoclingExtraction(filePath);
  if (doclingResult) return doclingResult;

  if (!isRemoteExtractionConfigured()) {
    return extractPDFContentLocal(filePath);
  }

  const filename = path.basename(filePath);
  try {
    const remote = await extractPDFContentRemote(filePath);
    logger.info('PDF_PARSER', `Extraction delegated to ${CONFIG.PDF_EXTRACT_SERVICE_URL} (${remote.raw_text.length} chars)`, { filename });
    return remote;
  } catch (err: any) {
    if (CONFIG.PDF_EXTRACT_SERVICE_REQUIRED) {
      throw new Error(`PDF extract service unreachable (PDF_EXTRACT_SERVICE_REQUIRED=1) for '${filename}': ${err.message}`);
    }
    const now = Date.now();
    if (now - lastRemoteFallbackWarnAt > REMOTE_FALLBACK_WARN_INTERVAL_MS) {
      lastRemoteFallbackWarnAt = now;
      logger.warn(
        'PDF_PARSER',
        `PDF extract service (${CONFIG.PDF_EXTRACT_SERVICE_URL}) unreachable — falling back to in-process extraction: ${err.message}`,
        { filename }
      );
    }
    return extractPDFContentLocal(filePath);
  }
}
