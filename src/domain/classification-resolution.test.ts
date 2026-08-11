import { describe, it, expect } from 'vitest';
import { refineClassification, resolveCategory, resolveSubcategory, applyEntityPriorityOverride } from './classification-resolution.js';
import { DocumentMetadata, CategoryItem, EntityDictionary } from './document.schema.js';

const EMPTY_DICTIONARY: EntityDictionary = { banks: [], energy: [], telecom: [], insurance: [], gov: [], health: [] };
const DEFAULT_PERSONAL_NAME_DENYLIST = ['dupond', 'martin', 'lefebvre', 'bernard'];

function baseMetadata(overrides: Partial<DocumentMetadata>): DocumentMetadata {
  return {
    titre: 'Test', registre: '', date: '', categorie: 'administrative', subcategorie: 'general',
    summary: '', tags: [], markdown_content: '', other: {}, ...overrides,
  };
}

describe('refineClassification', () => {
  it('leaves a specific classification untouched', () => {
    const input = baseMetadata({ categorie: 'invoices', subcategorie: 'sfr' });
    const result = refineClassification(input, 'SFR Facture Total TTC', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result).toEqual(input);
  });

  it('replaces categorie "personal" with the rule-based result', () => {
    const input = baseMetadata({ categorie: 'personal', subcategorie: 'sfr' });
    const result = refineClassification(input, 'SFR Facture Total TTC', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.categorie).toBe('invoices');
  });

  it('replaces a "general" subcategorie with the rule-based result when the rule-based classifier finds something specific', () => {
    const input = baseMetadata({ categorie: 'invoices', subcategorie: 'general' });
    const result = refineClassification(input, 'Facture SFR Total TTC 45.99', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.subcategorie).toBe('sfr');
  });

  it('does not mutate the input object', () => {
    const input = baseMetadata({ categorie: 'personal', subcategorie: 'sfr' });
    refineClassification(input, 'SFR Facture Total TTC', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(input.categorie).toBe('personal');
  });
});

describe('resolveCategory', () => {
  it('matches an existing category by id', () => {
    const config = { categories: [{ id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] } as CategoryItem] };
    const { category, isNew } = resolveCategory(config, 'invoices');
    expect(category.id).toBe('invoices');
    expect(isNew).toBe(false);
  });

  it('creates and appends a new category when none matches', () => {
    const config = { categories: [] as CategoryItem[] };
    const { category, isNew } = resolveCategory(config, 'new_category');
    expect(isNew).toBe(true);
    expect(category.id).toBe('new_category');
    expect(config.categories).toContain(category);
  });

  it('defaults an empty/falsy categorie to "administrative"', () => {
    const config = { categories: [] as CategoryItem[] };
    const { category } = resolveCategory(config, '');
    expect(category.id).toBe('administrative');
  });
});

describe('resolveSubcategory', () => {
  it('matches an existing subcategory by id', () => {
    const category: CategoryItem = { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [{ id: 'sfr', name: 'SFR', aliases: [] }] };
    const { subcategoryId, isNew } = resolveSubcategory(category, 'sfr', 'text', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(subcategoryId).toBe('sfr');
    expect(isNew).toBe(false);
  });

  it('resolves a forbidden slug (general/other/divers) as-is without creating it', () => {
    const category: CategoryItem = { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] };
    const { subcategoryId, isNew } = resolveSubcategory(category, 'other', 'text', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(subcategoryId).toBe('other');
    expect(isNew).toBe(false);
    expect(category.subcategories).toHaveLength(0);
  });

  it('resolves an ungrounded slug to "general" instead of creating it', () => {
    const category: CategoryItem = { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] };
    const { subcategoryId, isNew } = resolveSubcategory(category, 'veolia', 'nothing here about that entity', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(subcategoryId).toBe('general');
    expect(isNew).toBe(false);
  });

  it('creates and appends a new subcategory when the slug is genuinely grounded', () => {
    const category: CategoryItem = { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] };
    const { subcategoryId, isNew, newSubcategory } = resolveSubcategory(category, 'veolia', 'Veolia here and Veolia there', 'veolia_invoice.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(isNew).toBe(true);
    expect(subcategoryId).toBe('veolia');
    expect(newSubcategory?.id).toBe('veolia');
    expect(category.subcategories).toContainEqual(newSubcategory);
  });

  it('coerces a bare-year subcategorie to "general"', () => {
    const category: CategoryItem = { id: 'administrative', name: 'Administrative', description: '', aliases: [], subcategories: [] };
    const { subcategoryId } = resolveSubcategory(category, '2023', 'text', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(subcategoryId).toBe('general');
  });

  it('collapses a verbose underscore-normalized slug onto an existing subcategory whose alias is stored with spaces (regression: real categories.json credit_mutuel aliases like "credit mutuel" / "ccm marseille")', () => {
    const category: CategoryItem = {
      id: 'bank', name: 'Banque & Relevés', description: '', aliases: [],
      subcategories: [{ id: 'credit_mutuel', name: 'Crédit Mutuel', aliases: ['creditmutuel', 'credit mutuel', 'ccm marseille', 'ccm'] }]
    };
    const { subcategoryId, isNew } = resolveSubcategory(
      category, 'Caisse Credit Mutuel Marseille Ste Marguerite', 'Crédit Mutuel bank statement text', 'releve.pdf', DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(subcategoryId).toBe('credit_mutuel');
    expect(isNew).toBe(false);
    expect(category.subcategories).toHaveLength(1);
  });

  it('matches a category alias stored with spaces against an underscore-normalized rawCategorie', () => {
    const config = { categories: [{ id: 'bank', name: 'Bank', description: '', aliases: ['bank', 'compte bancaire'], subcategories: [] } as CategoryItem] };
    const { category, isNew } = resolveCategory(config, 'Compte Bancaire');
    expect(isNew).toBe(false);
    expect(category.id).toBe('bank');
  });
});

describe('applyEntityPriorityOverride', () => {
  const BANK_DICTIONARY: EntityDictionary = {
    banks: [{ slug: 'credit_mutuel', name: 'Crédit Mutuel', aliases: ['credit mutuel', 'ccm'] }],
    energy: [], telecom: [], insurance: [], gov: [], health: []
  };
  const GOV_DICTIONARY: EntityDictionary = {
    banks: [], energy: [], telecom: [], insurance: [],
    gov: [{ slug: 'france_travail', name: 'France Travail', aliases: ['france travail', 'pole emploi'] }],
    health: []
  };

  function baseMetadata(overrides: Partial<DocumentMetadata>): DocumentMetadata {
    return {
      titre: 'Test', registre: '', date: '', categorie: 'correspondence', subcategorie: 'general',
      summary: '', tags: [], markdown_content: '', other: {}, ...overrides,
    };
  }

  it('overrides a weak/fallback category (correspondence) with the entity-dictionary-grounded category+subcategory', () => {
    const input = baseMetadata({ categorie: 'correspondence', subcategorie: 'credit_mutuel_marseille_ste_marguerite' });
    const result = applyEntityPriorityOverride(input, 'CAISSE DE CREDIT MUTUEL MARSEILLE STE MARGUERITE', BANK_DICTIONARY);
    expect(result.overridden).toBe(true);
    expect(result.categorie).toBe('bank');
    expect(result.subcategorie).toBe('credit_mutuel');
  });

  it('does not override a specific (non-fallback) category even when the entity is dictionary-grounded under a different category', () => {
    const input = baseMetadata({ categorie: 'bulletin_salaire', subcategorie: 'france_travail' });
    const result = applyEntityPriorityOverride(input, 'France Travail', GOV_DICTIONARY);
    expect(result.overridden).toBe(false);
    expect(result.categorie).toBe('bulletin_salaire');
    expect(result.subcategorie).toBe('france_travail');
  });

  it('does not override when no entity was extracted', () => {
    const input = baseMetadata({ categorie: 'correspondence' });
    const result = applyEntityPriorityOverride(input, '', BANK_DICTIONARY);
    expect(result.overridden).toBe(false);
  });

  it('does not override when the entity is not recognized in the entity dictionary', () => {
    const input = baseMetadata({ categorie: 'correspondence' });
    const result = applyEntityPriorityOverride(input, 'Some Unknown Local Shop', BANK_DICTIONARY);
    expect(result.overridden).toBe(false);
  });

  it('treats "other" and "personal" as weak/fallback categories too', () => {
    const input = baseMetadata({ categorie: 'other', subcategorie: 'general' });
    const result = applyEntityPriorityOverride(input, 'Crédit Mutuel', BANK_DICTIONARY);
    expect(result.overridden).toBe(true);
    expect(result.categorie).toBe('bank');
  });

  it('overrides a bank-domain entity unconditionally, even against a non-weak/arbitrary wrong category (regression: real Step D output landed on "reports", not just "correspondence")', () => {
    const input = baseMetadata({ categorie: 'reports', subcategorie: 'credit_mutuel_marseille_ste_marguerite' });
    const result = applyEntityPriorityOverride(input, 'CAISSE DE CREDIT MUTUEL MARSEILLE STE MARGUERITE', BANK_DICTIONARY);
    expect(result.overridden).toBe(true);
    expect(result.categorie).toBe('bank');
    expect(result.subcategorie).toBe('credit_mutuel');
  });

  it('does not override when Step D already agrees the category is "bank"', () => {
    const input = baseMetadata({ categorie: 'bank', subcategorie: 'credit_mutuel' });
    const result = applyEntityPriorityOverride(input, 'Crédit Mutuel', BANK_DICTIONARY);
    expect(result.overridden).toBe(false);
  });
});
