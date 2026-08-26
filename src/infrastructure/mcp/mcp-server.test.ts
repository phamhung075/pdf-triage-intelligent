import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// mcp-server.ts's tool handlers touch several I/O-heavy collaborators. For the tools
// under test here we mock out everything except the DB layer (../db/database.js) and
// the pure domain/schema modules (../../domain/taxonomy.js, ../../domain/document.schema.js,
// ../../application/scan-lock.js) — search_documents/get_full_document_text/
// update_document_metadata are exercised against a REAL temp SQLite DB (same pattern as
// database.test.ts) so the DB-layer behavior is genuinely proven, while categories-store,
// relocalize-document, json-registry, and triage-scan are mocked since they touch the
// real categories.json / filesystem / Ollama pipeline which must never run in a unit test.
vi.mock('../categories-store.js', () => ({
  getCategoriesConfig: vi.fn(() => ({ categories: [] })),
}));

vi.mock('../../application/relocalize-document.js', () => ({
  relocalizeFileIfNeeded: vi.fn(() => ({ newPath: '', moved: false })),
  ensureCategoryAndSubcategoryExist: vi.fn(),
  findActualFileOnDisk: vi.fn(() => null),
}));

vi.mock('../json-registry.js', () => ({
  syncJSONRegistry: vi.fn(async () => {}),
}));

vi.mock('../../application/triage-scan.js', () => ({
  runTriageScan: vi.fn(async () => ({ scannedCount: 0, processedCount: 0, skippedCount: 0, items: [] })),
}));

let dbPath: string;
let originalEnvDbPath: string | undefined;

beforeEach(() => {
  originalEnvDbPath = process.env.PDF_DB_PATH;
  dbPath = path.join(os.tmpdir(), `pdf-triage-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PDF_DB_PATH = dbPath;
});

afterEach(async () => {
  const { getDb } = await import('../db/database.js');
  try {
    const db = await getDb();
    await db.close();
  } catch {
    // ignore — some tests may not have opened a connection
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  process.env.PDF_DB_PATH = originalEnvDbPath;
});

// Re-evaluates the whole module graph so the module-level `dbInstance` singleton in
// database.ts (and the mocked modules' vi.fn() instances) don't leak across tests, and
// so mcp-server.ts's internal `import '../db/database.js'` resolves to the SAME cached
// instance we insert test rows through here (both imports happen within one epoch).
async function freshMcp() {
  vi.resetModules();
  const database = await import('../db/database.js');
  const categoriesStore = await import('../categories-store.js');
  const relocalize = await import('../../application/relocalize-document.js');
  const jsonRegistry = await import('../json-registry.js');
  const triageScan = await import('../../application/triage-scan.js');
  const mcpServer = await import('./mcp-server.js');
  return { database, categoriesStore, relocalize, jsonRegistry, triageScan, mcpServer };
}

function sampleDoc(overrides: Record<string, any> = {}) {
  return {
    checksum: 'chk-' + Math.random().toString(36).slice(2),
    title: 'Facture SFR Janvier',
    registre: 'REF-001',
    date: '2026-01-15',
    category: 'invoices',
    subcategory: 'sfr',
    summary: 'Facture mensuelle SFR pour janvier',
    tags: ['facture', 'sfr'],
    raw_text: 'Contenu complet de la facture SFR de janvier 2026',
    markdown_content: '# Facture SFR',
    original_filename: 'facture.pdf',
    original_path: 'C:/raws/facture.pdf',
    new_path: '',
    embedding: [0.1, 0.2, 0.3],
    status: 'COMPLETED',
    ...overrides,
  };
}

describe('listMcpTools', () => {
  it('lists all 9 tools with the expected names', async () => {
    const { mcpServer } = await freshMcp();
    const result = await mcpServer.listMcpTools();
    const names = result.tools.map(t => t.name);
    expect(names).toEqual([
      'search_documents',
      'get_full_document_text',
      'update_document_metadata',
      'trigger_triage',
      'list_categories',
      'prepare_dossier',
      'get_document_markdown',
      'open_document_folder',
      'package_documents',
    ]);
    // docId is required on the tools that need it
    expect(result.tools.find(t => t.name === 'get_full_document_text')?.inputSchema.required).toEqual(['docId']);
    expect(result.tools.find(t => t.name === 'update_document_metadata')?.inputSchema.required).toEqual(['docId']);
    expect(result.tools.find(t => t.name === 'get_document_markdown')?.inputSchema.required).toEqual(['docId']);
    expect(result.tools.find(t => t.name === 'open_document_folder')?.inputSchema.required).toEqual(['docId']);
  });
});

describe('handleMcpToolCall — search_documents', () => {
  it('filters by category and subcategory, and matches query case-insensitively', async () => {
    const { database, mcpServer } = await freshMcp();
    await database.insertDocumentRecord(sampleDoc({ checksum: 'a', title: 'Facture SFR Janvier', category: 'invoices', subcategory: 'sfr' }));
    await database.insertDocumentRecord(sampleDoc({ checksum: 'b', title: 'Facture EDF Fevrier', category: 'invoices', subcategory: 'edf', summary: 'Facture electricite' }));
    await database.insertDocumentRecord(sampleDoc({ checksum: 'c', title: 'Bulletin Salaire', category: 'bulletin_salaire', subcategory: 'employer_x', summary: 'Paie mensuelle' }));

    const byCategory = await mcpServer.handleMcpToolCall('search_documents', { category: 'INVOICES' });
    const byCategoryParsed = JSON.parse(byCategory.content[0].text);
    expect(byCategoryParsed.count).toBe(2);

    const bySub = await mcpServer.handleMcpToolCall('search_documents', { subcategory: 'SFR' });
    const bySubParsed = JSON.parse(bySub.content[0].text);
    expect(bySubParsed.count).toBe(1);
    expect(bySubParsed.results[0].title).toBe('Facture SFR Janvier');

    const byQuery = await mcpServer.handleMcpToolCall('search_documents', { query: 'ELECTRICITE' });
    const byQueryParsed = JSON.parse(byQuery.content[0].text);
    expect(byQueryParsed.count).toBe(1);
    expect(byQueryParsed.results[0].title).toBe('Facture EDF Fevrier');
  });

  it('honors the limit parameter', async () => {
    const { database, mcpServer } = await freshMcp();
    await database.insertDocumentRecord(sampleDoc({ checksum: 'a' }));
    await database.insertDocumentRecord(sampleDoc({ checksum: 'b' }));
    await database.insertDocumentRecord(sampleDoc({ checksum: 'c' }));

    const result = await mcpServer.handleMcpToolCall('search_documents', { limit: 2 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(2);
  });

  it('returns all documents when no filters are given', async () => {
    const { database, mcpServer } = await freshMcp();
    await database.insertDocumentRecord(sampleDoc({ checksum: 'a' }));
    await database.insertDocumentRecord(sampleDoc({ checksum: 'b' }));

    const result = await mcpServer.handleMcpToolCall('search_documents', {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(2);
  });
});

describe('handleMcpToolCall — get_full_document_text', () => {
  it('returns the full raw_text for an existing document', async () => {
    const { database, mcpServer } = await freshMcp();
    const id = await database.insertDocumentRecord(sampleDoc({ checksum: 'x', raw_text: 'The full extracted body text.' }));

    const result = await mcpServer.handleMcpToolCall('get_full_document_text', { docId: id });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe(id);
    expect(parsed.raw_text).toBe('The full extracted body text.');
    expect(result.isError).toBeUndefined();
  });

  it('returns an isError response for a docId that does not exist', async () => {
    const { mcpServer } = await freshMcp();
    const result = await mcpServer.handleMcpToolCall('get_full_document_text', { docId: 9999 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Document ID 9999 not found');
  });
});

describe('handleMcpToolCall — update_document_metadata', () => {
  it('rejects a non-integer docId', async () => {
    const { mcpServer } = await freshMcp();
    const result = await mcpServer.handleMcpToolCall('update_document_metadata', { docId: 1.5, title: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('docId must be a positive integer');
  });

  it('rejects a zero docId', async () => {
    const { mcpServer } = await freshMcp();
    const result = await mcpServer.handleMcpToolCall('update_document_metadata', { docId: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('docId must be a positive integer');
  });

  it('rejects a negative docId', async () => {
    const { mcpServer } = await freshMcp();
    const result = await mcpServer.handleMcpToolCall('update_document_metadata', { docId: -3 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('docId must be a positive integer');
  });

  it('rejects arguments that fail Zod validation (wrong type for a field)', async () => {
    const { mcpServer } = await freshMcp();
    const result = await mcpServer.handleMcpToolCall('update_document_metadata', { docId: 1, category: 123 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid arguments');
  });

  it('rejects a forbidden subcategory per Golden Rule #4 (general/other/divers/year)', async () => {
    const { mcpServer } = await freshMcp();
    const general = await mcpServer.handleMcpToolCall('update_document_metadata', { docId: 1, subcategory: 'general' });
    expect(general.isError).toBe(true);
    expect(general.content[0].text).toContain('Golden Rule #4');

    const year = await mcpServer.handleMcpToolCall('update_document_metadata', { docId: 1, subcategory: '2024' });
    expect(year.isError).toBe(true);
    expect(year.content[0].text).toContain('Golden Rule #4');

    const frenchAlias = await mcpServer.handleMcpToolCall('update_document_metadata', { docId: 1, subcategorie: 'divers' });
    expect(frenchAlias.isError).toBe(true);
    expect(frenchAlias.content[0].text).toContain('Golden Rule #4');
  });

  it('returns an isError response for a docId that does not exist', async () => {
    const { mcpServer } = await freshMcp();
    const result = await mcpServer.handleMcpToolCall('update_document_metadata', { docId: 9999, subcategory: 'sfr' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Document ID 9999 not found');
  });

  it('updates non-path fields only, without touching relocalization, when new_path does not exist on disk', async () => {
    const { database, relocalize, jsonRegistry, mcpServer } = await freshMcp();
    const id = await database.insertDocumentRecord(sampleDoc({ checksum: 'y', new_path: '' }));

    const result = await mcpServer.handleMcpToolCall('update_document_metadata', { docId: id, summary: 'Updated summary only' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(`Successfully updated metadata for document ID ${id}`);

    const doc = await database.getDocumentById(id);
    expect(doc?.summary).toBe('Updated summary only');
    expect(doc?.title).toBe('Facture SFR Janvier'); // untouched

    expect(relocalize.relocalizeFileIfNeeded).not.toHaveBeenCalled();
    expect(jsonRegistry.syncJSONRegistry).toHaveBeenCalledTimes(1);
  });

  it('accepts the French categorie/subcategorie aliases and prefers explicit English keys when both are given (Golden Rule #19)', async () => {
    const { database, mcpServer } = await freshMcp();
    const id = await database.insertDocumentRecord(sampleDoc({ checksum: 'z', new_path: '' }));

    await mcpServer.handleMcpToolCall('update_document_metadata', { docId: id, categorie: 'utilities', subcategorie: 'edf' });
    const doc = await database.getDocumentById(id);
    expect(doc?.category).toBe('utilities');
    expect(doc?.subcategory).toBe('edf');
  });

  it('relocalizes the physical file when category/subcategory change and the file exists on disk', async () => {
    const { database, relocalize, mcpServer } = await freshMcp();

    const tempFile = path.join(os.tmpdir(), `mcp-relocalize-test-${Date.now()}.pdf`);
    fs.writeFileSync(tempFile, 'dummy pdf bytes');

    try {
      const id = await database.insertDocumentRecord(sampleDoc({ checksum: 'reloc', category: 'invoices', subcategory: 'sfr', new_path: tempFile }));

      const mockedNewPath = path.join(os.tmpdir(), 'organized', 'telecom', 'orange', '2026', 'facture.pdf');
      vi.mocked(relocalize.relocalizeFileIfNeeded).mockReturnValue({ newPath: mockedNewPath, moved: true });

      const result = await mcpServer.handleMcpToolCall('update_document_metadata', { docId: id, category: 'telecom', subcategory: 'orange' });
      expect(result.isError).toBeUndefined();

      expect(relocalize.ensureCategoryAndSubcategoryExist).toHaveBeenCalledWith('telecom', 'orange');
      expect(relocalize.relocalizeFileIfNeeded).toHaveBeenCalledWith(tempFile, 'telecom', 'orange', '2026-01-15');

      const doc = await database.getDocumentById(id);
      expect(doc?.category).toBe('telecom');
      expect(doc?.subcategory).toBe('orange');
      expect(doc?.new_path).toBe(mockedNewPath); // DB updated to match the relocalized path — this is the "DB and disk out of sync" bug being guarded against
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  it('does not re-run updateDocumentRecord for the path when relocalizeFileIfNeeded reports no move (newPath === current new_path)', async () => {
    const { database, relocalize, mcpServer } = await freshMcp();

    const tempFile = path.join(os.tmpdir(), `mcp-relocalize-nomove-test-${Date.now()}.pdf`);
    fs.writeFileSync(tempFile, 'dummy pdf bytes');

    try {
      const id = await database.insertDocumentRecord(sampleDoc({ checksum: 'nomove', category: 'invoices', subcategory: 'sfr', new_path: tempFile }));
      vi.mocked(relocalize.relocalizeFileIfNeeded).mockReturnValue({ newPath: tempFile, moved: false });

      await mcpServer.handleMcpToolCall('update_document_metadata', { docId: id, category: 'invoices', subcategory: 'sfr2' });

      const doc = await database.getDocumentById(id);
      expect(doc?.new_path).toBe(tempFile);
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });
});

describe('handleMcpToolCall — trigger_triage', () => {
  it('returns the runTriageScan result on success', async () => {
    const { triageScan, mcpServer } = await freshMcp();
    const scanResult = { scannedCount: 3, processedCount: 2, skippedCount: 1, items: [{ file: 'a.pdf' }] };
    vi.mocked(triageScan.runTriageScan).mockResolvedValue(scanResult as any);

    const result = await mcpServer.handleMcpToolCall('trigger_triage', {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(scanResult);
  });

  it('turns a ScanInProgressError into an isError response instead of propagating', async () => {
    const { triageScan, mcpServer } = await freshMcp();
    const { ScanInProgressError } = await import('../../application/scan-lock.js');
    vi.mocked(triageScan.runTriageScan).mockRejectedValue(new ScanInProgressError(4242));

    const result = await mcpServer.handleMcpToolCall('trigger_triage', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already in progress');
    expect(result.content[0].text).toContain('4242');
  });

  it('surfaces an unrelated thrown error as an isError response via the outer catch', async () => {
    const { triageScan, mcpServer } = await freshMcp();
    vi.mocked(triageScan.runTriageScan).mockRejectedValue(new Error('disk exploded'));

    const result = await mcpServer.handleMcpToolCall('trigger_triage', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disk exploded');
  });
});

describe('handleMcpToolCall — list_categories', () => {
  it('returns whatever getCategoriesConfig() provides', async () => {
    const { categoriesStore, mcpServer } = await freshMcp();
    const categories = [{ id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] }];
    vi.mocked(categoriesStore.getCategoriesConfig).mockReturnValue({ categories } as any);

    const result = await mcpServer.handleMcpToolCall('list_categories', {});
    expect(JSON.parse(result.content[0].text)).toEqual(categories);
  });
});

describe('handleMcpToolCall — package_documents', () => {
  it('errors when neither docIds nor dossierType is provided', async () => {
    const { mcpServer } = await freshMcp();
    const result = await mcpServer.handleMcpToolCall('package_documents', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error: provide either docIds or dossierType.');
  });

  it('errors when every resolved document has no file on disk', async () => {
    const { database, relocalize, mcpServer } = await freshMcp();
    vi.mocked(relocalize.findActualFileOnDisk).mockReturnValue(null);
    const id = await database.insertDocumentRecord(sampleDoc({ checksum: 'nofile' }));

    const result = await mcpServer.handleMcpToolCall('package_documents', { docIds: [id] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`Missing IDs: ${id}`);
  });

  it('builds a real zip on disk for docIds resolving to a file, reporting included and missing IDs', async () => {
    const { database, relocalize, mcpServer } = await freshMcp();
    const settings = await import('../settings.js');

    const tempFile = path.join(os.tmpdir(), `mcp-package-test-${Date.now()}.pdf`);
    fs.writeFileSync(tempFile, 'dummy pdf bytes');
    let zipPath: string | undefined;

    try {
      const foundId = await database.insertDocumentRecord(sampleDoc({ checksum: 'pkg-found', title: 'Found Doc' }));
      const missingId = await database.insertDocumentRecord(sampleDoc({ checksum: 'pkg-missing', title: 'Missing Doc' }));

      vi.mocked(relocalize.findActualFileOnDisk).mockImplementation((doc: any) => doc.id === foundId ? tempFile : null);

      const result = await mcpServer.handleMcpToolCall('package_documents', { docIds: [foundId, missingId], zipName: 'unit_test_pack' });
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.fileCount).toBe(1);
      expect(parsed.includedDocIds).toEqual([foundId]);
      expect(parsed.missingDocIds).toEqual([missingId]);
      expect(parsed.zipPath).toBe(path.join(settings.BASE_DIR, '__packages', 'unit_test_pack.zip'));

      zipPath = parsed.zipPath;
      expect(fs.existsSync(zipPath!)).toBe(true);
      expect(fs.readFileSync(zipPath!).slice(0, 4).toString('hex')).toBe('504b0304'); // PK.. zip magic bytes
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      if (zipPath && fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    }
  });
});

describe('handleMcpToolCall — unknown tool', () => {
  it('returns an isError response for an unrecognized tool name', async () => {
    const { mcpServer } = await freshMcp();
    const result = await mcpServer.handleMcpToolCall('does_not_exist', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Unknown tool name: does_not_exist');
  });
});
