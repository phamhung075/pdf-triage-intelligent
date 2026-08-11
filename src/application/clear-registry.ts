import fs from 'fs';
import path from 'path';
import { CONFIG, ensureDirectoriesExist, reloadConfigFromDisk } from '../infrastructure/settings.js';
import { acquireScanLock } from './scan-lock.js';
import { getAllDocuments, getDb } from '../infrastructure/db/database.js';
import { findActualFileOnDisk, moveBackToRaws } from './relocalize-document.js';
import { isPathInsideDir } from '../domain/taxonomy.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';

export async function clearRegistryAndMoveArchiveToRaws(onProgress?: (event: any) => void): Promise<{ countMoved: number }> {
  const release = acquireScanLock();
  try {
  reloadConfigFromDisk();
  ensureDirectoriesExist();

  const existingDocs = await getAllDocuments();
  console.log(`Clearing registry (${existingDocs.length} records) and moving all physical files from __archive to __raws...`);

  onProgress?.({
    type: 'CLEAR_STARTED',
    totalFiles: existingDocs.length,
    message: `Clearing registry records and moving ${existingDocs.length} physical file(s) back to __raws...`
  });

  let countMoved = 0;
  let processedIndex = 0;
  for (const doc of existingDocs) {
    processedIndex++;
    const actualPath = findActualFileOnDisk(doc);
    if (actualPath && fs.existsSync(actualPath) && isPathInsideDir(actualPath, CONFIG.OUTPUT_ROOT_DIR)) {
      try {
        onProgress?.({
          type: 'FILE_PROGRESS',
          filename: doc.original_filename || doc.title,
          scannedCount: processedIndex,
          processedCount: processedIndex,
          totalFiles: existingDocs.length,
          stage: 'CLEARING',
          message: `Moving file ${processedIndex}/${existingDocs.length} back to __raws: ${doc.title}`
        });
        await moveBackToRaws(actualPath);
        countMoved++;
      } catch (err: any) {
        console.warn(`Error moving file ${actualPath} back to __raws:`, err.message);
      }
    }
  }

  const db = await getDb();
  await db.run('DELETE FROM documents');
  try {
    await db.run('DELETE FROM documents_fts');
  } catch (e) {}

  // Any files still left under __archive at this point have no matching DB row
  // (e.g. a repair/insert that never completed). Never delete a PDF — move these
  // orphans back to __raws too, same as tracked files, then remove the now-empty
  // folder skeleton so the next scan reconstructs it cleanly.
  try {
    const moveOrphansAndRemoveEmptyDirs = async (dirPath: string): Promise<void> => {
      if (!fs.existsSync(dirPath)) return;
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        const curPath = path.join(dirPath, file);
        if (fs.lstatSync(curPath).isDirectory()) {
          await moveOrphansAndRemoveEmptyDirs(curPath);
        } else {
          try {
            await moveBackToRaws(curPath);
            countMoved++;
          } catch (err: any) {
            console.warn(`Error moving orphaned file ${curPath} back to __raws:`, err.message);
          }
        }
      }
      if (
        dirPath.toLowerCase() !== path.normalize(CONFIG.OUTPUT_ROOT_DIR).toLowerCase() &&
        fs.existsSync(dirPath) &&
        fs.readdirSync(dirPath).length === 0
      ) {
        fs.rmdirSync(dirPath);
      }
    };
    await moveOrphansAndRemoveEmptyDirs(CONFIG.OUTPUT_ROOT_DIR);
    ensureDirectoriesExist();
  } catch (e) {}

  await syncJSONRegistry();

  console.log(`Clear Registry Completed: Purged DB & moved ${countMoved} physical files from __archive back to __raws.`);
  return { countMoved };
  } finally {
    release();
  }
}
