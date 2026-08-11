import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildClassificationPrompt } from './prompt.js';

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
