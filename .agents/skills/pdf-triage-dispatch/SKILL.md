---
name: pdf-triage-dispatch
description: Use when delegating pdf-triage work to a background DeepSeek Harness worker — turns this repository's rules into a self-contained work order the worker can execute without reading the repo, and lists the paths and commands a worker must never touch.
---

# Dispatching a DeepSeek worker for pdf-triage work

Claude is the orchestrator; DeepSeek Harness workers do the execution. The mechanics — `start`, `status`, `result`, `wait`, `update`, `cancel`, `session-tail.mjs` — are owned by the [deepseek-offload skill](../deepseek-offload/SKILL.md); read it first. This skill covers only what is specific to **this** repository.

A worker starts with **none of your context**. It does not know the golden rules, cannot see this conversation, and inherits none of your instructions. Everything it must respect goes in the prompt.

## The work order

Use all six fields. A missing field is the usual cause of a run that comes back plausible and wrong.

1. **Objective** — one imperative sentence. "Add X to Y", not "look into Y".
2. **Scope** — exact paths it may read, and the repo docs it must read first (`docs/knowledge/architecture.md`, `docs/knowledge/golden-rules.md`, the relevant `docs/workflows/*`). Name what is out of bounds.
3. **Method** — the commands you expect: `npm run typecheck`, `npm test`. Include the trap that applies (e.g. `npm run build:frontend` after any `public/ts/**` edit).
4. **Output contract** — the exact format you will parse, plus a word budget. Findings, not a transcript.
5. **Write policy** — default `read-only`. If it may write, scope it to the exact paths, and route any scratch output under `scratch/`.
6. **Evidence rule** — "cite the files and commands you actually ran; mark anything unverified". A claim without a command behind it is not a finding.

## Constraints to state in every work order

Copy these into the prompt; the worker cannot infer them:

- **Never run `npm run dev` or `npm start`.** The user runs the server. This is the most-violated rule by a worker that wants to check its own work.
- **Scan scope is `__raws` only** (`CONFIG.INPUT_DIR`) — never walk parents, siblings, or the disk.
- **Never write to** `.env`, `settings.json`, `.prompts.private.json`, `.categories.private.json`, `registry.json`, `manual_decisions.json`, `taxonomy_hints.json`, or any `*.db`. These hold the operator's real data.
- **No personal data in committed files** — see [pdf-triage-personal-data](../pdf-triage-personal-data/SKILL.md). Hand the worker the rule; do not hand it the values.
- **Do not commit or push.** Workers return findings and diffs; the orchestrator commits.
- **The three gates** are `npm run typecheck`, `npm test`, `npm run build:frontend` — see [pdf-triage-verify](../pdf-triage-verify/SKILL.md).

`DEEPSEEK_MCP_PERMISSION=allow` means every permission prompt is auto-accepted: the child can run shell commands and edit files unattended. Pass `--permission reject` for a read-only investigation.

## Splitting by role

Slice a request by [agent role](../../../docs/agents/README.md) — one job per role, never one job per file — and use a role-named `--label` so each session is identifiable in the GUI:

| `--label` | Owns |
| --- | --- |
| `pipeline-engineer` | `application/{triage-scan,repair-registry,relocalize-document,clear-registry}.ts`, `pdf-extractor.ts`, `web-server.ts`, SSE, watcher |
| `classification-expert` | `classify-document.ts`, `domain/{classification,prompt,classification-resolution,decision-rule}.ts`, the Qwen prompt, `ruleBasedClassify` |
| `db-registry-keeper` | `db/database.ts`, `document.schema.ts`, FTS5, `json-registry.ts` |
| `ui-frontend` | `public/**` — cards, modals, pills, Toast, SSE consumer |
| `mcp-integrator` | `infrastructure/mcp/mcp-server.ts` and its tool schemas |
| `ollama-ops` | Ollama connectivity, `ollama-client.ts`, `/api/ollama/*`, model lifecycle |
| `qa-reviewer` | Reviewing a change against `AGENT_REQUIREMENTS.md` + Golden Rules |

Dispatch concurrently, then keep working — `start` is fire-and-forget. Poll with `result <jobId>`; `wait` only when the next step truly needs that output.

## Following and steering a job

The job's session does appear in the GUI at `http://127.0.0.1:3080` under this project, but it runs in a separate process and **the GUI cannot show it running or stream it**. Never prompt or act on its GUI row.

Follow it in the terminal with `node .agents/skills/deepseek-offload/scripts/session-tail.mjs <jobId> --watch`, and steer a job that is going the wrong way with `dsh-offload.mjs update <jobId> "<new information>"` rather than cancelling and re-dispatching — the steer preserves the session's work so far. `cancel <jobId>` stops a run outright.

## Reviewing what comes back

A worker inherits nothing of your rules, so **read its diff as if a stranger wrote it**. Run `git status` and `git diff` after any job that wrote files. Check it against the numbered rules in `AGENTS.md` — the frequent misses are the `< 10` character no-text guard, the strict no-subcategory fail guard, writing a taxonomy slug to `categories.json` instead of the private overlay, and `Promise.all`-ing the scan pipeline (Golden Rule 9 requires one file at a time with a `setTimeout(50)` yield).

Nothing a worker produced is committed until you have reviewed it and the [qa-reviewer](../../../docs/agents/qa-reviewer.md) gate has run.
