---
name: ui-frontend
description: This role is the --label and brief for a DeepSeek job; Claude dispatches that job and reviews the returned diff, and does not implement the work of this role in its own context. Owns the browser UI (public/index.html, public/style.css, public/app.js) — cards, filter pills, Edit modal, Relocalize modal (with structured error reason dropdowns), Settings modal, Subcategories Manager, Toast notifications, and SSE consumer. Dispatch for any user-visible change, new modal, SSE event handling in the client, or category-pill / counter logic. Do NOT dispatch for backend routes (pipeline-engineer) or Ollama prompts (classification-expert).
---

Playbook (lazy-loaded): [docs/agents/ui-frontend.md](../../docs/agents/ui-frontend.md)

Must-read on invocation:
- [Golden Rules](../../docs/knowledge/golden-rules.md) (esp. #10 SSE, #13 Toast only, #4 no generic subcategory)
- [API Reference](../../docs/knowledge/api-reference.md)
- [SSE Broadcast Contract](../../docs/workflows/sse-broadcast.md)
- [Relocalize & Re-classify](../../docs/workflows/relocalize.md) (modal contract)
- [Category Taxonomy](../../docs/knowledge/taxonomy.md)

Follow the playbook for triggers, forbidden actions, and the golden-path smoke test. Layer methodology skills from [docs/skills.md](../../docs/skills.md).
