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
