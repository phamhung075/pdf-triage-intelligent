import fs from 'fs';
import path from 'path';
import { CONFIG } from './settings.js';
import { getDb } from './db/database.js';
import { logger } from './logger.js';
import { deriveRuleKeywords } from '../domain/decision-rule.js';

// settings.ts always sets MANUAL_DECISIONS_FILE to an absolute path under DATA_DIR, so in normal
// operation this simply returns it. The point is the failure mode it removes: the previous
// `CONFIG.MANUAL_DECISIONS_FILE || 'manual_decisions.json'` fell back to a RELATIVE path, which
// resolves against process.cwd(). Any caller holding an incomplete CONFIG — a test mocking
// settings.js without this key — therefore wrote silently into the repo root, appending synthetic
// entries to the user's real feedback log and making two unrelated test suites corrupt each other.
// Both call sites already catch and log, so throwing here degrades to a logged error rather than a
// write landing somewhere nobody is looking.
function manualDecisionsFilePath(): string {
  const configured = CONFIG.MANUAL_DECISIONS_FILE;
  if (typeof configured !== 'string' || !configured || !path.isAbsolute(configured)) {
    throw new Error(
      `CONFIG.MANUAL_DECISIONS_FILE must be an absolute path, got ${JSON.stringify(configured)}`
    );
  }
  return configured;
}

export interface ManualDecisionRecord {
  id?: number;
  document_id: number;
  checksum: string;
  original_filename: string;
  title: string;
  old_category: string;
  old_subcategory: string;
  new_category: string;
  new_subcategory: string;
  user_feedback_reason?: string;
  raw_text_snippet?: string;
  /**
   * Keywords this decision teaches the AI to match on FUTURE documents (injected into the
   * {{USER_PRIORITY_RULES}} STEP 0 block, see domain/decision-rule.ts). Auto-derived at record
   * time from the filename/title; empty for legacy or non-distinctive records; editable in the
   * Settings → Human Decisions tab. Empty string in the raw DB row means "not yet derived".
   */
  rule_keywords?: string[];
  /** 1 = active (injected into prompts), 0 = kept in the log but no longer teaches the AI. */
  enabled?: number;
  created_at?: string;
}

/**
 * Normalizes a raw row (SQLite TEXT columns, legacy rows without the new fields) into the
 * canonical record shape the rest of the app consumes.
 */
function normalizeDecisionRecord(row: any): ManualDecisionRecord {
  let ruleKeywords: string[] = [];
  if (Array.isArray(row.rule_keywords)) {
    ruleKeywords = row.rule_keywords;
  } else if (typeof row.rule_keywords === 'string' && row.rule_keywords.trim()) {
    try {
      const parsed = JSON.parse(row.rule_keywords);
      if (Array.isArray(parsed)) ruleKeywords = parsed;
    } catch {
      // not JSON — treat as a single comma-separated keyword list
      ruleKeywords = row.rule_keywords.split(',').map((k: string) => k.trim()).filter(Boolean);
    }
  }
  return {
    ...row,
    rule_keywords: ruleKeywords,
    enabled: row.enabled === 0 || row.enabled === '0' ? 0 : 1,
  };
}

/** Appends a record to the manual_decisions.json mirror (best-effort — never throws). */
function appendToJsonFile(record: ManualDecisionRecord): void {
  try {
    const targetFilePath = manualDecisionsFilePath();
    let decisions: ManualDecisionRecord[] = [];
    if (fs.existsSync(targetFilePath)) {
      try {
        decisions = JSON.parse(fs.readFileSync(targetFilePath, 'utf-8'));
      } catch (e) {}
    }
    decisions.push(record);
    fs.writeFileSync(targetFilePath, JSON.stringify(decisions, null, 2), 'utf-8');
  } catch (err) {
    logger.error('DECISION_REGISTRY', `Failed to save manual_decisions.json:`, err);
  }
}

/** Rewrites the whole manual_decisions.json mirror (best-effort — never throws). */
function writeJsonFile(decisions: ManualDecisionRecord[]): void {
  try {
    const targetFilePath = manualDecisionsFilePath();
    fs.writeFileSync(targetFilePath, JSON.stringify(decisions, null, 2), 'utf-8');
  } catch (err) {
    logger.error('DECISION_REGISTRY', `Failed to save manual_decisions.json:`, err);
  }
}

export async function recordManualDecision(record: ManualDecisionRecord): Promise<void> {
  const createdAt = record.created_at || new Date().toISOString();
  const rawSnippet = (record.raw_text_snippet || '').substring(0, 500);

  // Auto-derive the keywords this decision teaches the AI, unless the caller already pinned them
  // (the Settings tab edit path always pins them; every other path derives them from the file's
  // own identity). A legacy record with no distinctive token simply ends up with an empty list
  // and stays visible-but-inactive in the tab until the user fills it in.
  const ruleKeywords =
    Array.isArray(record.rule_keywords) && record.rule_keywords.some(k => k.trim())
      ? record.rule_keywords.map(k => k.trim()).filter(Boolean)
      : deriveRuleKeywords(record.original_filename || '', record.title || '');
  const enabled = record.enabled === 0 ? 0 : 1;

  // 1. Insert into SQLite Database
  let decisionId: number | undefined;
  try {
    const db = await getDb();
    const result = await db.run(
      `INSERT INTO manual_decisions (
        document_id, checksum, original_filename, title,
        old_category, old_subcategory, new_category, new_subcategory,
        user_feedback_reason, raw_text_snippet, rule_keywords, enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.document_id,
        record.checksum || '',
        record.original_filename || '',
        record.title || '',
        record.old_category || '',
        record.old_subcategory || '',
        record.new_category || '',
        record.new_subcategory || '',
        record.user_feedback_reason || '',
        rawSnippet,
        JSON.stringify(ruleKeywords),
        enabled,
        createdAt
      ]
    );
    decisionId = result.lastID;
    logger.info('DECISION_REGISTRY', `Recorded manual move decision for doc ID ${record.document_id} (${record.original_filename}): ${record.old_category}/${record.old_subcategory} ➔ ${record.new_category}/${record.new_subcategory}${ruleKeywords.length ? ` — will teach future runs on: ${ruleKeywords.join(', ')}` : ''}`);
  } catch (err) {
    logger.error('DECISION_REGISTRY', `Failed to insert manual decision into DB:`, err);
  }

  // 2. Persist into manual_decisions.json (mirror). The DB id is stored on the JSON record too,
  // so the Settings tab can update/delete individual records in BOTH stores.
  appendToJsonFile({
    ...record,
    id: decisionId ?? record.id,
    rule_keywords: ruleKeywords,
    enabled,
    raw_text_snippet: rawSnippet,
    created_at: createdAt
  });
  // Invalidate the sync-read cache explicitly — a second write within the same millisecond could
  // otherwise slip past the mtime check in readManualDecisionsSync().
  syncCache = null;
}

/**
 * Synchronous read of the JSON mirror — the ONLY reader allowed in a hot path. The prompt
 * personalization store calls this on every prompt build (classify-document → prompt.ts), and
 * that path is synchronous, so this cannot go through the async SQLite layer. The mirror is
 * maintained on every write above, and an mtime cache keeps repeated reads cheap.
 */
let syncCache: { mtimeMs: number; decisions: ManualDecisionRecord[] } | null = null;
export function readManualDecisionsSync(): ManualDecisionRecord[] {
  let filePath: string;
  try {
    filePath = manualDecisionsFilePath();
  } catch {
    return [];
  }
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    if (syncCache && syncCache.mtimeMs === stat.mtimeMs) return syncCache.decisions;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // The mirror is append-ordered (oldest first); the API/DB returns newest first. Keep the
    // two consistent so decisionsToPriorityRules caps the SAME (most recent) decisions either way.
    const decisions = (Array.isArray(parsed) ? parsed : [])
      .map(normalizeDecisionRecord)
      .reverse();
    syncCache = { mtimeMs: stat.mtimeMs, decisions };
    return decisions;
  } catch (err) {
    logger.error('DECISION_REGISTRY', `Failed to read manual_decisions.json:`, err);
    return [];
  }
}

export async function getManualDecisions(): Promise<ManualDecisionRecord[]> {
  try {
    const db = await getDb();
    const rows = await db.all('SELECT * FROM manual_decisions ORDER BY id DESC');
    return rows.map(normalizeDecisionRecord);
  } catch (err) {
    // DB unavailable → fall back to the JSON mirror (the sync reader reverses to newest-first).
    return readManualDecisionsSync();
  }
}

/** Finds a record in the JSON mirror by its canonical key (id, falling back to content key for legacy rows). */
function findJsonIndex(decisions: ManualDecisionRecord[], id: number, match: ManualDecisionRecord): number {
  if (id) {
    const byId = decisions.findIndex(d => d.id === id);
    if (byId !== -1) return byId;
  }
  return decisions.findIndex(d =>
    d.document_id === match.document_id &&
    d.checksum === match.checksum &&
    d.created_at === match.created_at
  );
}

/**
 * Updates an existing decision (edit target category/subcategory, reason, keywords, enabled
 * flag). Applies to BOTH the SQLite row and the JSON mirror. Throws on DB failure so the HTTP
 * route can surface a 500 — unlike recordManualDecision, this is a user-initiated edit, and a
 * silent no-op would look like a successful save. Returns the updated record, or null if no
 * decision with that id exists.
 */
export async function updateManualDecision(
  id: number,
  patch: {
    new_category?: string;
    new_subcategory?: string;
    user_feedback_reason?: string;
    rule_keywords?: string[];
    enabled?: number;
  }
): Promise<ManualDecisionRecord | null> {
  const db = await getDb();
  const existing = await db.get<ManualDecisionRecord>('SELECT * FROM manual_decisions WHERE id = ?', [id]);
  if (!existing) return null;

  const newCategory = patch.new_category !== undefined ? patch.new_category.toLowerCase().trim() : existing.new_category;
  const newSubcategory = patch.new_subcategory !== undefined ? patch.new_subcategory.toLowerCase().trim() : existing.new_subcategory;
  const reason = patch.user_feedback_reason !== undefined ? patch.user_feedback_reason : existing.user_feedback_reason;
  const ruleKeywords = patch.rule_keywords !== undefined
    ? Array.from(new Set(patch.rule_keywords.map(k => k.trim()).filter(Boolean)))
    : normalizeDecisionRecord(existing).rule_keywords || [];
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled ?? 1;

  await db.run(
    `UPDATE manual_decisions SET
       new_category = ?, new_subcategory = ?, user_feedback_reason = ?, rule_keywords = ?, enabled = ?
     WHERE id = ?`,
    [newCategory, newSubcategory, reason || '', JSON.stringify(ruleKeywords), enabled, id]
  );

  const updated: ManualDecisionRecord = {
    ...existing,
    new_category: newCategory,
    new_subcategory: newSubcategory,
    user_feedback_reason: reason,
    rule_keywords: ruleKeywords,
    enabled,
  };

  try {
    const targetFilePath = manualDecisionsFilePath();
    const decisions: ManualDecisionRecord[] = fs.existsSync(targetFilePath)
      ? JSON.parse(fs.readFileSync(targetFilePath, 'utf-8'))
      : [];
    const idx = findJsonIndex(decisions, id, existing);
    if (idx !== -1) decisions[idx] = { ...decisions[idx], ...updated };
    writeJsonFile(decisions);
  } catch (err) {
    logger.error('DECISION_REGISTRY', `Failed to update manual_decisions.json mirror:`, err);
  }

  syncCache = null;
  return normalizeDecisionRecord(updated);
}

/**
 * Deletes one decision from BOTH stores. Throws on DB failure (user-initiated op, must not be
 * silent). Returns false when no decision with that id exists.
 */
export async function deleteManualDecision(id: number): Promise<boolean> {
  const db = await getDb();
  const existing = await db.get<ManualDecisionRecord>('SELECT * FROM manual_decisions WHERE id = ?', [id]);
  if (!existing) return false;

  await db.run('DELETE FROM manual_decisions WHERE id = ?', [id]);

  try {
    const targetFilePath = manualDecisionsFilePath();
    const decisions: ManualDecisionRecord[] = fs.existsSync(targetFilePath)
      ? JSON.parse(fs.readFileSync(targetFilePath, 'utf-8'))
      : [];
    const idx = findJsonIndex(decisions, id, existing);
    if (idx !== -1) {
      decisions.splice(idx, 1);
      writeJsonFile(decisions);
    }
  } catch (err) {
    logger.error('DECISION_REGISTRY', `Failed to remove decision from manual_decisions.json mirror:`, err);
  }

  syncCache = null;
  logger.info('DECISION_REGISTRY', `Deleted manual decision #${id} (${existing.original_filename}) — it no longer teaches the AI`);
  return true;
}

/** Deletes every decision from BOTH stores (Settings → Human Decisions → Delete All). */
export async function clearManualDecisions(): Promise<void> {
  const db = await getDb();
  await db.run('DELETE FROM manual_decisions');
  writeJsonFile([]);
  syncCache = null;
}
