# 📚 PDF Triage - Documentation Index

> **Purpose**: Single source of truth for the Claude agent team. Every `.claude/agents/*.md` file is intentionally minimal (description only) and lazy-loads its playbook + knowledge from this `docs/` tree.

## 🧭 Start Here

- [Project Overview](./overview.md) — What this system does, the pipeline, and the stack.
- [Golden Rules](./knowledge/golden-rules.md) — Absolute constraints every agent MUST obey.
- [Agent Roster](./agents/README.md) — The team, who does what, and when to invoke each.
- [Skills Index](./skills.md) — Methodology skills (Superpowers) unified under docs/. **Skills = how to work; agent playbooks = what to work on. Layer both.**
- [Changelog](../CHANGELOG.md) — Dated, grouped record of every notable change. `docs/` + `AGENTS.md` (root bootstrap; `CLAUDE.md` is a symlink to it) describe the *current* state; the changelog is the history of how it got there. Update it alongside any doc change of real size — see [docs-curator](./agents/docs-curator.md).

## 🔄 Workflows

- [Triage Pipeline](./workflows/triage-pipeline.md) — End-to-end flow (`__raws` → AI → SQLite → `__archive`).
- [Repair Registry](./workflows/repair-registry.md) — Ghost purge, re-classify, relocalize, move-back.
- [Relocalize & Re-classify](./workflows/relocalize.md) — Modal-driven re-classification with AI feedback.
- [Clear Registry](./workflows/clear-registry.md) — Purge DB & move `__archive` back to `__raws`.
- [Classification Decision Flow](./workflows/classification-flow.md) — Strict 13-step priority order.
- [Real-Time SSE Broadcast](./workflows/sse-broadcast.md) — Event types & UI live-update contract.

## 🧠 Knowledge Base

- [Architecture](./knowledge/architecture.md) — Module boundaries & data flow diagram.
- [Data Model](./knowledge/data-model.md) — SQLite schema, `categories.json`, `registry.json`.
- [Ollama / Qwen 3.5](./knowledge/ollama-qwen.md) — Prompt design, JSON contract, fallback rules.
- [Canonical Paths](./knowledge/canonical-paths.md) — On-disk folder layout & naming.
- [API Reference](./knowledge/api-reference.md) — Every REST + SSE + MCP endpoint.
- [Category Taxonomy](./knowledge/taxonomy.md) — Categories, subcategories, aliases.
- [Environment & Config](./knowledge/environment.md) — `settings.json`, env vars, paths.

## 👥 Agent Playbooks

Every agent's operating manual (invocation triggers, allowed tools, must-read links, done-when checklist):

- [pipeline-engineer](./agents/pipeline-engineer.md)
- [classification-expert](./agents/classification-expert.md)
- [db-registry-keeper](./agents/db-registry-keeper.md)
- [ui-frontend](./agents/ui-frontend.md)
- [mcp-integrator](./agents/mcp-integrator.md)
- [ollama-ops](./agents/ollama-ops.md)
- [qa-reviewer](./agents/qa-reviewer.md)
- [docs-curator](./agents/docs-curator.md)
