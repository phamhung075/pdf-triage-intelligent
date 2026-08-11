import fs from 'fs';
import { CONFIG } from './settings.js';
import { getDb } from './db/database.js';
import { logger } from './logger.js';

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
  created_at?: string;
}

export async function recordManualDecision(record: ManualDecisionRecord): Promise<void> {
  const createdAt = record.created_at || new Date().toISOString();
  const rawSnippet = (record.raw_text_snippet || '').substring(0, 500);

  // 1. Insert into SQLite Database
  try {
    const db = await getDb();
    await db.run(
      `INSERT INTO manual_decisions (
        document_id, checksum, original_filename, title,
        old_category, old_subcategory, new_category, new_subcategory,
        user_feedback_reason, raw_text_snippet, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        createdAt
      ]
    );
    logger.info('DECISION_REGISTRY', `Recorded manual move decision for doc ID ${record.document_id} (${record.original_filename}): ${record.old_category}/${record.old_subcategory} ➔ ${record.new_category}/${record.new_subcategory}`);
  } catch (err) {
    logger.error('DECISION_REGISTRY', `Failed to insert manual decision into DB:`, err);
  }

  // 2. Persist into manual_decisions.json
  try {
    const targetFilePath = CONFIG.MANUAL_DECISIONS_FILE || 'manual_decisions.json';
    let decisions: ManualDecisionRecord[] = [];
    if (fs.existsSync(targetFilePath)) {
      try {
        decisions = JSON.parse(fs.readFileSync(targetFilePath, 'utf-8'));
      } catch (e) {}
    }

    decisions.push({
      ...record,
      raw_text_snippet: rawSnippet,
      created_at: createdAt
    });

    fs.writeFileSync(targetFilePath, JSON.stringify(decisions, null, 2), 'utf-8');
  } catch (err) {
    logger.error('DECISION_REGISTRY', `Failed to save manual_decisions.json:`, err);
  }
}

export async function getManualDecisions(): Promise<ManualDecisionRecord[]> {
  try {
    const db = await getDb();
    return await db.all('SELECT * FROM manual_decisions ORDER BY id DESC');
  } catch (err) {
    const targetFilePath = CONFIG.MANUAL_DECISIONS_FILE || 'manual_decisions.json';
    if (fs.existsSync(targetFilePath)) {
      try {
        return JSON.parse(fs.readFileSync(targetFilePath, 'utf-8'));
      } catch (e) {}
    }
  }
  return [];
}
