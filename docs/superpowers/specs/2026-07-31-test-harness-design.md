# Test Harness for Pure Classification/Path Logic (Phase 1 of 2)

Date: 2026-07-31
Owner: shared — classification-expert (`ai.service.ts`), pipeline-engineer
(`triage.service.ts`, `config.ts`), db-registry-keeper (`document.schema.ts`).
Each module's tests are written under its owning agent's existing boundary;
this spec itself doesn't change any ownership.

## Problem

The project has zero automated tests. `npm run build` (`tsc`) is the only
verification gate today. This was directly costly this session: a real bug
(`classifyPDFText` never setting `think: false`, causing `qwen3.5:9b` to route
its entire JSON answer into the discarded `response.thinking` field instead of
`response.response`) went undetected through several commits on 2026-07-28 and
was only caught by manually reading `logs/triage_debug.log` and querying
Ollama directly. A regression test would have caught it at write-time.

Separately, the user wants the codebase reorganized along DDD lines. Doing
that restructuring with no tests in place means any behavior change during
the move is invisible until it shows up as a misfiled document in production
(a real household document archive — Golden Rule stakes, not abstract risk).

## Goal

Stand up a fast, dependency-free unit test harness covering the codebase's
pure/near-pure logic — classification rules, JSON repair, taxonomy guards,
canonical path building, config/schema validation — so that:

1. Today's known bug class (silent misclassification) has regression coverage.
2. Phase 2 (DDD restructuring, separately spec'd) has a safety net to restructure against.

This is **Phase 1 of 2**. Phase 2 (light domain/application/infrastructure
layering) is explicitly deferred to its own spec, written after this phase
lands, since the test suite built here is a prerequisite for restructuring
safely rather than something restructuring should wait to justify.

Explicitly out of scope for Phase 1:
- Any DDD/file-layout restructuring — no files move in this phase.
- Integration tests against real SQLite / real filesystem / real Ollama —
  deferred to Phase 2, where the DDD boundaries will determine the natural
  seams for integration-style tests (`runTriageScan`, `repairRegistry`,
  `moveBackToRaws`, the file-watcher loop, `web_server.ts`, `mcp/server.ts`,
  `database.ts`).
- UI tests (`public/app.js`).
- CI wiring (no GitHub Actions / pre-commit hook in this repo today) — just
  a local `npm test` script.
- An open-ended bug audit — bug fixes in this phase are limited to what
  characterization testing genuinely surfaces while covering the table below,
  each with its own regression test. Not a general refactor.

## 1. Test framework & setup

- **Vitest**, added as a devDependency. Chosen over Jest because the project
  is `"type": "module"` (ESM) end-to-end with `tsx`; Vitest runs native
  ESM/TS with zero transform config, where Jest needs extra ESM shims in
  this setup.
- `package.json` gains:
  - `"test": "vitest run"` — single-run mode, what `npm test` invokes.
  - `"test:watch": "vitest"` — interactive watch mode for local dev.
- Tests are colocated next to the source file they cover, as `*.test.ts`
  (e.g. `src/services/ai.service.test.ts`, `src/config.test.ts`). This keeps
  a test traveling with its file if Phase 2 later relocates that file.
- No coverage threshold enforced in this phase — the goal is targeted
  characterization of the module table below, not a percentage.

## 2. Modules and functions under test

| Module | Functions | Mocking strategy |
|---|---|---|
| `src/services/ai.service.ts` | `ruleBasedClassify`, `cleanAndParseJSON`, `repairTruncatedJSON` (via `cleanAndParseJSON`'s malformed-JSON path), `isGroundedSubcategorySlug`, `matchEntityDictionary`, `buildEntityHintLine` | `vi.mock('fs')` returning fixed `entity_dictionary.json` / `categories.json` fixtures for the functions that call `getEntityDictionary()` / `getCategoriesConfig()` internally. Everything else is pure — no mocking. |
| `src/services/ai.service.ts` | `classifyPDFText` | `vi.mock('ollama')` — the `Ollama` class's `generate()` method returns canned `{response, thinking}` payloads per test case, including **the exact bug shape from today** (`response: ""`, `thinking: "<the real answer>"`) to lock in the `think: false` fix as a regression test. `fs` mocked as above for `getCategoriesConfig`. |
| `src/config.ts` | `loadCustomSettings`, `CONFIG` value derivation, `updateConfig` | `vi.mock('fs')` for `settings.json` read/write. |
| `src/schemas/document.schema.ts` | `DocumentMetadataSchema` (and any other exported Zod schemas in the file) parse/validation edge cases: missing required fields, wrong types, boundary date formats | None — pure Zod validation. |
| `src/services/triage.service.ts` | `isYearString`, `isForbiddenSubcategory` (Golden Rule #4 enforcement), `computeCanonicalPath` (Golden Rule #5 path-building) | None needed for `isYearString`/`isForbiddenSubcategory`. `computeCanonicalPath`'s no-year-in-`dateStr` fallback branch (`new Date().getFullYear()`) is tested by asserting the result contains *some* 4-digit year path segment, not a hardcoded expected year — it must not depend on the day the suite runs. |

## 3. Bug-hunting

Bounded to what's actually surfaced while writing the characterization tests
above — e.g. a regex boundary that's too greedy, a slug-normalization edge
case that strips a character it shouldn't, a date-format branch that mishandles
a valid input. Each fix ships with the regression test that caught it. This is
not a separate audit pass over unrelated code.

## 4. Success criteria

- `npm test` runs clean (`vitest run` exits 0).
- Every function in the Section 2 table has at least: one happy-path test,
  and the specific edge cases named in this doc (empty/malformed input,
  forbidden slugs, unicode entity names, the `think:false` regression case).
- `npm run build` (`tsc --noEmit`) still passes — no type regressions from
  test code or from any bug fixes made in passing.
- No behavior change to currently-working classification/path logic — these
  are characterization/regression tests on existing behavior, not a rewrite.
  Any bug fix that does intentionally change behavior is called out explicitly
  in its commit message.

## Verification

- `npm test` and `npm run build` both green.
- Manual spot-check: re-run the same realistic Ollama payload used to verify
  the `think:false` fix earlier this session, confirm the new
  `classifyPDFText` test suite would have caught the pre-fix bug (i.e. the
  regression test fails if `think: false` is reverted).
- `qa-reviewer` pass once implemented, since this touches `services/*` and
  `schemas/*` — audited against each owning agent's done-when checklist
  (classification-expert, pipeline-engineer, db-registry-keeper).

## Handoff to Phase 2

Once this lands, a follow-up spec (`docs/superpowers/specs/<date>-ddd-restructure-design.md`)
covers the light domain/application/infrastructure layering discussed during
brainstorming, using the test suite built here as the regression net during
the move. Not written yet — deliberately sequenced after Phase 1 ships.
