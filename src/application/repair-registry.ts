import fs from 'fs';
import path from 'path';
import { CONFIG, ensureDirectoriesExist, reloadConfigFromDisk } from '../infrastructure/settings.js';
import { acquireScanLock } from './scan-lock.js';
import { getAllDocuments, updateDocumentRecord, getDb, getDocumentByChecksum, insertDocumentRecord } from '../infrastructure/db/database.js';
import { isYearString, findCanonicalCategoryForSubcategory } from '../domain/taxonomy.js';
import { getCategoriesConfig } from '../infrastructure/categories-store.js';
import { getAllFilesRecursively } from '../infrastructure/pdf-scanner.js';
import { extractPDFContent } from '../infrastructure/pdf-extractor.js';
import { moveBackToRaws, findActualFileOnDisk, relocalizeFileIfNeeded } from './relocalize-document.js';
import { ruleBasedClassify, extractRuleBasedContact } from '../domain/classification.js';
import { getEntityDictionary } from '../infrastructure/entity-dictionary-store.js';
import { getPromptPersonalization } from '../infrastructure/prompt-personalization-store.js';
import { classifyPDFText } from './classify-document.js';
import { generateEmbedding } from '../infrastructure/ollama-client.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
import { logger } from '../infrastructure/logger.js';

export async function repairRegistry(onProgress?: (event: any) => void): Promise<{
  scannedCount: number;
  repairedCount: number;
  updatedCount: number;
  relocalizedCount: number;
  movedToRawsCount: number;
}> {
  const release = acquireScanLock();
  try {
  reloadConfigFromDisk();
  ensureDirectoriesExist();

  console.log(`Starting Repair Registry & Relocalization on: ${CONFIG.OUTPUT_ROOT_DIR}`);

  const existingDocs = await getAllDocuments();
  let ghostPurgedCount = 0;
  for (const doc of existingDocs) {
    if (isYearString(doc.subcategory)) {
      await updateDocumentRecord(doc.id, { subcategory: 'general' });
    }
    const actual = findActualFileOnDisk(doc);
    if (!actual || !fs.existsSync(actual)) {
      logger.info('REPAIR', `Purging ghost database record ID ${doc.id} (${doc.title}) - missing on disk`);
      const db = await getDb();
      await db.run('DELETE FROM documents WHERE id = ?', [doc.id]);
      try {
        await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [doc.id]);
      } catch (e) {}
      ghostPurgedCount++;
    }
  }

  const archivedFiles = getAllFilesRecursively(CONFIG.OUTPUT_ROOT_DIR);

  onProgress?.({
    type: 'REPAIR_STARTED',
    totalFiles: archivedFiles.length,
    message: `Starting repair & relocalization of ${archivedFiles.length} archived PDF file(s)...`
  });

  let repairedCount = 0;
  let updatedCount = 0;
  let relocalizedCount = 0;
  let movedToRawsCount = 0;
  let processedIndex = 0;

  for (const filePath of archivedFiles) {
    processedIndex++;
    try {
      if (!fs.existsSync(filePath)) continue;

      const file = path.basename(filePath);
      onProgress?.({
        type: 'FILE_PROGRESS',
        filename: file,
        scannedCount: archivedFiles.length,
        processedCount: processedIndex,
        stage: 'REPAIRING',
        message: `Analyzing & repairing file ${processedIndex}/${archivedFiles.length}: ${file}`
      });
      const { checksum, raw_text } = await extractPDFContent(filePath);

      const isMissingContent = !raw_text || raw_text.trim().length === 0 || raw_text.includes('[No raw text extracted]');

      if (isMissingContent) {
        await moveBackToRaws(filePath, checksum);
        movedToRawsCount++;
        continue;
      }

      const existing = await getDocumentByChecksum(checksum);
      if (existing) {
        const currentText = (existing.raw_text || '').trim();
        if (currentText.length < 15 || currentText.includes('[No raw text extracted]') || (raw_text.length > 20 && currentText !== raw_text)) {
          logger.info('REPAIR', `Updating raw text for doc ID ${existing.id} (${file}): ${raw_text.length} chars`);
          await updateDocumentRecord(existing.id, { raw_text });
          updatedCount++;
        }

        let currentCat = existing.category;
        let currentSub = existing.subcategory;
        const isGeneric = !currentSub || currentSub === 'general' || currentSub === 'other' || currentSub === 'divers' || currentCat === 'personal';

        if (isGeneric) {
          const rb = ruleBasedClassify(raw_text || currentText, file, getEntityDictionary(), CONFIG.PERSONAL_NAME_DENYLIST, getPromptPersonalization());
          if (rb.subcategorie !== 'general' && rb.subcategorie !== 'other' && rb.subcategorie !== 'divers') {
            currentCat = rb.categorie;
            currentSub = rb.subcategorie;
            logger.info('REPAIR', `Re-classified document ID ${existing.id} (${file}): ${existing.category}/${existing.subcategory} -> ${currentCat}/${currentSub}`);
            await updateDocumentRecord(existing.id, {
              category: currentCat,
              subcategory: currentSub
            });
            updatedCount++;
          } else {
            logger.warn('REPAIR', `Document ID ${existing.id} (${file}) has no specific subcategory. Moving back to __raws!`);
            await moveBackToRaws(filePath, checksum);
            movedToRawsCount++;
            continue;
          }
        } else {
          const categoriesConfig = getCategoriesConfig();
          // currentCat is passed so an ambiguous slug (one living under several categories) keeps
          // the placement classification already chose, instead of being relocated by array order.
          const canonicalCat = findCanonicalCategoryForSubcategory(currentSub, categoriesConfig, currentCat);
          if (canonicalCat && canonicalCat !== currentCat) {
            logger.info('REPAIR', `Canonical category changed for doc ID ${existing.id} (${file}) subcategory '${currentSub}': ${currentCat} -> ${canonicalCat}`);
            currentCat = canonicalCat;
            await updateDocumentRecord(existing.id, {
              category: currentCat
            });
            updatedCount++;
          }
        }

        const { newPath, moved } = relocalizeFileIfNeeded(filePath, currentCat, currentSub, existing.date, existing.title);

        if (moved) relocalizedCount++;

        // Backfill missing contact metadata if not present (only authentic extracted contact info)
        if (!existing.contact_name && !existing.contact_email) {
          const ruleContact = extractRuleBasedContact(raw_text || currentText);
          if (ruleContact.contact_name || ruleContact.contact_email || ruleContact.contact_phone) {
            logger.info('REPAIR', `Extracted contact details for doc ID ${existing.id} (${file}): ${ruleContact.contact_name || ruleContact.contact_email}`);
            await updateDocumentRecord(existing.id, {
              contact_name: ruleContact.contact_name,
              contact_email: ruleContact.contact_email,
              contact_phone: ruleContact.contact_phone,
              contact_address: ruleContact.contact_address,
              contact_website: ruleContact.contact_website
            });
          }
        }

        if (existing.new_path !== newPath || existing.status !== 'MOVED') {
          await updateDocumentRecord(existing.id, {
            new_path: newPath,
            status: 'MOVED'
          });
          updatedCount++;
        }
      } else {
        const rel = path.relative(CONFIG.OUTPUT_ROOT_DIR, filePath);
        const parts = rel.split(path.sep);

        const pathCat = parts[0] || 'other';
        const pathSub = parts.length >= 3 ? parts[1] : 'general';

        console.log(`Repairing & analyzing unindexed file '${file}' (Path hint: ${pathCat}/${pathSub})...`);
        const metadata = await classifyPDFText(raw_text, file);
        const embedding = await generateEmbedding(raw_text);
        const ruleContact = extractRuleBasedContact(raw_text);

        const targetCat = metadata.categorie;
        const targetSub = metadata.subcategorie;
        const targetDate = metadata.date || '';

        const isGenericTarget = !targetSub || targetSub === 'general' || targetSub === 'other' || targetSub === 'divers';
        if (isGenericTarget) {
          logger.warn('REPAIR', `Unindexed file '${file}' has no specific subcategory. Moving back to __raws!`);
          await moveBackToRaws(filePath, checksum);
          movedToRawsCount++;
          continue;
        }

        const { newPath, moved } = relocalizeFileIfNeeded(filePath, targetCat, targetSub, targetDate, metadata.titre);
        if (moved) relocalizedCount++;

        try {
          await insertDocumentRecord({
            checksum,
            title: metadata.titre || file.replace(/\.pdf$/i, ''),
            registre: metadata.registre || '',
            date: targetDate,
            category: targetCat,
            subcategory: targetSub,
            summary: metadata.summary || '',
            tags: metadata.tags || [],
            raw_text,
            markdown_content: metadata.markdown_content || '',
            total_amount: metadata.total_amount || '',
            vat_amount: metadata.vat_amount || '',
            siren: metadata.siren || '',
            iban: metadata.iban || '',
            expiry_date: metadata.expiry_date || '',
            contact_name: metadata.contact_name || '',
            contact_email: metadata.contact_email || '',
            contact_phone: metadata.contact_phone || '',
            contact_address: metadata.contact_address || '',
            contact_website: metadata.contact_website || '',
            original_filename: file,
            original_path: filePath,
            new_path: newPath,
            embedding,
            status: 'MOVED'
          });
          repairedCount++;
        } catch (dbErr: any) {
          if (dbErr.message?.includes('UNIQUE constraint failed')) {
            const existingDoc = await getDocumentByChecksum(checksum);
            if (existingDoc) {
              await updateDocumentRecord(existingDoc.id, {
                category: targetCat,
                subcategory: targetSub,
                new_path: newPath,
                status: 'MOVED'
              });
              updatedCount++;
            }
          } else {
            console.warn(`Error inserting record for ${file}:`, dbErr.message);
          }
        }
      }
    } catch (err: any) {
      console.warn(`Error repairing file ${filePath}:`, err.message);
    }
  }

  await syncJSONRegistry();

  return {
    scannedCount: archivedFiles.length,
    repairedCount,
    updatedCount,
    relocalizedCount,
    movedToRawsCount
  };
  } finally {
    release();
  }
}
