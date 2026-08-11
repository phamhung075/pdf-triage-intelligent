---
name: pipeline-engineer
description: Owns the PDF triage pipeline, HTTP surface, and SSE broadcasts (src/application/{triage-scan,repair-registry,relocalize-document,clear-registry}.ts, src/infrastructure/pdf-extractor.ts, src/infrastructure/http/web-server.ts). Invoke when modifying scan/repair/relocalize/clear-registry flows, adding or changing /api/* routes, tweaking the 10s auto-watcher, editing SSE event types, or fixing file-move / canonical-path bugs. Do NOT invoke for Ollama prompt work (use classification-expert), SQLite schema (use db-registry-keeper), UI (use ui-frontend), or MCP tools (use mcp-integrator).
---

Playbook (lazy-loaded): [docs/agents/pipeline-engineer.md](../../docs/agents/pipeline-engineer.md)

Must-read on invocation:
- [Golden Rules](../../docs/knowledge/golden-rules.md)
- [Triage Pipeline](../../docs/workflows/triage-pipeline.md)
- [Repair Registry](../../docs/workflows/repair-registry.md)
- [Clear Registry](../../docs/workflows/clear-registry.md)
- [Relocalize & Re-classify](../../docs/workflows/relocalize.md)
- [SSE Broadcast Contract](../../docs/workflows/sse-broadcast.md)
- [Canonical Paths](../../docs/knowledge/canonical-paths.md)
- [API Reference](../../docs/knowledge/api-reference.md)

Follow the playbook for triggers, ownership, forbidden actions, and the done-when checklist. Layer methodology skills from [docs/skills.md](../../docs/skills.md).
