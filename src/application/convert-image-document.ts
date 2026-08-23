import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { runOrientStep, runCropStep, runEnhanceStep, runExtractStep } from './image-to-pdf.js';
import { encodeJpeg } from '../infrastructure/image-processor.js';
import { fitImageToA4 } from '../domain/pdf-page-fit.js';
import { logger } from '../infrastructure/logger.js';

// Extensions the triage scanner accepts that are photographs rather than documents. Kept in sync
// with the image branch of pdf-extractor.ts, which remains the fallback when conversion fails.
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff']);

// A photograph, not a diagram: JPEG at this quality is visually indistinguishable from the source
// at a fraction of a full-resolution PNG. Note @napi-rs/canvas takes 0-100 here, not 0-1.
const ARCHIVE_JPEG_QUALITY = 85;

export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface ConvertedImageDocument {
  pdfPath: string;
  checksum: string;
  rawText: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Turns one photographed document into the PDF that gets archived in its place, and returns the OCR
// text alongside it.
//
// WHY THE TEXT COMES BACK FROM HERE. The pipeline already reads the page to produce that text, on
// the enhanced image, which is the best version to read. If this returned only a path, the caller
// would hand the fresh PDF to extractPDFContent, find no text layer in it, render the page back to
// a bitmap and OCR the very same document a second time — 15-30s of duplicated work per file. So
// the text is carried out in memory and the caller skips extraction entirely.
//
// WHICH IMAGE GOES ON THE PAGE. The CROPPED one, not the enhanced one. Enhancement exists to make
// glyphs separable for OCR (it pushes contrast hard and sharpens), and that treatment can crush
// faint stamps and signatures — fine for a machine that is about to throw the pixels away, wrong
// for the copy of a document being kept for years. OCR still reads the enhanced version; only the
// archived page is the natural-toned one.
//
// FAILURE IS NEVER DESTRUCTIVE. Each stage degrades to the best buffer produced so far, so a failed
// crop still yields an upright PDF and a failed orientation still yields the original photo as a
// PDF. If the PDF cannot be written at all this throws and the original file is left exactly where
// it was, for the caller to fall back on. The source image is deleted only after the PDF is
// confirmed on disk.
export async function convertImageToPdf(imagePath: string): Promise<ConvertedImageDocument> {
  const filename = path.basename(imagePath);
  const docLog = logger.forDocument(filename);
  const imageBuffer = fs.readFileSync(imagePath);

  // Best buffer produced so far. Every stage below either improves it or leaves it untouched, so
  // there is always something publishable no matter how far the vision pipeline gets.
  let pageBuffer = imageBuffer;

  const oriented = await runOrientStep(imageBuffer);
  if (oriented.error || !oriented.imageBase64) {
    docLog.warn('IMG2PDF', `Orientation failed, using the photo as-is: ${oriented.error}`, { filename });
  } else {
    pageBuffer = Buffer.from(oriented.imageBase64, 'base64');
  }

  const cropped = await runCropStep(pageBuffer);
  if (cropped.error || !cropped.imageBase64) {
    docLog.warn('IMG2PDF', `Crop failed, keeping the uncropped page: ${cropped.error}`, { filename });
  } else {
    pageBuffer = Buffer.from(cropped.imageBase64, 'base64');
  }

  // From here the two branches diverge: `pageBuffer` is what gets archived, `readBuffer` is what
  // gets read. Enhancement only ever feeds the reader.
  let readBuffer = pageBuffer;
  const enhanced = await runEnhanceStep(pageBuffer);
  if (enhanced.error || !enhanced.imageBase64) {
    docLog.warn('IMG2PDF', `Enhancement failed, running OCR on the unenhanced page: ${enhanced.error}`, { filename });
  } else {
    readBuffer = Buffer.from(enhanced.imageBase64, 'base64');
  }

  let rawText = '';
  const extracted = await runExtractStep(readBuffer);
  if (extracted.error) {
    docLog.warn('IMG2PDF', `OCR failed; the PDF will be archived without text: ${extracted.error}`, { filename });
  } else {
    // runExtractStep prefers PaddleOCR's text and falls back to Tesseract, then converts to
    // markdown. Prefer the markdown, since that is what the classifier and the registry consume.
    const paddleOrTesseract = extracted.candidates?.find((c) => c.label === 'paddleocr' && c.text)?.text
      ?? extracted.candidates?.find((c) => c.label === 'tesseract' && c.text)?.text
      ?? '';
    rawText = (extracted.markdown || paddleOrTesseract || '').trim();
  }

  const jpeg = await encodeJpeg(pageBuffer, ARCHIVE_JPEG_QUALITY);
  const pdfDoc = await PDFDocument.create();
  const embedded = await pdfDoc.embedJpg(jpeg);
  const fit = fitImageToA4(embedded.width, embedded.height);
  const page = pdfDoc.addPage([fit.pageWidth, fit.pageHeight]);
  page.drawImage(embedded, { x: fit.x, y: fit.y, width: fit.drawWidth, height: fit.drawHeight });
  const pdfBytes = Buffer.from(await pdfDoc.save());

  // Write beside the source, taking its name with a .pdf extension. Written first, and only then is
  // the original removed — the reverse order would lose the document if the write failed.
  const pdfPath = path.join(path.dirname(imagePath), `${path.basename(imagePath, path.extname(imagePath))}.pdf`);
  fs.writeFileSync(pdfPath, pdfBytes);
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF was not written to ${pdfPath}`);
  }

  try {
    fs.unlinkSync(imagePath);
  } catch (err) {
    // The PDF exists, so the document is safe and triage can proceed. A leftover source image would
    // otherwise be picked up and converted again on the next scan tick, so this is worth shouting
    // about even though it is not fatal to this document.
    docLog.warn('IMG2PDF', `Converted to PDF but could not remove the source image: ${errorMessage(err)}`, { imagePath });
  }

  // Checksum the PDF, not the photo: the PDF is the artifact that gets archived and de-duplicated,
  // so a checksum taken from the discarded source would never match a re-scan of the archive.
  const checksum = crypto.createHash('sha256').update(pdfBytes).digest('hex');

  docLog.info('IMG2PDF', `Converted photo to archivable PDF`, {
    filename,
    pdfPath,
    pdfBytes: pdfBytes.length,
    textLength: rawText.length,
  });

  return { pdfPath, checksum, rawText };
}
