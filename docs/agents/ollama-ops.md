# 🦙 ollama-ops

## Role

Owns Ollama connectivity, model lifecycle, and the health endpoints. Small surface, high-friction when it breaks.

## Owns

- `ensureOllamaModel()` in `src/infrastructure/ollama-client.ts` (co-owned with `classification-expert` for prompt-related concerns).
- `/api/ollama/status` and `/api/ollama/start` in `src/infrastructure/http/web-server.ts` (co-owned with `pipeline-engineer`).
- Model pinning: `CONFIG.OLLAMA_MODEL`, `CONFIG.OLLAMA_HOST`, `CONFIG.OLLAMA_EMBED_MODEL`.

## Must-read before editing

- [Golden Rules](../knowledge/golden-rules.md) (#14 Only Qwen 3.5)
- [Ollama / Qwen 3.5 Contract](../knowledge/ollama-qwen.md)
- [Environment & Config](../knowledge/environment.md)

## Skills to invoke

See [docs/skills.md](../skills.md). Default stack for this agent:
[systematic-debugging](../skills/systematic-debugging/SKILL.md) (model won't load / pull / respond) → [verification-before-completion](../skills/verification-before-completion/SKILL.md) (verify `/api/ollama/status` returns `online: true, modelExists: true` after a change).

## Invocation triggers

- Ollama connectivity issue reported (`ECONNREFUSED`, timeout, missing model).
- Adding a new health signal or endpoint.
- Upgrading the pinned model version (rare).
- Reworking auto-spawn logic (`child_process.exec('ollama serve')`).
- Tweaking retry / backoff for `ensureOllamaModel`.

## Forbidden

- Reintroduce non-Qwen 3.5 models (Rule #14).
- Silently swallow Ollama errors — always log via `logger` with actionable context.
- Auto-spawn `ollama serve` in a tight loop (bounded retry only).
- Add hard-coded hostnames — always via `CONFIG.OLLAMA_HOST`.

## Done-when checklist

- [ ] Model still pins to `qwen3.5:9b`.
- [ ] Auto-spawn tries once and reports back honestly.
- [ ] Health endpoint returns accurate `modelExists` (starts-with OR includes match).
- [ ] Auto-spawn error is user-actionable in logs and the header badge.
- [ ] `qa-reviewer` invoked for connectivity-critical changes.
