import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as pdfPkg from 'pdf-parse';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';
import { logger } from './logger.js';
import { cleanExtractedText } from '../domain/pdf-text.js';
import { paddleOcrRecognize } from './paddleocr-client.js';

export interface ExtractedPDF {
  checksum: string;
  raw_text: string;
  numpages: number;
  info: any;
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

// Fallback 1: Robust text extraction via pdfjs-dist legacy (recovers text from corrupted XRef tables)
export async function parseWithPdfjs(buffer: Buffer): Promise<string> {
  try {
    const loadingTask = (pdfjsLib as any).getDocument({ data: new Uint8Array(buffer), ignoreErrors: true, useSystemFonts: true });
    const doc = await loadingTask.promise;
    let fullText = '';
    const numPages = Math.min(doc.numPages, 10);
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

export async function getSharedTesseractWorker(): Promise<any> {
  if (!sharedTesseractWorkerPromise) {
    sharedTesseractWorkerPromise = (async () => {
      try {
        const worker = await createWorker(['fra', 'eng']);
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
async function ocrPageBuffer(pngBuf: Buffer): Promise<string> {
  try {
    return await paddleOcrRecognize(pngBuf);
  } catch (err: any) {
    logger.debug('PDF_PARSER', `PaddleOCR unavailable, falling back to Tesseract: ${err.message}`);
    const worker = await getSharedTesseractWorker();
    const res = await worker.recognize(pngBuf);
    return res?.data?.text || '';
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
export async function ocrPdfPagesWithCanvas(buffer: Buffer, maxPages = 3): Promise<string> {
  try {
    const loadingTask = (pdfjsLib as any).getDocument({
      data: new Uint8Array(buffer),
      ignoreErrors: true,
      useSystemFonts: true
    });
    const doc = await loadingTask.promise;
    const ocrTexts: string[] = [];
    const numPages = Math.min(doc.numPages, maxPages);

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      try {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');
        await page.render({ canvasContext: context, viewport }).promise;
        const pngBuf = canvas.toBuffer('image/png');

        const text = await ocrPageBuffer(pngBuf);
        if (text && text.trim().length > 10) {
          ocrTexts.push(text.trim());
        }
      } catch (pageErr: any) {
        logger.debug('PDF_PARSER', `Canvas OCR failed on page ${pageNum}: ${pageErr.message}`);
      }
    }

    return ocrTexts.join('\n\n');
  } catch (err: any) {
    logger.warn('PDF_PARSER', `Full-page canvas OCR failed: ${err.message}`);
    return '';
  }
}

export const ocrPdfImages = ocrPdfPagesWithCanvas;

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

export async function extractPDFContent(filePath: string): Promise<ExtractedPDF> {
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
    try {
      ocrText = await paddleOcrRecognize(fileBuffer);
    } catch (paddleErr: any) {
      logger.debug('PDF_PARSER', `PaddleOCR unavailable for image ${filename}, falling back to Tesseract: ${paddleErr.message}`);
      try {
        const worker = await createWorker('fra+eng');
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
      info: { title: filename }
    };
  }

  let raw_text = '';
  let numpages = 1;
  let info: any = {};

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

  // Step 2: Robust pdfjs-dist fallback parser for corrupted XRef tables
  if (!raw_text || raw_text.length < 10) {
    const pdfjsText = await parseWithPdfjs(fileBuffer);
    const cleanedPdfjs = cleanExtractedText(pdfjsText, filename);
    if (cleanedPdfjs && cleanedPdfjs.length >= 10) {
      logger.info('PDF_PARSER', `Recovered ${cleanedPdfjs.length} chars using pdfjs-dist fallback parser`, { filename });
      raw_text = cleanedPdfjs;
    }
  }

  // Step 3: High-fidelity Canvas page rendering, then OCR via ocrPageBuffer — PaddleOCR first,
  // Tesseract only as an availability fallback (see ocrPageBuffer).
  if (!raw_text || raw_text.length < 10) {
    logger.info('PDF_PARSER', `No digital text layer found for '${filename}'. Running full-page Canvas render & OCR (PaddleOCR, Tesseract fallback)...`);
    const ocrText = await ocrPdfPagesWithCanvas(fileBuffer);
    const cleanedOcr = cleanExtractedText(ocrText, filename);
    if (cleanedOcr && cleanedOcr.length >= 10) {
      logger.info('PDF_PARSER', `Successfully extracted ${cleanedOcr.length} chars via Canvas OCR`, { filename });
      raw_text = `[OCR Extracted Text]\n\n${cleanedOcr}`;
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
    info
  };
}
