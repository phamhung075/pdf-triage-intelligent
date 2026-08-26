import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, ChildProcess } from 'child_process';

let tempRoot: string;
let tempBaseDir: string;
let inputDir: string;
let outputDir: string;
let dbPath: string;

// Whole-module mock of settings.js: BASE_DIR (scan-lock's .scan.lock location) and
// CONFIG.{INPUT_DIR,OUTPUT_ROOT_DIR,DB_PATH} all get redirected to temp directories so
// this suite never touches the real project's __raws/__archive/pdf_triage.db/.scan.lock.
// See scan-lock.test.ts for why BASE_DIR specifically needs this (it's a hardcoded
// literal in the real settings.ts, not process.env-configurable).
vi.mock('../infrastructure/settings.js', () => ({
  // DATA_DIR falls back to BASE_DIR when PDF_TRIAGE_DATA_DIR is unset, which is what a git
  // checkout does — so the lock files land in the same temp dir the rest of the test uses.
  get DATA_DIR() { return tempBaseDir; },
  get BASE_DIR() { return tempBaseDir; },
  get CONFIG() {
    return {
      INPUT_DIR: inputDir,
      OUTPUT_ROOT_DIR: outputDir,
      DB_PATH: dbPath,
      PERSONAL_NAME_DENYLIST: [] as string[],
    };
  },
  ensureDirectoriesExist: vi.fn(() => {
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
  }),
  reloadConfigFromDisk: vi.fn(),
}));

const { syncJSONRegistryMock } = vi.hoisted(() => ({ syncJSONRegistryMock: vi.fn(async () => {}) }));
vi.mock('../infrastructure/json-registry.js', () => ({ syncJSONRegistry: syncJSONRegistryMock }));

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-triage-clearreg-'));
  tempBaseDir = path.join(tempRoot, 'base');
  inputDir = path.join(tempRoot, '__raws');
  outputDir = path.join(tempRoot, '__archive');
  dbPath = path.join(tempRoot, 'pdf_triage.db');
  fs.mkdirSync(tempBaseDir, { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  syncJSONRegistryMock.mockClear();
});

afterEach(async () => {
  try {
    const { getDb } = await import('../infrastructure/db/database.js');
    const db = await getDb();
    await db.close();
  } catch {
    // ignore — some tests may not have opened a connection
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function fresh() {
  vi.resetModules();
  const database = await import('../infrastructure/db/database.js');
  const clearRegistry = await import('./clear-registry.js');
  return { database, clearRegistry };
}

function sampleDoc(overrides: Record<string, any> = {}) {
  return {
    checksum: 'chk-' + Math.random().toString(36).slice(2),
    title: 'Facture SFR',
    registre: '',
    date: '2026-01-15',
    category: 'invoices',
    subcategory: 'sfr',
    summary: '',
    tags: [],
    raw_text: 'contenu',
    original_filename: 'facture.pdf',
    original_path: 'C:/never/used.pdf',
    status: 'MOVED',
    ...overrides,
  };
}

describe('clearRegistryAndMoveArchiveToRaws', () => {
  it('moves each tracked document\'s archived file back to __raws, purges SQLite, and syncs the registry', async () => {
    const { database, clearRegistry } = await fresh();

    const archivedFile = path.join(outputDir, 'invoices', 'sfr', '2026', 'facture.pdf');
    fs.mkdirSync(path.dirname(archivedFile), { recursive: true });
    fs.writeFileSync(archivedFile, 'dummy pdf bytes');

    const id = await database.insertDocumentRecord(sampleDoc({ new_path: archivedFile }));

    const result = await clearRegistry.clearRegistryAndMoveArchiveToRaws();

    expect(result.countMoved).toBe(1);
    expect(fs.existsSync(archivedFile)).toBe(false);
    expect(fs.existsSync(path.join(inputDir, 'facture.pdf'))).toBe(true);
    expect(await database.getDocumentById(id)).toBeUndefined();
    expect(syncJSONRegistryMock).toHaveBeenCalledTimes(1);
  });

  it('does not move a document\'s file if it lives outside OUTPUT_ROOT_DIR, but still purges its DB row', async () => {
    const { database, clearRegistry } = await fresh();

    const outsideFile = path.join(tempRoot, 'somewhere_else', 'weird.pdf');
    fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
    fs.writeFileSync(outsideFile, 'dummy');

    const id = await database.insertDocumentRecord(sampleDoc({ new_path: outsideFile }));

    const result = await clearRegistry.clearRegistryAndMoveArchiveToRaws();

    expect(result.countMoved).toBe(0);
    expect(fs.existsSync(outsideFile)).toBe(true); // untouched
    expect(await database.getDocumentById(id)).toBeUndefined(); // DB row still purged unconditionally
  });

  it('moves orphaned files under __archive that have no matching DB row, and prunes the empty directory skeleton', async () => {
    const { clearRegistry } = await fresh();

    const orphanFile = path.join(outputDir, 'health', 'doctor_x', '2025', 'orphan.pdf');
    fs.mkdirSync(path.dirname(orphanFile), { recursive: true });
    fs.writeFileSync(orphanFile, 'dummy pdf bytes');

    const result = await clearRegistry.clearRegistryAndMoveArchiveToRaws();

    expect(result.countMoved).toBe(1);
    expect(fs.existsSync(orphanFile)).toBe(false);
    expect(fs.existsSync(path.join(inputDir, 'orphan.pdf'))).toBe(true);
    // The now-empty category/subcategory/year skeleton under __archive should be pruned.
    expect(fs.existsSync(path.join(outputDir, 'health'))).toBe(false);
  });

  it('propagates ScanInProgressError when the cross-process scan lock is held by another running process', async () => {
    // acquireScanLock()'s file lock deliberately treats a lock file written with THIS
    // process's own PID as free (see scan-lock.ts / scan-lock.test.ts) — it only guards
    // against a genuinely separate process, so a real child process is needed here to
    // prove clearRegistryAndMoveArchiveToRaws() actually propagates the lock error
    // instead of swallowing it internally.
    const { clearRegistry } = await fresh();
    const child: ChildProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    try {
      await new Promise<void>((resolve) => {
        if (child.pid) resolve();
        else child.once('spawn', () => resolve());
      });
      fs.writeFileSync(path.join(tempBaseDir, '.scan.lock'), String(child.pid));

      await expect(clearRegistry.clearRegistryAndMoveArchiveToRaws()).rejects.toThrow(/already in progress/i);
    } finally {
      child.kill();
    }
  }, 10_000);
});
