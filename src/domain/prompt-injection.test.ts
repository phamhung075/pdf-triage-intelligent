import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PromptPersonalization } from './prompt-personalization.js';

// The personalization overlay is read from a gitignored file whose presence differs between a
// developer's machine and a fresh clone, so it is mocked here to pin BOTH paths deterministically:
// personalized and not. The rendering itself is covered in prompt-personalization.test.ts.
const personalization = vi.hoisted(() => ({ current: null as PromptPersonalization | null }));

vi.mock('../infrastructure/prompt-personalization-store.js', async () => {
  const { EMPTY_PROMPT_PERSONALIZATION } = await import('./prompt-personalization.js');
  return {
    getPromptPersonalization: () => personalization.current ?? EMPTY_PROMPT_PERSONALIZATION,
  };
});

const { buildClassificationPrompt, buildEntityExtractionPrompt } = await import('./prompt.js');
const { PromptPersonalizationSchema } = await import('./prompt-personalization.js');

describe('personal prompt overlay injection', () => {
  beforeEach(() => {
    personalization.current = null;
  });

  it('injects the user priority rules as a STEP 0 ahead of the generic STEP 1 flow', () => {
    personalization.current = PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: ['MYCODE_42'], category: 'bank', subcategory: 'my_bank' }],
    });
    const { system } = buildClassificationPrompt('categories', 'doc.pdf', 'text');

    expect(system).toContain('MYCODE_42');
    // A strict-order decision flow means an override appended after STEP 13 would never fire for
    // the document types it exists to catch — assert it really precedes STEP 1.
    expect(system.indexOf('STEP 0: USER-SPECIFIC HIGH-PRIORITY OVERRIDES')).toBeGreaterThan(-1);
    expect(system.indexOf('STEP 0: USER-SPECIFIC HIGH-PRIORITY OVERRIDES')).toBeLessThan(system.indexOf('STEP 1: BANK STATEMENTS'));
  });

  it('injects the known entities into the Step A entity-extraction prompt', () => {
    personalization.current = PromptPersonalizationSchema.parse({
      known_entities: ['ACME CONSEIL'],
    });
    const { user } = buildEntityExtractionPrompt('doc.pdf', 'some document text');
    expect(user).toContain('ACME CONSEIL');
  });

  it('leaves no unresolved {{USER_*}} placeholder when there is no personalization at all', () => {
    const { system, user } = buildClassificationPrompt('categories', 'doc.pdf', 'text');
    const entity = buildEntityExtractionPrompt('doc.pdf', 'text');

    for (const rendered of [system, user, entity.system, entity.user]) {
      expect(rendered).not.toMatch(/\{\{USER_[A-Z_]+\}\}/);
    }
  });

  it('keeps the generic flow intact when there is no personalization — STEP 1 still leads', () => {
    const { system } = buildClassificationPrompt('categories', 'doc.pdf', 'text');
    expect(system).not.toContain('STEP 0');
    expect(system).toContain('STEP 1: BANK STATEMENTS');
  });
});
