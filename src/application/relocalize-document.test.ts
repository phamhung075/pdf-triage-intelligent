import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tempRoot: string;
let inputDir: string;
let outputDir: string;
let dbPath: string;

// Same whole-module settings.js mock strategy as scan-lock.test.ts/clear-registry.test.ts:
// INPUT_DIR/OUTPUT_ROOT_DIR/DB_PATH redirected to temp dirs so this suite's real fs/DB
// operations (the actual thing being tested — atomic file moves, directory cleanup) never
// touch the real project's __raws/__archive/pdf_triage.db.
vi.mock('../infrastructure/settings.js', () => ({
  get CONFIG() {
    return {
      INPUT_DIR: inputDir,
      OUTPUT_ROOT_DIR: outputDir,
      DB_PATH: dbPath,
      PERSONAL_NAME_DENYLIST: [] as string[],
    };
  },
}));

const { getCategoriesConfigMock, saveCategoriesConfigMock } = vi.hoisted(() => ({
  getCategoriesConfigMock: vi.fn(),
  saveCategoriesConfigMock: vi.fn(),
}));
vi.mock('../infrastructure/categories-store.js', () => ({
  getCategoriesConfig: getCategoriesConfigMock,
  saveCategoriesConfig: saveCategoriesConfigMock,
}));

const { syncJSONRegistryMock } = vi.hoisted(() => ({ syncJSONRegistryMock: vi.fn(async () => {}) }));
vi.mock('../infrastructure/json-registry.js', () => ({ syncJSONRegistry: syncJSONRegistryMock }));

const { classifyPDFTextMock } = vi.hoisted(() => ({ classifyPDFTextMock: vi.fn() }));
vi.mock('./classify-document.js', () => ({ classifyPDFText: classifyPDFTextMock }));

const { extractPDFContentMock } = vi.hoisted(() => ({ extractPDFContentMock: vi.fn() }));
vi.mock('../infrastructure/pdf-extractor.js', () => ({ extractPDFContent: extractPDFContentMock }));

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-triage-relocalize-'));
  inputDir = path.join(tempRoot, '__raws');
  outputDir = path.join(tempRoot, '__archive');
  dbPath = path.join(tempRoot, 'pdf_triage.db');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  getCategoriesConfigMock.mockReset().mockReturnValue({ categories: [] });
  saveCategoriesConfigMock.mockReset();
  syncJSONRegistryMock.mockReset().mockResolvedValue(undefined);
  classifyPDFTextMock.mockReset();
  extractPDFContentMock.mockReset().mockResolvedValue({ checksum: 'unused', raw_text: '', numpages: 1, info: {} });
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
  const relocalize = await import('./relocalize-document.js');
  return { database, relocalize };
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
    raw_text: 'contenu original',
    original_filename: 'facture.pdf',
    original_path: 'C:/never/used.pdf',
    status: 'MOVED',
    ...overrides,
  };
}

describe('relocalizeFileIfNeeded', () => {
  it('moves a file to its canonical path and reports moved:true', async () => {
    const { relocalize } = await fresh();
    const sourceDir = path.join(inputDir, 'loose');
    fs.mkdirSync(sourceDir, { recursive: true });
    const sourceFile = path.join(sourceDir, 'facture.pdf');
    fs.writeFileSync(sourceFile, 'dummy bytes');

    const result = relocalize.relocalizeFileIfNeeded(sourceFile, 'invoices', 'sfr', '2026-01-15');

    const expectedTarget = path.join(outputDir, 'invoices', 'sfr', '2026', 'facture.pdf');
    expect(result).toEqual({ newPath: expectedTarget, moved: true });
    expect(fs.existsSync(expectedTarget)).toBe(true);
    expect(fs.existsSync(sourceFile)).toBe(false);
  });

  it('reports moved:false and leaves the file in place when it is already at the canonical path', async () => {
    const { relocalize } = await fresh();
    const canonicalDir = path.join(outputDir, 'invoices', 'sfr', '2026');
    fs.mkdirSync(canonicalDir, { recursive: true });
    const file = path.join(canonicalDir, 'facture.pdf');
    fs.writeFileSync(file, 'dummy bytes');

    const result = relocalize.relocalizeFileIfNeeded(file, 'invoices', 'sfr', '2026-01-15');

    expect(result).toEqual({ newPath: file, moved: false });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('cleans up the now-empty source directory (and its empty parent) after moving', async () => {
    const { relocalize } = await fresh();
    const catDir = path.join(outputDir, 'old_cat', 'old_sub');
    fs.mkdirSync(catDir, { recursive: true });
    const file = path.join(catDir, 'doc.pdf');
    fs.writeFileSync(file, 'dummy bytes');

    relocalize.relocalizeFileIfNeeded(file, 'new_cat', 'new_sub', '2026-01-15');

    expect(fs.existsSync(catDir)).toBe(false);
    expect(fs.existsSync(path.join(outputDir, 'old_cat'))).toBe(false);
  });

  it('never overwrites an existing file at the target path — appends a unique suffix instead', async () => {
    const { relocalize } = await fresh();
    const targetDir = path.join(outputDir, 'invoices', 'sfr', '2026');
    fs.mkdirSync(targetDir, { recursive: true });
    const existingTarget = path.join(targetDir, 'facture.pdf');
    fs.writeFileSync(existingTarget, 'PRE-EXISTING CONTENT — must survive');

    const sourceDir = path.join(inputDir, 'loose');
    fs.mkdirSync(sourceDir, { recursive: true });
    const sourceFile = path.join(sourceDir, 'facture.pdf');
    fs.writeFileSync(sourceFile, 'incoming content');

    const result = relocalize.relocalizeFileIfNeeded(sourceFile, 'invoices', 'sfr', '2026-01-15');

    expect(result.moved).toBe(true);
    expect(result.newPath).not.toBe(existingTarget);
    expect(fs.readFileSync(existingTarget, 'utf-8')).toBe('PRE-EXISTING CONTENT — must survive');
    expect(fs.readFileSync(result.newPath, 'utf-8')).toBe('incoming content');
  });
});

describe('moveBackToRaws', () => {
  it('moves the file into INPUT_DIR and returns its new path', async () => {
    const { relocalize } = await fresh();
    const archivedDir = path.join(outputDir, 'invoices', 'sfr', '2026');
    fs.mkdirSync(archivedDir, { recursive: true });
    const file = path.join(archivedDir, 'facture.pdf');
    fs.writeFileSync(file, 'dummy');

    const newPath = await relocalize.moveBackToRaws(file);

    expect(newPath).toBe(path.join(inputDir, 'facture.pdf'));
    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('deletes the matching DB record (and its FTS row) when a checksum is provided', async () => {
    const { database, relocalize } = await fresh();
    const archivedDir = path.join(outputDir, 'invoices', 'sfr', '2026');
    fs.mkdirSync(archivedDir, { recursive: true });
    const file = path.join(archivedDir, 'facture.pdf');
    fs.writeFileSync(file, 'dummy');

    const id = await database.insertDocumentRecord(sampleDoc({ checksum: 'to-delete' }));

    await relocalize.moveBackToRaws(file, 'to-delete');

    expect(await database.getDocumentById(id)).toBeUndefined();
  });

  it('cleans up the now-empty source directory tree', async () => {
    const { relocalize } = await fresh();
    const archivedDir = path.join(outputDir, 'invoices', 'sfr');
    fs.mkdirSync(archivedDir, { recursive: true });
    const file = path.join(archivedDir, 'facture.pdf');
    fs.writeFileSync(file, 'dummy');

    await relocalize.moveBackToRaws(file);

    expect(fs.existsSync(archivedDir)).toBe(false);
    expect(fs.existsSync(path.join(outputDir, 'invoices'))).toBe(false);
  });
});

describe('findActualFileOnDisk', () => {
  it('returns doc.new_path when it exists on disk', async () => {
    const { relocalize } = await fresh();
    const p = path.join(outputDir, 'exists.pdf');
    fs.writeFileSync(p, 'x');
    expect(relocalize.findActualFileOnDisk({ new_path: p })).toBe(p);
  });

  it('falls back to original_path when new_path is missing/nonexistent', async () => {
    const { relocalize } = await fresh();
    const p = path.join(inputDir, 'orig.pdf');
    fs.writeFileSync(p, 'x');
    expect(relocalize.findActualFileOnDisk({ new_path: path.join(outputDir, 'ghost.pdf'), original_path: p })).toBe(p);
  });

  it('falls back to a direct filename match inside INPUT_DIR', async () => {
    const { relocalize } = await fresh();
    const p = path.join(inputDir, 'renamed_folder_lost.pdf');
    fs.writeFileSync(p, 'x');
    expect(relocalize.findActualFileOnDisk({ original_filename: 'renamed_folder_lost.pdf', original_path: 'C:/gone/renamed_folder_lost.pdf' })).toBe(p);
  });

  it('falls back to a recursive case-insensitive basename search under OUTPUT_ROOT_DIR', async () => {
    const { relocalize } = await fresh();
    const nested = path.join(outputDir, 'invoices', 'sfr', '2026');
    fs.mkdirSync(nested, { recursive: true });
    const p = path.join(nested, 'MovedFile.pdf');
    fs.writeFileSync(p, 'x');
    const found = relocalize.findActualFileOnDisk({ original_filename: 'movedfile.PDF', original_path: 'C:/gone/movedfile.PDF' });
    expect(found).toBe(p);
  });

  it('returns null when nothing matches anywhere', async () => {
    const { relocalize } = await fresh();
    expect(relocalize.findActualFileOnDisk({ original_filename: 'does_not_exist.pdf', original_path: 'C:/gone/does_not_exist.pdf' })).toBeNull();
  });
});

describe('ensureCategoryAndSubcategoryExist', () => {
  it('creates a brand-new category and subcategory when neither exists (Golden Rule #5)', async () => {
    const { relocalize } = await fresh();
    getCategoriesConfigMock.mockReturnValue({ categories: [] });

    relocalize.ensureCategoryAndSubcategoryExist('telecom', 'orange');

    expect(saveCategoriesConfigMock).toHaveBeenCalledTimes(1);
    const saved = saveCategoriesConfigMock.mock.calls[0][0];
    const cat = saved.find((c: any) => c.id === 'telecom');
    expect(cat).toBeDefined();
    expect(cat.subcategories.map((s: any) => s.id)).toEqual(['orange']);
  });

  it('appends a new subcategory to an existing category without duplicating the category', async () => {
    const { relocalize } = await fresh();
    getCategoriesConfigMock.mockReturnValue({
      categories: [{ id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [{ id: 'sfr', name: 'SFR', aliases: [] }] }],
    });

    relocalize.ensureCategoryAndSubcategoryExist('invoices', 'edf');

    const saved = saveCategoriesConfigMock.mock.calls[0][0];
    expect(saved.filter((c: any) => c.id === 'invoices')).toHaveLength(1);
    expect(saved[0].subcategories.map((s: any) => s.id)).toEqual(['sfr', 'edf']);
  });

  it('is a no-op on content when the category/subcategory already exist (still saves)', async () => {
    const { relocalize } = await fresh();
    getCategoriesConfigMock.mockReturnValue({
      categories: [{ id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [{ id: 'sfr', name: 'SFR', aliases: [] }] }],
    });

    relocalize.ensureCategoryAndSubcategoryExist('invoices', 'sfr');

    const saved = saveCategoriesConfigMock.mock.calls[0][0];
    expect(saved[0].subcategories).toHaveLength(1);
  });
});

describe('reclassifyAndRelocalizeDocument', () => {
  it('returns an error when the document does not exist', async () => {
    const { relocalize } = await fresh();
    const result = await relocalize.reclassifyAndRelocalizeDocument(9999);
    expect(result).toEqual({ success: false, error: 'Document not found' });
  });

  it('rejects a forbidden explicit subcategory (Golden Rule #4) without touching the DB', async () => {
    const { database, relocalize } = await fresh();
    const id = await database.insertDocumentRecord(sampleDoc());

    const result = await relocalize.reclassifyAndRelocalizeDocument(id, 'invoices', 'general');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Golden Rule #4');
  });

  it('purges a stale ghost record when the physical file is missing on disk', async () => {
    const { database, relocalize } = await fresh();
    const id = await database.insertDocumentRecord(sampleDoc({ new_path: path.join(outputDir, 'gone.pdf'), original_path: 'C:/gone/gone.pdf' }));

    const result = await relocalize.reclassifyAndRelocalizeDocument(id);

    expect(result).toMatchObject({ success: false, staleCleaned: true });
    expect(await database.getDocumentById(id)).toBeUndefined();
    expect(syncJSONRegistryMock).toHaveBeenCalled();
  });

  it('relocalizes to an explicit category/subcategory (skipping AI reclassification) and updates the DB', async () => {
    const { database, relocalize } = await fresh();
    const archivedDir = path.join(outputDir, 'invoices', 'sfr', '2026');
    fs.mkdirSync(archivedDir, { recursive: true });
    const file = path.join(archivedDir, 'facture.pdf');
    fs.writeFileSync(file, 'dummy');
    getCategoriesConfigMock.mockReturnValue({ categories: [] });

    const id = await database.insertDocumentRecord(sampleDoc({ new_path: file, category: 'invoices', subcategory: 'sfr' }));

    const result = await relocalize.reclassifyAndRelocalizeDocument(id, 'telecom', 'orange');

    expect(result.success).toBe(true);
    expect(classifyPDFTextMock).not.toHaveBeenCalled();
    expect(saveCategoriesConfigMock).toHaveBeenCalled(); // ensureCategoryAndSubcategoryExist ran for real

    const doc = await database.getDocumentById(id);
    expect(doc?.category).toBe('telecom');
    expect(doc?.subcategory).toBe('orange');
    expect(fs.existsSync(path.join(outputDir, 'telecom', 'orange', '2026', 'facture.pdf'))).toBe(true);
  });

  it('re-runs AI classification (with the feedback reason) when no explicit category/subcategory is given', async () => {
    const { database, relocalize } = await fresh();
    const archivedDir = path.join(outputDir, 'invoices', 'sfr', '2026');
    fs.mkdirSync(archivedDir, { recursive: true });
    const file = path.join(archivedDir, 'facture.pdf');
    fs.writeFileSync(file, 'dummy');
    extractPDFContentMock.mockResolvedValue({ checksum: 'x', raw_text: 'Some genuinely re-extracted content here', numpages: 1, info: {} });
    classifyPDFTextMock.mockResolvedValue({
      titre: 'Facture Orange Corrigee',
      categorie: 'telecom',
      subcategorie: 'orange',
      date: '2026-02-01',
      summary: 'nouveau resume',
      markdown_content: '# Orange',
    });

    const id = await database.insertDocumentRecord(sampleDoc({ new_path: file, category: 'invoices', subcategory: 'sfr' }));

    const result = await relocalize.reclassifyAndRelocalizeDocument(id, undefined, undefined, 'wrong category, this is actually Orange telecom');

    expect(classifyPDFTextMock).toHaveBeenCalledWith(
      'Some genuinely re-extracted content here',
      'facture.pdf',
      'wrong category, this is actually Orange telecom'
    );
    expect(result.success).toBe(true);
    const doc = await database.getDocumentById(id);
    expect(doc?.category).toBe('telecom');
    expect(doc?.subcategory).toBe('orange');
    expect(doc?.title).toBe('Facture Orange Corrigee');
  });

  it('falls back to the existing raw_text for classification when re-extraction yields too little text', async () => {
    const { database, relocalize } = await fresh();
    const archivedDir = path.join(outputDir, 'invoices', 'sfr', '2026');
    fs.mkdirSync(archivedDir, { recursive: true });
    const file = path.join(archivedDir, 'facture.pdf');
    fs.writeFileSync(file, 'dummy');
    extractPDFContentMock.mockResolvedValue({ checksum: 'x', raw_text: '', numpages: 1, info: {} }); // extraction fails this time
    classifyPDFTextMock.mockResolvedValue({ categorie: 'invoices', subcategorie: 'sfr' });

    const id = await database.insertDocumentRecord(sampleDoc({ new_path: file, raw_text: 'ORIGINAL STORED TEXT FROM FIRST SCAN' }));

    await relocalize.reclassifyAndRelocalizeDocument(id);

    expect(classifyPDFTextMock).toHaveBeenCalledWith('ORIGINAL STORED TEXT FROM FIRST SCAN', 'facture.pdf', undefined);
  });
});
