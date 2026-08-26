import { describe, it, expect } from 'vitest';
import {
  PromptPersonalizationSchema,
  EMPTY_PROMPT_PERSONALIZATION,
  renderPriorityRulesBlock,
  renderKnownEntitiesBlock,
  matchPriorityRules,
} from './prompt-personalization.js';

describe('PromptPersonalizationSchema', () => {
  it('parses an empty object into fully-defaulted empty collections', () => {
    const parsed = PromptPersonalizationSchema.parse({});
    expect(parsed.known_entities).toEqual([]);
    expect(parsed.priority_rules).toEqual([]);
    expect(parsed.extra_rules_text).toBe('');
  });

  it('rejects a priority rule with no keywords — a rule that matches nothing is a config mistake, not an empty rule', () => {
    expect(() => PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: [], category: 'bank' }],
    })).toThrow();
  });

  it('rejects a priority rule with no category', () => {
    expect(() => PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: ['STMT_CHK_'] }],
    })).toThrow();
  });

  it('accepts a rule that pins only the category, leaving the subcategory to entity resolution', () => {
    const parsed = PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: ['MY_CODE'], category: 'bank' }],
    });
    expect(parsed.priority_rules[0].subcategory).toBeUndefined();
  });
});

describe('renderPriorityRulesBlock', () => {
  it('renders nothing at all when there is no personalization — the placeholder must vanish cleanly', () => {
    expect(renderPriorityRulesBlock(EMPTY_PROMPT_PERSONALIZATION)).toBe('');
  });

  it('renders a STEP 0 override block placed before the generic STEP 1 flow', () => {
    const block = renderPriorityRulesBlock(PromptPersonalizationSchema.parse({
      priority_rules: [
        { keywords: ['STMT_CHK_', 'C/C MYPRODUCT'], category: 'bank', subcategory: 'my_bank' },
      ],
    }));
    expect(block).toContain('STEP 0: USER-SPECIFIC HIGH-PRIORITY OVERRIDES (EVALUATE BEFORE STEP 1)');
    expect(block).toContain('"STMT_CHK_", "C/C MYPRODUCT"');
    expect(block).toContain("Category = 'bank', Subcategory = 'my_bank'");
  });

  it('tells the model to resolve the subcategory itself when a rule pins only the category', () => {
    const block = renderPriorityRulesBlock(PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: ['BCTC'], category: 'administrative' }],
    }));
    expect(block).toContain("Category = 'administrative' (resolve the Subcategory from the issuing entity as usual)");
    expect(block).not.toContain('Subcategory = \'\'');
  });

  it('appends a per-rule note when one is given', () => {
    const block = renderPriorityRulesBlock(PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: ['recXX'], category: 'identity', subcategory: 'recipisse_sejour', note: 'Scan filename prefix only.' }],
    }));
    expect(block).toContain('Scan filename prefix only.');
  });

  it('injects extra_rules_text verbatim even when there are no structured rules', () => {
    const block = renderPriorityRulesBlock(PromptPersonalizationSchema.parse({
      extra_rules_text: '- NEVER file my landlord statements under invoices.',
    }));
    expect(block).toContain('- NEVER file my landlord statements under invoices.');
    expect(block).toContain('STEP 0');
  });

  it('ignores rules whose keywords are all blank rather than emitting an unmatchable rule line', () => {
    const block = renderPriorityRulesBlock(PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: ['   '], category: 'bank', subcategory: 'x' }],
    }));
    expect(block).toBe('');
  });
});

describe('renderKnownEntitiesBlock', () => {
  it('renders nothing when no entities are configured', () => {
    expect(renderKnownEntitiesBlock(EMPTY_PROMPT_PERSONALIZATION)).toBe('');
  });

  it('lists the entities and forbids forcing a match the text does not support', () => {
    const block = renderKnownEntitiesBlock(PromptPersonalizationSchema.parse({
      known_entities: ['ACME CONSEIL', 'Lakeside Dental'],
    }));
    expect(block).toContain('"ACME CONSEIL", "Lakeside Dental"');
    expect(block).toMatch(/never force one that the text does not actually contain/i);
  });

  it('drops blank entries instead of emitting empty quoted slots', () => {
    const block = renderKnownEntitiesBlock(PromptPersonalizationSchema.parse({
      known_entities: ['ACME CONSEIL', '  ', ''],
    }));
    expect(block).toContain('"ACME CONSEIL"');
    expect(block).not.toContain('""');
  });
});

describe('matchPriorityRules', () => {
  const overlay = PromptPersonalizationSchema.parse({
    priority_rules: [
      { keywords: ['STMT_CHK_', 'C/C MYPRODUCT'], category: 'bank', subcategory: 'my_bank' },
      { keywords: ['GAN'], category: 'health', subcategory: 'my_mutuelle' },
      { keywords: ['Northwind Academy'], category: 'education', subcategory: 'northwind' },
      { keywords: ['DEFERRED'], category: 'invoices' },
    ],
  });

  it('returns null when there is no personalization', () => {
    expect(matchPriorityRules('anything at all', EMPTY_PROMPT_PERSONALIZATION)).toBeNull();
  });

  it('matches a prefix-style statement code immediately followed by the rest of the filename', () => {
    // The trailing boundary is deliberately dropped for keywords ending in a separator —
    // "stmt_chk_" is always glued to the account number that follows it.
    const hit = matchPriorityRules('stmt_chk_101_00047_20240607.pdf releve de cheques', overlay);
    expect(hit).toEqual({ categorie: 'bank', subcategorie: 'my_bank', keyword: 'stmt_chk_' });
  });

  it('matches a keyword containing regex metacharacters literally', () => {
    const hit = matchPriorityRules('releve de compte c/c myproduct solde crediteur', overlay);
    expect(hit?.subcategorie).toBe('my_bank');
  });

  it('does not match a short keyword occurring inside a longer word', () => {
    // "gan" must not fire on "organization" — the classic substring-matching bug.
    expect(matchPriorityRules('this government organization issued it', overlay)).toBeNull();
  });

  it('matches a short keyword standing on its own', () => {
    expect(matchPriorityRules('mutuelle gan remboursement soins', overlay)?.subcategorie).toBe('my_mutuelle');
  });

  it('matches a keyword glued to a trailing date or account number', () => {
    // Scan prefixes and statement codes are written this way in practice
    // ("recXX20240424", "STMT_CHK_101"), so the boundary must exclude letters, not digits.
    const glued = PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: ['recXX'], category: 'identity', subcategory: 'recipisse' }],
    });
    expect(matchPriorityRules('recxx20240424.pdf', glued)?.subcategorie).toBe('recipisse');
  });

  it('still refuses to match a keyword glued to trailing LETTERS', () => {
    const glued = PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: ['NORTHWIND'], category: 'education', subcategory: 'northwind' }],
    });
    expect(matchPriorityRules('a northwinds gale', glued)).toBeNull();
  });

  it('matches a multi-word entity name', () => {
    expect(matchPriorityRules('northwind academy certificat de scolarite', overlay)?.subcategorie).toBe('northwind');
  });

  it('skips a rule that defers subcategory resolution — a regex classifier has nothing to act on', () => {
    expect(matchPriorityRules('this mentions DEFERRED explicitly', overlay)).toBeNull();
  });

  it('returns the first matching rule in file order, so ordering is the tie-break', () => {
    const both = PromptPersonalizationSchema.parse({
      priority_rules: [
        { keywords: ['shared'], category: 'bank', subcategory: 'first' },
        { keywords: ['shared'], category: 'health', subcategory: 'second' },
      ],
    });
    expect(matchPriorityRules('a shared token', both)?.subcategorie).toBe('first');
  });
});
