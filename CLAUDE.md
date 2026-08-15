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
- **Every category/subcategory** is auto-created (in `.categories.private.json`, never in the committed `categories.json`) **before** moving the file — see `categories-store.ts`.
- **Never** accept `general`/`other`/`divers`/year as a final subcategory — BLOCK and keep in `__raws`.
- **Only** Qwen 3.5 (`qwen3.5:9b`).
- **Toast** for all UI feedback, never `alert()`.

## Repo layout

```
pdf_triage/
├── CLAUDE.md                  # this file
├── AGENTS.md                  # user-authored directives (legacy summary)
├── AGENT_REQUIREMENTS.md      # user-authored full spec (referenced by golden-rules.md)
├── LICENSE                    # MIT
├── categories.json            # PUBLIC, generic starter taxonomy (committed) — top-level categories only
├── .categories.private.json   # PRIVATE taxonomy overlay (gitignored) — real auto-created subcategories; merged with categories.json at runtime by categories-store.ts
├── entity_dictionary.json     # curated generic entity reference (banks, telecoms, etc.) — safe to commit, not personal
├── settings.json               # runtime config (gitignored — contains real folder paths); see settings.json.example for the template
├── settings.json.example      # committed template for settings.json
├── .env.example                # committed template for .env (gitignored) — BASE_DIR override, ports, Ollama host, etc.
├── pdf_triage.db               # SQLite (runtime, gitignored)
├── registry.json               # JSON mirror (runtime, gitignored)
├── package.json                # tsx dev + build scripts
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
│   ├── vision-lab-server.ts           # Vision Lab standalone Express app: POST /api/vision/diagnose-image, own port
│   ├── vision-lab-main.ts             # Vision Lab entrypoint: calls startVisionLabServer() — `npm run vision:dev`
│   ├── domain/                        # pure logic, zero I/O
│   │   ├── document.schema.ts         # Zod schemas
│   │   ├── classification.ts          # ruleBasedClassify, cleanAndParseJSON, entity matching, normalizeSlug
│   │   ├── prompt.ts                  # Qwen prompt building (Step A/C/D)
│   │   ├── classification-resolution.ts  # refine/resolve category & subcategory, entity-priority override
│   │   ├── taxonomy.ts                # isForbiddenSubcategory, computeCanonicalPath
│   │   ├── pdf-text.ts                # cleanExtractedText
│   │   ├── image-adjust.ts            # pure auto-levels/sharpen math for the Vision Lab pipeline (ported from pdf-awesome)
│   │   ├── model/                     # ⚠️ NOT WIRED IN — orphaned DDD entities from an incomplete refactor,
│   │   │                              #   never imported by index.ts/web-server.ts. Dead code, not the real architecture.
│   │   └── repositories/              # ⚠️ NOT WIRED IN — same orphaned refactor (interface definitions only)
│   ├── application/                   # orchestration / use-cases
│   │   ├── classify-document.ts       # classifyPDFText orchestrator (Step A entity + Step C markdown + Step D classify)
│   │   ├── triage-scan.ts             # runTriageScan — the real, live-wired scan pipeline
│   │   ├── ai-chat-assistant.ts       # local chat assistant grounded in the document registry (via MCP prepare_dossier)
│   │   ├── image-to-pdf.ts            # runVisionPipeline — Vision Lab orchestrator: original/oriented/cropped/enhanced steps
│   │   ├── repair-registry.ts
│   │   ├── relocalize-document.ts
│   │   ├── clear-registry.ts
│   │   ├── scan-lock.ts
│   │   └── use-cases/                 # ⚠️ NOT WIRED IN — orphaned DDD use-cases, same incomplete refactor as domain/model
│   └── infrastructure/                # I/O adapters
│       ├── settings.ts                # CONFIG, BASE_DIR (defaults to process.cwd(), overridable via PDF_TRIAGE_BASE_DIR)
│       ├── logger.ts
│       ├── categories-store.ts        # merges categories.json (public) + .categories.private.json (private) on read; diffs writes to the private file only
│       ├── entity-dictionary-store.ts # entity_dictionary.json read
│       ├── manual-decisions-store.ts  # manual_decisions.json read/write (user feedback log, gitignored)
│       ├── zip-builder.ts             # pure-TS ZIP archive builder (no native deps) — PDF package export + bulk Markdown export
│       ├── ollama-client.ts
│       ├── vision-client.ts           # detectOrientation/detectCropBox — Ollama calls against CONFIG.OLLAMA_VISION_MODEL
│       ├── paddleocr-client.ts        # paddleOcrRecognize/paddleOcrDetectOrientation — HTTP client for paddleocr-server/, auto-spawns it if unreachable
│       ├── image-processor.ts         # @napi-rs/canvas ops: rotateImage, cropImage, applyBrightnessContrast, applySharpen
│       ├── pdf-extractor.ts
│       ├── pdf-scanner.ts
│       ├── pid-lock.ts
│       ├── db/database.ts
│       ├── json-registry.ts
│       ├── http/web-server.ts         # all real REST/SSE routes live here
│       ├── http/controllers/          # ⚠️ NOT WIRED IN — orphaned DDD controller, same incomplete refactor
│       ├── adapters/                  # ⚠️ NOT WIRED IN — orphaned DDD adapters, same incomplete refactor
│       ├── di/container.ts            # ⚠️ NOT WIRED IN — orphaned DI container, only imported by the orphaned DocumentController
│       └── mcp/mcp-server.ts
├── public/                    # UI — public/ts/ (source) compiled to public/js/ (served), public/scss/ (source) compiled to public/style.css (served), public/js/vendor/ (marked.js, vendored not CDN)
│   └── test-image-to-pdf.html # standalone Vision Lab diagnostic page (served by vision-lab-server.ts, not the main app)
├── paddleocr-server/           # standalone Python/FastAPI OCR service (PaddleOCR) — separate process, see paddleocr-server/README.md
├── social/                    # gitignored — LinkedIn/marketing drafts, not project source
└── logs/triage_debug.log
```

## Scripts

- `npm run dev` / `npm start` — dev server (web + SSE + 10s auto-watcher). **User runs this, not Claude.**
- `npm run scan` — one-shot triage scan.
- `npm run mcp` — MCP stdio server.
- `npm run vision:dev` — standalone Vision Lab diagnostic server (port `3179`), run independently of `npm run dev`.
- `npm run build` — `build:css` + `tsc` (backend) + `tsc -p tsconfig.frontend.json` (frontend).
- `npm run build:css` — compile `public/scss/style.scss` → `public/style.css`.
- `npm run watch:css` — `sass --watch` for local SCSS development.
- `npm run build:frontend` — `build:css` + compile `public/ts/*.ts` → `public/js/*.js`. Run this after editing any `public/ts/*.ts` file — nothing recompiles it automatically.
- `npm run watch:frontend` — `tsc -p tsconfig.frontend.json -w` for local frontend development.
- `npm run typecheck` — `tsc -p tsconfig.test.json` + `tsc -p tsconfig.frontend.json`, no emit.
- `npm run desktop` — Electron desktop shell.
- `npm run dist:exe` — build the portable Windows installer.
- `npm test` — run the Vitest unit test suite (pure classification/path/schema logic; see `docs/superpowers/specs/2026-07-31-test-harness-design.md`).
- `npm run test:watch` — Vitest in watch mode for local development.
