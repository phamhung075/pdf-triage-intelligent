import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildClassificationPrompt, buildMarkdownConversionPrompt, ILLEGIBLE_FRAGMENT_MARKER } from './prompt.js';

describe('buildClassificationPrompt', () => {
  it('embeds the categories description string into the system prompt', () => {
    const { system } = buildClassificationPrompt('- Category invoices: bills', 'facture.pdf', 'some text');
    expect(system).toContain('- Category invoices: bills');
  });

  it('truncates document text over 4000 chars in the user prompt, with an ellipsis', () => {
    const longText = 'a'.repeat(5000);
    const { user } = buildClassificationPrompt('categories', 'doc.pdf', longText);
    expect(user).toContain('a'.repeat(4000) + '...');
    expect(user).not.toContain('a'.repeat(4001));
  });

  it('does not truncate document text at or under 4000 chars', () => {
    const shortText = 'b'.repeat(4000);
    const { user } = buildClassificationPrompt('categories', 'doc.pdf', shortText);
    expect(user).toContain(shortText);
    expect(user).not.toContain('...');
  });

  it('includes the filename in the user prompt', () => {
    const { user } = buildClassificationPrompt('categories', 'my_invoice.pdf', 'text');
    expect(user).toContain('Filename: my_invoice.pdf');
  });

  it('appends the previous-error feedback block only when previousError is provided', () => {
    const withoutError = buildClassificationPrompt('categories', 'doc.pdf', 'text');
    expect(withoutError.user).not.toContain('PREVIOUS ATTEMPT FEEDBACK');

    const withError = buildClassificationPrompt('categories', 'doc.pdf', 'text', 'subcategory was ungrounded');
    expect(withError.user).toContain('PREVIOUS ATTEMPT FEEDBACK');
    expect(withError.user).toContain('subcategory was ungrounded');
  });

  it('appends an explicit, prioritized entity-hint block only when entityHint.entity is provided', () => {
    const withoutHint = buildClassificationPrompt('categories', 'doc.pdf', 'text');
    expect(withoutHint.user).not.toContain('PRE-EXTRACTED ENTITY HINT');

    const withHint = buildClassificationPrompt('categories', 'doc.pdf', 'text', undefined, 'FR', { entity: 'Crédit Mutuel', docType: 'Bank Statement' });
    expect(withHint.user).toContain('PRE-EXTRACTED ENTITY HINT');
    expect(withHint.user).toContain('Crédit Mutuel');
    expect(withHint.user).toContain('Bank Statement');
    expect(withHint.user).toContain('GROUND TRUTH');
  });

  it('omits the entity-hint block when entityHint.entity is an empty string', () => {
    const { user } = buildClassificationPrompt('categories', 'doc.pdf', 'text', undefined, 'FR', { entity: '' });
    expect(user).not.toContain('PRE-EXTRACTED ENTITY HINT');
  });

  it('instructs the model not to confuse the document\'s own "date" with a validity/expiry date found elsewhere in the text', () => {
    const { system } = buildClassificationPrompt('categories', 'doc.pdf', 'text');
    expect(system).toMatch(/DATE vs EXPIRY_DATE/);
    expect(system).toMatch(/never let the expiry\/validity date silently overwrite "date"/);
  });

  it('injects the current date into the formatting rules so Step D can guard against future-dated OCR misreads', () => {
    const now = new Date('2026-08-12T00:00:00');
    const { system } = buildClassificationPrompt('categories', 'doc.pdf', 'text', undefined, 'FR', undefined, now);
    expect(system).toContain('Today\'s date is 2026-08-12');
    expect(system).not.toContain('{{CURRENT_DATE}}');
  });

  it('no longer requests a markdown_content JSON key from Step D (Step C already produces it) — the lang instruction only mentions titre/summary', () => {
    const { system } = buildClassificationPrompt('categories', 'doc.pdf', 'text');
    // The FR/EN lang instruction must not tell the model to generate markdown_content.
    expect(system).not.toMatch(/Generate the output.*markdown_content|Générez.*markdown_content/);

    // The JSON schema example itself must no longer declare a markdown_content key.
    const schemaPath = path.join(process.cwd(), 'prompts', 'json_schema_response.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    expect(schema).not.toHaveProperty('markdown_content');
  });
});

describe('buildMarkdownConversionPrompt', () => {
  it('instructs the model to preserve illegible fragments near-verbatim instead of fabricating recognized-template content (Problem A safety net)', () => {
    const { user } = buildMarkdownConversionPrompt('some garbled chunk');
    expect(user).toContain('NEVER FABRICATE FROM PATTERN-RECOGNITION');
    expect(user).toContain('does not resolve into coherent words in ANY language');
    expect(user).toContain(ILLEGIBLE_FRAGMENT_MARKER);
    // The rule must explicitly say recognizing a doc TYPE isn't license to invent its usual values.
    expect(user).toMatch(/not license to fabricate/i);
  });

  it('includes the raw chunk text in the user prompt', () => {
    const { user } = buildMarkdownConversionPrompt('BANG cAN oor xf roAN garbled OCR noise');
    expect(user).toContain('BANG cAN oor xf roAN garbled OCR noise');
  });

  it('omits any continuation-context block when no continuation context is passed', () => {
    // Rule 3's own text forward-references "CONTINUATION CONTEXT note below, if present" (it's
    // always in the template), so assert on the actually-injected block's distinct wording instead.
    const { user } = buildMarkdownConversionPrompt('some chunk text');
    expect(user).not.toContain('⚠️ CONTINUATION CONTEXT:');
    expect(user).not.toContain('ended mid-table');
  });

  it('injects an explicit continuation-context block instructing the model to continue the open table without repeating the header (Problem B)', () => {
    const { user } = buildMarkdownConversionPrompt('100.00 | 200.00 | food', {
      header: '| Date | Amount | Label |',
      separator: '| --- | --- | --- |',
    });
    expect(user).toContain('⚠️ CONTINUATION CONTEXT:');
    expect(user).toContain('| Date | Amount | Label |');
    expect(user).toContain('| --- | --- | --- |');
    expect(user).toMatch(/do NOT repeat the header\/separator row/i);
    expect(user).toMatch(/do NOT start a new table/i);
  });

  it('does not inject continuation context when header is an empty string', () => {
    const { user } = buildMarkdownConversionPrompt('some chunk text', { header: '', separator: '' });
    expect(user).not.toContain('⚠️ CONTINUATION CONTEXT:');
  });
});
