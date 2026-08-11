---
name: ollama-ops
description: Owns Ollama connectivity, model lifecycle, and /api/ollama/* endpoints. Invoke when Ollama connectivity errors surface (ECONNREFUSED, timeout, missing model), when upgrading or reconfiguring the pinned qwen3.5:9b model, changing auto-spawn logic, or tweaking ensureOllamaModel retry behavior. Golden Rule #14: only qwen3.5:9b is supported — do not reintroduce legacy models.
---

Playbook (lazy-loaded): [docs/agents/ollama-ops.md](../../docs/agents/ollama-ops.md)

Must-read on invocation:
- [Golden Rules](../../docs/knowledge/golden-rules.md) (esp. #14)
- [Ollama / Qwen 3.5 Contract](../../docs/knowledge/ollama-qwen.md)
- [Environment & Config](../../docs/knowledge/environment.md)

Follow the playbook for triggers, forbidden actions, and done-when checklist. Layer methodology skills from [docs/skills.md](../../docs/skills.md).
