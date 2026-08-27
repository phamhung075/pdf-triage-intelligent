import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Regression guard for the WSL path discipline (see src/domain/path-conversion.ts and
// src/infrastructure/os-open.ts): the ONLY file allowed to know about OS-specific launcher
// executables is src/infrastructure/os-open.ts. Any other file spawning explorer.exe / chrome.exe
// / xdg-open directly is exactly how "Open Incoming" ended up passing a POSIX /mnt path to
// explorer.exe, which cannot resolve it and silently fell back to C:\Users\<user>\Documents.
//
// A literal appearing in os-open.ts is fine (it is the owner). Test files are exempt (they must be
// able to assert on the command names). Everything else fails the build.
const OWNER_FILE = path.join('src', 'infrastructure', 'os-open.ts');
const FORBIDDEN_LITERALS = ['explorer.exe', 'chrome.exe', 'xdg-open'];
const TEXT_EXT = /\.ts$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'vendor']);

function collect(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      collect(full, out);
    } else if (TEXT_EXT.test(entry.name)) {
      out.push(full);
    }
  }
}

describe('OS-launcher hygiene (WSL path discipline)', () => {
  const files: string[] = [];
  collect(path.join(process.cwd(), 'src'), files);

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('all OS launcher executables live only in src/infrastructure/os-open.ts', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
      // The owner file and its own tests are allowed to name the executables.
      if (rel === OWNER_FILE || rel.endsWith('.test.ts')) continue;
      const content = fs.readFileSync(file, 'utf-8');
      if (FORBIDDEN_LITERALS.some(lit => content.includes(lit))) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
