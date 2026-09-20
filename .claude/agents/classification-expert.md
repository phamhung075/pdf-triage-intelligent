---
name: classification-expert
description: This role is the --label and brief for a DeepSeek job; Claude dispatches that job and reviews the returned diff, and does not implement the work of this role in its own context. Owns the classifier — the Ollama Qwen 3.5 prompt AND the deterministic RuleBasedClassify fallback in the classification package (services/pdf-triage-pdf2w/classification, plus app/classify), plus categories.json taxonomy. Dispatch when refining the classification prompt, adding/renaming a category or subcategory, fixing a misclassification pattern (via previousError feedback), tuning fallback regex signals, or changing generateEmbedding behavior. Do NOT dispatch for schema changes (use db-registry-keeper) or pipeline flow (use pipeline-engineer).
---

Playbook (lazy-loaded): [docs/agents/classification-expert.md](../../docs/agents/classification-expert.md)

Must-read on invocation:
- [Golden Rules](../../docs/knowledge/golden-rules.md)
- [Ollama / Qwen 3.5 Contract](../../docs/knowledge/ollama-qwen.md)
- [Classification Decision Flow](../../docs/workflows/classification-flow.md)
- [Category Taxonomy](../../docs/knowledge/taxonomy.md)
- [Relocalize & Re-classify](../../docs/workflows/relocalize.md) (feedback loop)
- [Data Model](../../docs/knowledge/data-model.md) (`DocumentMetadata` contract)

Follow the playbook for triggers, ownership, forbidden actions, and the done-when checklist. Layer methodology skills from [docs/skills.md](../../docs/skills.md).
