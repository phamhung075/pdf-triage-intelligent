---
name: pdf-triage-personal-data
description: Use before committing anything that touches prompts, classification rules, categories, entity dictionaries or fixtures in pdf-triage — enforces the public-base/private-overlay split and names what may never enter the committed tree.
---

# Keeping personal data out of the committed tree

pdf-triage is a local-first personal tool with a **publishable** committed tree. Every value that is specific to the person running the instance belongs in a gitignored overlay; the committed file holds the generic base. The two are merged at read time, so the runtime always sees the real thing.

This is a hard rule, not a preference: [`AGENTS.md`](../../../AGENTS.md) non-negotiable rule 15, and `src/domain/prompt-hygiene.test.ts` fails the build on a leak.

## The published/private pairs

| Committed (generic, publishable) | Gitignored (this instance) | Merged by |
| --- | --- | --- |
| `prompts/` templates | `.prompts.private.json` | [`prompt-personalization.ts`](../../../src/domain/prompt-personalization.ts) |
| `categories.json` (starter taxonomy) | `.categories.private.json` | `saveCategoriesConfig` in [`categories-store.ts`](../../../src/infrastructure/categories-store.ts) |
| `settings.json.example` | `settings.json` (also holds real folder paths) | [`settings.ts`](../../../src/infrastructure/settings.ts) |
| `prompts.private.json.example` | `.prompts.private.json` | as above |
| — | `registry.json`, `manual_decisions.json`, `taxonomy_hints.json`, `pdf_triage.db` | runtime artifacts |

Never edit the gitignored side *into* a committed file, and never "temporarily" commit one to test. `category`/`subcategory` naming rules and the overlay schema are in [`taxonomy.md`](../../../docs/knowledge/taxonomy.md#personal-prompt-overlay).

## What may never be committed

Real employers, banks and their product or filename codes, insurers, clinics, schools, vendors, personal names, and scanner/filename prefixes belonging to the operator. Concretely: no `RLV_CHQ_`-style code, no real branch name, no `CESI`-style institution, no person's name, in `prompts/`, `src/domain/classification.ts`, `categories.json`, `entity_dictionary.json`, or any fixture.

The failure this prevents is real and specific: a personal signal fused into a scan filename prefix or an OCR fixture.

## Where a signal goes instead

- A **classification hint** (bank product code, filename prefix, employer) → a priority rule in `.prompts.private.json`. It feeds *both* the prompt (`{{USER_PRIORITY_RULES}}` / `{{USER_KNOWN_ENTITIES}}`) and the deterministic fallback `ruleBasedClassify()` via `matchPriorityRules()` — one source, so the LLM path and the rule path cannot disagree.
- An **entity name** → `entity_dictionary.json` only if it is generic (a national telecom, a well-known chain). Anything tied to the operator's own affairs stays private.
- A **new taxonomy branch** → auto-created into `.categories.private.json` by `saveCategoriesConfig`, which diffs the merged config against the public file and persists only the difference. Golden Rule 5: register before moving a file, and never write the slug into the committed `categories.json`.

**Scope matters on priority rules.** `scope: 'all'` (the default) fires on the document body too, so only hand-curated rules with distinctive codes may use it. Auto-learned rules from `decisionsToPriorityRules` are forced to `scope: 'filename'`: a generic word like `paiement` matching body text is what filed a SEPA mandate and two tax notices under invoices/cdiscount on 2026-08-31. If you add a rule from a document body, justify why that string cannot appear in an unrelated document.

## How the guard works

`src/domain/prompt-hygiene.test.ts` scans `src`, `prompts`, `public` and `docs` plus the named root files against `CONFIG.PERSONAL_NAME_DENYLIST` — which itself lives in the gitignored `settings.json`, so no personal token is written into the committed test. Tokens shorter than 4 characters are skipped, because a three-letter fragment matches innocent substrings (e.g. "thinking") while a word-boundary match misses the real leak shape (a name fused into a filename prefix). Symlinks, dot-directories, `skills`, `vendor`, `node_modules` and `dist` are skipped.

The denylist is a safety net, not a licence: it catches tokens you remembered to list. Reviewing the diff is still your job.

## Checklist before committing

1. Does the diff add any real-world identifier to a committed file? Move it to the matching overlay.
2. Did you run the change through the generic path — would a fresh clone with no private files still behave sensibly? Both placeholders resolve to an empty string when `.prompts.private.json` is absent, and that is the supported baseline.
3. Run `npm test`. `prompt-hygiene.test.ts` is part of the suite, and `npm run typecheck` alone will not run it — see [pdf-triage-verify](../pdf-triage-verify/SKILL.md).
