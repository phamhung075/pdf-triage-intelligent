import fs from 'fs';
import path from 'path';
import { CONFIG, ensureDirectoriesExist, reloadConfigFromDisk } from '../infrastructure/settings.js';
import { acquireScanLock } from './scan-lock.js';
import { getPDFsRecursively } from '../infrastructure/pdf-scanner.js';
import { extractPDFContent } from '../infrastructure/pdf-extractor.js';
import { convertImageToPdf, convertImageFolderToPdf, findImageBundleFolders, isImageFile, type ConvertedImageDocument } from './convert-image-document.js';
import {
  getDocumentByChecksum,
  insertDocumentRecord,
  updateDocumentRecord,
  getBlockedFile,
  upsertBlockedFile,
  deleteBlockedFile,
  pruneBlockedFiles
} from '../infrastructure/db/database.js';
import { classifyPDFText } from './classify-document.js';
import { generateEmbedding } from '../infrastructure/ollama-client.js';
import { relocalizeFileIfNeeded } from './relocalize-document.js';
import { isForbiddenSubcategory } from '../domain/taxonomy.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
import { logger } from '../infrastructure/logger.js';

export interface TriageResultItem {
  filename: string;
  docId: number;
  title: string;
  category: string;
  subcategory: string;
  newPath: string;
  status: string;
}

export interface TriageProgressEvent {
  type: 'SCAN_STARTED' | 'FILE_PROGRESS' | 'FILE_COMPLETED' | 'FILE_FAILED' | 'SCAN_COMPLETED';
  totalFiles?: number;
  files?: string[];
  filename?: string;
  stage?: 'EXTRACTING_TEXT' | 'AI_CLASSIFYING' | 'RELOCALIZING' | 'COMPLETED' | 'SKIPPED_DUPLICATE' | 'FAILED';
  message?: string;
  docId?: number;
  title?: string;
  category?: string;
  subcategory?: string;
  newPath?: string;
  scannedCount?: number;
  processedCount?: number;
  skippedCount?: number;
}

/**
 * @param shouldAbort Polled once per file. runTriageScan has no other cancellation point, so
 *   POST /api/triage/unlock ("Stop") previously only cleared the caller's in-memory flag and let
 *   the loop run to completion — the user saw the scan stop while it kept moving and classifying
 *   files underneath them.
 */
export async function runTriageScan(
  onProgress?: (event: TriageProgressEvent) => void,
  shouldAbort?: () => boolean
): Promise<{
  scannedCount: number;
  processedCount: number;
  skippedCount: number;
  items: TriageResultItem[];
}> {
  const release = acquireScanLock();
  try {
  reloadConfigFromDisk();
  ensureDirectoriesExist();

  console.log(`Scanning for PDFs in: ${CONFIG.INPUT_DIR}`);
  console.log(`Output Root Directory: ${CONFIG.OUTPUT_ROOT_DIR}`);

  // Photo bundles first: a folder in __raws holding only photos is ONE multi-page document, not N
  // loose pages. Done BEFORE the file walk so the resulting PDF is picked up by this same scan,
  // and so the individual photos are already out of __raws by the time the walk lists it.
  for (const bundleDir of findImageBundleFolders(CONFIG.INPUT_DIR)) {
    try {
      const bundled = await convertImageFolderToPdf(bundleDir);
      logger.info('TRIAGE', `Bundled folder '${path.basename(bundleDir)}' into a ${bundled.pageCount}-page PDF`, {
        bundleDir,
        pdfPath: bundled.pdfPath,
      });
      // No `stage` — the union is a fixed set the UI switches on, and inventing a value here
      // would fall through every branch of the consumer.
      onProgress?.({
        type: 'FILE_PROGRESS',
        filename: path.basename(bundled.pdfPath),
        message: `Bundled ${bundled.pageCount} photos from '${path.basename(bundleDir)}' into one PDF`,
      });
    } catch (err: any) {
      // Bundling is an enhancement, never a gate — exactly like single-photo conversion. Leave the
      // folder alone and let the walk below triage its photos individually rather than blocking
      // readable documents.
      logger.warn('TRIAGE', `Could not bundle folder '${bundleDir}', its photos will be triaged individually: ${err.message}`);
    }
  }

  const pdfFilePaths = getPDFsRecursively(CONFIG.INPUT_DIR, CONFIG.OUTPUT_ROOT_DIR);
  const filenames = pdfFilePaths.map(p => path.basename(p));
  await pruneBlockedFiles(pdfFilePaths);

  onProgress?.({
    type: 'SCAN_STARTED',
    totalFiles: pdfFilePaths.length,
    files: filenames
  });

  let processedCount = 0;
  let skippedCount = 0;
  let scannedCount = 0;
  const totalFiles = pdfFilePaths.length;
  const items: TriageResultItem[] = [];

  for (const incomingPath of pdfFilePaths) {
    if (shouldAbort?.()) {
      logger.info('TRIAGE', `Scan aborted by user after ${scannedCount} of ${totalFiles} file(s). Remaining files stay in __raws for the next scan.`);
      break;
    }
    scannedCount++;
    // Both are re-pointed at the generated PDF when the incoming file is a photograph, so that
    // everything downstream — blocking, dedup, the DB record, the archive move — operates on the
    // artifact that is actually kept rather than on a source image that no longer exists.
    let originalPath = incomingPath;
    let file = path.basename(originalPath);

    try {
      const docLog = logger.forDocument(file);
      docLog.info('TRIAGE', `Starting triage session for incoming document: ${file}`);
      const fileStat = fs.statSync(originalPath);
      const previouslyBlocked = await getBlockedFile(originalPath);
      if (previouslyBlocked && previouslyBlocked.mtime_ms === fileStat.mtimeMs && previouslyBlocked.size === fileStat.size) {
        // Same file content as last blocked attempt: skip re-extraction/re-classification
        // and re-logging so an unfixable file doesn't spam the log every auto-watcher tick.
        onProgress?.({
          type: 'FILE_FAILED',
          filename: file,
          stage: 'FAILED',
          scannedCount,
          processedCount,
          totalFiles,
          message: previouslyBlocked.message
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      if (previouslyBlocked) {
        // File content changed since it was blocked (e.g. user replaced it) — retry fresh.
        await deleteBlockedFile(originalPath);
      }

      onProgress?.({
        type: 'FILE_PROGRESS',
        filename: file,
        stage: 'EXTRACTING_TEXT',
        scannedCount,
        processedCount,
        totalFiles,
        message: 'Extracting content layer from file...'
      });

      // A photograph is not an archivable document: run the vision pipeline over it, keep the
      // resulting PDF in its place, and reuse the text that pipeline already read. Doing this here
      // rather than inside extractPDFContent keeps extraction free of side effects, and means the
      // fresh PDF is never handed straight back to the OCR path that just produced it.
      let converted: ConvertedImageDocument | null = null;
      if (isImageFile(originalPath)) {
        try {
          converted = await convertImageToPdf(originalPath);
          originalPath = converted.pdfPath;
          file = path.basename(originalPath);
        } catch (convErr: any) {
          // Conversion is an enhancement, not a gate. The photo is untouched on this path, so fall
          // through and triage it exactly as before rather than blocking a readable document.
          docLog.warn('TRIAGE', `Image-to-PDF conversion failed, triaging the photo as-is: ${convErr.message}`, { filename: file });
        }
      }

      const { checksum, raw_text } = converted
        ? { checksum: converted.checksum, raw_text: converted.rawText }
        : await extractPDFContent(originalPath);

      const cleanText = (raw_text || '').trim();
      if (!cleanText || cleanText.length < 10) {
        let movedPath = originalPath;
        try {
          movedPath = moveBlockedFileToBlockedFolder(originalPath);
        } catch {}
        const message = '❌ Blocked: No text extracted from PDF. Moved to __raws/blocked_files.';
        docLog.warn('TRIAGE', `BLOCKED: No text extracted from PDF. Moved to __raws/blocked_files.`, { originalPath: movedPath, filename: file });
        await upsertBlockedFile({
          original_path: movedPath,
          filename: file,
          reason: 'NO_TEXT_EXTRACTED',
          message,
          mtime_ms: fileStat.mtimeMs,
          size: fileStat.size
        });
        onProgress?.({
          type: 'FILE_FAILED',
          filename: file,
          stage: 'FAILED',
          message
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      const existing = await getDocumentByChecksum(checksum);
      if (existing) {
        let movedDupPath = originalPath;
        try {
          movedDupPath = moveDuplicateFileToDuplicatesFolder(originalPath);
          docLog.info('TRIAGE', `Moved duplicate file to __raws/.duplicates_files (Checksum in DB, ID: ${existing.id})`, { filename: file, docId: existing.id });
        } catch (moveErr: any) {
          docLog.warn('TRIAGE', `Skipping duplicate file (Failed to move to .duplicates_files: ${moveErr.message})`, { filename: file });
        }

        skippedCount++;
        items.push({
          filename: file,
          docId: existing.id,
          title: existing.title,
          category: existing.category,
          subcategory: existing.subcategory || 'general',
          newPath: movedDupPath,
          status: 'SKIPPED_DUPLICATE'
        });

        onProgress?.({
          type: 'FILE_COMPLETED',
          filename: file,
          stage: 'SKIPPED_DUPLICATE',
          message: 'Moved duplicate file to __raws/.duplicates_files (Already in database)',
          docId: existing.id,
          title: existing.title,
          category: existing.category,
          subcategory: existing.subcategory || 'general',
          newPath: movedDupPath
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      onProgress?.({
        type: 'FILE_PROGRESS',
        filename: file,
        stage: 'AI_CLASSIFYING',
        message: 'Analyzing text, title, date & subcategory with Qwen 3.5 AI...'
      });

      console.log(`Classifying '${file}'...`);
      const metadata = await classifyPDFText(raw_text, file);

      // Golden Rule #4. Use the canonical predicate, not a hand-rolled three-value test: it is the
      // same one every other write path uses (web-server.ts, relocalize-document.ts, mcp-server.ts,
      // categories-store.ts), and resolveSubcategory deliberately returns sentinels like 'unknown',
      // 'camscanner', a bare year or a file extension *verbatim* so this guard blocks them
      // (classification-resolution.ts). The old inline test caught 3 of the ~20, so the rest were
      // archived into junk taxonomy branches instead of being held in __raws for review.
      const subcat = (metadata.subcategorie || '').toLowerCase().trim();
      if (isForbiddenSubcategory(metadata.subcategorie)) {
        let movedPath = originalPath;
        try {
          movedPath = moveBlockedFileToBlockedFolder(originalPath);
        } catch {}
        const message = `❌ Blocked: Failed to assign specific subcategory to '${file}'. Moved to __raws/.blocked_files.`;
        docLog.warn('TRIAGE', `BLOCKED: No specific subcategory detected (subcat='${subcat}'). Moved to __raws/.blocked_files.`, { originalPath: movedPath, filename: file });
        await upsertBlockedFile({
          original_path: movedPath,
          filename: file,
          reason: 'NO_SUBCATEGORY',
          message,
          mtime_ms: fileStat.mtimeMs,
          size: fileStat.size
        });
        onProgress?.({
          type: 'FILE_FAILED',
          filename: file,
          stage: 'FAILED',
          message
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      const embedding = await generateEmbedding(raw_text);

      let docId: number;
      try {
        docId = await insertDocumentRecord({
          checksum,
          title: metadata.titre,
          registre: metadata.registre,
          date: metadata.date,
          category: metadata.categorie,
          subcategory: metadata.subcategorie || 'general',
          summary: metadata.summary,
          tags: metadata.tags,
          raw_text,
          markdown_content: metadata.markdown_content || '',
          // Step D extracts all of these and DocumentMetadataSchema validates them, but they were
          // never passed here — so insertDocumentRecord wrote its '' default for every one and all
          // ten columns sat empty for the entire corpus while summary/date/tags filled in normally.
          // That is why the UI's Contact Information panel always looked broken.
          total_amount: metadata.total_amount,
          vat_amount: metadata.vat_amount,
          siren: metadata.siren,
          iban: metadata.iban,
          expiry_date: metadata.expiry_date,
          contact_name: metadata.contact_name,
          contact_email: metadata.contact_email,
          contact_phone: metadata.contact_phone,
          contact_address: metadata.contact_address,
          contact_website: metadata.contact_website,
          original_filename: file,
          original_path: originalPath,
          embedding,
          // Present only when this document came from a photograph, so it can be traced back to
          // the image it was made from and re-edited if the automatic crop got it wrong.
          source_image_path: converted?.sourceImagePath || '',
          status: 'PENDING'
        });
      } catch (insertErr: any) {
        // Another checksum-owning row can appear between the pre-check above (line ~146)
        // and this insert — classifyPDFText's Step A/C/D round-trip takes tens of seconds,
        // a wide window for a concurrent scan/repair/manual-edit to insert the same content
        // first. Without this, the file is left in __raws and gets the full (expensive)
        // AI classification re-run every single 10s auto-watcher tick, forever, since it's
        // never blocked or moved — this is what "SQLITE_CONSTRAINT: UNIQUE constraint
        // failed: documents.checksum" repeating for every subsequent file in production logs
        // traced back to.
        if (!/UNIQUE constraint failed.*checksum/i.test(insertErr.message || '')) {
          throw insertErr;
        }

        const existing = await getDocumentByChecksum(checksum);
        let movedDupPath = originalPath;
        try {
          movedDupPath = moveDuplicateFileToDuplicatesFolder(originalPath);
        } catch (moveErr: any) {
          docLog.warn('TRIAGE', `Skipping duplicate file (Failed to move to .duplicates_files: ${moveErr.message})`, { filename: file });
        }

        skippedCount++;
        items.push({
          filename: file,
          docId: existing?.id ?? -1,
          title: existing?.title ?? metadata.titre,
          category: existing?.category ?? metadata.categorie,
          subcategory: existing?.subcategory || 'general',
          newPath: movedDupPath,
          status: 'SKIPPED_DUPLICATE'
        });

        onProgress?.({
          type: 'FILE_COMPLETED',
          filename: file,
          stage: 'SKIPPED_DUPLICATE',
          message: 'Moved duplicate file to __raws/.duplicates_files (Checksum collided with an existing document)',
          docId: existing?.id,
          title: existing?.title,
          category: existing?.category,
          subcategory: existing?.subcategory || 'general',
          newPath: movedDupPath
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      onProgress?.({
        type: 'FILE_PROGRESS',
        filename: file,
        stage: 'RELOCALIZING',
        message: `Moving file to __archive/${metadata.categorie}/${metadata.subcategorie || 'general'}/...`
      });

      const { newPath: finalTargetPath } = relocalizeFileIfNeeded(
        originalPath,
        metadata.categorie,
        metadata.subcategorie,
        metadata.date,
        metadata.titre
      );

      await updateDocumentRecord(docId, {
        new_path: finalTargetPath,
        status: 'MOVED'
      });

      processedCount++;
      items.push({
        filename: file,
        docId,
        title: metadata.titre,
        category: metadata.categorie,
        subcategory: metadata.subcategorie || 'general',
        newPath: finalTargetPath,
        status: 'MOVED'
      });

      onProgress?.({
        type: 'FILE_COMPLETED',
        filename: file,
        stage: 'COMPLETED',
        scannedCount,
        processedCount,
        totalFiles,
        message: 'Successfully triaged & relocated',
        docId,
        title: metadata.titre,
        category: metadata.categorie,
        subcategory: metadata.subcategorie || 'general',
        newPath: finalTargetPath
      });

      logger.info('TRIAGE', `Successfully triaged '${file}' -> ID: ${docId}, Category: ${metadata.categorie}/${metadata.subcategorie}`);
    } catch (err: any) {
      logger.error('TRIAGE', `Error processing file ${file}: ${err.message}`);
      onProgress?.({
        type: 'FILE_FAILED',
        filename: file,
        stage: 'FAILED',
        scannedCount,
        processedCount,
        totalFiles,
        message: err.message
      });
    } finally {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  cleanEmptyDirectories(CONFIG.INPUT_DIR, CONFIG.INPUT_DIR);
  await syncJSONRegistry();

  onProgress?.({
    type: 'SCAN_COMPLETED',
    scannedCount: pdfFilePaths.length,
    processedCount,
    skippedCount
  });

  return {
    scannedCount: pdfFilePaths.length,
    processedCount,
    skippedCount,
    items
  };
  } finally {
    release();
  }
}

export function moveDuplicateFileToDuplicatesFolder(originalPath: string): string {
  const file = path.basename(originalPath);
  const dupDir = path.join(CONFIG.INPUT_DIR, '.duplicates_files');
  if (!fs.existsSync(dupDir)) {
    fs.mkdirSync(dupDir, { recursive: true });
  }

  let targetPath = path.join(dupDir, file);
  if (fs.existsSync(targetPath) && targetPath !== originalPath) {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    let counter = 1;
    while (fs.existsSync(targetPath)) {
      targetPath = path.join(dupDir, `${base}_dup${counter}${ext}`);
      counter++;
    }
  }

  if (originalPath !== targetPath) {
    try {
      fs.renameSync(originalPath, targetPath);
    } catch (err: any) {
      fs.copyFileSync(originalPath, targetPath);
      fs.unlinkSync(originalPath);
    }
  }

  return targetPath;
}

export function cleanEmptyDirectories(dir: string, baseInputDir: string): void {
  if (!fs.existsSync(dir)) return;

  let items: fs.Dirent[] = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const item of items) {
    if (item.isDirectory()) {
      const fullPath = path.join(dir, item.name);
      
      if (path.resolve(fullPath) === path.resolve(baseInputDir) || 
          item.name.startsWith('.') ||
          item.name === 'duplicates_files' || item.name === 'duplicates' ||
          item.name === 'blocked_files' || item.name === 'blocked') {
        continue;
      }

      cleanEmptyDirectories(fullPath, baseInputDir);

      if (fs.existsSync(fullPath)) {
        let remainingItems: string[] = [];
        try {
          remainingItems = fs.readdirSync(fullPath).filter(i => i !== 'Thumbs.db' && i !== '.DS_Store' && i !== 'desktop.ini');
        } catch {
          continue;
        }

        if (remainingItems.length === 0) {
          try {
            fs.rmSync(fullPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
            logger.info('TRIAGE', `Cleaned up empty directory in __raws: ${fullPath}`);
          } catch (err: any) {
            logger.warn('TRIAGE', `Failed to remove empty directory ${fullPath}: ${err.message}`);
          }
        }
      }
    }
  }
}

export function moveBlockedFileToBlockedFolder(originalPath: string): string {
  const file = path.basename(originalPath);
  const blockDir = path.join(CONFIG.INPUT_DIR, '.blocked_files');
  if (!fs.existsSync(blockDir)) {
    fs.mkdirSync(blockDir, { recursive: true });
  }

  let targetPath = path.join(blockDir, file);
  if (fs.existsSync(targetPath) && targetPath !== originalPath) {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    let counter = 1;
    while (fs.existsSync(targetPath)) {
      targetPath = path.join(blockDir, `${base}_blocked${counter}${ext}`);
      counter++;
    }
  }

  if (originalPath !== targetPath) {
    try {
      fs.renameSync(originalPath, targetPath);
    } catch (err: any) {
      fs.copyFileSync(originalPath, targetPath);
      fs.unlinkSync(originalPath);
    }
  }

  return targetPath;
}
