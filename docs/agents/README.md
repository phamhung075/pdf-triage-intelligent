# 👥 Agent Roster

Every agent is defined **twice**:

1. A minimal shell in `.claude/agents/<name>.md` — frontmatter with `name` + `description` only, body linking here. For an implementation role the shell only names the DeepSeek `--label`; Claude dispatches that job and does not implement the work in its own context.
2. A full playbook in `docs/agents/<name>.md` — read when the role is dispatched. Encodes triggers, must-read links, forbidden actions, done-when checklist.

This split keeps `.claude/agents/` small (fast to load, easy to browse) and makes the docs a single source of truth (easy to edit, git-diff-friendly).

## Team

Each role below is the `--label`/brief for a DeepSeek job, started as the orchestrator rule at the top of [AGENTS.md](../../AGENTS.md) requires. It is not a Claude implementation agent. The work-order contract is in [pdf-triage-dispatch](../../.agents/skills/pdf-triage-dispatch/SKILL.md). The only Claude-side subagents are `qa-reviewer` (review) and `read-only-investigator` (read-only analysis, not in this table).

| Agent                                       | Owns                                                                                          | Dispatch a DeepSeek job when (`qa-reviewer`: invoke when)      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [pipeline-engineer](./pipeline-engineer.md) | `app/{triagescan,repair,relocalize,clear}`, `infra/pdfextractor`, `httpapi`, SSE, watcher | Pipeline logic, scan/repair/clear/relocalize, HTTP routes, SSE |
| [classification-expert](./classification-expert.md) | `app/classify`, `classification`, `prompt`, `classificationresolution`, `decisionrule`, Qwen prompt, `RuleBasedClassify`, `categories.json` | Prompt changes, taxonomy tweaks, feedback loop                 |
| [db-registry-keeper](./db-registry-keeper.md) | `store/database`, `documentschema`, FTS5, `infra/jsonregistry`                    | Schema migrations, query performance, JSON mirror              |
| [ui-frontend](./ui-frontend.md)             | `public/*` (HTML/CSS/JS), modals, pills, Toast, SSE consumer                                  | Any UI change — cards, filters, settings, relocalize modal     |
| [mcp-integrator](./mcp-integrator.md)       | `mcpserver`, tool schemas                                                                 | Adding/modifying MCP tools exposed to external agents          |
| [ollama-ops](./ollama-ops.md)               | Ollama connectivity, `infra/ollama`, `/api/ollama/*`, model lifecycle                                         | Model install, health, auto-spawn, connectivity errors         |
| [qa-reviewer](./qa-reviewer.md)             | Reviews changes vs `AGENT_REQUIREMENTS.md` + Golden Rules                                     | After any non-trivial change; always before merge              |
| [docs-curator](./docs-curator.md)           | Everything in `docs/` and `AGENTS.md` (root bootstrap; `CLAUDE.md` is a symlink to it)        | After code changes that alter behavior described in docs       |

## Skills ↔ team

Every agent layers methodology skills on top of its domain playbook. The unified index — with per-agent affinity table — is at [docs/skills.md](../skills.md).

Rule of thumb:
- **Skill** = *how* to work (process). Sourced from the vendored Superpowers plugin.
- **Agent playbook** = *what* to work on (PDF-triage domain).

## When to start multiple DeepSeek jobs in parallel

The user wants live UI + backend changes with no regressions. One job per role in scope, never one per file. Common parallel patterns:

- Adding a REST endpoint that mutates a doc → `pipeline-engineer` + `ui-frontend` + `db-registry-keeper` jobs in parallel, then the `qa-reviewer` Claude subagent reviews the diffs.
- Prompt refinement → a `classification-expert` job alone; then `qa-reviewer` for a rules audit.
- Schema change → a `db-registry-keeper` job first (blocks others), then `pipeline-engineer` + `classification-expert` + `ui-frontend` jobs in parallel.

## Dispatch etiquette

Every dispatched DeepSeek worker MUST (the orchestrator puts these in the work order):

1. Read its playbook (`docs/agents/<self>.md`) BEFORE touching code.
2. Read [Golden Rules](../knowledge/golden-rules.md).
3. Read every doc linked from its playbook's "Must-read" section.
4. Announce which files it plans to touch.
5. Never edit outside its ownership; report the need to the orchestrator, which dispatches the owning role.

A Claude subagent (`qa-reviewer`, `read-only-investigator`) follows steps 1–3 but is used only for review or read-only analysis and never writes feature code.
