import fs from 'fs';
import { CONFIG } from './settings.js';
import { CategoriesConfigSchema, CategoryItem } from '../domain/document.schema.js';
import { isForbiddenSubcategory } from '../domain/taxonomy.js';

const BUILT_IN_DEFAULT_CATEGORIES: CategoryItem[] = [
  { id: 'invoices', name: 'Factures', description: 'Factures et reçus', aliases: ['facture', 'invoice'], subcategories: [] },
  { id: 'bulletin_salaire', name: 'Bulletins de Salaire', description: 'Fiches de paie par entreprise', aliases: ['bulletin_salaire', 'paie', 'salaire'], subcategories: [] },
  { id: 'contracts', name: 'Contrats', description: 'Contrats et baux', aliases: ['contrat', 'contract'], subcategories: [] },
  { id: 'bank', name: 'Banque & Relevés', description: 'Relevés de compte bancaire et RIB', aliases: ['bank', 'banque', 'releve', 'rib'], subcategories: [] },
  { id: 'administrative', name: 'Administratif', description: 'Documents administratifs', aliases: ['tax', 'impot'], subcategories: [] },
  { id: 'health', name: 'Santé', description: 'Santé et mutuelle', aliases: ['health', 'sante'], subcategories: [] },
  { id: 'identity', name: 'Identité', description: 'Passeports et cartes d identite', aliases: ['identity', 'passport'], subcategories: [] },
  { id: 'housing', name: 'Logement', description: 'Justificatifs de domicile et loyers', aliases: ['housing', 'logement'], subcategories: [] },
  { id: 'insurance', name: 'Assurances', description: 'Contrats d assurance', aliases: ['insurance', 'assurance'], subcategories: [] },
  { id: 'education', name: 'Éducation', description: 'Formations et diplômes', aliases: ['education', 'formation'], subcategories: [] },
  { id: 'recruitment', name: 'Recrutement', description: 'Lettres et CV', aliases: ['recrutement', 'candidature'], subcategories: [] },
  { id: 'correspondence', name: 'Courriers', description: 'Emails et lettres', aliases: ['courrier', 'mail'], subcategories: [] },
  { id: 'technical', name: 'Technique', description: 'Manuels et guides', aliases: ['tech', 'manual'], subcategories: [] },
  { id: 'reports', name: 'Rapports', description: 'Rapports de projets', aliases: ['report'], subcategories: [] }
];

function readCategoriesFile(filePath: string, label: string): CategoryItem[] | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return CategoriesConfigSchema.parse(parsed).categories;
  } catch (e) {
    console.error(`Invalid ${label} schema, ignoring`, e);
    return null;
  }
}

function loadPublicCategories(): CategoryItem[] {
  return readCategoriesFile(CONFIG.CATEGORIES_FILE, 'categories.json') ?? BUILT_IN_DEFAULT_CATEGORIES;
}

function loadPrivateCategories(): CategoryItem[] {
  return readCategoriesFile(CONFIG.CATEGORIES_PRIVATE_FILE, '.categories.private.json') ?? [];
}

// Layers the private (personal, gitignored, auto-created-from-your-documents) overlay onto the
// public (generic, committed) base — new categories from the overlay are appended, and new
// subcategories on a category that exists in both are merged in by id. This lets categories.json
// stay a clean, shareable starter taxonomy while .categories.private.json accumulates real
// entities (bank branches, employers, etc.) without either file needing manual reconciliation.
function mergeCategories(base: CategoryItem[], overlay: CategoryItem[]): CategoryItem[] {
  const merged = base.map(cat => ({ ...cat, subcategories: [...(cat.subcategories ?? [])] }));

  for (const overlayCat of overlay) {
    const existing = merged.find(cat => cat.id === overlayCat.id);
    if (!existing) {
      merged.push({ ...overlayCat, subcategories: [...(overlayCat.subcategories ?? [])] });
      continue;
    }
    const existingSubIds = new Set((existing.subcategories ?? []).map(s => s.id));
    for (const overlaySub of overlayCat.subcategories ?? []) {
      if (!existingSubIds.has(overlaySub.id)) {
        existing.subcategories!.push(overlaySub);
      }
    }
  }

  return merged;
}

export function getCategoriesConfig() {
  const merged = mergeCategories(loadPublicCategories(), loadPrivateCategories());

  // Strip forbidden/invalid subcategories (e.g. anyscanner, raw file extensions like verso_png, 102818_jpg)
  merged.forEach(cat => {
    if (cat.subcategories) {
      cat.subcategories = cat.subcategories.filter(s => !isForbiddenSubcategory(s.id));
    }
  });

  return { categories: merged };
}

export let onCategoryCreatedCallback: (() => void) | null = null;
export function setOnCategoryCreatedCallback(cb: () => void) {
  onCategoryCreatedCallback = cb;
}

// Persists ONLY what isn't already in the public categories.json — new categories wholesale,
// and new subcategories on categories that already exist publicly. This is a one-way diff
// against the CURRENT public file, not a general two-way sync: renaming or editing a category
// that came from the public base won't be captured here (that's an intentionally out-of-scope
// edge case — the common path this exists for is auto-created categories/subcategories from
// document classification, never edits to the shipped defaults).
export function saveCategoriesConfig(categories: CategoryItem[]): void {
  const validated = CategoriesConfigSchema.parse({ categories });
  const publicCategories = loadPublicCategories();

  const privateDiff: CategoryItem[] = [];
  for (const cat of validated.categories) {
    const publicCat = publicCategories.find(c => c.id === cat.id);
    if (!publicCat) {
      privateDiff.push(cat);
      continue;
    }
    const publicSubIds = new Set((publicCat.subcategories ?? []).map(s => s.id));
    const extraSubs = (cat.subcategories ?? []).filter(s => !publicSubIds.has(s.id));
    if (extraSubs.length > 0) {
      privateDiff.push({ ...cat, subcategories: extraSubs });
    }
  }

  fs.writeFileSync(CONFIG.CATEGORIES_PRIVATE_FILE, JSON.stringify({ categories: privateDiff }, null, 2), 'utf-8');
  if (onCategoryCreatedCallback) {
    try { onCategoryCreatedCallback(); } catch (e) {}
  }
}
