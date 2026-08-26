# Chat retrieval: query planning + FTS5/BM25

**Date:** 2026-08-26
**Status:** Approved, not yet implemented
**Owners:** pipeline-engineer (orchestration), db-registry-keeper (`searchDocumentsFts`), classification-expert (planner prompt)

## The problem

The chat assistant returns the wrong documents. Asked for a RIB from Crédit
Mutuel, it returned ten documents of which eight were BNP Paribas account
statements, and it missed a second RIB that is in the archive.

The cause is not the model. It is that `searchRelevantDocuments`
(`src/application/ai-chat-assistant.ts:70`) loads every document into memory
and scores them by counting substring hits of every query token longer than
two characters. Concretely, for the query `RIB de credit mutuel j'ai besoin`:

- The tokens are `rib`, `credit`, `mutuel`, `besoin`. There is no stopword
  list, so `besoin` is a search term.
- There is no IDF. `credit` and `mutuel` occur in dozens of statement
  summaries and score exactly as much as the rare, decisive `rib`.
- Document *type* is not a dimension. A RIB and an account statement are both
  `bank/credit_mutuel`.
- The only intent handled well is pay slips, via a hardcoded
  `isPaySlipQuery` chain of `lower.includes(...)` (line 79). Every new intent
  would need another branch.
- The model receives ten pre-filtered candidates once, with no ability to
  search again. Its "missing documents" suggestions are drawn from those ten,
  which is why it offered 2019 BNP statements as substitutes for a RIB.

Two better engines already exist in the database and are never queried:

| Asset | State |
| --- | --- |
| FTS5 `documents_fts` | Created, populated, kept in sync on every insert/update (`database.ts:159, 335, 425`). **No `MATCH` query exists anywhere in the repo.** |
| `embedding` column | Written on every triage (`triage-scan.ts:287`). **Empty on all 861 documents.** |

The embeddings are empty because `CONFIG.OLLAMA_EMBED_MODEL` is
`nomic-embed-text`, that model is not installed in the local Ollama, and
`generateEmbedding` (`ollama-client.ts:130`) swallows the failure with
`catch { return []; }`. 861 documents were indexed with `embedding: []`
without one log line. (Were it repaired, it would still encode only
`text.substring(0, 1000)`.)

## Evidence that FTS5 alone is enough

A weighted BM25 query run against the **existing, untouched** index, using the
expression a planner would produce for the failing query:

```
(rib OR "identité bancaire" OR "identite bancaire") AND (mutuel OR "credit mutuel")
```

| rank | doc | score | title |
| --- | --- | --- | --- |
| 1 | 4280 | -29.52 | Relevé d'identité bancaire - CCM Marseille Sainte Marguerite |
| 2 | 4592 | -19.28 | Relevé d'Identi**tai**re Bancaire - CCM Marseille Ste Marguerite |
| 3 | 4715 | -12.25 | RCE 00050974642 20200611 |
| 4+ | … | -9.3 to -8.2 | the account statements, all demoted |

(BM25 in SQLite returns negative scores; more negative is more relevant.)

Two things this settles:

1. The correct document ranks first with a clear margin, and the eight
   statements that polluted the answer fall below rank 4 with compressed
   scores. IDF does the work: `mutuel` is frequent and weakly discriminating,
   `rib` and `identité bancaire` are rare and decisive.
2. **A second RIB, #4592, surfaces — one the current assistant never found.**
   Its title carries an OCR corruption, "Relevé d'Identi*tai*re Bancaire". A
   `title.includes('identité bancaire')` misses it permanently; BM25 recovers
   it from `bancaire` plus `raw_text`. That is recall gained at no cost.

Document type also turns out to be present already, in `tags`:

| doc | tags |
| --- | --- |
| 4280 (RIB) | `["banking", "rib", "credit_mutuel", "iban"]` |
| 4440 (statement) | `["bank", "credit_mutuel", "relevé_compte", "mouvement_bancaire"]` |

No new column is required. Note the tag vocabulary does drift (`bank` vs
`banking`, `releve_compte` vs `relevé_compte`); normalizing it is worthwhile
but out of scope, and BM25 tolerates it.

## Decisions taken

| Decision | Choice | Why |
| --- | --- | --- |
| Priority | Precision and recall first | Chosen by the user; the conversational multi-turn loop is deliberately out of scope (YAGNI). |
| LLM budget | Two Qwen calls (plan, then answer) | Accepted latency (~2-5 s extra) in exchange for real intent parsing and synonym expansion. |
| Engine | FTS5/BM25 only, no embeddings | Measured above. Embeddings need a model install, a backfill of 861 documents, and a new silent-failure surface — and the harness is the instrument that will say whether they add anything. Guessing before measuring is the thing to avoid. |
| Proof | Ground-truth query harness | Consistent with the Vision Lab crop harness; prevents an "improvement" on one query from silently breaking another. |

Rejected: LLM reranking of ~40 candidates (a third call, +5-10 s) — the
measured margins suggest precision is not the binding constraint.

## Design

### 1. The contract — `src/domain/chat-query.ts` (new, pure, zero I/O)

```ts
{
  docTypes:     string[]  // ["rib", "relevé d'identité bancaire", "IBAN"]
  entities:     string[]  // ["credit mutuel", "CCM"]
  keywords:     string[]  // ["2023", "mensuel"]
  notTerms:     string[]  // ["relevé de compte", "mouvement"]
  category?:    string    // constrained to the live taxonomy
  subcategory?: string
  dateFrom?:    string    // ISO
  dateTo?:      string
  limit?:       number
}
```

Validated by Zod at the boundary, per the project's architecture rule.

Three **facets** rather than one keyword bag, because that is how a document
is actually asked for: *what kind* + *whose* + *about what*. Non-empty facets
are combined with `AND`; terms within a facet with `OR`. This is precisely the
shape proven above.

### 2. The query compiler — `buildFtsMatchExpression(q): string | null`

Same file, pure, unit-testable without a database or a model.

```
(rib OR "identité bancaire") AND (mutuel OR "credit mutuel") NOT ("relevé de compte")
```

**Every term is emitted as a quoted phrase with internal quotes doubled.**
FTS5 treats `-`, `*`, `:`, `(`, `)`, `NEAR`, `AND`, `OR`, `NOT` as syntax;
raw text blows up the `MATCH`. Systematic quoting neutralizes all of it. This
matters more than it looks: the terms are produced by the LLM from untrusted
document-derived text, and this function is the boundary that stops that text
from reaching the query parser as syntax. It is the focus of the unit tests.

Empty facets are dropped, not emitted as `()`. An entirely empty query
compiles to `null`, and the caller treats that as "no FTS query possible".

### 3. Retrieval — `searchDocumentsFts()` in `database.ts`

`MATCH` + `bm25()` weighted per column, joined to `documents` for the full
record, with the `category`, `subcategory`, `dateFrom` and `dateTo` filters
applied in SQL (not in JavaScript after the fact — a filter applied after
`LIMIT` would silently return fewer rows than asked for).

The eleven `documents_fts` columns, in schema order, with their weights:

| column | weight | column | weight |
| --- | --- | --- | --- |
| `doc_id` (UNINDEXED) | 0 | `summary` | 3 |
| `title` | 10 | `category` | 2 |
| `original_filename` | 1 | `subcategory` | 2 |
| `original_path` | 1 | `tags` | 6 |
| `new_path` | 1 | `raw_text` | 0.5 |
| `registre` | 1 | | |

`raw_text` at 0.5 carries the recall — it is what recovered the OCR-corrupted
#4592 — but a word buried in four pages must never weigh as much as a word in
the title.

If the `MATCH` throws, or FTS5 is unavailable in the SQLite build, the caller
falls back to the current scorer. **The chat never surfaces an error.**

### 4. Orchestration — `ai-chat-assistant.ts`

`planQuery()` → `searchDocumentsFts()` → `buildPromptContext()` → answer.

- **Planner fallback.** If Ollama is down or returns invalid JSON, a pure
  deterministic heuristic planner (French stopwords, date extraction, matching
  against existing tags) produces a degraded `StructuredQuery`. The chat works
  without an LLM.
- **Relaxation ladder.** Zero results drops the weakest facet and retries, in
  order: `keywords`, then `notTerms`, then `entities`. Only then the old
  scorer. This replaces silence with an imperfect but useful answer.
- **Removed:** the hardcoded `isPaySlipQuery` branch. The planner covers it.
- **Retained as the last-resort fallback:** the rest of `searchRelevantDocuments`
  — the general token scorer — minus that branch. It is what the FTS path
  degrades to when the `MATCH` throws, when FTS5 is missing from the SQLite
  build, or when the relaxation ladder is exhausted. It is no longer the
  primary path.
- **Preserved unchanged:** pay-period de-duplication and citation pruning.
  Both are fixes for real, user-reported bugs, documented in-code and covered
  by tests. They must not regress.
- **`limit` ownership.** The planner emits `limit`; `extractRequestedCount`
  remains the authority when it finds an explicit count in the user's words
  ("les 3 derniers"), because a regex on a stated number is more reliable
  than a model re-deriving it. Precedence is therefore
  `extractRequestedCount() ?? plan.limit ?? 10`. The same resolved value
  feeds the citation-pruning `minExpected`, so retrieval and pruning cannot
  disagree about how many documents were asked for — they disagreeing is
  exactly what caused the earlier under-citing bug.

`prepare_dossier` (MCP) routes through the same path — one search engine, not
two.

### 5. The harness — `scripts/eval-chat-search.mjs`

`.chat-eval.private.json` is **gitignored** (real queries and document IDs are
personal data, per the project's publishability rules); a `.example` is
committed.

Output: precision@k, recall and MRR per query plus an aggregate, compared
against a recorded baseline.

Two modes: `--no-llm` uses the heuristic planner (fast, deterministic, good
for a tight loop) and the default uses the real Qwen planner. Run by hand,
**not part of `npm test`** — it needs Ollama and the real database.

### 6. Tests and guardrails

Vitest, no I/O: compiler escaping (quotes, FTS operators, empty facets), Zod
validation, the heuristic planner, the relaxation ladder. The five existing
`ai-chat-assistant` tests stay green. The planner prompt is built from the
**live** taxonomy, never hardcoded entities, so `prompt-hygiene.test.ts`
keeps guarding the door.

### 7. Included side fix

`generateEmbedding`'s `catch { return []; }` becomes a `logger.warn`. Even
though embeddings are out of scope, that silence is what produced 861
empty vectors unnoticed; leaving it means rediscovering the same silence on
the day the hybrid option is revisited.

## Files touched

| File | Change |
| --- | --- |
| `src/domain/chat-query.ts` | new — schema + compiler + heuristic planner |
| `src/domain/chat-query.test.ts` | new — unit tests |
| `src/infrastructure/db/database.ts` | add `searchDocumentsFts()` |
| `src/application/ai-chat-assistant.ts` | rewrite retrieval; drop `isPaySlipQuery` |
| `src/infrastructure/mcp/mcp-server.ts` | `prepare_dossier` uses the new path |
| `src/infrastructure/ollama-client.ts` | warn instead of swallowing |
| `scripts/eval-chat-search.mjs` | new — harness |
| `.chat-eval.private.json.example` | new — committed template |
| `.gitignore`, `CHANGELOG.md`, `docs/` | ignore the private eval file; record the change |

## Success criteria

1. `RIB de credit mutuel` returns #4280 first and #4592 second, with no
   account statements in the top three.
2. The harness reports precision and recall at or above the recorded baseline
   on every query in the set — no regression traded for an improvement.
3. All 726 existing tests stay green; `npm run typecheck` stays clean.
4. With Ollama stopped, the chat still returns plausible documents.

## Out of scope

Embeddings and hybrid RRF fusion (revisit with harness numbers), LLM
reranking, the multi-turn conversational loop, and tag-vocabulary
normalization.
