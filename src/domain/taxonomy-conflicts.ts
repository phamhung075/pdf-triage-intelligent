import { isForbiddenSubcategory } from './taxonomy.js';

// Taxonomy duplicate guard — the BLOCK half of the "block then return a hint" loop that keeps the
// one-instance-per-subcategory invariant (docs/knowledge/taxonomy.md#one-instance-per-subcategory).
//
// The Qwen classifier resolves categories/subcategories through resolveCategory/resolveSubcategory
// (classification-resolution.ts), which previously only searched for a slug INSIDE the matched
// category. A slug that existed under another category (foncia under housing while classified as
// invoices/foncia) or a variant spelling of an existing slug (bouyguestelecom vs bouygues_telecom)
// therefore fell through to dynamic auto-creation — Golden Rule #5 happily wrote a SECOND instance
// of the same entity. This module detects those cases BEFORE creation, so the caller can remap the
// document to the existing entry instead and record a hint that teaches future runs (the HINT half,
// rendered back into the model's STEP 0 block via taxonomy-hints-store.ts).
//
// Deliberately conservative: a false positive here rewrites a document's category, so near-duplicate
// detection requires a high similarity threshold and a minimum length, and never fires on the short
// slugs (sfr, cic, gps, edf…) where edit distance is meaningless.

export type TaxonomyConflictKind =
  | 'cross-category'        // exact slug id exists under another category
  | 'cross-category-alias'  // slug matches an alias of an entry under another category
  | 'cross-category-near'   // slug is a near-duplicate spelling of an entry under another category
  | 'spelling-merge'        // slug is a near-duplicate spelling of an entry in the SAME category
  | 'category-near'         // proposed new top-level category near-duplicates an existing one
  | 'entity-as-category';   // proposed category is actually an existing subcategory (entity) name

export interface TaxonomyConflict {
  kind: TaxonomyConflictKind;
  /** The category the document should be filed under instead. */
  mappedCategoryId: string;
  /** The existing subcategory slug to use (undefined only for category-near). */
  mappedSubcategoryId?: string;
  /** Human-readable explanation, surfaced in logs and persisted for future prompts. */
  hint: string;
}

/** A recorded conflict, persisted newest-first in taxonomy_hints.json and re-injected into STEP 0. */
export interface TaxonomyHintEntry {
  proposed_category?: string;
  proposed_subcategory?: string;
  mapped_category: string;
  mapped_subcategory?: string;
  hint: string;
  created_at?: string;
}

// --- Slug comparison ----------------------------------------------------------------

/**
 * Slug form used for duplicate comparison: lowercase, accent-stripped, separators removed, so
 * 'la_poste'/'laposte', 'bouygues_telecom'/'bouyguestelecom' and 'crédit mutuel'/'creditmutuel'
 * all compare equal where they denote the same entity.
 */
export function normalizeSlugForComparison(slug: string): string {
  return (slug || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Classic Levenshtein distance (small strings only — this is a hot path over short slugs). */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** 1 - distance/maxLen over normalized forms; 1 means identical spelling. */
export function slugSimilarity(a: string, b: string): number {
  const na = normalizeSlugForComparison(a);
  const nb = normalizeSlugForComparison(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(na, nb) / maxLen;
}

/** Below this ratio a near-match is considered a coincidence, not a duplicate. */
export const NEAR_DUPLICATE_THRESHOLD = 0.82;
/** Near-duplicate detection is meaningless for very short slugs — edit distance there is noise. */
export const MIN_COMPARE_LENGTH = 4;

function isComparable(slug: string): boolean {
  const n = normalizeSlugForComparison(slug);
  return n.length >= MIN_COMPARE_LENGTH;
}

// --- Subcategory conflicts ----------------------------------------------------------

interface CandidateSub {
  categoryId: string;
  subcategoryId: string;
  normalized: string;
  aliases: string[];
}

function collectSubcategoryCandidates(categories: any[]): CandidateSub[] {
  const out: CandidateSub[] = [];
  for (const cat of categories || []) {
    for (const sub of cat.subcategories || []) {
      if (isForbiddenSubcategory(sub.id)) continue;
      const aliases = (sub.aliases || []).map((a: string) => normalizeSlugForComparison(a)).filter(Boolean);
      out.push({ categoryId: cat.id, subcategoryId: sub.id, normalized: normalizeSlugForComparison(sub.id), aliases });
    }
  }
  return out;
}

/**
 * Detects a duplicate BEFORE a new subcategory would be auto-created under `currentCategoryId`.
 *
 * The current category is NOT excluded from the scan: the caller (resolveSubcategory) already
 * resolved exact id/alias matches within the current category before this hook runs, so any exact
 * hit here is by definition under another category — but a near-duplicate spelling in the SAME
 * category (bouyguestelecom vs bouygues_telecom) is exactly what the caller's exact-only lookup
 * misses, and is the case this guard exists to merge. Kind reflects whether the winning entry
 * lives under the current category (spelling-merge, no category change) or elsewhere (cross-*).
 */
export function findSubcategoryConflict(
  categories: { categories: any[] },
  currentCategoryId: string,
  rawSubSlug: string
): TaxonomyConflict | null {
  const slug = (rawSubSlug || '').toLowerCase().trim();
  if (!slug || isForbiddenSubcategory(slug)) return null;
  const slugNorm = normalizeSlugForComparison(slug);
  if (!slugNorm) return null;

  const candidates = collectSubcategoryCandidates(categories?.categories);
  const sameCategory = (c: CandidateSub) => c.categoryId === currentCategoryId;

  // 1) exact id
  const exact = candidates.find(c => c.normalized === slugNorm);
  if (exact) {
    if (sameCategory(exact)) return null; // caller's own lookup already handled this
    return {
      kind: 'cross-category',
      mappedCategoryId: exact.categoryId,
      mappedSubcategoryId: exact.subcategoryId,
      hint: `Duplicate subcategory BLOCKED: '${slug}' already exists as '${exact.subcategoryId}' under category '${exact.categoryId}' — reusing it instead of creating a second instance (one-instance-per-subcategory rule).`,
    };
  }

  // 2) alias match — EXACT normalized equality only. The caller's within-category rule already
  //    allows substring alias matches (verbose slugs like 'Caisse Credit Mutuel Springfield
  //    Centre' containing 'creditmutuel'), but cross-category that would be a collision trap:
  //    'cdiscount_energie' contains 'cdiscount' and must NOT be dragged onto the e-commerce
  //    vendor. Here an alias must denote the entity wholesale ('creditmutuel' == alias, 'amazon'
  //    == cdiscount alias).
  const aliasHit = candidates.find(c =>
    c.aliases.some(a => a === slugNorm)
  );
  if (aliasHit) {
    return {
      kind: sameCategory(aliasHit) ? 'spelling-merge' : 'cross-category-alias',
      mappedCategoryId: aliasHit.categoryId,
      mappedSubcategoryId: aliasHit.subcategoryId,
      hint: `Duplicate subcategory BLOCKED: '${slug}' matches an alias of existing '${aliasHit.subcategoryId}' under category '${aliasHit.categoryId}' — reuse the existing slug instead of creating a new one.`,
    };
  }

  // 3) near-duplicate spelling
  if (isComparable(slug)) {
    let best: { candidate: CandidateSub; ratio: number } | null = null;
    for (const c of candidates) {
      const ratio = slugSimilarity(slug, c.subcategoryId);
      if (ratio >= NEAR_DUPLICATE_THRESHOLD && (!best || ratio > best.ratio)) {
        best = { candidate: c, ratio };
      }
    }
    // also compare against aliases (e.g. 'lai dental' vs existing alias 'lai_dental')
    if (!best) {
      for (const c of candidates) {
        for (const a of c.aliases) {
          if (!isComparable(a)) continue;
          const ratio = slugSimilarity(slug, a);
          if (ratio >= NEAR_DUPLICATE_THRESHOLD && (!best || ratio > best.ratio)) {
            best = { candidate: c, ratio };
          }
        }
      }
    }
    if (best) {
      return {
        kind: sameCategory(best.candidate) ? 'spelling-merge' : 'cross-category-near',
        mappedCategoryId: best.candidate.categoryId,
        mappedSubcategoryId: best.candidate.subcategoryId,
        hint: `Duplicate subcategory BLOCKED: '${slug}' is a near-duplicate spelling of existing '${best.candidate.subcategoryId}' under category '${best.candidate.categoryId}' (similarity ${Math.round(best.ratio * 100)}%) — reusing the existing slug instead of creating '${slug}'.`,
      };
    }
  }

  return null;
}

// --- Category conflicts -------------------------------------------------------------

/**
 * Detects a duplicate BEFORE a new top-level category would be auto-created. Two guards:
 *  1. the proposed name near-duplicates an existing category id (e.g. 'administratif' -> 'administrative')
 *  2. the proposed "category" is actually an entity that already exists as a subcategory
 *     (e.g. 'france_travail' -> subcategory of 'administrative' — the AI-created top-level
 *     category that this mechanism exists to prevent coming back).
 */
export function findCategoryConflict(
  categories: { categories: any[] },
  rawCategorie: string,
  rawSubcategorie?: string
): TaxonomyConflict | null {
  const rawCat = (rawCategorie || '').toLowerCase().trim();
  const catNorm = normalizeSlugForComparison(rawCat);
  if (!catNorm) return null;

  const cats = categories?.categories || [];

  // 1) near-duplicate of an existing top-level category
  if (isComparable(rawCat)) {
    let bestCat: { id: string; ratio: number } | null = null;
    for (const c of cats) {
      if (isForbiddenSubcategory(c.id)) continue;
      if (normalizeSlugForComparison(c.id) === catNorm) continue; // exact id — caller handles it
      const ratio = slugSimilarity(rawCat, c.id);
      if (ratio >= NEAR_DUPLICATE_THRESHOLD && (!bestCat || ratio > bestCat.ratio)) {
        bestCat = { id: c.id, ratio };
      }
    }
    if (bestCat) {
      return {
        kind: 'category-near',
        mappedCategoryId: bestCat.id,
        hint: `Duplicate category BLOCKED: '${rawCat}' is a near-duplicate of existing category '${bestCat.id}' (similarity ${Math.round(bestCat.ratio * 100)}%) — using '${bestCat.id}' instead of auto-creating a second top-level category.`,
      };
    }
  }

  // 2) entity-as-category: the proposed category name is really an existing subcategory
  const proposedSub = (rawSubcategorie || '').toLowerCase().trim();
  const subMatches: Array<{ categoryId: string; subcategoryId: string; ratio: number }> = [];
  for (const c of cats) {
    for (const s of c.subcategories || []) {
      if (isForbiddenSubcategory(s.id)) continue;
      const ratio = slugSimilarity(rawCat, s.id);
      if (ratio === 1 || ratio >= NEAR_DUPLICATE_THRESHOLD) {
        subMatches.push({ categoryId: c.id, subcategoryId: s.id, ratio });
      }
    }
  }
  if (subMatches.length > 0) {
    // prefer an exact slug match; otherwise the closest near-match
    subMatches.sort((a, b) => (a.ratio === 1 ? -1 : 0) - (b.ratio === 1 ? -1 : 0) || b.ratio - a.ratio);
    const best = subMatches[0];
    return {
      kind: 'entity-as-category',
      mappedCategoryId: best.categoryId,
      mappedSubcategoryId: best.subcategoryId,
      hint: `Duplicate category BLOCKED: '${rawCat}' is an entity that already exists as subcategory '${best.subcategoryId}' under category '${best.categoryId}' — entities are never top-level categories. Filing under '${best.categoryId}/${best.subcategoryId}' instead of creating category '${rawCat}'.`,
    };
  }

  return null;
}

// --- Hint rendering (the "return hint" half) ---------------------------------------

/**
 * Renders persisted taxonomy conflicts into a compact STEP 0 block the model reads on every
 * classification run — the concrete "do not create these" list. Returns '' when there is
 * nothing to inject (placeholder must vanish cleanly).
 */
export function renderTaxonomyConflictHintsBlock(hints: TaxonomyHintEntry[]): string {
  const clean = (hints || []).filter(h => h && h.mapped_category && h.hint);
  if (clean.length === 0) return '';

  const lines: string[] = [
    '',
    'STEP 0: TAXONOMY DUPLICATE GUARD (read BEFORE classifying):',
    '- The following category/subcategory slugs were proposed by a previous run but BLOCKED because an identical or near-identical instance already exists. NEVER return them as new categories/subcategories — always reuse the exact existing slug under its existing category:',
  ];
  for (const h of clean) {
    const proposed = [h.proposed_category, h.proposed_subcategory].filter(Boolean).join('/');
    const mapped = [h.mapped_category, h.mapped_subcategory].filter(Boolean).join('/');
    lines.push(`- "${proposed || '?'}" → ALWAYS use "${mapped}". ${h.hint}`);
  }
  return lines.join('\n') + '\n';
}
