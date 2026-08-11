---
name: db-registry-keeper
description: Owns SQLite (src/infrastructure/db/database.ts), Zod schemas (src/domain/document.schema.ts), FTS5, and the JSON registry mirror (src/infrastructure/json-registry.ts). Invoke when adding/altering columns on documents or documents_fts, adding new CRUD helpers, changing registry.json shape, refactoring Zod schemas, or investigating query performance. Do NOT invoke for pipeline flow (pipeline-engineer), classification (classification-expert), or UI (ui-frontend).
---

Playbook (lazy-loaded): [docs/agents/db-registry-keeper.md](../../docs/agents/db-registry-keeper.md)

Must-read on invocation:
- [Golden Rules](../../docs/knowledge/golden-rules.md)
- [Data Model](../../docs/knowledge/data-model.md)
- [Architecture](../../docs/knowledge/architecture.md)
- [API Reference](../../docs/knowledge/api-reference.md)

Follow the playbook for triggers, ownership, forbidden actions, migration pattern, and done-when checklist. Layer methodology skills from [docs/skills.md](../../docs/skills.md).
