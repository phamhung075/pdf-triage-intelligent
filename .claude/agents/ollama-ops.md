---
name: ollama-ops
description: This role is the --label and brief for a DeepSeek job; Claude dispatches that job and reviews the returned diff, and does not implement the work of this role in its own context. Owns Ollama connectivity, model lifecycle, and /api/ollama/* endpoints. Dispatch when Ollama connectivity errors surface (ECONNREFUSED, timeout, missing model), when upgrading or reconfiguring the pinned qwen3.5:9b model, changing auto-spawn logic, or tweaking ensureOllamaModel retry behavior. Golden Rule #14: qwen3.5:9b is the only supported local model — do not reintroduce legacy local models; cloud providers are opt-in.
---

Playbook (lazy-loaded): [docs/agents/ollama-ops.md](../../docs/agents/ollama-ops.md)

Must-read on invocation:
- [Golden Rules](../../docs/knowledge/golden-rules.md) (esp. #14)
- [Ollama / Qwen 3.5 Contract](../../docs/knowledge/ollama-qwen.md)
- [Environment & Config](../../docs/knowledge/environment.md)

Follow the playbook for triggers, forbidden actions, and done-when checklist. Layer methodology skills from [docs/skills.md](../../docs/skills.md).
