import { describe, it, expect } from 'vitest';
import {
  findSubcategoryConflict,
  findCategoryConflict,
  normalizeSlugForComparison,
  slugSimilarity,
  renderTaxonomyConflictHintsBlock,
  TaxonomyHintEntry,
} from './taxonomy-conflicts.js';
import { CategoryItem } from './document.schema.js';

// A taxonomy shaped like the merged one after the 2026-08-27 one-instance merge.
function buildTaxonomy(): { categories: CategoryItem[] } {
  return {
    categories: [
      {
        id: 'invoices', name: 'Invoices', description: '', aliases: [],
        subcategories: [
          { id: 'sfr', name: 'SFR', aliases: ['red'] },
          { id: 'bouygues_telecom', name: 'Bouygues Telecom', aliases: ['bouyguestelecom'] },
          { id: 'cdiscount', name: 'Cdiscount', aliases: ['cdiscount', 'amazon', 'fnac'] },
        ],
      },
      {
        id: 'housing', name: 'Housing', description: '', aliases: [],
        subcategories: [{ id: 'foncia', name: 'Foncia', aliases: ['loyer'] }],
      },
      {
        id: 'bank', name: 'Bank', description: '', aliases: [],
        subcategories: [{ id: 'credit_mutuel', name: 'Crédit Mutuel', aliases: ['creditmutuel', 'credit mutuel', 'ccm'] }],
      },
      {
        id: 'administrative', name: 'Administrative', description: '', aliases: [],
        subcategories: [
          { id: 'france_travail', name: 'France Travail', aliases: ['francetravail'] },
          { id: 'impot', name: 'Impôts', aliases: ['taxe', 'avis'] },
          { id: 'inpi', name: 'Inpi', aliases: [] },
        ],
      },
      {
        id: 'correspondence', name: 'Correspondence', description: '', aliases: [],
        subcategories: [{ id: 'la_poste', name: 'La Poste', aliases: ['laposte'] }],
      },
      {
        id: 'bulletin_salaire', name: 'Bulletin Salaire', description: '', aliases: [],
        subcategories: [{ id: 'lai_dentail', name: 'Lai Dentail', aliases: ['lai dental'] }],
      },
      {
        id: 'health', name: 'Health', description: '', aliases: [],
        subcategories: [{ id: 'gps', name: 'Gps', aliases: [] }],
      },
      {
        id: 'education', name: 'Education', description: '', aliases: [],
        subcategories: [{ id: 'cdiscount_energie', name: 'Cdiscount Energie', aliases: [] }],
      },
    ],
  };
}

describe('slug comparison', () => {
  it('normalizes separators, accents and case for comparison', () => {
    expect(normalizeSlugForComparison('la_poste')).toBe('laposte');
    expect(normalizeSlugForComparison('La Poste')).toBe('laposte');
    expect(normalizeSlugForComparison('bouygues_telecom')).toBe('bouyguestelecom');
    expect(normalizeSlugForComparison('crédit mutuel')).toBe('creditmutuel');
  });

  it('scores near-identical spellings highly and unrelated slugs lowly', () => {
    expect(slugSimilarity('bouyguestelecom', 'bouygues_telecom')).toBe(1);
    expect(slugSimilarity('lai_dental', 'lai_dentail')).toBeGreaterThan(0.85);
    expect(slugSimilarity('impot', 'inpi')).toBeLessThan(0.7);
    expect(slugSimilarity('cdiscount', 'cdiscount_energie')).toBeLessThan(0.7);
  });
});

describe('findSubcategoryConflict', () => {
  it('blocks an exact slug that already exists under another category', () => {
    const conflict = findSubcategoryConflict(buildTaxonomy(), 'invoices', 'foncia');
    expect(conflict).not.toBeNull();
    expect(conflict!.kind).toBe('cross-category');
    expect(conflict!.mappedCategoryId).toBe('housing');
    expect(conflict!.mappedSubcategoryId).toBe('foncia');
  });

  it('blocks a slug matching an alias of an entry under another category', () => {
    // 'creditmutuel' normalizes identically to the id itself (underscore stripped) — exact id
    // path. A genuinely distinct alias (cdiscount's 'amazon') exercises the alias branch.
    const conflict = findSubcategoryConflict(buildTaxonomy(), 'housing', 'amazon');
    expect(conflict!.kind).toBe('cross-category-alias');
    expect(conflict!.mappedCategoryId).toBe('invoices');
    expect(conflict!.mappedSubcategoryId).toBe('cdiscount');
  });

  it('blocks a same-entity spelling variant across categories (la_poste/laposte)', () => {
    // 'laposte' normalizes identically to the existing id 'la_poste' (separator stripped) — the
    // exact-id cross-category path, mapping the proposal onto correspondence/la_poste.
    const conflict = findSubcategoryConflict(buildTaxonomy(), 'invoices', 'laposte');
    expect(conflict!.kind).toBe('cross-category');
    expect(conflict!.mappedCategoryId).toBe('correspondence');
    expect(conflict!.mappedSubcategoryId).toBe('la_poste');
  });

  it('merges a near-duplicate spelling within the SAME category (spelling-merge)', () => {
    // typo variant not present in the aliases — the caller\'s exact lookup misses it and only the
    // guard's fuzzy pass catches it
    const conflict = findSubcategoryConflict(buildTaxonomy(), 'invoices', 'bouyguestelecomme');
    expect(conflict!.kind).toBe('spelling-merge');
    expect(conflict!.mappedCategoryId).toBe('invoices');
    expect(conflict!.mappedSubcategoryId).toBe('bouygues_telecom');
  });

  it('blocks a near-duplicate spelling across categories', () => {
    const conflict = findSubcategoryConflict(buildTaxonomy(), 'health', 'lai_dentaile');
    expect(conflict!.kind).toBe('cross-category-near');
    expect(conflict!.mappedCategoryId).toBe('bulletin_salaire');
    expect(conflict!.mappedSubcategoryId).toBe('lai_dentail');
  });

  it('does not fire on a genuinely new slug', () => {
    expect(findSubcategoryConflict(buildTaxonomy(), 'invoices', 'veolia')).toBeNull();
  });

  it('does not fire on forbidden slugs', () => {
    expect(findSubcategoryConflict(buildTaxonomy(), 'invoices', 'general')).toBeNull();
    expect(findSubcategoryConflict(buildTaxonomy(), 'invoices', 'divers')).toBeNull();
  });

  it('does not conflate entities that share a word (cdiscount vs cdiscount_energie)', () => {
    // proposed cdiscount_energie under invoices: exact owner is education — one-instance remap,
    // NOT a collapse onto the cdiscount vendor entry
    const conflict = findSubcategoryConflict(buildTaxonomy(), 'invoices', 'cdiscount_energie');
    expect(conflict!.kind).toBe('cross-category');
    expect(conflict!.mappedCategoryId).toBe('education');
    expect(conflict!.mappedSubcategoryId).toBe('cdiscount_energie');
    // the vendor slug proposed under education maps to invoices/cdiscount, never to the energy arm
    const conflict2 = findSubcategoryConflict(buildTaxonomy(), 'education', 'cdiscount');
    expect(conflict2!.kind).toBe('cross-category');
    expect(conflict2!.mappedCategoryId).toBe('invoices');
    expect(conflict2!.mappedSubcategoryId).toBe('cdiscount');
    // fuzzy pass must NOT merge cdiscount with cdiscount_energie (0.53 similarity)
    const near = findSubcategoryConflict(buildTaxonomy(), 'education', 'cdiscountv2');
    expect(near).toBeNull();
  });

  it('does not fire on short slugs where edit distance is noise', () => {
    expect(findSubcategoryConflict(buildTaxonomy(), 'housing', 'sfx')).toBeNull();
    expect(findSubcategoryConflict(buildTaxonomy(), 'housing', 'gpsx')).toBeNull();
  });
});

describe('findCategoryConflict', () => {
  it('blocks a near-duplicate top-level category (administratif -> administrative)', () => {
    const conflict = findCategoryConflict(buildTaxonomy(), 'administratif');
    expect(conflict!.kind).toBe('category-near');
    expect(conflict!.mappedCategoryId).toBe('administrative');
  });

  it('blocks an entity name proposed as a top-level category (france_travail)', () => {
    const conflict = findCategoryConflict(buildTaxonomy(), 'france_travail', 'france_travail');
    expect(conflict!.kind).toBe('entity-as-category');
    expect(conflict!.mappedCategoryId).toBe('administrative');
    expect(conflict!.mappedSubcategoryId).toBe('france_travail');
  });

  it('does not fire when the proposed category is genuinely new', () => {
    expect(findCategoryConflict(buildTaxonomy(), 'justice')).toBeNull();
  });

  it('does not fire for an existing category id', () => {
    // callers only run the guard after their own exact/alias lookup missed
    expect(findCategoryConflict(buildTaxonomy(), 'bank')).toBeNull();
  });
});

describe('renderTaxonomyConflictHintsBlock', () => {
  it('renders nothing for an empty list', () => {
    expect(renderTaxonomyConflictHintsBlock([])).toBe('');
  });

  it('renders the proposed -> mapped guard lines', () => {
    const hints: TaxonomyHintEntry[] = [{
      proposed_category: 'invoices',
      proposed_subcategory: 'foncia',
      mapped_category: 'housing',
      mapped_subcategory: 'foncia',
      hint: 'Duplicate subcategory BLOCKED.',
      created_at: '2026-08-27T00:00:00.000Z',
    }];
    const block = renderTaxonomyConflictHintsBlock(hints);
    expect(block).toContain('TAXONOMY DUPLICATE GUARD');
    expect(block).toContain('invoices/foncia');
    expect(block).toContain('housing/foncia');
  });

  it('skips malformed entries', () => {
    const block = renderTaxonomyConflictHintsBlock([
      { proposed_category: 'x', mapped_category: '', mapped_subcategory: '', hint: 'no target', created_at: '' },
      null as any,
    ]);
    expect(block).toBe('');
  });
});
