import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../infrastructure/settings.js';
import { moveDuplicateFileToDuplicatesFolder, cleanEmptyDirectories } from './triage-scan.js';

describe('moveDuplicateFileToDuplicatesFolder', () => {
  const testInputDir = path.join(CONFIG.INPUT_DIR, 'test_tmp_scan');
  const dupDir = path.join(CONFIG.INPUT_DIR, '.duplicates_files');

  beforeEach(() => {
    if (!fs.existsSync(testInputDir)) {
      fs.mkdirSync(testInputDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testInputDir)) {
      fs.rmSync(testInputDir, { recursive: true, force: true });
    }
  });

  it('moves duplicate file into input/.duplicates_files directory', () => {
    const testFile = path.join(testInputDir, 'sample_duplicate.pdf');
    fs.writeFileSync(testFile, 'dummy pdf content');

    const resultPath = moveDuplicateFileToDuplicatesFolder(testFile);

    expect(fs.existsSync(testFile)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(true);
    expect(resultPath).toContain('.duplicates_files');
    expect(path.basename(resultPath)).toBe('sample_duplicate.pdf');

    // Clean up created file in dupDir
    if (fs.existsSync(resultPath)) {
      fs.unlinkSync(resultPath);
    }
  });

  it('handles filename collision by appending _dup counter', () => {
    const testFile = path.join(testInputDir, 'collision.pdf');
    fs.writeFileSync(testFile, 'dummy pdf content');

    const existingInDup = path.join(dupDir, 'collision.pdf');
    fs.writeFileSync(existingInDup, 'already existing duplicate');

    const resultPath = moveDuplicateFileToDuplicatesFolder(testFile);

    expect(fs.existsSync(testFile)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(true);
    expect(path.basename(resultPath)).toBe('collision_dup1.pdf');

    // Clean up
    if (fs.existsSync(existingInDup)) fs.unlinkSync(existingInDup);
    if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
  });
});

describe('cleanEmptyDirectories', () => {
  const baseDir = path.join(CONFIG.INPUT_DIR, 'test_clean_dir');

  beforeEach(() => {
    if (fs.existsSync(baseDir)) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    fs.mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(baseDir)) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('deletes nested empty subdirectories but keeps non-empty subdirectories and .duplicates_files', () => {
    const emptySub1 = path.join(baseDir, 'sub1', 'nested_empty');
    fs.mkdirSync(emptySub1, { recursive: true });

    const nonEmptySub = path.join(baseDir, 'sub2');
    fs.mkdirSync(nonEmptySub, { recursive: true });
    fs.writeFileSync(path.join(nonEmptySub, 'keep.txt'), 'hello');

    const dupSub = path.join(baseDir, '.duplicates_files');
    fs.mkdirSync(dupSub, { recursive: true });

    cleanEmptyDirectories(baseDir, baseDir);

    expect(fs.existsSync(emptySub1)).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'sub1'))).toBe(false);
    expect(fs.existsSync(nonEmptySub)).toBe(true);
    expect(fs.existsSync(dupSub)).toBe(true);
  });
});
