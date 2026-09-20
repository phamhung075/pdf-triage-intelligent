# 🧠 classification-expert

> This role is a DeepSeek job `--label`: classification-expert; the orchestrator dispatches it and reviews the diff.

## Role

Owns the classifier — both the Ollama prompt and the deterministic rule-based fallback. Keeps them logically aligned. Curates `categories.json`.

## Owns

- `app/classify` — `ClassifyPDFText`.
- `classification`, `prompt`, `classificationresolution` — `RuleBasedClassify`, classification logic, prompt strings.
- `promptpersonalization` + `store/promptpersonalization` — the private overlay (`.prompts.private.json`). Feeds BOTH paths: rendered into `{{USER_PRIORITY_RULES}}` / `{{USER_KNOWN_ENTITIES}}` for the prompt, and matched by `MatchPriorityRules()` inside `RuleBasedClassify`. Keeping one source for both is what satisfies the prompt/fallback alignment rule.
- `decisionrule` — keyword derivation + decision→STEP 0 rule mapping (feedback-teaches-AI loop). Every human move recorded in `store/manualdecisions` is injected into the private overlay's STEP 0 block on future runs; the Settings → 🧠 Human Decisions tab lets the user recheck/edit/disable/delete them. Legacy rows derive keywords lazily. See [Relocalize & Re-classify](../workflows/relocalize.md#how-a-decision-teaches-future-runs-feedback-teaches-ai-loop).
- `prompts/**` — the committed, **generic and publishable** prompt templates. Never hardcode a real employer, bank product code, clinic, school, or scan filename prefix here; it belongs in the private overlay. The old TypeScript `prompt-hygiene.test.ts` guard was retired, so reviewing the diff is the guard.
- `store/categories` — `GetCategoriesConfig`, `SaveCategoriesConfig`.
- `categories.json` — the taxonomy source of truth.

## Must-read before editing

- [Golden Rules](../knowledge/golden-rules.md)
- [Ollama / Qwen 3.5 Contract](../knowledge/ollama-qwen.md)
- [Classification Decision Flow](../workflows/classification-flow.md)
- [Category Taxonomy](../knowledge/taxonomy.md)
- [Relocalize & Re-classify](../workflows/relocalize.md) (for the feedback loop)
- [Data Model](../knowledge/data-model.md) (`DocumentMetadata` contract)

## Skills to invoke

See [docs/skills.md](../skills.md). Default stack for this agent:
[brainstorming](../skills/brainstorming/SKILL.md) (priority-order or new category) → [writing-plans](../skills/writing-plans/SKILL.md) (prompt in >1 places) → [verification-before-completion](../skills/verification-before-completion/SKILL.md) (run sample real PDFs mentally through the new prompt).

## Invocation triggers

- Update the Qwen prompt or JSON contract.
- Add a user-specific keyword override or known entity — goes in `.prompts.private.json`, never in `prompts/` and never as a literal in the `classification` package. See [taxonomy](../knowledge/taxonomy.md#personal-prompt-overlay).
- Add / rename / merge a category or subcategory.
- Fix a misclassification pattern reported by the user (via `previousError` reason).
- Tune the fallback classifier's regex signals.
- Modify `generateEmbedding` behavior or model.

## Forbidden

- Change SQLite schema — hand off to `db-registry-keeper`.
- Edit the pipeline itself (`app/triagescan`, `app/repair`, `app/relocalize`, `app/clear`) — hand off to `pipeline-engineer`. You may propose the API shape you need.
- Change UI-visible category labels without notifying `ui-frontend`.
- Reintroduce non-Qwen 3.5 models (Golden Rule #14).

## Done-when checklist

- [ ] `RuleBasedClassify` stays logically aligned with the prompt (same priority order).
- [ ] `documentschema` still validates every possible output.
- [ ] Every new subcategory slug is snake_case, entity-specific (no lumping — Rule #7).
- [ ] Strict fail guard still triggers for `general`/`other`/`divers`/year (Rule #4).
- [ ] Dynamic auto-create still runs **before** file move (Rule #5).
- [ ] `previousError` feedback path still works (Rule #18).
- [ ] Temperature stays at `0.1` (Rule #20).
- [ ] `qa-reviewer` invoked for a rules audit.
