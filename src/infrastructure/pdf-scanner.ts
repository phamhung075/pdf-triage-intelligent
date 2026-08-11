import fs from 'fs';
import path from 'path';
import { isPathInsideDir } from '../domain/taxonomy.js';

export const SUPPORTED_EXTENSIONS = new Set([
  '.pdf',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff',
  '.txt', '.md', '.csv', '.log', '.json',
  '.docx', '.xlsx', '.xls'
]);

export function isSupportedFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

export function getPDFsRecursively(dir: string, ignoreDir?: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    if (ignoreDir && isPathInsideDir(fullPath, ignoreDir)) {
      continue;
    }

    if (item.isDirectory()) {
      if (item.name.startsWith('.') || item.name === 'duplicates_files' || item.name === 'duplicates' || item.name === 'blocked_files' || item.name === 'blocked') {
        continue;
      }
      results = results.concat(getPDFsRecursively(fullPath, ignoreDir));
    } else if (item.isFile() && isSupportedFile(item.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

export function getAllFilesRecursively(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results = results.concat(getAllFilesRecursively(fullPath));
    } else if (item.isFile() && isSupportedFile(item.name)) {
      results.push(fullPath);
    }
  }
  return results;
}
