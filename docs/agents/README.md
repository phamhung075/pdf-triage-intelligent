# 👥 Agent Roster

Every agent is defined **twice**:

1. A minimal shell in `.claude/agents/<name>.md` — frontmatter with `name` + `description` only, body linking here. Claude Code reads these to pick which agent to spawn.
2. A full playbook in `docs/agents/<name>.md` — read on first invocation. Encodes triggers, must-read links, forbidden actions, done-when checklist.

This split keeps `.claude/agents/` small (fast to load, easy to browse) and makes the docs a single source of truth (easy to edit, git-diff-friendly).

## Team

| Agent                                       | Owns                                                                                          | Invoke when                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [pipeline-engineer](./pipeline-engineer.md) | `application/{triage-scan,repair-registry,relocalize-document,clear-registry}.ts`, `infrastructure/pdf-extractor.ts`, `infrastructure/http/web-server.ts`, SSE, watcher | Pipeline logic, scan/repair/clear/relocalize, HTTP routes, SSE |
| [classification-expert](./classification-expert.md) | `application/classify-document.ts`, `domain/{classification,prompt,classification-resolution}.ts`, Qwen prompt, `ruleBasedClassify`, `categories.json` | Prompt changes, taxonomy tweaks, feedback loop                 |
| [db-registry-keeper](./db-registry-keeper.md) | `infrastructure/db/database.ts`, `domain/document.schema.ts`, FTS5, `infrastructure/json-registry.ts`                    | Schema migrations, query performance, JSON mirror              |
| [ui-frontend](./ui-frontend.md)             | `public/*` (HTML/CSS/JS), modals, pills, Toast, SSE consumer                                  | Any UI change — cards, filters, settings, relocalize modal     |
| [mcp-integrator](./mcp-integrator.md)       | `infrastructure/mcp/mcp-server.ts`, tool schemas                                                                 | Adding/modifying MCP tools exposed to external agents          |
| [ollama-ops](./ollama-ops.md)               | Ollama connectivity, `infrastructure/ollama-client.ts`, `/api/ollama/*`, model lifecycle                                         | Model install, health, auto-spawn, connectivity errors         |
| [qa-reviewer](./qa-reviewer.md)             | Reviews changes vs `AGENT_REQUIREMENTS.md` + Golden Rules                                     | After any non-trivial change; always before merge              |
| [docs-curator](./docs-curator.md)           | Everything in `docs/` and `AGENTS.md` (root bootstrap; `CLAUDE.md` is a symlink to it)        | After code changes that alter behavior described in docs       |

## Skills ↔ team

Every agent layers methodology skills on top of its domain playbook. The unified index — with per-agent affinity table — is at [docs/skills.md](../skills.md).

Rule of thumb:
- **Skill** = *how* to work (process). Sourced from the vendored Superpowers plugin.
- **Agent playbook** = *what* to work on (PDF-triage domain).

## When to spawn multiple agents in parallel

The user wants live UI + backend changes with no regressions. Common parallel patterns:

- Adding a REST endpoint that mutates a doc → `pipeline-engineer` + `ui-frontend` + `db-registry-keeper` in parallel, `qa-reviewer` after.
- Prompt refinement → `classification-expert` alone; then `qa-reviewer` for a rules audit.
- Schema change → `db-registry-keeper` first (blocks others), then `pipeline-engineer` + `classification-expert` + `ui-frontend` in parallel.

## Invocation etiquette

Every agent MUST:

1. Read its playbook (`docs/agents/<self>.md`) BEFORE touching code.
2. Read [Golden Rules](../knowledge/golden-rules.md).
3. Read every doc linked from its playbook's "Must-read" section.
4. Announce which files it plans to touch.
5. Never edit outside its ownership without pinging the owning agent first.
