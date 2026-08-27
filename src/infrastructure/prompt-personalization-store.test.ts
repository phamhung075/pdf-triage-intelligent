import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tempRoot: string;
let promptsFile: string;
let decisionsFile: string;
let dbPath: string;

// Same whole-module settings mock as the other I/O suites: everything happens in a temp dir, so
// this suite can never touch the developer's real .prompts.private.json / manual_decisions.json.
vi.mock('./settings.js', () => ({
  get DATA_DIR() { return tempRoot; },
  get CONFIG() {
    return {
      PROMPTS_PRIVATE_FILE: promptsFile,
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
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-triage-personalization-'));
  promptsFile = path.join(tempRoot, '.prompts.private.json');
  decisionsFile = path.join(tempRoot, 'manual_decisions.json');
  dbPath = path.join(tempRoot, 'pdf_triage.db');
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('prompt-personalization-store (with human decision feedback)', () => {
  it('returns an empty personalization when neither the overlay nor any decision exists', async () => {
    const { getPromptPersonalization } = await import('./prompt-personalization-store.js');
    const p = getPromptPersonalization();
    expect(p.priority_rules).toEqual([]);
    expect(p.known_entities).toEqual([]);
  });

  it('reads the hand-curated overlay unchanged when there are no decisions', async () => {
    fs.writeFileSync(promptsFile, JSON.stringify({
      known_entities: ['ACME CORP'],
      priority_rules: [{ keywords: ['STMT_CHK_'], category: 'bank', subcategory: 'my_bank' }],
    }), 'utf-8');

    const { getPromptPersonalization } = await import('./prompt-personalization-store.js');
    const p = getPromptPersonalization();
    expect(p.known_entities).toEqual(['ACME CORP']);
    expect(p.priority_rules).toEqual([{ keywords: ['STMT_CHK_'], category: 'bank', subcategory: 'my_bank' }]);
  });

  it('appends enabled human decisions as STEP 0 rules AFTER the hand-curated ones', async () => {
    fs.writeFileSync(promptsFile, JSON.stringify({
      priority_rules: [{ keywords: ['HAND_MADE'], category: 'housing', subcategory: 'my_landlord' }],
    }), 'utf-8');
    fs.writeFileSync(decisionsFile, JSON.stringify([{
      id: 3,
      document_id: 1,
      checksum: 'c',
      original_filename: 'STMT_CHK_101.pdf',
      title: 'Relevé de chèques BNP',
      old_category: 'housing',
      old_subcategory: 'northwind_realty',
      new_category: 'bank',
      new_subcategory: 'bnp_paribas',
      user_feedback_reason: 'This is a BNP check statement',
      rule_keywords: ['STMT_CHK_'],
      enabled: 1,
      created_at: '2026-01-01T00:00:00.000Z'
    }]), 'utf-8');

    const { getPromptPersonalization } = await import('./prompt-personalization-store.js');
    const p = getPromptPersonalization();

    expect(p.priority_rules).toHaveLength(2);
    expect(p.priority_rules[0].keywords).toEqual(['HAND_MADE']); // curated first → wins tie-breaks
    expect(p.priority_rules[1].keywords).toEqual(['STMT_CHK_']);
    expect(p.priority_rules[1].category).toBe('bank');
    expect(p.priority_rules[1].subcategory).toBe('bnp_paribas');
    expect(p.priority_rules[1].note).toContain('decision #3');
  });

  it('does NOT inject disabled decisions', async () => {
    fs.writeFileSync(decisionsFile, JSON.stringify([{
      id: 3,
      document_id: 1,
      checksum: 'c',
      original_filename: 'STMT_CHK_101.pdf',
      title: 'Relevé',
      old_category: 'housing',
      old_subcategory: 'northwind_realty',
      new_category: 'bank',
      new_subcategory: 'bnp_paribas',
      rule_keywords: ['STMT_CHK_'],
      enabled: 0
    }]), 'utf-8');

    const { getPromptPersonalization } = await import('./prompt-personalization-store.js');
    expect(getPromptPersonalization().priority_rules).toEqual([]);
  });

  it('derives keywords for legacy decision records that have none stored', async () => {
    fs.writeFileSync(decisionsFile, JSON.stringify([{
      id: 4,
      document_id: 1,
      checksum: 'c',
      original_filename: 'NORTHWIND_2024.pdf',
      title: 'Northwind Academy — certificat de scolarité',
      old_category: 'correspondence',
      old_subcategory: 'general',
      new_category: 'education',
      new_subcategory: 'northwind',
      enabled: 1
    }]), 'utf-8');

    const { getPromptPersonalization } = await import('./prompt-personalization-store.js');
    const p = getPromptPersonalization();
    expect(p.priority_rules).toHaveLength(1);
    expect(p.priority_rules[0].keywords).toContain('northwind');
    expect(p.priority_rules[0].category).toBe('education');
  });

  it('ignores an invalid overlay file but still merges decisions (never throws)', async () => {
    fs.writeFileSync(promptsFile, '{ not json !!!', 'utf-8');
    fs.writeFileSync(decisionsFile, JSON.stringify([{
      id: 5,
      document_id: 1,
      checksum: 'c',
      original_filename: 'BNP.pdf',
      title: 'BNP',
      new_category: 'bank',
      new_subcategory: 'bnp_paribas',
      rule_keywords: ['bnp'],
      enabled: 1
    }]), 'utf-8');

    const { getPromptPersonalization } = await import('./prompt-personalization-store.js');
    const p = getPromptPersonalization();
    expect(p.priority_rules).toHaveLength(1);
    expect(p.priority_rules[0].keywords).toEqual(['bnp']);
  });
});
