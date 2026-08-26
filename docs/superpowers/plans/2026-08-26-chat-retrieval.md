# Chat Retrieval (Query Planning + FTS5/BM25) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat assistant's in-memory substring scorer with a two-stage pipeline — Qwen plans a faceted structured query, weighted BM25 over the existing FTS5 index retrieves, Qwen answers — so that asking for a RIB returns RIBs instead of eight account statements.

**Architecture:** A new pure domain module (`src/domain/chat-query.ts`) owns the query contract, the FTS5 expression compiler and a deterministic heuristic planner — all zero-I/O and unit-tested. `database.ts` gains one retrieval helper. `ai-chat-assistant.ts` becomes orchestration only: plan → retrieve → relax if empty → answer. The existing token scorer survives as the last-resort fallback so the chat degrades instead of failing.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node.js, SQLite via `sqlite`/`sqlite3` with FTS5, Zod for boundary validation, Vitest for tests, Ollama `qwen3.5:9b`.

**Spec:** [docs/superpowers/specs/2026-08-26-chat-retrieval-design.md](../specs/2026-08-26-chat-retrieval-design.md)

## Global Constraints

- **Only `qwen3.5:9b`.** Golden Rule #14. Never introduce another generation model.
- **Never hardcode personal data** in `prompts/`, `src/domain/*`, or any committed file. Real employers, banks, clinics and scanner prefixes live in the gitignored `.prompts.private.json`. `src/domain/prompt-hygiene.test.ts` fails the build on a leak.
- **No DI container, aggregate classes, domain-event bus, unit of work, or command dispatcher.** The wired 3-layer design is the architecture: `index.ts` → `http/web-server.ts` → `application/*` → `domain/*` + `infrastructure/*`. Domain functions are pure and parameter-injected.
- **Domain layer is zero-I/O.** `src/domain/*` must not import from `src/infrastructure/*` or touch the filesystem, the database, or the network.
- **ESM import specifiers end in `.js`** even for TypeScript sources (e.g. `import { x } from './chat-query.js'`).
- **Never run `npm run dev`.** If the server must be restarted, instruct the user.
- **All 726 existing tests must stay green** and `npm run typecheck` must stay clean at every commit.
- **The eval fixture holds personal data** (real queries, real document IDs) — `.chat-eval.private.json` is gitignored; only `.chat-eval.private.json.example` is committed.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/domain/chat-query.ts` (new) | The `StructuredQuery` contract (Zod), `buildFtsMatchExpression` (compiler), `planQueryHeuristic` (deterministic fallback planner), `relaxQuery` (the ladder). Pure, zero I/O. |
| `src/domain/chat-query.test.ts` (new) | Unit tests for all four exports. No database, no Ollama. |
| `src/infrastructure/db/database.ts` (modify) | Add `searchDocumentsFts()` — the only place a `MATCH` query lives. |
| `src/application/chat-query-planner.ts` (new) | Builds the planner prompt from the live taxonomy, calls Ollama, validates with Zod, falls back to the heuristic planner. |
| `src/application/ai-chat-assistant.ts` (modify) | Orchestration only: plan → retrieve → relax → answer. Drops `isPaySlipQuery`. |
| `src/infrastructure/mcp/mcp-server.ts` (modify) | `prepare_dossier` routes through the new path. |
| `src/infrastructure/ollama-client.ts` (modify) | `generateEmbedding` warns instead of swallowing. |
| `scripts/eval-chat-search.mjs` (new) | The ground-truth harness. Run by hand, not in `npm test`. |

The planner lives in `application/` rather than `domain/` because it performs I/O (Ollama) and reads the live taxonomy. Only the pure parts — contract, compiler, heuristic, ladder — are in `domain/`.

---

### Task 1: The query contract and the FTS5 compiler

**Files:**
- Create: `src/domain/chat-query.ts`
- Test: `src/domain/chat-query.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `StructuredQuerySchema` — Zod schema.
  - `type StructuredQuery = z.infer<typeof StructuredQuerySchema>` with fields `docTypes: string[]`, `entities: string[]`, `keywords: string[]`, `notTerms: string[]`, `category?: string`, `subcategory?: string`, `dateFrom?: string`, `dateTo?: string`, `limit?: number`.
  - `buildFtsMatchExpression(q: StructuredQuery): string | null`.

This is the security boundary of the whole feature: the terms come from an LLM that read untrusted document text, and this function is what stops that text reaching the FTS5 parser as syntax. Test it hardest.

- [ ] **Step 1: Write the failing tests**

Create `src/domain/chat-query.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { StructuredQuerySchema, buildFtsMatchExpression, type StructuredQuery } from './chat-query.js';

function q(overrides: Partial<StructuredQuery> = {}): StructuredQuery {
  return { docTypes: [], entities: [], keywords: [], notTerms: [], ...overrides };
}

describe('StructuredQuerySchema', () => {
  it('fills the four term arrays with empty defaults when absent', () => {
    const parsed = StructuredQuerySchema.parse({});
    expect(parsed).toEqual({ docTypes: [], entities: [], keywords: [], notTerms: [] });
  });

  it('accepts explicit null on optional string fields, as Qwen frequently emits', () => {
    const parsed = StructuredQuerySchema.parse({ category: null, dateFrom: null });
    expect(parsed.category).toBeUndefined();
    expect(parsed.dateFrom).toBeUndefined();
  });

  it('coerces a stringified limit and rejects an absurd one', () => {
    expect(StructuredQuerySchema.parse({ limit: '3' }).limit).toBe(3);
    expect(StructuredQuerySchema.parse({ limit: 9999 }).limit).toBeUndefined();
  });

  it('drops non-string entries inside a term array instead of throwing', () => {
    expect(StructuredQuerySchema.parse({ keywords: ['rib', 42, null] }).keywords).toEqual(['rib']);
  });
});

describe('buildFtsMatchExpression', () => {
  it('ORs terms inside a facet and ANDs the facets', () => {
    expect(buildFtsMatchExpression(q({ docTypes: ['rib'], entities: ['credit mutuel'] })))
      .toBe('("rib") AND ("credit mutuel")');
  });

  it('reproduces the expression proven against the real index', () => {
    expect(buildFtsMatchExpression(q({
      docTypes: ['rib', 'identité bancaire'],
      entities: ['mutuel', 'credit mutuel'],
    }))).toBe('("rib" OR "identité bancaire") AND ("mutuel" OR "credit mutuel")');
  });

  it('parenthesises the positive part before NOT, because FTS5 binds NOT tighter than AND', () => {
    // Without the outer parens, `A AND B NOT C` parses as `A AND (B NOT C)` and the
    // exclusion would only apply to the second facet.
    expect(buildFtsMatchExpression(q({
      docTypes: ['rib'],
      entities: ['mutuel'],
      notTerms: ['relevé de compte'],
    }))).toBe('(("rib") AND ("mutuel")) NOT ("relevé de compte")');
  });

  it('returns null when every facet is empty, so the caller knows no FTS query is possible', () => {
    expect(buildFtsMatchExpression(q())).toBeNull();
    expect(buildFtsMatchExpression(q({ notTerms: ['x'] }))).toBeNull();
  });

  it('escapes embedded double quotes by doubling them', () => {
    expect(buildFtsMatchExpression(q({ keywords: ['le "vrai" doc'] })))
      .toBe('("le ""vrai"" doc")');
  });

  it.each([
    ['a NEAR/2 b'], ['col:value'], ['wild*card'], ['(paren)'], ['dash-term'],
    ['AND'], ['OR'], ['NOT'], ['^caret'], ['a AND b OR c'],
  ])('neutralises FTS5 syntax in %j by quoting it as a phrase', (term) => {
    const expr = buildFtsMatchExpression(q({ keywords: [term] }));
    expect(expr).toBe(`("${term}")`);
  });

  it('drops terms with no alphanumeric content, which tokenise to nothing and error the MATCH', () => {
    expect(buildFtsMatchExpression(q({ keywords: ['???', '  ', '-', 'rib'] }))).toBe('("rib")');
  });

  it('drops a facet that becomes empty after filtering rather than emitting ()', () => {
    expect(buildFtsMatchExpression(q({ docTypes: ['???'], entities: ['mutuel'] })))
      .toBe('("mutuel")');
  });

  it('trims surrounding whitespace and de-duplicates case-insensitively within a facet', () => {
    expect(buildFtsMatchExpression(q({ keywords: ['  RIB  ', 'rib', 'Rib'] }))).toBe('("RIB")');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/chat-query.test.ts`
Expected: FAIL — `Failed to resolve import "./chat-query.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/chat-query.ts`:

```ts
import { z } from 'zod';

/**
 * A term array as Qwen actually emits it: usually strings, occasionally with a null or a number
 * mixed in, occasionally the key is absent entirely. Filter rather than throw — a single stray
 * element must not cost us the whole plan and send the chat down the fallback path.
 */
const termArray = z
  .array(z.unknown())
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/chat-query.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Verify the whole suite and types are still clean**

Run: `npm test && npm run typecheck`
Expected: 727+ tests pass, typecheck silent.

- [ ] **Step 6: Commit**

```bash
git add src/domain/chat-query.ts src/domain/chat-query.test.ts
git commit -m "feat(chat): add StructuredQuery contract and FTS5 expression compiler"
```

---

### Task 2: The deterministic heuristic planner and the relaxation ladder

**Files:**
- Modify: `src/domain/chat-query.ts`
- Test: `src/domain/chat-query.test.ts`

**Interfaces:**
- Consumes: `StructuredQuery`, `buildFtsMatchExpression` from Task 1.
- Produces:
  - `planQueryHeuristic(userMessage: string, knownTags?: string[]): StructuredQuery`
  - `relaxQuery(q: StructuredQuery): StructuredQuery | null` — returns the next-broader query, or `null` when nothing further can be dropped.

`planQueryHeuristic` is what keeps the chat working with Ollama stopped. `relaxQuery` is what turns "no results" into an imperfect but useful answer. Both pure.

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/chat-query.test.ts`:

```ts
import { planQueryHeuristic, relaxQuery } from './chat-query.js';

describe('planQueryHeuristic', () => {
  it('drops French stopwords and the filler that polluted the old scorer', () => {
    const plan = planQueryHeuristic("RIB de credit mutuel j'ai besoin");
    expect(plan.keywords).not.toContain('besoin');
    expect(plan.keywords).not.toContain('de');
    expect(plan.keywords.map(k => k.toLowerCase())).toEqual(
      expect.arrayContaining(['rib', 'credit', 'mutuel'])
    );
  });

  it('promotes a token matching a known tag into the entities facet', () => {
    const plan = planQueryHeuristic('relevé credit_mutuel 2023', ['credit_mutuel', 'rib']);
    expect(plan.entities).toContain('credit_mutuel');
    expect(plan.keywords).not.toContain('credit_mutuel');
  });

  it('extracts a bare year into an ISO date range and out of the keywords', () => {
    const plan = planQueryHeuristic('relevé de compte 2023');
    expect(plan.dateFrom).toBe('2023-01-01');
    expect(plan.dateTo).toBe('2023-12-31');
    expect(plan.keywords).not.toContain('2023');
  });

  it('ignores a 4-digit number that is not a plausible document year', () => {
    const plan = planQueryHeuristic('facture 9999');
    expect(plan.dateFrom).toBeUndefined();
  });

  it('produces a compilable expression for a realistic query', () => {
    expect(buildFtsMatchExpression(planQueryHeuristic('bulletin de salaire'))).not.toBeNull();
  });

  it('returns an all-empty plan for a message of pure stopwords, so the caller falls back', () => {
    const plan = planQueryHeuristic("j'ai besoin de le la les");
    expect(buildFtsMatchExpression(plan)).toBeNull();
  });
});

describe('relaxQuery', () => {
  const full: StructuredQuery = {
    docTypes: ['rib'], entities: ['credit mutuel'], keywords: ['2023'], notTerms: ['relevé'],
  };

  it('drops keywords first — the weakest facet', () => {
    const r = relaxQuery(full)!;
    expect(r.keywords).toEqual([]);
    expect(r.notTerms).toEqual(['relevé']);
    expect(r.entities).toEqual(['credit mutuel']);
  });

  it('drops notTerms second', () => {
    const r = relaxQuery(relaxQuery(full)!)!;
    expect(r.notTerms).toEqual([]);
    expect(r.entities).toEqual(['credit mutuel']);
  });

  it('drops entities third, keeping the document type longest', () => {
    const r = relaxQuery(relaxQuery(relaxQuery(full)!)!)!;
    expect(r.entities).toEqual([]);
    expect(r.docTypes).toEqual(['rib']);
  });

  it('returns null once only docTypes remain, so the ladder terminates', () => {
    let q: StructuredQuery | null = full;
    for (let i = 0; i < 3; i++) q = relaxQuery(q!);
    expect(relaxQuery(q!)).toBeNull();
  });

  it('preserves the taxonomy and date filters at every rung', () => {
    const r = relaxQuery({ ...full, category: 'bank', dateFrom: '2023-01-01' })!;
    expect(r.category).toBe('bank');
    expect(r.dateFrom).toBe('2023-01-01');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/chat-query.test.ts`
Expected: FAIL — `planQueryHeuristic is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/domain/chat-query.ts`:

```ts
/**
 * French and English function words plus the conversational filler people put in a chat box
 * ("j'ai besoin", "peux-tu"). The old scorer had no stopword list at all, so `besoin` was a
 * search term with the same standing as `rib`.
 */
const STOPWORDS = new Set([
  'ai', 'aux', 'avec', 'avoir', 'besoin', 'cette', 'ces', 'dans', 'des', 'donne', 'donner',
  'elle', 'est', 'et', 'eux', 'faire', 'fait', 'iel', 'ils', 'les', 'leur', 'mais', 'merci',
  'mes', 'moi', 'mon', 'nos', 'notre', 'nous', 'ont', 'ou', 'par', 'pas', 'peux', 'peut',
  'plus', 'pour', 'pouvez', 'quel', 'quelle', 'quels', 'quelles', 'que', 'qui', 'sur', 'ses',
  'son', 'sont', 'tous', 'tout', 'toute', 'toutes', 'trouve', 'trouver', 'une', 'veux',
  'voir', 'vos', 'votre', 'vous',
  'a', 'about', 'all', 'and', 'any', 'are', 'can', 'find', 'for', 'from', 'get', 'give',
  'have', 'i', 'is', 'me', 'my', 'need', 'of', 'please', 'show', 'some', 'the', 'to', 'want',
  'with', 'you', 'your',
]);

/** Bounds a bare 4-digit number to something that could plausibly be a document year. */
function isPlausibleDocumentYear(n: number): boolean {
  return n >= 1950 && n <= 2100;
}

/**
 * Deterministic, zero-I/O planner. This is the fallback that keeps the chat usable when Ollama
 * is stopped or returns unparseable JSON, and the fast path for the eval harness's --no-llm mode.
 * It is deliberately dumber than the model: stopwords out, years into a date range, tokens that
 * match a known tag promoted to entities, everything else a keyword.
 */
export function planQueryHeuristic(userMessage: string, knownTags: string[] = []): StructuredQuery {
  const tagSet = new Set(knownTags.map(t => t.toLowerCase()));
  const entities: string[] = [];
  const keywords: string[] = [];
  let dateFrom: string | undefined;
  let dateTo: string | undefined;

  const tokens = userMessage
    .toLowerCase()
    .split(/[\s,.;:!?/\\'"()[\]]+/)
    .map(t => t.trim())
    .filter(Boolean);

  for (const token of tokens) {
    if (/^\d{4}$/.test(token)) {
      const year = parseInt(token, 10);
      if (isPlausibleDocumentYear(year)) {
        dateFrom = `${year}-01-01`;
        dateTo = `${year}-12-31`;
        continue;
      }
    }
    if (token.length <= 2 || STOPWORDS.has(token)) continue;
    if (tagSet.has(token)) entities.push(token);
    else keywords.push(token);
  }

  return StructuredQuerySchema.parse({ entities, keywords, dateFrom, dateTo });
}

/**
 * One rung down the relaxation ladder: keywords, then notTerms, then entities. Returns null when
 * only docTypes (and the filters) remain — the document type is what the user is least willing to
 * compromise on, so it is never dropped, and the ladder must terminate.
 */
export function relaxQuery(q: StructuredQuery): StructuredQuery | null {
  if (q.keywords.length > 0) return { ...q, keywords: [] };
  if (q.notTerms.length > 0) return { ...q, notTerms: [] };
  if (q.entities.length > 0) return { ...q, entities: [] };
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/chat-query.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the whole suite and types**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/domain/chat-query.ts src/domain/chat-query.test.ts
git commit -m "feat(chat): add heuristic planner and relaxation ladder"
```

---

### Task 3: The BM25 retrieval helper

**Files:**
- Modify: `src/infrastructure/db/database.ts` (append near `getAllDocuments`, around line 436)

**Interfaces:**
- Consumes: `buildFtsMatchExpression` output (a `string`), `DocumentRecord`.
- Produces: `searchDocumentsFts(matchExpr: string, filters?: FtsSearchFilters, limit?: number): Promise<DocumentRecord[]>` and `export interface FtsSearchFilters { category?: string; subcategory?: string; dateFrom?: string; dateTo?: string }`.

This is the only place in the repo where an FTS5 `MATCH` runs. It throws on a malformed expression or an FTS5-less SQLite build; the application layer catches (Task 5).

There is no unit test here: it needs a real SQLite handle, and the project's Vitest suite is pure-logic only. Task 7's harness is what exercises it against the real index, and Task 5's orchestration tests mock it.

- [ ] **Step 1: Write the implementation**

Add to `src/infrastructure/db/database.ts`, immediately after `getDocumentByChecksum`:

```ts
export interface FtsSearchFilters {
  category?: string;
  subcategory?: string;
  /** Inclusive ISO YYYY-MM-DD bound compared against documents.date, which is stored ISO. */
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Column weights for bm25(), in documents_fts schema order. Title and tags carry the signal:
 * tags hold the document type (a RIB is tagged 'rib', a statement 'releve_compte') which is the
 * dimension the old substring scorer had no way to express.
 *
 * raw_text is deliberately 0.5. It earns its place on recall — it is what surfaces a document
 * whose title was corrupted by OCR — but a word buried in four pages must never outweigh a word
 * in the title, which is exactly how account statements crowded out the RIB.
 */
const BM25_WEIGHTS = [
  0.0,  // doc_id (UNINDEXED)
  10.0, // title
  1.0,  // original_filename
  1.0,  // original_path
  1.0,  // new_path
  1.0,  // registre
  3.0,  // summary
  2.0,  // category
  2.0,  // subcategory
  6.0,  // tags
  0.5,  // raw_text
].join(',');

/**
 * Ranked full-text search over documents_fts.
 *
 * Filters are applied in SQL, not in JavaScript afterwards: a filter applied after LIMIT would
 * silently return fewer rows than asked for.
 *
 * Throws if the expression is malformed or SQLite was built without FTS5. Callers must catch and
 * degrade — the chat must never surface a search error to the user.
 */
export async function searchDocumentsFts(
  matchExpr: string,
  filters: FtsSearchFilters = {},
  limit: number = 10
): Promise<DocumentRecord[]> {
  const db = await getDb();
  const conditions: string[] = ['documents_fts MATCH ?'];
  const params: Array<string | number> = [matchExpr];

  if (filters.category) {
    conditions.push('d.category = ?');
    params.push(filters.category);
  }
  if (filters.subcategory) {
    conditions.push('d.subcategory = ?');
    params.push(filters.subcategory);
  }
  // Documents with an empty date are excluded from a bounded search rather than sorting as '' —
  // 72 of 861 have no date and would otherwise all pass a >= filter.
  if (filters.dateFrom) {
    conditions.push("d.date <> '' AND d.date >= ?");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    conditions.push("d.date <> '' AND d.date <= ?");
    params.push(filters.dateTo);
  }
  params.push(limit);

  return db.all<DocumentRecord[]>(
    `SELECT d.*
       FROM documents_fts f
       JOIN documents d ON d.id = f.doc_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY bm25(documents_fts, ${BM25_WEIGHTS})
      LIMIT ?`,
    params
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: silent.

- [ ] **Step 3: Prove it against the real index**

Run this one-off (it reads the real database read-only and asserts the spec's success criterion #1):

```bash
node -e "
const sqlite3=require('sqlite3');
const db=new sqlite3.Database('pdf_triage.db',sqlite3.OPEN_READONLY);
const w='0.0,10.0,1.0,1.0,1.0,1.0,3.0,2.0,2.0,6.0,0.5';
const m='(\"rib\" OR \"identité bancaire\") AND (\"mutuel\" OR \"credit mutuel\")';
db.all('SELECT d.id,d.title FROM documents_fts f JOIN documents d ON d.id=f.doc_id WHERE documents_fts MATCH ? ORDER BY bm25(documents_fts,'+w+') LIMIT 3',[m],
 (e,r)=>{ if(e) throw e; console.table(r); });
"
```
Expected: rows `4280` then `4592` in the top two, and no account statement in the top three.

- [ ] **Step 4: Commit**

```bash
git add src/infrastructure/db/database.ts
git commit -m "feat(db): add searchDocumentsFts, the first BM25 query against the FTS5 index"
```

---

### Task 4: The Qwen query planner

**Files:**
- Create: `src/application/chat-query-planner.ts`
- Test: `src/application/chat-query-planner.test.ts`

**Interfaces:**
- Consumes: `StructuredQuerySchema`, `planQueryHeuristic` (Task 1/2); `requestTextChatCompletion` from `../infrastructure/ollama-client.js`; `cleanAndParseJSON` from `../domain/classification.js`; `getCategoriesConfig` from `../infrastructure/categories-store.js`.
- Produces:
  - `buildPlannerPrompt(userMessage: string, categoryIds: string[], now: Date): { system: string; userPrompt: string }`
  - `planQuery(userMessage: string, now?: Date): Promise<StructuredQuery>` — never throws; falls back to `planQueryHeuristic`.

The prompt is built from the **live** taxonomy passed in as a parameter — never a hardcoded entity list. That is what keeps `prompt-hygiene.test.ts` green.

- [ ] **Step 1: Write the failing tests**

Create `src/application/chat-query-planner.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../infrastructure/ollama-client.js', () => ({
  requestTextChatCompletion: vi.fn(),
}));
vi.mock('../infrastructure/categories-store.js', () => ({
  getCategoriesConfig: () => ({ categories: [{ id: 'bank' }, { id: 'identity' }] }),
}));

import { requestTextChatCompletion } from '../infrastructure/ollama-client.js';
import { buildPlannerPrompt, planQuery } from './chat-query-planner.js';

const mocked = vi.mocked(requestTextChatCompletion);

beforeEach(() => vi.clearAllMocks());

describe('buildPlannerPrompt', () => {
  it('lists the live taxonomy so the model cannot invent a category', () => {
    const { system } = buildPlannerPrompt('rib', ['bank', 'identity'], new Date('2026-08-26'));
    expect(system).toContain('bank');
    expect(system).toContain('identity');
  });

  it('grounds the prompt in the current date for relative expressions', () => {
    const { system } = buildPlannerPrompt('les 3 derniers mois', ['bank'], new Date('2026-08-26'));
    expect(system).toContain('2026');
  });

  it('contains no personal entity — the taxonomy is the only source of names', () => {
    const { system, userPrompt } = buildPlannerPrompt('rib', ['bank'], new Date('2026-08-26'));
    expect(`${system}\n${userPrompt}`.toLowerCase()).not.toMatch(/paribas|mutuel|foncia/);
  });
});

describe('planQuery', () => {
  it('parses a well-formed plan from the model', async () => {
    mocked.mockResolvedValue({ response: JSON.stringify({
      docTypes: ['rib'], entities: ['credit mutuel'], keywords: [], notTerms: ['relevé de compte'],
    }) });
    const plan = await planQuery('RIB credit mutuel');
    expect(plan.docTypes).toEqual(['rib']);
    expect(plan.notTerms).toEqual(['relevé de compte']);
  });

  it('unwraps a plan the model fenced in a markdown code block', async () => {
    mocked.mockResolvedValue({ response: '```json\n{"docTypes":["rib"]}\n```' });
    expect((await planQuery('rib')).docTypes).toEqual(['rib']);
  });

  it('falls back to the heuristic planner when Ollama is unreachable', async () => {
    mocked.mockRejectedValue(new Error('ECONNREFUSED'));
    const plan = await planQuery("RIB de credit mutuel j'ai besoin");
    expect(plan.keywords.map(k => k.toLowerCase())).toContain('rib');
    expect(plan.keywords).not.toContain('besoin');
  });

  it('falls back to the heuristic planner when the model returns unparseable text', async () => {
    mocked.mockResolvedValue({ response: 'Bien sûr ! Voici votre RIB.' });
    expect((await planQuery('rib credit mutuel')).keywords.length).toBeGreaterThan(0);
  });

  it('falls back when the model returns valid JSON that yields no searchable facet', async () => {
    mocked.mockResolvedValue({ response: '{"docTypes":[],"entities":[],"keywords":[]}' });
    expect((await planQuery('rib credit mutuel')).keywords.length).toBeGreaterThan(0);
  });

  it('never throws, whatever the model does', async () => {
    mocked.mockResolvedValue({ response: null as unknown as string });
    await expect(planQuery('rib')).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/application/chat-query-planner.test.ts`
Expected: FAIL — cannot resolve `./chat-query-planner.js`.

- [ ] **Step 3: Write the implementation**

Create `src/application/chat-query-planner.ts`:

```ts
import {
  StructuredQuerySchema,
  buildFtsMatchExpression,
  planQueryHeuristic,
  type StructuredQuery,
} from '../domain/chat-query.js';
import { cleanAndParseJSON, formatLocalDate } from '../domain/classification.js';
import { requestTextChatCompletion } from '../infrastructure/ollama-client.js';
import { getCategoriesConfig } from '../infrastructure/categories-store.js';
import { logger } from '../infrastructure/logger.js';

/**
 * Builds the planner prompt. The category list is a parameter, read from the live taxonomy by the
 * caller — never a literal here. Committed prompts stay free of personal entities (Golden Rule);
 * the model learns real names from the taxonomy at runtime, not from this file.
 */
export function buildPlannerPrompt(
  userMessage: string,
  categoryIds: string[],
  now: Date
): { system: string; userPrompt: string } {
  const system = `Tu convertis une demande de document en requête de recherche structurée JSON.
Tu ne réponds JAMAIS à la demande — tu produis UNIQUEMENT l'objet JSON.

Nous sommes le ${formatLocalDate(now)}. Résous toute expression temporelle relative
("les 3 derniers mois", "cette année", "l'an dernier") en dates ISO à partir de cette date.

Catégories disponibles: ${categoryIds.join(', ')}.

Renvoie exactement cet objet:
{
  "docTypes": [],   // le TYPE de document demandé, avec ses synonymes usuels et son sigle.
                    // Ex: pour un RIB -> ["rib", "relevé d'identité bancaire", "iban", "bic"]
  "entities":  [],  // l'organisme / l'émetteur cité, avec ses variantes et abréviations
  "keywords":  [],  // les autres termes porteurs de sens (jamais de mots vides)
  "notTerms":  [],  // les types de documents à EXCLURE quand ils se confondent avec la demande.
                    // Ex: pour un RIB -> ["relevé de compte", "mouvement"]
  "category":  null,        // une des catégories ci-dessus, ou null
  "subcategory": null,
  "dateFrom":  null,        // "YYYY-MM-DD" ou null
  "dateTo":    null,
  "limit":     null         // nombre de documents demandé, ou null
}

Règles:
- Mets des SYNONYMES dans docTypes: c'est ce qui rattrape un document mal titré.
- notTerms est ce qui sépare deux documents du même organisme. Utilise-le.
- N'invente pas de catégorie absente de la liste. Dans le doute, null.
- Aucun texte hors du JSON.`;

  return { system, userPrompt: `Demande: "${userMessage}"` };
}

/**
 * Turns a free-text request into a StructuredQuery.
 *
 * Never throws and never returns an unusable plan: any failure — Ollama down, prose instead of
 * JSON, valid JSON with nothing searchable in it — degrades to the deterministic heuristic
 * planner, so the chat keeps working without a model.
 */
export async function planQuery(userMessage: string, now: Date = new Date()): Promise<StructuredQuery> {
  const fallback = () => planQueryHeuristic(userMessage);

  try {
    const categoryIds = getCategoriesConfig().categories.map(c => c.id);
    const { system, userPrompt } = buildPlannerPrompt(userMessage, categoryIds, now);
    const { response } = await requestTextChatCompletion(system, userPrompt);

    const plan = StructuredQuerySchema.parse(cleanAndParseJSON(response ?? ''));
    if (buildFtsMatchExpression(plan) === null) {
      logger.warn('CHAT_PLANNER', 'Model plan had no searchable facet; using heuristic planner.');
      return fallback();
    }
    return plan;
  } catch (err: any) {
    logger.warn('CHAT_PLANNER', `Planner failed (${err?.message}); using heuristic planner.`);
    return fallback();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/application/chat-query-planner.test.ts`
Expected: PASS.

If `formatLocalDate` is not exported from `src/domain/classification.ts`, check its actual export site (`ai-chat-assistant.ts` imports it from there) and adjust the import path rather than duplicating the function.

- [ ] **Step 5: Verify the whole suite, types, and prompt hygiene**

Run: `npm test && npm run typecheck`
Expected: green, including `src/domain/prompt-hygiene.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/application/chat-query-planner.ts src/application/chat-query-planner.test.ts
git commit -m "feat(chat): add Qwen query planner with deterministic fallback"
```

---

### Task 5: Rewire the chat orchestration

**Files:**
- Modify: `src/application/ai-chat-assistant.ts`
- Test: `src/application/ai-chat-assistant.test.ts`

**Interfaces:**
- Consumes: `planQuery` (Task 4), `buildFtsMatchExpression` / `relaxQuery` (Tasks 1-2), `searchDocumentsFts` (Task 3).
- Produces: `retrieveDocuments(userMessage: string, now?: Date): Promise<DocumentRecord[]>` — the new retrieval entry point, exported so Task 6's MCP tool and Task 7's harness both use it.

The five existing tests in this file cover two real user-reported bug fixes. **They must stay green unmodified.** If one fails, the fix is the implementation, not the test.

- [ ] **Step 1: Write the failing tests**

First, **extend the existing `database.js` mock factory at the top of the file**. It currently
spreads the real module and replaces only `getAllDocuments`, which means `searchDocumentsFts`
would run for real and open the production database from a unit test:

```ts
vi.mock('../infrastructure/db/database.js', async () => {
  const actual = await vi.importActual('../infrastructure/db/database.js') as any;
  return {
    ...actual,
    getAllDocuments: vi.fn(),
    searchDocumentsFts: vi.fn()   // <- add this line
  };
});
```

Add the planner mock next to the other `vi.mock` calls at the top of the file (`vi.mock` is
hoisted, but keeping them together is how this file reads):

```ts
vi.mock('./chat-query-planner.js', () => ({ planQuery: vi.fn() }));
```

Then extend the import line to pull in the new export, and append the tests. Note the style this
file already uses — `import * as dbModule` plus `(dbModule.x as any)` — rather than `vi.mocked`:

```ts
import { searchRelevantDocuments, buildPromptContext, processChatQuery, retrieveDocuments } from './ai-chat-assistant.js';
import * as plannerModule from './chat-query-planner.js';

describe('retrieveDocuments', () => {
  const mockedPlan = () => plannerModule.planQuery as any;
  const mockedFts = () => dbModule.searchDocumentsFts as any;

  beforeEach(() => {
    vi.resetAllMocks();
    // The last-resort token scorer calls getAllDocuments; give it an empty archive by default so
    // only the tests that care about the fallback have to think about it.
    (dbModule.getAllDocuments as any).mockResolvedValue([]);
  });

  it('runs the compiled expression through FTS5 and returns its ranked rows', async () => {
    mockedPlan().mockResolvedValue({ docTypes: ['rib'], entities: ['credit mutuel'], keywords: [], notTerms: [] });
    mockedFts().mockResolvedValue([{ id: 4280, title: 'RIB' }]);

    const docs = await retrieveDocuments('RIB credit mutuel');

    expect(mockedFts()).toHaveBeenCalledWith(
      '("rib") AND ("credit mutuel")', expect.anything(), expect.any(Number)
    );
    expect(docs.map(d => d.id)).toEqual([4280]);
  });

  it('passes the taxonomy and date filters through to SQL', async () => {
    mockedPlan().mockResolvedValue({
      docTypes: ['rib'], entities: [], keywords: [], notTerms: [],
      category: 'bank', dateFrom: '2023-01-01', dateTo: '2023-12-31',
    });
    mockedFts().mockResolvedValue([{ id: 1 }]);

    await retrieveDocuments('rib 2023');

    expect(mockedFts()).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ category: 'bank', dateFrom: '2023-01-01', dateTo: '2023-12-31' }),
      expect.any(Number)
    );
  });

  it('climbs the relaxation ladder when the first query returns nothing', async () => {
    mockedPlan().mockResolvedValue({ docTypes: ['rib'], entities: ['ccm'], keywords: ['2023'], notTerms: [] });
    mockedFts().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 7 }]);

    const docs = await retrieveDocuments('rib ccm 2023');

    expect(mockedFts()).toHaveBeenCalledTimes(2);
    expect(mockedFts().mock.calls[1][0]).not.toContain('2023');
    expect(docs.map(d => d.id)).toEqual([7]);
  });

  it('falls back to the token scorer when FTS5 throws, never surfacing an error', async () => {
    mockedPlan().mockResolvedValue({ docTypes: ['rib'], entities: [], keywords: [], notTerms: [] });
    mockedFts().mockRejectedValue(new Error('no such module: fts5'));
    (dbModule.getAllDocuments as any).mockResolvedValue([
      { id: 99, title: 'RIB Banque', category: 'bank', subcategory: 'x', date: '2024-01-01', summary: '' },
    ]);

    const docs = await retrieveDocuments('rib');

    expect(docs).toBeInstanceOf(Array);
    expect(dbModule.getAllDocuments).toHaveBeenCalled();
  });

  it('honours an explicit count in the user words over the model limit', async () => {
    mockedPlan().mockResolvedValue({ docTypes: ['bulletin'], entities: [], keywords: [], notTerms: [], limit: 10 });
    mockedFts().mockResolvedValue([]);

    await retrieveDocuments('les 3 derniers bulletins de salaire');

    expect(mockedFts().mock.calls[0][2]).toBe(3);
  });

  it('does not read the French indefinite article as a request for exactly one document', async () => {
    // "j'ai besoin d'un RIB" is not a request for one document, it is a request for RIBs. Reading
    // it as a count of 1 would cap the search at a single row and drop the second RIB in the
    // archive — the exact document this whole change exists to surface.
    mockedPlan().mockResolvedValue({ docTypes: ['rib'], entities: [], keywords: [], notTerms: [] });
    mockedFts().mockResolvedValue([]);

    await retrieveDocuments("j'ai besoin d'un RIB");

    expect(mockedFts().mock.calls[0][2]).toBeGreaterThan(1);
  });

  it('still reads an explicit singular request as one document', async () => {
    mockedPlan().mockResolvedValue({ docTypes: ['bulletin'], entities: [], keywords: [], notTerms: [] });
    mockedFts().mockResolvedValue([]);

    await retrieveDocuments('mon dernier bulletin de salaire');

    expect(mockedFts().mock.calls[0][2]).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/application/ai-chat-assistant.test.ts`
Expected: FAIL — `retrieveDocuments` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/application/ai-chat-assistant.ts`:

1. Add imports:

```ts
import { searchDocumentsFts } from '../infrastructure/db/database.js';
import { buildFtsMatchExpression, relaxQuery, type StructuredQuery } from '../domain/chat-query.js';
import { planQuery } from './chat-query-planner.js';
```

2. Add `retrieveDocuments` above `buildPromptContext`:

```ts
/**
 * The retrieval entry point: plan the query, run it through BM25, relax it if it found nothing.
 *
 * The old token scorer survives only as the last resort — when FTS5 is unavailable, when the
 * MATCH throws, or when the ladder is exhausted. It is no longer the primary path.
 */
export async function retrieveDocuments(userMessage: string, now: Date = new Date()): Promise<DocumentRecord[]> {
  const plan = await planQuery(userMessage, now);

  // A number the user actually typed ("les 3 derniers") beats the model re-deriving it. The same
  // resolved value feeds citation pruning below, so retrieval and pruning cannot disagree about
  // how many documents were asked for — that disagreement is what silently dropped documents before.
  const limit = extractRequestedCount(userMessage) ?? plan.limit ?? 10;
  const filters = {
    category: plan.category,
    subcategory: plan.subcategory,
    dateFrom: plan.dateFrom,
    dateTo: plan.dateTo,
  };

  let current: StructuredQuery | null = plan;
  while (current) {
    const matchExpr = buildFtsMatchExpression(current);
    if (!matchExpr) break;
    try {
      const hits = await searchDocumentsFts(matchExpr, filters, limit);
      if (hits.length > 0) return hits;
    } catch (err: any) {
      logger.warn('CHAT_ASSISTANT', `FTS5 search failed (${err?.message}); using the token scorer.`);
      break;
    }
    current = relaxQuery(current);
  }

  return searchRelevantDocuments(userMessage);
}
```

3. Fix `extractRequestedCount`: remove `un` and `une` from the singular alternation, leaving
   `/\b(single|last|dernier|dernière)\b/i`. They are French indefinite articles, not quantities —
   "j'ai besoin d'un RIB" means "I need a RIB", not "return exactly one document". This was
   harmless while the count only sliced an already-fetched list; now that it caps the SQL `LIMIT`,
   it would cut the search to a single row on the most natural phrasing there is, and drop the
   second RIB. Leave the numeric and word-number branches (`trois`, `deux`) alone.

4. In `searchRelevantDocuments`, **delete the entire pay-slip branch** — from `const isPaySlipQuery = ...` through the `return dedupedPaySlips.slice(0, limit);` that closes it. Keep everything else: the general token scoring, the date sort, and the empty-match fallback. The function stays exported (Task 7's harness and the fallback path both use it).

   The pay-period de-duplication logic that lived in that branch is **not** lost — move it into a small exported helper and call it on the result of `retrieveDocuments`:

```ts
/**
 * Collapses re-scanned copies of the same pay period. Two imports of the same month must not
 * occupy two of the limited result slots and push a distinct, still-requested month out.
 */
export function dedupeByPeriod(docs: DocumentRecord[]): DocumentRecord[] {
  const byPeriod = new Map<string, DocumentRecord>();
  for (const doc of docs) {
    const ts = parseDocDate(doc.date);
    const periodKey = ts ? new Date(ts).toISOString().slice(0, 7) : `no-date-${doc.id}`;
    const existing = byPeriod.get(periodKey);
    if (!existing || doc.id > existing.id) byPeriod.set(periodKey, doc);
  }
  return [...byPeriod.values()];
}
```

5. In `processChatQuery`, replace the `handleMcpToolCall('prepare_dossier', ...)` block and the `searchRelevantDocuments` fallback with:

```ts
let matchedDocs = dedupeByPeriod(await retrieveDocuments(userMessage, now));
```

   Delete the now-unused `handleMcpToolCall` import. Leave the citation-pruning block below it untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/application/ai-chat-assistant.test.ts`
Expected: PASS — the five pre-existing tests **and** the six new ones.

If a pre-existing test fails, the implementation is wrong. Do not edit that test.

- [ ] **Step 5: Verify the whole suite and types**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/application/ai-chat-assistant.ts src/application/ai-chat-assistant.test.ts
git commit -m "feat(chat): retrieve via planned BM25 search with a relaxation ladder"
```

---

### Task 6: Route the MCP tool through the same engine, and stop swallowing embedding failures

**Files:**
- Modify: `src/infrastructure/mcp/mcp-server.ts:306-332` (the `prepare_dossier` handler)
- Modify: `src/infrastructure/ollama-client.ts:121-132` (`generateEmbedding`)

**Interfaces:**
- Consumes: `retrieveDocuments` (Task 5).
- Produces: nothing new.

One search engine, not two. External MCP agents get the same quality as the web chat.

- [ ] **Step 1: Point `prepare_dossier` at the new path**

In the `prepare_dossier` handler, replace the dynamic import of `searchRelevantDocuments` and its call:

```ts
const { retrieveDocuments } = await import('../../application/ai-chat-assistant.js');
const { detectFileType } = await import('../../domain/taxonomy.js');
const docs = await retrieveDocuments(dossierType);
```

Leave the `formatted` mapping and the JSON response shape exactly as they are — `ai-chat-assistant.ts` no longer calls this tool, but external agents depend on the shape.

Note: `dossierType` is currently lowercased before use. Keep the raw casing instead — pass `(args?.dossierType as string) || ''` — because the planner reads proper nouns better with their capitalisation intact.

- [ ] **Step 2: Make the embedding failure audible**

In `src/infrastructure/ollama-client.ts`, replace the silent catch:

```ts
export async function generateEmbedding(text: string): Promise<number[]> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  try {
    const response = await ollama.embeddings({
      model: CONFIG.OLLAMA_EMBED_MODEL,
      prompt: text.substring(0, 1000)
    });
    return response.embedding || [];
  } catch (err: any) {
    // This catch used to be silent, and that is how all 861 documents in the archive came to be
    // indexed with an empty embedding: the model is simply not installed, and nothing said so.
    logger.warn(
      'OLLAMA',
      `Embedding failed for model '${CONFIG.OLLAMA_EMBED_MODEL}' (${err?.message}). `
      + `Document indexed without a vector; run 'ollama pull ${CONFIG.OLLAMA_EMBED_MODEL}' to enable semantic search.`
    );
    return [];
  }
}
```

Add `import { logger } from './logger.js';` if it is not already imported in that file.

- [ ] **Step 3: Verify the suite and types**

Run: `npm test && npm run typecheck`
Expected: green, including `src/infrastructure/mcp/mcp-server.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/infrastructure/mcp/mcp-server.ts src/infrastructure/ollama-client.ts
git commit -m "feat(mcp): route prepare_dossier through planned BM25 search; warn on embedding failure"
```

---

### Task 7: The ground-truth eval harness

**Files:**
- Create: `scripts/eval-chat-search.mjs`
- Create: `.chat-eval.private.json.example`
- Modify: `.gitignore`
- Modify: `package.json` (add the `eval:chat` script)

**Interfaces:**
- Consumes: `retrieveDocuments` and `searchRelevantDocuments` (Task 5), `planQueryHeuristic` / `buildFtsMatchExpression` (Tasks 1-2), `searchDocumentsFts` (Task 3).
- Produces: a printed per-query and aggregate report.

This is what turns "it feels better" into a number, and what will later decide whether embeddings are worth installing.

- [ ] **Step 1: Add the gitignore entry**

Append to `.gitignore`, in the private-overlay block near `.prompts.private.json`:

```
# Chat-search evaluation fixture — your real queries and the document IDs they should return.
# Personal data; only .chat-eval.private.json.example is committed.
.chat-eval.private.json
```

- [ ] **Step 2: Write the committed example fixture**

Create `.chat-eval.private.json.example`:

```json
{
  "queries": [
    {
      "query": "RIB de credit mutuel j'ai besoin",
      "expectedIds": [4280, 4592],
      "note": "Must not return account statements. 4592 has an OCR-corrupted title."
    },
    {
      "query": "les 3 derniers bulletins de salaire",
      "expectedIds": [],
      "note": "Fill in with your own document IDs — see the dashboard card headers."
    }
  ]
}
```

- [ ] **Step 3: Write the harness**

Create `scripts/eval-chat-search.mjs`:

```js
#!/usr/bin/env node
/**
 * Ground-truth evaluation for chat document retrieval.
 *
 *   node scripts/eval-chat-search.mjs            # real Qwen planner
 *   node scripts/eval-chat-search.mjs --no-llm   # deterministic heuristic planner, fast
 *   node scripts/eval-chat-search.mjs --baseline # write the current numbers as the baseline
 *
 * Needs the real database, and (without --no-llm) a running Ollama. Deliberately NOT part of
 * `npm test`: the unit suite is pure-logic and must stay hermetic.
 */
import fs from 'node:fs';
import path from 'node:path';

const FIXTURE = '.chat-eval.private.json';
const BASELINE = '.chat-eval.baseline.json';
const noLlm = process.argv.includes('--no-llm');
const writeBaseline = process.argv.includes('--baseline');

if (!fs.existsSync(FIXTURE)) {
  console.error(`Missing ${FIXTURE}. Copy ${FIXTURE}.example and fill in your real document IDs.`);
  process.exit(1);
}

const { retrieveDocuments } = await import('../dist/application/ai-chat-assistant.js');
const { planQueryHeuristic, buildFtsMatchExpression } = await import('../dist/domain/chat-query.js');
const { searchDocumentsFts } = await import('../dist/infrastructure/db/database.js');

const { queries } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/** Rank-1-based reciprocal rank of the first expected hit; 0 when none is retrieved. */
function reciprocalRank(gotIds, expectedIds) {
  const i = gotIds.findIndex(id => expectedIds.includes(id));
  return i === -1 ? 0 : 1 / (i + 1);
}

async function runOne({ query, expectedIds }) {
  let gotIds;
  if (noLlm) {
    const expr = buildFtsMatchExpression(planQueryHeuristic(query));
    gotIds = expr ? (await searchDocumentsFts(expr, {}, 10)).map(d => d.id) : [];
  } else {
    gotIds = (await retrieveDocuments(query)).map(d => d.id);
  }

  const hits = gotIds.filter(id => expectedIds.includes(id));
  return {
    query,
    precision: gotIds.length ? hits.length / gotIds.length : 0,
    recall: expectedIds.length ? hits.length / expectedIds.length : 1,
    mrr: reciprocalRank(gotIds, expectedIds),
    got: gotIds.slice(0, 5),
  };
}

const results = [];
for (const q of queries) results.push(await runOne(q));

const mean = key => results.reduce((s, r) => s + r[key], 0) / (results.length || 1);
const summary = { precision: mean('precision'), recall: mean('recall'), mrr: mean('mrr') };

console.table(results.map(r => ({
  query: r.query.slice(0, 44),
  'P@10': r.precision.toFixed(2),
  recall: r.recall.toFixed(2),
  MRR: r.mrr.toFixed(2),
  top5: r.got.join(', '),
})));
console.log(`\nMode: ${noLlm ? 'heuristic (--no-llm)' : 'Qwen planner'}`);
console.log(`Mean  P@10 ${summary.precision.toFixed(3)} | recall ${summary.recall.toFixed(3)} | MRR ${summary.mrr.toFixed(3)}`);

if (writeBaseline) {
  fs.writeFileSync(BASELINE, JSON.stringify({ mode: noLlm ? 'heuristic' : 'llm', summary }, null, 2));
  console.log(`\nBaseline written to ${BASELINE}.`);
} else if (fs.existsSync(BASELINE)) {
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const delta = k => (summary[k] - base.summary[k]).toFixed(3);
  console.log(`\nvs baseline: P@10 ${delta('precision')} | recall ${delta('recall')} | MRR ${delta('mrr')}`);
  const regressed = ['precision', 'recall', 'mrr'].filter(k => summary[k] < base.summary[k] - 0.001);
  if (regressed.length) {
    console.error(`\nREGRESSION on: ${regressed.join(', ')}`);
    process.exit(1);
  }
}
```

Add the baseline file to `.gitignore` alongside the fixture (it records numbers derived from personal queries):

```
.chat-eval.baseline.json
```

- [ ] **Step 4: Add the npm script**

In `package.json` `scripts`, after `test:watch`:

```json
"eval:chat": "npm run build && node scripts/eval-chat-search.mjs"
```

The `npm run build` prefix matters: the harness imports from `dist/`, so a stale build would score the old code and quietly report the wrong numbers.

- [ ] **Step 5: Record the baseline against the current code**

Do this **before** trusting any comparison. Stash the feature work, build, and baseline the old behaviour:

```bash
git stash
npm run build && node scripts/eval-chat-search.mjs --baseline
git stash pop
```

Then build the new code and compare:

```bash
npm run eval:chat
```
Expected: precision, recall and MRR all at or above the baseline, and the RIB query returning 4280 and 4592.

If any metric regressed, stop and report the numbers. Do not adjust the fixture to make it pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/eval-chat-search.mjs .chat-eval.private.json.example .gitignore package.json
git commit -m "test(chat): add ground-truth retrieval eval harness"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/knowledge/architecture.md`, `docs/knowledge/data-model.md`
- Modify: `docs/agents/pipeline-engineer.md`, `docs/agents/db-registry-keeper.md`

Every notable change updates the docs in the same turn — that is the project's single-source-of-truth rule, and this change alters how retrieval works, which agent owns what, and what the FTS5 index is for.

- [ ] **Step 1: Add the CHANGELOG entry**

Under `## Unreleased`, add a `###` section following the existing style — a title that names the problem, the measured evidence, then what changed. Cover: the substring scorer with no IDF and no stopwords; the eight statements returned for a RIB query; the FTS5 index that existed and was never queried; the second RIB (#4592) recovered despite an OCR-corrupted title; the 861 empty embeddings and the silent catch behind them; and the deferral of embeddings pending harness numbers.

- [ ] **Step 2: Update the knowledge docs**

- `docs/knowledge/architecture.md` — document the chat retrieval flow: plan (Qwen) → compile → BM25 → relax → answer, with the fallbacks at each stage.
- `docs/knowledge/data-model.md` — record that `documents_fts` is now queried by `searchDocumentsFts`, list the BM25 column weights and say why `raw_text` is 0.5; note that `embedding` remains unpopulated and why.

- [ ] **Step 3: Update the agent playbooks**

- `docs/agents/pipeline-engineer.md` — add `src/application/chat-query-planner.ts` to the owned files.
- `docs/agents/db-registry-keeper.md` — add `searchDocumentsFts` and the BM25 weights as owned surface.

- [ ] **Step 4: Verify nothing drifted**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/
git commit -m "docs: record the chat retrieval rework"
```

---

## Verification Before Completion

Do not report this plan complete until all of the following have been run and their output seen:

1. `npm test` — all pre-existing tests plus the new ones, green.
2. `npm run typecheck` — silent.
3. `npm run eval:chat` — at or above baseline on every metric, with #4280 and #4592 returned for the RIB query and no account statement in the top three.
4. Ollama stopped (`ollama stop qwen3.5:9b` or equivalent), then a chat query issued — documents still returned, via the heuristic planner.

Report the actual numbers from step 3. If any check fails, say so with its output rather than describing the work as done.
