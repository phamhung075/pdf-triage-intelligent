import fs from 'fs';
import path from 'path';
import { CONFIG } from '../infrastructure/settings.js';
import { computeCanonicalPath, isForbiddenSubcategory } from '../domain/taxonomy.js';
import { getPDFsRecursively } from '../infrastructure/pdf-scanner.js';
import { getCategoriesConfig, saveCategoriesConfig } from '../infrastructure/categories-store.js';
import { extractPDFContent } from '../infrastructure/pdf-extractor.js';
import { classifyPDFText } from './classify-document.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
import { getDb, getDocumentByChecksum, getDocumentById, updateDocumentRecord } from '../infrastructure/db/database.js';
import { logger } from '../infrastructure/logger.js';
import { recordManualDecision } from '../infrastructure/manual-decisions-store.js';

// Moves sourcePath to desiredTargetPath without the check-then-act race a plain
// `existsSync` + `renameSync` has: fs.linkSync fails atomically with EEXIST if the
// target already exists (unlike renameSync, which would silently overwrite it on
// Windows), so a genuine collision always gets a fresh unique suffix instead of
// clobbering another file. Falls back to a plain rename across filesystem/volume
// boundaries (EXDEV), where an atomic link isn't possible.
function renameAtomicNoOverwrite(sourcePath: string, desiredTargetPath: string, maxAttempts = 20): string {
  const dir = path.dirname(desiredTargetPath);
  const ext = path.extname(desiredTargetPath);
  const base = path.basename(desiredTargetPath, ext);

  let candidate = desiredTargetPath;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fs.linkSync(sourcePath, candidate);
      fs.unlinkSync(sourcePath);
      return candidate;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        candidate = path.join(dir, `${base}_${Date.now()}_${attempt}${ext}`);
        continue;
      }
      if (err.code === 'EXDEV') {
        fs.renameSync(sourcePath, candidate);
        return candidate;
      }
      throw err;
    }
  }
  throw new Error(`Failed to move '${sourcePath}' to a unique path after ${maxAttempts} attempts`);
}

export function relocalizeFileIfNeeded(
  filePath: string,
  category: string,
  subcategory?: string,
  dateStr?: string,
  title?: string
): { newPath: string; moved: boolean } {
  const originalFilename = path.basename(filePath);
  const targetPath = computeCanonicalPath(filePath, category, CONFIG.OUTPUT_ROOT_DIR, subcategory, dateStr, title);
  const targetFilename = path.basename(targetPath);

  const normTarget = path.normalize(targetPath).toLowerCase();
  const normCurrent = path.normalize(filePath).toLowerCase();

  if (normTarget === normCurrent) {
    return { newPath: filePath, moved: false };
  }

  const isRenamed = originalFilename.toLowerCase() !== targetFilename.toLowerCase();
  const isRelocatedFolder = path.dirname(normCurrent) !== path.dirname(normTarget);

  if (isRenamed && isRelocatedFolder) {
    logger.info('RELOCALIZE', `Decision: Moving folder & renaming file '${originalFilename}' ➔ '${targetFilename}'`, {
      from: filePath,
      to: targetPath,
      category,
      subcategory: subcategory || 'general'
    });
  } else if (isRenamed) {
    logger.info('RELOCALIZE', `Decision: Renaming file '${originalFilename}' ➔ '${targetFilename}'`, {
      from: filePath,
      to: targetPath
    });
  } else if (isRelocatedFolder) {
    logger.info('RELOCALIZE', `Decision: Moving file to folder '__archive/${category}/${subcategory || 'general'}'`, {
      from: filePath,
      to: targetPath
    });
  }

  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const finalTarget = renameAtomicNoOverwrite(filePath, targetPath);

  try {
    const oldDir = path.dirname(filePath);
    if (fs.existsSync(oldDir) && fs.readdirSync(oldDir).length === 0) {
      fs.rmdirSync(oldDir);
      const oldParent = path.dirname(oldDir);
      if (fs.existsSync(oldParent) && fs.readdirSync(oldParent).length === 0) {
        fs.rmdirSync(oldParent);
      }
    }
  } catch (e) {}

  return { newPath: finalTarget, moved: true };
}

export async function moveBackToRaws(filePath: string, checksum?: string): Promise<string> {
  const filename = path.basename(filePath);
  const desiredTargetPath = path.join(CONFIG.INPUT_DIR, filename);

  logger.warn('REPAIR', `Moving file '${filename}' back to __raws`, { targetPath: desiredTargetPath });
  const targetPath = path.normalize(desiredTargetPath).toLowerCase() === path.normalize(filePath).toLowerCase()
    ? filePath
    : renameAtomicNoOverwrite(filePath, desiredTargetPath);

  if (checksum) {
    const existing = await getDocumentByChecksum(checksum);
    if (existing) {
      const db = await getDb();
      await db.run('DELETE FROM documents WHERE id = ?', [existing.id]);
      try {
        await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [existing.id]);
      } catch (e) {}
    }
  }

  try {
    const oldDir = path.dirname(filePath);
    if (fs.existsSync(oldDir) && fs.readdirSync(oldDir).length === 0) {
      fs.rmdirSync(oldDir);
      const oldParent = path.dirname(oldDir);
      if (fs.existsSync(oldParent) && fs.readdirSync(oldParent).length === 0) {
        fs.rmdirSync(oldParent);
      }
    }
  } catch (e) {}

  return targetPath;
}

export function findActualFileOnDisk(doc: { original_filename?: string; original_path?: string; new_path?: string }): string | null {
  if (doc.new_path && fs.existsSync(doc.new_path)) {
    return doc.new_path;
  }
  if (doc.original_path && fs.existsSync(doc.original_path)) {
    return doc.original_path;
  }

  const filename = doc.original_filename || (doc.original_path ? path.basename(doc.original_path) : '');
  if (!filename) return null;

  const rawMatch = path.join(CONFIG.INPUT_DIR, filename);
  if (fs.existsSync(rawMatch)) {
    return rawMatch;
  }

  const allArchived = getPDFsRecursively(CONFIG.OUTPUT_ROOT_DIR);
  const found = allArchived.find(f => path.basename(f).toLowerCase() === filename.toLowerCase());
  return found || null;
}

// Golden Rule #5: the category/subcategory must exist in categories.json BEFORE any
// physical file move — every caller that lets an explicit category/subcategory be set
// (not just the AI classification path) must run this first.
export function ensureCategoryAndSubcategoryExist(category: string, subcategory: string): void {
  const categoriesConfig = getCategoriesConfig();
  let catObj = categoriesConfig.categories.find(c => c.id === category);
  if (!catObj) {
    catObj = {
      id: category,
      name: category.charAt(0).toUpperCase() + category.slice(1),
      description: `Category auto-created for ${category}`,
      aliases: [category],
      subcategories: []
    };
    categoriesConfig.categories.push(catObj);
  }

  if (!catObj.subcategories) catObj.subcategories = [];
  if (!catObj.subcategories.some(s => s.id === subcategory)) {
    catObj.subcategories.push({
      id: subcategory,
      name: subcategory.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      aliases: [subcategory]
    });
  }
  saveCategoriesConfig(categoriesConfig.categories);
}

export async function reclassifyAndRelocalizeDocument(
  id: number,
  explicitCategory?: string,
  explicitSubcategory?: string,
  userFeedbackReason?: string
): Promise<{
  success: boolean;
  staleCleaned?: boolean;
  error?: string;
  message?: string;
  document?: any;
}> {
  const doc = await getDocumentById(id);
  if (!doc) {
    return { success: false, error: 'Document not found' };
  }

  if (explicitSubcategory !== undefined && isForbiddenSubcategory(explicitSubcategory)) {
    return { success: false, error: `'${explicitSubcategory}' is not a valid subcategory (general/other/divers/year strings are not allowed — Golden Rule #4). Please choose a specific entity or document-type name.` };
  }

  const actualPath = findActualFileOnDisk(doc);
  if (!actualPath || !fs.existsSync(actualPath)) {
    logger.info('RELOCALIZE', `Purging stale ghost database record ID ${id} (${doc.title}) - missing on disk`);
    const db = await getDb();
    await db.run('DELETE FROM documents WHERE id = ?', [id]);
    try {
      await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [id]);
    } catch (e) {}
    await syncJSONRegistry();
    return {
      success: false,
      staleCleaned: true,
      error: `Physical file '${doc.original_filename || doc.title}' was missing on disk. Cleaned up stale record.`
    };
  }

  const extracted = await extractPDFContent(actualPath);
  const freshText = extracted.raw_text || '';
  const storedText = doc.raw_text || '';

  // A re-analysis must never make the record WORSE than it already was.
  //
  // The file's bytes are unchanged, so the stored text — produced by a healthy extraction — is
  // strictly the better input whenever the fresh one came out of the Tesseract availability
  // fallback instead of PaddleOCR. The two engines are not comparable on a photographed document:
  // on a photographed ID card PaddleOCR returned the clean numbered form fields where Tesseract
  // returned line noise ('3 > U NI NV me').
  //
  // The old test here was `raw_text.trim().length > 10` — a LIVENESS check, not a quality one. It
  // could not tell the two apart, so 346 chars of OCR noise replaced 433 chars of clean text and
  // the title, date, summary and markdown were all rebuilt from the noise. The document was then
  // physically moved into the wrong year folder, with nothing in the record to say why.
  const freshUsable = freshText.trim().length > 10;
  const rejectDegraded = !!extracted.ocr_degraded && storedText.trim().length > 10;
  if (rejectDegraded) {
    logger.warn(
      'RELOCALIZE',
      `Re-extraction of '${path.basename(actualPath)}' fell back to the degraded OCR engine ` +
      `(${freshText.trim().length} chars) — keeping the ${storedText.trim().length} chars of stored ` +
      `text from the original extraction rather than re-analyzing from worse input.`,
      { documentId: id }
    );
  }
  // Degraded text still beats NO text: the guard prevents a downgrade, it does not make
  // re-analysis impossible for a document that never had usable text to begin with.
  const useFreshText = freshUsable && !rejectDegraded;
  const textToAnalyze = useFreshText ? freshText : storedText;

  let newCategory = doc.category;
  let newSubcategory = doc.subcategory;
  let newTitle = doc.title;
  let newDate = doc.date;
  let newSummary = doc.summary;
  let newMarkdown = doc.markdown_content;

  if (explicitCategory && explicitSubcategory) {
    // User explicitly chose Category & Subcategory from Modal
    newCategory = explicitCategory.toLowerCase().trim();
    newSubcategory = explicitSubcategory.toLowerCase().trim();
  } else {
    // Re-run Qwen 3.5 AI with optional user feedback note
    logger.info('RELOCALIZE', `Re-analyzing document content with AI for ID ${id} (${doc.title})...`, { userFeedbackReason });
    const meta = await classifyPDFText(textToAnalyze, doc.original_filename || path.basename(actualPath), userFeedbackReason);

    newCategory = meta.categorie;
    newSubcategory = meta.subcategorie;
    newTitle = meta.titre || doc.title;
    newDate = meta.date || doc.date;
    newSummary = meta.summary || doc.summary;
    newMarkdown = meta.markdown_content || doc.markdown_content;
  }

  newCategory = (newCategory || '').toLowerCase().trim();
  newSubcategory = (newSubcategory || '').toLowerCase().trim();
  if (newCategory && newSubcategory) {
    ensureCategoryAndSubcategoryExist(newCategory, newSubcategory);
  }

  const { newPath, moved } = relocalizeFileIfNeeded(actualPath, newCategory, newSubcategory, newDate, newTitle);

  await updateDocumentRecord(id, {
    title: newTitle,
    category: newCategory,
    subcategory: newSubcategory,
    date: newDate,
    summary: newSummary,
    markdown_content: newMarkdown,
    new_path: newPath,
    status: 'MOVED',
    // Persist the text the rest of this update was actually derived from. Leaving it behind is
    // what let the record contradict itself — a conclusion rebuilt from new text sitting next to
    // the old evidence, with no way for the user (or the next reader) to see the mismatch.
    ...(useFreshText ? { raw_text: freshText } : {})
  });

  if (doc.category !== newCategory || doc.subcategory !== newSubcategory || userFeedbackReason || explicitCategory) {
    await recordManualDecision({
      document_id: id,
      checksum: doc.checksum,
      original_filename: doc.original_filename || path.basename(actualPath),
      title: newTitle,
      old_category: doc.category,
      old_subcategory: doc.subcategory,
      new_category: newCategory,
      new_subcategory: newSubcategory,
      user_feedback_reason: userFeedbackReason || (explicitCategory ? 'Manual user selection' : 'AI re-analysis'),
      raw_text_snippet: textToAnalyze
    });
  }

  await syncJSONRegistry();
  const updatedDoc = await getDocumentById(id);

  return {
    success: true,
    message: moved
      ? `📍 Re-analyzed & relocated document to: ${newCategory.toUpperCase()} / ${newSubcategory.toUpperCase()}`
      : `📍 Document re-analyzed & confirmed in canonical location: ${newCategory.toUpperCase()} / ${newSubcategory.toUpperCase()}`,
    document: updatedDoc
  };
}

export async function deleteDocumentAndMoveToTrash(id: number): Promise<{ success: boolean; error?: string; message?: string }> {
  const doc = await getDocumentById(id);
  if (!doc) {
    return { success: false, error: 'Document not found' };
  }

  const trashDir = path.join(CONFIG.INPUT_DIR, '.delete_files');
  if (!fs.existsSync(trashDir)) {
    fs.mkdirSync(trashDir, { recursive: true });
  }

  const actualPath = findActualFileOnDisk(doc);
  let trashPath = '';

  if (actualPath && fs.existsSync(actualPath)) {
    const filename = path.basename(actualPath);
    const desiredPath = path.join(trashDir, filename);
    trashPath = renameAtomicNoOverwrite(actualPath, desiredPath);

    try {
      const oldDir = path.dirname(actualPath);
      if (fs.existsSync(oldDir) && fs.readdirSync(oldDir).length === 0) {
        fs.rmdirSync(oldDir);
        const oldParent = path.dirname(oldDir);
        if (fs.existsSync(oldParent) && fs.readdirSync(oldParent).length === 0) {
          fs.rmdirSync(oldParent);
        }
      }
    } catch (e) {}
  }

  const db = await getDb();
  await db.run('DELETE FROM documents WHERE id = ?', [id]);
  try {
    await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [id]);
  } catch (e) {}

  await syncJSONRegistry();

  logger.info('DELETE', `Deleted document ID ${id} (${doc.title}) and moved file to __raws/.delete_files`, { trashPath });

  return {
    success: true,
    message: `🗑️ Document '${doc.title}' un-registered and moved to __raws/.delete_files`
  };
}
