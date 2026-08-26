import { z } from 'zod';

/**
 * A term array as Qwen actually emits it: usually strings, occasionally with a null or a number
 * mixed in, occasionally the key is absent entirely, and occasionally the entire field is null.
 * Filter rather than throw — a single stray element or null field must not cost us the whole plan
 * and send the chat down the fallback path.
 */
const termArray = z
  .union([z.array(z.unknown()), z.null()])
  .optional()
  .transform(arr => (arr ?? []).filter((t): t is string => typeof t === 'string'));

/**
 * Qwen returns JSON null (not an absent key) for a field that does not apply about as often as it
 * omits it — the same behaviour that broke DocumentMetadataSchema. Treat null as absent.
 */
const nullableOptionalString = z
  .union([z.string(), z.null()])
  .optional()
  .transform(v => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined));

const optionalLimit = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform(v => {
    const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
    return Number.isInteger(n) && n > 0 && n <= 50 ? n : undefined;
  });

export const StructuredQuerySchema = z.object({
  docTypes: termArray,
  entities: termArray,
  keywords: termArray,
  notTerms: termArray,
  category: nullableOptionalString,
  subcategory: nullableOptionalString,
  dateFrom: nullableOptionalString,
  dateTo: nullableOptionalString,
  limit: optionalLimit,
});

export type StructuredQuery = z.infer<typeof StructuredQuerySchema>;

/** Terms that tokenise to nothing make FTS5 raise "fts5: syntax error near ..." on the MATCH. */
function hasSearchableContent(term: string): boolean {
  return /[\p{L}\p{N}]/u.test(term);
}

/**
 * Emits a term as an FTS5 phrase. Quoting is not cosmetic: FTS5 reads `-`, `*`, `:`, `(`, `)`,
 * `^`, `NEAR`, `AND`, `OR` and `NOT` as query syntax, and these terms are produced by a model
 * that has read untrusted document text. A phrase literal is the one form that cannot be
 * reinterpreted as an operator. Internal double quotes are escaped by doubling, per SQLite.
 */
function toFtsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function normaliseFacet(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (!hasSearchableContent(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * Compiles a StructuredQuery into an FTS5 MATCH expression.
 *
 * Facets are ANDed, terms within a facet are ORed: "what kind of document" AND "whose" AND
 * "about what". Returns null when no positive facet survives — the caller must treat that as
 * "no FTS query is possible" rather than running an empty MATCH.
 */
export function buildFtsMatchExpression(q: StructuredQuery): string | null {
  const facets = [q.docTypes, q.entities, q.keywords]
    .map(normaliseFacet)
    .filter(terms => terms.length > 0)
    .map(terms => `(${terms.map(toFtsPhrase).join(' OR ')})`);

  if (facets.length === 0) return null;

  const positive = facets.join(' AND ');
  const nots = normaliseFacet(q.notTerms);
  if (nots.length === 0) return positive;

  // FTS5 precedence is NOT > AND > OR, so `A AND B NOT C` would parse as `A AND (B NOT C)` and
  // apply the exclusion to one facet only. Parenthesise the whole positive side.
  return `(${positive}) NOT (${nots.map(toFtsPhrase).join(' OR ')})`;
}
