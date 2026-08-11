import { IFileSystemGateway } from '../../domain/repositories/IFileSystemGateway.js';
import { relocalizeFileIfNeeded, moveBackToRaws, findActualFileOnDisk } from '../../application/relocalize-document.js';
import { getPDFsRecursively } from '../pdf-scanner.js';
import { cleanEmptyDirectories } from '../../application/triage-scan.js';
import { CONFIG } from '../settings.js';
import fs from 'fs';
import path from 'path';

export class LocalFileSystemAdapter implements IFileSystemGateway {
  public relocalizeFile(filePath: string, category: string, subcategory?: string, dateStr?: string, title?: string) {
    return relocalizeFileIfNeeded(filePath, category, subcategory, dateStr, title);
  }

  public async moveBackToRaws(filePath: string, checksum?: string): Promise<string> {
    return await moveBackToRaws(filePath, checksum);
  }

  public findFileOnDisk(doc: { original_filename?: string; original_path?: string; new_path?: string }): string | null {
    return findActualFileOnDisk(doc);
  }

  public deleteFileToTrash(filePath: string): string {
    const trashDir = path.join(CONFIG.INPUT_DIR, '.delete_files');
    if (!fs.existsSync(trashDir)) {
      fs.mkdirSync(trashDir, { recursive: true });
    }
    const filename = path.basename(filePath);
    const targetPath = path.join(trashDir, filename);
    fs.renameSync(filePath, targetPath);
    return targetPath;
  }

  public getRawPdfFiles(): string[] {
    return getPDFsRecursively(CONFIG.INPUT_DIR);
  }

  public cleanEmptyDirectories(dir: string): void {
    cleanEmptyDirectories(dir, CONFIG.INPUT_DIR);
  }
}
