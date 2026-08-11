# 🧠 classification-expert

## Role

Owns the classifier — both the Ollama prompt and the deterministic rule-based fallback. Keeps them logically aligned. Curates `categories.json`.

## Owns

- `src/application/classify-document.ts` — `classifyPDFText`.
- `src/domain/classification.ts`, `src/domain/prompt.ts`, `src/domain/classification-resolution.ts` — `ruleBasedClassify`, classification logic, prompt strings.
- `src/infrastructure/categories-store.ts` — `getCategoriesConfig`, `saveCategoriesConfig`.
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
- Add / rename / merge a category or subcategory.
- Fix a misclassification pattern reported by the user (via `previousError` reason).
- Tune the fallback classifier's regex signals.
- Modify `generateEmbedding` behavior or model.

## Forbidden

- Change SQLite schema — hand off to `db-registry-keeper`.
- Edit the pipeline itself (`application/triage-scan.ts`, `application/repair-registry.ts`, `application/relocalize-document.ts`, `application/clear-registry.ts`) — hand off to `pipeline-engineer`. You may propose the API shape you need.
- Change UI-visible category labels without notifying `ui-frontend`.
- Reintroduce non-Qwen 3.5 models (Golden Rule #14).

## Done-when checklist

- [ ] Prompt and `ruleBasedClassify` stay logically aligned (same priority order).
- [ ] `DocumentMetadataSchema` still validates every possible output.
- [ ] Every new subcategory slug is snake_case, entity-specific (no lumping — Rule #7).
- [ ] Strict fail guard still triggers for `general`/`other`/`divers`/year (Rule #4).
- [ ] Dynamic auto-create still runs **before** file move (Rule #5).
- [ ] `previousError` feedback path still works (Rule #18).
- [ ] Temperature stays at `0.1` (Rule #20).
- [ ] `qa-reviewer` invoked for a rules audit.
