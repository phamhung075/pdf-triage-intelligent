import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { recordManualDecision, getManualDecisions } from './manual-decisions-store.js';
import { CONFIG } from './settings.js';
import { getDb } from './db/database.js';

describe('manual-decisions-store', () => {
  beforeEach(async () => {
    try { fs.writeFileSync(CONFIG.MANUAL_DECISIONS_FILE, '[]'); } catch (e) {}
    const db = await getDb();
    await db.run('DELETE FROM manual_decisions');
  });

  it('records manual decision in SQLite DB and manual_decisions.json', async () => {
    await recordManualDecision({
      document_id: 42,
      checksum: 'abc123checksum',
      original_filename: 'RLV_CHQ_001.pdf',
      title: 'Relevé de chèques BNP',
      old_category: 'housing',
      old_subcategory: 'foncia',
      new_category: 'administrative',
      new_subcategory: 'bnp_paribas',
      user_feedback_reason: 'This is a BNP check statement, not Foncia rent',
      raw_text_snippet: 'BNP PARIBAS RELEVE DE CHEQUES'
    });

    const decisions = await getManualDecisions();
    expect(decisions.length).toBe(1);
    expect(decisions[0].document_id).toBe(42);
    expect(decisions[0].old_category).toBe('housing');
    expect(decisions[0].old_subcategory).toBe('foncia');
    expect(decisions[0].new_category).toBe('administrative');
    expect(decisions[0].new_subcategory).toBe('bnp_paribas');
    expect(decisions[0].user_feedback_reason).toBe('This is a BNP check statement, not Foncia rent');

    expect(fs.existsSync(CONFIG.MANUAL_DECISIONS_FILE)).toBe(true);
    const jsonContent = JSON.parse(fs.readFileSync(CONFIG.MANUAL_DECISIONS_FILE, 'utf-8'));
    expect(jsonContent.length).toBe(1);
    expect(jsonContent[0].new_subcategory).toBe('bnp_paribas');
  });
});
