import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tempRoot: string;
let tempBaseDir: string;
let inputDir: string;
let outputDir: string;
let dbPath: string;

// Same whole-module settings.js mock strategy as the other application-layer test
// files — see scan-lock.test.ts for why BASE_DIR specifically needs it.
vi.mock('../infrastructure/settings.js', () => ({
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

const { ruleBasedClassifyMock, extractRuleBasedContactMock } = vi.hoisted(() => ({
  ruleBasedClassifyMock: vi.fn(),
  extractRuleBasedContactMock: vi.fn(() => ({ contact_name: '', contact_email: '', contact_phone: '', contact_address: '', contact_website: '' }))
}));
vi.mock('../domain/classification.js', () => ({
  ruleBasedClassify: ruleBasedClassifyMock,
  extractRuleBasedContact: extractRuleBasedContactMock
}));

const { getEntityDictionaryMock } = vi.hoisted(() => ({ getEntityDictionaryMock: vi.fn(() => ({})) }));
vi.mock('../infrastructure/entity-dictionary-store.js', () => ({ getEntityDictionary: getEntityDictionaryMock }));

const { generateEmbeddingMock } = vi.hoisted(() => ({ generateEmbeddingMock: vi.fn(async () => []) }));
vi.mock('../infrastructure/ollama-client.js', () => ({ generateEmbedding: generateEmbeddingMock }));

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-triage-repair-'));
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
  ruleBasedClassifyMock.mockReset();
  getEntityDictionaryMock.mockReset().mockReturnValue({});
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
  const repairRegistryMod = await import('./repair-registry.js');
  return { database, repairRegistryMod };
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
    raw_text: 'contenu original suffisamment long pour ne pas etre considere vide',
    original_filename: 'facture.pdf',
    original_path: 'C:/never/used.pdf',
    status: 'MOVED',
    ...overrides,
  };
}

function writeArchivedFile(relDir: string, filename: string, content = 'dummy pdf bytes'): string {
  const dir = path.join(outputDir, relDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, content);
  return file;
}

describe('repairRegistry — ghost purge & year-string normalization', () => {
  it('purges a DB record whose physical file is missing everywhere on disk', async () => {
    const { database, repairRegistryMod } = await fresh();
    const id = await database.insertDocumentRecord(sampleDoc({
      new_path: path.join(outputDir, 'invoices', 'sfr', '2026', 'gone.pdf'),
      original_path: 'C:/gone/gone.pdf',
      original_filename: 'gone.pdf',
    }));

    await repairRegistryMod.repairRegistry();

    expect(await database.getDocumentById(id)).toBeUndefined();
  });

  it('normalizes a year-string subcategory to "general", which then routes the doc through rule-based reclassification', async () => {
    const { database, repairRegistryMod } = await fresh();
    const file = writeArchivedFile(path.join('invoices', '2024'), 'facture.pdf');
    const id = await database.insertDocumentRecord(sampleDoc({
      checksum: 'yearstring-doc',
      category: 'invoices',
      subcategory: '2024',
      new_path: file,
    }));

    extractPDFContentMock.mockResolvedValue({ checksum: 'yearstring-doc', raw_text: 'contenu suffisant', numpages: 1, info: {} });
    ruleBasedClassifyMock.mockReturnValue({ categorie: 'telecom', subcategorie: 'orange', titre: 't', registre: '', date: '', summary: '', tags: [], markdown_content: '' });

    const result = await repairRegistryMod.repairRegistry();

    const doc = await database.getDocumentById(id);
    expect(doc?.category).toBe('telecom');
    expect(doc?.subcategory).toBe('orange');
    expect(result.updatedCount).toBeGreaterThanOrEqual(1);
  });
});

describe('repairRegistry — existing indexed documents', () => {
  it('updates stale/missing raw_text for an existing, already-specific document', async () => {
    const { database, repairRegistryMod } = await fresh();
    const file = writeArchivedFile(path.join('invoices', 'sfr', '2026'), 'facture.pdf');
    const id = await database.insertDocumentRecord(sampleDoc({ checksum: 'stale-text', new_path: file, raw_text: '' }));

    extractPDFContentMock.mockResolvedValue({ checksum: 'stale-text', raw_text: 'Freshly re-extracted content, plenty of characters here', numpages: 1, info: {} });

    const result = await repairRegistryMod.repairRegistry();

    const doc = await database.getDocumentById(id);
    expect(doc?.raw_text).toBe('Freshly re-extracted content, plenty of characters here');
    expect(result.updatedCount).toBeGreaterThanOrEqual(1);
    expect(ruleBasedClassifyMock).not.toHaveBeenCalled(); // category/subcategory already specific
  });

  it('reclassifies a generic-subcategory document via ruleBasedClassify when it finds something specific', async () => {
    const { database, repairRegistryMod } = await fresh();
    const file = writeArchivedFile(path.join('personal', 'general', '2026'), 'doc.pdf');
    const id = await database.insertDocumentRecord(sampleDoc({ checksum: 'generic-doc', category: 'personal', subcategory: 'general', new_path: file }));

    extractPDFContentMock.mockResolvedValue({ checksum: 'generic-doc', raw_text: 'contenu suffisant', numpages: 1, info: {} });
    ruleBasedClassifyMock.mockReturnValue({ categorie: 'health', subcategorie: 'doctor_x', titre: 't', registre: '', date: '', summary: '', tags: [], markdown_content: '' });

    const result = await repairRegistryMod.repairRegistry();

    const doc = await database.getDocumentById(id);
    expect(doc?.category).toBe('health');
    expect(doc?.subcategory).toBe('doctor_x');
    expect(result.relocalizedCount).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(outputDir, 'health', 'doctor_x'))).toBe(true);
  });

  it('moves the file back to __raws when rule-based reclassification also can\'t find anything specific', async () => {
    const { database, repairRegistryMod } = await fresh();
    const file = writeArchivedFile(path.join('personal', 'general', '2026'), 'doc.pdf');
    await database.insertDocumentRecord(sampleDoc({ checksum: 'still-generic', category: 'personal', subcategory: 'general', new_path: file }));

    extractPDFContentMock.mockResolvedValue({ checksum: 'still-generic', raw_text: 'contenu suffisant', numpages: 1, info: {} });
    ruleBasedClassifyMock.mockReturnValue({ categorie: 'other', subcategorie: 'general', titre: 't', registre: '', date: '', summary: '', tags: [], markdown_content: '' });

    const result = await repairRegistryMod.repairRegistry();

    expect(result.movedToRawsCount).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(inputDir, 'doc.pdf'))).toBe(true);
  });
});

describe('repairRegistry — unindexed archived files', () => {
  it('classifies and inserts a brand-new record for an archived file with no matching DB row', async () => {
    const { database, repairRegistryMod } = await fresh();
    const file = writeArchivedFile(path.join('some', 'legacy', 'path'), 'unindexed.pdf');

    extractPDFContentMock.mockResolvedValue({ checksum: 'brand-new-checksum', raw_text: 'contenu suffisant pour classification', numpages: 1, info: {} });
    classifyPDFTextMock.mockResolvedValue({
      titre: 'Nouvelle Facture', registre: 'REF-9', categorie: 'utilities', subcategorie: 'edf',
      date: '2026-03-01', summary: 'resume', tags: ['edf'], markdown_content: '# EDF',
    });

    const result = await repairRegistryMod.repairRegistry();

    expect(result.repairedCount).toBe(1);
    const doc = await database.getDocumentByChecksum('brand-new-checksum');
    expect(doc?.category).toBe('utilities');
    expect(doc?.subcategory).toBe('edf');
    expect(doc?.title).toBe('Nouvelle Facture');
    expect(fs.existsSync(path.join(outputDir, 'utilities', 'edf', '2026'))).toBe(true);
  });

  it('moves an unindexed file back to __raws instead of inserting it when classification is generic', async () => {
    const { repairRegistryMod } = await fresh();
    const file = writeArchivedFile(path.join('some', 'legacy', 'path'), 'unindexed.pdf');

    extractPDFContentMock.mockResolvedValue({ checksum: 'generic-new-checksum', raw_text: 'contenu suffisant', numpages: 1, info: {} });
    classifyPDFTextMock.mockResolvedValue({
      titre: 't', registre: '', categorie: 'other', subcategorie: 'general', date: '', summary: '', tags: [], markdown_content: '',
    });

    const result = await repairRegistryMod.repairRegistry();

    expect(result.movedToRawsCount).toBe(1);
    expect(result.repairedCount).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(inputDir, 'unindexed.pdf'))).toBe(true);
  });
});

describe('repairRegistry — missing/empty content guard', () => {
  it('moves a file with no extractable content back to __raws without ever attempting classification', async () => {
    const { repairRegistryMod } = await fresh();
    const file = writeArchivedFile(path.join('invoices', 'sfr', '2026'), 'blank.pdf');

    extractPDFContentMock.mockResolvedValue({ checksum: 'blank-checksum', raw_text: '', numpages: 1, info: {} });

    const result = await repairRegistryMod.repairRegistry();

    expect(result.movedToRawsCount).toBe(1);
    expect(classifyPDFTextMock).not.toHaveBeenCalled();
    expect(ruleBasedClassifyMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(inputDir, 'blank.pdf'))).toBe(true);
  });
});

describe('repairRegistry — summary counts', () => {
  it('reports scannedCount equal to the number of archived files walked', async () => {
    const { repairRegistryMod } = await fresh();
    writeArchivedFile('a', 'one.pdf');
    writeArchivedFile('b', 'two.pdf');
    extractPDFContentMock.mockResolvedValue({ checksum: 'c1', raw_text: '', numpages: 1, info: {} });

    const result = await repairRegistryMod.repairRegistry();
    expect(result.scannedCount).toBe(2);
  });
});
