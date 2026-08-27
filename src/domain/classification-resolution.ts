import { CategoryItem, SubcategoryItem, DocumentMetadata, EntityDictionary } from './document.schema.js';
import { ruleBasedClassify, isGroundedSubcategorySlug, normalizeSlug, matchEntityDictionary, ALL_ENTITY_DOMAINS } from './classification.js';
import { findCategoryConflict, findSubcategoryConflict, TaxonomyConflict } from './taxonomy-conflicts.js';
import { getEntityDictionary } from '../infrastructure/entity-dictionary-store.js';
import { getPromptPersonalization } from '../infrastructure/prompt-personalization-store.js';

// Categories the 13-step classification flow only ever reaches when nothing more specific
// matched (see docs/workflows/classification-flow.md step 12 — "Plain postal letters or emails
// without invoice, tax, or contract context"). A grounded entity-dictionary match is trusted
// enough to override one of these fallback guesses, but never a category Step D chose with
// apparent confidence (e.g. 'bulletin_salaire', 'contracts') — the same real-world entity can
// legitimately issue documents under several different categories (France Travail issues both
// 'administrative' letters and 'bulletin_salaire' unemployment payment statements), and Step D's
// full-text read is better positioned to tell those apart than a bare entity name is.
const WEAK_FALLBACK_CATEGORIES = new Set(['correspondence', 'other', 'personal', '']);

// Step A (buildEntityExtractionPrompt) runs a dedicated, narrowly-scoped extraction pass whose
// only job is identifying the document's issuing entity — this is far more reliable than hoping
// Step D's single freeform full-classification call both re-derives the entity AND picks the
// correct top-level category. When that extracted entity is recognized in the curated
// entity_dictionary.json (each entity belongs to exactly one domain -> exactly one category, so
// this is unambiguous by construction, unlike fuzzy-matching against the noisier, auto-created
// categories.json), and Step D's own category choice landed in one of the fallback buckets above,
// prefer the entity dictionary's grounded category+subcategory. This directly fixes the regression
// where a Crédit Mutuel bank statement (Step A correctly extracted the full branch name from the
// header) still got filed under 'correspondence' by Step D.
export function applyEntityPriorityOverride(
  validated: DocumentMetadata,
  extractedEntity: string,
  dictionary: EntityDictionary
): { categorie: string; subcategorie: string; overridden: boolean; reason?: string } {
  const noop = { categorie: validated.categorie, subcategorie: validated.subcategorie, overridden: false };
  if (!extractedEntity || !extractedEntity.trim()) return noop;

  const entityLower = extractedEntity.toLowerCase();
  const currentCategorySlug = normalizeSlug(validated.categorie || '');

  // Golden Rule #6 singles out bank statements as the "archetypal trap": a vendor name inside a
  // transaction row (SFR, PayPal, Amazon) must never outrank the issuing bank's own header. Manual
  // probing against a real Crédit Mutuel statement showed Step D landing on an arbitrary wrong
  // category — not just the 'correspondence' fallback below, but also e.g. 'reports' — so unlike
  // the general case, a curated bank-domain match overrides UNCONDITIONALLY rather than being
  // gated to "weak fallback" categories: in this taxonomy a recognized bank entity essentially
  // never legitimately produces a non-'bank' document.
  const bankMatch = matchEntityDictionary(entityLower, ['banks'], dictionary);
  if (bankMatch && currentCategorySlug !== bankMatch.categorie) {
    return {
      categorie: bankMatch.categorie,
      subcategorie: bankMatch.subcategorie,
      overridden: true,
      reason: `Step A entity "${extractedEntity}" is grounded in entity_dictionary.json's curated bank list as ${bankMatch.categorie}/${bankMatch.subcategorie} (Golden Rule #6) — overriding Step D's category '${validated.categorie}'`
    };
  }

  if (!WEAK_FALLBACK_CATEGORIES.has(currentCategorySlug)) return noop;

  const dictMatch = matchEntityDictionary(entityLower, ALL_ENTITY_DOMAINS, dictionary);
  if (!dictMatch) return noop;

  return {
    categorie: dictMatch.categorie,
    subcategorie: dictMatch.subcategorie,
    overridden: true,
    reason: `Step A entity "${extractedEntity}" is grounded in entity_dictionary.json as ${dictMatch.categorie}/${dictMatch.subcategorie} — overriding Step D's fallback category '${validated.categorie}'`
  };
}

// Refine Category & Subcategory using ruleBasedClassify if AI returned 'general', 'personal', 'other', or 'correspondence' for a Tax/Bank document
export function refineClassification(
  validated: DocumentMetadata,
  rawText: string,
  filename: string,
  dictionary: EntityDictionary,
  personalNameDenylist: string[]
): DocumentMetadata {
  if (!(validated.categorie === 'personal' || validated.categorie === 'other' || validated.subcategorie === 'general' || (validated.categorie === 'correspondence' && /impot|tax/i.test(filename)))) {
    return validated;
  }

  const rb = ruleBasedClassify(rawText, filename, dictionary, personalNameDenylist, getPromptPersonalization());
  const result = { ...validated };

  if (validated.categorie === 'personal' || validated.categorie === 'other' || !validated.categorie || (validated.categorie === 'correspondence' && rb.categorie === 'administrative')) {
    result.categorie = rb.categorie;
  }
  if (validated.subcategorie === 'general') {
    if (rb.subcategorie !== 'general') {
      result.subcategorie = rb.subcategorie;
      if (rb.categorie && (result.categorie === 'correspondence' || result.categorie === 'other')) {
        result.categorie = rb.categorie;
      }
    } else if (result.categorie === 'bulletin_salaire') {
      result.subcategorie = 'bulletin_salaire';
    }
  }

  return result;
}

// Normalize category ID & resolve to an existing entry, or describe a new one to be
// auto-created BEFORE the file is moved (Golden Rule #5).
//
// Duplicate guard: before auto-creating a brand-new top-level category, check the taxonomy for a
// near-duplicate category id (e.g. 'administratif' -> 'administrative') or for the proposed name
// actually being an entity that already exists as a subcategory ('france_travail' as a category —
// it is a subcategory of 'administrative'). A hit blocks the creation and remaps to the existing
// entry; the caller records the conflict as a hint that teaches future runs.
export function resolveCategory(
  categoriesConfig: { categories: CategoryItem[] },
  rawCategorie: string,
  rawSubcategorie?: string
): { category: CategoryItem; isNew: boolean; conflict?: TaxonomyConflict } {
  const rawCatSlug = normalizeSlug(rawCategorie || 'administrative');
  const matchedCategory = categoriesConfig.categories.find(c =>
    c.id === rawCatSlug || (c.aliases && c.aliases.some(a => rawCatSlug.includes(normalizeSlug(a))))
  );

  if (matchedCategory) {
    return { category: matchedCategory, isNew: false };
  }

  const conflict = findCategoryConflict(categoriesConfig, rawCatSlug, rawSubcategorie);
  if (conflict) {
    const existing = categoriesConfig.categories.find(c => c.id === conflict.mappedCategoryId);
    if (existing) {
      return { category: existing, isNew: false, conflict };
    }
    // mapped category missing is unexpected (conflict detection only maps onto real entries);
    // fall through to creation rather than hang the pipeline.
  }

  const newCatSlug = rawCatSlug;
  const newCatName = newCatSlug
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const newCatObj: CategoryItem = {
    id: newCatSlug,
    name: newCatName,
    description: `Category auto-created for ${newCatName}`,
    aliases: [newCatSlug],
    subcategories: []
  };

  categoriesConfig.categories.push(newCatObj);
  return { category: newCatObj, isNew: true };
}

const FORBIDDEN_SUBCATEGORIES = new Set([
  'general', 'other', 'divers', 'unknown', 'none',
  'anyscanner', 'camscanner', 'geniusscan', 'adobescan', 'tinyscanner', 'simplescan', 'docscanner',
  'jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'pdf', 'txt', 'docx', 'xlsx'
]);

// Normalize subcategory ID & resolve to an existing entry under `matchedCategory`, or
// describe a new one to be auto-created BEFORE the file is moved (Golden Rule #5) — unless
// the slug is forbidden (Golden Rule #4) or ungrounded (see isGroundedSubcategorySlug),
// in which case it resolves to 'general' so the caller's strict fail guard can BLOCK it.
//
// Duplicate guard: when `categoriesConfig` is supplied, a slug that already exists (exactly, by
// alias, or as a near-duplicate spelling) anywhere else in the taxonomy is NOT auto-created a
// second time — it resolves to the existing entry (and, when that entry lives under another
// category, `conflict.mappedCategoryId` tells the caller the document must be re-filed there).
export function resolveSubcategory(
  matchedCategory: CategoryItem,
  rawSubcategorie: string,
  rawText: string,
  filename: string,
  personalNameDenylist: string[],
  categoriesConfig?: { categories: CategoryItem[] }
): { subcategoryId: string; isNew: boolean; newSubcategory?: SubcategoryItem; rawSubSlug: string; conflict?: TaxonomyConflict } {
  let rawSubSlug = normalizeSlug(rawSubcategorie || '');
  // Clean dates from subcategory slugs
  rawSubSlug = rawSubSlug.replace(/_\d{4,8}$/g, '').replace(/\d{4,8}$/g, '');

  if (!rawSubSlug || /^\d{4}$/.test(rawSubSlug)) {
    rawSubSlug = 'general';
  }

  if (!matchedCategory.subcategories) {
    matchedCategory.subcategories = [];
  }

  const matchedSub = FORBIDDEN_SUBCATEGORIES.has(rawSubSlug)
    ? undefined
    : matchedCategory.subcategories.find(s =>
        s.id === rawSubSlug || (s.aliases && s.aliases.some(a => rawSubSlug.includes(normalizeSlug(a))))
      );

  if (matchedSub) {
    return { subcategoryId: matchedSub.id, isNew: false, rawSubSlug };
  }

  if (FORBIDDEN_SUBCATEGORIES.has(rawSubSlug)) {
    // Forbidden sentinel value — never auto-create it as a real taxonomy entry. Return it
    // as-is so the caller's strict fail guard (Golden Rule #4) BLOCKs the file and keeps
    // it in __raws.
    return { subcategoryId: rawSubSlug, isNew: false, rawSubSlug };
  }

  // Duplicate guard: never auto-create a second instance of a slug that already exists
  // elsewhere in the taxonomy (see domain/taxonomy-conflicts.ts).
  if (categoriesConfig) {
    const conflict = findSubcategoryConflict(categoriesConfig, matchedCategory.id, rawSubSlug);
    if (conflict) {
      return {
        subcategoryId: conflict.mappedSubcategoryId || rawSubSlug,
        isNew: false,
        rawSubSlug,
        conflict,
      };
    }
  }

  if (!isGroundedSubcategorySlug(rawSubSlug, rawText, filename, personalNameDenylist)) {
    // Before giving up and collapsing to 'general' (which triggers Golden Rule #4 block),
    // check if ruleBasedClassify can extract a valid, grounded subcategory fallback
    // (e.g. 'facture', 'bulletin_salaire', 'attestation_confirmation', 'cpf', 'bctc')
    const rb = ruleBasedClassify(rawText, filename, getEntityDictionary(), personalNameDenylist, getPromptPersonalization());
    if (rb.subcategorie && rb.subcategorie !== 'general' && !FORBIDDEN_SUBCATEGORIES.has(rb.subcategorie)) {
      const matchedFallbackSub = matchedCategory.subcategories.find(s =>
        s.id === rb.subcategorie || (s.aliases && s.aliases.some(a => {
          const normalizedAlias = normalizeSlug(a);
          return rb.subcategorie.includes(normalizedAlias) || normalizedAlias.includes(rb.subcategorie);
        }))
      );
      if (matchedFallbackSub) {
        return { subcategoryId: matchedFallbackSub.id, isNew: false, rawSubSlug };
      }
      if (isGroundedSubcategorySlug(rb.subcategorie, rawText, filename, personalNameDenylist)) {
        // Same duplicate guard for the rule-based fallback's candidate slug.
        if (categoriesConfig) {
          const rbConflict = findSubcategoryConflict(categoriesConfig, matchedCategory.id, rb.subcategorie);
          if (rbConflict) {
            return { subcategoryId: rbConflict.mappedSubcategoryId || rb.subcategorie, isNew: false, rawSubSlug, conflict: rbConflict };
          }
        }
        const newSubName = rb.subcategorie
          .split('_')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        const newSubObj: SubcategoryItem = { id: rb.subcategorie, name: newSubName, aliases: [rb.subcategorie] };
        matchedCategory.subcategories.push(newSubObj);
        return { subcategoryId: rb.subcategorie, isNew: true, newSubcategory: newSubObj, rawSubSlug };
      }
    }

    return { subcategoryId: 'general', isNew: false, rawSubSlug };
  }

  const newSubName = rawSubSlug
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const newSubObj: SubcategoryItem = {
    id: rawSubSlug,
    name: newSubName,
    aliases: [rawSubSlug]
  };

  matchedCategory.subcategories.push(newSubObj);
  return { subcategoryId: rawSubSlug, isNew: true, newSubcategory: newSubObj, rawSubSlug };
}
