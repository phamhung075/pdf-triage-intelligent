import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let dbPath: string;
let originalEnvDbPath: string | undefined;

// Each test gets its own on-disk SQLite file (WAL mode needs a real file, not ':memory:'
// shared across connections) and a freshly re-evaluated module graph so the
// module-level `dbInstance` singleton in database.ts doesn't leak across tests.
beforeEach(() => {
  originalEnvDbPath = process.env.PDF_DB_PATH;
  dbPath = path.join(os.tmpdir(), `pdf-triage-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PDF_DB_PATH = dbPath;
});

afterEach(async () => {
  const { getDb } = await import('./database.js');
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

async function freshDb() {
  const { vi } = await import('vitest');
  vi.resetModules();
  return import('./database.js');
}

function sampleDoc(overrides: Record<string, any> = {}) {
  return {
    checksum: 'abc123',
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
    new_path: 'C:/archive/invoices/sfr/2026/facture.pdf',
    embedding: [0.1, 0.2, 0.3],
    status: 'COMPLETED',
    ...overrides,
  };
}

describe('getDb / initSchema', () => {
  it('creates documents, categories_db, and blocked_files tables on first call', async () => {
    const { getDb } = await freshDb();
    const db = await getDb();
    const tables = await db.all<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    const names = tables.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['documents', 'categories_db', 'blocked_files']));
  });

  it('is idempotent — calling getDb() twice returns the same instance without re-throwing on CREATE TABLE', async () => {
    const { getDb } = await freshDb();
    const db1 = await getDb();
    const db2 = await getDb();
    expect(db1).toBe(db2);
  });
});

describe('insertDocumentRecord / retrieval', () => {
  it('inserts a document and makes it retrievable by id and by checksum', async () => {
    const { getDb, insertDocumentRecord, getDocumentById, getDocumentByChecksum } = await freshDb();
    await getDb();
    const id = await insertDocumentRecord(sampleDoc());

    const byId = await getDocumentById(id);
    expect(byId?.title).toBe('Facture SFR Janvier');
    expect(byId?.category).toBe('invoices');
    expect(byId?.subcategory).toBe('sfr');
    expect(JSON.parse(byId!.tags)).toEqual(['facture', 'sfr']);

    const byChecksum = await getDocumentByChecksum('abc123');
    expect(byChecksum?.id).toBe(id);
  });

  it('defaults subcategory to "general" when not provided', async () => {
    const { getDb, insertDocumentRecord, getDocumentById } = await freshDb();
    await getDb();
    const id = await insertDocumentRecord(sampleDoc({ subcategory: undefined }));
    const doc = await getDocumentById(id);
    expect(doc?.subcategory).toBe('general');
  });

  it('rejects a duplicate checksum (SHA-256 checksum is the dedupe key — Golden Rule #20)', async () => {
    const { getDb, insertDocumentRecord } = await freshDb();
    await getDb();
    await insertDocumentRecord(sampleDoc());
    await expect(insertDocumentRecord(sampleDoc({ original_filename: 'other.pdf' }))).rejects.toThrow();
  });

  it('getAllDocuments returns rows ordered newest-first (id DESC)', async () => {
    const { getDb, insertDocumentRecord, getAllDocuments } = await freshDb();
    await getDb();
    const id1 = await insertDocumentRecord(sampleDoc({ checksum: 'c1' }));
    const id2 = await insertDocumentRecord(sampleDoc({ checksum: 'c2' }));
    const all = await getAllDocuments();
    expect(all[0].id).toBe(id2);
    expect(all[1].id).toBe(id1);
  });

  it('indexes the document into documents_fts so full-text search can find it', async () => {
    const { getDb, insertDocumentRecord } = await freshDb();
    const db = await getDb();
    const id = await insertDocumentRecord(sampleDoc());
    const ftsRows = await db.all(
      "SELECT doc_id FROM documents_fts WHERE documents_fts MATCH 'SFR'"
    );
    expect(ftsRows.some((r: any) => r.doc_id === id)).toBe(true);
  });
});

describe('updateDocumentRecord', () => {
  it('returns false for a non-existent document id', async () => {
    const { getDb, updateDocumentRecord } = await freshDb();
    await getDb();
    const result = await updateDocumentRecord(999, { title: 'Nope' });
    expect(result).toBe(false);
  });

  it('updates only the provided fields and preserves the rest', async () => {
    const { getDb, insertDocumentRecord, updateDocumentRecord, getDocumentById } = await freshDb();
    await getDb();
    const id = await insertDocumentRecord(sampleDoc());
    await updateDocumentRecord(id, { summary: 'Updated summary only' });

    const doc = await getDocumentById(id);
    expect(doc?.summary).toBe('Updated summary only');
    expect(doc?.title).toBe('Facture SFR Janvier'); // untouched
    expect(doc?.category).toBe('invoices'); // untouched
  });

  it('accepts French key aliases (titre/categorie/subcategorie) per Golden Rule #19', async () => {
    const { getDb, insertDocumentRecord, updateDocumentRecord, getDocumentById } = await freshDb();
    await getDb();
    const id = await insertDocumentRecord(sampleDoc());
    await updateDocumentRecord(id, {
      titre: 'Nouveau Titre',
      categorie: 'utilities',
      subcategorie: 'edf',
    });

    const doc = await getDocumentById(id);
    expect(doc?.title).toBe('Nouveau Titre');
    expect(doc?.category).toBe('utilities');
    expect(doc?.subcategory).toBe('edf');
  });

  it('prefers the English key over the French alias when both are given', async () => {
    const { getDb, insertDocumentRecord, updateDocumentRecord, getDocumentById } = await freshDb();
    await getDb();
    const id = await insertDocumentRecord(sampleDoc());
    await updateDocumentRecord(id, { category: 'english-wins', categorie: 'french-loses' } as any);
    const doc = await getDocumentById(id);
    expect(doc?.category).toBe('english-wins');
  });

  it('re-indexes documents_fts after an update instead of leaving a stale row', async () => {
    const { getDb, insertDocumentRecord, updateDocumentRecord } = await freshDb();
    const db = await getDb();
    // "mensuelle" only appears in the original summary — title/tags/raw_text don't
    // contain it — so it's a clean marker for "did the old summary get purged".
    const id = await insertDocumentRecord(sampleDoc({ summary: 'Facture mensuelle pour janvier' }));
    await updateDocumentRecord(id, { summary: 'Completely different renamed content xyzzy' });

    const staleMatches = await db.all("SELECT doc_id FROM documents_fts WHERE documents_fts MATCH 'mensuelle'");
    expect(staleMatches.some((r: any) => r.doc_id === id)).toBe(false);

    const freshMatches = await db.all("SELECT doc_id FROM documents_fts WHERE documents_fts MATCH 'xyzzy'");
    expect(freshMatches.some((r: any) => r.doc_id === id)).toBe(true);
  });
});

describe('blocked files CRUD', () => {
  const entry = {
    original_path: 'C:/raws/bad.pdf',
    filename: 'bad.pdf',
    reason: 'no_text',
    message: 'Blocked: No text extracted from PDF.',
    mtime_ms: 123456,
    size: 42,
  };

  it('upserts, then reads back a blocked file', async () => {
    const { getDb, upsertBlockedFile, getBlockedFile } = await freshDb();
    await getDb();
    await upsertBlockedFile(entry);
    const found = await getBlockedFile(entry.original_path);
    expect(found?.filename).toBe('bad.pdf');
    expect(found?.reason).toBe('no_text');
  });

  it('upserting the same original_path again updates the row instead of duplicating it', async () => {
    const { getDb, upsertBlockedFile, getBlockedFile } = await freshDb();
    const db = await getDb();
    await upsertBlockedFile(entry);
    await upsertBlockedFile({ ...entry, reason: 'ocr_failed', message: 'Blocked: OCR failed.' });

    const rows = await db.all('SELECT * FROM blocked_files WHERE original_path = ?', [entry.original_path]);
    expect(rows).toHaveLength(1);
    const found = await getBlockedFile(entry.original_path);
    expect(found?.reason).toBe('ocr_failed');
  });

  it('deletes a blocked file', async () => {
    const { getDb, upsertBlockedFile, deleteBlockedFile, getBlockedFile } = await freshDb();
    await getDb();
    await upsertBlockedFile(entry);
    await deleteBlockedFile(entry.original_path);
    expect(await getBlockedFile(entry.original_path)).toBeUndefined();
  });

  it('pruneBlockedFiles removes entries whose path is no longer in the provided existing-paths list', async () => {
    const { getDb, upsertBlockedFile, getBlockedFile } = await freshDb();
    await getDb();
    await upsertBlockedFile(entry);
    await upsertBlockedFile({ ...entry, original_path: 'C:/raws/still-there.pdf', filename: 'still-there.pdf' });

    const { pruneBlockedFiles } = await import('./database.js');
    await pruneBlockedFiles(['C:/raws/still-there.pdf']);

    expect(await getBlockedFile(entry.original_path)).toBeUndefined();
    expect(await getBlockedFile('C:/raws/still-there.pdf')).toBeDefined();
  });

  it('getAllBlockedFiles lists every blocked file, newest first', async () => {
    const { getDb, upsertBlockedFile, getAllBlockedFiles } = await freshDb();
    await getDb();
    await upsertBlockedFile(entry);
    await upsertBlockedFile({ ...entry, original_path: 'C:/raws/second.pdf', filename: 'second.pdf', reason: 'no_text' });

    const all = await getAllBlockedFiles();
    expect(all).toHaveLength(2);
    expect(all.map(f => f.filename).sort()).toEqual(['bad.pdf', 'second.pdf']);
  });
});

describe('getCategorySubcategoryStats', () => {
  it('aggregates counts per category/subcategory, case-insensitively', async () => {
    const { getDb, insertDocumentRecord, getCategorySubcategoryStats } = await freshDb();
    await getDb();
    await insertDocumentRecord(sampleDoc({ checksum: 'a', category: 'invoices', subcategory: 'sfr' }));
    await insertDocumentRecord(sampleDoc({ checksum: 'b', category: 'Invoices', subcategory: 'SFR' }));
    await insertDocumentRecord(sampleDoc({ checksum: 'c', category: 'invoices', subcategory: 'edf' }));

    const stats = await getCategorySubcategoryStats();
    expect(stats.total).toBe(3);
    expect(stats.categoryCounts['invoices']).toBe(3);
    expect(stats.subcategoryCounts['invoices']['sfr']).toBe(2);
    expect(stats.subcategoryCounts['invoices']['edf']).toBe(1);
  });

  it('buckets an empty subcategory under "general"', async () => {
    const { getDb, insertDocumentRecord, getCategorySubcategoryStats } = await freshDb();
    await getDb();
    await insertDocumentRecord(sampleDoc({ checksum: 'a', category: 'misc', subcategory: '' }));

    const stats = await getCategorySubcategoryStats();
    expect(stats.subcategoryCounts['misc']['general']).toBe(1);
  });
});
