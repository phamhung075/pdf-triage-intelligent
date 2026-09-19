# 🤖 AGENTS.md — Agent Instructions, Bootstrap & Lazy-Loading Context

> **This file is the single root bootstrap for every agent.** `CLAUDE.md` at the project root is a
> **symlink → `AGENTS.md`**, so Claude Code, Codex, Cursor and any other agent tool all read exactly
> the same instructions.
>
> **Lazy-loading by design**: this file stays small on purpose. The full, detailed knowledge lives in
> `docs/` and is loaded **only when you need it** — the context map below tells you which file to open
> for which topic. Do not re-state doc content in this file; link to it.
>
> Together, `AGENTS.md` + `docs/` are the single source of truth for how this project works *now*;
> [CHANGELOG.md](CHANGELOG.md) is the dated record of how it got there — every notable change updates
> both in the same turn.

<!-- deepseek-offload: orchestrator rule — begin -->
## Orchestrator rule — delegate execution to the DeepSeek Harness

You are the orchestrator; the DeepSeek Harness is the worker. Always — no size exception.

You keep thinking, planning, judgment, review, synthesis and anything user-facing. You never
hand-execute code, docs or one-line fixes: every unit of execution is dispatched.

Dispatch through these two entry points:

- `deepseek_agent` — the MCP tool. Blocking: use it for a quick answer or one small precise edit. A
  trivial job still gets dispatched, through this cheaper path.
- `node .agents/skills/deepseek-offload/scripts/dsh-offload.mjs start "<task>" --label <role>` —
  background: multi-step, multi-file or research-heavy work. It returns a job id; poll it with
  `result <jobId>`.

Investigation and diagnosis jobs: pass `--read-only` to `start`.

Fan-out: independent domain-scoped work becomes one job per role in scope, never one per file. The
orchestrator still does synthesis, conflict resolution, review and sign-off.

Review every worker diff before reporting done; workers never commit or push.

If this project defines Claude subagents (.claude/agents/*) or an agent roster in its docs, treat
those roles as the `--label` / brief for a DeepSeek job, not as a reason to do the work in Claude's
own context. Use a Claude subagent only for review or read-only analysis.

If your prompt names one specific job and says you were dispatched as a worker, do that job
yourself; do not re-delegate.

Command surface, prompt contracts and safety rules: `.agents/skills/deepseek-offload/SKILL.md`.
<!-- deepseek-offload: orchestrator rule — end -->

---

## 🧠 Golden Rule: Think First Before Action

> ⚠️ **THINK FIRST BEFORE DOING ANYTHING**: Always thoroughly analyze the problem, inspect the
> codebase, trace imports, verify data schemas, and plan your implementation steps carefully before
> editing files or running commands. Never make assumptions or guess implementation details.

---

## 📥 Lazy-Loading Context Map

> **CRITICAL**: Before performing any task, code edit, or server command in this repository, you MUST
> read and obey all specifications defined in the files below.

### Must read, every session

| Topic | File |
| --- | --- |
| Authoritative user spec (all master directives) | [AGENT_REQUIREMENTS.md](./AGENT_REQUIREMENTS.md) |
| The 21 non-negotiable Golden Rules (rules override everything) | [docs/knowledge/golden-rules.md](docs/knowledge/golden-rules.md) |
| Docs index — all knowledge, workflows, agent playbooks | [docs/README.md](docs/README.md) |
| Agent roster — who owns what; each role is the `--label`/brief for a DeepSeek job, not a Claude implementation agent | [docs/agents/README.md](docs/agents/README.md) |

### On-demand (lazy-load only when the topic is relevant)

| Topic | File |
| --- | --- |
| Classification decision flow — strict priority order (banks first, Step 0 overlay) | [docs/workflows/classification-flow.md](docs/workflows/classification-flow.md) |
| Architecture & module boundaries | [docs/knowledge/architecture.md](docs/knowledge/architecture.md) |
| Data model — SQLite schema, `categories.json`, `registry.json` | [docs/knowledge/data-model.md](docs/knowledge/data-model.md) |
| Ollama / Qwen 3.5 — prompt design, JSON contract, fallbacks | [docs/knowledge/ollama-qwen.md](docs/knowledge/ollama-qwen.md) |
| On-disk canonical folder layout & naming | [docs/knowledge/canonical-paths.md](docs/knowledge/canonical-paths.md) |
| REST + SSE + MCP API reference | [docs/knowledge/api-reference.md](docs/knowledge/api-reference.md) |
| PDF/photo text extraction (pdf2w, required) and in-process canonical-path/text cleaning (`PDF2W_SERVICE_URL`, `infra/pdf2w`, `canonicalpath`, `cleantext`, `services/pdf-triage-pdf2w/`) | [docs/knowledge/pdf2w-extraction.md](docs/knowledge/pdf2w-extraction.md) |
| Service-split plan — **superseded**, kept as historical record; see the banner in the file for what actually shipped | [docs/knowledge/service-split-plan.md](docs/knowledge/service-split-plan.md) |
| Taxonomy — categories, subcategories, private overlays | [docs/knowledge/taxonomy.md](docs/knowledge/taxonomy.md) |
| Environment & config (`settings.json`, env vars) | [docs/knowledge/environment.md](docs/knowledge/environment.md) |
| Workflows — triage, repair, relocalize, clear, SSE broadcast | [docs/workflows/](docs/workflows/) |
| Skills index — methodology (Superpowers plugin) | [docs/skills.md](docs/skills.md) |
| Per-agent playbooks (lazy-loaded on invocation) | [docs/agents/](docs/agents/) |
| DeepSeek Harness delegation — all implementation is dispatched here (orchestrator → worker); command surface, safety | [.agents/skills/deepseek-offload/SKILL.md](.agents/skills/deepseek-offload/SKILL.md) |
| Repository-owned skills & Agent Notes — procedures and decision records | [.agents/skills/](.agents/skills/) · [.agents/notes/](.agents/notes/README.md) |

---

## 🚀 What this project is

Local-first **PDF Triage & Agentic Registry** — one static, CGO-free **Go binary**, `pdf-triage` (`serve | scan | mcp | vision-lab`, built by `make build` into `dist/pdf-triage`), plus SQLite (+FTS5) and Ollama Qwen 3.5. Watches `__raws`, extracts text, classifies each document, writes SQLite + JSON registry mirrors, moves the file to a canonical `__archive/<category>/<subcategory>/<YYYY>/` folder, and pushes SSE updates to a web dashboard. Also exposes MCP tools for external agents. TypeScript remains only for the browser dashboard (`public/ts` → `public/js`, `public/scss` → `public/style.css`).

Incoming **photos** (`.jpg/.png/.webp/.bmp/.tiff`) are not archived as images: they run through the vision pipeline (orient → crop → enhance → assemble) and are filed as A4 PDFs — see the `app/convertimage` package (`services/pdf-triage-pdf2w/app/convertimage`). A **folder** in `__raws` holding only photos (2+) is bundled into ONE multi-page PDF named after the folder, pages ordered numerically (`IMG_2` before `IMG_10`); a lone photo, or a folder mixing photos with anything else, is triaged file-by-file as before. All PDF/photo text extraction — including OCR for scanned or image-only pages — is delegated to the external, self-hosted `markdown-extract-service` (**pdf2w**, reached via `PDF2W_SERVICE_URL` from the `infra/pdf2w` package); pdf-triage runs no OCR of its own. Canonical-path resolution (taxonomy → on-disk archive path) and text cleaning now run **in-process** in the Go binary (`canonicalpath` and `cleantext` packages). Extraction is required, not optional-with-fallback — see [pdf2w-extraction.md](docs/knowledge/pdf2w-extraction.md).

Full overview: [docs/overview.md](docs/overview.md).

---

## ⛔ Non-negotiable rules (one-line anchors — full detail is lazy-loaded from [Golden Rules](docs/knowledge/golden-rules.md))

These are the memory anchors that must never be forgotten, even before loading the full rules:

1. **Think first** — read code, trace imports, verify schemas before editing. No guessing paths or field names. *(Golden Rule 0)*
2. **Server command rule** — **NEVER** START the server binary (`./dist/pdf-triage serve`) or `make dev` / `air` or any other long-running process yourself, and never run a built binary bare (with no subcommand it defaults to `serve`). Always ask/instruct the user to run it in their terminal. Run `go test` instead. *(Golden Rule 2)*
3. **Scan scope** — scan **ONLY** inside `__raws` (`CONFIG.INPUT_DIR`). Never full-disk / parent walks. *(Golden Rule 1)*
4. **No-text block guard** — a PDF with `< 10` clean characters is BLOCKED: no DB row, no move, stays in `__raws`, emit `FILE_FAILED`. *(Golden Rule 3)*
5. **STRICT no-subcategory fail guard** — resolving to empty / `general` / `other` / `divers` / a year-string → **FAILED / BLOCKED**: no SQLite row, no move, **MUST remain in `__raws`** for manual review. *(Golden Rule 4)*
6. **Pre-move dynamic auto-creation (zero-block)** — BEFORE moving a file, register any missing category/subcategory **in `.categories.private.json`** (never the committed `categories.json`), then construct folders and move. *(Golden Rule 5)*
7. **Deep semantic reading over keywords** — analyze full semantic context, legal purpose, and primary issuing entity. Never classify off a lone keyword (a `SFR`/`PayPal` row inside a Crédit Mutuel statement is a transaction, not the document type). *(Golden Rule 6)*
8. **Company-level separation** — never lump: `credit_mutuel` ≠ `societe_generale` ≠ generic `banque`. Same rule for employers, insurers, health institutions, schools, vendors. *(Golden Rule 7)*
9. **Classification decision flow** — strict priority order, Step 0 private overlay first, banks always win → see [classification-flow.md](docs/workflows/classification-flow.md). *(Golden Rule 6/7)*
10. **Executive summary contract** — 3–5 searchable sentences per document: issuing organization, key identifiers/refs, financial amounts/dates, core purpose. Written to `summary`, indexed in SQLite FTS5. *(Golden Rule 12)*
11. **SSE on every mutation** — scan / relocalize / edit / repair / clear / watcher tick all broadcast live SSE. *(Golden Rule 10)*
12. **Clear Registry semantics** — `DELETE /api/documents` moves every `__archive` file back to `__raws`, cleans empty folders, purges the SQLite DB. *(Golden Rule 15)*
13. **Toast only** — all UI feedback via Toast service, never `alert()`. *(Golden Rule 13)*
14. **Only Qwen 3.5** — `qwen3.5:9b`. Legacy models are purged; do not reintroduce. *(Golden Rule 14)*
15. **Personal-data hygiene** — never hardcode personal data in committed `prompts/` or in the `classification` package (`services/pdf-triage-pdf2w/classification`). Real employers, bank product/filename codes, clinics, schools, scanner prefixes go in the gitignored `.prompts.private.json`, which feeds BOTH the prompt (`{{USER_PRIORITY_RULES}}` / `{{USER_KNOWN_ENTITIES}}`) and `ruleBasedClassify()` via `matchPriorityRules()` — one source keeps them aligned. The TypeScript prompt-hygiene test was retired; a repo-tree personal-data scan belongs in CI and is an open item. *(see [taxonomy.md](docs/knowledge/taxonomy.md#personal-prompt-overlay))*
16. **No speculative DDD scaffolding** — do NOT reintroduce a DI container, aggregate classes, a domain-event bus, a unit of work, or a command/query dispatcher. The layered Go design is the architecture: domain (top-level pure packages) → `infra/` → `store/` → `app/` → `httpapi` / `mcpserver` / `visionlab` → `cmd/pdf-triage`; `cmd/pdf-triage` is the composition root; `app/` takes its collaborators as small interfaces; raw SQL lives only in `store/database`; the OS launcher only in `infra/osopen`. *(see [architecture.md](docs/knowledge/architecture.md))*
17. **Photo-pipeline invariants** — never re-apply EXIF orientation (`exifDegrees` is `null` by design), never reintroduce the crop-detector texture gate (the signal is inverted on half the corpus), never delete a source image (move it to `__raws/.delete_files/img_converted/`; conversion is an enhancement, never a gate). *(see the `floodcrop` and `app/convertimage` package docs)*

---

## 👥 Team (lazy-loaded)

The roster, ownership table, and dispatch etiquette live in [docs/agents/README.md](docs/agents/README.md) — load it before dispatching DeepSeek jobs. Each role there is the `--label`/brief for a DeepSeek job: implementation goes to a job started with the role name as `--label`, per the orchestrator rule at the top of this file. Claude subagents are used only for review or read-only analysis, and the only ones are `qa-reviewer` and `read-only-investigator`.

Shells in `.claude/agents/*.md` are **description-only frontmatter** linking to the full playbooks in `docs/agents/*.md`: the description is loaded upfront, the playbook + required knowledge are lazy-loaded when the role is dispatched. For an implementation role the shell only names the DeepSeek `--label`; it is not an instruction to implement in Claude's own context. All operational knowledge is diff-friendly and lives in one place.

---

## 🛠️ Skills

**Repository-owned skills** live in [`.agents/skills/`](.agents/skills/) — one `SKILL.md` per procedure, each stating its trigger in its own frontmatter and linking out to the `docs/` file that owns its facts. Read the matching one before acting.

**Methodology skills** are the vendored [obra/superpowers](https://github.com/obra/superpowers) plugin (v6.2.0) at [`.claude/plugins/superpowers/`](.claude/plugins/superpowers/), exposed via Windows directory junctions: [`.claude/skills/`](.claude/skills/) is Claude Code's auto-discovery path — the repository-owned skills are **not** discovered there — and [`docs/skills/`](docs/skills/) is the same target read from the docs tree.

**Single source of truth for methodology skills**: [`docs/skills.md`](docs/skills.md). The plugin is registered as `superpowers@superpowers-dev` in [`.claude/settings.json`](.claude/settings.json); a `SessionStart` hook auto-invokes `using-superpowers` on startup/clear/compact.

**Rule of thumb**: Skills are HOW to work; agent playbooks are WHAT to work on. Layer both. (`.claude/plugins/superpowers/docs/` is vendor material — intentionally NOT merged into `docs/`.)

**Agent Notes** in [`.agents/notes/`](.agents/notes/README.md) are the decision records: write one when a change gives something up or rejects a plausible alternative — the changelog says what changed, a note says why, and what lost.

---

## 🧭 Claude is the Orchestrator (DeepSeek Harness = worker)

> Claude thinks, plans, reviews and stays user-facing. All implementation, with no size exception,
> is dispatched to background DeepSeek Harness workers on `deepseek-flash`, which cost a
> fraction of the orchestrator's tokens. The bridge is registered as `deepseek` in
> [`.mcp.json`](.mcp.json) — machine-local and gitignored; approve it the first time Claude Code
> prompts for the server.

`deepseek_agent` is the blocking MCP call for a quick inline answer or one small precise edit. `node .agents/skills/deepseek-offload/scripts/dsh-offload.mjs start "<task>" --label <name>` is the fire-and-forget path for anything multi-step, multi-file or research-heavy: it prints a job id and returns immediately, so keep working and poll with `result <jobId>` rather than blocking.

Read [pdf-triage-dispatch](.agents/skills/pdf-triage-dispatch/SKILL.md) before every dispatch — it owns the work-order contract, the constraints every prompt must carry, the role split and the review rule. The [deepseek-offload skill](.agents/skills/deepseek-offload/SKILL.md) owns the command surface, the mandatory safety rules, prompt contracts and troubleshooting; install and refresh from [INSTALL.md](.agents/deepseek-offload/INSTALL.md).

**Precedence:** the orchestrator rule at the top of this file is unconditional. Implementation goes to a DeepSeek job started with the role name as `--label`; Claude subagents are used only for review or read-only analysis. No other wording in this repository (roster docs, `.claude/agents/*` shells, skills) overrides it.

**If you were dispatched as a worker** (you are the DeepSeek job): your prompt is your authority — do the one job it names yourself, do not re-delegate or spawn a subagent, do not commit or push, and return findings rather than a transcript.

**Investigation is read-only by construction, never by request.** When the deliverable is a diagnosis — root-cause work, audits, tracing — dispatch the `read-only-investigator` subagent ([.claude/agents/read-only-investigator.md](.claude/agents/read-only-investigator.md)), whose tool list is `Read, Grep, Glob`: it has nothing that can write. Do not use the built-in `fork` subagent type for investigation work, and do not brief a DeepSeek job as read-only without passing `--read-only` to `dsh-offload.mjs start`, which pins the job to the Harness's `read-only` file policy. Instructions do not constrain a fork; a tool list and a file policy do.

---

## 🗂️ Repo layout

```
pdf_triage/
├── AGENTS.md                  # THIS file — single root bootstrap for all agents (instructions + lazy-loading map)
├── CLAUDE.md                  # symlink → AGENTS.md (Claude Code reads the same file)
├── CHANGELOG.md               # dated, grouped record of every notable change — updated alongside docs/code
├── AGENT_REQUIREMENTS.md      # user-authored full spec (authoritative — must-read)
├── LICENSE                    # MIT
├── Makefile                   # build / test / frontend / dev for the Go binary (build → dist/pdf-triage)
├── categories.json            # PUBLIC, generic starter taxonomy (committed) — top-level categories only
├── .categories.private.json   # PRIVATE taxonomy overlay (gitignored) — real auto-created subcategories; merged with categories.json at runtime by the store/categories package
├── entity_dictionary.json     # curated generic entity reference (banks, telecoms, etc.) — safe to commit, not personal
├── prompts.private.json.example # committed template for .prompts.private.json
├── .prompts.private.json      # PRIVATE prompt overlay (gitignored) — your real employers, bank product/filename codes, clinics, scanner prefixes; injected into the generic prompts/ templates at build time by the store/promptpersonalization package
├── settings.json              # runtime config (gitignored — contains real folder paths); see settings.json.example for the template
├── settings.json.example      # committed template for settings.json
├── .env.example               # committed template for .env (gitignored) — BASE/DATA dirs, ports, Ollama host, pdf2w URL
├── pdf_triage.db              # SQLite (runtime, gitignored)
├── registry.json              # JSON mirror (runtime, gitignored)
├── package.json               # frontend-only build manifest (sass + tsc); the backend is the Go binary
├── pnpm-workspace.yaml        # frontend pnpm workspace
├── docker-compose.yml         # no in-repo service — extraction is the EXTERNAL markdown-extract-service (pdf2w) on :3984
├── .gitmodules                # registers services/pdf-triage-pdf2w (and .agents/deepseek-offload)
├── services/
│   └── pdf-triage-pdf2w/      # git submodule → the Go backend: cmd/pdf-triage (serve | scan | mcp | vision-lab),
│                              #   httpapi, mcpserver, visionlab, app/, store/, infra/, and the top-level domain packages
├── .dockerignore               # keeps personal data out of build contexts
├── docs/                      # → knowledge, workflows, agent playbooks (LAZY-LOADED — see context map above)
│   ├── README.md
│   ├── overview.md
│   ├── skills.md              # UNIFIED skill index (single source of truth)
│   ├── skills/                # junction → .claude/plugins/superpowers/skills
│   ├── agents/{README,*.md}   # per-agent playbooks
│   ├── knowledge/*.md         # architecture, data-model, ollama-qwen, canonical-paths, api-reference, taxonomy, environment, golden-rules, pdf2w-extraction, service-split-plan (superseded)
│   └── workflows/*.md         # triage-pipeline, repair-registry, relocalize, clear-registry, classification-flow, sse-broadcast
├── prompts/                   # committed, publishable Qwen prompt templates
├── public/                    # UI — public/ts/ (source) compiled to public/js/ (served), public/scss/ (source) compiled to public/style.css (served), public/js/vendor/ (marked.js, vendored not CDN)
│   └── test-image-to-pdf.html # standalone Vision Lab diagnostic page (served by `pdf-triage vision-lab`, not the main app)
├── .agents/                    # agent tooling — repository-owned skills, Agent Notes, DeepSeek delegation
├── .claude/
│   ├── settings.json          # enables superpowers plugin locally
│   ├── agents/*.md            # description-only shells → link to docs/agents/*
│   ├── skills/                # junction → .claude/plugins/superpowers/skills
│   └── plugins/
│       └── superpowers/       # full obra/superpowers repo, cloned
└── logs/triage_debug.log
```

---

## 📜 Scripts

- `make build` — build the dashboard assets + the static, CGO-free Go binary → `dist/pdf-triage`.
- `make test` — run the Go module's test suite (`go test ./...`).
- `make frontend` — compile `public/scss/style.scss` → `public/style.css` and `public/ts/*.ts` → `public/js/*.js`.
- `make dev` / `make dev-server` — live-reloading dev mode (frontend watchers + Go hot-reload). **The operator runs this, not the agent.**
- `./dist/pdf-triage serve` — dashboard + REST + SSE + 10s auto-watcher (the default when no subcommand is given). **The operator starts the server, not the agent.**
- `./dist/pdf-triage scan` — one-shot triage scan.
- `./dist/pdf-triage mcp` — MCP over stdio (+ streamable HTTP per settings).
- `./dist/pdf-triage vision-lab` — standalone Vision Lab diagnostic server (port `3179`).
- `pnpm run build:css` — compile `public/scss/style.scss` → `public/style.css`.
- `pnpm run build:frontend` — `build:css` + compile `public/ts/*.ts` → `public/js/*.js`. Run this after editing any `public/ts/*.ts` file — nothing recompiles it automatically.
- `pnpm run watch:css` / `pnpm run watch:frontend` — local watch mode for SCSS / frontend TypeScript.
- `pnpm run typecheck` — `tsc -p tsconfig.frontend.json --noEmit`.
