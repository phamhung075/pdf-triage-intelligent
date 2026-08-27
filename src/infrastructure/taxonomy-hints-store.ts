import fs from 'fs';
import path from 'path';
import { CONFIG } from './settings.js';
import { TaxonomyHintEntry } from '../domain/taxonomy-conflicts.js';
import { logger } from './logger.js';

// Persists the HINT half of the "block then return a hint" loop (see
// domain/taxonomy-conflicts.ts): every time a duplicate category/subcategory creation is blocked,
// the conflict is recorded here (gitignored taxonomy_hints.json, alongside manual_decisions.json)
// and re-injected into the model's {{USER_PRIORITY_RULES}} STEP 0 block on every future run, so
// Qwen stops proposing the blocked slugs. Capped to the newest MAX_TAXONOMY_HINTS entries so a
// long-running archive cannot bloat the prompt.

export const MAX_TAXONOMY_HINTS = 50;

function hintsFilePath(): string {
  const configured = CONFIG.TAXONOMY_HINTS_FILE;
  if (typeof configured !== 'string' || !configured || !path.isAbsolute(configured)) {
    throw new Error(`CONFIG.TAXONOMY_HINTS_FILE must be an absolute path, got ${JSON.stringify(configured)}`);
  }
  return configured;
}

/**
 * Appends one conflict hint (newest first) and trims the list to the cap. Never throws — the
 * classification hot path must not fail because the hint file could not be written; a failed
 * write degrades to a logged error and the block still happened. An identical conflict already
 * in the list is not appended again — repeated blocks of the same slug must not fill the cap.
 */
export function recordTaxonomyHint(entry: TaxonomyHintEntry): void {
  try {
    const targetFilePath = hintsFilePath();
    const key = JSON.stringify([entry.proposed_category || '', entry.proposed_subcategory || '', entry.mapped_category, entry.mapped_subcategory || '']);
    const existing = readTaxonomyHintsSync();
    if (existing.some(e => JSON.stringify([e.proposed_category || '', e.proposed_subcategory || '', e.mapped_category, e.mapped_subcategory || '']) === key)) {
      return;
    }
    const next = [
      { ...entry, created_at: entry.created_at || new Date().toISOString() },
      ...existing,
    ].slice(0, MAX_TAXONOMY_HINTS);

    const tmpPath = `${targetFilePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(tmpPath, targetFilePath);
    syncCache = null;
  } catch (err) {
    logger.error('TAXONOMY_GUARD', 'Failed to record taxonomy conflict hint:', err);
  }
}

let syncCache: { mtimeMs: number; hints: TaxonomyHintEntry[] } | null = null;

/** Synchronous read of the hint list (newest first) — the prompt build path is synchronous. */
export function readTaxonomyHintsSync(): TaxonomyHintEntry[] {
  try {
    const targetFilePath = hintsFilePath();
    if (!fs.existsSync(targetFilePath)) return [];
    const stat = fs.statSync(targetFilePath);
    if (syncCache && syncCache.mtimeMs === stat.mtimeMs) return syncCache.hints;
    const parsed = JSON.parse(fs.readFileSync(targetFilePath, 'utf-8'));
    const hints = (Array.isArray(parsed) ? parsed : []).filter((h: any) => h && h.mapped_category);
    syncCache = { mtimeMs: stat.mtimeMs, hints };
    return hints;
  } catch (err) {
    logger.error('TAXONOMY_GUARD', 'Failed to read taxonomy conflict hints:', err);
    return [];
  }
}
