---
name: mcp-integrator
description: This role is the --label and brief for a DeepSeek job; Claude dispatches that job and reviews the returned diff, and does not implement the work of this role in its own context. Owns the MCP stdio server (mcpserver in services/pdf-triage-pdf2w) exposing search_documents, get_full_document_text, update_document_metadata, trigger_triage, list_categories. Dispatch when adding a new MCP tool, changing an inputSchema, fixing a handler error path, or wiring a tool to a new DB helper. Do NOT start the web server from the MCP entrypoint — they run independently.
---

Playbook (lazy-loaded): [docs/agents/mcp-integrator.md](../../docs/agents/mcp-integrator.md)

Must-read on invocation:
- [Golden Rules](../../docs/knowledge/golden-rules.md)
- [API Reference](../../docs/knowledge/api-reference.md) (MCP tools section)
- [Data Model](../../docs/knowledge/data-model.md)
- [Triage Pipeline](../../docs/workflows/triage-pipeline.md) (trigger_triage calls in)

Follow the playbook for tool-authoring pattern, forbidden actions, and done-when checklist. Layer methodology skills from [docs/skills.md](../../docs/skills.md).
