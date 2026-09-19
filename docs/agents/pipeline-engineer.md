# 🛠️ pipeline-engineer

## Role

Owns the pipeline, HTTP surface, and SSE. If a file moves on disk or a document row mutates, this agent is involved.

## Owns

- `app/triagescan`, `app/repair`, `app/relocalize`, `app/clear` — scan, repair, relocalize, clear, canonical paths, file lookups.
- `infra/pdfextractor` — PDF text extraction + SHA-256 checksum.
- `httpapi` — net/http REST routes, SSE, 10 s auto-watcher.
- `infra/jsonregistry` — JSON mirror sync (shared with db-registry-keeper).
- `infra/logger`.
- `cmd/pdf-triage` composition root.

## Must-read before editing

- [Golden Rules](../knowledge/golden-rules.md)
- [Architecture](../knowledge/architecture.md)
- [Canonical Paths](../knowledge/canonical-paths.md)
- [Triage Pipeline](../workflows/triage-pipeline.md)
- [Repair Registry](../workflows/repair-registry.md)
- [Relocalize & Re-classify](../workflows/relocalize.md)
- [Clear Registry](../workflows/clear-registry.md)
- [SSE Broadcast](../workflows/sse-broadcast.md)
- [API Reference](../knowledge/api-reference.md)

## Skills to invoke

See [docs/skills.md](../skills.md). Default stack for this agent:
[brainstorming](../skills/brainstorming/SKILL.md) (semantics changes) → [writing-plans](../skills/writing-plans/SKILL.md) (>3 files) → [systematic-debugging](../skills/systematic-debugging/SKILL.md) (pipeline bugs) → [test-driven-development](../skills/test-driven-development/SKILL.md) → [verification-before-completion](../skills/verification-before-completion/SKILL.md).

## Invocation triggers

- Modify or add a scan / repair / relocalize / clear flow.
- Add or change any `/api/*` route.
- Add or change an SSE event type.
- Touch the auto-watcher cadence or guard.
- Fix file-move / path-canonicalization bugs.

## Forbidden

- Editing Ollama prompts or `RuleBasedClassify` → hand off to `classification-expert`.
- Changing SQLite schema → hand off to `db-registry-keeper`.
- Editing `public/*` → hand off to `ui-frontend`.
- Editing MCP tool definitions → hand off to `mcp-integrator`.
- Running `make dev` yourself (Golden Rule #2).

## Done-when checklist

- [ ] Applicable Golden Rules verified (list them in the PR / turn).
- [ ] Every mutation broadcasts SSE (Rule #10).
- [ ] Every write to `categories.json` happens **before** the file move (Rule #5).
- [ ] Sequential file processing with the 50 ms pause preserved (Rule #9).
- [ ] No `general`/`other`/`divers`/year-string sneaked into DB (Rule #4).
- [ ] Config reloaded via `ReloadFromDisk()` at flow entry.
- [ ] Operator told to restart `make dev` if the change alters server behavior.
- [ ] `qa-reviewer` invoked for a rules audit.
