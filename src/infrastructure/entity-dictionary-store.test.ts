import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tempDir: string;
let entityFile: string;

// Same rationale as categories-store.test.ts: ENTITY_DICTIONARY_FILE is hardcoded off
// BASE_DIR in the real settings.ts, so this must be redirected to a temp path rather
// than touching the real project's entity_dictionary.json (1044 real French entities).
vi.mock('./settings.js', () => ({
  get CONFIG() { return { ENTITY_DICTIONARY_FILE: entityFile }; },
}));

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-dict-test-'));
  entityFile = path.join(tempDir, 'entity_dictionary.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function fresh() {
  vi.resetModules();
  return import('./entity-dictionary-store.js');
}

describe('getEntityDictionary', () => {
  it('returns an empty (schema-defaulted) dictionary when entity_dictionary.json does not exist', async () => {
    const { getEntityDictionary } = await fresh();
    const dict = getEntityDictionary();
    expect(dict).toEqual({ banks: [], energy: [], telecom: [], insurance: [], gov: [], health: [] });
  });

  it('returns the parsed content when the file exists and is valid', async () => {
    fs.writeFileSync(entityFile, JSON.stringify({
      banks: [{ slug: 'credit_mutuel', name: 'Credit Mutuel', aliases: ['cm'] }],
    }));
    const { getEntityDictionary } = await fresh();
    const dict = getEntityDictionary();
    expect(dict.banks).toEqual([{ slug: 'credit_mutuel', name: 'Credit Mutuel', aliases: ['cm'] }]);
    expect(dict.energy).toEqual([]); // schema default for the omitted key
  });

  it('falls back to an empty dictionary when the file contains malformed JSON', async () => {
    fs.writeFileSync(entityFile, '{not valid json');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getEntityDictionary } = await fresh();
    expect(getEntityDictionary()).toEqual({ banks: [], energy: [], telecom: [], insurance: [], gov: [], health: [] });
    consoleErrorSpy.mockRestore();
  });

  it('falls back to an empty dictionary when an entity entry fails schema validation', async () => {
    fs.writeFileSync(entityFile, JSON.stringify({ banks: [{ name: 'Missing slug field' }] }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getEntityDictionary } = await fresh();
    expect(getEntityDictionary()).toEqual({ banks: [], energy: [], telecom: [], insurance: [], gov: [], health: [] });
    consoleErrorSpy.mockRestore();
  });
});
