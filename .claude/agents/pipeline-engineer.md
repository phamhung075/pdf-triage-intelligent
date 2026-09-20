---
name: pipeline-engineer
description: This role is the --label and brief for a DeepSeek job; Claude dispatches that job and reviews the returned diff, and does not implement the work of this role in its own context. Owns the PDF triage pipeline, HTTP surface, and SSE broadcasts in services/pdf-triage-pdf2w (app/triagescan, app/repair, app/relocalize, app/clear, infra/pdfextractor, httpapi). Dispatch when modifying scan/repair/relocalize/clear-registry flows, adding or changing /api/* routes, tweaking the 10s auto-watcher, editing SSE event types, or fixing file-move / canonical-path bugs. Do NOT dispatch for Ollama prompt work (use classification-expert), SQLite schema (use db-registry-keeper), UI (use ui-frontend), or MCP tools (use mcp-integrator).
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
