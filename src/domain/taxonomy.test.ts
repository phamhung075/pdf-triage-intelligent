import { describe, it, expect } from 'vitest';
import path from 'path';
import { isYearString, isForbiddenSubcategory, computeCanonicalPath, findCanonicalCategoryForSubcategory, mergeSubcategoryInTaxonomy } from './taxonomy.js';

const TEST_OUTPUT_ROOT = 'C:\\test-archive';

describe('isYearString', () => {
  it('accepts a plain 4-digit year', () => {
    expect(isYearString('2023')).toBe(true);
  });

  it('accepts a 4-digit year with surrounding whitespace', () => {
    expect(isYearString('  2023  ')).toBe(true);
  });

  it('rejects a 5-digit number', () => {
    expect(isYearString('20233')).toBe(false);
  });

  it('rejects non-numeric text', () => {
    expect(isYearString('abcd')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isYearString(undefined)).toBe(false);
  });
});

describe('isForbiddenSubcategory', () => {
  it('forbids "general", "other", "divers" case-insensitively', () => {
    expect(isForbiddenSubcategory('general')).toBe(true);
    expect(isForbiddenSubcategory('GENERAL')).toBe(true);
    expect(isForbiddenSubcategory('other')).toBe(true);
    expect(isForbiddenSubcategory('divers')).toBe(true);
  });

  it('forbids a bare year string', () => {
    expect(isForbiddenSubcategory('2023')).toBe(true);
  });

  it('forbids undefined and empty string', () => {
    expect(isForbiddenSubcategory(undefined)).toBe(true);
    expect(isForbiddenSubcategory('')).toBe(true);
    expect(isForbiddenSubcategory('   ')).toBe(true);
  });

  it('allows a real, specific subcategory slug', () => {
    expect(isForbiddenSubcategory('sfr')).toBe(false);
    expect(isForbiddenSubcategory('credit_mutuel')).toBe(false);
  });
});

describe('computeCanonicalPath', () => {
  it('builds category/subcategory/year/filename under outputRootDir', () => {
    const result = computeCanonicalPath('C:\\raws\\facture.pdf', 'invoices', TEST_OUTPUT_ROOT, 'sfr', '2024-05-12');
    expect(result).toBe(path.join(TEST_OUTPUT_ROOT, 'invoices', 'sfr', '2024', 'facture.pdf'));
  });

  it('falls back to the current year when dateStr has no 20xx year', () => {
    const result = computeCanonicalPath('C:\\raws\\facture.pdf', 'invoices', TEST_OUTPUT_ROOT, 'sfr', undefined);
    const currentYear = new Date().getFullYear().toString();
    expect(result).toBe(path.join(TEST_OUTPUT_ROOT, 'invoices', 'sfr', currentYear, 'facture.pdf'));
  });

  it('coerces a bare-year subcategory to "general" instead of nesting under a year folder', () => {
    const result = computeCanonicalPath('C:\\raws\\doc.pdf', 'administrative', TEST_OUTPUT_ROOT, '2023', '2024-01-01');
    expect(result).toBe(path.join(TEST_OUTPUT_ROOT, 'administrative', 'general', '2024', 'doc.pdf'));
  });

  it('defaults an empty category to "other" and empty subcategory to "general"', () => {
    const result = computeCanonicalPath('C:\\raws\\doc.pdf', '', TEST_OUTPUT_ROOT, '', '2024-01-01');
    expect(result).toBe(path.join(TEST_OUTPUT_ROOT, 'other', 'general', '2024', 'doc.pdf'));
  });

  it('splits a subcategory containing a slash into nested path segments', () => {
    const result = computeCanonicalPath('C:\\raws\\doc.pdf', 'invoices', TEST_OUTPUT_ROOT, 'foo/bar', '2024-01-01');
    expect(result).toBe(path.join(TEST_OUTPUT_ROOT, 'invoices', 'foo', 'bar', '2024', 'doc.pdf'));
  });
});

// repair-registry.ts:121 uses this to decide whether a document's category is "wrong", then
// overwrites the DB row and hands the new category to relocalizeFileIfNeeded, which PHYSICALLY
// MOVES the file. The lookup returned the first category containing the slug *by array position*,
// and the live taxonomy has 42 subcategory slugs sitting under more than one category — so a
// Repair run would have relocated 87 of 276 archived documents into a category nobody chose:
// payslips filed under bulletin_salaire/clinic_x moved to contracts/clinic_x,
// identity/permis_conduire moved to administrative, and so on. Ambiguity must never be resolved
// by array order.
describe('findCanonicalCategoryForSubcategory', () => {
  const config = {
    categories: [
      { id: 'contracts', subcategories: [{ id: 'clinic_x' }, { id: 'acme' }] },
      { id: 'bulletin_salaire', subcategories: [{ id: 'clinic_x' }] },
      { id: 'health', subcategories: [{ id: 'clinic_x' }, { id: 'ameli' }] },
      { id: 'invoices', subcategories: [{ id: 'engie' }] },
    ],
  };

  it('resolves a slug that belongs to exactly one category', () => {
    expect(findCanonicalCategoryForSubcategory('engie', config)).toBe('invoices');
    expect(findCanonicalCategoryForSubcategory('ameli', config)).toBe('health');
  });

  it('returns null for an unknown slug', () => {
    expect(findCanonicalCategoryForSubcategory('not_a_real_slug', config)).toBeNull();
  });

  it('returns null for a forbidden slug rather than resolving it', () => {
    expect(findCanonicalCategoryForSubcategory('general', config)).toBeNull();
    expect(findCanonicalCategoryForSubcategory('2024', config)).toBeNull();
  });

  it('refuses to pick a winner when the slug exists under several categories', () => {
    // 'clinic_x' is under contracts, bulletin_salaire and health. Array order previously made
    // 'contracts' win and dragged every payslip with it.
    expect(findCanonicalCategoryForSubcategory('clinic_x', config)).toBeNull();
  });

  it('keeps the document where it is when its current category is one of the candidates', () => {
    expect(findCanonicalCategoryForSubcategory('clinic_x', config, 'bulletin_salaire')).toBe('bulletin_salaire');
    expect(findCanonicalCategoryForSubcategory('clinic_x', config, 'health')).toBe('health');
  });

  it('still returns null for an ambiguous slug when the current category is not a candidate', () => {
    expect(findCanonicalCategoryForSubcategory('clinic_x', config, 'invoices')).toBeNull();
  });

  it('still corrects a genuinely misfiled document when the slug is unambiguous', () => {
    expect(findCanonicalCategoryForSubcategory('engie', config, 'correspondence')).toBe('invoices');
  });
});

describe('mergeSubcategoryInTaxonomy', () => {
  const build = () => ([
    {
      id: 'invoices',
      subcategories: [
        { id: 'bouyguestelecom', name: 'Bouyguestelecom', aliases: ['bouyguestelecom'] },
        { id: 'bouygues_telecom', name: 'Bouygues Telecom', aliases: ['bouygues_telecom'] },
        { id: 'engie', name: 'Engie', aliases: ['engie'] },
      ],
    },
  ]);

  it('merges into an existing target without leaving a duplicate id', () => {
    const cats = mergeSubcategoryInTaxonomy(build(), 'invoices', 'bouyguestelecom', 'bouygues_telecom');
    const subs = cats[0].subcategories;
    expect(subs.filter((s: any) => s.id === 'bouygues_telecom')).toHaveLength(1);
    expect(subs.find((s: any) => s.id === 'bouyguestelecom')).toBeUndefined();
    expect(subs).toHaveLength(2); // survivor + engie
  });

  it('keeps the losing spelling as an alias so old references still resolve', () => {
    const cats = mergeSubcategoryInTaxonomy(build(), 'invoices', 'bouyguestelecom', 'bouygues_telecom');
    const winner = cats[0].subcategories.find((s: any) => s.id === 'bouygues_telecom');
    expect(winner.aliases).toContain('bouyguestelecom');
    expect(winner.aliases).toContain('bouygues_telecom');
  });

  it('still renames in place when the target does not exist', () => {
    const cats = mergeSubcategoryInTaxonomy(build(), 'invoices', 'engie', 'engie_sa');
    const subs = cats[0].subcategories;
    expect(subs.find((s: any) => s.id === 'engie')).toBeUndefined();
    const renamed = subs.find((s: any) => s.id === 'engie_sa');
    expect(renamed.name).toBe('Engie Sa');
    expect(renamed.aliases).toContain('engie');
  });

  it('leaves the taxonomy untouched for a no-op or unknown category', () => {
    expect(mergeSubcategoryInTaxonomy(build(), 'invoices', 'engie', 'engie')[0].subcategories).toHaveLength(3);
    expect(mergeSubcategoryInTaxonomy(build(), 'nope', 'engie', 'x')[0].subcategories).toHaveLength(3);
  });

  it('creates the target when neither side exists', () => {
    const cats = mergeSubcategoryInTaxonomy(build(), 'invoices', 'ghost', 'newthing');
    expect(cats[0].subcategories.find((s: any) => s.id === 'newthing')).toBeDefined();
  });
});
