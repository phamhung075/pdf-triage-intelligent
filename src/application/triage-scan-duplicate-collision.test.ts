import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Same whole-module settings.js mock strategy as repair-registry.test.ts / scan-lock.test.ts.
// Kept in its own file (rather than added to triage-scan.test.ts) because that file relies
// on a top-level static import of triage-scan.js against the REAL settings.js — mixing that
// with a mocked settings.js in the same file hits a temporal-dead-zone ReferenceError, since
// scan-lock.ts reads BASE_DIR at module-top-level before any beforeEach can set it.
let tempRoot: string;
let tempBaseDir: string;
let inputDir: string;
let outputDir: string;
let dbPath: string;

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

const { classifyPDFTextMock } = vi.hoisted(() => ({ classifyPDFTextMock: vi.fn() }));
vi.mock('./classify-document.js', () => ({ classifyPDFText: classifyPDFTextMock }));

const { extractPDFContentMock } = vi.hoisted(() => ({ extractPDFContentMock: vi.fn() }));
vi.mock('../infrastructure/pdf-extractor.js', () => ({ extractPDFContent: extractPDFContentMock }));

const { generateEmbeddingMock } = vi.hoisted(() => ({ generateEmbeddingMock: vi.fn(async () => []) }));
vi.mock('../infrastructure/ollama-client.js', () => ({ generateEmbedding: generateEmbeddingMock }));

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
    raw_text: 'contenu original suffisamment long pour ne pas etre considere vide',
    original_filename: 'facture.pdf',
    original_path: 'C:/never/used.pdf',
    status: 'MOVED',
    ...overrides,
  };
}

describe('runTriageScan — checksum collision at insert time', () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-triage-scan-'));
    tempBaseDir = path.join(tempRoot, 'base');
    inputDir = path.join(tempRoot, '__raws');
    outputDir = path.join(tempRoot, '__archive');
    dbPath = path.join(tempRoot, 'pdf_triage.db');
    fs.mkdirSync(tempBaseDir, { recursive: true });
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    syncJSONRegistryMock.mockReset().mockResolvedValue(undefined);
    classifyPDFTextMock.mockReset();
    extractPDFContentMock.mockReset();
    generateEmbeddingMock.mockReset().mockResolvedValue([]);
  });

  afterEach(async () => {
    try {
      const { getDb } = await import('../infrastructure/db/database.js');
      const db = await getDb();
      await db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function fresh() {
    vi.resetModules();
    const database = await import('../infrastructure/db/database.js');
    const triageScanMod = await import('./triage-scan.js');
    return { database, triageScanMod };
  }

  it('moves the file to .duplicates_files instead of leaving it to retry forever, when its checksum collides at insert time (pre-check passed but a colliding row was written in the meantime)', async () => {
    const { database, triageScanMod } = await fresh();

    const filePath = path.join(inputDir, 'race_duplicate.pdf');
    fs.writeFileSync(filePath, 'dummy pdf bytes');

    const sharedChecksum = 'chk-race-collision';
    extractPDFContentMock.mockResolvedValue({
      checksum: sharedChecksum,
      raw_text: 'Some genuine long enough raw text content here for the test to accept.'
    });

    // Simulates another process/request inserting a document with this exact checksum
    // during the window between this file's pre-check (getDocumentByChecksum, which
    // found nothing) and classifyPDFText resolving — reproducing the observed production
    // failure: STEP A/STEP C logs show classification ran, then insertDocumentRecord
    // throws "UNIQUE constraint failed: documents.checksum".
    classifyPDFTextMock.mockImplementation(async () => {
      await database.insertDocumentRecord(sampleDoc({ checksum: sharedChecksum, original_filename: 'already_archived_elsewhere.pdf' }));
      return {
        titre: 'Race Duplicate Doc', categorie: 'invoices', subcategorie: 'sfr',
        date: '2024-01-01', summary: '', tags: [], markdown_content: ''
      };
    });

    const result = await triageScanMod.runTriageScan();

    expect(result.items[0].status).toBe('SKIPPED_DUPLICATE');
    expect(fs.existsSync(filePath)).toBe(false);

    const allDocs = await database.getAllDocuments();
    expect(allDocs.length).toBe(1);
  });
});
