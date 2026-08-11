import { describe, it, expect } from 'vitest';
import path from 'path';
import { isYearString, isForbiddenSubcategory, computeCanonicalPath } from './taxonomy.js';

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
