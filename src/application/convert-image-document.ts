import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { runOrientStep, runCropStep, runEnhanceStep, runExtractStep } from './image-to-pdf.js';
import { encodeJpeg } from '../infrastructure/image-processor.js';
import { fitImageToA4 } from '../domain/pdf-page-fit.js';
import { logger } from '../infrastructure/logger.js';
import { CONFIG } from '../infrastructure/settings.js';

// Extensions the triage scanner accepts that are photographs rather than documents. Kept in sync
// with the image branch of pdf-extractor.ts, which remains the fallback when conversion fails.
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff']);

// A photograph, not a diagram: JPEG at this quality is visually indistinguishable from the source
// at a fraction of a full-resolution PNG. Note @napi-rs/canvas takes 0-100 here, not 0-1.
const ARCHIVE_JPEG_QUALITY = 85;

// Bound on the _1, _2, … search for a free name, both for the generated PDF beside the source
// (the 'wx' write below) and for the source's resting place in the trash folder. A stem that
// collides 20 times over is a pathological directory, not a case worth silently churning through.
const MAX_PDF_NAME_ATTEMPTS = 20;

// Where a source photograph goes once its PDF is safely on disk. It is kept, not deleted: the
// archived PDF holds an oriented, CROPPED, JPEG-re-encoded rendition, so if the crop detector
// clipped part of the page the original is the only way back — and orientation/OCR failures
// degrade gracefully while a bad crop does not. `.delete_files` is this project's existing trash
// convention (settings.ts creates it) and pdf-scanner.ts skips every dot-directory, so nothing
// parked here is ever re-triaged. It grows without bound; prune it periodically.
const CONVERTED_SOURCE_TRASH = ['.delete_files', 'img_converted'];

export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface ConvertedImageDocument {
  pdfPath: string;
  checksum: string;
  rawText: string;
  /** 1 for a single photo, N for a folder bundled into one multi-page document. */
  pageCount: number;
  /**
   * Where the source photo(s) were parked under .delete_files/img_converted, so the document can
   * be traced back to the image it was made from and re-edited later. Empty when the move failed
   * — the PDF is still valid, there is just nothing to point at.
   */
  sourceImagePath: string;
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
/**
 * Moves a converted source photograph into __raws/.delete_files/img_converted/.
 *
 * Called only after the PDF is on disk, so the document is never at risk. Returns the resting
 * path. Collisions get a _1, _2 … suffix rather than overwriting, the same way
 * moveBlockedFileToBlockedFolder does — two photos named IMG_0001.jpg from different cameras are
 * ordinary, and silently clobbering one would defeat the point of keeping them.
 */
function moveConvertedSourceToTrash(imagePath: string, groupName?: string): string {
  const trashDir = groupName
    ? path.join(CONFIG.INPUT_DIR, ...CONVERTED_SOURCE_TRASH, groupName)
    : path.join(CONFIG.INPUT_DIR, ...CONVERTED_SOURCE_TRASH);
  fs.mkdirSync(trashDir, { recursive: true });

  const file = path.basename(imagePath);
  const ext = path.extname(file);
  const base = path.basename(file, ext);

  let target = path.join(trashDir, file);
  for (let attempt = 1; fs.existsSync(target); attempt++) {
    if (attempt > MAX_PDF_NAME_ATTEMPTS) {
      throw new Error(`Could not find a free name for ${file} in ${trashDir} after ${MAX_PDF_NAME_ATTEMPTS} attempts`);
    }
    target = path.join(trashDir, `${base}_${attempt}${ext}`);
  }

  try {
    fs.renameSync(imagePath, target);
  } catch (err: any) {
    // EXDEV: __raws can sit on a different volume from the temp/source location. Copy-then-unlink
    // is the standard fallback, and the copy is verified by unlink only running on success.
    if (err?.code !== 'EXDEV') throw err;
    fs.copyFileSync(imagePath, target);
    fs.unlinkSync(imagePath);
  }

  return target;
}

/**
 * Runs one photograph through the full vision pipeline and returns the page image plus its text.
 *
 * Every stage degrades gracefully: orientation, crop and enhancement each either improve the
 * buffer or leave it untouched, so there is always something publishable no matter how far the
 * pipeline gets. `pageJpeg` is what gets archived (the CROPPED page, natural tones); the enhanced
 * page only ever feeds OCR and is never archived.
 */
async function renderPageFromImage(
  imagePath: string,
  docLog: ReturnType<typeof logger.forDocument>
): Promise<{ pageJpeg: Buffer; rawText: string }> {
  const filename = path.basename(imagePath);
  const imageBuffer = fs.readFileSync(imagePath);

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
    docLog.warn('IMG2PDF', `OCR failed; the page will be archived without text: ${extracted.error}`, { filename });
  } else {
    // runExtractStep prefers PaddleOCR's text and falls back to Tesseract, then converts to
    // markdown. Prefer the markdown, since that is what the classifier and the registry consume.
    const paddleOrTesseract = extracted.candidates?.find((c) => c.label === 'paddleocr' && c.text)?.text
      ?? extracted.candidates?.find((c) => c.label === 'tesseract' && c.text)?.text
      ?? '';
    rawText = (extracted.markdown || paddleOrTesseract || '').trim();
  }

  return { pageJpeg: await encodeJpeg(pageBuffer, ARCHIVE_JPEG_QUALITY), rawText };
}

/** Assembles rendered pages into one PDF, each fitted to A4. */
async function buildPdfFromPages(pages: Buffer[]): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  for (const jpeg of pages) {
    const embedded = await pdfDoc.embedJpg(jpeg);
    const fit = fitImageToA4(embedded.width, embedded.height);
    const page = pdfDoc.addPage([fit.pageWidth, fit.pageHeight]);
    page.drawImage(embedded, { x: fit.x, y: fit.y, width: fit.drawWidth, height: fit.drawHeight });
  }
  return Buffer.from(await pdfDoc.save());
}

/**
 * Claims a .pdf name with the 'wx' flag (exclusive create), never a plain write.
 *
 * An unrelated PDF can already own the name. Dropping both `contrat.jpg` (a photo of page 2) and
 * `contrat.pdf` (the signed contract) into __raws puts them in the same scan batch, and the image
 * is processed first — a plain writeFileSync would replace the contract's bytes with the photo,
 * with no copy in .duplicates_files, .delete_files or __archive to recover from. 'wx' fails with
 * EEXIST instead and we fall back to a suffixed name, mirroring renameAtomicNoOverwrite() in
 * relocalize-document.ts. The check IS the write, so there is no TOCTOU window.
 */
function writePdfWithoutOverwriting(dir: string, base: string, bytes: Buffer, context: string): string {
  let pdfPath = path.join(dir, `${base}.pdf`);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(pdfPath, bytes, { flag: 'wx' });
      return pdfPath;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      if (attempt >= MAX_PDF_NAME_ATTEMPTS) {
        throw new Error(`Could not find a free .pdf name for ${context} after ${MAX_PDF_NAME_ATTEMPTS} attempts`);
      }
      pdfPath = path.join(dir, `${base}_${attempt + 1}.pdf`);
    }
  }
}

/**
 * Page order for a bundled folder: numeric-aware, so IMG_2 sorts before IMG_10 rather than after.
 * Plain lexicographic ordering silently shuffles the pages of any document with 10+ photos.
 */
export function sortImagePagesNaturally(filenames: string[]): string[] {
  return [...filenames].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/**
 * The images inside a bundle folder, in page order. Non-image files are ignored here; whether the
 * folder qualifies as a bundle at all is decided by findImageBundleFolders().
 */
export function listBundleImages(folderPath: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(folderPath, { withFileTypes: true })
      .filter(e => e.isFile() && isImageFile(e.name))
      .map(e => e.name);
  } catch {
    return [];
  }
  return sortImagePagesNaturally(names).map(name => path.join(folderPath, name));
}

/**
 * Finds folders under __raws whose contents are a single multi-page document.
 *
 * A folder qualifies only when it holds TWO OR MORE images and no other kind of file. Both halves
 * matter:
 *   - One image is not a bundle; it takes the ordinary single-photo path and keeps its own name.
 *   - A folder mixing photos with a PDF (or anything else) is an ordinary folder the user is using
 *     for storage, not a document. Silently fusing its photos into one PDF would be a destructive
 *     guess, so it is left alone and each file is triaged individually as before.
 *
 * Dot-directories are skipped — that is where .blocked_files, .duplicates_files and the converted
 * sources in .delete_files live, and none of them are incoming work.
 */
export function findImageBundleFolders(rootDir: string): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const files = entries.filter(e => e.isFile() && e.name !== 'Thumbs.db' && e.name !== '.DS_Store' && e.name !== 'desktop.ini');
    const images = files.filter(e => isImageFile(e.name));

    if (dir !== rootDir && images.length >= 2 && images.length === files.length) {
      found.push(dir);
      return; // the whole folder is this one document; do not descend into it
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        walk(path.join(dir, entry.name));
      }
    }
  };

  walk(rootDir);
  return found;
}

export async function convertImageToPdf(imagePath: string): Promise<ConvertedImageDocument> {
  const filename = path.basename(imagePath);
  const docLog = logger.forDocument(filename);

  const { pageJpeg, rawText } = await renderPageFromImage(imagePath, docLog);
  const pdfBytes = await buildPdfFromPages([pageJpeg]);

  // The PDF is written BEFORE the source is touched — the reverse order would lose the document
  // if the write failed.
  const pdfPath = writePdfWithoutOverwriting(
    path.dirname(imagePath),
    path.basename(imagePath, path.extname(imagePath)),
    pdfBytes,
    imagePath
  );

  let sourceImagePath = '';
  try {
    sourceImagePath = moveConvertedSourceToTrash(imagePath);
    docLog.info('IMG2PDF', `Source photo kept in ${CONVERTED_SOURCE_TRASH.join('/')}`, { imagePath, trashedPath: sourceImagePath });
  } catch (err) {
    // The PDF exists, so the document is safe and triage can proceed. A source image left in place
    // would otherwise be picked up and converted again on the next scan tick, so this is worth
    // shouting about even though it is not fatal to this document.
    docLog.warn('IMG2PDF', `Converted to PDF but could not move the source image out of __raws: ${errorMessage(err)}`, { imagePath });
  }

  // Checksum the PDF, not the photo: the PDF is the artifact that gets archived and de-duplicated,
  // so a checksum taken from the discarded source would never match a re-scan of the archive.
  const checksum = crypto.createHash('sha256').update(pdfBytes).digest('hex');

  docLog.info('IMG2PDF', `Converted photo to archivable PDF`, {
    filename,
    pdfPath,
    pdfBytes: pdfBytes.length,
    textChars: rawText.length,
  });

  return { pdfPath, checksum, rawText, pageCount: 1, sourceImagePath };
}

/**
 * Bundles a folder of photographs in __raws into ONE multi-page PDF.
 *
 * A folder is how a phone photo batch of a multi-page document actually arrives, so
 * `__raws/contrat-bail/` holding three photos becomes a single three-page document rather than
 * three unrelated one-page ones. Pages follow sortImagePagesNaturally() (numeric-aware), the
 * folder name becomes the PDF name, and each page's OCR text is concatenated so the classifier
 * reads the whole document at once.
 *
 * Ordering matches the single-photo path: the PDF is written first, and only then are the sources
 * moved to .delete_files/img_converted/<folder>/ — keeping the pages grouped there too, so a bad
 * crop on page 2 is recoverable without guessing which loose photo it was.
 */
export async function convertImageFolderToPdf(folderPath: string): Promise<ConvertedImageDocument> {
  const folderName = path.basename(folderPath);
  const docLog = logger.forDocument(folderName);

  const imagePaths = listBundleImages(folderPath);
  if (imagePaths.length === 0) {
    throw new Error(`No convertible images found in ${folderPath}`);
  }

  const pages: Buffer[] = [];
  const pageTexts: string[] = [];
  for (const imagePath of imagePaths) {
    const { pageJpeg, rawText } = await renderPageFromImage(imagePath, docLog);
    pages.push(pageJpeg);
    if (rawText) pageTexts.push(rawText);
  }

  const pdfBytes = await buildPdfFromPages(pages);
  const pdfPath = writePdfWithoutOverwriting(path.dirname(folderPath), folderName, pdfBytes, folderPath);

  // For a bundle the whole folder is the source, so record the directory rather than one page.
  let sourceImagePath = '';
  for (const imagePath of imagePaths) {
    try {
      const moved = moveConvertedSourceToTrash(imagePath, folderName);
      if (!sourceImagePath) sourceImagePath = path.dirname(moved);
    } catch (err) {
      docLog.warn('IMG2PDF', `Bundled to PDF but could not move a source page out of __raws: ${errorMessage(err)}`, { imagePath });
    }
  }

  // Remove the folder only once it is genuinely empty — anything left behind (a stray .txt, a
  // page whose move failed) means the user still has something there, and deleting it would be
  // exactly the data loss the rest of this module exists to prevent.
  try {
    if (fs.readdirSync(folderPath).length === 0) {
      fs.rmdirSync(folderPath);
    } else {
      docLog.warn('IMG2PDF', `Bundled folder still has files left in it; leaving it in place`, { folderPath });
    }
  } catch (err) {
    docLog.warn('IMG2PDF', `Could not remove the bundled folder: ${errorMessage(err)}`, { folderPath });
  }

  const checksum = crypto.createHash('sha256').update(pdfBytes).digest('hex');
  // A horizontal rule between pages: valid Markdown, and it stops the last line of one page from
  // being glued onto the first line of the next when the classifier reads the text.
  const rawText = pageTexts.join('\n\n---\n\n');

  docLog.info('IMG2PDF', `Bundled ${pages.length} photos into one archivable PDF`, {
    folderPath,
    pdfPath,
    pageCount: pages.length,
    pdfBytes: pdfBytes.length,
    textChars: rawText.length,
  });

  return { pdfPath, checksum, rawText, pageCount: pages.length, sourceImagePath };
}

