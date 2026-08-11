import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createZipArchive } from './zip-builder.js';

describe('createZipArchive', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-triage-zip-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('packages a file read from disk by path (existing behavior)', () => {
    const filePath = path.join(tempDir, 'source.pdf');
    fs.writeFileSync(filePath, 'pdf bytes here');

    const zip = createZipArchive([{ name: 'renamed.pdf', path: filePath }]);

    expect(zip.length).toBeGreaterThan(0);
    // End Of Central Directory signature must be present with exactly 1 entry recorded.
    const eocdSignature = zip.readUInt32LE(zip.length - 22);
    expect(eocdSignature).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 22 + 8)).toBe(1); // total entries
  });

  it('packages in-memory content directly, without touching disk', () => {
    const zip = createZipArchive([{ name: 'notes.md', content: Buffer.from('# Hello\n\nWorld', 'utf-8') }]);

    expect(zip.length).toBeGreaterThan(0);
    expect(zip.readUInt16LE(zip.length - 22 + 8)).toBe(1);
    // The local file header's filename field should contain the literal name we gave it.
    expect(zip.subarray(30, 30 + 'notes.md'.length).toString('utf-8')).toBe('notes.md');
  });

  it('sets the UTF-8 filename flag (general purpose bit 11 / 0x0800) so accented entry names are not mojibaked by strict ZIP readers', () => {
    const zip = createZipArchive([{ name: 'Avis de Taxes Foncières.md', content: Buffer.from('x', 'utf-8') }]);

    // Local File Header: signature(4) + version(2) + generalFlag(2) at offset 6.
    const localGeneralFlag = zip.readUInt16LE(6);
    expect(localGeneralFlag & 0x0800).toBe(0x0800);
  });

  it('skips an entry that has neither a valid path nor content, without throwing', () => {
    const zip = createZipArchive([
      { name: 'missing.pdf', path: path.join(tempDir, 'does-not-exist.pdf') },
      { name: 'notes.md', content: Buffer.from('kept', 'utf-8') },
    ]);

    expect(zip.readUInt16LE(zip.length - 22 + 8)).toBe(1); // only the content-based entry survives
  });
});
