import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getPDFsRecursively, getAllFilesRecursively } from './pdf-scanner.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-scanner-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function touch(relPath: string, content = 'x') {
  const full = path.join(tempDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('getPDFsRecursively', () => {
  it('finds supported document and image files recursively, case-insensitively, ignoring unsupported files', async () => {
    touch('a.pdf');
    touch('sub/b.PDF');
    touch('sub/deeper/c.Pdf');
    touch('notes.txt');
    touch('image.png');
    touch('invoice.docx');
    touch('sheet.xlsx');
    touch('program.exe');

    const found = getPDFsRecursively(tempDir).map(f => path.basename(f)).sort();
    expect(found).toEqual(['a.pdf', 'b.PDF', 'c.Pdf', 'image.png', 'invoice.docx', 'notes.txt', 'sheet.xlsx'].sort());
  });

  it('skips duplicates_files/duplicates/blocked_files/blocked directories entirely', async () => {
    touch('normal.pdf');
    touch('duplicates_files/dup1.pdf');
    touch('duplicates/dup2.pdf');
    touch('blocked_files/blk1.pdf');
    touch('blocked/blk2.pdf');

    const found = getPDFsRecursively(tempDir).map(f => path.basename(f));
    expect(found).toEqual(['normal.pdf']);
  });

  it('excludes files inside ignoreDir when provided', async () => {
    touch('keep/one.pdf');
    touch('skip/two.pdf');

    const found = getPDFsRecursively(tempDir, path.join(tempDir, 'skip')).map(f => path.basename(f));
    expect(found).toEqual(['one.pdf']);
  });

  it('returns an empty array when the directory does not exist', () => {
    expect(getPDFsRecursively(path.join(tempDir, 'nonexistent'))).toEqual([]);
  });
});

describe('getAllFilesRecursively', () => {
  it('finds supported files recursively without skipping duplicates/blocked directories', async () => {
    touch('a.pdf');
    touch('duplicates_files/dup1.pdf');
    touch('blocked_files/blk1.pdf');

    const found = getAllFilesRecursively(tempDir).map(f => path.basename(f)).sort();
    expect(found).toEqual(['a.pdf', 'blk1.pdf', 'dup1.pdf'].sort());
  });

  it('ignores unsupported binary files', async () => {
    touch('doc.pdf');
    touch('readme.md');
    touch('binary.exe');

    const found = getAllFilesRecursively(tempDir).map(f => path.basename(f)).sort();
    expect(found).toEqual(['doc.pdf', 'readme.md'].sort());
  });

  it('returns an empty array when the directory does not exist', () => {
    expect(getAllFilesRecursively(path.join(tempDir, 'nonexistent'))).toEqual([]);
  });
});
