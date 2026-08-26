import fs from 'fs';
import { CONFIG } from './settings.js';
import { EntityDictionarySchema, EntityDictionary } from '../domain/document.schema.js';

// entity_dictionary.json is ~145KB of curated entities and nothing in the app ever writes it, yet
// getEntityDictionary() used to re-read, JSON.parse and Zod-validate the whole file on EVERY call.
// That is not a once-per-run cost: classification-resolution.ts calls it per ungrounded subcategory
// and repair-registry.ts calls it inside its per-document loop, so a 258-document repair paid the
// full parse 258 times (~6-7ms each, measured; ~0.02ms once cached).
//
// The existence probe stays fs.existsSync on purpose. Several suites auto-mock the whole fs module
// and only stub existsSync/readFileSync; probing with statSync instead made those mocks return
// undefined and silently yielded an empty dictionary, which flipped a real classification assertion
// (France Travail pay slip -> 'employeur' instead of 'france_travail'). stat is therefore used only
// to validate the cache, and when it is unavailable the code simply re-reads — the exact behavior
// this function had before the cache existed.
interface CacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  value: EntityDictionary;
}

let cache: CacheEntry | null = null;

// Exposed for tests and for any future hot-reload endpoint that needs to force a re-read.
export function clearEntityDictionaryCache(): void {
  cache = null;
}

function statOrNull(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat || typeof stat.mtimeMs !== 'number' || typeof stat.size !== 'number') return null;
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

export function getEntityDictionary(): EntityDictionary {
  const filePath = CONFIG.ENTITY_DICTIONARY_FILE;

  if (fs.existsSync(filePath)) {
    // Keyed on path + mtime + size so a dictionary edited while the server runs is picked up on the
    // next call. No stat (mocked fs, exotic filesystem) simply means "cannot prove the cache is
    // still valid", so fall through and re-read rather than serve something possibly stale.
    const stat = statOrNull(filePath);
    if (stat && cache && cache.path === filePath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.value;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const value = EntityDictionarySchema.parse(JSON.parse(raw));
      // A malformed file is deliberately never cached: it is usually a half-written save, and the
      // next call should retry rather than serve an empty dictionary for the process's lifetime.
      cache = stat ? { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, value } : null;
      return value;
    } catch (e) {
      console.error("Invalid entity_dictionary.json schema, using empty dictionary", e);
      cache = null;
    }
  } else {
    cache = null;
  }

  return EntityDictionarySchema.parse({});
}
