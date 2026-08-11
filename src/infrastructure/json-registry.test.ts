import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tempDir: string;
let registryPath: string;
let dbPath: string;

// JSON_REGISTRY_PATH actually does respect process.env.PDF_REGISTRY_PATH in the real
// settings.ts, but DB_PATH is what getAllDocuments() (imported from database.js) needs,
// and mocking the whole module keeps this consistent with the other infra test files.
vi.mock('./settings.js', () => ({
  get CONFIG() { return { JSON_REGISTRY_PATH: registryPath, DB_PATH: dbPath }; },
}));

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-registry-test-'));
  registryPath = path.join(tempDir, 'registry.json');
  dbPath = path.join(tempDir, 'pdf_triage.db');
});

afterEach(async () => {
  try {
    const { getDb } = await import('./db/database.js');
    const db = await getDb();
    await db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function fresh() {
  vi.resetModules();
  const database = await import('./db/database.js');
  const jsonRegistry = await import('./json-registry.js');
  return { database, jsonRegistry };
}

function sampleDoc(overrides: Record<string, any> = {}) {
  return {
    checksum: 'chk-' + Math.random().toString(36).slice(2),
    title: 'Facture SFR',
    registre: 'REF-1',
    date: '2026-01-15',
    category: 'invoices',
    subcategory: 'sfr',
    summary: 'resume',
    tags: ['a', 'b'],
    raw_text: 'contenu',
    original_filename: 'facture.pdf',
    original_path: 'C:/raws/facture.pdf',
    new_path: 'C:/archive/invoices/sfr/2026/facture.pdf',
    status: 'MOVED',
    ...overrides,
  };
}

describe('syncJSONRegistry', () => {
  it('writes an empty registry when there are no documents', async () => {
    const { jsonRegistry } = await fresh();
    await jsonRegistry.syncJSONRegistry();

    const written = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(written.total_count).toBe(0);
    expect(written.documents).toEqual([]);
    expect(typeof written.updated_at).toBe('string');
  });

  it('maps DB documents into registry entries, parsing tags and defaulting empty subcategory to "general"', async () => {
    const { database, jsonRegistry } = await fresh();
    await database.insertDocumentRecord(sampleDoc({ subcategory: undefined, tags: ['facture', 'sfr'] }));

    await jsonRegistry.syncJSONRegistry();

    const written = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(written.total_count).toBe(1);
    expect(written.documents[0]).toMatchObject({
      title: 'Facture SFR',
      category: 'invoices',
      subcategory: 'general',
      tags: ['facture', 'sfr'],
    });
  });

  it('falls back to an empty array when a document\'s stored tags are not valid JSON', async () => {
    const { database, jsonRegistry } = await fresh();
    const id = await database.insertDocumentRecord(sampleDoc());
    const db = await database.getDb();
    await db.run('UPDATE documents SET tags = ? WHERE id = ?', ['not valid json{{', id]);

    await jsonRegistry.syncJSONRegistry();

    const written = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(written.documents[0].tags).toEqual([]);
  });

  it('does not leave a .tmp file behind after the atomic write', async () => {
    const { jsonRegistry } = await fresh();
    await jsonRegistry.syncJSONRegistry();
    expect(fs.existsSync(`${registryPath}.tmp`)).toBe(false);
    expect(fs.existsSync(registryPath)).toBe(true);
  });
});
