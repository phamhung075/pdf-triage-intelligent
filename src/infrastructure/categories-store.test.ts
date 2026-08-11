import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tempDir: string;
let categoriesFile: string;
let categoriesPrivateFile: string;

// BASE_DIR now defaults to process.cwd() (portable, for open-source use), but the store still
// must never touch the REAL project's categories.json / .categories.private.json while under
// test — mock the whole settings module with temp paths instead.
vi.mock('./settings.js', () => ({
  get CONFIG() { return { CATEGORIES_FILE: categoriesFile, CATEGORIES_PRIVATE_FILE: categoriesPrivateFile }; },
}));

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'categories-store-test-'));
  categoriesFile = path.join(tempDir, 'categories.json');
  categoriesPrivateFile = path.join(tempDir, '.categories.private.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function fresh() {
  vi.resetModules();
  return import('./categories-store.js');
}

describe('getCategoriesConfig', () => {
  it('returns the built-in default categories when neither file exists', async () => {
    const { getCategoriesConfig } = await fresh();
    const config = getCategoriesConfig();
    expect(config.categories.length).toBeGreaterThan(0);
    expect(config.categories.some(c => c.id === 'invoices')).toBe(true);
  });

  it('returns the parsed content when categories.json exists and is valid, with no private file', async () => {
    fs.writeFileSync(categoriesFile, JSON.stringify({
      categories: [{ id: 'custom', name: 'Custom', description: '', aliases: [], subcategories: [] }],
    }));
    const { getCategoriesConfig } = await fresh();
    const config = getCategoriesConfig();
    expect(config.categories).toEqual([{ id: 'custom', name: 'Custom', description: '', aliases: [], subcategories: [] }]);
  });

  it('falls back to defaults when categories.json contains malformed JSON', async () => {
    fs.writeFileSync(categoriesFile, '{not valid json');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getCategoriesConfig } = await fresh();
    const config = getCategoriesConfig();
    expect(config.categories.some(c => c.id === 'invoices')).toBe(true);
    consoleErrorSpy.mockRestore();
  });

  it('falls back to defaults when categories.json fails schema validation', async () => {
    fs.writeFileSync(categoriesFile, JSON.stringify({ categories: [{ name: 'Missing id field' }] }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getCategoriesConfig } = await fresh();
    const config = getCategoriesConfig();
    expect(config.categories.some(c => c.id === 'invoices')).toBe(true);
    consoleErrorSpy.mockRestore();
  });

  it('adds a category that exists only in the private overlay', async () => {
    fs.writeFileSync(categoriesFile, JSON.stringify({
      categories: [{ id: 'invoices', name: 'Factures', description: '', aliases: [], subcategories: [] }],
    }));
    fs.writeFileSync(categoriesPrivateFile, JSON.stringify({
      categories: [{ id: 'bank', name: 'Banque', description: '', aliases: [], subcategories: [{ id: 'credit_mutuel', name: 'Credit Mutuel', aliases: [] }] }],
    }));

    const { getCategoriesConfig } = await fresh();
    const config = getCategoriesConfig();

    expect(config.categories.map(c => c.id).sort()).toEqual(['bank', 'invoices']);
    const bank = config.categories.find(c => c.id === 'bank')!;
    expect(bank.subcategories?.map(s => s.id)).toEqual(['credit_mutuel']);
  });

  it('merges private subcategories into a category that already exists in the public file, without duplicating', async () => {
    fs.writeFileSync(categoriesFile, JSON.stringify({
      categories: [{
        id: 'bank', name: 'Banque', description: '', aliases: [],
        subcategories: [{ id: 'generic_bank', name: 'Generic Bank', aliases: [] }],
      }],
    }));
    fs.writeFileSync(categoriesPrivateFile, JSON.stringify({
      categories: [{
        id: 'bank', name: 'Banque', description: '', aliases: [],
        subcategories: [{ id: 'credit_mutuel', name: 'Credit Mutuel', aliases: [] }],
      }],
    }));

    const { getCategoriesConfig } = await fresh();
    const config = getCategoriesConfig();

    expect(config.categories).toHaveLength(1);
    const bank = config.categories[0];
    expect(bank.subcategories?.map(s => s.id).sort()).toEqual(['credit_mutuel', 'generic_bank']);
  });

  it('does not duplicate a subcategory that already exists in both files', async () => {
    const sharedSub = { id: 'credit_mutuel', name: 'Credit Mutuel', aliases: [] };
    fs.writeFileSync(categoriesFile, JSON.stringify({
      categories: [{ id: 'bank', name: 'Banque', description: '', aliases: [], subcategories: [sharedSub] }],
    }));
    fs.writeFileSync(categoriesPrivateFile, JSON.stringify({
      categories: [{ id: 'bank', name: 'Banque', description: '', aliases: [], subcategories: [sharedSub] }],
    }));

    const { getCategoriesConfig } = await fresh();
    const config = getCategoriesConfig();

    expect(config.categories[0].subcategories).toHaveLength(1);
  });

  it('ignores a private file with malformed JSON and still returns the public categories', async () => {
    fs.writeFileSync(categoriesFile, JSON.stringify({
      categories: [{ id: 'invoices', name: 'Factures', description: '', aliases: [], subcategories: [] }],
    }));
    fs.writeFileSync(categoriesPrivateFile, '{not valid json');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { getCategoriesConfig } = await fresh();
    const config = getCategoriesConfig();

    expect(config.categories.map(c => c.id)).toEqual(['invoices']);
    consoleErrorSpy.mockRestore();
  });
});

describe('saveCategoriesConfig', () => {
  it('writes the full category list to .categories.private.json when categories.json does not exist (nothing public to diff against)', async () => {
    const { saveCategoriesConfig } = await fresh();
    saveCategoriesConfig([{ id: 'new_cat', name: 'New', description: '', aliases: [], subcategories: [] }]);

    expect(fs.existsSync(categoriesFile)).toBe(false); // public file is never written to
    const written = JSON.parse(fs.readFileSync(categoriesPrivateFile, 'utf-8'));
    expect(written.categories).toEqual([{ id: 'new_cat', name: 'New', description: '', aliases: [], subcategories: [] }]);
  });

  it('writes only the categories/subcategories NOT already in the public categories.json', async () => {
    fs.writeFileSync(categoriesFile, JSON.stringify({
      categories: [{
        id: 'bank', name: 'Banque', description: '', aliases: [],
        subcategories: [{ id: 'generic_bank', name: 'Generic Bank', aliases: [] }],
      }],
    }));

    const { saveCategoriesConfig } = await fresh();
    // Full merged list, as callers throughout the codebase pass it (public generic_bank + a
    // newly auto-created private subcategory) — only the new one should end up in the diff.
    saveCategoriesConfig([
      {
        id: 'bank', name: 'Banque', description: '', aliases: [],
        subcategories: [
          { id: 'generic_bank', name: 'Generic Bank', aliases: [] },
          { id: 'credit_mutuel', name: 'Credit Mutuel', aliases: [] },
        ],
      },
    ]);

    const written = JSON.parse(fs.readFileSync(categoriesPrivateFile, 'utf-8'));
    expect(written.categories).toHaveLength(1);
    expect(written.categories[0].id).toBe('bank');
    expect(written.categories[0].subcategories.map((s: any) => s.id)).toEqual(['credit_mutuel']);
  });

  it('never writes to categories.json (the public file is read-only from this module\'s perspective)', async () => {
    fs.writeFileSync(categoriesFile, JSON.stringify({ categories: [{ id: 'invoices', name: 'Factures', description: '', aliases: [], subcategories: [] }] }));
    const originalContent = fs.readFileSync(categoriesFile, 'utf-8');

    const { saveCategoriesConfig } = await fresh();
    saveCategoriesConfig([{ id: 'invoices', name: 'Factures', description: '', aliases: [], subcategories: [{ id: 'sfr', name: 'SFR', aliases: [] }] }]);

    expect(fs.readFileSync(categoriesFile, 'utf-8')).toBe(originalContent);
  });

  it('invokes the registered onCategoryCreatedCallback', async () => {
    const { saveCategoriesConfig, setOnCategoryCreatedCallback } = await fresh();
    const callback = vi.fn();
    setOnCategoryCreatedCallback(callback);

    saveCategoriesConfig([{ id: 'c', name: 'C', description: '', aliases: [], subcategories: [] }]);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('swallows an error thrown by the callback instead of letting it propagate', async () => {
    const { saveCategoriesConfig, setOnCategoryCreatedCallback } = await fresh();
    setOnCategoryCreatedCallback(() => { throw new Error('callback exploded'); });

    expect(() => saveCategoriesConfig([{ id: 'c', name: 'C', description: '', aliases: [], subcategories: [] }])).not.toThrow();
  });

  it('does not invoke a callback when none has been registered', async () => {
    const { saveCategoriesConfig } = await fresh();
    // Fresh module graph => onCategoryCreatedCallback starts null; just confirm no throw.
    expect(() => saveCategoriesConfig([{ id: 'c', name: 'C', description: '', aliases: [], subcategories: [] }])).not.toThrow();
  });
});
