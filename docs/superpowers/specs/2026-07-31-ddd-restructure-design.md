# DDD Light-Layering Restructure (Phase 2 of 2)

Date: 2026-07-31
Owner: shared — every agent whose files move (see Section 6). docs-curator
syncs CLAUDE.md and docs/agents/*.md as part of this same effort.

## Problem

The codebase (~3,300 lines across 8 files) mixes pure classification/taxonomy
logic with filesystem, SQLite, and Ollama I/O inside the same functions —
most concentrated in `ai.service.ts` (809 lines) and `triage.service.ts`
(852 lines). This has two costs, both already observed directly:

1. **Testing cost.** Phase 1's test suite (`docs/superpowers/specs/2026-07-31-test-harness-design.md`)
   had to `vi.mock('fs')` and rebuild fixture plumbing to test functions like
   `matchEntityDictionary` and `ruleBasedClassify` that are logically pure —
   they only touch `fs` because they fetch their own data (`getEntityDictionary()`,
   `CONFIG.PERSONAL_NAME_DENYLIST`) instead of receiving it as input.
2. **Change-risk cost.** `classifyPDFText` (250 lines) interleaves prompt
   building, Ollama calls, JSON parsing, schema validation, rule-based
   fallback, and category/subcategory auto-creation in one function — exactly
   the kind of function where the `think:false` bug (fixed earlier this
   session) and the entity-dictionary grounding bugs (fixed in prior
   sessions) live. Untangling pure decision logic from I/O makes each piece
   independently reasoned about and testable.

## Goal

Reorganize `src/` into three layers — **domain** (pure, zero I/O),
**application** (orchestration/use-cases), **infrastructure** (I/O adapters)
— using Phase 1's 69-test suite as the regression net during the move.
No behavior change: every existing capability, Golden Rule enforcement, and
API/MCP contract works identically after the move. This is explicitly a
**structural** refactor, not a feature or bug-fix pass — see Global
Constraints.

## 1. Layer boundaries

- **`src/domain/`** — functions take data as parameters and return data.
  No `fs`, no network calls, no reading `CONFIG` internally. Includes the
  Zod schemas (`src/schemas/` folds in here — data contracts, not I/O).
- **`src/application/`** — orchestration ("use cases"): fetches data via
  infrastructure, calls domain functions to decide what to do, calls
  infrastructure again to persist/act.
- **`src/infrastructure/`** — all I/O: SQLite, filesystem, the Ollama SDK,
  Express routes, the MCP stdio transport, logging.

## 2. Domain layer file mapping

| New file | Contents (from) | Signature changes |
|---|---|---|
| `src/domain/classification.ts` | `ruleBasedClassify`, `cleanAndParseJSON`, `repairTruncatedJSON`, `isGroundedSubcategorySlug`, `matchEntityDictionary`, `buildEntityHintLine`, `normalizeSlug`, `buildCategoriesDescriptionStr` (from `ai.service.ts`) | `matchEntityDictionary`, `buildEntityHintLine`, `ruleBasedClassify`, `buildCategoriesDescriptionStr` take the entity dictionary (`EntityDictionary`) as a parameter instead of calling `getEntityDictionary()`. `isGroundedSubcategorySlug` and `ruleBasedClassify` take `personalNameDenylist: string[]` as a parameter instead of reading `CONFIG.PERSONAL_NAME_DENYLIST`. |
| `src/domain/taxonomy.ts` | `isYearString`, `isForbiddenSubcategory`, `computeCanonicalPath`, `isPathInsideDir` (from `triage.service.ts`) | `computeCanonicalPath` takes `outputRootDir: string` as a parameter instead of reading `CONFIG.OUTPUT_ROOT_DIR`. |
| `src/domain/pdf-text.ts` | `cleanExtractedText` (from `pdf.service.ts`) | Unchanged — already pure. |
| `src/domain/document.schema.ts` | Moved as-is from `src/schemas/document.schema.ts` | Unchanged. |
| `src/domain/prompt.ts` *(new extraction)* | The Qwen system/user prompt string-building logic currently inlined in `classifyPDFText` | New: `buildClassificationPrompt(categoriesDescriptionStr: string, filename: string, textSnippet: string, previousError?: string): { system: string; user: string }`. |
| `src/domain/classification-resolution.ts` *(new extraction)* | The category/subcategory resolve-or-create decision logic currently inlined at the end of `classifyPDFText`, AND the AI-result refinement logic currently inlined mid-function (re-running `ruleBasedClassify` and merging its result when the AI returned `personal`/`other`/`general`) | New: `refineClassification(validated: DocumentMetadata, rawText: string, filename: string, dictionary: EntityDictionary, personalNameDenylist: string[]): DocumentMetadata` (pure — given the same inputs `classifyPDFText` already has in hand, this has no I/O of its own beyond calling the already-pure `ruleBasedClassify`), `resolveCategory(categoriesConfig, rawCategorySlug): { category: CategoryItem; isNew: boolean }`, and `resolveSubcategory(matchedCategory, rawSubcategorySlug, rawText, filename, personalNameDenylist): { subcategoryId: string; isNew: boolean; newSubcategory?: SubcategoryItem }`. Pure decision logic only — the actual `saveCategoriesConfig()` write stays in `application/classify-document.ts`. |

Extracting `prompt.ts` and `classification-resolution.ts` is the one real
judgment call in this design: without it, `classifyPDFText` would just
relocate to `application/` as one still-250-line function, which is a file
move, not a real separation. With it, the prompt-building and
resolve-or-create logic become independently unit-testable functions with
no mocking required.

## 3. Application layer file mapping

| New file | Contents (from) |
|---|---|
| `src/application/classify-document.ts` | `classifyPDFText`, restructured as the orchestrator: fetch categories config + entity dictionary (infrastructure) → `buildClassificationPrompt` (domain) → Ollama call (infrastructure) → `cleanAndParseJSON` + `DocumentMetadataSchema.parse` (domain) → on failure, `ruleBasedClassify` (domain) → `refineClassification` (domain) → `resolveCategory`/`resolveSubcategory` (domain) → `saveCategoriesConfig` (infrastructure) |
| `src/application/triage-scan.ts` | `runTriageScan`, `TriageProgressEvent`, `TriageResultItem` (from `triage.service.ts`) |
| `src/application/repair-registry.ts` | `repairRegistry` |
| `src/application/relocalize-document.ts` | `relocalizeFileIfNeeded`, `moveBackToRaws`, `reclassifyAndRelocalizeDocument`, `ensureCategoryAndSubcategoryExist`, `findActualFileOnDisk`, `renameAtomicNoOverwrite` (private) |
| `src/application/clear-registry.ts` | `clearRegistryAndMoveArchiveToRaws` |
| `src/application/scan-lock.ts` | `acquireScanLock`, `ScanInProgressError` — built on the shared PID-lock helper from infrastructure (Section 4) |

## 4. Infrastructure layer file mapping

| New file | Contents (from) |
|---|---|
| `src/infrastructure/settings.ts` | `config.ts` — `CONFIG`, `loadCustomSettings`, `updateConfig`, `reloadConfigFromDisk`, `ensureDirectoriesExist` |
| `src/infrastructure/categories-store.ts` | `getCategoriesConfig`, `saveCategoriesConfig`, `setOnCategoryCreatedCallback` (from `ai.service.ts`) |
| `src/infrastructure/entity-dictionary-store.ts` | `getEntityDictionary` (from `ai.service.ts`) |
| `src/infrastructure/ollama-client.ts` | `ensureOllamaModel`, `checkModelCanGenerate`, `generateEmbedding` (from `ai.service.ts`), plus a new thin `requestClassificationCompletion(system: string, user: string): Promise<{ response: string; thinking?: string }>` wrapping the raw `ollama.generate()` call (with `format: 'json'`, `think: false`) that `application/classify-document.ts` calls |
| `src/infrastructure/pdf-extractor.ts` | `extractPDFContent`, `safePdfParse` (from `pdf.service.ts`) — imports `cleanExtractedText` from `domain/pdf-text.ts` |
| `src/infrastructure/pdf-scanner.ts` | `getPDFsRecursively`, `getAllFilesRecursively` (from `triage.service.ts` — real `fs.readdirSync` calls, so infrastructure not domain) |
| `src/infrastructure/db/database.ts` | `db/database.ts`, unchanged content, relocated |
| `src/infrastructure/json-registry.ts` | `json_registry.service.ts`, unchanged, relocated |
| `src/infrastructure/logger.ts` | `logger.service.ts`, unchanged, relocated |
| `src/infrastructure/pid-lock.ts` *(new — DRY cleanup)* | Consolidates `triage.service.ts`'s `acquireScanLock`/`isLockHolderRunning` and `web_server.ts`'s `acquireSingleInstanceLock`/`isProcessRunning` — near-duplicate PID-lock-file logic (`.scan.lock` vs `.server.lock`) — into one `acquireProcessLock(lockFilePath: string): () => void`. Both call sites (`application/scan-lock.ts`, `infrastructure/http/web-server.ts`) use it with their respective lock file path. Low-risk cleanup, in scope only because both implementations are already being relocated. |
| `src/infrastructure/http/web-server.ts` | `server/web_server.ts` — same route logic, imports updated |
| `src/infrastructure/mcp/mcp-server.ts` | `mcp/server.ts` — same tool logic, imports updated |

`src/index.ts` stays at the root (composition root — wires infrastructure
adapters to application use-cases), with updated imports.

## 5. Test migration

Every Phase 1 test file relocates and its imports/mocks adjust to match the
new signatures. No test case or assertion is dropped — this is a rename +
signature-adjustment pass, not a coverage change:

| Old file | Splits into |
|---|---|
| `src/services/ai.service.test.ts` | `src/domain/classification.test.ts` (drops `vi.mock('fs')` for most cases — the dictionary is now a plain parameter), `src/domain/prompt.test.ts` (new), `src/domain/classification-resolution.test.ts` (new), `src/application/classify-document.test.ts` (keeps the Ollama mock + `think:false` regression test) |
| `src/config.test.ts` | `src/infrastructure/settings.test.ts` (unchanged reasoning — still needs `vi.mock('fs')` + `resetModules`) |
| `src/schemas/document.schema.test.ts` | `src/domain/document.schema.test.ts` (unchanged) |
| `src/services/triage.service.test.ts` | `src/domain/taxonomy.test.ts` (simpler — `computeCanonicalPath` takes `outputRootDir` directly, no longer imports the real `CONFIG`) |

## 6. Docs updates (final tasks)

- `CLAUDE.md`'s repo-layout tree shows the new `src/domain/`, `src/application/`,
  `src/infrastructure/` structure.
- `CLAUDE.md`'s agent-ownership table updated, e.g.:
  - `classification-expert` → `src/domain/classification.ts`, `src/domain/prompt.ts`,
    `src/domain/classification-resolution.ts`, `src/infrastructure/entity-dictionary-store.ts`,
    `src/infrastructure/ollama-client.ts`, `entity_dictionary.json`, `categories.json`.
  - `pipeline-engineer` → `src/application/*.ts`, `src/infrastructure/http/web-server.ts`,
    `src/infrastructure/pdf-scanner.ts`, `src/infrastructure/pid-lock.ts`.
  - `db-registry-keeper` → `src/infrastructure/db/database.ts`, `src/domain/document.schema.ts`,
    `src/infrastructure/json-registry.ts`.
  - `mcp-integrator` → `src/infrastructure/mcp/mcp-server.ts`.
  - `ollama-ops` → `src/infrastructure/ollama-client.ts` (shared note with classification-expert).
- Each affected `docs/agents/*.md` playbook's file references updated to match.
- `docs/knowledge/architecture.md` gains a new section describing the three
  layers and the dependency direction (`infrastructure`/`application` may
  import `domain`; `domain` imports nothing from the other two).

## Global Constraints

- **No behavior change.** Every Golden Rule enforcement, API route, MCP tool,
  SSE event, and classification decision produces identical output before
  and after this restructure. This is a structural move, not a bug-fix or
  feature pass — any bug noticed along the way gets logged for a separate
  fix, not folded in here (mirrors Phase 1's bounded bug-hunt discipline,
  inverted: zero bug fixes this time, not "bounded").
- Domain functions perform no I/O — no `fs`, no network, no reading `CONFIG`
  or environment variables.
- No re-export shims — old file paths are deleted once their content moves;
  every importer is updated in the same task.
- `npm test`, `npm run build`, and `npm run typecheck` stay green after every
  task.
- No new npm dependencies.
- Executed via `subagent-driven-development` in an isolated git worktree,
  same process as Phase 1.
- Reference specs: `docs/superpowers/specs/2026-07-31-test-harness-design.md`
  (Phase 1), this document (Phase 2).

## Verification

- `npm test` (all relocated + new tests), `npm run build`, `npm run typecheck`
  all green at the end.
- Boot smoke-check: after `index.ts` and all infrastructure adapters are
  updated, confirm the app actually boots with no import-resolution errors
  (e.g. `tsx src/index.ts scan` against an empty `__raws`, or a timed
  start-then-kill of the default web-server mode) — a clean `tsc` alone
  doesn't prove the runtime import graph resolves correctly.
- Manual interactive check of the dashboard is the user's own follow-up
  (Golden Rule: `npm run dev` is never run by the assistant).
- Final whole-branch review specifically checks: no domain file imports
  `fs`/`CONFIG`/network; application files may talk to `fs`/SQLite directly
  where Section 3 assigns them to (`relocalize-document.ts`,
  `clear-registry.ts`, `repair-registry.ts` — this is expected/correct for
  those specific files, not a violation), and every application file's
  Ollama access goes through the `infrastructure/ollama-client.ts` import;
  CLAUDE.md's ownership table paths all resolve to real files.
