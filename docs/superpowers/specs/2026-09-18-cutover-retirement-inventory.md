# Cutover retirement inventory — 2026-09-18

> Status: pre-deletion inventory written at the cutover commit of branch `go-cutover-final`
> (the isolated cutover worktree). Every path below comes from
> `git ls-files` at the worktree root. The Go backend is already ported and verified in the
> `services/pdf-triage-pdf2w` submodule (composition root `cmd/pdf-triage`:
> `serve | scan | mcp | vision-lab`); this inventory classifies what survives the TypeScript
> retirement. `KEEP` = stays tracked; `DELETE` = removed in this cutover.

## Method

- `git ls-files` grouped by top-level entry, one row per tracked path.
- Only files that serve the retired Node/Electron/tsx/vitest backend are `DELETE`; anything
  genuinely uncertain defaults to `KEEP` and is listed under **Judgment calls** below.
- `docs/`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md` and `.agents/notes/` were already updated
  for the Go backend on this branch and are not edited (the only new docs file is this one).

## Summary

- Tracked paths: **266** — KEEP **141**, DELETE **125**.
- `(root)`: 23 tracked — KEEP 23, DELETE 0
- `.agents`: 20 tracked — KEEP 20, DELETE 0
- `.claude`: 10 tracked — KEEP 10, DELETE 0
- `desktop`: 2 tracked — KEEP 0, DELETE 2
- `docs`: 50 tracked — KEEP 50, DELETE 0
- `input`: 1 tracked — KEEP 1, DELETE 0
- `organized`: 1 tracked — KEEP 1, DELETE 0
- `prompts`: 10 tracked — KEEP 10, DELETE 0
- `public`: 31 tracked — KEEP 30, DELETE 1
- `scripts`: 2 tracked — KEEP 0, DELETE 2
- `services`: 1 tracked — KEEP 1, DELETE 0
- `src`: 115 tracked — KEEP 0, DELETE 115

## Inventory

### (root) (23 paths)

| Path | Class | Reason |
| --- | --- | --- |
| `.dockerignore` | KEEP | Build-context hygiene; keeps personal data out of any image build |
| `.env.example` | KEEP | Runtime env template; rewritten this task to match the Go settings table |
| `.gitignore` | KEEP | Ignore rules; dist/ already listed |
| `.gitmodules` | KEEP | Registers the Go backend and deepseek-offload submodules |
| `AGENTS.md` | KEEP | Agent bootstrap, already describes the Go single-binary backend |
| `AGENT_REQUIREMENTS.md` | KEEP | Authoritative user spec |
| `CHANGELOG.md` | KEEP | Dated history record |
| `CLAUDE.md` | KEEP | Symlink to AGENTS.md |
| `LICENSE` | KEEP | MIT license |
| `README.md` | KEEP | User-facing readme (KEEP; stale deleted-path/script refs listed below) |
| `categories.json` | KEEP | Committed public starter taxonomy |
| `docker-compose.yml` | DELETE | Only service was the now-in-process canonical-path HTTP hop |
| `entity_dictionary.json` | KEEP | Committed generic entity reference |
| `package.json` | KEEP | Becomes the frontend-only build manifest |
| `pnpm-lock.yaml` | KEEP | Lockfile; regenerated this task |
| `pnpm-workspace.yaml` | KEEP | Frontend-only allow-build marker; updated to @parcel/watcher (sass) |
| `prompts.private.json.example` | KEEP | Private prompt-overlay template |
| `settings.json.example` | KEEP | Runtime settings template |
| `tsconfig.frontend.json` | KEEP | Frontend TypeScript config (public/ts -> public/js) |
| `tsconfig.json` | DELETE | Backend TypeScript config (rootDir src/, outDir dist/) |
| `tsconfig.test.json` | DELETE | Backend test tsconfig extending tsconfig.json |
| `vitest.config.ts` | DELETE | Vitest backend test runner config |
| `vitest.setup.ts` | DELETE | Vitest backend setup (log redirection) |

### .agents (20 paths)

| Path | Class | Reason |
| --- | --- | --- |
| `.agents/deepseek-offload` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/dsh-workspace-attach` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/mcp-deepseek/README.md` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/mcp-deepseek/git-guard.cjs` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/mcp-deepseek/server.cjs` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/mcp_config.json.example` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/notes/AGENTS.md` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/notes/README.md` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/notes/implemented/architecture/2026-09-19-go-backend-cutover.md` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/notes/implemented/process/2026-09-16-adopt-agent-skills-and-notes.md` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/skills/deepseek-offload/SKILL.md` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/skills/deepseek-offload/references` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/skills/deepseek-offload/scripts/dsh-offload.mjs` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/skills/deepseek-offload/scripts/session-tail.mjs` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/skills/pdf-triage-change/SKILL.md` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/skills/pdf-triage-dispatch/SKILL.md` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/skills/pdf-triage-extraction/SKILL.md` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/skills/pdf-triage-personal-data/SKILL.md` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/skills/pdf-triage-verify/SKILL.md` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |
| `.agents/skills/pdf-triage-wsl-ops/SKILL.md` | KEEP | Agent tooling/skills/notes (KEEP; some stale deleted-path refs listed below) |

### .claude (10 paths)

| Path | Class | Reason |
| --- | --- | --- |
| `.claude/agents/classification-expert.md` | KEEP | Agent shells + local settings (KEEP; stale src/ refs in shells listed below) |
| `.claude/agents/db-registry-keeper.md` | KEEP | Agent shells + local settings (KEEP; stale src/ refs in shells listed below) |
| `.claude/agents/docs-curator.md` | KEEP | Agent shells + local settings (KEEP; stale src/ refs in shells listed below) |
| `.claude/agents/mcp-integrator.md` | KEEP | Agent shells + local settings (KEEP; stale src/ refs in shells listed below) |
| `.claude/agents/ollama-ops.md` | KEEP | Agent shells + local settings (KEEP; stale src/ refs in shells listed below) |
| `.claude/agents/pipeline-engineer.md` | KEEP | Agent shells + local settings (KEEP; stale src/ refs in shells listed below) |
| `.claude/agents/qa-reviewer.md` | KEEP | Agent shells + local settings (KEEP; stale src/ refs in shells listed below) |
| `.claude/agents/read-only-investigator.md` | KEEP | Agent shells + local settings (KEEP; stale src/ refs in shells listed below) |
| `.claude/agents/ui-frontend.md` | KEEP | Agent shells + local settings (KEEP; stale src/ refs in shells listed below) |
| `.claude/settings.json` | KEEP | Agent shells + local settings (KEEP; stale src/ refs in shells listed below) |

### desktop (2 paths)

| Path | Class | Reason |
| --- | --- | --- |
| `desktop/icon.png` | DELETE | Electron desktop shell (replaced by the Go binary) |
| `desktop/main.cjs` | DELETE | Electron desktop shell (replaced by the Go binary) |

### docs (50 paths)

| Path | Class | Reason |
| --- | --- | --- |
| `docs/README.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/agents/README.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/agents/classification-expert.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/agents/db-registry-keeper.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/agents/docs-curator.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/agents/mcp-integrator.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/agents/ollama-ops.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/agents/pipeline-engineer.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/agents/qa-reviewer.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/agents/ui-frontend.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/knowledge/api-reference.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/knowledge/architecture.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/knowledge/canonical-paths.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/knowledge/data-model.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/knowledge/environment.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/knowledge/golden-rules.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/knowledge/ollama-qwen.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/knowledge/pdf2w-extraction.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/knowledge/service-split-plan.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/knowledge/taxonomy.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/overview.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/skills.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/plans/2026-07-28-entity-dictionary.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/plans/2026-07-31-ddd-restructure.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/plans/2026-07-31-test-harness.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/plans/2026-08-13-image-to-pdf-vision-lab.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/plans/2026-08-15-paddleocr-integration.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/plans/2026-08-15-vision-lab-extract-text.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/plans/2026-08-26-chat-retrieval.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/plans/2026-09-17-pdf2w-extraction-swap-plan.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/plans/2026-09-18-pdf2w-extraction-swap.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-07-28-entity-dictionary-design.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-07-31-ddd-restructure-design.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-07-31-test-harness-design.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-08-13-image-to-pdf-vision-lab-design.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-08-15-paddleocr-integration-design.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-08-15-vision-lab-extract-text-design.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-08-24-dev-server-port-takeover-design.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-08-26-chat-retrieval-design.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-09-18-cutover-differential-report.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-09-18-go-backend-inventory.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-09-18-go-backend-migration-design.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/superpowers/specs/2026-09-18-http-parity-audit.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/workflows/classification-flow.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/workflows/clear-registry.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/workflows/relocalize.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/workflows/repair-registry.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/workflows/sse-broadcast.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |
| `docs/workflows/triage-pipeline.md` | KEEP | Documentation, already Go-updated on this branch (orchestrator-owned; do not edit) |

### input (1 paths)

| Path | Class | Reason |
| --- | --- | --- |
| `input/.gitkeep` | KEEP | Runtime input dir placeholder |

### organized (1 paths)

| Path | Class | Reason |
| --- | --- | --- |
| `organized/.gitkeep` | KEEP | Runtime archive dir placeholder |

### prompts (10 paths)

| Path | Class | Reason |
| --- | --- | --- |
| `prompts/classification_rules.md` | KEEP | Committed generic Qwen prompt templates |
| `prompts/contact_rules.md` | KEEP | Committed generic Qwen prompt templates |
| `prompts/formatting_rules.md` | KEEP | Committed generic Qwen prompt templates |
| `prompts/json_schema_response.json` | KEEP | Committed generic Qwen prompt templates |
| `prompts/micro_prompt_entity.md` | KEEP | Committed generic Qwen prompt templates |
| `prompts/micro_prompt_markdown.md` | KEEP | Committed generic Qwen prompt templates |
| `prompts/retry_prompt.md` | KEEP | Committed generic Qwen prompt templates |
| `prompts/system_header.md` | KEEP | Committed generic Qwen prompt templates |
| `prompts/system_template.md` | KEEP | Committed generic Qwen prompt templates |
| `prompts/user_template.md` | KEEP | Committed generic Qwen prompt templates |

### public (31 paths)

| Path | Class | Reason |
| --- | --- | --- |
| `public/apple-touch-icon.png` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/favicon.ico` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/icon.png` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/index.html` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/js/CategoryPillsManager.js` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/js/ChatAssistantManager.js` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/js/DocumentGridManager.js` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/js/ImageEditorManager.js` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/js/ModalsManager.js` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/js/Toast.js` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/js/TriageApp.js` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/js/TriageEventsManager.js` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/js/TriageState.js` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/js/crop-quad.js` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/js/vendor/marked.js` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/scss/style.scss` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/style.css` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/test-image-to-pdf.html` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/test-render.html` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/ts/CategoryPillsManager.ts` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/ts/ChatAssistantManager.ts` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/ts/DocumentGridManager.ts` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/ts/ImageEditorManager.ts` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/ts/ModalsManager.ts` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/ts/Toast.ts` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/ts/TriageApp.ts` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/ts/TriageEventsManager.ts` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/ts/TriageState.ts` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/ts/crop-quad.test.ts` | DELETE | Vitest-only frontend test; vitest toolchain retired at cutover |
| `public/ts/crop-quad.ts` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |
| `public/viewer.html` | KEEP | Browser dashboard source + compiled output (served statically by the Go server) |

### scripts (2 paths)

| Path | Class | Reason |
| --- | --- | --- |
| `scripts/build-exe.mjs` | DELETE | Backend tooling (Electron packaging / src-importing TS migration) |
| `scripts/merge-subcategories.ts` | DELETE | Backend tooling (Electron packaging / src-importing TS migration) |

### services (1 paths)

| Path | Class | Reason |
| --- | --- | --- |
| `services/pdf-triage-pdf2w` | KEEP | Go backend submodule gitlink (pinned to e0e1d9f) |

### src (115 paths)

| Path | Class | Reason |
| --- | --- | --- |
| `src/application/ai-chat-assistant.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/ai-chat-assistant.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/chat-query-planner.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/chat-query-planner.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/classify-document.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/classify-document.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/clear-registry.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/clear-registry.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/convert-image-document.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/convert-image-document.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/image-to-pdf.integration.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/image-to-pdf.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/image-to-pdf.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/micro-prompt-pipeline.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/relocalize-document.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/relocalize-document.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/repair-registry.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/repair-registry.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/scan-lock.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/scan-lock.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/triage-scan-duplicate-collision.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/triage-scan.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/application/triage-scan.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/chat-query.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/chat-query.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/classification-resolution.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/classification-resolution.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/classification.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/classification.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/decision-rule.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/decision-rule.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/document.schema.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/document.schema.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/exif-orientation.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/exif-orientation.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/extraction-quality-gate.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/extraction-quality-gate.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/flood-crop.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/flood-crop.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/image-adjust.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/image-adjust.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/image-dimensions.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/image-dimensions.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/markdown-tables.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/markdown-tables.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/path-conversion.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/path-conversion.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/pdf-page-fit.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/pdf-page-fit.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/pdf-text.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/pdf-text.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/prompt-hygiene.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/prompt-injection.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/prompt-personalization.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/prompt-personalization.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/prompt.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/prompt.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/taxonomy-conflicts.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/taxonomy-conflicts.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/taxonomy.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/domain/taxonomy.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/index.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/canonical-path-remote.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/canonical-path-remote.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/categories-store.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/categories-store.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/clean-text-remote.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/clean-text-remote.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/crop-detector.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/crop-detector.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/db/database.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/db/database.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/entity-dictionary-store.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/entity-dictionary-store.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/http/task-state.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/http/task-state.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/http/web-server.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/http/web-server.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/image-processor.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/image-processor.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/json-registry.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/json-registry.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/logger.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/logger.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/manual-decisions-store.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/manual-decisions-store.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/mcp/mcp-server.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/mcp/mcp-server.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/ollama-client.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/ollama-client.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/orientation-detector.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/orientation-detector.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/os-open.hygiene.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/os-open.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/os-open.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/pdf-extractor.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/pdf-extractor.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/pdf-scanner.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/pdf-scanner.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/pdf2w-remote.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/pdf2w-remote.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/pid-lock.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/pid-lock.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/prompt-personalization-store.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/prompt-personalization-store.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/settings.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/settings.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/taxonomy-hints-store.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/vision-client.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/vision-client.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/zip-builder.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/infrastructure/zip-builder.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/vision-lab-main.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/vision-lab-server.test.ts` | DELETE | TypeScript backend module/test, ported to Go |
| `src/vision-lab-server.ts` | DELETE | TypeScript backend module/test, ported to Go |

## Judgment calls

- **`public/ts/crop-quad.test.ts` — DELETE.** It is a dashboard test, but it is the only
  `vitest` importer left in `public/ts`, and STEP 2 retires the `test`/`test:watch` scripts and
  the vitest toolchain. Keeping an unrunnable test that imports a removed dependency is worse
  than removing it; `crop-quad.ts` itself stays (it is compiled into `public/js`).
- **`pnpm-workspace.yaml` — KEEP (rewritten).** It originally allowed only `sqlite3`'s native
  build. Deleting it makes `pnpm install` fail with `ERR_PNPM_IGNORED_BUILDS` because `sass`
  pulls in `@parcel/watcher`; it now allows only `@parcel/watcher`, so no backend native build
  can be reintroduced through it.
- **`README.md` — KEEP, deleted-path/command refs fixed.** The run/build/test blocks now use the
  Go binary (`make build`, `./dist/pdf-triage serve|scan|mcp|vision-lab`, `make test`,
  `pnpm run typecheck`) and the `src/` links point at the Go packages. Deeper pre-existing
  PaddleOCR/Electron architecture prose (not a deleted-path reference) still needs a full README
  pass, recorded as a follow-up in the audit below.
- **`marked` npm package — removed.** `public/ts/TriageState.ts` only reads the global
  `window.marked`, which `public/index.html` loads from the vendored
  `public/js/vendor/marked.js`; no build step imports the npm package.
- **`docker-compose.yml` — DELETE rather than comment-only.** The sole service was the Go
  canonical-path HTTP hop that is now in-process; extraction is the external pdf2w service with
  its own repository/compose file. A comments-only compose file is an invalid compose project,
  so deleting is cleaner than leaving a file that cannot be used.

## Deleted-path reference audit (non-docs tracked files)

References to `src/`, `scripts/`, `desktop/`, `tsconfig.json` or `vitest` in tracked files that
survive, excluding `docs/` and `AGENTS.md`/`CLAUDE.md` (orchestrator-owned, list-only):

- `.gitignore` — comment refs `src/infrastructure/categories-store.ts`,
  `src/domain/prompt-personalization.ts`, `src/infrastructure/mcp/mcp-server.ts`,
  `scripts/crop-bench.ts / crop-score.ts` → comments updated this task.
- `prompts.private.json.example` — `src/domain/prompt-personalization.ts` → updated this task.
- `public/index.html` — `src/domain/crop-quad.ts` → updated this task.
- `package.json` — `desktop/main.cjs`, `src/index.ts`, `scripts/build-exe.mjs` → rewritten.
- `README.md` — `src/domain/prompt-hygiene.test.ts`, `src/infrastructure/categories-store.ts`,
  `npm run dev/desktop/dist:exe/build/test/typecheck` → updated this task. Remaining
  pre-existing PaddleOCR/Electron/`@napi-rs/canvas` architecture prose is a separate README pass.
- `.claude/agents/{classification-expert,db-registry-keeper,mcp-integrator,pipeline-engineer}.md`
  — `src/...` paths in frontmatter descriptions → listed (KEEP).
- `.agents/skills/{pdf-triage-extraction,pdf-triage-verify,pdf-triage-wsl-ops}/SKILL.md`
  — `src/...`, `vitest.config.ts`, PaddleOCR refs → listed (KEEP).
- `public/js/vendor/marked.js` — its own upstream `./src/` comment, not this repo → excluded.

