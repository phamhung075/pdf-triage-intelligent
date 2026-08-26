import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tempRoot: string;
let decisionsFile: string;
let dbPath: string;

// This suite used to run against the REAL CONFIG: it wrote '[]' over the developer's actual
// manual_decisions.json and ran `DELETE FROM manual_decisions` on the production pdf_triage.db on
// every `npm test`. The user's entire feedback log — the input to the feedback-teaches-AI loop,
// Golden Rule #18 — was destroyed by running the test suite, and what survived was this file's own
// fixture. Same whole-module settings mock the other I/O suites use (see relocalize-document.test.ts),
// so everything below now happens inside a temp directory.
vi.mock('./settings.js', () => ({
  get DATA_DIR() { return tempRoot; },
  get CONFIG() {
    return {
      MANUAL_DECISIONS_FILE: decisionsFile,
      DB_PATH: dbPath,
      INPUT_DIR: path.join(tempRoot, '__raws'),
      OUTPUT_ROOT_DIR: path.join(tempRoot, '__archive'),
      PERSONAL_NAME_DENYLIST: [] as string[],
    };
  },
}));

beforeEach(() => {
  vi.resetModules();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-triage-decisions-'));
  decisionsFile = path.join(tempRoot, 'manual_decisions.json');
  dbPath = path.join(tempRoot, 'pdf_triage.db');
});

afterEach(async () => {
  try {
    const { getDb } = await import('./db/database.js');
    const db = await getDb();
    await db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('manual-decisions-store', () => {
  it('records manual decision in SQLite DB and manual_decisions.json', async () => {
    const { recordManualDecision, getManualDecisions } = await import('./manual-decisions-store.js');

    await recordManualDecision({
      document_id: 42,
      checksum: 'abc123checksum',
      original_filename: 'RLV_CHQ_001.pdf',
      title: 'Relevé de chèques BNP',
      old_category: 'housing',
      old_subcategory: 'northwind_realty',
      new_category: 'administrative',
      new_subcategory: 'bnp_paribas',
      user_feedback_reason: 'This is a BNP check statement, not Northwind Realty rent',
      raw_text_snippet: 'BNP PARIBAS RELEVE DE CHEQUES'
    });

    const decisions = await getManualDecisions();
    expect(decisions.length).toBe(1);
    expect(decisions[0].document_id).toBe(42);
    expect(decisions[0].old_category).toBe('housing');
    expect(decisions[0].old_subcategory).toBe('northwind_realty');
    expect(decisions[0].new_category).toBe('administrative');
    expect(decisions[0].new_subcategory).toBe('bnp_paribas');
    expect(decisions[0].user_feedback_reason).toBe('This is a BNP check statement, not Northwind Realty rent');

    expect(fs.existsSync(decisionsFile)).toBe(true);
    const jsonContent = JSON.parse(fs.readFileSync(decisionsFile, 'utf-8'));
    expect(jsonContent.length).toBe(1);
    expect(jsonContent[0].new_subcategory).toBe('bnp_paribas');
  });

  it('writes nowhere at all when the decisions path is not configured', async () => {
    // The store used to fall back to the RELATIVE path 'manual_decisions.json', which resolves
    // against process.cwd() — so any caller holding an incomplete CONFIG (a test mocking settings.js
    // without this key) silently appended to the real file in the repo root. That is how two
    // unrelated suites started corrupting each other's data, intermittently and invisibly.
    decisionsFile = undefined as unknown as string;
    const before = fs.readdirSync(process.cwd());

    const { recordManualDecision } = await import('./manual-decisions-store.js');
    await expect(recordManualDecision({
      document_id: 1,
      checksum: 'c',
      original_filename: 'f.pdf',
      title: 't',
      old_category: 'a',
      old_subcategory: 'b',
      new_category: 'c',
      new_subcategory: 'd',
      user_feedback_reason: 'r',
      raw_text_snippet: 's'
    })).resolves.not.toThrow(); // both call sites catch and log — a bad config must not crash triage

    expect(fs.readdirSync(process.cwd())).toEqual(before);
  });
});
