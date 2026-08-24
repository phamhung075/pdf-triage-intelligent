import { describe, it, expect } from 'vitest';
import {
  DocumentMetadataSchema,
  SystemSettingsSchema,
  CategoriesConfigSchema,
  EntityDictionarySchema,
  UpdateDocumentSchema,
  SearchQuerySchema,
} from './document.schema.js';

describe('DocumentMetadataSchema', () => {
  it('parses a fully-populated valid object unchanged', () => {
    const input = {
      titre: 'Facture SFR', registre: 'REF-1', date: '2024-05-12',
      categorie: 'invoices', subcategorie: 'sfr', summary: 'A vendor invoice',
      tags: ['sfr', 'invoice'], markdown_content: '# Facture',
    };
    expect(DocumentMetadataSchema.parse(input)).toMatchObject(input);
  });

  it('rejects a missing titre', () => {
    expect(() => DocumentMetadataSchema.parse({ categorie: 'invoices' })).toThrow();
  });

  it('rejects a missing categorie', () => {
    expect(() => DocumentMetadataSchema.parse({ titre: 'Test' })).toThrow();
  });

  it('defaults optional fields when omitted', () => {
    const result = DocumentMetadataSchema.parse({ titre: 'Test', categorie: 'administrative' });
    expect(result.registre).toBe('');
    expect(result.date).toBe('');
    expect(result.subcategorie).toBe('');
    expect(result.summary).toBe('');
    expect(result.tags).toEqual([]);
    expect(result.markdown_content).toBe('');
    expect(result.other).toEqual({});
  });

  // Regression test: Qwen frequently returns an explicit JSON `null` (not an absent key) for a
  // field that doesn't apply to this document type (e.g. expiry_date on a bank statement, iban
  // on a payslip). Before the nullableOptionalString fix, this threw "Expected string, received
  // null" out of DocumentMetadataSchema.parse(), which classify-document.ts's catch block turned
  // into a silent downgrade to the generic rule-based fallback classifier for the whole document
  // — confirmed against a real production log entry for a BNP Paribas bank statement.
  it('normalizes an explicit null on an optional string field to "" instead of throwing', () => {
    const input = {
      titre: 'Relevé de compte', categorie: 'bank',
      total_amount: null, vat_amount: null, siren: null, iban: null, expiry_date: null,
      contact_name: null, contact_email: null, contact_phone: null,
      contact_address: null, contact_website: null,
    };
    const result = DocumentMetadataSchema.parse(input);
    expect(result.total_amount).toBe('');
    expect(result.vat_amount).toBe('');
    expect(result.siren).toBe('');
    expect(result.iban).toBe('');
    expect(result.expiry_date).toBe('');
    expect(result.contact_name).toBe('');
    expect(result.contact_email).toBe('');
    expect(result.contact_phone).toBe('');
    expect(result.contact_address).toBe('');
    expect(result.contact_website).toBe('');
  });

  it('still accepts a real string value on those same fields', () => {
    const result = DocumentMetadataSchema.parse({
      titre: 'Facture', categorie: 'invoices', iban: 'FR7630001007941234567890185', expiry_date: '2027-01-01',
    });
    expect(result.iban).toBe('FR7630001007941234567890185');
    expect(result.expiry_date).toBe('2027-01-01');
  });
});

describe('SystemSettingsSchema', () => {
  it('accepts qwen3.5:9b as ollama_model', () => {
    const input = {
      input_dir: '/in', output_root_dir: '/out',
      ollama_model: 'qwen3.5:9b', ollama_host: 'http://127.0.0.1:11434',
    };
    expect(SystemSettingsSchema.parse(input)).toMatchObject(input);
  });

  it('rejects any ollama_model other than qwen3.5:9b (Golden Rule #14)', () => {
    const input = {
      input_dir: '/in', output_root_dir: '/out',
      ollama_model: 'llama3', ollama_host: 'http://127.0.0.1:11434',
    };
    expect(() => SystemSettingsSchema.parse(input)).toThrow();
  });

  it('rejects a missing input_dir', () => {
    const input = { output_root_dir: '/out', ollama_model: 'qwen3.5:9b', ollama_host: 'h' };
    expect(() => SystemSettingsSchema.parse(input)).toThrow();
  });
});

describe('CategoriesConfigSchema', () => {
  it('parses nested subcategories recursively', () => {
    const input = {
      categories: [
        {
          id: 'invoices', name: 'Factures', aliases: ['facture'],
          subcategories: [
            { id: 'sfr', name: 'SFR', aliases: [], subcategories: [{ id: 'sfr_mobile', name: 'SFR Mobile' }] },
          ],
        },
      ],
    };
    const result = CategoriesConfigSchema.parse(input);
    expect(result.categories[0]?.subcategories?.[0]?.subcategories?.[0]?.id).toBe('sfr_mobile');
  });

  it('rejects a category with no id', () => {
    expect(() =>
      CategoriesConfigSchema.parse({ categories: [{ name: 'Factures' }] })
    ).toThrow();
  });
});

describe('EntityDictionarySchema', () => {
  it('defaults missing domains to empty arrays', () => {
    const result = EntityDictionarySchema.parse({ banks: [{ slug: 'ca', name: 'Crédit Agricole' }] });
    expect(result.banks).toHaveLength(1);
    expect(result.energy).toEqual([]);
    expect(result.telecom).toEqual([]);
    expect(result.insurance).toEqual([]);
    expect(result.gov).toEqual([]);
    expect(result.health).toEqual([]);
  });

  it('defaults an entity item aliases to an empty array when omitted', () => {
    const result = EntityDictionarySchema.parse({ banks: [{ slug: 'ca', name: 'Crédit Agricole' }] });
    expect(result.banks[0].aliases).toEqual([]);
  });
});

describe('UpdateDocumentSchema', () => {
  it('accepts a partial update with only some fields set', () => {
    const result = UpdateDocumentSchema.parse({ title: 'New Title', tags: ['a', 'b'] });
    expect(result.title).toBe('New Title');
    expect(result.tags).toEqual(['a', 'b']);
    expect(result.category).toBeUndefined();
  });

  it('accepts an empty object (every field optional)', () => {
    expect(() => UpdateDocumentSchema.parse({})).not.toThrow();
  });
});

describe('SearchQuerySchema', () => {
  it('defaults query to "", mode to "hybrid", limit to 50 when omitted', () => {
    const result = SearchQuerySchema.parse({});
    expect(result.query).toBe('');
    expect(result.mode).toBe('hybrid');
    expect(result.limit).toBe(50);
  });

  it('rejects an invalid mode value', () => {
    expect(() => SearchQuerySchema.parse({ mode: 'fuzzy' })).toThrow();
  });

  it('rejects a non-positive limit', () => {
    expect(() => SearchQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => SearchQuerySchema.parse({ limit: -5 })).toThrow();
  });
});
