import { describe, it, expect } from 'vitest';
import { refineClassification, resolveCategory, resolveSubcategory, applyEntityPriorityOverride } from './classification-resolution.js';
import { DocumentMetadata, CategoryItem, EntityDictionary } from './document.schema.js';

const EMPTY_DICTIONARY: EntityDictionary = { banks: [], energy: [], telecom: [], insurance: [], gov: [], health: [] };
const DEFAULT_PERSONAL_NAME_DENYLIST = ['dupond', 'martin', 'lefebvre', 'bernard'];

function baseMetadata(overrides: Partial<DocumentMetadata>): DocumentMetadata {
  return {
    titre: 'Test', registre: '', date: '', categorie: 'administrative', subcategorie: 'general',
    summary: '', tags: [], markdown_content: '', other: {}, thinking: '',
    // Transform-produced fields: DocumentMetadataSchema normalizes null/undefined to '', so the
    // parsed OUTPUT type has them as plain required strings. Spell them out here rather than
    // widening the production type just to satisfy a fixture.
    total_amount: '', vat_amount: '', siren: '', iban: '', expiry_date: '',
    contact_name: '', contact_email: '', contact_phone: '', contact_address: '', contact_website: '',
    ...overrides,
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

  it('collapses a verbose underscore-normalized slug onto an existing subcategory whose alias is stored with spaces (regression: a private-overlay credit_mutuel alias set like "credit mutuel" / "ccm springfield")', () => {
    const category: CategoryItem = {
      id: 'bank', name: 'Banque & Relevés', description: '', aliases: [],
      subcategories: [{ id: 'credit_mutuel', name: 'Crédit Mutuel', aliases: ['creditmutuel', 'credit mutuel', 'ccm springfield', 'ccm'] }]
    };
    const { subcategoryId, isNew } = resolveSubcategory(
      category, 'Caisse Credit Mutuel Springfield Centre', 'Crédit Mutuel bank statement text', 'releve.pdf', DEFAULT_PERSONAL_NAME_DENYLIST
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

describe('resolveCategory duplicate guard', () => {
  const config = {
    categories: [
      { id: 'administrative', name: 'Administrative', description: '', aliases: [], subcategories: [{ id: 'france_travail', name: 'France Travail', aliases: [] }] } as CategoryItem,
      { id: 'housing', name: 'Housing', description: '', aliases: [], subcategories: [] } as CategoryItem,
    ],
  };

  it('blocks a near-duplicate category name and remaps to the existing one', () => {
    const { category, isNew, conflict } = resolveCategory(config, 'administratif');
    expect(isNew).toBe(false);
    expect(category.id).toBe('administrative');
    expect(conflict?.kind).toBe('category-near');
    expect(config.categories).toHaveLength(2); // nothing auto-created
  });

  it('blocks an entity name proposed as a top-level category', () => {
    const { category, isNew, conflict } = resolveCategory(config, 'france_travail', 'france_travail');
    expect(isNew).toBe(false);
    expect(category.id).toBe('administrative');
    expect(conflict?.kind).toBe('entity-as-category');
    expect(conflict?.mappedSubcategoryId).toBe('france_travail');
    expect(config.categories).toHaveLength(2);
  });

  it('still auto-creates a genuinely new category', () => {
    const { isNew, category } = resolveCategory(config, 'justice');
    expect(isNew).toBe(true);
    expect(category.id).toBe('justice');
  });
});

describe('resolveSubcategory duplicate guard', () => {
  const config = {
    categories: [
      { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [{ id: 'bouygues_telecom', name: 'Bouygues Telecom', aliases: ['bouyguestelecom'] }] } as CategoryItem,
      { id: 'housing', name: 'Housing', description: '', aliases: [], subcategories: [{ id: 'foncia', name: 'Foncia', aliases: ['loyer'] }] } as CategoryItem,
    ],
  };
  const invoices = config.categories[0];

  it('blocks a slug that exists under another category and maps to the canonical owner', () => {
    const { subcategoryId, isNew, conflict } = resolveSubcategory(invoices, 'foncia', 'Quittance de loyer Foncia', 'quittance.pdf', DEFAULT_PERSONAL_NAME_DENYLIST, config);
    expect(isNew).toBe(false);
    expect(subcategoryId).toBe('foncia');
    expect(conflict?.kind).toBe('cross-category');
    expect(conflict?.mappedCategoryId).toBe('housing');
    expect(invoices.subcategories).toHaveLength(1); // nothing auto-created under invoices
  });

  it('merges a same-category near-duplicate spelling onto the existing entry', () => {
    // 'bouygue_telecom' (dropped 's') is not caught by the caller's exact/alias lookup — only the
    // guard's fuzzy pass recognizes it as the same entity as 'bouygues_telecom'.
    const { subcategoryId, isNew, conflict } = resolveSubcategory(invoices, 'bouygue_telecom', 'Bouygues Telecom facture', 'bouygues.pdf', DEFAULT_PERSONAL_NAME_DENYLIST, config);
    expect(isNew).toBe(false);
    expect(subcategoryId).toBe('bouygues_telecom');
    expect(conflict?.kind).toBe('spelling-merge');
    expect(invoices.subcategories).toHaveLength(1);
  });

  it('does not block without a full taxonomy (backward compatible)', () => {
    const { isNew, subcategoryId } = resolveSubcategory(invoices, 'foncia', 'Quittance de loyer Foncia', 'quittance.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(isNew).toBe(true); // legacy behavior: no cross-category knowledge
    expect(subcategoryId).toBe('foncia');
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
      summary: '', tags: [], markdown_content: '', other: {}, thinking: '',
      total_amount: '', vat_amount: '', siren: '', iban: '', expiry_date: '',
      contact_name: '', contact_email: '', contact_phone: '', contact_address: '', contact_website: '',
      ...overrides,
    };
  }

  it('overrides a weak/fallback category (correspondence) with the entity-dictionary-grounded category+subcategory', () => {
    const input = baseMetadata({ categorie: 'correspondence', subcategorie: 'credit_mutuel_springfield_centre' });
    const result = applyEntityPriorityOverride(input, 'CAISSE DE CREDIT MUTUEL SPRINGFIELD CENTRE', BANK_DICTIONARY);
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
    const input = baseMetadata({ categorie: 'reports', subcategorie: 'credit_mutuel_springfield_centre' });
    const result = applyEntityPriorityOverride(input, 'CAISSE DE CREDIT MUTUEL SPRINGFIELD CENTRE', BANK_DICTIONARY);
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
