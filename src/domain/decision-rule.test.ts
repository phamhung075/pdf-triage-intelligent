import { describe, it, expect } from 'vitest';
import { deriveRuleKeywords, decisionsToPriorityRules, HumanDecisionLike } from './decision-rule.js';

describe('deriveRuleKeywords', () => {
  it('keeps distinctive filename codes (bank product codes, scanner prefixes) and drops years/account numbers', () => {
    const keywords = deriveRuleKeywords('STMT_CHK_101_00047_20240607.pdf', 'Relevé de chèques BNP');
    // 'stmt', 'chk' come from the filename; 'bnp' from the title (issuer name).
    expect(keywords).toContain('stmt');
    expect(keywords).toContain('chk');
    expect(keywords).toContain('bnp');
    expect(keywords.some(k => /^\d+$/.test(k))).toBe(false);
  });

  it('treats a token found in BOTH filename and title as the strongest signal and ranks it first', () => {
    const keywords = deriveRuleKeywords('NORTHWIND_2024.pdf', 'Northwind Academy — certificat de scolarité');
    expect(keywords[0]).toBe('northwind');
  });

  it('filters generic document-type words regardless of accents', () => {
    const keywords = deriveRuleKeywords('Releve_2024.pdf', 'Relevé de compte');
    expect(keywords).not.toContain('releve');
    expect(keywords).not.toContain('relevé');
    expect(keywords).not.toContain('compte');
  });

  it('keeps a scanner prefix glued to a date as ONE token', () => {
    const keywords = deriveRuleKeywords('recXX20240424.pdf', 'Récépissé de demande de titre de séjour');
    expect(keywords).toContain('recxx20240424');
    expect(keywords).not.toContain('recepisse');
    expect(keywords).not.toContain('sejour');
    expect(keywords).not.toContain('demande');
  });

  it('returns an empty array when nothing distinctive can be found', () => {
    expect(deriveRuleKeywords('document.pdf', 'Document')).toEqual([]);
  });

  it('caps the number of derived keywords', () => {
    const keywords = deriveRuleKeywords('alpha_beta_gamma_delta_epsilon.pdf', '');
    expect(keywords.length).toBeLessThanOrEqual(3);
  });
});

describe('decisionsToPriorityRules', () => {
  const base: HumanDecisionLike = {
    id: 7,
    original_filename: 'STMT_CHK_101.pdf',
    title: 'Relevé de chèques BNP',
    new_category: 'bank',
    new_subcategory: 'bnp_paribas',
    user_feedback_reason: 'This is a BNP check statement, not rent',
    enabled: 1,
  };

  it('turns an enabled decision into a STEP 0 priority rule pinning category AND subcategory', () => {
    const rules = decisionsToPriorityRules([base]);
    expect(rules).toHaveLength(1);
    expect(rules[0].category).toBe('bank');
    expect(rules[0].subcategory).toBe('bnp_paribas');
    expect(rules[0].keywords.length).toBeGreaterThan(0);
  });

  it('skips disabled decisions', () => {
    expect(decisionsToPriorityRules([{ ...base, enabled: 0 }])).toHaveLength(0);
  });

  it('skips decisions whose target subcategory is forbidden (Golden Rule #4)', () => {
    expect(decisionsToPriorityRules([{ ...base, new_subcategory: 'general' }])).toHaveLength(0);
    expect(decisionsToPriorityRules([{ ...base, new_subcategory: 'divers' }])).toHaveLength(0);
    expect(decisionsToPriorityRules([{ ...base, new_subcategory: '2024' }])).toHaveLength(0);
  });

  it('skips decisions with no target category at all', () => {
    expect(decisionsToPriorityRules([{ ...base, new_category: '' }])).toHaveLength(0);
  });

  it('derives keywords lazily for legacy records that have none stored', () => {
    const legacy = { ...base, rule_keywords: [] };
    const rules = decisionsToPriorityRules([legacy]);
    expect(rules[0].keywords.length).toBeGreaterThan(0);
    expect(rules[0].keywords).toContain('stmt');
  });

  it('uses stored keywords verbatim when present (never re-derives)', () => {
    const rules = decisionsToPriorityRules([{ ...base, rule_keywords: ['MY_CODE', 'acme'] }]);
    expect(rules[0].keywords).toEqual(['MY_CODE', 'acme']);
  });

  it('skips a decision that ends up with no usable keyword', () => {
    expect(decisionsToPriorityRules([{ ...base, original_filename: 'doc.pdf', title: 'Document', rule_keywords: [] }])).toHaveLength(0);
  });

  it('carries the human reason into the rule note (minus boilerplate), tagged with the decision id', () => {
    const rules = decisionsToPriorityRules([base]);
    expect(rules[0].note).toContain('Auto-learned from a human move');
    expect(rules[0].note).toContain('(decision #7)');
    expect(rules[0].note).toContain('This is a BNP check statement, not rent');
  });

  it('does not echo boilerplate reasons into the note', () => {
    const rules = decisionsToPriorityRules([{ ...base, user_feedback_reason: 'Manual user selection' }]);
    expect(rules[0].note).not.toContain('Manual user selection');
  });

  it('caps the number of injected rules, keeping the NEWEST decisions', () => {
    const decisions = Array.from({ length: 40 }, (_, i) => ({ ...base, id: i + 1 }));
    const rules = decisionsToPriorityRules(decisions, 10);
    expect(rules).toHaveLength(10);
    expect(rules[0].note).toContain('(decision #1)');
  });

  it('keeps rules that pin only the category when the subcategory is empty', () => {
    const rules = decisionsToPriorityRules([{ ...base, new_subcategory: '' }]);
    expect(rules).toHaveLength(1);
    expect(rules[0].subcategory).toBeUndefined();
  });
});
