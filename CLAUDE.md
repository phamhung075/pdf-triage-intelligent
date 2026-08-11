# CLAUDE.md — Project Bootstrap

This file is loaded first by Claude Code. Everything else lives in `docs/`.

## What this project is

Local-first **PDF Triage & Agentic Registry** — TypeScript + Node.js + Express + SQLite (+FTS5) + Ollama Qwen 3.5. Watches `__raws`, extracts text, classifies each PDF, writes SQLite + JSON registry mirrors, moves the file to a canonical `__archive/<category>/<subcategory>/<YYYY>/` folder, and pushes SSE updates to a web dashboard. Also exposes MCP tools for external agents.

Full overview: [docs/overview.md](docs/overview.md).

## Read these first, every session

1. [docs/knowledge/golden-rules.md](docs/knowledge/golden-rules.md) — the 20 non-negotiable rules.
2. [docs/README.md](docs/README.md) — index of all knowledge, workflows, and agent playbooks.
3. [docs/agents/README.md](docs/agents/README.md) — the team roster and how to invoke each agent.

## Team

Every agent's shell in `.claude/agents/*.md` is **description-only frontmatter** with links back to `docs/agents/*.md`. This means:

- Claude Code loads only the description upfront.
- On invocation, the agent lazy-loads its full playbook + required knowledge from `docs/`.
- All operational knowledge is diff-friendly and lives in one place.

Roster:

| Agent | Owns |
| --- | --- |
| [pipeline-engineer](docs/agents/pipeline-engineer.md) | src/application/{triage-scan,repair-registry,relocalize-document,clear-registry,scan-lock}.ts, src/infrastructure/http/web-server.ts, src/infrastructure/{pdf-extractor,pdf-scanner,pid-lock}.ts, SSE, auto-watcher |
| [classification-expert](docs/agents/classification-expert.md) | src/domain/{classification,prompt,classification-resolution}.ts, src/application/classify-document.ts, src/infrastructure/entity-dictionary-store.ts, categories.json, entity_dictionary.json |
| [db-registry-keeper](docs/agents/db-registry-keeper.md) | src/infrastructure/db/database.ts, src/domain/document.schema.ts, src/infrastructure/{categories-store,json-registry}.ts, FTS5 |
| [ui-frontend](docs/agents/ui-frontend.md) | public/ (HTML/CSS/JS), modals, pills, Toast, SSE consumer |
| [mcp-integrator](docs/agents/mcp-integrator.md) | src/infrastructure/mcp/mcp-server.ts, tool schemas |
| [ollama-ops](docs/agents/ollama-ops.md) | src/infrastructure/ollama-client.ts, Ollama connectivity, /api/ollama/*, model lifecycle |
| [qa-reviewer](docs/agents/qa-reviewer.md) | Rules audit — no code, just verdicts |
| [docs-curator](docs/agents/docs-curator.md) | docs/ + CLAUDE.md + .claude/agents/*.md shells |

## Skills (single source: docs/skills.md)

The [obra/superpowers](https://github.com/obra/superpowers) plugin (v6.2.0) is vendored at [`.claude/plugins/superpowers/`](.claude/plugins/superpowers/) and exposed via Windows directory junctions:
- [`.claude/skills/`](.claude/skills/) — Claude Code auto-discovery path.
- [`docs/skills/`](docs/skills/) — same target, accessible from the docs tree.

**Single source of truth for skills**: [`docs/skills.md`](docs/skills.md) — indexed catalog with per-agent affinity table. Every agent references this file.

The plugin is registered as `superpowers@superpowers-dev` in [`.claude/settings.json`](.claude/settings.json). A `SessionStart` hook auto-invokes `using-superpowers` on startup/clear/compact.

**Rule of thumb**: Skills are HOW to work; agent playbooks are WHAT to work on. Layer both.

The plugin also ships `.claude/plugins/superpowers/docs/` — Superpowers' own dev history (porting guide, planning docs, specs). Vendor material, not part of this project's knowledge base; intentionally NOT merged into `docs/`.

## Operating rules (short list — full list in Golden Rules)

- **Think first**, read code before editing, no guessing paths or fields.
- **Never** run `npm run dev` yourself — always instruct the user to run/restart it in their terminal.
- **Never** scan outside `CONFIG.INPUT_DIR` (`__raws`).
- **Every mutation** broadcasts SSE.
- **Every category/subcategory** is auto-created in `categories.json` **before** moving the file.
- **Never** accept `general`/`other`/`divers`/year as a final subcategory — BLOCK and keep in `__raws`.
- **Only** Qwen 3.5 (`qwen3.5:9b`).
- **Toast** for all UI feedback, never `alert()`.

## Repo layout

```
pdf_triage/
├── CLAUDE.md                  # this file
├── AGENTS.md                  # user-authored directives (legacy summary)
├── AGENT_REQUIREMENTS.md      # user-authored full spec (referenced by golden-rules.md)
├── categories.json            # taxonomy source of truth
├── settings.json              # runtime config (input_dir, output_root_dir, ollama_*)
├── pdf_triage.db              # SQLite (runtime)
├── registry.json              # JSON mirror (runtime)
├── package.json               # tsx dev + build scripts
├── docs/                      # → knowledge, workflows, agent playbooks (LAZY-LOADED)
│   ├── README.md
│   ├── overview.md
│   ├── skills.md              # UNIFIED skill index (single source of truth)
│   ├── skills/                # junction → .claude/plugins/superpowers/skills
│   ├── agents/{README,*.md}   # per-agent playbooks
│   ├── knowledge/*.md         # architecture, data-model, ollama-qwen, canonical-paths, api-reference, taxonomy, environment, golden-rules
│   └── workflows/*.md         # triage-pipeline, repair-registry, relocalize, clear-registry, classification-flow, sse-broadcast
├── .claude/
│   ├── settings.json          # enables superpowers plugin locally
│   ├── agents/*.md            # description-only shells → link to docs/agents/*
│   ├── skills/                # junction → .claude/plugins/superpowers/skills
│   └── plugins/
│       └── superpowers/       # full obra/superpowers repo, cloned
├── src/
│   ├── index.ts                       # composition root: dispatch default web, `scan`, `mcp`
│   ├── domain/                        # pure logic, zero I/O
│   │   ├── document.schema.ts         # Zod schemas
│   │   ├── classification.ts          # ruleBasedClassify, cleanAndParseJSON, entity matching
│   │   ├── prompt.ts                  # Qwen prompt building
│   │   ├── classification-resolution.ts  # refine/resolve category & subcategory
│   │   ├── taxonomy.ts                # isForbiddenSubcategory, computeCanonicalPath
│   │   └── pdf-text.ts                # cleanExtractedText
│   ├── application/                   # orchestration / use-cases
│   │   ├── classify-document.ts       # classifyPDFText orchestrator
│   │   ├── triage-scan.ts             # runTriageScan
│   │   ├── repair-registry.ts
│   │   ├── relocalize-document.ts
│   │   ├── clear-registry.ts
│   │   └── scan-lock.ts
│   └── infrastructure/                # I/O adapters
│       ├── settings.ts                # CONFIG, settings.json
│       ├── logger.ts
│       ├── categories-store.ts        # categories.json read/write
│       ├── entity-dictionary-store.ts # entity_dictionary.json read
│       ├── ollama-client.ts
│       ├── pdf-extractor.ts
│       ├── pdf-scanner.ts
│       ├── pid-lock.ts
│       ├── db/database.ts
│       ├── json-registry.ts
│       ├── http/web-server.ts
│       └── mcp/mcp-server.ts
├── public/                    # UI (HTML, CSS, JS)
└── logs/triage_debug.log
```

## Scripts

- `npm run dev` / `npm start` — dev server (web + SSE + 10s auto-watcher). **User runs this, not Claude.**
- `npm run scan` — one-shot triage scan.
- `npm run mcp` — MCP stdio server.
- `npm run build` — `tsc`.
- `npm test` — run the Vitest unit test suite (pure classification/path/schema logic; see `docs/superpowers/specs/2026-07-31-test-harness-design.md`).
- `npm run test:watch` — Vitest in watch mode for local development.
