import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { CONFIG } from '../settings.js';
import { detectFileType } from '../../domain/taxonomy.js';
import fs from 'fs';

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (dbInstance) {
    return dbInstance;
  }

  dbInstance = await open({
    filename: CONFIG.DB_PATH,
    driver: sqlite3.Database
  });

  try {
    await dbInstance.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA busy_timeout = 10000;
    `);
  } catch (err: any) {
    console.warn('SQLite WAL pragma setup notice:', err.message);
  }

  await initSchema(dbInstance);
  return dbInstance;
}

async function initSchema(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checksum TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      registre TEXT DEFAULT '',
      date TEXT DEFAULT '',
      category TEXT NOT NULL,
      subcategory TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      raw_text TEXT DEFAULT '',
      markdown_content TEXT DEFAULT '',
      total_amount TEXT DEFAULT '',
      vat_amount TEXT DEFAULT '',
      siren TEXT DEFAULT '',
      iban TEXT DEFAULT '',
      expiry_date TEXT DEFAULT '',
      contact_name TEXT DEFAULT '',
      contact_email TEXT DEFAULT '',
      contact_phone TEXT DEFAULT '',
      contact_address TEXT DEFAULT '',
      contact_website TEXT DEFAULT '',
      original_filename TEXT NOT NULL,
      original_path TEXT NOT NULL,
      new_path TEXT DEFAULT '',
      file_type TEXT DEFAULT 'PDF',
      -- Where the photograph that produced this PDF was parked
      -- (__raws/.delete_files/img_converted/...). Empty for documents that arrived as PDFs, and
      -- for anything converted before sources were retained — those photos were deleted outright,
      -- so there is nothing to point at and no way to backfill.
      source_image_path TEXT DEFAULT '',
      embedding TEXT DEFAULT '[]',
      status TEXT DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories_db (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      aliases TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS blocked_files (
      original_path TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      reason TEXT NOT NULL,
      message TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration: add subcategory, markdown_content, total_amount, vat_amount, siren, iban, expiry_date, contact_name, contact_email, contact_phone, contact_address, and contact_website columns if missing
  try {
    const tableInfo = await db.all("PRAGMA table_info(documents);");
    const hasSubcategory = tableInfo.some((col: any) => col.name === 'subcategory');
    if (!hasSubcategory) {
      await db.exec("ALTER TABLE documents ADD COLUMN subcategory TEXT DEFAULT '';");
    }
    const hasMarkdown = tableInfo.some((col: any) => col.name === 'markdown_content');
    if (!hasMarkdown) {
      await db.exec("ALTER TABLE documents ADD COLUMN markdown_content TEXT DEFAULT '';");
    }
    const hasTotalAmount = tableInfo.some((col: any) => col.name === 'total_amount');
    if (!hasTotalAmount) {
      await db.exec("ALTER TABLE documents ADD COLUMN total_amount TEXT DEFAULT '';");
      await db.exec("ALTER TABLE documents ADD COLUMN vat_amount TEXT DEFAULT '';");
      await db.exec("ALTER TABLE documents ADD COLUMN siren TEXT DEFAULT '';");
      await db.exec("ALTER TABLE documents ADD COLUMN iban TEXT DEFAULT '';");
      await db.exec("ALTER TABLE documents ADD COLUMN expiry_date TEXT DEFAULT '';");
    }
    const hasContactName = tableInfo.some((col: any) => col.name === 'contact_name');
    if (!hasContactName) {
      await db.exec("ALTER TABLE documents ADD COLUMN contact_name TEXT DEFAULT '';");
      await db.exec("ALTER TABLE documents ADD COLUMN contact_email TEXT DEFAULT '';");
      await db.exec("ALTER TABLE documents ADD COLUMN contact_phone TEXT DEFAULT '';");
      await db.exec("ALTER TABLE documents ADD COLUMN contact_address TEXT DEFAULT '';");
      await db.exec("ALTER TABLE documents ADD COLUMN contact_website TEXT DEFAULT '';");
    }
    const hasFileType = tableInfo.some((col: any) => col.name === 'file_type');
    if (!hasFileType) {
      await db.exec("ALTER TABLE documents ADD COLUMN file_type TEXT DEFAULT 'PDF';");
    }
    const hasSourceImage = tableInfo.some((col: any) => col.name === 'source_image_path');
    if (!hasSourceImage) {
      await db.exec("ALTER TABLE documents ADD COLUMN source_image_path TEXT DEFAULT '';");
    }
    await db.exec("UPDATE documents SET contact_name='', contact_email='', contact_phone='', contact_address='', contact_website='' WHERE contact_name LIKE '%Description%' OR contact_name LIKE '%Qty%' OR contact_name LIKE '%Subtotal%' OR contact_name LIKE '%Unit price%';");
  } catch (err) {
    console.warn("Table info pragma migration check notice:", err);
  }

  // Create manual_decisions table for registering user move / relocalize choices
  await db.exec(`
    CREATE TABLE IF NOT EXISTS manual_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER,
      checksum TEXT,
      original_filename TEXT,
      title TEXT,
      old_category TEXT,
      old_subcategory TEXT,
      new_category TEXT,
      new_subcategory TEXT,
      user_feedback_reason TEXT,
      raw_text_snippet TEXT,
      created_at TEXT
    );
  `);

  // FTS5 index. `CREATE VIRTUAL TABLE IF NOT EXISTS` is a no-op against an EXISTING table, so
  // it silently does NOT migrate one whose columns have drifted — which is what happened here:
  // the on-disk table still had the original 7 columns while the INSERTs below had grown to 11.
  // Every insert then failed at prepare, straight into an empty catch, so the index sat at 0 rows
  // against a full corpus of documents and nobody noticed. Detect the drift and rebuild.
  const FTS_COLUMN_NAMES = [
    'doc_id', 'title', 'original_filename', 'original_path', 'new_path',
    'registre', 'summary', 'category', 'subcategory', 'tags', 'raw_text',
  ];
  const CREATE_FTS = `
    CREATE VIRTUAL TABLE documents_fts USING fts5(
      doc_id UNINDEXED,
        title,
        original_filename,
        original_path,
        new_path,
        registre,
        summary,
        category,
        subcategory,
        tags,
        raw_text
    );
  `;

  try {
    await db.exec(CREATE_FTS.replace('CREATE VIRTUAL TABLE', 'CREATE VIRTUAL TABLE IF NOT EXISTS'));

    const ftsInfo: Array<{ name: string }> = await db.all('PRAGMA table_info(documents_fts)');
    const actual = ftsInfo.map(c => c.name);
    const drifted = actual.length !== FTS_COLUMN_NAMES.length
      || FTS_COLUMN_NAMES.some((name, i) => actual[i] !== name);

    if (drifted) {
      console.warn(
        `FTS5 schema drift: documents_fts has [${actual.join(', ')}] but the code writes `
        + `[${FTS_COLUMN_NAMES.join(', ')}]. Rebuilding and backfilling the index.`
      );
      await db.exec('DROP TABLE IF EXISTS documents_fts;');
      await db.exec(CREATE_FTS);
    }

    // Backfill whenever the index is empty but documents exist — covers both the rebuild above
    // and any database whose index was never populated because of the drift.
    // db.get is typed as T | undefined (no row); COUNT(*) always returns one, but keep the guard
    // honest rather than asserting non-null.
    const ftsCount = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents_fts');
    const docCount = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents');
    if (ftsCount?.n === 0 && (docCount?.n ?? 0) > 0) {
      await db.exec(`
        INSERT INTO documents_fts (doc_id, title, original_filename, original_path, new_path, registre, summary, category, subcategory, tags, raw_text)
        SELECT id, COALESCE(title, ''), COALESCE(original_filename, ''), COALESCE(original_path, ''),
               COALESCE(new_path, ''), COALESCE(registre, ''), COALESCE(summary, ''),
               COALESCE(category, ''), COALESCE(subcategory, 'general'), COALESCE(tags, '[]'),
               COALESCE(raw_text, '')
        FROM documents;
      `);
      console.warn(`FTS5 index backfilled from ${docCount?.n ?? 0} existing document(s).`);
    }
  } catch (err) {
    console.warn("FTS5 virtual table setup skipped or not supported:", err);
  }
}

// One-shot so a genuinely FTS5-less SQLite build does not spam the log on every write, while a
// real breakage (schema drift, constraint failure) still surfaces instead of vanishing.
let ftsWriteFailureLogged = false;
function warnFtsWriteFailure(operation: string, err: unknown): void {
  if (ftsWriteFailureLogged) return;
  ftsWriteFailureLogged = true;
  console.warn(
    `FTS5 ${operation} failed — full-text search will be incomplete. `
    + `This message is logged once per process.`, err
  );
}

export interface DocumentRecord {
  id: number;
  checksum: string;
  title: string;
  registre: string;
  date: string;
  category: string;
  subcategory: string;
  summary: string;
  tags: string; // JSON string
  raw_text: string;
  markdown_content?: string;
  total_amount?: string;
  vat_amount?: string;
  siren?: string;
  iban?: string;
  expiry_date?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  contact_address?: string;
  contact_website?: string;
  original_filename: string;
  original_path: string;
  new_path: string;
  file_type: string;
  /** Photo this PDF was made from, parked under .delete_files/img_converted. '' when unknown. */
  source_image_path: string;
  embedding: string; // JSON string
  status: string;
  created_at: string;
  updated_at: string;
}

export async function insertDocumentRecord(doc: {
  checksum: string;
  title: string;
  registre: string;
  date: string;
  category: string;
  subcategory?: string;
  summary: string;
  tags: string[];
  raw_text: string;
  markdown_content?: string;
  total_amount?: string;
  vat_amount?: string;
  siren?: string;
  iban?: string;
  expiry_date?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  contact_address?: string;
  contact_website?: string;
  original_filename: string;
  original_path: string;
  new_path?: string;
  file_type?: string;
  source_image_path?: string;
  embedding?: number[];
  status?: string;
}): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();

  const result = await db.run(
    `INSERT INTO documents (
      checksum, title, registre, date, category, subcategory, summary, tags, raw_text, markdown_content,
      total_amount, vat_amount, siren, iban, expiry_date, contact_name, contact_email, contact_phone, contact_address, contact_website,
      original_filename, original_path, new_path, file_type, source_image_path, embedding, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      doc.checksum,
      doc.title,
      doc.registre || '',
      doc.date || '',
      doc.category,
      doc.subcategory || 'general',
      doc.summary || '',
      JSON.stringify(doc.tags || []),
      doc.raw_text || '',
      doc.markdown_content || '',
      doc.total_amount || '',
      doc.vat_amount || '',
      doc.siren || '',
      doc.iban || '',
      doc.expiry_date || '',
      doc.contact_name || '',
      doc.contact_email || '',
      doc.contact_phone || '',
      doc.contact_address || '',
      doc.contact_website || '',
      doc.original_filename,
      doc.original_path,
      doc.new_path || '',
      doc.file_type || detectFileType(doc.original_filename),
      doc.source_image_path || '',
      JSON.stringify(doc.embedding || []),
      doc.status || 'PENDING',
      now,
      now
    ]
  );

  const docId = result.lastID!;

  // Index in FTS if available
  try {
    await db.run(
      `INSERT INTO documents_fts (doc_id, title, original_filename, original_path, new_path, registre, summary, category, subcategory, tags, raw_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        docId,
        doc.title,
        doc.original_filename || '',
        doc.original_path || '',
        doc.new_path || '',
        doc.registre || '',
        doc.summary || '',
        doc.category,
        doc.subcategory || 'general',
        JSON.stringify(doc.tags || []),
        doc.raw_text || ''
      ]
    );
  } catch (err) {
    warnFtsWriteFailure('insert', err);
  }

  return docId;
}

export async function updateDocumentRecord(id: number, updates: {
  title?: string;
  titre?: string;
  registre?: string;
  date?: string;
  category?: string;
  categorie?: string;
  subcategory?: string;
  subcategorie?: string;
  summary?: string;
  tags?: string[];
  raw_text?: string;
  markdown_content?: string;
  total_amount?: string;
  vat_amount?: string;
  siren?: string;
  iban?: string;
  expiry_date?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  contact_address?: string;
  contact_website?: string;
  new_path?: string;
  status?: string;
}): Promise<boolean> {
  const db = await getDb();
  const existing = await db.get<DocumentRecord>('SELECT * FROM documents WHERE id = ?', [id]);
  if (!existing) return false;

  const now = new Date().toISOString();
  const title = updates.title ?? updates.titre ?? existing.title;
  const registre = updates.registre ?? existing.registre;
  const date = updates.date ?? existing.date;
  const category = updates.category ?? updates.categorie ?? existing.category;
  const subcategory = updates.subcategory ?? updates.subcategorie ?? existing.subcategory;
  const summary = updates.summary ?? existing.summary;
  const tagsStr = updates.tags ? JSON.stringify(updates.tags) : existing.tags;
  const raw_text = updates.raw_text ?? existing.raw_text;
  const markdown_content = updates.markdown_content ?? (existing.markdown_content || '');
  const total_amount = updates.total_amount ?? (existing.total_amount || '');
  const vat_amount = updates.vat_amount ?? (existing.vat_amount || '');
  const siren = updates.siren ?? (existing.siren || '');
  const iban = updates.iban ?? (existing.iban || '');
  const expiry_date = updates.expiry_date ?? (existing.expiry_date || '');
  const contact_name = updates.contact_name ?? (existing.contact_name || '');
  const contact_email = updates.contact_email ?? (existing.contact_email || '');
  const contact_phone = updates.contact_phone ?? (existing.contact_phone || '');
  const contact_address = updates.contact_address ?? (existing.contact_address || '');
  const contact_website = updates.contact_website ?? (existing.contact_website || '');
  const new_path = updates.new_path ?? existing.new_path;
  const status = updates.status ?? existing.status;

  await db.run(
    `UPDATE documents SET
      title = ?, registre = ?, date = ?, category = ?, subcategory = ?, summary = ?,
      tags = ?, raw_text = ?, markdown_content = ?, total_amount = ?, vat_amount = ?,
      siren = ?, iban = ?, expiry_date = ?, contact_name = ?, contact_email = ?, contact_phone = ?,
      contact_address = ?, contact_website = ?, new_path = ?, status = ?, updated_at = ?
     WHERE id = ?`,
    [title, registre, date, category, subcategory, summary, tagsStr, raw_text, markdown_content, total_amount, vat_amount, siren, iban, expiry_date, contact_name, contact_email, contact_phone, contact_address, contact_website, new_path, status, now, id]
  );

  // Update FTS
  try {
    await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [id]);
    await db.run(
      `INSERT INTO documents_fts (doc_id, title, original_filename, original_path, new_path, registre, summary, category, subcategory, tags, raw_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, title, existing.original_filename || '', existing.original_path || '', new_path || '', registre, summary, category, subcategory, tagsStr, raw_text]
    );
  } catch (err) {
    // Ignore FTS errors
  }

  return true;
}

export async function getAllDocuments(): Promise<DocumentRecord[]> {
  const db = await getDb();
  return db.all<DocumentRecord[]>('SELECT * FROM documents ORDER BY id DESC');
}

export async function getDocumentById(id: number): Promise<DocumentRecord | undefined> {
  const db = await getDb();
  return db.get<DocumentRecord>('SELECT * FROM documents WHERE id = ?', [id]);
}

export async function getDocumentByChecksum(checksum: string): Promise<DocumentRecord | undefined> {
  const db = await getDb();
  return db.get<DocumentRecord>('SELECT * FROM documents WHERE checksum = ?', [checksum]);
}

export interface BlockedFileRecord {
  original_path: string;
  filename: string;
  reason: string;
  message: string;
  mtime_ms: number;
  size: number;
  blocked_at: string;
}

export async function getBlockedFile(originalPath: string): Promise<BlockedFileRecord | undefined> {
  const db = await getDb();
  return db.get<BlockedFileRecord>('SELECT * FROM blocked_files WHERE original_path = ?', [originalPath]);
}

export async function getAllBlockedFiles(): Promise<BlockedFileRecord[]> {
  const db = await getDb();
  return db.all<BlockedFileRecord[]>('SELECT * FROM blocked_files ORDER BY blocked_at DESC');
}

export async function upsertBlockedFile(entry: {
  original_path: string;
  filename: string;
  reason: string;
  message: string;
  mtime_ms: number;
  size: number;
}): Promise<void> {
  const db = await getDb();
  await db.run(
    `INSERT INTO blocked_files (original_path, filename, reason, message, mtime_ms, size, blocked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(original_path) DO UPDATE SET
       filename = excluded.filename,
       reason = excluded.reason,
       message = excluded.message,
       mtime_ms = excluded.mtime_ms,
       size = excluded.size,
       blocked_at = excluded.blocked_at`,
    [entry.original_path, entry.filename, entry.reason, entry.message, entry.mtime_ms, entry.size, new Date().toISOString()]
  );
}

export async function deleteBlockedFile(originalPath: string): Promise<void> {
  const db = await getDb();
  await db.run('DELETE FROM blocked_files WHERE original_path = ?', [originalPath]);
}

export async function pruneBlockedFiles(existingPaths: string[]): Promise<void> {
  const db = await getDb();
  const rows = await db.all<{ original_path: string }[]>('SELECT original_path FROM blocked_files');
  const existingSet = new Set(existingPaths);
  const stale = rows.filter(r => !existingSet.has(r.original_path));
  for (const row of stale) {
    await db.run('DELETE FROM blocked_files WHERE original_path = ?', [row.original_path]);
  }
}

export async function getCategorySubcategoryStats(): Promise<{
  total: number;
  categoryCounts: Record<string, number>;
  subcategoryCounts: Record<string, Record<string, number>>;
}> {
  const db = await getDb();
  const rows = await db.all<{ category: string; subcategory: string; count: number }[]>(
    `SELECT LOWER(category) as category, LOWER(COALESCE(NULLIF(subcategory, ''), 'general')) as subcategory, COUNT(*) as count 
     FROM documents 
     GROUP BY LOWER(category), LOWER(COALESCE(NULLIF(subcategory, ''), 'general'))`
  );

  let total = 0;
  const categoryCounts: Record<string, number> = {};
  const subcategoryCounts: Record<string, Record<string, number>> = {};

  for (const row of rows) {
    const cat = row.category;
    const sub = row.subcategory;
    const cnt = row.count;

    total += cnt;
    categoryCounts[cat] = (categoryCounts[cat] || 0) + cnt;

    if (!subcategoryCounts[cat]) {
      subcategoryCounts[cat] = {};
    }
    subcategoryCounts[cat][sub] = (subcategoryCounts[cat][sub] || 0) + cnt;
  }

  return { total, categoryCounts, subcategoryCounts };
}
